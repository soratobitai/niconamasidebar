import { fetchLivePrograms, fetchProgramInfo } from '../services/api.js';
import { fetchFollowedProgramsViaPage, isLiveScreenshotUrl } from '../services/followPageSource.js';
import { getProgramInfos as getProgramInfosFromStorage, upsertProgramInfos, patchProgramThumbnail } from '../services/storage.js';
import { makeProgramElement, calculateActivePoint, updateThumbnailsFromStorage } from '../render/sidebar.js';
import { setProgramContainerWidth } from '../ui/layout.js';
import { sortPrograms } from '../utils/sorting.js';
import { updateThumbnailInterval, watchPageBaseUrl, newProgramFastPollMs, manualThumbWaitMaxMs } from '../config/constants.js';

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
        // 手動更新がサムネ反映の完了通知を待つ上限（doc/09 項目AC-1）。
        // フィールドに持たせてあるのは検証用に短縮できるようにするため（scripts/verify-sidebar-loop.mjs）。
        this._manualThumbWaitMs = manualThumbWaitMaxMs;
        // 番組ごとの自己連鎖サムネタイマー（id -> timeoutId）と稼働フラグ。
        this._thumbTimers = new Map();
        this._thumbRunning = false;
        // 実行世代。start/stop のたび ++ し、停止/再開を跨いだ古いサイクルの張り直しを無効化する。
        this._thumbGen = 0;
        // _updateOneThumbnailAndWait の安全ガードタイマー（stop時に一括clearするため追跡）。
        this._pendingGuards = new Set();

        // === サイドバー更新の常設ループ ===
        // 「次に取得してよい時刻」が唯一の正で、タイマーは単なる目覚まし。
        // 誰が再スケジュールしても同じ _sidebarNextDueAt から遅延を計算するので、
        // 複数の呼び出し元が食い違って二重に走ることが構造上ありえない。
        this._sidebarLoopTimer = null;   // 常に高々1本。clear してから set する
        this._sidebarLoopRunning = false; // 二重開始ガード（_sidebarLoopTimer は tick 実行中 null になるため当てにしない）
        this._sidebarLoopStopped = false; // destroySidebarLoop で true。resetSidebarSchedule で復帰しうる
        this._sidebarNextDueAt = 0;      // 次に updateSidebar してよい時刻（epoch ms）
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
     * サイドバー更新の常設ループを開始する。init から1回だけ呼ぶ（冪等）。
     *
     * 旧実装は start/stop/restart でチェーンを作っては壊す方式だったが、
     * 「取得中(await中)は保留タイマーが存在しない」ため clearTimeout が空振りし、
     * 戻ってきたチェーンが自力で張り直して (A)閉じても止まらない (B)チェーンが二重化する、
     * という欠陥があった（doc/09 項目AB）。世代トークンで押さえていたが、
     * ここでは「作り直さない」ことで欠陥そのものを構造から消している。
     *
     * ページのライフサイクルは DOMContentLoaded で1回 setup → beforeunload/pagehide で1回 cleanup
     * のみ（SPA的な再初期化経路は存在しない。自動移動も location.assign による完全遷移）。
     * よってループは「ページ滞在中ずっと1本」で足り、停止は片道でよい。
     */
    startSidebarLoop() {
        // 二重開始は _sidebarLoopTimer では判定できない。_sidebarTick は入口で自分を null にするため、
        // 取得中(await中)に呼ばれるとガードをすり抜けてもう1本張ってしまう。専用フラグで判定する。
        if (this._sidebarLoopRunning) return;
        this._sidebarLoopRunning = true;
        this._sidebarLoopStopped = false;
        const interval = this._currentUpdateIntervalMs();
        this._sidebarNextDueAt = Date.now() + interval;
        this._scheduleSidebarTick(interval);
    }

    /**
     * 常設ループを止める（ページ離脱時のみ）。
     * 「閉じたら止める」には使わないこと（閉じている間は _sidebarTick 側が isOpen で弾く）。
     *
     * 完全な片道にはしない。cleanup は beforeunload / pagehide で呼ばれるが、どちらも
     * 「ページが破棄されずに生き残る」場合がある（bfcache 復帰、遷移のキャンセル）。
     * 旧実装は停止が可逆で、その状況でもサイドバーを開き直せば定期更新が復活した
     * （main.js の `!getTimer('sidebar')` ガード経由）。その復旧性を落とさないため、
     * resetSidebarSchedule（＝開いた時・間隔変更時）から再武装できるようにしてある。
     */
    destroySidebarLoop() {
        this._sidebarLoopStopped = true;
        this._sidebarLoopRunning = false;
        if (this._sidebarLoopTimer !== null) {
            clearTimeout(this._sidebarLoopTimer);
            this._sidebarLoopTimer = null;
        }
    }

    /**
     * 次回取得の期限を「今から1周期後」に置き直す（旧 restartSidebarUpdate 相当）。
     * 位相のリセットだけを行い、ループを二重には増やさない。
     *
     * 呼ぶのは3箇所: サイドバーを開いた時、手動更新の完了後、更新間隔の変更時。
     * いずれも「開いている時だけ」というガードは呼び出し側にある。
     */
    resetSidebarSchedule() {
        // cleanup 後にページが生き残っていた場合はここで再武装する（destroySidebarLoop 参照）
        if (this._sidebarLoopStopped) {
            this.startSidebarLoop();
            return;
        }
        const interval = this._currentUpdateIntervalMs();
        this._sidebarNextDueAt = Date.now() + interval;
        this._scheduleSidebarTick(interval);
    }

    /** 目覚ましを張り直す。常に「clear してから set」なので同時に2本存在しない。 */
    _scheduleSidebarTick(delayMs) {
        if (this._sidebarLoopStopped) return;
        if (this._sidebarLoopTimer !== null) {
            clearTimeout(this._sidebarLoopTimer);
        }
        this._sidebarLoopTimer = setTimeout(() => { this._sidebarTick(); }, Math.max(0, delayMs));
    }

    /**
     * 次の起床までの遅延。_sidebarNextDueAt から毎回計算し直すので、
     * resetSidebarSchedule が割り込んでも結果が食い違わない。
     * 期限が過ぎている（閉じている間に空振りしていた等）場合は1周期後にする＝暴走しない。
     */
    _sidebarDelayToNextMs() {
        const interval = this._currentUpdateIntervalMs();
        const remain = this._sidebarNextDueAt - Date.now();
        return (remain > 0 && remain <= interval) ? remain : interval;
    }

    /**
     * ループの1回ぶん。「今やるべきか」を毎回ここで判定する。
     * 判定に外れても必ず finally で次の目覚ましを張るので、ループが死ぬ経路は destroy だけ。
     */
    async _sidebarTick() {
        this._sidebarLoopTimer = null; // 自分は発火済み
        if (this._sidebarLoopStopped) return;
        try {
            // 閉じている間は取得しない（旧実装の stopAllTimers 相当。ループは生かしたまま素通り）
            if (!this.appState.sidebar.isOpen) return;
            // まだ期限前（早すぎる起床への保険）
            if (Date.now() < this._sidebarNextDueAt) return;
            // 別の更新（手動更新）が進行中なら今回は見送り、次周期に回す
            if (this.appState.isLoading()) return;

            const sessionId = await this.updateSidebar();
            if (this._sidebarLoopStopped) return;
            // 自分が始めたセッションだけを閉じる。await 中に手動更新が別セッションを
            // 立てている可能性があるため、無条件 finish は他人のセッションを閉じてしまう。
            if (sessionId) {
                await this.loadingManager.finishSessionWithMinDuration(1000, sessionId);
            }
            // サムネ<img>の反映は各番組の自己連鎖サイクルに任せる（全件同時更新はしない＝
            // リストがいっぺんに切り替わる“一斉感”を無くす）。新規カードは _syncThumbTimers が拾う。
        } catch (error) {
            console.error('[sidebarTick] エラー:', error);
        } finally {
            // 期限は「この回が終わった時点」から数え直す。旧実装は取得完了後に初めて
            // setTimeout(interval) を張る自己連鎖だったため、実周期は interval＋その回の作業時間
            // （＝取得時間と最低表示1秒の合成）だった。取得の前に期限を進めると周期が
            // interval ちょうどに詰まり、ニコ生への取得頻度が上がってしまう＝挙動が変わる。
            // ただし await 中に resetSidebarSchedule（手動更新の完了・間隔変更）が
            // 期限を先へ置き直していた場合は、そちらを尊重して上書きしない。
            const now = Date.now();
            if (this._sidebarNextDueAt <= now) {
                this._sidebarNextDueAt = now + this._currentUpdateIntervalMs();
            }
            this._scheduleSidebarTick(this._sidebarDelayToNextMs());
        }
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

            // サムネイル更新。
            // 完了通知は待つが、上限を切って必ず前へ進める（doc/09 項目AC-1）。
            // updateThumbnail の入口で背景タブは弾いているが、それだけでは
            // 「待っている最中にタブが背景へ回る」経路を塞げない（rAF が途中で止まり
            // onComplete が来なくなる）。ここで固まると isPerformingManualUpdate が
            // 立ちっぱなしになり、そのタブでは手動更新が二度と通らなくなる。
            await new Promise(resolve => {
                let settled = false;
                const finish = () => { if (!settled) { settled = true; resolve(); } };
                const guard = setTimeout(() => {
                    console.warn('[手動更新] サムネ反映の完了通知が来ないため打ち切りました（背景タブへの切替など）');
                    finish();
                }, this._manualThumbWaitMs);
                this.updateThumbnail(true, () => { clearTimeout(guard); finish(); });
            });

            // 最低1秒のローディング時間を確保して終了
            await this.loadingManager.finishSessionWithMinDuration(1000);

            // 定期取得の位相をリセット（＝今から1周期後にする）。ループ自体は作り直さない。
            if (this.appState.sidebar.isOpen) {
                this.resetSidebarSchedule();
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
        // ローディングセッションの扱い。
        //
        // 開始したIDを返すのは、await を跨いで戻ってきた呼び出し元が「自分が始めたセッションだけ」を
        // 閉じられるようにするため（他人のセッションを閉じると、手動更新がまだ走っているのに
        // 更新ボタンが有効化され「押せるのに無反応」になる）。
        //
        // 既に別の更新のセッションが動いている場合は、新しく立てずに相乗りする（null を返す）。
        // startSession は前のセッションを finish せずに上書きするため、ここで素直に立てると
        // 動いている持ち主からロックを奪ってしまう。奪ったIDを自分で閉じると、
        // 元の持ち主（例: 手動更新の force 一斉更新＝実測15秒級）がまだ走っているのに
        // isLoading() が false へ落ち、上と同じ「押せるのに無反応」＋定期取得の二重走行になる。
        // 相乗りなら持ち主が最後まで施錠を保てる。呼び出し元は null の時に finish しなければよい。
        const sessionId = this.loadingManager.getCurrentSessionId()
            ? null
            : this.loadingManager.startSession();

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
                return sessionId;
            }

            // 空配列のときは既存DOMを維持
            if (Array.isArray(livePrograms) && livePrograms.length === 0) {
                this.updateProgramCount(0);
                return sessionId;
            }

            // スクレイプ upsert 後の storage を読む（詳細が反映済み）
            const programInfos = getProgramInfosFromStorage();

            const container = document.getElementById('liveProgramContainer');
            if (!container) return sessionId;

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
        return sessionId;
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

        // 背景タブでは何もせず「完了」として返す（doc/09 項目AC-1）。
        // updateThumbnailsFromStorage は requestAnimationFrame で始まるため、背景タブでは
        // tick が一度も走らず onComplete/onSettled が永久に発火しない。待っている
        // performManualUpdate がそこで固まり、isPerformingManualUpdate が立ちっぱなしになって
        // 以後そのタブでは手動更新が二度と通らなくなる（ローディングは60秒で解除されるので
        // 更新ボタンは有効に見えるのに押しても無反応）。
        // そもそも背景では rAF が来ない＝実行しても1枚も更新できないので、待たせる意味がない。
        // 前景に戻れば番組ごとの20秒サイクルが通常どおり反映する（_runThumbCycle も同じ判定で見送る）。
        if (typeof document !== 'undefined' && document.hidden) {
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
