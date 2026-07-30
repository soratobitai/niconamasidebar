/**
 * 番組カードの並び順の比較器。**ここが唯一の定義**。
 *
 * 【なぜ切り出したか】
 * 同じルールが3箇所に別々に書かれていた:
 *   (a) utils/sorting.js        … 新着順で実際に並べ替える
 *   (b) render/sidebar.js       … 人気順で実際に並べ替える
 *   (c) UpdateManager._sortOrderChanged … (a)(b) の両方を再実装して「並べ替えが要るか」を判定する
 *
 * (c) が (a)(b) と食い違うと、**判定は「並べ替えが要る」と言い続けるのに、並べ替えても
 * その順序にならない**。すると毎周期 `replaceChildren` が走り、FLIP が本気で動くようになった今は
 * **ユーザーが何もしていないのに全カードが毎回スライドする**。
 * 逆向きに食い違えば、並べ替えが必要なのに永久にスキップされる。
 *
 * 【変えてはいけないこと】
 * 現在の tie-break の挙動をそのまま移した。「改善」しないこと（見た目が変わる）。
 * - 人気順には tie-break が無い。`parseFloat` が NaN を返す経路もある（属性が無いカード）。
 *   NaN との比較は常に false なので `Array.prototype.sort` の安定性により現状順が保たれる。
 *   ここに tie-break を足すと、同点番組の並びが変わる。
 * - 新着順の第2キーは lv番号の降順。ただし `data-api-index` は
 *   `livePrograms.forEach((data, apiIndex) => ...)` の添字なのでカード間で常に一意であり、
 *   **この tie-break は実際には効いていない**（属性が欠けたカードが混ざった時の保険）。
 */

/** 人気順（active-point 降順）。tie-break 無し＝同点は現状順を保つ。 */
export function compareByActivePoint(a, b) {
    return parseFloat(b.getAttribute('active-point')) - parseFloat(a.getAttribute('active-point'))
}

/**
 * 新着順（data-api-index 昇順 ＝ 放送開始が新しい順）。
 * この属性は updateSidebar が beginAt 降順で並べた位置を書き込んだもの。
 * ※lv番号は予約/作成順で放送開始順とズレる（予約枠など）ため、第1キーには使わない。
 */
export function compareByApiIndex(a, b) {
    const ia = a.dataset.apiIndex !== undefined ? (parseInt(a.dataset.apiIndex, 10) || 0) : Infinity
    const ib = b.dataset.apiIndex !== undefined ? (parseInt(b.dataset.apiIndex, 10) || 0) : Infinity
    if (ia !== ib) return ia - ib
    return (parseInt(b.id, 10) || 0) - (parseInt(a.id, 10) || 0)
}

/**
 * 設定値から比較器を選ぶ。
 * @param {string} sortType - 'active' なら人気順、それ以外は新着順（既定）
 */
export function orderComparator(sortType) {
    return sortType === 'active' ? compareByActivePoint : compareByApiIndex
}
