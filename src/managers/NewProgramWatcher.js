import { getProgramInfos as getProgramInfosFromStorage } from '../services/storage.js';
import {
    newProgramScanIntervalMs as SCAN_INTERVAL_MS,
    newProgramNotReadyBaseMs as RETRY_BASE_MS,
    newProgramNotReadyMaxDelayMs as RETRY_MAX_DELAY_MS,
    newProgramNotReadyMaxAttempts as RETRY_MAX_ATTEMPTS,
    newProgramNotReadyMaxTotalMs as RETRY_MAX_TOTAL_MS,
} from '../config/constants.js';

/**
 * 新番組先行検知（New Program Watcher）
 *
 * 通常の番組リスト更新（updateProgramsInterval, 既定120秒）を待たず、軽量スキャン（既定30秒）で
 * notifybox を差分照合し、新しく始まった番組を早くカード化＋詳細取得へ回す。検知遅延 最悪120秒→最悪30秒。
 *
 * サムネURL未生成対応（この機能の肝）:
 *   ニコ生の詳細API(liveInfoAPI)は放送開始直後、liveScreenshotThumbnailUrls がまだ空のことがある。
 *   その番組は fetchAndSave が「保存せず false」を返す（queue.js）ため localStorage に詳細が載らない。
 *   本 watcher は partial を一切保存しない（保存すると _fetchedAt が付き TTL[programInfoTtlMs] で
 *   再取得が止まる＝既知の落とし穴）まま、番組ごとにバックオフ（3s→6s→12s→24s→30s上限, 6回/90秒で諦め）で
 *   「詳細だけ」再取得する。詳細が保存でき次第（＝ライブサムネURLが用意でき次第）updateThumbnail で
 *   次の20秒tickを待たず即描画する。諦め後は placeholder カードが既にあるので再検知ループにならず、
 *   通常120秒サイクルへ委譲する（二重の安全網）。
 *
 * 稼働条件: サイドバーが開いている × タブが可視のときのみ。閉じる/非表示で完全停止
 *   （scanタイマー＋全 per-id タイマー＋状態）。タイマーは AppState.timers.newProgramScan に登録し
 *   cleanup/clearAllTimers の対象に載せる。
 *
 * 再利用: getLivePrograms（計測付き・in-flight dedupe 共有）/ updateSidebar（カード生成・ソート・エンキュー）/
 *   ProgramInfoQueue（4件/秒レート制限・重複排除）/ updateThumbnailsFromStorage（描画）を素通しで使う。
 *   queue.js のコアには手を入れない（未生成の判定は storage 観測で行う）。
 *   IIFEビルドのためモジュールグローバル参照はせず、依存は注入で受け取る（AutoNextManager と同方針）。
 */
export class NewProgramWatcher {
    constructor(appState, updateManager, programInfoQueue) {
        this.appState = appState;
        this.updateManager = updateManager;
        this.programInfoQueue = programInfoQueue;

        // 監視中の番組id（lvなし数値文字列）
        this.watchedIds = new Set();
        // 未生成リトライ状態: id -> { attempts, firstSeenAt, timer }
        this.pending = new Map();
        // 解決時のサムネ即描画を1回にまとめる合流タイマー
        this._thumbPaintTimer = null;
        // キュー drain を1回にまとめる合流タイマー
        this._drainTimer = null;
    }

    /** 稼働可能か（開いている×可視） */
    _active() {
        return this.appState.sidebar.isOpen && this.appState.isVisible();
    }

    /** 現在DOMに描画中の番組id集合（lvなし） */
    _renderedIds() {
        const set = new Set();
        const container = document.getElementById('liveProgramContainer');
        if (container) {
            for (const el of container.children) {
                if (el && el.id) set.add(el.id);
            }
        }
        return set;
    }

    /**
     * 開始（冪等）。開いている×可視のときのみ。
     * 最初のスキャンは1周期後（開いた直後は performManualUpdate/初回ロードが全件を担うため、
     * 直後は「新規」が無い＝スキャンを前倒しする意味がない）。
     */
    start() {
        if (!this._active()) return;
        // 既存タイマーを掃除してから張り直す（二重起動防止）
        this.appState.clearTimer('newProgramScan');
        const timer = setTimeout(() => this._runScan(), SCAN_INTERVAL_MS);
        this.appState.setTimer('newProgramScan', timer);
    }

    /** 完全停止（scanタイマー＋全 per-id タイマー＋状態）。閉じる/非表示/cleanup で呼ぶ。 */
    stop() {
        this.appState.clearTimer('newProgramScan');
        for (const st of this.pending.values()) {
            if (st.timer) clearTimeout(st.timer);
        }
        this.pending.clear();
        this.watchedIds.clear();
        if (this._thumbPaintTimer) {
            clearTimeout(this._thumbPaintTimer);
            this._thumbPaintTimer = null;
        }
        if (this._drainTimer) {
            clearTimeout(this._drainTimer);
            this._drainTimer = null;
        }
    }

    async _runScan() {
        // スキャン中に閉じ/非表示になっていたら何もしない
        if (!this._active()) return;
        try {
            await this._scanOnce();
        } catch (e) {
            // 失敗しても watcher は落とさない（次周期で回復）
            console.warn('[新番組検知] スキャンでエラー:', e);
        }
        // 完了後に次周期を張る（自己連鎖。await 後に可視/開を再確認）
        if (this._active()) {
            const timer = setTimeout(() => this._runScan(), SCAN_INTERVAL_MS);
            this.appState.setTimer('newProgramScan', timer);
        }
    }

    async _scanOnce() {
        // 計測付き・in-flight dedupe を共有する既存ラッパで取得（直接 fetchLivePrograms は呼ばない）
        const live = await this.updateManager.getLivePrograms(100);
        if (!this._active()) return;
        if (!Array.isArray(live) || live.length === 0) return;

        // 別更新(初回ロード/手動更新)が進行中(isLoading)なら、そのサイクルがリスト取り込み＋カード生成＋
        // エンキューを担う。ここで割り込むと settle 中の processNow と競合するため、この tick は検知を
        // 丸ごと見送る（監視登録もしない＝「監視したのにカードが無い」不整合を避ける。次周期で拾う）。
        if (this.appState.isLoading()) return;

        // DOM を「現在描画中」の唯一の真実として差分（120秒サイクルと食い違わない＝重複カードを作らない）
        const rendered = this._renderedIds();
        const newIds = [];
        for (const p of live) {
            if (!p || p.id == null) continue;
            const id = String(p.id);
            if (!rendered.has(id) && !this.watchedIds.has(id)) newIds.push(id);
        }
        if (newIds.length === 0) return;

        // 新番組を監視登録（バックオフ初期化＝最初のチェックを予約）
        for (const id of newIds) this._startWatch(id);

        // カード挿入＋詳細エンキューは既存 updateSidebar に委譲（同 tick で同期的にカード生成＝
        // 最初の _check[+3s] までに必ず placeholder カードが存在する）。
        // silent=スピナー無し／preloadedList=取得済みリスト再利用で二重fetch無し。
        this.updateManager.updateSidebar({ preloadedList: live, silent: true });
        this._kickQueue(); // updateSidebar が積んだ新番組の詳細を確実に処理させる
    }

    _startWatch(id) {
        if (this.pending.has(id)) return; // 既存監視は張り直さない
        this.watchedIds.add(id);
        this.pending.set(id, { attempts: 0, firstSeenAt: Date.now(), timer: null });
        this._arm(id);
    }

    _arm(id) {
        const st = this.pending.get(id);
        if (!st) return;
        const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_MS * Math.pow(2, st.attempts));
        st.timer = setTimeout(() => this._check(id), delay);
    }

    _check(id) {
        const st = this.pending.get(id);
        if (!st) return;
        if (!this._active()) { this._cleanup(id); return; }

        // 詳細が保存されていれば「解決」（サムネURLが用意された／member-only・channel で保存済み）。
        // partial を保存しない設計なので、詳細の存在＝サムネURL入手済み（＝再取得成功）を意味する。
        const infos = getProgramInfosFromStorage();
        const info = Array.isArray(infos) ? infos.find((i) => i && i.id === `lv${id}`) : null;
        if (info) {
            this._cleanup(id);
            this._scheduleThumbPaint(); // 次の20秒tickを待たず即描画
            return;
        }

        // 詳細が未保存＝サムネ未生成 or 一時失敗。カードが無い（放送終了/未生成）なら監視終了。
        const rendered = this._renderedIds();
        if (!rendered.has(id)) { this._cleanup(id); return; }

        st.attempts += 1;
        const elapsed = Date.now() - st.firstSeenAt;
        if (st.attempts >= RETRY_MAX_ATTEMPTS || elapsed >= RETRY_MAX_TOTAL_MS) {
            // 諦め: placeholder カードは残るので次スキャンで再検知されず（重複ループ防止）、
            // 通常120秒サイクルが詳細未取得のまま再エンキューして最終的に収束させる。
            this._cleanup(id);
            return;
        }
        // 詳細だけ再取得（partial は保存しない＝_fetchedAt を刻まない）。キューのレート制限/dedupe を通す。
        this.programInfoQueue.add(id);
        this._kickQueue();
        this._arm(id);
    }

    _cleanup(id) {
        const st = this.pending.get(id);
        if (st && st.timer) clearTimeout(st.timer);
        this.pending.delete(id);
        this.watchedIds.delete(id);
    }

    // キューの詳細取得を一度だけ確実に走らせる（合流）。
    // サイドバーを閉じて開き直した直後などは連続処理ループ(programInfoQueue.start)が停止しており、
    // add しただけでは処理されないことがあるため。ループ稼働中でも isProcessing ガード＋dedupe＋
    // 4件/秒レート制限で協調するので無害。settle中(isLoading)はその processNow が drain するので任せる。
    _kickQueue() {
        if (this._drainTimer) return;
        this._drainTimer = setTimeout(() => {
            this._drainTimer = null;
            if (!this._active() || this.appState.isLoading()) return;
            if (this.programInfoQueue.size() > 0) {
                this.programInfoQueue.processNow(null).catch(() => {});
            }
        }, 100);
    }

    // 複数番組が近接して解決したとき、サムネ更新(force)を1回にまとめる（無駄な全走査/CDN取得を抑制）
    _scheduleThumbPaint() {
        if (this._thumbPaintTimer) return;
        this._thumbPaintTimer = setTimeout(() => {
            this._thumbPaintTimer = null;
            if (this._active() && this.updateManager) {
                // force で TTL/バックオフをバイパスし、揃ったばかりのライブサムネを即 <img> へ反映
                this.updateManager.updateThumbnail(true);
            }
        }, 150);
    }
}
