import { fetchLivePrograms, fetchProgramInfo, mapNotifyboxRowToInfo } from '../services/api.js';
import { fetchFollowedProgramsViaPage, isLiveScreenshotUrl } from '../services/followPageSource.js';
import { getProgramInfos as getProgramInfosFromStorage, upsertProgramInfos, patchProgramThumbnail } from '../services/storage.js';
import { fetchKickPrograms, isKickSessionLost } from '../services/kickSource.js';
import { makeProgramElement, applyRankAttributes, updateThumbnailsFromStorage, flipReorder, applyProgramInfoToCard, releaseThumbnailBlobs, syncServiceTabs, setKickNotice, setNicoNotice, NICO_NOTICE_NONE, NICO_NOTICE_AUTH, NICO_NOTICE_UNREACHABLE, cardIdOf, autoUpdateIntervalMs } from '../render/sidebar.js';
import { setProgramContainerWidth } from '../ui/layout.js';
import { sortPrograms } from '../utils/sorting.js';
import { orderComparator } from '../utils/programOrder.js';
import { updateThumbnailInterval, kickThumbnailInterval, newProgramFastPollMs, manualThumbWaitMaxMs, reorderFlipDurationMs, endCheckMaxPerCycle, minLoadingDurationMs, fallbackUpdateIntervalSec, endedByAutoNextValidMs } from '../config/constants.js';
import { checkExtensionAlive } from '../utils/extensionAlive.js';
import { takeEndedByAutoNext } from '../services/status.js';

/**
 * 終了と**確認して**消した番組が notifybox に戻ってきた時に1回だけ警告する（鳴る罠）。
 *
 * 🔴 **この判断が誤っていた時の症状は「放送中の番組が黙って画面から消える」で、
 * エラーは一切出ない。** 利用者からは「たまに番組が消える拡張」にしか見えず、原因に辿り着けない。
 *
 * 詳細APIが `ended` と答えた番組しか消さないので、ここが鳴るなら
 * **詳細APIと notifybox が食い違っている**＝前提の作り直しが要る（doc/09 項目BF-2）。
 */
let notifyboxResurrectionWarned = false;
function warnNotifyboxResurrection(id) {
    if (notifyboxResurrectionWarned) return;
    notifyboxResurrectionWarned = true;
    console.warn(
        `[リスト] ${id} を詳細APIで「終了した」と確認して外しましたが、`
        + 'notifybox に戻ってきました。詳細API(`liveCycle`)と notifybox が食い違っています。'
        + '番組終了の確認（doc/09 項目BF-2）を見直してください。'
    );
}

/**
 * 更新処理とタイマーの管理
 *
 * データ取得の役割分担:
 *   - リスト: notifybox API（早さ担当）とフォローAPIの**和集合**。notifybox は user番組の
 *     新着検知が 20〜101秒 速く、フォローAPIは詳細と100件超をカバーする（doc/09 項目AD）。
 *   - 詳細＋並び順(beginAt): フォロー中ページの公開フロントJSON API 1リクエスト。
 *     storage へ upsert する。従来の「1番組=1詳細API×N」を1リクエストに置換した効率化。
 *   - サムネ画像の再取得: 別の常設ループ（startThumbnailLoop）が保存済みURL＋キャッシュバスターで更新。
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
        // === サムネ更新の常設ループ ===
        // サイドバー側と同じモデル。「番組ごとの次に更新してよい時刻」が唯一の正で、
        // タイマーは1本の目覚ましだけ。旧実装は番組数ぶんの自己連鎖タイマー＋世代トークンで、
        // stop→即再開の境界で二重化する「ゴースト連鎖」を世代照合で押さえていた（doc/09 項目Z）。
        // 作り直さない構造にして、その欠陥の発生源ごと消している。
        this._thumbLoopTimer = null;    // 常に高々1本。clear してから set する
        this._thumbLoopRunning = false; // 二重開始ガード（tick 実行中は _thumbLoopTimer が null になる）
        this._thumbLoopStopped = false; // destroyThumbnailLoop で true。開き直しで復帰しうる
        this._thumbDueAt = new Map();
        // 番組詳細API に問い合わせて `liveCycle: 'ended'` と**確認できた**番組id（doc/09 項目BF-2）。
        // 🔴 **推測で入れないこと。** ここに入れてよいのは詳細APIが終了と答えた番組だけ。
        //    ここに入った番組は聞き直さず、フォローAPIが手放すまで消したままにする。
        //    notifybox に戻ってきたら警告を鳴らして印を落とす（＝食い違いに気付ける）。
        this._endedConfirmed = new Set();
        // 🔴 **自動移動で離れた番組は、詳細APIに聞かなくても終了と分かっている**（doc/09 項目CS）。
        //    移動のきっかけがその番組の終了を見たことなので、推測ではない。
        //
        // 🔴 **`_endedConfirmed` に混ぜないこと。** あちらには「notifybox に戻ってきたら印を落として
        //    警告する」鳴る罠があり、**詳細APIの答えと notifybox の食い違いを捕まえる**ためのもの。
        //    ところがこの印が効いてほしいのは、まさに**一覧APIも notifybox もまだ返している窓**
        //    なので、混ぜると置いた瞬間に罠が落として誤警告まで出る（実装して検査で気付いた）。
        //
        // ⚠️ **期限を切ること。** 鳴る罠の外に置く＝取り違えた時に戻る道が無くなるので、
        //    時間で自分から戻れるようにする。kick.com 側と同じ考え方・同じ長さ。
        this._endedByAutoNext = '';
        this._endedByAutoNextUntil = 0;
        // ⚠️ **`_dropEndedPrograms` より先に必ず終わらせること。** 初回の取得は
        //    ページ読み込みの 300ms 後に走るので、素直に await しないと間に合わない。
        //    約束を1つ持ち回り、確認の入口で待つ形にしてある（毎周期 storage を読まない）。
        this._endedSeeded = this._seedEndedFromAutoNext();
        // 取得中の番組（完了を待たずに次へ進むので、同じ番組を二重に走らせないための印）
        this._thumbInFlight = new Set();   // id -> 次に更新してよい時刻(epoch ms)。ドリフトはここで表現する
        // _updateOneThumbnailAndWait の安全ガードタイマー（破棄時に一括clearするため追跡）。
        this._pendingGuards = new Set();

        // === サイドバー更新の常設ループ ===
        // 「次に取得してよい時刻」が唯一の正で、タイマーは単なる目覚まし。
        // 誰が再スケジュールしても同じ _sidebarNextDueAt から遅延を計算するので、
        // 複数の呼び出し元が食い違って二重に走ることが構造上ありえない。
        this._sidebarLoopTimer = null;   // 常に高々1本。clear してから set する
        this._sidebarLoopRunning = false; // 二重開始ガード（_sidebarLoopTimer は tick 実行中 null になるため当てにしない）
        this._sidebarLoopStopped = false; // destroySidebarLoop で true。resetSidebarSchedule で復帰しうる
        this._sidebarNextDueAt = 0;      // 次に updateSidebar してよい時刻（epoch ms）

        // 描画の世代。updateSidebar が入口で採番し、取得の await 明けに自分が最新かを確認する。
        // 遅れて着地した古い取得結果で新しい描画を巻き戻さないため（doc/09 項目AP）。
        this._renderGen = 0;

    }

    /**
     * サムネ更新の常設ループを開始する（setup から1回だけ）。
     *
     * 「全番組を同時に一斉更新」だとリストがいっぺんに切り替わって気持ち悪い、というUX要望が起点。
     * 番組ごとに「次に更新してよい時刻」を持ち、更新が完了してからその時刻を20秒先へ置き直す。
     * 周期＝20秒＋その回の作業時間になり、作業時間が毎回わずかに違うため時間とともに位相がばらける
     * （自然ドリフト）。**タイマーは1本**で、ドリフトは期限の持ち方だけで表現している。
     * ※読み込み時の一斉更新は performManualUpdate が担う。ここは以後の更新を受け持つ。
     */
    startThumbnailLoop() {
        // 二重開始は _thumbLoopTimer では判定できない（tick 実行中は null になるため）。専用フラグで判定する。
        if (this._thumbLoopRunning) return;
        this._thumbLoopRunning = true;
        this._thumbLoopStopped = false;
        this._refreshThumbSchedule(); // 現在のカードに初回の期限を配り、目覚ましを張る
    }

    /**
     * サムネ更新の常設ループを止める（ページ離脱時のみ）。
     * 「閉じたら止める」には使わないこと（閉じている間は _thumbTick が isOpen を見て素通りする）。
     * サイドバー側 destroySidebarLoop と同じく完全な片道にはしない（bfcache 復帰等でページが生き残るため）。
     */
    destroyThumbnailLoop() {
        this._thumbLoopStopped = true;
        this._thumbLoopRunning = false;
        if (this._thumbLoopTimer !== null) {
            clearTimeout(this._thumbLoopTimer);
            this._thumbLoopTimer = null;
        }
        this._thumbDueAt.clear();
        this._thumbInFlight.clear();
        if (this._pendingGuards) {
            // 各待機を finish() で解決（ガードclear＋Promise resolve）＝await で宙吊りのフレーム
            // （detachedカード参照ごと）を解放する。単に clearTimeout だけだと未resolveでリークする。
            for (const e of Array.from(this._pendingGuards)) { try { e.finish(); } catch (_e) { /* noop */ } }
            this._pendingGuards.clear();
        }
    }

    // ===================== 実行可否ポリシー =====================
    //
    // 「今この処理をしてよいか」の判定は、**どこで何を見るかが意図的に違う**。
    // 同じ判定に見えるので取り違えやすい（実際に説明を誤ったことがある）。この表が正。
    //
    // | 判定             | リスト更新 | サムネ更新 | サムネ反映 | 手動更新 |
    // |------------------|-----------|-----------|-----------|---------|
    // | 破棄済み          | ○         | ○         | −         | −       |
    // | サイドバーが閉    | ○ 取得しない | ○ 更新しない | −      | −       |
    // | **背景タブ**      | **見ない** | ○ 更新しない | ○ 即完了 | （反映側で判定）|
    // | 別の更新が実行中  | ○ 見送る   | −         | −         | ○ 多重防止 |
    // | DOM差し替え中     | −         | −         | ○ 即完了   | −       |
    //
    // 🔴 **リスト更新だけが背景タブを見ない**のは 655df9c の意図的決定。
    //    サイドバーが開いている間は裏タブでもリストを取り続ける（doc/09 項目AB-2）。
    //    ここに可視判定を足すと仕様変更になる。
    // 🔴 **サムネ側が背景タブを見る**のは、rAF が止まって完了通知が永久に来ないため
    //    （待ち続けると手動更新が固まる。doc/09 項目AC-1）。
    //
    // 生の `document.hidden` / `appState.sidebar.isOpen` を各所に直書きせず、
    // 必ず下の述語を通すこと（どこが何を見ているか grep で追えるようにするため）。

    /** サイドバーが開いているか。閉じている間は「やらない」だけで、ループは止めない。 */
    _isSidebarOpen() {
        return !!this.appState.sidebar.isOpen;
    }

    /**
     * 背景（非表示）タブか。
     * ⚠️ **リスト更新のループでは使わないこと**（上の表を参照）。
     */
    _isBackgroundTab() {
        return typeof document !== 'undefined' && !!document.hidden;
    }

    /** 別の更新（手動更新など）が実行中か。 */
    _isUpdateInFlight() {
        return this.appState.isLoading();
    }

    /** サムネ1周期の基準間隔(ms)。作業完了後にこの時間だけ待って次サイクルを張る。 */
    /**
     * 直近に取得した Kick の番組。**保存領域には入れていない**ので、
     * 順位を計算し直す時はここから拾う必要がある。
     */
    getKickPrograms() {
        return this._kickPrograms || [];
    }

    _currentThumbCycleMs() {
        return (Number(this.options.updateThumbnailInterval) || updateThumbnailInterval) * 1000;
    }

    /**
     * カード1枚ぶんのサムネ更新周期。**サービスごとに違う。**
     *
     * ニコ生は20秒、Kick は60秒（2026-08-04 実測: 平均約57秒でしか絵が変わらない）。
     * 同じ20秒で叩くと Kick は3回に2回が同じ絵の取り直しになる。
     *
     * ⚠️ スケジューラ本体（`_thumbNextDelayMs` / `_thumbTick`）には手を入れないこと。
     *    「いちばん早い期限まで寝る」という作りなので、**期限を配る側だけ**を変えれば
     *    番組ごとに違う周期が自然に成立する。
     * ⚠️ **要素を持っているなら要素を渡すこと。** id しか無い場所（tick の完了時）のために
     *    引き直しにも対応しているが、`getElementById` の戻り値が要素である前提に寄りかからない。
     *    ここで `getAttribute` を無条件に呼んで verify:loop を落としたことがある（2026-08-04）。
     * @param {string|HTMLElement} idOrEl カードのDOM id、または要素そのもの
     */
    _thumbCycleMsFor(idOrEl) {
        const el = (idOrEl && typeof idOrEl === 'object')
            ? idOrEl
            : (idOrEl ? document.getElementById(idOrEl) : null);
        const isKick = !!(el && typeof el.getAttribute === 'function' && el.getAttribute('data-service') === 'kick');
        return isKick ? kickThumbnailInterval * 1000 : this._currentThumbCycleMs();
    }

    /**
     * 現在のカードと「次に更新してよい時刻」の表を突き合わせる。
     * 新しく現れたカードには初回の期限を配り、消えたカードの期限は捨てる。
     * 初回は基準間隔の内側へ均等配置する（理由は下のコメント）。
     * 読み込み直後の一斉更新は performManualUpdate 側が担うため、ここでは間隔を空けてよい。
     * 開始時と updateSidebar の後（新規/削除カードの後）に呼ぶ。
     */
    _syncThumbDueAt() {
        if (!this._thumbLoopRunning) return;
        const container = document.getElementById('liveProgramContainer');
        if (!container) return;
        const cycleMs = this._currentThumbCycleMs();
        const cards = Array.from(container.children);
        const present = new Set();
        const now = Date.now();
        // 表が空＝これは「読み込み直後の初回一斉配布」。途中で増えた新着カードとは扱いを分ける。
        // （forEach の中で size を見ると、1件配った時点で判定が裏返ってしまう）
        const initialAssignment = this._thumbDueAt.size === 0;
        cards.forEach((el, i) => {
            const id = el && el.id;
            if (!id) return;
            present.add(id);
            if (!this._thumbDueAt.has(id)) {
                // 期限の配り方は2通りだけ。**機械的な位相分散はしない**（利用者判断・2026-08-01）。
                //
                //   ・読み込み直後の一斉配布 / 手動更新中 → `今 + 20秒`
                //     この2つの場面では performManualUpdate が全カードをまとめて取得済み。
                //     ここで「今すぐ」を配ると、同じ <img> に2本目の取得が重なる（新規カードは
                //     dataset.lastSuccessAt/key が未設定なので TTL ガードが素通りする）。
                //   ・途中で増えた新着カード → `今すぐ`
                //     一斉取得は走っていないので待つ理由が無い。他の番組の期限は未来なので、
                //     新着が「いちばん古い期限」になり次の起床で真っ先に処理される。
                //
                // 以前は周期内へ均等配置していたが、それは「同時に取ると帯域を分け合って遅くなる」
                // という前提の細工だった。実際の重さは回線ではなく相手の応答待ちで、重ねても問題ない
                // （doc/09 項目BD）。ズレは「各番組の取得が終わってから20秒」で自然に生まれる。
                const deferred = initialAssignment || this.isPerformingManualUpdate;
                // 要素をそのまま渡す（引き直さない）。
                this._thumbDueAt.set(id, deferred ? now + this._thumbCycleMsFor(el) : now);
            }
        });
        // 消えた番組の期限を解放
        for (const id of Array.from(this._thumbDueAt.keys())) {
            if (!present.has(id)) this._thumbDueAt.delete(id);
        }
    }

    /**
     * 期限表を更新し、目覚ましを張り直す（ループの外から呼ぶ用）。
     *
     * ⚠️ **`_syncThumbDueAt` 自体はタイマーを張らないこと。** tick の中から呼ばれるため、
     * そこで張ると tick が await している間に発火して**二重実行**になる（実装中に実際に踏んだ）。
     * 張り直しは tick の finally か、この関数のようにループ外の呼び出し元だけが行う。
     */
    _refreshThumbSchedule() {
        // 破棄済みでもページが生き残っていればここで再武装する。
        // cleanup は beforeunload / pagehide で走るが、どちらも**ページが破棄されずに生き残る**
        // 場合がある（bfcache 復帰・遷移のキャンセル）。サイドバー側 resetSidebarSchedule と
        // 同じく、再武装の入口を必ず1つ用意しておく（doc/09 項目AB-2 の復旧経路と同じ理由）。
        if (this._thumbLoopStopped) {
            this._thumbLoopStopped = false;
            this._thumbLoopRunning = true;
        }
        this._syncThumbDueAt();
        this._scheduleThumbTick(this._thumbNextDelayMs());
    }

    /** 目覚ましを張り直す。常に「clear してから set」なので同時に2本存在しない。 */
    _scheduleThumbTick(delayMs) {
        if (this._thumbLoopStopped || !this._thumbLoopRunning) return;
        if (this._thumbLoopTimer !== null) clearTimeout(this._thumbLoopTimer);
        this._thumbLoopTimer = setTimeout(() => { this._thumbTick(); }, Math.max(0, delayMs));
    }

    /**
     * 次の起床までの遅延＝「いちばん早い期限」まで。期限を毎回見直すので、
     * カードが増減しても resetSidebarSchedule 相当の割り込みがあっても結果が食い違わない。
     * 対象が無ければ1周期後に様子を見に来る（暴走しない）。
     */
    _thumbNextDelayMs() {
        const cycleMs = this._currentThumbCycleMs();
        const now = Date.now();
        let min = Infinity;
        // 🔴 **取得中の番組を数に入れないこと。** 期限切れなのに選べない番組が残っていると
        // 「0ms で起きる → 選べない → また 0ms」の無限ループになる（doc/09 R-1 で踏んだ形）。
        for (const [id, t] of this._thumbDueAt) { if (this._thumbInFlight.has(id)) continue; if (t < min) min = t; }
        if (!Number.isFinite(min)) return cycleMs;
        const remain = min - now;
        if (!(remain > 0)) return 0;          // 既に期限切れ＝すぐ処理する
        return Math.min(remain, cycleMs);     // 異常に先の期限でも1周期以内には見に来る
    }

    /**
     * ループの1回ぶん。**期限が来ている番組を1件だけ**処理する。
     *
     * 1件ずつにしているのは、1番組の画像がハング（最大2×間隔のガード）しても
     * 他の番組を巻き添えにしないため。まとめて処理すると1件の遅延が全体を止める。
     * 期限切れが複数あれば次の tick が遅延0で連続して回るので、総処理量は変わらない。
     *
     * ドリフト（番組ごとに更新タイミングがばらける）は「**完了した時点＋20秒**」を
     * 次の期限にすることで表現される。タイマーの本数とは無関係なので、1本のループでも保たれる。
     */
    async _thumbTick() {
        this._thumbLoopTimer = null; // 自分は発火済み
        if (this._thumbLoopStopped) return;
        // 拡張が再読み込み/更新/無効化されていたら、ここで打ち切る（**張り直さない**）。
        // 放っておくと取り残された content script が取得を続ける（実測: 無効化後60秒でサムネ+9回）。
        if (!checkExtensionAlive()) return;
        // 先行の tick が await 中なら重ねない。重なると同じ番組を連続更新して暴走する。
        // （先行側が finally で必ず張り直すので、ここは何もせず戻ってよい）
        if (this._thumbTickBusy) return;
        this._thumbTickBusy = true;

        // 何もできずに素通りした回か。素通り時は「いちばん早い期限まで」で再スケジュールしてはいけない。
        // 閉じている間・背景タブの間も _thumbDueAt の期限は過去のまま残るので、
        // _thumbNextDelayMs() が 0 を返し **0ms 再スケジュールの無限ループ**になる（実測: 2秒で180回）。
        // 更新回数だけを数えるテストでは検出できない（更新は0回のまま暴走する）。
        let idled = false;
        try {
            // 閉じている間は更新しない（旧実装の stopThumbnailUpdate 相当。ループは生かしたまま素通り）
            if (!this._isSidebarOpen()) { idled = true; return; }
            // 背景タブは rAF が止まり onSettled が来ない＝更新しても1枚も反映できない。
            // ガード40秒の空回しを避けるため素通りする。前景復帰後の一斉更新は performManualUpdate が担う。
            if (this._isBackgroundTab()) { idled = true; return; }

            this._syncThumbDueAt(); // カードの増減を期限表へ反映

            // 期限が来ているもののうち、いちばん古いものを1件選ぶ
            const now = Date.now();
            let target = null, oldest = Infinity;
            for (const [id, due] of this._thumbDueAt) {
                if (this._thumbInFlight.has(id)) continue; // 取得中の番組は選ばない
                if (due <= now && due < oldest) { oldest = due; target = id; }
            }
            if (target === null) return;

            const container = document.getElementById('liveProgramContainer');
            const card = container ? document.getElementById(target) : null;
            if (!container) { idled = true; return; } // コンテナごと消えている＝様子見
            if (!card || !container.contains(card)) { this._thumbDueAt.delete(target); return; }

            // 🔴 **ここで完了を待たないこと。**
            //
            // 以前は `await` で1件の画像が届くまでループを止めていた。ドリフト（番組ごとに
            // タイミングがばらける）を「完了してから20秒」で作るための待ちだったが、
            // **ズレを作ることと、1件ずつ順番にやることは別**である。待った結果、
            //   一周の時間 ＝ 番組数 × 1件あたりの所要時間
            // となり、番組が増えるほど各番組の更新間隔が20秒から伸びていた
            // （実測: 18番組で一周60秒以上。新着カードは行列の最後尾で62秒待たされた）。
            // 取得の大半は「相手の返事待ち」なので、重ねれば隠せる（doc/09 項目BD）。
            //
            // 各番組の期限は**その番組の取得が終わった時点＋20秒**で置き直す。これはこの下の
            // 完了ハンドラの仕事であり、ループ全体が止まる必要はない。
            this._thumbInFlight.add(target);
            (async () => {
                try {
                    await this._fetchLiveThumbIfPendingYoung(target); // A1統合（空＆若い番組だけ詳細API追撃）
                    await this._updateOneThumbnailAndWait(target);    // <img>更新（この番組の読み込み完了まで）
                } catch (_e) { /* 個別失敗は無視して次へ */ }
                this._thumbInFlight.delete(target);
                // 「完了した時点」から次の期限を数え直す＝作業時間ぶん自然にドリフトする。
                // カードが消えていたら期限も消す（復活時は _syncThumbDueAt が配り直す）。
                if (this._thumbDueAt.has(target)) {
                    this._thumbDueAt.set(target, Date.now() + this._thumbCycleMsFor(target));
                }
                // 飛行中は選ばれないので、終わった時点で起床予定を取り直す
                // （寝すぎ・起きすぎのどちらも防ぐ）。
                this._scheduleThumbTick(this._thumbNextDelayMs());
            })();
        } catch (error) {
            console.error('[thumbTick] エラー:', error);
        } finally {
            this._thumbTickBusy = false;
            // 素通りした回は必ず1周期空ける（上の idled のコメント参照）。
            // 処理できた回だけ「いちばん早い期限まで」で詰める＝期限切れが複数あれば連続で捌ける。
            this._scheduleThumbTick(idled ? this._currentThumbCycleMs() : this._thumbNextDelayMs());
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

    /**
     * 目覚ましを張り直す。常に「clear してから set」なので同時に2本存在しない。
     *
     * 🔴 **自動更新 OFF を弾くのはここ1箇所。** 開始・位相リセット・tick の張り直しの
     *    3経路がすべてここを通る。上流それぞれで弾く形にすると、経路が増えた時に漏れる。
     */
    _scheduleSidebarTick(delayMs) {
        if (this._sidebarLoopStopped) return;
        if (this._sidebarLoopTimer !== null) {
            clearTimeout(this._sidebarLoopTimer);
            this._sidebarLoopTimer = null;
        }
        // OFF。**張らずに戻る**（上で clear 済みなので、動作中に OFF へ変えても次で止まる）。
        // ⚠️ サムネのループ（_thumbLoopTimer）はここを通らない。OFF でも回り続ける＝仕様。
        if (autoUpdateIntervalMs(this.options) === null) return;
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
        // 拡張が無効化されていたら打ち切る（**finally の張り直しへ入る前に return する**）。
        // try の中で返すと finally が次を張ってしまい、止めたつもりでループが生き残る。
        if (!checkExtensionAlive()) return;
        try {
            // 閉じている間は取得しない（旧実装の stopAllTimers 相当。ループは生かしたまま素通り）
            if (!this._isSidebarOpen()) return;
            // まだ期限前（早すぎる起床への保険）
            if (Date.now() < this._sidebarNextDueAt) return;
            // 別の更新（手動更新）が進行中なら今回は見送り、次周期に回す
            if (this._isUpdateInFlight()) return;

            const sessionId = await this.updateSidebar();
            if (this._sidebarLoopStopped) return;
            // 自分が始めたセッションだけを閉じる。await 中に手動更新が別セッションを
            // 立てている可能性があるため、無条件 finish は他人のセッションを閉じてしまう。
            if (sessionId) {
                await this.loadingManager.finishSessionWithMinDuration(minLoadingDurationMs, sessionId);
            }
            // サムネ<img>の反映は各番組の自己連鎖サイクルに任せる（全件同時更新はしない＝
            // リストがいっぺんに切り替わる“一斉感”を無くす）。新規カードは _syncThumbDueAt が拾う。
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
        if (this.isPerformingManualUpdate) {
            return;
        }
        this.isPerformingManualUpdate = true;
        // 自分が始めたセッションのIDを覚えておく。相乗り（＝別の更新が先に動いていた）なら null で、
        // その場合は finish しない。持ち主が最後まで施錠を保つ（doc/09 項目AG）。
        let sessionId = null;
        try {
            sessionId = await this.updateSidebar();

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

            // 最低1秒のローディング時間を確保して終了（自分が持ち主の時だけ）
            if (sessionId) await this.loadingManager.finishSessionWithMinDuration(minLoadingDurationMs, sessionId);

            // 定期取得の位相をリセット（＝今から1周期後にする）。ループ自体は作り直さない。
            if (this._isSidebarOpen()) {
                this.resetSidebarSchedule();
            }
        } catch (error) {
            console.error('[手動更新] エラーが発生しました:', error);
            if (sessionId) await this.loadingManager.finishSessionWithMinDuration(minLoadingDurationMs, sessionId);
        } finally {
            this.isPerformingManualUpdate = false;
        }
    }

    /**
     * 現在の更新間隔(ms)。リスト＋詳細サイクルの周期。
     *
     * ⚠️ **OFF の時もここは数値を返す。** 期限の計算（`_sidebarNextDueAt`）に NaN を
     *    混ぜないため。実際に止めるのは `_scheduleSidebarTick` 側の1箇所。
     */
    _currentUpdateIntervalMs() {
        return autoUpdateIntervalMs(this.options) ?? fallbackUpdateIntervalSec * 1000;
    }

    /**
     * フォロー中ページを1回スクレイプして、放送中フォロー番組の詳細を storage へ一括 upsert する。
     * 失敗（未ログイン/構造変化/通信エラー）時は何もしない＝その周は詳細が古いまま（フォールバックしない）。
     */
    async _refreshDetailsViaScrape() {
        // 🔴 **失敗の理由ごと返す**（doc/09 項目CH）。呼び出し側が「未ログイン」と
        //    「メンテナンス・通信断」を出し分けるのに要る。
        const res = await fetchFollowedProgramsViaPage();
        if (res.ok) upsertProgramInfos(res.programs); // 全件フルレコードで書き戻し（_fetchedAt付与）
        return res; // {ok:true, programs}（[] = 放送中0件）/ {ok:false, reason}
    }

    /**
     * 新着順の基準となる並び（放送開始が新しい順）を作る。
     *
     * 旧実装は notifybox API の返却順をそのまま使っていた。lv番号は予約/作成順で採番され
     * 放送開始順とズレる（予約枠など）ため、番号で並べると新着順が崩れるからである。
     * フォローAPIは全番組の beginAt（放送開始時刻）を返すので、**番号ではなく時刻**で
     * 直接並べれば同じ順序が得られる（2026-07-29 実測: notifybox の並びと完全一致）。
     *
     * 同時刻は lv番号の降順で決定的にする（安定ソート＝毎周期で順序が揺れない）。
     */
    /**
     * 2つの取得元を和集合にする。
     *
     * @param {false|Array<any>} notifyList notifybox の notifybox_content（失敗時 false）
     * @param {null|Array<object>} fetched  フォローAPI の programInfo 配列（失敗時 null）
     * @returns {Array<object>} 表示対象の programInfo 配列
     *
     * 優先順位は「フォローAPI の実データ ＞ storage の前回値 ＞ notifybox の最小情報」。
     * notifybox にしか無い番組＝フォローAPIがまだ拾えていない**新着**なので、
     * 詳細が来るまでの1周期だけタイトルだけのカードを出す（次の周期で本来の姿になる）。
     */
    _mergeSources(notifyList, fetched) {
        const byId = new Map();
        if (Array.isArray(fetched)) {
            for (const p of fetched) if (p && p.id) byId.set(String(p.id), p);
        }
        if (!Array.isArray(notifyList)) return Array.from(byId.values());

        // フォローAPIが失敗した周期でも、storage の前回値で詳細を補って描画を保つ
        const stored = getProgramInfosFromStorage();
        const storedById = new Map(Array.isArray(stored) ? stored.map((x) => [x.id, x]) : []);
        const now = Date.now();

        notifyList.forEach((row, i) => {
            if (!row || row.id == null) return;
            const id = 'lv' + String(row.id).replace(/^lv/, '');
            if (byId.has(id)) return;                     // フォローAPI側にあるならそちらが正
            const cached = storedById.get(id);
            if (cached) { byId.set(id, cached); return; } // 前回値があれば使う（古くても出す）

            // どこにも詳細が無い＝たった今始まった番組。
            // notifybox は放送開始が新しい順に返すので、その並びを保ったまま
            // 「今この瞬間に始まった」扱いにして新着順の先頭へ置く。
            //
            // ⚠️ **notifybox の行を id と title だけに削らないこと。** 配信者名(community_name)と
            // アイコン(thumbnail_url)と種別(provider_type)も入っている。ここで捨てると、
            // フォローAPIが同じ番組を拾うまでの 20〜101秒＋1周期のあいだ、新着カードが
            // 「配信者名不明・アイコンなし・ローディング画像」で立つ（doc/09 項目AT）。
            const info = mapNotifyboxRowToInfo(row, new Date(now - i).toISOString());
            if (info) byId.set(id, info);
        });
        return Array.from(byId.values());
    }

    /**
     * 終了した番組をリストから外す（doc/09 項目BF-2）。
     *
     * 【考え方】**notifybox の不在は「疑い」でしかない。終了かどうかは本人に聞いて確かめる。**
     *
     *   1. notifybox から消えた番組を「終わったかもしれない」とみなす（＝疑い）
     *   2. その番組だけ番組詳細API に問い合わせ、`liveCycle` を見る
     *   3. `ended` なら消す。`on_air` なら残す。**答えが得られなければ消さない**
     *
     * 🔴 **これは推測ではなく確認なので、notifybox が何件返そうと放送中の番組は消えない。**
     * 2026-08-01 の事故（rows=500 を要求したら5件しか返らず、放送中16件が「終了した」と
     * 誤判定されてカードが消えた）は、この形なら起きない。16件すべてに問い合わせが飛び、
     * すべて `on_air` が返り、1件も消えない。
     *
     * 【なぜ件数で守るのをやめたか】2026-08-01 に件数で守ろうとして3回失敗した:
     *   - 「要求数ぴったり／実績値ちょうど」→ 5件の応答が素通りして事故が起きた
     *   - 「フォローAPIより少なければ怪しい」→ notifybox が先に落とすのが前提なので常に止まる
     *   - 「notifybox が返した範囲より古い番組は触らない」→ **いちばん古い番組が終わると、
     *     基準がそれより新しい番組へ繰り上がり、自分が自動的に範囲の外になる。永久に消えない**
     *     （2026-08-02 に実コードで再現。長時間放送の番組ほど当たる）
     * **不在から終了を導こうとする限り、この手の穴は塞ぎきれない。だから導くのをやめた。**
     *
     * 【速さ】実測 2026-08-02: 詳細APIは番組終了の **0.5〜1.0秒後**には `ended` を返す
     * （応答 約31ms・約2KB）。問い合わせるのは疑いが出た番組だけなので、普段は1周期に0〜数件。
     *
     * @param {Array<object>} programs `_mergeSources` の結果
     * @param {Array<any>|false} notifyList notifybox の生応答（失敗時 false）
     * @returns {Promise<Array<object>>} 終了と**確認できた**番組を除いたリスト
     */
    /**
     * 自動移動で離れた番組を覚える。**起動時に1回だけ。**
     * 🔴 **絶対に throw しないこと。** 約束を持ち回るので、失敗すると確認の入口で例外になる。
     */
    async _seedEndedFromAutoNext() {
        try {
            const id = await takeEndedByAutoNext();
            if (id) {
                this._endedByAutoNext = id;
                this._endedByAutoNextUntil = Date.now() + endedByAutoNextValidMs;
            }
        } catch (_e) { /* 読めなければ従来どおり詳細APIに聞く */ }
    }

    /** 自動移動で離れた番組か（期限内のみ）。 */
    _isEndedByAutoNext(id) {
        return !!id && id === this._endedByAutoNext && Date.now() <= this._endedByAutoNextUntil;
    }

    async _dropEndedPrograms(programs, notifyList) {
        // 🔴 **種蒔きを待ってから判断する。** ここより後だと、初回の周期だけ間に合わない
        //    （＝自動移動の直後という、いちばん効いてほしい場面で効かない）。
        await this._endedSeeded;

        // 消したままにする（＝終了と分かっている番組を落とす）。理由は2つあり、扱いが違う:
        //   `_endedConfirmed`   … 詳細APIが ended と答えた。鳴る罠の対象
        //   `_endedByAutoNext`  … 自動移動が終了を見て離れた。期限つき・鳴る罠の対象外
        const dropConfirmed = (list) => list.filter((p) => {
            const id = p && p.id ? String(p.id) : '';
            return !(id && (this._endedConfirmed.has(id) || this._isEndedByAutoNext(id)));
        });

        // notifybox の取得に失敗した周期は**新たな疑いを立てない**（通信断で全部消えるのが最悪の壊れ方）。
        // ⚠️ ただし**確認済みの番組は消したままにする**。ここで戻すと、notifybox が不安定な間
        //    「終わった番組が出たり消えたり」を繰り返す。推測で消したのなら戻す価値があるが、
        //    確認して消した番組を notifybox の不調で戻す理由は無い。
        if (!Array.isArray(notifyList)) return dropConfirmed(programs);

        const live = new Set();
        for (const row of notifyList) {
            if (row && row.id != null) live.add('lv' + String(row.id).replace(/^lv/, ''));
        }

        // 消した番組が notifybox に戻ってきた＝詳細APIと notifybox が食い違っている。鳴る罠。
        for (const id of live) {
            if (this._endedConfirmed.has(id)) {
                this._endedConfirmed.delete(id);
                warnNotifyboxResurrection(id);
            }
        }

        // 疑い＝notifybox に居ない番組。既に `ended` と確認済みの番組は聞き直さない。
        const suspects = [];
        for (const p of programs) {
            const id = p && p.id ? String(p.id) : '';
            // 自動移動で離れた番組は聞くまでもない（聞いても一覧より詳細のほうが遅いことがある）
            if (!id || live.has(id) || this._endedConfirmed.has(id) || this._isEndedByAutoNext(id)) continue;
            suspects.push(id);
        }

        // 1周期の問い合わせ数に上限を置く（notifybox が壊れて大量に疑いが出た時の暴走止め）。
        // ⚠️ あぶれた番組は**次の周期に回るだけ**。消えるのが遅れることはあっても、
        //    間違って消えることはない（確認できていない番組は消さないため）。
        const batch = suspects.slice(0, endCheckMaxPerCycle);
        if (suspects.length > batch.length) {
            console.warn(
                `[終了確認] 疑いが ${suspects.length}件あるため、この周期は ${batch.length}件だけ確認します`
                + '（残りは次の周期）。notifybox の応答が異常に少ない可能性があります。'
            );
        }
        await Promise.all(batch.map(async (id) => {
            const info = await fetchProgramInfo(String(id).replace(/^lv/, ''));
            // ⚠️ **答えが得られなかった時（通信断・404・想定外の応答）は消さない。**
            //    「判断の材料が無い時は消さない」を守る。次の周期にまた聞く。
            if (info && info.liveCycle === 'ended') this._endedConfirmed.add(id);
        }));

        const kept = dropConfirmed(programs);

        // 掃除: 今回のリストにも居ない番組の印は落とす（集合が青天井にならないように）。
        // ⚠️ **消した番組の印は残る**（フォローAPIがまだ返している＝`programs` に居るため）。
        //    それでよい。印が消えるのはフォローAPIもその番組を手放した時＝本当に用が済んだ時。
        //    印を早く落とすと、フォローAPIが返し続けている間ずっと問い合わせ直すことになる。
        const stillRelevant = new Set();
        for (const p of programs) if (p && p.id) stillRelevant.add(String(p.id));
        for (const id of this._endedConfirmed) {
            if (!stillRelevant.has(id)) this._endedConfirmed.delete(id);
        }
        return kept;
    }

    /**
     * notifybox が先に見つけた新番組の最小レコードを storage にも載せる。
     *
     * 【なぜ必要か】ライブサムネの追撃 `_fetchLiveThumbIfPendingYoung` は **storage のレコードを
     * 見て動く**。notifybox 由来の番組は storage に居ないので追撃が始まらず、フォローAPIが
     * その番組を返すまで（実測 **20〜101秒**）サムネを取りに行けなかった。
     * ここで種を蒔いておけば、カードのサムネ周期（20秒）が来た時点で詳細APIを叩ける＝
     * フォローAPIを待たずにライブサムネが出る（doc/09 項目AZ）。
     *
     * ⚠️ 蒔くのは `_source==='notifybox'`（＝フォローAPIにも storage にも無い正真正銘の新着）だけ。
     *    フォローAPI由来のレコードを上書きしないこと。`_mergeSources` の優先順位がそれを保証している。
     * ⚠️ この最小レコードは 来場者0・コメント0 なので、**盛り上がりの計算で「前回値」に使わない**
     *    （0からの差分を急増と誤認する）。`nextMomentum` が `_source` を見て弾いている。
     * @param {Array<object>} programs `_mergeSources` の結果
     */
    _seedNewProgramsToStorage(programs) {
        const seeds = programs.filter((p) => p && p._source === 'notifybox');
        if (seeds.length) upsertProgramInfos(seeds);
    }

    _orderByBeginAtDesc(programs) {
        const beginMs = (p) => {
            const t = p && p.onAirTime && p.onAirTime.beginAt ? Date.parse(p.onAirTime.beginAt) : NaN;
            return Number.isFinite(t) ? t : -Infinity; // 時刻不明は末尾へ
        };
        const lvNum = (p) => parseInt(String((p && p.id) || '').replace(/^lv/, ''), 10) || 0;
        return [...programs].sort((a, b) => {
            const d = beginMs(b) - beginMs(a);
            if (d !== 0) return d;
            return lvNum(b) - lvNum(a);
        });
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
        // 既に動いているセッションがあれば startSession が null を返す（＝相乗り）。
        // 呼び出し側は null の時に finish しなければよい。
        const sessionId = this.loadingManager.startSession();

        // 描画の世代を採番する。取得の await 明けに「自分がまだ最新か」を確認するため。
        //
        // 🔴 **セッションの相乗りは描画の排他にはならない。** startSession が null を返すのは
        //    「スピナーの持ち主は別にいる」という意味だけで、取得も描画も普通に進む。
        //    updateSidebar は3経路から呼ばれ、うち **AutoNext 経路（main.js）だけ
        //    `_isUpdateInFlight()` ガードが無い**（定期tick `_sidebarTick` と手動更新は
        //    isPerformingManualUpdate で弾いている）。よって重なりうる。
        const myGen = ++this._renderGen;

        try {
            // 2つの取得元を並列に叩き、**和集合**を表示する（doc/09 項目AD）。
            //
            //   notifybox   … 「誰がいるか」を早く知る担当。返すのは実質 id と title だけだが、
            //                  user番組の新着検知がフォローAPIより 20〜101秒 速い（2026-07-29 実測）。
            //   フォローAPI … 詳細・並び順(beginAt)・100件を超える番組の担当。
            //
            // ⚠️ 旧実装は notifybox を「絞り込み」に使っていた（notifybox に載った番組だけカード化）。
            // notifybox は rows=100 でページングが無いため、**放送中が100件を超えると101件目以降が
            // 表示されなかった**（詳細だけ取得して捨てていた）。和集合にすることでこれも解消する。
            //
            //   Kick        … フォロー中の放送中番組。1リクエストで完成データが揃う。
            //                  権限が無ければ即 {ok:false,reason:'no-permission'}（＝既定の状態）。
            //
            // 🔴 **Kick をこの Promise.all に並べるのは await 地点を増やさないため。**
            //    取得後に別の await を足すと「自分がまだ最新か」の世代確認（項目AP）を
            //    もう1箇所足す必要が出る。ここに並べれば既存の確認がそのまま効く。
            const [notifyList, followRes, kickResult] = await Promise.all([
                fetchLivePrograms(),             // 失敗時 false（件数は api.js が持つ＝失敗で下がる）
                this._refreshDetailsViaScrape(), // {ok, programs} / {ok:false, reason}
                fetchKickPrograms(),             // 失敗時 {ok:false}
            ]);
            // ⚠️ ここから下は**従来どおり配列 or null**として扱う（`[]` は「放送中0件」で真）。
            //    理由が要るのは案内の出し分けだけなので、包みはここで開く。
            const fetched = followRes.ok ? followRes.programs : null;
            // 🔴 **取れなかった周期は「0件」にせず、前回の結果を据え置くこと。**
            //    空にすると、Kick の取得が一瞬失敗するたびに**Kick のカードが全部消えて
            //    次の周期で戻る＝点滅する。** kick.com ページ側は元から据え置きにしてあり、
            //    ここだけ逆だった（2026-08-07 に発見）。
            //    「取れなかった」は「居なかった」ではない（doc/09 項目BF-2 と同じ話）。
            const kickPrograms = (kickResult && kickResult.ok && Array.isArray(kickResult.programs))
                ? kickResult.programs
                : (this._kickPrograms || []);

            // 🔴 自分より後に始まった取得が既に描画を終えていたら、ここで降りる（doc/09 項目AP）。
            //
            // `livePrograms` は**取得を始めた時刻のスナップショット**であって、着地時点の現実ではない。
            // フォローAPIは1ページずつ await で回す逐次ページングなので、フォローが多い日は数秒かかる。
            // その数秒の間に始まった新番組は、こちらのスナップショットには載っていない。
            // 載っていないまま描画すると、削除検知（「DOMにあって新リストに無い」）が
            // **新番組を「終わった番組」と誤判定してカードを消す**。
            //
            // 実測（scripts/verify-sidebar-loop.mjs の raceRender）:
            //   B着地 → [400,100,200]（新番組が出る）→ A着地 → [100,200]（消える）
            // 復活は次の周期なので、設定によっては最大180秒ぶん表示されない。
            // 「新しく始まった番組をすぐ拾う」ために notifybox とフォローAPIの和集合まで
            // 用意している（項目AD）のに、その成果をここで捨てていた。
            //
            // ⚠️ 判定はここ（await の直後・描画に触る前）に置くこと。これより後ろに置くと
            //    apiErrorElement の表示や updateProgramCount を古い結果で上書きしてしまう。
            // ⚠️ セッションは閉じさせる必要があるので sessionId は返す（呼び出し元の後始末）。
            if (myGen !== this._renderGen) return sessionId;

            // ログイン誘導は「両方失敗」の時だけ出す（＝未ログイン/通信断）。
            // 片方でも取れていれば描画できるので、エラー表示はしない。
            const bothFailed = !fetched && !notifyList;
            // 🔴 **「ログイン」は 401/403 の時だけ**（doc/09 項目CH）。それ以外は
            //    メンテナンス・通信断・仕様変更なので「接続できません」を出す。
            //    notifybox は未ログインでも 404 の HTML を返す（2026-08-10 実測）ので
            //    認証の判定には使えない。**判断材料はフォローAPIの状態コードだけ。**
            setNicoNotice(!bothFailed ? NICO_NOTICE_NONE
                : (followRes.reason === 'unauthorized' ? NICO_NOTICE_AUTH : NICO_NOTICE_UNREACHABLE));

            // Kick のログイン切れは**ニコ生とは別に**知らせる（doc/09 項目CG）。
            // 🔴 上の `bothFailed` に混ぜないこと。あれはニコ生の2経路の話で、
            //    中身もニコ生のログインリンク。Kick が切れただけでニコ生を勧めることになる。
            // ⚠️ **毎周期 true/false を渡し切る。** 出す時だけ呼ぶと、ログインし直しても消えない。
            setKickNotice(isKickSessionLost(kickResult));

            // 🔴 **ニコ生が落ちても Kick まで止めないこと**（doc/09 項目CH）。
            //    以前はここで無条件に return しており、Kick は正常なのに巻き添えで更新が
            //    止まっていた（`this._kickPrograms` の更新もこの先にあるので、
            //    サムネ更新ループまで古いリストを使い続ける）。
            //
            // ⚠️ **ニコ生のカードを消させないこと。** 描画は「新リストに無いカードを消す」ので、
            //    ニコ生ぶんが空のまま描画すると全部消える。前回の取得結果を据え置いて埋める
            //    （kick.com 側が `lastNicoPrograms` でやっているのと同じ）。
            let merged;
            if (bothFailed) {
                merged = this._nicoPrograms || [];

                // ⚠️ **据え置く元がまだ無いのに DOM にニコ生のカードがある**＝復元できない。
                //    その周期だけ従来どおり何も描かずに帰る（消すより古いまま残すほうが良い）。
                //    起動直後は取得が成功するまでカードが無いので、通常ここには来ない。
                const shown = document.getElementById('liveProgramContainer');
                const nicoCards = shown
                    ? Array.from(shown.children).filter((el) => el.getAttribute('data-service') !== 'kick').length
                    : 0;
                if (!merged.length && nicoCards > 0) {
                    this.updateProgramCount(shown.children.length);
                    return sessionId;
                }
            } else {
                // 和集合を作ってから、終了したと**確認できた**番組を落とす。
                // ⚠️ 順序を入れ替えないこと。先に落としても `_mergeSources` が notifybox 行を
                //    足し直すので意味が無い。
                merged = await this._dropEndedPrograms(this._mergeSources(notifyList, fetched), notifyList);

                // 🔴 上の確認は詳細APIを叩くので、ここでもう一度世代を確かめる（項目AP と同じ理由）。
                //    問い合わせている間に別の取得が着地して描画を終えていたら、古い結果で上書きしない。
                //    ⚠️ **await を足したらこの確認も足すこと。** 前回は取得の直後にしか置いておらず、
                //       ここに await が増えた時に守りが1つ抜けた形になる。
                if (myGen !== this._renderGen) return sessionId;

                this._seedNewProgramsToStorage(merged);
                // 次にニコ生が落ちた時に据え置く元。**成功した周期だけ更新する。**
                this._nicoPrograms = merged;
            }

            // 🔴 **Kick を足すのはここ。`_seedNewProgramsToStorage` より後。**
            //
            //  - **ニコ生の localStorage キャッシュに入れない。** あのキャッシュは「詳細を別APIで
            //    後から補う」ために在る。Kick は毎回の取得でサムネURL・開始時刻・同接が揃って
            //    返るので、補う対象が無い。入れると `lv` 前提のキー生成に手を入れることになる。
            //  - **`_dropEndedPrograms`（ニコ生の詳細APIで終了確認）も通さない。**
            //    Kick は「今回のリストに居ない＝終了」で判定できる。詳細APIも存在しない。
            //  - **`updateThumbnailsFromStorage` の対象にもならない**（storage に居ないため）。
            //    Kick のサムネは毎周期のリスト取得で新しい URL が来る（versionId が変わる）。
            const combined = kickPrograms.length ? merged.concat(kickPrograms) : merged;
            // サムネ更新ループが Kick も対象にできるよう控えておく。
            // Kick は localStorage に入れていないので、そこからは引けない。
            this._kickPrograms = kickPrograms;

            // 空のときは既存DOMを維持（取得は成功していて放送中0件）
            if (combined.length === 0) {
                this.updateProgramCount(0);
                return sessionId;
            }

            // 新着順の基準（放送開始が新しい順）。data-api-index はこの並びの位置を表す。
            // Kick も `onAirTime.beginAt` を持つので、そのまま同じ土俵で並ぶ。
            const livePrograms = this._orderByBeginAtDesc(combined);

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
            livePrograms.forEach((data, apiIndex) => {
                if (!data || !data.id) return;

                // 1番組のカード生成で失敗しても、その番組だけスキップしてリスト全体は描画する。
                // （不正データを踏んでもサイドバー全体が空にならないようにする防御）
                try {
                    // カードのDOM id は「lv を外した数値」。サムネ更新側が `lv${card.id}` で
                    // 引き直す前提になっているので、この規約は変えないこと。
                    // 🔴 自前で正規化しないこと（cardIdOf が唯一の定義）。ずれると既存カードを
                    //    引き当てられず、毎周期カードを作り直してリストがチラつく。
                    const id = cardIdOf(data);
                    const existing = existingMap.get(id);

                    if (existing) {
                        // その場更新。**カードのDOMは移動も作り直しもしない。**
                        // 人気順が読む属性（active-point / data-total / 弾幕補正の覗き窓）を
                        // まとめて更新する。**個別に書かないこと** — 片方だけ更新すると
                        // 同点時の並びが古い値で決まる。書き手は applyRankAttributes だけにしてある。
                        applyRankAttributes(existing, data);
                        // 新着順（放送開始が新しい順）での位置。sorting.js の newest がこれを昇順に並べる。
                        existing.setAttribute('data-api-index', String(apiIndex));
                        // タイトル・リンク先・配信者名・アイコン・静止サムネの戻り先(data-src)を反映。
                        // 旧実装はタイトルとリンク先しか更新しておらず、fillMissingDetails が後から
                        // 埋めた配信者名/アイコンと、空だった data-src が固定されたままだった（doc/09 項目AK）。
                        applyProgramInfoToCard(existing, data);
                        orderedIds.push(id);
                    } else {
                        // DOM要素を直接作成（構造変更）
                        const element = makeProgramElement(data, this.loadingImageURL);
                        if (element) {
                            element.setAttribute('data-api-index', String(apiIndex));
                            newElements.set(id, element);
                            orderedIds.push(id);
                            structuralChange = true;
                        }
                    }
                } catch (e) {
                    console.warn('[updateSidebar] カード生成に失敗（この番組をスキップ）:', data && data.id, e);
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

                // 定期更新で順位が入れ替わった時だけ FLIP でスライドさせる（doc/09 項目AI）。
                //
                // 入れ替わり自体は FLIP の有無に関係なく起きている。FLIP は動きを足すのではなく、
                // 既に起きている**瞬間移動を目で追える形にする**だけ。ユーザーが何もしていないのに
                // カードが飛ぶのは「一斉に切り替わるのが気持ち悪い」（サムネのドリフト設計の起点）と
                // 同じ種類の不快さなので、この拡張の既存の思想に沿う。
                //
                // ⚠️ 並べ替えは flipReorder の中で**同期的に**完了させること。First/Last の実測が
                //    噛み合わなくなるため、ここに await / rAF / microtask を挟んではいけない。
                //    （rAF を使うのは transform を外す Play フェーズだけで、DOM構造の変更は同期）
                // ⚠️ 初回描画では既存カードが無く First が取れないので moved が空になり、
                //    flipReorder は何もせずに返る（＝初回は自動的にアニメ無し）。
                // ⚠️ 設定で並び順を変えた時は**通さない**。ユーザー自身が起こした変化なので
                //    瞬時に切り替わる方がよい（optionsHandler → main.js の sortPrograms 経路）。
                //
                // 🔴 **フラグメントの組み立ては必ずこのコールバックの中で行うこと。**
                //    `frag.appendChild(既存カード)` は DOM 仕様上そのカードを**現在の親から取り外す**
                //    （pre-insert → adopt → 旧親から remove）。外で組むと flipReorder が First を
                //    測る時点で container が空になっており、firstRects が空 → moved が空 →
                //    **FLIP が毎回何もせずに return する**（＝アニメが一度も出ない）。
                //    2026-07-29 の初回配線で実際にこの形になっており、翌日にモックDOM検証で発覚した。
                //    例外もログも出ないので、目視でしか気付けない類の壊れ方だった。
                // リストから外れるカードが抱えている blob URL（②の給餌コマ）をここで解放する。
                // 外れた要素はDOMから辿れなくなるので、手放さないとページ滞在中ずっと残る。
                {
                    const keep = new Set(orderedIds);
                    for (const el of container.children) {
                        if (el && el.id && !keep.has(el.id)) releaseThumbnailBlobs(el);
                    }
                }
                flipReorder(container, () => {
                    const frag = document.createDocumentFragment();
                    for (const id of orderedIds) {
                        const el = existingMap.get(id) || newElements.get(id);
                        if (el) frag.appendChild(el);
                    }
                    container.replaceChildren(frag);
                    // 🔴 **カード幅の設定は「ここ」。flipReorder の外（後）でやらないこと。**
                    //    新規カードは幅が未設定のまま挿入される。flex なので既定幅が効き、
                    //    **折り返しが崩れたまま Last が測られる**（同じ行の既存カードは
                    //    新規カードの高さに引き伸ばされ、実測で 199x203 → 199x285 まで伸びていた）。
                    //    その壊れた座標で FLIP が transform を当て、直後に幅が直って
                    //    レイアウトが戻るため、**順位が変わっていないカードが飛んだ位置から滑ってくる**
                    //    （2026-08-04・利用者報告「同じ場所なのにフラップする」）。
                    //
                    //    列数は「意図した幅」(appState.sidebar.width)で決める。開閉アニメ中の途中幅
                    //    (offsetWidth) を使うと、開いた直後のリスト再描画がアニメ中に走った時に
                    //    1列⇔多列がパタついてサムネが一瞬巨大化するため。
                    setProgramContainerWidth(this.elems, this.appState.sidebar.width);
                    // ソート（詳細が揃っているので programsSort で確定できる）
                    this.sortProgramsInContainer(container);
                }, reorderFlipDurationMs);
                this.appState.update.isInserting = false;
            }
            // else: その場更新のみ（DOMの組み替え・並べ替えはしない＝差分だけ触る）

            // タブ分離モードの表示状態を実態へ合わせる。Kick のカードが無ければタブは出ない。
            // 戻り値は「いま見えている件数」（混在モードなら全件）。
            const visibleCount = syncServiceTabs(container, this.options.kickDisplayMode, this.options.kickActiveTab);

            // 番組数更新
            this.updateProgramCount(visibleCount);

            // 新規/削除カードに合わせてサムネ更新の期限表を同期する。
            this._refreshThumbSchedule();

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
        // ⚠️ **タブ分離中に「見えているカードだけ」で判定しないこと（2026-08-04 に試して撤回）。**
        //    隠れている側の並び替えで組み替えが走るのを省く狙いだったが、
        //    **チラつきの原因はこれではなかった**（flipReorder のスクロール位置リセット）。
        //    スクロールを直した今、組み替えが走っても見た目には何も起きない。
        //    残るのは「隠れている側の DOM 順がずれる」という不変条件だけで、
        //    タブ切り替え時の並べ直しと対にしないと古い順序が見える。割に合わない。
        const els = Array.from(container.children);
        if (els.length < 2) return false;
        // 🔴 比較器を**ここに書き直さないこと**。utils/programOrder.js が唯一の定義。
        //    ここが実際の並べ替え（sorting.js / sortProgramsByActivePoint）と食い違うと、
        //    「並べ替えが要る」と言い続けるのに並べ替えてもその順序にならない
        //    ＝毎周期 replaceChildren が走り、**全カードが毎回スライドする**（FLIP が効いている今は特に目立つ）。
        //    逆向きに食い違えば、必要な並べ替えが永久にスキップされる。
        const sorted = els.slice();
        sorted.sort(orderComparator(this.options.programsSort));
        for (let i = 0; i < els.length; i++) {
            if (els[i] !== sorted[i]) return true;
        }
        return false;
    }

    /**
     * サムネイルを更新
     */
    updateThumbnail(force, onComplete, onlyIds, onSettled) {
        // DOM差し替え中は実行しない。
        //
        // 🔴 **ここは本来到達しない**（doc/09 項目AL）。差し替え（`isInserting=true` 〜 `false`）は
        // await を1つも挟まない同期区間なので、単一スレッドである以上、別のコールバックが
        // その途中で `isInserting=true` を観測することはできない。
        //
        // 到達したなら「描画のどこかが非同期化された」合図である。そして**この分岐は
        // onComplete/onSettled を呼んで「完了した」と嘘をつく**ため、呼び出し元の `_thumbTick` は
        // 成功したものとして次の期限を +20秒 進める＝**サムネが「更新0回・エラー0件」のまま
        // 静かに止まる**。原因に辿り着けない類の壊れ方なので、1回だけ警告を出す。
        if (this.appState.update.isInserting) {
            if (!this._warnedInserting) {
                this._warnedInserting = true;
                console.warn('[サムネ反映] DOM差し替え中に呼ばれました。描画が非同期化された可能性があります（doc/09 項目AL）。このままだとサムネ更新が無言で止まります。');
            }
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
        if (this._isBackgroundTab()) {
            if (onComplete) onComplete();
            if (onSettled) onSettled();
            return;
        }

        // Kick は storage に入れていないので、直近の取得結果を足してから渡す。
        // これを忘れると Kick のサムネが更新されず、動くサムネのコマも貯まらない。
        const stored = getProgramInfosFromStorage();
        const kick = this._kickPrograms || [];
        const programInfos = kick.length ? (stored || []).concat(kick) : stored;
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
