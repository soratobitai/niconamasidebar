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
 * - 新着順の第2キーは lv番号の降順。ただし `data-api-index` は
 *   `livePrograms.forEach((data, apiIndex) => ...)` の添字なのでカード間で常に一意であり、
 *   **この tie-break は実際には効いていない**（属性が欠けたカードが混ざった時の保険）。
 *
 * 【2026-07-31 に変えたこと】
 * 人気順に第2キー（累計 `data-total` の降順）を足した。スコアが「開始からの平均」から
 * 「直近の勢い」へ変わり、**静かな番組が軒並み 0 で同点になる**ため（利用者決定・doc/09 項目AY）。
 * それ以前は tie-break 無しで、同点は現状順が保たれていた。
 *
 * 【2026-08-04 に変えたこと】
 * 第1キーが「勢い」から**推定同時視聴者数**になった（`estimateConcurrentViewers`）。
 * 人気順の本来の目的が同接での比較であり、Kick 対応で同接が実測で手に入ったため。
 * これに伴い第2キーを `data-total`（累計エンゲージメント）から `data-begin-at`（放送開始が
 * 新しい順）へ差し替えた。**`data-total` はコメントを含むので Kick では常に 0 になり、
 * 混在時に Kick が必ず下へ沈む**。開始時刻なら両サービスが同じ意味で持っている。
 */

/**
 * 人気順（盛り上がり `active-point` の降順 → 同点なら累計 `data-total` の降順）。
 *
 * ⚠️ `parseFloat` が NaN を返す経路がある（属性が無いカード）。NaN との比較は常に false なので
 * `if (d)` は偽になり、第2キーへ落ちる。第2キーも欠ければ 0 差＝`Array.prototype.sort` の
 * 安定性で現状順が保たれる（従来の「同点は動かさない」挙動をここで維持している）。
 */
export function compareByActivePoint(a, b) {
    const d = parseFloat(b.getAttribute('active-point')) - parseFloat(a.getAttribute('active-point'))
    if (d) return d
    return (parseFloat(b.getAttribute('data-begin-at')) || 0) - (parseFloat(a.getAttribute('data-begin-at')) || 0)
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
