import { fetchLivePrograms, fetchProgramInfo } from '../services/api.js';
import { fetchFollowedProgramsViaPage, isLiveScreenshotUrl } from '../services/followPageSource.js';
import { getProgramInfos as getProgramInfosFromStorage, upsertProgramInfos, patchProgramThumbnail } from '../services/storage.js';
import { makeProgramElement, calculateActivePoint, updateThumbnailsFromStorage } from '../render/sidebar.js';
import { setProgramContainerWidth } from '../ui/layout.js';
import { sortPrograms } from '../utils/sorting.js';
import { updateThumbnailInterval, watchPageBaseUrl, newProgramFastPollMs } from '../config/constants.js';

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
        // 番組ごとの自己連鎖サムネタイマー（id -> timeoutId）と稼働フラグ。
        this._thumbTimers = new Map();
        this._thumbRunning = false;
        // 実行世代。start/stop のたび ++ し、停止/再開を跨いだ古いサイクルの張り直しを無効化する。
        this._thumbGen = 0;
        // _updateOneThumbnailAndWait の安全ガードタイマー（stop時に一括clearするため追跡）。
        this._pendingGuards = new Set();
    }

    /**
     * サムネイル更新を開始する（番組ごとの独立・自己連鎖タイマー方式）。
     *
     * 昔は「全番組を同時に一斉更新」→ リストがいっぺんに切り替わって気持ち悪かった。
     * いまは各番組が自分のタイマーを持ち、「更新が完了してから次の20秒を張り直す」自己連鎖にする。
     * 周期＝20秒＋その回の作業時間（ライブサムネの取得・デコード）になり、作業時間が毎回わずかに違うため、
     * 読み込み時に一斉に始まっても時間とともに少しずつズレていく（自然ドリフト）。
     * ※読み込み時の一斉更新は performManualUpdate（updateThumbnail 全件）が担う。ここは以後の更新を受け持つ。
     */
    startThumbnailUpdate() {
        if (!this._thumbTimers) this._thumbTimers = new Map(); // id -> timeoutId
        if (this._thumbRunning) { this._syncThumbTimers(); return; } // 二重開始防止（冪等）
        this._thumbRunning = true;
        this._thumbGen = (this._thumbGen || 0) + 1; // 世代を進める（停止跨ぎの旧サイクルを無効化）
        // main.js の二重開始ガード(!getTimer('thumbnail'))と停止処理(stopAllTimers)に乗せるためのセンチネル。
        this.appState.setTimer('thumbnail', true);
        this._syncThumbTimers();
    }

    /** サムネ更新を停止し、全番組の自己連鎖タイマー・ガードを片付ける（サイドバー閉/クリーンアップ時）。 */
    stopThumbnailUpdate() {
        this._thumbRunning = false;
        this._thumbGen = (this._thumbGen || 0) + 1; // 世代を進める（in-flightサイクルの張り直しを無効化）
        if (this._thumbTimers) {
            for (const t of this._thumbTimers.values()) clearTimeout(t);
            this._thumbTimers.clear();
        }
        if (this._pendingGuards) {
            // 各待機を finish() で解決（ガードclear＋Promise resolve）＝await で宙吊りの中断サイクルの
            // フレーム（detachedカード参照ごと）を解放する。単に clearTimeout だけだと未resolveでリークする。
            for (const e of Array.from(this._pendingGuards)) { try { e.finish(); } catch (_e) { /* noop */ } }
            this._pendingGuards.clear();
        }
    }

    /** サムネ1周期の基準間隔(ms)。作業完了後にこの時間だけ待って次サイクルを張る。 */
    _currentThumbCycleMs() {
        return (Number(this.options.updateThumbnailInterval) || updateThumbnailInterval) * 1000;
    }

    /**
     * 現在のカードと自己連鎖タイマーを突き合わせる。
     * 新しく現れたカードにはサイクルを開始し、消えたカードのタイマーは片付ける。
     * 初回サイクルは「基準間隔を番組数で割った位置」へ均等配置する（理由は下のコメント）。
     * 読み込み直後の一斉更新は performManualUpdate 側が担うため、ここでは間隔を空けてよい。
     * 開始時と updateSidebar の後（新規/削除カードの後）に呼ぶ。
     */
    _syncThumbTimers() {
        if (!this._thumbRunning) return;
        if (!this._thumbTimers) this._thumbTimers = new Map();
        const container = document.getElementById('liveProgramContainer');
        if (!container) return;
        const cycleMs = this._currentThumbCycleMs();
        const cards = Array.from(container.children);
        const present = new Set();
        cards.forEach((el, i) => {
            const id = el && el.id;
            if (!id) return;
            present.add(id);
            if (!this._thumbTimers.has(id)) {
                // 初回サイクルを周期内へ均等配置する（＝位相をずらす）。
                // 全カードに同じ delay を張ると初回が完全同時になり、全画像が HTTP/2 の同一接続で
                // 多重化されて帯域を分け合う＝どの番組も「同じ時間」で完了してしまう。作業時間が
                // 共通化すると全番組が同じ瞬間に次を張り直すため、「作業時間ぶん自然にドリフトする」
                // という自己連鎖の前提が原理的に成立せず、一斉状態がそのまま自己維持される。
                // さらに周期が「基準間隔＋一斉取得にかかる時間」まで伸びる
                // （実測: 16番組で作業15.1秒→周期35.1秒。20秒間隔が守れずコマを取りこぼす）。
                // 位相を分散させれば同時取得が減って作業時間が短くなり、周期も基準へ戻る。
                //
                // ただし基準間隔ぶん「後ろへ」倒してから分散させること。前倒しすると
                // performManualUpdate の force 一斉更新（実測15秒級）の最中に発火する。その時点では
                // 新規カードの dataset.lastSuccessAt/key が未設定（makeProgramElement は src を入れる
                // だけで、これらを書くのは applySuccess＝プリロード完了後）なので TTL ガードが素通りし、
                // 同じ <img> に2本目の取得が走る＝減らしたい同時接続を起動直後に増やしてしまう。
                this._scheduleThumbCycle(id, cycleMs + Math.round((cycleMs * (i + 1)) / cards.length));
            }
        });
        // 消えた番組のタイマーを解放（各サイクルでも自然停止するが、ここで即掃除する）
        for (const id of Array.from(this._thumbTimers.keys())) {
            if (!present.has(id)) {
                clearTimeout(this._thumbTimers.get(id));
                this._thumbTimers.delete(id);
            }
        }
    }

    /** 指定番組の次サイクルを delayMs 後に予約する（既存タイマーは必ず clear してから張り＝孤児化防止）。 */
    _scheduleThumbCycle(id, delayMs) {
        const prev = this._thumbTimers.get(id);
        if (prev) clearTimeout(prev); // set による上書きで旧タイマーが孤児化するのを防ぐ
        const timer = setTimeout(() => this._runThumbCycle(id), delayMs);
        this._thumbTimers.set(id, timer);
    }

    /**
     * 1番組の1サイクル: （空サムネの若い番組なら詳細APIで追撃 →）その番組のサムネ<img>を更新し、
     * 画像の読み込み完了を待ってから次の20秒を張り直す（自己連鎖＝作業時間ぶん自然にドリフトする）。
     * stop/再開を跨いだ古いサイクルは世代(gen)不一致で張り直さない（二重タイマー＝ゴースト連鎖の防止）。
     */
    async _runThumbCycle(id) {
        if (!this._thumbRunning) return; // 停止中（Mapはstopで掃除済み）→何もしない
        const gen = this._thumbGen; // このサイクルの世代を捕捉
        const container = document.getElementById('liveProgramContainer');
        const card = container ? document.getElementById(id) : null;
        // カードが消えた/コンテナ外ならこのサイクルを終了（再スケジュールしない）
        if (!card || !container.contains(card)) { this._thumbTimers.delete(id); return; }
        // 背景タブは rAF が止まり onSettled が来ない（更新も走らない）。ガード40秒の空回しを避けるため、
        // 更新は行わず軽く次サイクルだけ張る。前景復帰後の一斉更新は performManualUpdate が担う。
        if (typeof document !== 'undefined' && document.hidden) {
            if (this._thumbRunning && gen === this._thumbGen) this._scheduleThumbCycle(id, this._currentThumbCycleMs());
            return;
        }
        try {
            await this._fetchLiveThumbIfPendingYoung(id); // A1統合（空＆若い番組だけ詳細API追撃）
            await this._updateOneThumbnailAndWait(id);    // <img>更新（読み込み完了まで待つ＝ドリフト源）
        } catch (_e) { /* 個別失敗は無視して次サイクルへ */ }
        // 世代一致かつ稼働中のときだけ張り直す。不一致（stop/再開を跨いだ古いサイクル）は Map を触らず終了
        // ＝新世代が張ったタイマーを消さない。
        if (this._thumbRunning && gen === this._thumbGen) {
            this._scheduleThumbCycle(id, this._currentThumbCycleMs());
        }
    }

    /**
     * その番組のサムネ<img>を1件だけ更新し、画像の読み込み(全プリロード)が settle するまで待つ Promise。
     * 万一画像が固まっても、基準間隔の2倍で安全にタイムアウトして次サイクルへ進む。
     */
    _updateOneThumbnailAndWait(id) {
        return new Promise((resolve) => {
            let done = false;
            let guard;
            const entry = {};
            // finish は「ガードclear＋Set除去＋resolve」を1回だけ行う。stop時にもこれを呼ぶことで
            // 待機Promiseを確実に解決し、await で宙吊りの _runThumbCycle フレームを解放する。
            const finish = () => {
                if (done) return;
                done = true;
                clearTimeout(guard);
                if (this._pendingGuards) this._pendingGuards.delete(entry);
                resolve();
            };
            entry.finish = finish;
            guard = setTimeout(finish, this._currentThumbCycleMs() * 2); // 画像がハングしても2×間隔で必ず前進
            if (this._pendingGuards) this._pendingGuards.add(entry);      // stop時に一括 finish するため追跡
            this.updateThumbnail(false, null, new Set([id]), finish);     // 全プリロード settle でも finish
        });
    }

    /**
     * A1統合: 描画中で「user・非会員・ライブサムネ空」かつ beginAt が「若い」番組だけ、
     * 詳細API(fetchProgramInfo)でライブスクショを1回追撃し、取れたら storage を更新する。
     * 若さ(newProgramFastPollMs)を過ぎた空番組＝ほぼ固定画像運用とみなし追撃しない
     * （以降はリスト更新スクレイプ fillMissingDetails の60〜180秒に委譲）。旧「8回打ち切り」の代替。
     * @param {string} id 番組ID（数値文字列・lvなし）
     */
    async _fetchLiveThumbIfPendingYoung(id) {
        const infos = getProgramInfosFromStorage();
        if (!Array.isArray(infos)) return;
        const info = infos.find((i) => i && i.id === `lv${id}`);
        if (!info || info.providerType !== 'user' || info.isMemberOnly) return;
        const hasLive = info.liveScreenshotThumbnailUrls && info.liveScreenshotThumbnailUrls.middle;
        if (hasLive || info.thumbnailUrl) return; // 既にライブサムネあり＝追撃不要
        // beginAt ゲート：開始から newProgramFastPollMs 以内の若い番組だけ追撃（古い/不明は追わない）
        const beginAt = info.onAirTime && info.onAirTime.beginAt;
        const startMs = beginAt ? Date.parse(beginAt) : NaN;
        if (!Number.isFinite(startMs) || (Date.now() - startMs) >= newProgramFastPollMs) return;
        try {
            const detail = await fetchProgramInfo(id);
            if (!detail) return;
            const ss = detail.liveScreenshotThumbnailUrls;
            const cand = (ss && (ss.middle || ss.large || ss.small)) || '';
            if (isLiveScreenshotUrl(cand)) {
                // await を跨いだ stale スナップショットの全置換だと、その間にスクレイプが入れた最新の
                // 視聴者数等を巻き戻す(lost update)。サムネ欄だけを最新レコードに再read→マージする。
                patchProgramThumbnail(id, { liveScreenshotThumbnailUrls: { middle: cand }, large1280x720ThumbnailUrl: cand, thumbnailUrl: cand });
            }
        } catch (_e) { /* 個別失敗は次サイクルで再挑戦（若いうちは） */ }
    }

    /**
     * サイドバー更新タイマーを開始（updateProgramsInterval 周期）。
     * 1周期ごとに notifybox（リスト）＋スクレイプ（詳細）を取り込んで再描画する。
     */
    startSidebarUpdate() {
        // 既存タイマーを消し、世代を進めて in-flight の旧チェーンと縁を切る。
        const existingTimer = this.appState.getTimer('sidebar');
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        this._sidebarGen = (this._sidebarGen || 0) + 1;
        const gen = this._sidebarGen; // このチェーンの世代を捕捉

        // 次サイクルの予約。世代が進んでいたら張らない＝旧チェーンはここで自然消滅する。
        // 不一致時は appState のタイマーも触らない（新世代が張ったものを消さないため）。
        const scheduleNext = () => {
            if (gen !== this._sidebarGen) return;
            const timer = setTimeout(updateSidebarInterval, this._currentUpdateIntervalMs());
            this.appState.setTimer('sidebar', timer);
        };

        const updateSidebarInterval = async () => {
            // 発火時点で旧世代なら何もしない（clearTimeout が間に合わずキュー済みだった場合の保険）。
            if (gen !== this._sidebarGen) return;
            // 別の更新（手動更新）が進行中なら、今回の定期更新はスキップして次回に回す。
            if (this.appState.isLoading()) {
                scheduleNext();
                return;
            }
            try {
                await this.updateSidebar();
                // await を跨いだ後にも世代を見る。停止/再開を跨いだ旧チェーンがここへ戻ってくると、
                // getCurrentSessionId() は「今動いている別の更新」のセッションを返すため、
                // 他人のローディングセッションを finish してしまう（＝手動更新がまだ走っているのに
                // 更新ボタンの pointer-events が戻り、押せるのに無反応な状態になる）。
                if (gen !== this._sidebarGen) return;
                if (this.loadingManager.getCurrentSessionId()) {
                    await this.loadingManager.finishSessionWithMinDuration(1000);
                }
                // サムネ<img>の反映は各番組の自己連鎖サイクルに任せる（全件同時更新はしない＝
                // リストがいっぺんに切り替わる“一斉感”を無くす）。新規カードは _syncThumbTimers が拾う。
            } catch (error) {
                console.error('[updateSidebarInterval] エラー:', error);
            }
            scheduleNext();
        };

        scheduleNext();
    }

    /**
     * サイドバー更新を停止する（閉／クリーンアップ）。
     * clearTimeout だけでは await 中のチェーンを止められないため、世代を進めて張り直しを無効化する。
     * サムネ側 stopThumbnailUpdate と対称に、閉パス・離脱パスの両方から呼ぶこと。
     */
    stopSidebarUpdate() {
        this._sidebarGen = (this._sidebarGen || 0) + 1; // in-flight チェーンの張り直しを無効化
        const existingTimer = this.appState.getTimer('sidebar');
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        this.appState.clearTimer('sidebar');
    }

    /**
     * サイドバー更新タイマーを再開
     */
    restartSidebarUpdate() {
        // startSidebarUpdate が世代を進めるので、await 中の旧チェーンも張り直せなくなる
        // ＝ここで手前に clearTimeout を重ねる必要はない（旧実装は世代が無く、それだけが頼りだった）。
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
            if (!container) return;

            // 現在DOMのカードを id で引けるように
            const existingMap = new Map();
            for (const el of container.children) {
                if (el && el.id) existingMap.set(el.id, el);
            }

            // Phase1: 既存カードは「その場で属性だけ更新」（DOMは動かさない）。新規カードは作成して保持。
            //         リスト構造（追加/削除/並び替え）が要るかを判定する（差分更新）。
            let structuralChange = false;
            const orderedIds = [];         // livePrograms の並び順（API順）で有効な id
            const newElements = new Map(); // id -> 新規作成した要素
            livePrograms.forEach((program, apiIndex) => {
                if (!program || !program.id) return;

                // 1番組のカード生成で失敗しても、その番組だけスキップしてリスト全体は描画する。
                // （詳細がスクレイプに無い番組＝ページング超過やスクレイプ失敗時に不正データを踏んでも
                //   サイドバー全体が空にならないようにする防御）
                try {
                    const id = String(program.id);
                    const data = programInfos.find((info) => info.id === `lv${program.id}`);
                    const existing = existingMap.get(id);

                    if (existing) {
                        // その場更新（属性・タイトル・リンク先）。カードのDOMは移動しない。
                        existing.setAttribute('active-point', String(calculateActivePoint(data || program)));
                        // 新着順は API順（notifybox は放送開始が新しい順で返す）を保つためのインデックス
                        existing.setAttribute('data-api-index', String(apiIndex));
                        const titleEl = existing.querySelector('.program_title');
                        if (titleEl) titleEl.textContent = (data && data.title) || (program && program.title) || 'タイトル不明';
                        const linkEl = existing.querySelector('.program_thumbnail a');
                        if (linkEl) linkEl.href = data && data.id ? `${watchPageBaseUrl}${data.id}` : `${watchPageBaseUrl}lv${program.id}`;
                        orderedIds.push(id);
                    } else {
                        // DOM要素を直接作成（構造変更）
                        const element = data
                            ? makeProgramElement(data, this.loadingImageURL)
                            : makeProgramElement(program, this.loadingImageURL);
                        if (element) {
                            element.setAttribute('data-api-index', String(apiIndex));
                            newElements.set(id, element);
                            orderedIds.push(id);
                            structuralChange = true;
                        }
                    }
                } catch (e) {
                    console.warn('[updateSidebar] カード生成に失敗（この番組をスキップ）:', program && program.id, e);
                }
            });

            // 削除: 現在DOMにあって新リストに無い番組があれば構造変更
            if (!structuralChange) {
                const wanted = new Set(orderedIds);
                for (const el of container.children) {
                    if (el && el.id && !wanted.has(el.id)) { structuralChange = true; break; }
                }
            }

            // 追加/削除が無くても、その場更新で順位（active-point / API順）が入れ替わっていれば並べ替えが必要
            if (!structuralChange && this._sortOrderChanged(container)) {
                structuralChange = true;
            }

            if (structuralChange) {
                // 構造が変わった時だけ組み替える：既存を再利用＋新規を API順に並べて置換し、ソート。
                this.appState.update.isInserting = true;
                const frag = document.createDocumentFragment();
                for (const id of orderedIds) {
                    const el = existingMap.get(id) || newElements.get(id);
                    if (el) frag.appendChild(el);
                }
                container.replaceChildren(frag);
                // ソート（詳細が揃っているので programsSort で確定できる）
                this.sortProgramsInContainer(container);
                // 列数は「意図した幅」(appState.sidebar.width)で決める。開閉アニメ中の途中幅(offsetWidth)を
                // 使うと、開いた直後のリスト再描画がアニメ中に走った時に1列⇔多列がパタついてサムネが一瞬巨大化するため。
                setProgramContainerWidth(this.elems, this.appState.sidebar.width);
                this.appState.update.isInserting = false;
            }
            // else: その場更新のみ（DOMの組み替え・並べ替えはしない＝差分だけ触る）

            // 番組数更新
            this.updateProgramCount(livePrograms.length);

            // 新規/削除カードに合わせて番組ごとの自己連鎖サムネタイマーを同期する。
            this._syncThumbTimers();
        } catch (error) {
            console.error('[updateSidebar] エラーが発生しました:', error);
            this.appState.update.isInserting = false;
        }
    }

    /**
     * その場更新の後、現在のDOM順が programsSort で並べ替えた順序と食い違う（＝並べ替えが必要）かを、
     * DOMを触らずに判定する。食い違っていなければ組み替え自体を省ける（差分更新の肝）。
     * 比較器は sortPrograms（utils/sorting.js）と同一にする。
     */
    _sortOrderChanged(container) {
        const els = Array.from(container.children);
        if (els.length < 2) return false;
        const sorted = els.slice();
        if (this.options.programsSort === 'active') {
            sorted.sort((a, b) => parseFloat(b.getAttribute('active-point')) - parseFloat(a.getAttribute('active-point')));
        } else {
            sorted.sort((a, b) => {
                const ia = a.dataset.apiIndex !== undefined ? (parseInt(a.dataset.apiIndex, 10) || 0) : Infinity;
                const ib = b.dataset.apiIndex !== undefined ? (parseInt(b.dataset.apiIndex, 10) || 0) : Infinity;
                if (ia !== ib) return ia - ib;
                return (parseInt(b.id, 10) || 0) - (parseInt(a.id, 10) || 0);
            });
        }
        for (let i = 0; i < els.length; i++) {
            if (els[i] !== sorted[i]) return true;
        }
        return false;
    }

    /**
     * サムネイルを更新
     */
    updateThumbnail(force, onComplete, onlyIds, onSettled) {
        // DOM操作中は実行しない
        if (this.appState.update.isInserting) {
            if (onComplete) onComplete();
            if (onSettled) onSettled();
            return;
        }

        const programInfos = getProgramInfosFromStorage();
        if (!programInfos || programInfos.length === 0) {
            if (onComplete) onComplete();
            if (onSettled) onSettled();
            return;
        }

        // onlyIds 指定時はその番組だけ更新（番組ごと自己連鎖サイクル）。未指定なら全件（読み込み時の一斉更新）。
        // onSettled は画像の読み込み完了(settle)で発火＝各番組サイクルが「作業完了後に次の20秒を張る」ために使う。
        updateThumbnailsFromStorage(programInfos, { force: !!force, onComplete, onlyIds, onSettled });
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
