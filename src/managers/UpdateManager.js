import { fetchLivePrograms } from '../services/api.js';
import { fetchFollowedProgramsViaPage } from '../services/followPageSource.js';
import { getProgramInfos as getProgramInfosFromStorage, upsertProgramInfos } from '../services/storage.js';
import { makeProgramElement, calculateActivePoint, updateThumbnailsFromStorage } from '../render/sidebar.js';
import { setProgramContainerWidth } from '../ui/layout.js';
import { sortPrograms } from '../utils/sorting.js';
import { updateThumbnailInterval, watchPageBaseUrl } from '../config/constants.js';

/**
 * 更新処理とタイマーの管理
 *
 * データ取得の役割分担:
 *   - リスト（どの番組を並べるか）: notifybox API（fetchLivePrograms）
 *   - 番組詳細（視聴者数/コメント/ライブサムネURL/配信者/会員限定/開始時刻）:
 *     フォロー中ページのスクレイプ1回（fetchFollowedProgramsViaPage）で全番組ぶんを一括取得し
 *     storage へ upsert する。従来の「1番組=1詳細API×N」を1リクエストに置換した効率化。
 *   - サムネ画像の再取得: 別の20秒ループ（startThumbnailUpdate）が保存済みURL＋キャッシュバスターで更新。
 *
 * 詳細はリストと同時（updateSidebar内で並列取得）に storage へ載るため、カード生成時点で
 * 人気度（active-point）が確定している。よって「詳細が揃うまで新着順で待つ」整列確定機構は不要。
 */
export class UpdateManager {
    constructor(appState, loadingManager, options, elems, loadingImageURL) {
        this.appState = appState;
        this.loadingManager = loadingManager;
        this.options = options;
        this.elems = elems;
        this.loadingImageURL = loadingImageURL;

        // 重複実行防止フラグ
        this.isPerformingManualUpdate = false;
    }

    /**
     * サムネイル更新タイマーを開始（20秒周期）。
     * 保存済みのライブサムネURL（安定）にキャッシュバスターを付けて <img> を更新するだけで、
     * ネットワーク詳細取得は行わない。動くサムネ（②）もここでプリロードした画像から給餌される。
     */
    startThumbnailUpdate() {
        const runUpdateThumbnail = () => {
            this.updateThumbnail();
            const interval = this.options.updateThumbnailInterval || updateThumbnailInterval;
            const timer = setTimeout(runUpdateThumbnail, interval * 1000);
            this.appState.setTimer('thumbnail', timer);
        };

        runUpdateThumbnail(); // 即座に実行
    }

    /**
     * サイドバー更新タイマーを開始（updateProgramsInterval 周期）。
     * 1周期ごとに notifybox（リスト）＋スクレイプ（詳細）を取り込んで再描画する。
     */
    startSidebarUpdate() {
        // 既存のタイマーがある場合は確実にクリア
        const existingTimer = this.appState.getTimer('sidebar');
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const updateSidebarInterval = async () => {
            // 非表示タブでは更新しない（背景でのスクレイプ/リスト取得を避ける）。
            // 可視復帰時に visibilitychange ハンドラが即座に performManualUpdate で取り直す。
            if (!this.appState.isVisible()) {
                const idleTimer = setTimeout(updateSidebarInterval, this._currentUpdateIntervalMs());
                this.appState.setTimer('sidebar', idleTimer);
                return;
            }
            // 別の更新（手動更新）が進行中なら、今回の定期更新はスキップして次回に回す。
            if (this.appState.isLoading()) {
                const retryTimer = setTimeout(updateSidebarInterval, this._currentUpdateIntervalMs());
                this.appState.setTimer('sidebar', retryTimer);
                return;
            }
            try {
                await this.updateSidebar();
                if (this.loadingManager.getCurrentSessionId()) {
                    await this.loadingManager.finishSessionWithMinDuration(1000);
                }
                // 詳細はスクレイプで更新済み。保存済みURLからサムネ<img>も反映しておく。
                this.updateThumbnail();
            } catch (error) {
                console.error('[updateSidebarInterval] エラー:', error);
            }
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
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.appState.clearTimer('sidebar');
        }
        this.startSidebarUpdate();
    }

    /**
     * 手動更新を実行（初回ロード・更新ボタン・タブ復帰・サイドバー再オープン共通）。
     * リスト＋詳細を取り込み、サムネを反映し、定期タイマーを張り直す。
     * 詳細は毎回スクレイプで全件更新されるため、TTLや「軽量/しっかり」の区別は不要。
     */
    async performManualUpdate() {
        // 多重防止（開閉/タブ復帰/自動移動が重なった時の二重取得を防ぐ）
        if (this.isPerformingManualUpdate) return;
        this.isPerformingManualUpdate = true;
        try {
            await this.updateSidebar();

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
        }
    }

    /** 現在の更新間隔(ms)。リスト＋詳細サイクルの周期。 */
    _currentUpdateIntervalMs() {
        return Number(this.options.updateProgramsInterval) * 1000;
    }

    /**
     * ライブ番組リスト（並び順の元）を notifybox から取得する。
     * 返り値は notifybox_content 配列（{id: bare番号, title} 等）、失敗時は false。
     * ログイン/取得状態に応じて #api_error の表示を切り替える。
     */
    async getLivePrograms(rows = 100) {
        const result = await fetchLivePrograms(rows);
        if (this.elems.apiErrorElement) {
            this.elems.apiErrorElement.style.display = result ? 'none' : 'block';
        }
        return result;
    }

    /**
     * フォロー中ページを1回スクレイプして、放送中フォロー番組の詳細を storage へ一括 upsert する。
     * 失敗（未ログイン/構造変化/通信エラー）時は何もしない＝その周は詳細が古いまま（フォールバックしない）。
     */
    async _refreshDetailsViaScrape() {
        const scraped = await fetchFollowedProgramsViaPage(); // 内部programInfo形の配列 or null
        if (scraped) upsertProgramInfos(scraped); // 全件フルレコードで書き戻し（_fetchedAt付与）
    }

    /**
     * サイドバーを更新（リスト＝notifybox、詳細＝スクレイプ を並列取得して描画）。
     */
    async updateSidebar() {
        // ローディングセッション開始
        this.loadingManager.startSession();

        try {
            // リスト（notifybox）と 詳細（スクレイプ→storage upsert）を並列取得。
            // 詳細を先に storage へ載せてからカードを組むので、初回から人気度が確定する。
            const [livePrograms] = await Promise.all([
                this.getLivePrograms(100),
                this._refreshDetailsViaScrape(),
            ]);

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

            // スクレイプ upsert 後の storage を読む（詳細が反映済み）
            const programInfos = getProgramInfosFromStorage();

            const container = document.getElementById('liveProgramContainer');
            const frag = document.createDocumentFragment();
            const existingMap = new Map();
            if (container) {
                Array.from(container.children).forEach((el) => {
                    if (el && el.id) existingMap.set(el.id, el);
                });
            }

            livePrograms.forEach((program, apiIndex) => {
                if (!program || !program.id) return;

                // 1番組のカード生成で失敗しても、その番組だけスキップしてリスト全体は描画する。
                // （詳細がスクレイプに無い番組＝ページング超過やスクレイプ失敗時に不正データを踏んでも
                //   サイドバー全体が空にならないようにする防御）
                try {
                    const data = programInfos.find((info) => info.id === `lv${program.id}`);
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
                } catch (e) {
                    console.warn('[updateSidebar] カード生成に失敗（この番組をスキップ）:', program && program.id, e);
                }
            });

            const liveProgramContainer = document.getElementById('liveProgramContainer');
            if (!liveProgramContainer) {
                return;
            }

            // DOM更新
            this.appState.update.isInserting = true;
            liveProgramContainer.replaceChildren(frag);

            // ソート（詳細が揃っているので最初から programsSort で確定できる）
            this.sortProgramsInContainer(liveProgramContainer);

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
     * 番組リストをソート（設定のソート種別で並べる）
     */
    sortProgramsInContainer(container) {
        sortPrograms(container, this.options.programsSort);
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
}
