import { momentumTauMs } from '../config/constants.js'

/**
 * 「盛り上がり」（人気順のスコア）の計算。**ここが唯一の定義**。
 *
 * 測るのは **直近の「1分あたり（来場者の増分 ＋ コメントの増分）」** を指数移動平均で均した値。
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
 * 【単位】すべて「1分あたり」。来場者とコメントは 1:1 で足す（利用者決定・2026-07-31）。
 */

/**
 * 来場者＋コメントの累計（同点時の第2キー、および差分の元になる量）。
 * どちらも**減らない量**である（`watchCount` は同時視聴者数ではなく累計の来場者数。
 * 2026-07-31 に70件×6分で実測: 増えた26件・減った0件）。
 * @param {object} info programInfo
 * @returns {number}
 */
export function totalEngagement(info) {
    if (!info) return 0
    return (Number(info.viewers) || 0) + (Number(info.comments) || 0)
}

/**
 * 前回値が無い時の初期値＝「開始からの平均レート」。
 *
 * 若い番組ではこれが実質そのまま「直近のレート」なので、新番組が不当に沈まない。
 * 逆に長時間放送では平均に寄った値から始まるが、EMA が数周期で直近値へ寄せる。
 * @param {object} info programInfo
 * @param {number} now 現在時刻(ms)
 * @returns {number} 1分あたりの勢い
 */
export function initialMomentum(info, now) {
    if (!info) return 0
    const beginAt = info.onAirTime && info.onAirTime.beginAt ? Date.parse(info.onAirTime.beginAt) : NaN
    // 経過が1分未満の番組は「1分」として扱う（0除算と、開始直後の極端な値を避ける）
    const minutes = Number.isFinite(beginAt) ? Math.max(1, (now - beginAt) / 60000) : 1
    const v = totalEngagement(info) / minutes
    return Number.isFinite(v) ? v : 0
}

/**
 * 新しい取得値で勢いを更新する（指数移動平均）。
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
    const delta = Math.max(0, totalEngagement(next) - totalEngagement(prev))
    const instant = delta / (dtMs / 60000)
    // 時間ベースの係数。更新間隔が 30秒でも 180秒でも、同じ実時間で同じだけ寄る。
    // （固定の α にすると、間隔を変えた瞬間に手触りが変わってしまう）
    const alpha = 1 - Math.exp(-dtMs / momentumTauMs)
    const v = prevM + (instant - prevM) * alpha
    return Number.isFinite(v) ? v : 0
}
