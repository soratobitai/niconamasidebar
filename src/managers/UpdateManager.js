import { fetchLivePrograms } from '../services/api.js';
import { fetchFollowedProgramsViaPage } from '../services/followPageSource.js';
import { getProgramInfos as getProgramInfosFromStorage, upsertProgramInfos } from '../services/storage.js';
import { makeProgramElement, calculateActivePoint, updateThumbnailsFromStorage, flipReorder } from '../render/sidebar.js';
import { setProgramContainerWidth } from '../ui/layout.js';
import { sortPrograms } from '../utils/sorting.js';
import { updateThumbnailInterval, programInfoTtlMs, watchPageBaseUrl, apiRateWindowMs, scrapeIntervalMs } from '../config/constants.js';

/**
 * 更新処理とタイマーの管理
 * サイドバー更新、サムネイル更新、番組詳細取得のタイマー管理と実行を担当
 */
export class UpdateManager {
    constructor(appState, programInfoQueue, loadingManager, options, elems, loadingImageURL) {
        this.appState = appState;
        this.programInfoQueue = programInfoQueue;
        this.loadingManager = loadingManager;
        this.options = options;
        this.elems = elems;
        this.loadingImageURL = loadingImageURL;
        
        // API呼び出しトラッカー（デバッグ用、global）
        this.apiCallCounter = window.apiCallCounter || {
            getLivePrograms: 0,
            fetchProgramInfo: 0,
            recentTimestamps: []
        };
        window.apiCallCounter = this.apiCallCounter;
        
        // 重複実行防止フラグ
        this.isPerformingInitialLoad = false;
        this.isPerformingManualUpdate = false;
    }

    /**
     * サムネイル更新タイマーを開始
     */
    startThumbnailUpdate() {
        const runUpdateThumbnail = () => {
            this.updateThumbnail();
            // 完了後にタイマーを再セット（定期実行）
            const interval = this.options.updateThumbnailInterval || updateThumbnailInterval;
            const timer = setTimeout(runUpdateThumbnail, interval * 1000);
            this.appState.setTimer('thumbnail', timer);
        };
        
        runUpdateThumbnail(); // 即座に実行
    }

    /**
     * ToDoリスト（番組詳細取得）更新を開始
     */
    async startToDoListUpdate() {
        // oneTimeFlagの処理（ページ読み込み時の初回更新）
        if (this.appState.update.oneTimeFlag) {
            await this.performInitialLoad();
            this.appState.update.oneTimeFlag = false;
        }
        
        // キュー処理を開始
        this.programInfoQueue.start();
        
        // タイマーIDを保存（停止用）
        this.appState.setTimer('todo', 'queue-managed');
    }

    /**
     * サイドバー更新タイマーを開始
     */
    startSidebarUpdate() {
        // 既存のタイマーがある場合は確実にクリア
        const existingTimer = this.appState.getTimer('sidebar');
        if (existingTimer && existingTimer !== 'queue-managed') {
            clearTimeout(existingTimer);
        }
        
        const updateSidebarInterval = async () => {
            // 別の更新（手動更新・初回ロード）が進行中なら、今回の定期更新はスキップして次回に回す。
            // settle中の processNow（最大数十秒）に割り込んで途中ソートやセッション上書きが
            // 起きるのを防ぐ（ローディングセッションは60秒でタイムアウトするため詰まらない）。
            if (this.appState.isLoading()) {
                const retryTimer = setTimeout(updateSidebarInterval, this._currentUpdateIntervalMs());
                this.appState.setTimer('sidebar', retryTimer);
                return;
            }
            // followPage経路: 非表示中はスクレイプしない（背景での20秒取得を避ける。可視復帰時に
            // performManualUpdate が拾う）。タイマーは生かして次回に回す。
            const isFollowPage = this._resolveDataSource() === 'followPage';
            if (isFollowPage && !this.appState.isVisible()) {
                const idleTimer = setTimeout(updateSidebarInterval, this._currentUpdateIntervalMs());
                this.appState.setTimer('sidebar', idleTimer);
                return;
            }
            try {
                // followPage経路の定期スクレイプはスピナーを出さない（20秒周期の点滅回避）。
                // api経路は従来どおりスピナー表示＋最低1秒のローディング確保。
                await this.updateSidebar({ silent: isFollowPage });
                if (!isFollowPage && this.loadingManager.getCurrentSessionId()) {
                    await this.loadingManager.finishSessionWithMinDuration(1000);
                }
            } catch (error) {
                console.error('[updateSidebarInterval] エラー:', error);
            } finally {
                // followPage経路はサムネ更新を独立タイマーで回さず、スクレイプ直後にここで反映（20秒ループ一本化）。
                // 途中で throw してもサムネが更新されるよう finally に置く。api経路は thumbnail タイマーが担当。
                if (isFollowPage) this.updateThumbnail();
            }
            // 完了後にタイマーをセット
            const timer = setTimeout(updateSidebarInterval, this._currentUpdateIntervalMs());
            this.appState.setTimer('sidebar', timer);
        };

        const timer = setTimeout(updateSidebarInterval, this._currentUpdateIntervalMs());
        this.appState.setTimer('sidebar', timer);
    }

    /**
     * サイドバー更新タイマーを再開
     */
    restartSidebarUpdate() {
        const existingTimer = this.appState.getTimer('sidebar');
        if (existingTimer && existingTimer !== 'queue-managed') {
            clearTimeout(existingTimer);
            this.appState.clearTimer('sidebar');
        }
        this.startSidebarUpdate();
    }

    /**
     * 初回ロードを実行（ページ読み込み時のみ）
     */
    async performInitialLoad() {
        // 重複実行を防ぐ
        if (this.isPerformingInitialLoad) {
            return;
        }
        
        this.isPerformingInitialLoad = true;
        // 整列確定中フラグをON。
        // 人気順のときは、詳細取得が出揃うまで新着順で安定表示し（getEffectiveSortType）、
        // 途中の再ソートを抑制する（updateActivePointsAndSort）。確定後に1回だけ並べ替える。
        // 初回ロードはキャッシュ不足時に新着順で待つことを許可する。
        this.appState.update.settleAllowNewest = true;
        this.appState.update.settling = true;
        try {
            // ソートフラグをON
            this.programInfoQueue.setShouldSort(true);

            // 番組リスト更新（settling中は新着順で描画される）
            await this.updateSidebar();

            // DOM更新完了を待つ
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

            // 番組詳細取得（全件）。この間、active-point属性は更新されるが並べ替えはしない。
            const initialQueueSize = this.programInfoQueue.size();

            if (initialQueueSize > 0) {
                await this.programInfoQueue.processNow(null).catch(error => {
                    console.error('[初回ロード] キュー処理でエラーが発生しました:', error);
                });
            }

            // 整列確定: settlingを解除し、人気順のときは1回だけ最終ソートをFLIPで滑らかに実行。
            // （新着順はソートせず notifybox のAPI順＝放送開始が新しい順を保つので、確定後の並べ替えは不要）
            this.appState.update.settling = false;
            const listContainer = document.getElementById('liveProgramContainer');
            if (listContainer && this.options.programsSort === 'active') {
                flipReorder(listContainer, () => this.sortProgramsInContainer(listContainer));
            }

            // サムネイル更新
            await new Promise(resolve => {
                this.updateThumbnail(true, resolve);
            });

            // 最低1秒のローディング時間を確保して終了
            await this.loadingManager.finishSessionWithMinDuration(1000);

            // 定期タイマーをリセット
            if (this.appState.sidebar.isOpen) {
                this.restartSidebarUpdate();
            }
        } catch (error) {
            console.error('[初回ロード] エラーが発生しました:', error);
            if (this.loadingManager.getCurrentSessionId()) {
                await this.loadingManager.finishSessionWithMinDuration(1000);
            }
        } finally {
            // 例外時も含め、確定中フラグは必ず解除する
            this.appState.update.settling = false;
            this.isPerformingInitialLoad = false;
        }
    }

    /**
     * 手動更新を実行
     * @param {boolean} [settle=false] - true の場合、初回ロードと同様に詳細を取得してから
     *   1回だけFLIPで人気順に整える（更新ボタン用）。ただし既に人気順で表示中なので新着順への
     *   一時退避はしない（settleAllowNewest=false）。false は軽量更新（タブ復帰・再オープン用）。
     */
    async performManualUpdate(settle = false) {
        // 多重防止: 前回の手動更新が処理中なら重複実行しない（開閉/タブ復帰/自動移動が重なった時に
        // getLivePrograms が重複して積まれるのを防ぐ。performInitialLoad の isPerformingInitialLoad と同様）。
        if (this.isPerformingManualUpdate) return;
        this.isPerformingManualUpdate = true;
        if (settle) {
            // 途中の再ソートを抑制し、詳細取得後に1回だけFLIPで整える。
            // すでに人気順で表示中のため、新着順への一時退避はしない。
            // 更新ボタンは明示操作なのでTTLを無視して全詳細を再取得する。
            this.appState.update.settleAllowNewest = false;
            this.appState.update.settling = true;
            this.appState.update.forceRefetch = true;
        }
        try {
            // 番組リスト更新
            await this.updateSidebar();

            if (settle) {
                // DOM更新完了を待つ
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                // 未取得/期限切れ(TTL超過)の詳細を取得（新鮮なものはスキップ）
                if (this.programInfoQueue.size() > 0) {
                    await this.programInfoQueue.processNow(null).catch(error => {
                        console.error('[手動更新] キュー処理でエラーが発生しました:', error);
                    });
                }
                // 確定: 人気順なら1回だけFLIPで最新の順序へ（動きが無ければ no-op）
                this.appState.update.settling = false;
                const listContainer = document.getElementById('liveProgramContainer');
                if (listContainer && this.options.programsSort === 'active') {
                    flipReorder(listContainer, () => this.sortProgramsInContainer(listContainer));
                }
            }

            // サムネイル更新
            await new Promise(resolve => {
                this.updateThumbnail(true, resolve);
            });

            // 最低1秒のローディング時間を確保して終了
            await this.loadingManager.finishSessionWithMinDuration(1000);

            // 定期タイマーをリセット
            if (this.appState.sidebar.isOpen) {
                this.restartSidebarUpdate();
            }
        } catch (error) {
            console.error('[手動更新] エラーが発生しました:', error);
            if (this.loadingManager.getCurrentSessionId()) {
                await this.loadingManager.finishSessionWithMinDuration(1000);
            }
        } finally {
            this.isPerformingManualUpdate = false;
            if (settle) {
                // 例外時も含め、各フラグを既定へ戻す
                this.appState.update.settling = false;
                this.appState.update.settleAllowNewest = true;
                this.appState.update.forceRefetch = false;
            }
        }
    }

    /**
     * 表示に使うデータソースを解決する（'api' | 'followPage'）。
     * options.dataSource: 'api'（従来のnotifybox+詳細API）/ 'followPage'（フォロー中ページ・スクレイプ）/
     * 'auto'（followPage優先・失敗時はapiへ自動降格。降格判定はStage5で実装予定）。
     * @returns {'api'|'followPage'}
     */
    _resolveDataSource() {
        const s = (this.options && this.options.dataSource) || 'api';
        if (s === 'followPage') return 'followPage';
        if (s === 'auto') return this._degradedToApi ? 'api' : 'followPage';
        return 'api';
    }

    // 直近の getLivePrograms が使ったソース由来の能力フラグ（updateSidebar のゲートに使う）
    get needsDetailQueue() { return this._activeListSource !== 'followPage'; }      // followPageは詳細同梱→キュー不要
    get detailsArriveWithList() { return this._activeListSource === 'followPage'; } // 初回から人気順で描画可（settling不要）

    /** 現在のソースに応じたサイドバー更新ループの間隔(ms) */
    _currentUpdateIntervalMs() {
        if (this._resolveDataSource() === 'followPage') return scrapeIntervalMs;
        return Number(this.options.updateProgramsInterval) * 1000;
    }

    /**
     * ライブ番組リストを取得（ソース抽象化の継ぎ目）。
     * どちらのソースでも「notifybox互換のリスト（{id: bare番号, title} 配列, 新着順）」を返し、
     * 以降の updateSidebar は共通処理でカードを組む。失敗時は false。
     */
    async getLivePrograms(rows = 100) {
        const source = this._resolveDataSource();
        this._activeListSource = source;
        const result = source === 'followPage'
            ? await this._getLiveProgramsViaScrape(rows)
            : await this._getLiveProgramsViaApi(rows);
        // ログイン/取得状態は最終結果で判定（scrape失敗でも #api_error を出す）
        if (this.elems.apiErrorElement) {
            this.elems.apiErrorElement.style.display = result ? 'none' : 'block';
        }
        return result;
    }

    /** 従来の notifybox 取得（api経路）。計測カウンタは従来どおりここで加算する。 */
    async _getLiveProgramsViaApi(rows = 100) {
        this.apiCallCounter.getLivePrograms++;
        this.apiCallCounter.totalCalls++;

        // タイムスタンプを記録（API呼び出し頻度の計算用）
        const now = Date.now();
        if (!this.apiCallCounter.recentTimestamps) {
            this.apiCallCounter.recentTimestamps = [];
        }
        this.apiCallCounter.recentTimestamps.push(now);

        // 異常検出：getLiveProgramsが1分以内に10回以上呼ばれた場合のみ警告
        if (!this.apiCallCounter.getLiveProgramsTimestamps) {
            this.apiCallCounter.getLiveProgramsTimestamps = [];
        }
        this.apiCallCounter.getLiveProgramsTimestamps.push(now);
        // 1分以上前のタイムスタンプを削除
        this.apiCallCounter.getLiveProgramsTimestamps = this.apiCallCounter.getLiveProgramsTimestamps.filter(t => now - t < apiRateWindowMs);

        if (this.apiCallCounter.getLiveProgramsTimestamps.length >= 10) {
            console.error(`🚨 [異常検出] getLivePrograms()が1分以内に${this.apiCallCounter.getLiveProgramsTimestamps.length}回呼ばれています！`);
        }

        return await fetchLivePrograms(rows);
    }

    /**
     * 【実験】フォロー中ページをスクレイプして notifybox 互換のリストを返す。
     * 全番組の詳細（視聴者数/コメント/ライブサムネ/配信者/providerType/会員限定/開始時刻）は
     * ここで storage に一括upsertされるので、以降のキュー投入は不要（needsDetailQueue=false）。
     */
    async _getLiveProgramsViaScrape() {
        const scraped = await fetchFollowedProgramsViaPage(); // 内部programInfo形の配列 or null
        if (!scraped) return false; // 失敗（未ログイン/構造崩れ/通信）。Stage5で auto-fallback。
        upsertProgramInfos(scraped); // 全件フルレコードで書き戻し（_fetchedAt付与）
        // notifybox 形（bare id + title）を beginTime降順（=新着順）のまま返す
        return scraped.map((p) => ({ id: String(p.id).replace(/^lv/, ''), title: p.title }));
    }

    /**
     * サイドバーを更新
     * @param {Object} [opts]
     * @param {Array<any>|null} [opts.preloadedList=null] - 取得済みの放送中番組リスト（notifybox_content）。
     *   渡すと getLivePrograms を再取得せずそのまま使う（新番組先行検知の二重fetch回避）。
     * @param {boolean} [opts.silent=false] - true のときローディングセッション（更新ボタンのスピナー）を
     *   開始しない。先行検知の裏側更新で使う（スピナーを光らせず・セッションもリークさせない）。
     */
    async updateSidebar({ preloadedList = null, silent = false } = {}) {
        // ローディングセッション開始（サイレント時は開始しない＝スピナー無し）
        if (!silent) this.loadingManager.startSession();

        try {
            // localStorageから番組情報を取得
            const programInfos = getProgramInfosFromStorage();

            const livePrograms = preloadedList || await this.getLivePrograms(100);
            if (!livePrograms) {
                // 失敗時は既存の番組数を維持
                const container = document.getElementById('liveProgramContainer');
                if (container && container.children.length > 0) {
                    this.updateProgramCount(container.children.length);
                }
                return;
            }
            
            // 空配列のときは既存DOMを維持
            if (Array.isArray(livePrograms) && livePrograms.length === 0) {
                this.updateProgramCount(0);
                return;
            }

            const container = document.getElementById('liveProgramContainer');
            const frag = document.createDocumentFragment();
            const existingMap = new Map();
            if (container) {
                Array.from(container.children).forEach((el) => {
                    if (el && el.id) existingMap.set(el.id, el);
                });
            }

            let missingDetailCount = 0;
            livePrograms.forEach((program, apiIndex) => {
                if (!program || !program.id) return;

                const data = programInfos.find((info) => info.id === `lv${program.id}`);
                // 詳細（人気度の元データ）が未取得の番組を数える（初回の描画順の判定に使う）
                if (!data) missingDetailCount++;
                const id = String(program.id);
                const existing = existingMap.get(id);

                if (existing) {
                    // 軽い更新（属性・タイトル・リンク先）
                    existing.setAttribute('active-point', String(calculateActivePoint(data || program)));
                    // 新着順は API順（notifybox は放送開始が新しい順で返す）を保つためのインデックス
                    existing.setAttribute('data-api-index', String(apiIndex));
                    const titleEl = existing.querySelector('.program_title');
                    if (titleEl) titleEl.textContent = (data && data.title) || (program && program.title) || 'タイトル不明';
                    const linkEl = existing.querySelector('.program_thumbnail a');
                    if (linkEl) linkEl.href = data && data.id ? `${watchPageBaseUrl}${data.id}` : `${watchPageBaseUrl}lv${program.id}`;
                    frag.appendChild(existing);
                } else {
                    // DOM要素を直接作成
                    const element = data
                        ? makeProgramElement(data, this.loadingImageURL)
                        : makeProgramElement(program, this.loadingImageURL);
                    if (element) {
                        element.setAttribute('data-api-index', String(apiIndex));
                        frag.appendChild(element);
                    }
                }

                // キューに追加（最新の放送中番組リスト）
                // updateSidebar()が120秒ごとに最新リストを取得するため、
                // 自動的に最新の番組がキューに追加される。
                // TTLキャッシュ: 直近 programInfoTtlMs 以内に取得済みの詳細は再取得をスキップし、
                // 2回目以降の読み込みを高速化＆API負荷を軽減する。
                // forceRefetch（更新ボタン）時はTTLを無視して全番組を再取得する。
                const isFresh = data && data._fetchedAt && (Date.now() - data._fetchedAt) < programInfoTtlMs;
                // followPage経路(needsDetailQueue=false)は詳細が同梱済みなのでキュー投入しない。
                // forceRefetch(手動更新)でも投入しない＝再スクレイプで全詳細が更新されるため。
                if (this.needsDetailQueue && (this.appState.update.forceRefetch || !isFresh)) {
                    this.programInfoQueue.add(program.id);
                }
            });

            const liveProgramContainer = document.getElementById('liveProgramContainer');
            if (!liveProgramContainer) {
                return;
            }

            // DOM更新
            this.appState.update.isInserting = true;
            liveProgramContainer.replaceChildren(frag);

            // 初回整列中は、キャッシュだけで人気順を確定できるか（＝詳細未取得の番組が無いか）で描画順を決める。
            // 全番組がキャッシュ済みなら最初から人気順で描画し、開くたびの並べ替え（移動）を避ける。
            // ただし settleAllowNewest が false（更新ボタン）のときは新着順への退避はしない。
            if (this.appState.update.settling) {
                // followPage経路(detailsArriveWithList)は初回から詳細が揃う→新着待避不要（settlingNeedsNewest=false）。
                this.appState.update.settlingNeedsNewest =
                    !this.detailsArriveWithList && this.appState.update.settleAllowNewest && missingDetailCount > 0;
            }

            // ソート
            const container2 = document.getElementById('liveProgramContainer');
            if (container2) this.sortProgramsInContainer(container2);

            // 列数は「意図した幅」(appState.sidebar.width)で決める。開閉アニメ中の途中幅(offsetWidth)を
            // 使うと、開いた直後のリスト再描画がアニメ中に走った時に1列⇔多列がパタついてサムネが一瞬巨大化するため。
            setProgramContainerWidth(this.elems, this.appState.sidebar.width);

            // 番組数更新
            this.updateProgramCount(livePrograms.length);
            
            this.appState.update.isInserting = false;
        } catch (error) {
            console.error('[updateSidebar] エラーが発生しました:', error);
            this.appState.update.isInserting = false;
        }
    }

    /**
     * サムネイルを更新
     */
    updateThumbnail(force, onComplete) {
        // DOM操作中は実行しない
        if (this.appState.update.isInserting) {
            if (onComplete) onComplete();
            return;
        }
        
        const programInfos = getProgramInfosFromStorage();
        if (!programInfos || programInfos.length === 0) {
            if (onComplete) onComplete();
            return;
        }
        
        updateThumbnailsFromStorage(programInfos, { force: !!force, onComplete });
    }

    /**
     * 表示に使うソート種別を返す。
     * 初回整列の確定中(settling)かつ人気順のときは、確定するまで新着順で安定表示する。
     * @returns {string} 'active' | 'newest'
     */
    getEffectiveSortType() {
        // 初回整列の確定中で人気順、かつ「詳細未取得の番組がありキャッシュだけでは人気順を確定できない」
        // ときだけ、一時的に新着順で安定表示する。
        // 全番組がキャッシュ済み（人気順を確定できる）なら、変更前と同様に最初から人気順で描画する。
        if (this.appState.update.settling
            && this.options.programsSort === 'active'
            && this.appState.update.settlingNeedsNewest) {
            return 'newest';
        }
        return this.options.programsSort;
    }

    /**
     * 番組リストをソート（統一関数を使用）
     */
    sortProgramsInContainer(container) {
        sortPrograms(container, this.getEffectiveSortType());
    }

    /**
     * 番組数を表示
     */
    updateProgramCount(count) {
        const programCountElement = document.getElementById('program_count');
        if (programCountElement) {
            programCountElement.textContent = String(count);
        }
    }

    /**
     * active-point属性を更新してソートを実行
     * 番組詳細情報が取得された後に呼ばれる
     * @param {boolean} shouldSort - ソートを実行するかどうか（初回/サイドバーオープン/更新ボタン時のみtrue）
     */
    updateActivePointsAndSort(shouldSort = false) {
        const container = document.getElementById('liveProgramContainer');
        if (!container) return;

        const programInfos = getProgramInfosFromStorage();
        if (!programInfos || !Array.isArray(programInfos)) return;

        // 全ての番組要素のactive-pointを更新
        const programElements = container.querySelectorAll('.program_container');
        let hasUpdate = false;
        
        programElements.forEach((element) => {
            if (!element.id) return;
            
            const programId = `lv${element.id}`;
            const programInfo = programInfos.find((info) => info.id === programId);
            
            if (programInfo) {
                const newActivePoint = calculateActivePoint(programInfo);
                const currentActivePoint = parseFloat(element.getAttribute('active-point') || '0');
                
                // active-pointが更新される場合のみ更新
                if (Math.abs(newActivePoint - currentActivePoint) > 0.0001) {
                    element.setAttribute('active-point', String(newActivePoint));
                    hasUpdate = true;
                }
            }
        });

        // 初回整列の確定中(settling)は並べ替えない（確定後に1回だけ実行してガチャつきを防ぐ）。
        // それ以外は従来通り、shouldSortかつactive-pointが更新された場合のみソート。
        if (!this.appState.update.settling && shouldSort && hasUpdate) {
            this.sortProgramsInContainer(container);
        }
    }
}

