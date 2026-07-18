import { fetchLivePrograms, fetchProgramInfo } from '../services/api.js';
import { fetchFollowedProgramsViaPage, isLiveScreenshotUrl } from '../services/followPageSource.js';
import { getProgramInfos as getProgramInfosFromStorage, upsertProgramInfos } from '../services/storage.js';
import { makeProgramElement, calculateActivePoint, updateThumbnailsFromStorage } from '../render/sidebar.js';
import { setProgramContainerWidth } from '../ui/layout.js';
import { sortPrograms } from '../utils/sorting.js';
import { updateThumbnailInterval, watchPageBaseUrl } from '../config/constants.js';

// A1: 新番組など「ライブサムネがまだ空」の番組を、20秒サムネループで詳細APIから再取得する設定。
const THUMB_RETRY_MAX_ATTEMPTS = 8   // 1番組を20秒ループで再取得する最大回数（超えたら120秒サイクルへ委ねる）
const THUMB_RETRY_MAX_PER_CYCLE = 10 // 1ティックで叩く詳細APIの上限（暴走防止）

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
        // A1: ライブサムネ空番組の再取得試行回数（id -> attempts）。諦め判定に使う。
        this._thumbRetryAttempts = new Map();
    }

    /**
     * サムネイル更新タイマーを開始（20秒周期）。
     * 保存済みのライブサムネURL（安定）にキャッシュバスターを付けて <img> を更新するだけで、
     * ネットワーク詳細取得は行わない。動くサムネ（②）もここでプリロードした画像から給餌される。
     */
    startThumbnailUpdate() {
        const runUpdateThumbnail = async () => {
            // 新番組など「ライブサムネがまだ空」の番組を詳細APIで再取得し、用意でき次第すぐ差し替える（A1）
            await this._retryPendingLiveThumbnails();
            this.updateThumbnail();
            const interval = this.options.updateThumbnailInterval || updateThumbnailInterval;
            const timer = setTimeout(runUpdateThumbnail, interval * 1000);
            this.appState.setTimer('thumbnail', timer);
        };

        runUpdateThumbnail(); // 即座に実行
    }

    /**
     * A1: 描画中の user 番組でライブサムネが空のもの（放送直後で未生成 等）だけ、
     * 詳細API(fetchProgramInfo)で liveScreenshotThumbnailUrls を再取得し、取れ次第 storage を更新する。
     * 20秒サムネループから呼ぶので、新番組は最大~20秒でライブサムネへ差し替わる。
     * 空の少数だけ・番組ごとに諦め回数あり＝旧「全番組×詳細API」の重さには戻らない。
     * @returns {Promise<boolean>} 1件以上ライブサムネを補完したら true
     */
    async _retryPendingLiveThumbnails() {
        const container = document.getElementById('liveProgramContainer');
        if (!container) return false;
        const rendered = new Set();
        for (const el of container.children) { if (el && el.id) rendered.add(el.id); }
        if (rendered.size === 0) return false;

        const infos = getProgramInfosFromStorage();
        if (!Array.isArray(infos)) return false;

        // 対象: 描画中 × user × 非会員限定 × ライブサムネ未取得
        const pending = infos.filter((info) => {
            if (!info || info.providerType !== 'user' || info.isMemberOnly) return false;
            if (!rendered.has(String(info.id).replace(/^lv/, ''))) return false;
            const hasLive = info.liveScreenshotThumbnailUrls && info.liveScreenshotThumbnailUrls.middle;
            return !hasLive && !info.thumbnailUrl;
        });

        // リストから消えた/解決済みの id は試行回数マップから掃除
        const pendingIds = new Set(pending.map((i) => i.id));
        for (const id of Array.from(this._thumbRetryAttempts.keys())) {
            if (!pendingIds.has(id)) this._thumbRetryAttempts.delete(id);
        }

        // 諦め回数未満のものだけ、1ティックの上限件数まで
        const targets = pending
            .filter((info) => (this._thumbRetryAttempts.get(info.id) || 0) < THUMB_RETRY_MAX_ATTEMPTS)
            .slice(0, THUMB_RETRY_MAX_PER_CYCLE);
        if (targets.length === 0) return false;

        const updates = [];
        await Promise.all(targets.map(async (info) => {
            this._thumbRetryAttempts.set(info.id, (this._thumbRetryAttempts.get(info.id) || 0) + 1);
            try {
                const detail = await fetchProgramInfo(String(info.id).replace(/^lv/, ''));
                if (!detail) return;
                const ss = detail.liveScreenshotThumbnailUrls;
                const cand = (ss && (ss.middle || ss.large || ss.small)) || '';
                if (isLiveScreenshotUrl(cand)) {
                    updates.push({ ...info, liveScreenshotThumbnailUrls: { middle: cand }, large1280x720ThumbnailUrl: cand, thumbnailUrl: cand });
                    this._thumbRetryAttempts.delete(info.id);
                }
            } catch (_e) { /* 個別失敗は次ティックで再挑戦 */ }
        }));

        if (updates.length === 0) return false;
        upsertProgramInfos(updates);
        return true;
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
