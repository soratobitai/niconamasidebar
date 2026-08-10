import { setReloadButtonLoading } from '../render/sidebar.js';

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
     * ローディングセッションを開始する。
     *
     * ⚠️ **既に動いているセッションがあれば `null` を返し、何もしない**（doc/09 項目AG）。
     *
     * 旧実装は前のセッションを finish せずに**黙って上書き**していた。これが厄介な不具合の
     * 発生源だった: 後から来た者が持ち主からロックを奪い、それを閉じると持ち主がまだ実行中なのに
     * `isLoading()` が false へ落ちて、更新ボタンが「押せるのに無反応」になる。
     * 対策として finish 側のIDスコープ化や呼び出し側の相乗り判定を後付けしていたが、
     * **奪える構造がある限り同種の問題は出続ける**ため、奪えなくした。
     *
     * 呼び出し側は「`null` が返ったら自分は持ち主ではない＝finish してはいけない」と解釈する。
     *
     * @returns {string|null} 新しく開始したセッションID。既に動いていれば null
     */
    startSession() {
        if (this.currentUpdateSessionId) return null; // 持ち主がいる。奪わない
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
            this._finishNow(); // 見捨てられたセッションの回収は無条件に行う
        }, this.loadingSessionTimeoutMs);

        return sessionId;
    }

    /**
     * ローディングセッションを完了する。**持ち主だけが閉じられる。**
     *
     * @param {string|null} expectedSessionId
     *   `startSession` が返したID。**一致しない／null なら何もしない。**
     *
     * `null` を「無条件に閉じる」と解釈してはいけない。`startSession` は先客がいると `null` を
     * 返す（＝自分は持ち主ではない）ので、その `null` をそのまま渡された時に閉じてしまうと、
     * **持ち主がまだ実行中なのにロックが解ける**。呼び出し側が `if (sessionId)` を書き忘れても
     * 事故にならないよう、API 側で安全にしてある（doc/09 項目AG）。
     *
     * 無条件に閉じたいのはタイムアウト回収だけで、それは内部の `_finishNow` が担う。
     */
    finishSession(expectedSessionId = null) {
        if (!this.currentUpdateSessionId) return;
        if (expectedSessionId !== this.currentUpdateSessionId) return; // 持ち主でなければ触らない
        this._finishNow();
    }

    /** 実際の後始末。持ち主判定を通った時と、タイムアウト回収からのみ呼ぶ。 */
    _finishNow() {
        if (!this.currentUpdateSessionId) return;
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
     * @param {string|null} expectedSessionId - `finishSession` と同じ規則。**持ち主だけが閉じられる。**
     *   この関数自身が最低表示時間ぶん await するため、待っている間に状況が変わりうる。
     *   よって入口だけでなく await の後にも照合する（`finishSession` 側で再照合される）。
     */
    async finishSessionWithMinDuration(minDuration = 1000, expectedSessionId = null) {
        // 持ち主でなければ何もしない（待ちもしない）。null＝相乗り側もここで弾かれる。
        if (expectedSessionId !== this.currentUpdateSessionId) return;
        if (!this.sessionStartTime) {
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
        // 見た目の付け外しは kick.com ページと共有する（setReloadButtonLoading が唯一の実装）。
        // ここに直接書き戻すと、両ページで挙動がずれる。
        setReloadButtonLoading(this.appState.isLoading());
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

