/**
 * アプリケーション全体の状態を管理するクラス
 * 全てのグローバル状態を一箇所で管理し、クリーンアップを容易にする
 */
export class AppState {
    constructor() {
        // タイマー管理
        // ※サイドバーのリスト更新ループはここに載せない。UpdateManager が常設ループとして
        //   自前で1本だけ持ち、停止は destroySidebarLoop（ページ離脱時のみ）に一本化している。
        //   ここに載せると stopAllTimers / cleanup から外部に殺され、閉じた瞬間に復活不能になる。
        this.timers = {
            thumbnail: null, // サムネ更新ループ（20秒）
            autoNext: null,  // 自動移動
        };

        // オブザーバー管理
        this.observers = {
            resizeWatchPage: null,
            resizeSidebar: null,
            thumbnail: null, // thumbnailObserver は外部で管理されるため、参照のみ
        };

        // サイドバー状態
        this.sidebar = {
            width: 360,
            isOpen: false,
        };

        // 更新状態
        this.update = {
            isUpdating: false,
            pending: false,
            // DOM差し替え中フラグ。サムネ更新がDOM操作に割り込まないためのガード。
            isInserting: false,
        };

        // ローディング状態管理（更新セッション単位で管理）
        this.loading = {
            updateSession: null, // 更新セッションID（すべての処理を包括的に管理）
        };

        // 自動移動機能の状態
        this.autoNext = {
            scheduled: false,
            canceled: false,
            selectingNext: false,
            liveStatusStopper: null,
        };

        // その他
        this.handlers = {
            onResize: null,
            reloadBtn: null,
        };

        // 設定とDOM要素（参照のみ保持）
        this.config = {
            options: {},
            defaultOptions: {},
        };
        this.elements = {};
    }

    /**
     * タイマーを設定
     * @param {string} name - タイマー名 ('thumbnail' | 'autoNext')。未知のキーは無言で捨てられる
     * @param {number|object} timer - タイマーIDまたはタイマーオブジェクト
     */
    setTimer(name, timer) {
        if (name in this.timers) {
            this.timers[name] = timer;
        }
    }

    /**
     * タイマーを取得
     * @param {string} name - タイマー名
     * @returns {number|object|null} タイマー
     */
    getTimer(name) {
        return this.timers[name] || null;
    }

    /**
     * タイマーをクリア
     * @param {string} name - タイマー名
     */
    clearTimer(name) {
        if (name in this.timers && this.timers[name]) {
            if (typeof this.timers[name] === 'number') {
                clearTimeout(this.timers[name]);
                clearInterval(this.timers[name]);
            }
            this.timers[name] = null;
        }
    }

    /**
     * 全てのタイマーをクリア
     */
    clearAllTimers() {
        Object.keys(this.timers).forEach(name => {
            this.clearTimer(name);
        });
    }

    /**
     * オブザーバーを設定
     * @param {string} name - オブザーバー名
     * @param {object} observer - オブザーバーインスタンス
     */
    setObserver(name, observer) {
        if (name in this.observers) {
            this.observers[name] = observer;
        }
    }

    /**
     * オブザーバーを切断
     * @param {string} name - オブザーバー名
     */
    disconnectObserver(name) {
        if (name in this.observers && this.observers[name]) {
            try {
                if (typeof this.observers[name].disconnect === 'function') {
                    this.observers[name].disconnect();
                }
            } catch (_e) {
                // エラーは無視
            }
            this.observers[name] = null;
        }
    }

    /**
     * 全てのオブザーバーを切断
     */
    disconnectAllObservers() {
        Object.keys(this.observers).forEach(name => {
            this.disconnectObserver(name);
        });
    }

    /**
     * イベントハンドラーを設定
     * @param {string} name - ハンドラー名
     * @param {function} handler - ハンドラー関数
     */
    setHandler(name, handler) {
        if (name in this.handlers) {
            // 既存のハンドラーがあれば削除
            if (this.handlers[name]) {
                // 削除処理は呼び出し側で実装
            }
            this.handlers[name] = handler;
        }
    }

    /**
     * イベントハンドラーを取得
     * @param {string} name - ハンドラー名
     * @returns {function|null} ハンドラー
     */
    getHandler(name) {
        return this.handlers[name] || null;
    }

    /**
     * ローディング中かどうかを取得
     * @returns {boolean} ローディング中
     */
    isLoading() {
        return this.loading.updateSession !== null;
    }

    /**
     * 更新セッションを開始（すべての処理を包括的に管理）
     * @returns {string} セッションID
     */
    startUpdateSession() {
        const sessionId = `update_${Date.now()}_${Math.random()}`;
        this.loading.updateSession = sessionId;
        return sessionId;
    }

    /**
     * 更新セッションを完了
     * @param {string} sessionId - セッションID
     */
    finishUpdateSession(sessionId) {
        if (this.loading.updateSession === sessionId) {
            this.loading.updateSession = null;
        }
    }

    /**
     * 全てのリソースをクリーンアップ
     */
    cleanup() {
        // タイマーを全てクリア
        this.clearAllTimers();

        // オブザーバーを全て切断
        this.disconnectAllObservers();

        // イベントハンドラーを削除（必要に応じて）
        this.handlers.onResize = null;

        // 自動移動機能のクリーンアップ
        if (this.autoNext.liveStatusStopper) {
            try {
                this.autoNext.liveStatusStopper();
            } catch (_e) {
                // エラーは無視
            }
            this.autoNext.liveStatusStopper = null;
        }
    }
}

