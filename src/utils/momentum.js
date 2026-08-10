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
 * 🔴 **仮置きの初回値は、実測が1つ取れたら混ぜずに捨てる**（2026-08-10・doc/09 項目CL）。
 *
 *    初回は前回値が無いので `累計来場者 ÷ 経過分` で仮置きする。ところが推定同接は
 *    それに `min(W, 経過分)` を掛けるので**経過分どうしが打ち消し合い、
 *    推定同接＝累計来場者そのもの**になる。ニコ生の来場者は**入ってすぐ閉じた人も数える**ので、
 *    新着番組は実際の数倍で出る（実測の再現: 5分で 300 と表示、実際は約120）。
 *
 *    以前はこの仮置きを普通に混ぜていたため、**根拠の弱い値が20分居座って**
 *    「新着がいきなり上位に入り、じわじわ落ちる」動きになっていた。
 *    実測が1つでも取れたらそちらを信じる。落ち着くまで 約20分 → 約6分。
 *
 * ⚠️ **増分が 0 の周期では置き換えないこと。** 静かな番組が一発で 0 に落ち、
 *    順位が最下位へ吹き飛ぶ。0 の時は従来どおり均し、仮置きの印も残して次の機会を待つ。
 *
 * @param {object|null} prev 前回保存したレコード（`viewerRate` と `_fetchedAt` を持つ）
 * @param {object} next 今回の programInfo
 * @param {number} now 現在時刻(ms)
 * @returns {{rate:number, seeded:boolean}} 到着レート（1分あたり）と、それが仮置きかどうか
 */
export function nextViewerRate(prev, next, now) {
    if (!next) return { rate: 0, seeded: false }
    // notifybox 由来の最小レコード（来場者0）を前回値に使わない。理由は nextMomentum と同じ。
    if (prev && prev._source === 'notifybox') return { rate: initialViewerRate(next, now), seeded: true }
    const prevR = prev ? Number(prev.viewerRate) : NaN
    if (!Number.isFinite(prevR)) return { rate: initialViewerRate(next, now), seeded: true }

    const wasSeeded = !!(prev && prev.viewerRateSeeded)
    const dtMs = now - (Number(prev._fetchedAt) || 0)
    if (!(dtMs >= 1000)) return { rate: prevR, seeded: wasSeeded }

    // 累計来場者は減らないはずだが、取得元の揺れで減ることがある。負のレートは作らない。
    const dv = Math.max(0, (Number(next.viewers) || 0) - (Number(prev.viewers) || 0))
    const instant = dv / (dtMs / 60000)

    // 仮置きの値は捨てて、最初の実測でまるごと置き換える（上の説明を参照）。
    if (wasSeeded && instant > 0) return { rate: instant, seeded: false }

    const alpha = 1 - Math.exp(-dtMs / momentumTauMs)
    const v = prevR + (instant - prevR) * alpha
    return { rate: Number.isFinite(v) && v > 0 ? v : 0, seeded: wasSeeded }
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
/**
 * 直近 W 分に入ってきた人数。**推定同接の本体。**
 *
 * 【考え方】滞在時間が W 分なら、W 分以内に入った人はまだ居る。
 * つまり `累計来場(今) − 累計来場(W分前)` がそのまま同時視聴者数の推定になる。
 *
 * 【3つの場合】
 *   1. 放送開始から W 分たっていない … 全員まだ居る → **累計来場者そのもの**
 *   2. 履歴が W 分ぶん揃っている     … 窓の両端の差
 *   3. 履歴が足りない（途中から見始めた番組）
 *        … 持っているぶんの増分を W へ引き伸ばす。**2分ではなく持っている全期間**を使うので
 *          従来よりはるかにましで、周期を重ねるほど 2 に近づく。
 *
 * @returns {number|null} 数えられなければ null（呼び出し側が従来の計算へ落ちる）
 */
function arrivalsInWindow(info, now, W) {
    const cum = Number(info.viewers) || 0
    const beginAt = info.onAirTime && info.onAirTime.beginAt ? Date.parse(info.onAirTime.beginAt) : NaN
    const elapsedMin = Number.isFinite(beginAt) ? Math.max(0, (now - beginAt) / 60000) : NaN

    // 1. 放送が W より若い＝まだ誰も帰っていない
    if (Number.isFinite(elapsedMin) && elapsedMin <= W) return cum

    const samples = Array.isArray(info.viewerSamples) ? info.viewerSamples : null
    if (!samples || samples.length < 2) return null

    // 🔴 **窓をきっぱり切らないこと**（2026-08-10・利用者報告「同接が急に消えて、しばらくすると戻る」）。
    //    「W 分ちょうどで全員帰る」と扱うと、**直近 W 分に誰も入らなかった番組が 0 になる。**
    //    実際には W より前に入った人も残っているので、0 は明らかに嘘。
    //
    //    滞在時間を**平均 W の指数分布**とみなし、古い到着ほど軽く数える。
    //      推定同接 = Σ（その区間に入った人数 × exp(-経過 / W)）
    //    一定の流入が続く定常状態では **レート × W** に収束するので、目盛りの校正はそのまま効く。
    //    急に 0 へ落ちることも、窓の縁で段差ができることも無くなる。
    const sorted = samples
        .map((s) => [Number(s[0]), Number(s[1]) || 0])
        .filter((s) => Number.isFinite(s[0]))
        .sort((a, b) => a[0] - b[0])
    if (sorted.length >= 2) {
        let sum = 0
        for (let i = 1; i < sorted.length; i++) {
            const arrived = Math.max(0, sorted[i][1] - sorted[i - 1][1])
            if (!arrived) continue
            // 区間の真ん中に入ってきたとみなす
            const ageMin = (now - (sorted[i - 1][0] + sorted[i][0]) / 2) / 60000
            sum += arrived * Math.exp(-Math.max(0, ageMin) / W)
        }
        // 最後のサンプル以降に増えたぶん（まだ履歴へ入っていない最新の増分）
        sum += Math.max(0, cum - sorted[sorted.length - 1][1])

        // ⚠️ 履歴が W 分に満たない間は、古い到着を取りこぼしている。持っている期間で割り戻す。
        //    覆えていれば 1 倍（＝何もしない）。周期を重ねるほど 1 に近づく。
        const spanMin = (now - sorted[0][0]) / 60000
        const coverage = spanMin > 0 ? Math.min(1, spanMin / W) : 0
        if (coverage > 0 && coverage < 1) sum /= coverage
        if (sum > 0) return sum
    }

    // 3. 窓を覆えていない。持っている全期間で数えて W へ引き伸ばす。
    let oldest = null
    for (const s of samples) {
        const t = Number(s && s[0])
        if (!Number.isFinite(t)) continue
        if (!oldest || t < oldest[0]) oldest = [t, Number(s[1]) || 0]
    }
    if (!oldest) return null
    const spanMin = (now - oldest[0]) / 60000
    if (!(spanMin > 0)) return null
    const got = Math.max(0, cum - oldest[1])
    return got * (W / spanMin)
}

export function estimateConcurrentViewers(info, now, dwellMinutes) {
    if (!info) return 0

    // Kick は実測値。推定しない。
    if (info.service === 'kick') {
        const c = Number(info.concurrentViewersSmoothed)
        if (Number.isFinite(c) && c > 0) return c
        return Number(info.concurrentViewers) || 0
    }

    const W = Number(dwellMinutes) > 0 ? Number(dwellMinutes) : 1
    const cum = Number(info.viewers) || 0

    // 🔴 **「直近 W 分に入ってきた人数」を数える**（2026-08-10・doc/09 項目CO）。
    //    滞在時間が W なら、W 分以内に入った人はまだ居る。これがリトルの法則の素直な形。
    //
    //    以前は「直近2分の到着レート × W」だった。**2分の観測を20倍に引き伸ばす**ので:
    //      - 立ち上がりの山が過ぎた瞬間に、それ以前に入った人が計算から丸ごと消える
    //        （実測: 来場70人の番組が推定5人）
    //      - 一時的な集中がそのまま何十分も続く前提になる
    //        （実測: 累計200人の番組が推定800人）
    //      - 静かな数分に当たると半減する（実測: 2600 → 1800）
    //    どれも「短い観測を長い時間へ引き伸ばす」ことが原因で、窓で数えれば起きない。
    const windowed = arrivalsInWindow(info, now, W)
    if (windowed !== null) {
        return cum > 0 ? Math.min(windowed, cum) : windowed
    }

    // --- 履歴がまだ無い時だけ、従来の引き伸ばしで代用する ---
    // ⚠️ 初回の1周期だけここへ来る。次の取得からは上の窓が使える。
    const stored = Number(info.viewerRate)
    const rate = Number.isFinite(stored) ? stored : initialViewerRate(info, now)
    if (!(rate > 0)) return 0

    const beginAt = info.onAirTime && info.onAirTime.beginAt ? Date.parse(info.onAirTime.beginAt) : NaN
    // 開始時刻が不明なら定常とみなす（W をそのまま掛ける）。若い番組だと分からないので
    // 過大にならない方へ倒したいところだが、beginAt が無いのは異常系で数も少ない。
    const elapsedMin = Number.isFinite(beginAt) ? Math.max(0, (now - beginAt) / 60000) : W
    const v = rate * Math.min(W, elapsedMin)

    // 🔴 **累計来場者を超えないこと**（2026-08-10・利用者報告で発覚）。
    //    「今見ている人数」が「これまでに入ってきた人数」を超えるのはあり得ない。
    //    上限を入れていなかったため、**累計200人の番組で800人**と出ていた。
    //
    //    なぜ超えるのか: 到着レートは**直近数分**の値。そこへ滞在時間（最大45分）を掛けるので、
    //    一時的に人が集まった瞬間を捕まえると、その勢いが何十分も続いた前提の数になる。
    //    長い放送ほど「直近の勢い」と「これまでの実績」が乖離しやすい。
    //
    // ⚠️ これは恣意的な係数ではなく**動かせない事実**なので、設定では変えられないようにする。
    const cap = Number(info.viewers) || 0
    const capped = cap > 0 ? Math.min(v, cap) : v
    return Number.isFinite(capped) && capped > 0 ? capped : 0
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
