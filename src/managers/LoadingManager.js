/**
 * ローディング状態管理
 * 更新セッションの開始・終了、ローディング表示の制御を担当
 */
export class LoadingManager {
    constructor(appState, loadingSessionTimeoutMs) {
        this.appState = appState;
        this.loadingSessionTimeoutMs = loadingSessionTimeoutMs;
        this.currentUpdateSessionId = null;
        this.sessionStartTime = null;
        this.sessionTimeoutTimer = null;
    }

    /**
     * ローディングセッションを開始
     * @returns {string} セッションID
     */
    startSession() {
        const sessionId = this.appState.startUpdateSession();
        this.currentUpdateSessionId = sessionId;
        this.sessionStartTime = performance.now();
        this.updateLoadingState();
        
        // タイムアウト設定
        if (this.sessionTimeoutTimer) {
            clearTimeout(this.sessionTimeoutTimer);
        }
        this.sessionTimeoutTimer = setTimeout(() => {
            console.error('⚠️ [タイムアウト] ローディングセッションがタイムアウトしました', {
                sessionId: this.currentUpdateSessionId,
                duration: `${this.loadingSessionTimeoutMs / 1000}秒`
            });
            this.finishSession();
        }, this.loadingSessionTimeoutMs);
        
        return sessionId;
    }

    /**
     * ローディングセッションを完了する
     *
     * @param {string|null} expectedSessionId
     *   指定すると「現在のセッションがそれと一致する時だけ」閉じる（IDスコープ）。
     *   startSession は前セッションを finish せずに上書きするため、await を跨いで戻ってきた
     *   呼び出し元が素朴に finish すると「他人のセッション」を閉じてしまう。結果、手動更新が
     *   まだ走っているのに更新ボタンの pointer-events が戻り「押せるのに無反応」になる。
     *   省略時は従来どおり現在のセッションを無条件に閉じる。
     */
    finishSession(expectedSessionId = null) {
        if (!this.currentUpdateSessionId) {
            return;
        }
        if (expectedSessionId && expectedSessionId !== this.currentUpdateSessionId) {
            return; // 自分が始めたセッションではない＝触らない
        }

        const sessionId = this.currentUpdateSessionId;
        const duration = this.sessionStartTime 
            ? (performance.now() - this.sessionStartTime).toFixed(0) 
            : 'unknown';
        
        // 異常に長いセッション（10秒以上）の場合のみ警告
        if (duration !== 'unknown' && parseFloat(duration) > 10000) {
            console.warn(`⚠️ [異常検出] ローディングセッションが${(duration / 1000).toFixed(1)}秒かかりました`, {
                sessionId
            });
        }
        
        if (this.sessionTimeoutTimer) {
            clearTimeout(this.sessionTimeoutTimer);
            this.sessionTimeoutTimer = null;
        }
        if (this.currentUpdateSessionId) {
            this.appState.finishUpdateSession(this.currentUpdateSessionId);
            this.currentUpdateSessionId = null;
        }
        this.sessionStartTime = null;
        this.updateLoadingState();
    }

    /**
     * 最低ローディング時間を確保してセッションを完了する
     * @param {number} minDuration - 最低表示時間（ミリ秒）
     * @param {string|null} expectedSessionId - finishSession と同じIDスコープ。
     *   この関数自身が最低表示時間ぶん await するため、待っている間にセッションが差し替わりうる。
     *   よって入口だけでなく await の後にも照合する（finishSession 側で再照合される）。
     */
    async finishSessionWithMinDuration(minDuration = 1000, expectedSessionId = null) {
        if (expectedSessionId && this.currentUpdateSessionId
            && expectedSessionId !== this.currentUpdateSessionId) {
            return; // 自分が始めたセッションではない＝待つ必要も閉じる必要もない
        }
        if (!this.currentUpdateSessionId || !this.sessionStartTime) {
            this.finishSession(expectedSessionId);
            return;
        }

        const elapsed = performance.now() - this.sessionStartTime;
        const remaining = minDuration - elapsed;

        if (remaining > 0) {
            // 最低表示時間に達していない場合は待つ
            await new Promise(resolve => setTimeout(resolve, remaining));
        }

        this.finishSession(expectedSessionId);
    }

    /**
     * ローディング状態を更新（更新ボタンにローディング表示を適用）
     */
    updateLoadingState() {
        const reloadBtn = document.getElementById('reload_programs');
        if (!reloadBtn) {
            return;
        }
        
        const isLoading = this.appState.isLoading();
        
        if (isLoading) {
            // ローディング中：更新ボタンを無効化し、ローディング表示を追加
            if (!reloadBtn.classList.contains('loading')) {
                reloadBtn.classList.add('loading');
                reloadBtn.style.pointerEvents = 'none'; // クリック無効化
            }
        } else {
            // 全ての処理が完了：ローディング表示を解除し、更新ボタンを有効化
            if (reloadBtn.classList.contains('loading')) {
                reloadBtn.classList.remove('loading');
                reloadBtn.style.pointerEvents = ''; // クリック有効化
            }
        }
    }

    /**
     * 現在のセッションIDを取得
     */
    getCurrentSessionId() {
        return this.currentUpdateSessionId;
    }

    /**
     * ローディング中かどうか
     */
    isLoading() {
        return this.appState.isLoading();
    }
}

