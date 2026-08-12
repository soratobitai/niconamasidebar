/**
 * 【経過時間の表示】サムネの右下に「放送開始から何分か」を出すかどうか
 * （β版ではない・2026-08-12・doc/09 項目CX）。
 *
 * 🔴 **両ページで同じ印を使うこと**（`<html>` の `nns-show-elapsed`）。
 *    片方のページにだけ配線を足すと、そのページでだけ設定が効かない
 *    （doc/09 項目BN で何度も出ている型）。両ページが呼ぶことは検査 CX で縛っている。
 *
 * ⚠️ **印を付けるのは `<html>`。** `<body>` ではない（kick.com のサイドバーは `<html>` 直下）。
 *    `ui/placement.js` / `ui/viewerCount.js` と同じ場所・同じ理由。
 *
 * 🔴 **「出す時に印を付ける」向きにしてあること。** 逆にすると、この配線が動かなかった時に
 *    既定OFFのはずの表示が出る。CSS も既定を `display:none` にしてある。
 *    ⚠️ CSS でクラスに `display` を当てたら `[hidden]` ではなくこの印で出し分けること
 *       （`hidden` 属性と混ぜない。項目CW で踏んだ罠と隣り合わせ）。
 */

/** 既定は OFF（更新しただけで既存利用者の見た目が変わらないようにする）。 */
export const SHOW_ELAPSED_DEFAULT = 'off'

/** `<html>` に付ける印。CSS 側はこれで分岐する。 */
export const SHOW_ELAPSED_CLASS = 'nns-show-elapsed'

/** ⚠️ **知らない値は OFF に倒すこと。** 設定が壊れていた時に勝手に出さない。 */
export function normalizeShowElapsedTime(value) {
    return value === 'on' ? 'on' : SHOW_ELAPSED_DEFAULT
}

/** 経過時間を出す設定か。 */
export function isElapsedTimeVisible(value) {
    return normalizeShowElapsedTime(value) === 'on'
}

/**
 * 表示/非表示を画面へ反映する。**両ページがこれを呼ぶ。**
 * @param {string} value 'on' | 'off'
 * @returns {boolean} 出す設定なら true
 */
export function applyShowElapsedTime(value) {
    const show = isElapsedTimeVisible(value)
    try {
        document.documentElement.classList.toggle(SHOW_ELAPSED_CLASS, show)
    } catch (e) { /* まだ document が無い等。次の呼び出しで付く */ }
    return show
}

/**
 * 経過時間の文字列。**分より細かくしない。**
 *
 * 🔴 秒まで出すと1秒ごとの書き換えが要る。サムネの隅の数字にその価値は無く、
 *    番組の数だけ毎秒 DOM を触ることになる。
 * ⚠️ **開始が未来の場合は空**（予約枠・時計のずれ）。「-3分」のような表示を出さない。
 *
 * @param {number} beginAtMs 放送開始（エポックms）
 * @param {number} now 現在時刻(ms)
 * @returns {string} 例 '23分' / '1時間23分'。出せなければ空文字
 */
export function formatElapsed(beginAtMs, now) {
    const begin = Number(beginAtMs)
    if (!Number.isFinite(begin) || begin <= 0) return ''
    const min = Math.floor((Number(now) - begin) / 60000)
    if (!Number.isFinite(min) || min < 0) return ''
    if (min < 60) return min + '分'
    return Math.floor(min / 60) + '時間' + (min % 60) + '分'
}
