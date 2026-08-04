import {
    momentumTauMs,
    commentWeightHalfRatio,
    commentWeightSharpness,
    commentWeightViewerFloor,
    commentBaseWeight,
    initialMomentumMinWindowMin,
} from '../config/constants.js'

/**
 * 「盛り上がり」（人気順のスコア）の計算。**ここが唯一の定義**。
 *
 * 測るのは **直近の「1分あたり（来場者の増分 ＋ w × コメントの増分）」** を指数移動平均で均した値。
 * `w` は弾幕補正の重み（`commentWeight`）。
 *
 * 【なぜ差分なのか】
 * 旧スコアは `(来場者+1 + コメント+1) / 経過分` ＝「**開始からの平均**」だった。これだと
 *   - 3時間放送は1時間放送の3倍の総数がないと同じ点にならない（今どれだけ盛り上がっていても不利）
 *   - 序盤だけ人が来て今は静かな枠が、貯金だけで上位に残り続ける
 * という構造的な偏りが出る。差分なら「今どうか」だけを見るので、**新しい番組と長時間の番組が
 * 同じ土俵**に乗る（doc/09 項目AY）。
 *
 * 【なぜ平滑化が要るのか】
 * 2026-07-31 実測: 30秒ウィンドウでは**平均79%の番組が増分ゼロ**（ニコ生の統計が約60秒粒度でしか
 * 更新されないため、半分の周期は全滅する）。生の差分で並べると1周期あたり平均14.4位動く。
 * EMA(τ=3分) で 1.1位。**生の差分をそのまま順位に使わないこと。**
 *
 * 【単位】すべて「1分あたり」。来場者は 1:1、コメントは `commentWeight()` を掛けて足す
 * （2026-07-31 に 1:1 で決定 → 2026-08-01 に弾幕補正を追加。doc/09 項目BE）。
 */

/**
 * 「1人あたり何コメントか」。弾幕補正の唯一の入力。
 *
 * 累計どうしの比であって、レートではない。**ここを「Δコメント / Δ来場者」にしないこと**:
 * ニコ生の統計は約60秒粒度でしか動かず、30秒ウィンドウでは平均79%の番組が増分ゼロになる。
 * 分母がしょっちゅう 0 になって比が発散する。累計比なら分母が大きく、値もゆっくりしか
 * 動かないので、**重みの変動で順位が跳ねない**（EMA を入れたのと同じ理由）。
 *
 * また累計比は放送時間で系統的に伸びない。来場者が毎分 λ 人ずつ増え、同時視聴 A 人が
 * 毎分 q 件書くなら C/V = A·q/λ で時間 t が消える。**長時間放送が不利になる形ではない**
 * （項目AY で消した偏りを持ち込まない）。
 *
 * @param {object} info programInfo
 * @returns {number} r（0以上）
 */
export function commentRatio(info) {
    if (!info) return 0
    const c = Number(info.comments) || 0
    const v = Number(info.viewers) || 0
    if (!(c > 0)) return 0
    const r = c / (v + commentWeightViewerFloor)
    return Number.isFinite(r) && r > 0 ? r : 0
}

/**
 * コメントに掛ける重み（0 < w ≤ 基礎重み）。r だけで決まる、連続でなだらかな減少関数。
 *
 * **2つの係数の積**である: 弾幕っぽさに応じて差をつける「形」と、弾幕かどうかに関係なく
 * 来場者を重く見る「基礎重み」。役割が違うので両方要る（doc/09 項目BE-2）。
 *
 * 🔴 **これは「弾幕の検出」ではない。** 全番組が同じ式を通る。r が小さい番組では w がほぼ 1 に
 * なるので、式があってもなくても結果が変わらない。分岐も閾値も無いので、**境界の両側で挙動が
 * 跳ぶことがない**（doc/09 項目BE）。
 *
 * w は r→∞ で 0 に**漸近するだけ**で 0 にはならない。コメントが完全に無視される番組は作らない。
 *
 * @param {object} info programInfo
 * @returns {number} 重み（0 < w ≤ 1。計算不能なら 1 ＝ 補正しない）
 */
export function commentWeight(info) {
    const r = commentRatio(info)
    // 「形」の部分。r が大きいほど小さくなる（弾幕っぽさに応じた差はここでつく）。
    const shape = r > 0 ? 1 / (1 + Math.pow(r / commentWeightHalfRatio, commentWeightSharpness)) : 1
    // 基礎重み。**弾幕かどうかに関係なく**掛かる（来場者を重く見るための係数）。
    const w = commentBaseWeight * shape
    // 壊れた定数（0や負）を入れられた時に番組を消さない。基礎重みだけへ倒す。
    return Number.isFinite(w) && w > 0 && w <= 1 ? w : commentBaseWeight
}

/**
 * 来場者＋（重み付き）コメントの累計。同点時の第2キー、および初回レートの元になる量。
 * どちらも**減らない量**である（`watchCount` は同時視聴者数ではなく累計の来場者数。
 * 2026-07-31 に70件×6分で実測: 増えた26件・減った0件）。
 *
 * ⚠️ 弾幕補正が入ったので**整数とは限らない**。属性へ書くときは丸めること
 * （`sidebar.applyRankAttributes` が唯一の書き手）。
 * @param {object} info programInfo
 * @returns {number}
 */
export function totalEngagement(info) {
    if (!info) return 0
    return (Number(info.viewers) || 0) + commentWeight(info) * (Number(info.comments) || 0)
}

/**
 * 前回値が無い時の初期値＝「開始からの平均レート」。
 *
 * 若い番組ではこれが実質そのまま「直近のレート」なので、新番組が不当に沈まない。
 * 逆に長時間放送では平均に寄った値から始まるが、EMA が数周期で直近値へ寄せる。
 *
 * ⚠️ **分母には下限がある**（`initialMomentumMinWindowMin`）。入室ラッシュをそのまま
 * 「1分あたり」にすると新番組が初回で最上位に飛ぶため（doc/09 項目BG）。
 * **効くのは初回の1点だけ**で、以後は EMA が実データで動くのでこの関数は使われない。
 * @param {object} info programInfo
 * @param {number} now 現在時刻(ms)
 * @returns {number} 1分あたりの勢い
 */
export function initialMomentum(info, now) {
    if (!info) return 0
    const beginAt = info.onAirTime && info.onAirTime.beginAt ? Date.parse(info.onAirTime.beginAt) : NaN
    // 経過がこれ未満の番組は「最低ウィンドウぶん経った」として扱う。
    // 0除算を避けるためだけでなく、**入室ラッシュがそのまま勢いに化けるのを防ぐ**ため
    // （下限が1分だと、大型の新番組が初回でいきなり1位に入る。doc/09 項目BG）。
    const elapsed = Number.isFinite(beginAt) ? (now - beginAt) / 60000 : 0
    const minutes = Math.max(initialMomentumMinWindowMin, elapsed)
    const v = totalEngagement(info) / minutes
    return Number.isFinite(v) ? v : 0
}

/**
 * 来場者「だけ」の到着レートの初期値（1分あたり）。推定同接の材料。
 *
 * `initialMomentum` との違いはコメントを足さないことだけ。分母の下限も同じものを使う
 * （入室ラッシュがそのままレートに化けるのを防ぐ。項目BG）。
 * @param {object} info programInfo
 * @param {number} now 現在時刻(ms)
 * @returns {number} 1分あたりの来場者到着レート
 */
export function initialViewerRate(info, now) {
    if (!info) return 0
    const beginAt = info.onAirTime && info.onAirTime.beginAt ? Date.parse(info.onAirTime.beginAt) : NaN
    const elapsed = Number.isFinite(beginAt) ? (now - beginAt) / 60000 : 0
    const minutes = Math.max(initialMomentumMinWindowMin, elapsed)
    const v = (Number(info.viewers) || 0) / minutes
    return Number.isFinite(v) && v > 0 ? v : 0
}

/**
 * 来場者「だけ」の到着レートを更新する（指数移動平均）。
 *
 * 🔴 **`momentum` とは別に持つこと。** `momentum` は `Δ来場者 + w×Δコメント` で、
 *    弾幕補正が入っている。推定同接に使うのは**純粋な到着レート**でなければならない
 *    （コメントが混ざると人数の推定として意味を失う）。
 *
 * 平滑化の理由・時定数は `nextMomentum` と同じ。ニコ生の統計は約60秒粒度でしか動かず、
 * 生の差分をそのまま順位に使うと跳ねる。
 *
 * @param {object|null} prev 前回保存したレコード（`viewerRate` と `_fetchedAt` を持つ）
 * @param {object} next 今回の programInfo
 * @param {number} now 現在時刻(ms)
 * @returns {number} 更新後の到着レート（1分あたり）
 */
export function nextViewerRate(prev, next, now) {
    if (!next) return 0
    // notifybox 由来の最小レコード（来場者0）を前回値に使わない。理由は nextMomentum と同じ。
    if (prev && prev._source === 'notifybox') return initialViewerRate(next, now)
    const prevR = prev ? Number(prev.viewerRate) : NaN
    if (!Number.isFinite(prevR)) return initialViewerRate(next, now)

    const dtMs = now - (Number(prev._fetchedAt) || 0)
    if (!(dtMs >= 1000)) return prevR

    // 累計来場者は減らないはずだが、取得元の揺れで減ることがある。負のレートは作らない。
    const dv = Math.max(0, (Number(next.viewers) || 0) - (Number(prev.viewers) || 0))
    const instant = dv / (dtMs / 60000)
    const alpha = 1 - Math.exp(-dtMs / momentumTauMs)
    const v = prevR + (instant - prevR) * alpha
    return Number.isFinite(v) && v > 0 ? v : 0
}

/**
 * **推定同時視聴者数。人気順の唯一の第1キー。**
 *
 * 【なぜこれなのか】
 * 人気順の本来の目的は「同時視聴者数で並べること」。ニコ生が同接を公表していないので
 * `momentum`（勢い）という代替指標を作っていたが、Kick 対応で同接が実測で手に入るように
 * なったため、本来の目的に戻した（2026-08-04 決定）。
 * これにより弾幕補正（`commentWeight`）は順位計算の経路から外れている。
 *
 * 【式】リトルの法則。
 * ```
 *   推定同接 = 到着レート(人/分) × min(W, 放送開始からの経過分)
 * ```
 * `W` は平均滞在時間（分）。`min` は「開始から W 分たっていない番組は、まだ誰も帰っていない
 * とみなす」ことを表す（若い番組では実質 `累計来場者` がそのまま同接になる）。
 *
 * 🔴 **W が順位に効く範囲を取り違えないこと。**
 *    - 経過が W を**超えている**番組どうし → 一律に W を掛けるだけなので**順位は変わらない**
 *    - 経過が W **未満**の番組が混ざると → その番組の係数は W ではなく「経過分」なので、
 *      **W を大きくすると、続いている番組が若い番組より上に来やすくなる**
 *
 *    つまり W のつまみは2つのことを同時に動かす:
 *      (1) ニコ生と Kick の釣り合い
 *      (2) ニコ生内部の「立ち上がったばかりの番組 vs 続いている番組」の釣り合い
 *
 *    2026-08-04 の設計時に (2) を見落として「W はニコ生内部の順位を変えない」と説明していた。
 *    検証で反例が出た（若5分/毎分30人 と 古60分/毎分10人 は W=10 と W=20 で順位が入れ替わる）。
 *
 * Kick は同接が実測で返るので、推定せずそのまま使う（呼び出し側で平滑化済みの値が入る）。
 *
 * @param {object} info programInfo
 * @param {number} now 現在時刻(ms)
 * @param {number} dwellMinutes W（平均滞在時間・分）
 * @returns {number} 推定同時視聴者数
 */
export function estimateConcurrentViewers(info, now, dwellMinutes) {
    if (!info) return 0

    // Kick は実測値。推定しない。
    if (info.service === 'kick') {
        const c = Number(info.concurrentViewersSmoothed)
        if (Number.isFinite(c) && c > 0) return c
        return Number(info.concurrentViewers) || 0
    }

    const stored = Number(info.viewerRate)
    const rate = Number.isFinite(stored) ? stored : initialViewerRate(info, now)
    if (!(rate > 0)) return 0

    const W = Number(dwellMinutes) > 0 ? Number(dwellMinutes) : 1
    const beginAt = info.onAirTime && info.onAirTime.beginAt ? Date.parse(info.onAirTime.beginAt) : NaN
    // 開始時刻が不明なら定常とみなす（W をそのまま掛ける）。若い番組だと分からないので
    // 過大にならない方へ倒したいところだが、beginAt が無いのは異常系で数も少ない。
    const elapsedMin = Number.isFinite(beginAt) ? Math.max(0, (now - beginAt) / 60000) : W
    const v = rate * Math.min(W, elapsedMin)
    return Number.isFinite(v) && v > 0 ? v : 0
}

/**
 * 新しい取得値で勢いを更新する（指数移動平均）。
 *
 * ⚠️ **2026-08-04 以降、この値は順位計算に使われていない。**推定同接
 * （`estimateConcurrentViewers`）へ移行した。弾幕補正の実効値を実機で観察するための
 * 覗き窓（`data-total` / `data-comment-weight`）としてのみ残っている。
 *
 * @param {object|null} prev 前回保存したレコード（`momentum` と `_fetchedAt` を持つ）
 * @param {object} next 今回の programInfo
 * @param {number} now 現在時刻(ms)
 * @returns {number} 更新後の勢い（1分あたり）
 */
export function nextMomentum(prev, next, now) {
    if (!next) return 0
    // notifybox 由来の最小レコード（来場者0・コメント0）を「前回値」に使わない。
    // 新着を早く見つけるために storage へ蒔いた種であって、実測値ではない。差分を取ると
    // 0→実数の丸ごとが「急増」に化けて、出てきたばかりの番組が不当に1位へ飛ぶ（doc/09 項目AZ）。
    if (prev && prev._source === 'notifybox') return initialMomentum(next, now)
    const prevM = prev ? Number(prev.momentum) : NaN
    if (!Number.isFinite(prevM)) return initialMomentum(next, now)

    const dtMs = now - (Number(prev._fetchedAt) || 0)
    // 時計の巻き戻し・同一ミリ秒の二重書き込み等。極小の Δt で割ると勢いが爆発するので据え置く。
    if (!(dtMs >= 1000)) return prevM

    // 累計なので減らないはずだが、取得元の揺れで減ることがある。**負の勢いは作らない。**
    //
    // 🔴 **来場者とコメントを別々にクランプしている**（合計にではなく）。コメントへ重みを掛ける以上
    //    分けるしかないが、これは旧実装と完全一致ではない: 片方だけが減った周期
    //    （例 Δ来場者=-5・Δコメント=+10）で旧は 5、新は 10 になる。**分けたほうが正しい**
    //    ── 来場者側の揺れが実在するコメントを食い潰す理由が無い（doc/09 項目BE）。
    //    これ以外の周期では、w=1 のとき旧実装と一致する。
    const dv = Math.max(0, (Number(next.viewers) || 0) - (Number(prev.viewers) || 0))
    const dc = Math.max(0, (Number(next.comments) || 0) - (Number(prev.comments) || 0))
    // 重みは「今の」比で決める。放送の性格は累計に表れるので、prev ではなく next を見る。
    const delta = dv + commentWeight(next) * dc
    const instant = delta / (dtMs / 60000)
    // 時間ベースの係数。更新間隔が 30秒でも 180秒でも、同じ実時間で同じだけ寄る。
    // （固定の α にすると、間隔を変えた瞬間に手触りが変わってしまう）
    const alpha = 1 - Math.exp(-dtMs / momentumTauMs)
    const v = prevM + (instant - prevM) * alpha
    return Number.isFinite(v) ? v : 0
}
