/**
 * 拡張のコンテキストが生きているかの判定と、死んだ時の後始末フック。
 *
 * 【何が起きるか】拡張を再読み込み・更新・無効化すると、開いていたページに注入済みの
 * content script は**そのまま動き続ける**が、`chrome.*` は使えなくなる。この状態で
 * `chrome.runtime.getURL()` などを呼ぶと `Extension context invalidated` を投げる。
 *
 * 【実測 2026-08-02（拡張をアンインストールして観測）】
 *   - `Uncaught Error: Extension context invalidated.` の発生元は2箇所だけだった:
 *       handleThumbnailError（imgのerrorリスナ）／ syncStaticThumb（rAF の tick 内＝uncaught になる）
 *     どちらも `chrome.runtime.getURL('images/loading.gif')`。**ライブサムネを持たない番組が
 *     リストに居る回だけ**通る経路で、その番組が無い構成では0件、1件足すと2件出た。
 *   - さらに**取得が止まらない**: 無効化後60秒で サムネ +9回、別の回で follow +1 / notifybox +1。
 *     `cleanup` は beforeunload/pagehide でしか走らないため、誰も止めていなかった。
 *     開発中の再読み込みだけでなく、Chrome の自動更新でタブが開いていた場合にも起きる。
 *
 * 【判定に何を使うか】`chrome.runtime.id`。無効化されると undefined になる。
 * `chrome.runtime` の参照自体が投げることもあるので try で包む
 * （投げた＝生きていないので false を返せばよい）。
 */

let notified = false
const handlers = []

/**
 * 拡張のコンテキストが生きているか。
 * @returns {boolean}
 */
export function isExtensionAlive() {
    try {
        return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id)
    } catch (_e) {
        return false
    }
}

/**
 * 無効化を検知した時に1回だけ呼ぶ後始末を登録する。
 * @param {Function} fn
 */
export function onExtensionInvalidated(fn) {
    if (typeof fn === 'function') handlers.push(fn)
}

/**
 * 生きているかを確かめ、死んでいたら登録済みの後始末を**1回だけ**走らせる。
 *
 * 各ループの tick の先頭から呼ぶ。専用のタイマーを増やさずに済むうえ、
 * 止めたい対象（＝定期取得）そのものが検知点になる。
 * @returns {boolean} 生きていれば true（呼び出し元は処理を続けてよい）
 */
export function checkExtensionAlive() {
    if (isExtensionAlive()) return true
    if (!notified) {
        notified = true
        // 拡張が消えた後なので、ここで chrome.* を触るものを呼んではいけない。
        for (const fn of handlers) {
            try { fn() } catch (_e) { /* 1つ失敗しても残りは走らせる */ }
        }
    }
    return false
}

/** テスト用: 検知済みフラグと登録を戻す。 */
export function _resetExtensionAliveForTest() {
    notified = false
    handlers.length = 0
}
