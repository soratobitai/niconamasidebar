/**
 * 【同時視聴者数の表示】サムネの左上に出すかどうか（β版・2026-08-12・doc/09 項目CR）。
 *
 * 🔴 **両ページで同じ印を使うこと**（`<html>` の `nns-show-viewers`）。
 *    片方のページにだけ配線を足すと、そのページでだけ設定が効かない状態になる
 *    （doc/09 項目BN で何度も出ている型）。両ページが呼ぶことは検査 CR で縛っている。
 *
 * ⚠️ **印を付けるのは `<html>`。** `<body>` ではない。
 *    kick.com のサイドバーは `<html>` 直下に居るので、body に付けた印は届かない
 *    （`ui/placement.js` と同じ理由・同じ場所）。
 *
 * 🔴 **「出す時に印を付ける」向きにしてあること。** 逆（隠す時に付ける）にすると、
 *    この配線が動かなかった時に**既定OFFのはずの数字が出てしまう**。
 *    β版なので、壊れ方は「出ない」側に倒す。CSS も既定を `display:none` にしてある。
 */

/** 既定は OFF（β版。更新しただけで既存利用者の見た目が変わらないようにする）。 */
export const SHOW_VIEWER_COUNT_DEFAULT = 'off'

/** `<html>` に付ける印。CSS 側はこれで分岐する。 */
export const SHOW_VIEWERS_CLASS = 'nns-show-viewers'

/**
 * 設定値を正規化する。
 * ⚠️ **知らない値は OFF に倒すこと。** 設定が壊れていた時に、勝手に出さないため。
 */
export function normalizeShowViewerCount(value) {
    return value === 'on' ? 'on' : SHOW_VIEWER_COUNT_DEFAULT
}

/** 同時視聴者数を出す設定か。 */
export function isViewerCountVisible(value) {
    return normalizeShowViewerCount(value) === 'on'
}

/**
 * 表示/非表示を画面へ反映する。**両ページがこれを呼ぶ。**
 *
 * カードは作り直さない。バッジ自体は常に生成しておき（`applyRankAttributes` が中身を書く）、
 * ここは印の付け外しだけをする＝切り替えが即時に効き、描画中でも順位がずれない。
 *
 * @param {string} value 'on' | 'off'
 * @returns {boolean} 出す設定なら true
 */
export function applyShowViewerCount(value) {
    const show = isViewerCountVisible(value)
    try {
        document.documentElement.classList.toggle(SHOW_VIEWERS_CLASS, show)
    } catch (e) { /* まだ document が無い等。次の呼び出しで付く */ }
    return show
}
