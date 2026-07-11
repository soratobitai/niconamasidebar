import { fetchLivePrograms } from '../services/api.js';
import { getProgramInfos as getProgramInfosFromStorage } from '../services/storage.js';
import { makeProgramElement, calculateActivePoint, updateThumbnailsFromStorage, flipReorder } from '../render/sidebar.js';
import { setProgramContainerWidth } from '../ui/layout.js';
import { sortPrograms } from '../utils/sorting.js';
import { updateThumbnailInterval, programInfoTtlMs, watchPageBaseUrl, apiRateWindowMs } from '../config/constants.js';

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
                const retryTimer = setTimeout(updateSidebarInterval, Number(this.options.updateProgramsInterval) * 1000);
                this.appState.setTimer('sidebar', retryTimer);
                return;
            }
            await this.updateSidebar();
            // 定期更新時：最低1秒のローディング時間を確保して終了
            if (this.loadingManager.getCurrentSessionId()) {
                await this.loadingManager.finishSessionWithMinDuration(1000);
            }
            // 完了後にタイマーをセット
            const timer = setTimeout(updateSidebarInterval, Number(this.options.updateProgramsInterval) * 1000);
            this.appState.setTimer('sidebar', timer);
        };
        
        const timer = setTimeout(updateSidebarInterval, Number(this.options.updateProgramsInterval) * 1000);
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
     * ライブ番組リストを取得
     */
    async getLivePrograms(rows = 100) {
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
        
        const result = await fetchLivePrograms(rows);
        
        if (this.elems.apiErrorElement) {
            this.elems.apiErrorElement.style.display = result ? 'none' : 'block';
        }
        return result;
    }

    /**
     * サイドバーを更新
     */
    async updateSidebar() {
        // ローディングセッション開始
        this.loadingManager.startSession();
        
        try {
            // localStorageから番組情報を取得
            const programInfos = getProgramInfosFromStorage();

            const livePrograms = await this.getLivePrograms(100);
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
                if (this.appState.update.forceRefetch || !isFresh) {
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
                this.appState.update.settlingNeedsNewest =
                    this.appState.update.settleAllowNewest && missingDetailCount > 0;
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

