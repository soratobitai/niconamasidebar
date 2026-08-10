/**
 * 【サイドバーの置き方】ページを寄せるか、上に重ねるか。
 *
 * 🔴 **両ページで同じ印を使うこと**（`<html>` の `nns-overlay`）。
 *    ニコ生と kick.com は寄せ方の仕組みがまったく違う
 *    （ニコ生は body の flex に並べて `#root` を縮める / kick は body へ margin と幅を当てる）が、
 *    **「重ねる」の判定と印は1箇所にまとめる。**
 *    別々に書くと、片方だけ直して他方が置いていかれる（doc/09 項目BN で何度も出ている型）。
 *
 * ⚠️ **印を付けるのは `<html>`。** `<body>` ではない。
 *    kick.com のサイドバーは `<html>` 直下に居るので、body に付けた印はサイドバー自身に届かない。
 */

/** 既定は「寄せる」。今までの動きを変えない。 */
export const SIDEBAR_PLACEMENT_DEFAULT = 'push'

/** `<html>` に付ける印。CSS 側はこれで分岐する。 */
export const OVERLAY_CLASS = 'nns-overlay'

/**
 * 設定値を正規化する。
 * ⚠️ **知らない値は「寄せる」に倒すこと。** 設定が壊れていた時に画面を覆い隠さないため。
 */
export function normalizeSidebarPlacement(value) {
    return value === 'overlay' ? 'overlay' : SIDEBAR_PLACEMENT_DEFAULT
}

/** 重ねる設定か。 */
export function isOverlayPlacement(value) {
    return normalizeSidebarPlacement(value) === 'overlay'
}

/**
 * 置き方を画面へ反映する。**両ページがこれを呼ぶ。**
 * @param {string} value 'push' | 'overlay'
 * @returns {boolean} 重ねる設定なら true
 */
export function applySidebarPlacement(value) {
    const overlay = isOverlayPlacement(value)
    try {
        document.documentElement.classList.toggle(OVERLAY_CLASS, overlay)
    } catch (e) { /* まだ document が無い等。次の呼び出しで付く */ }
    return overlay
}
