import {
    viewerSampleStaleGraceMs,
} from '../config/constants.js'

/**
 * **推定同時視聴者数の計算。ここが唯一の定義。**
 *
 * ⚠️ **ファイル名が実体と合っていない。** 元は「盛り上がり」（`momentum`）を計算する場所で、
 *    2026-08-04 に人気順の第1キーが推定同接へ移り、2026-08-13 に勢いの計算を撤去した
 *    （doc/09 項目CM-2）。改名は import 4箇所と doc に波及するので据え置いている。
 *
 * 【何を残し、何を消したか】
 * 消したのは**誰も読まない値を作り続けていた経路**（すべて DevTools 用の覗き窓だった）:
 *
 *   - `nextMomentum` / `initialMomentum` … 勢い。2026-08-04 に順位から外れた
 *   - `commentWeight` / `commentRatio` / `totalEngagement` … 弾幕補正。勢いの中でしか使わない
 *   - `nextViewerRate` / `initialViewerRate` … 到着レート。2026-08-11 に推定の式から外れた
 *
 * 🔴 **推定同接はこれらを1つも使っていない。** 材料は来場者の履歴（`viewerSamples`）だけで、
 *    書くのは `storage.upsertProgramInfos`（新旧が出会う唯一の場所）。
 *    ⚠️ 復活させるなら「誰が読むのか」を先に決めること。読み手のない値は、
 *       毎周期すべての番組ぶん計算して storage へ書き込む費用だけが残る。
 */

/**
 * 推定同接の本体。**場合分けの無い1本の式**（2026-08-11・doc/09 項目CQ）。
 *
 * 【考え方】滞在時間を**平均 W の指数分布**とみなし、これまでに来た人ひとりずつを
 * 「まだ居る確率 exp(-経過/W)」で数え上げる。
 *
 * ```
 *   推定同接 = Σ（その区間に来た人数 × exp(-経過 / W)）
 * ```
 *
 * 定常状態では **レート × W** に収束する（リトルの法則）。
 *
 * 🔴 **観測より前に来た人を必ず足すこと**（本項の要）。履歴に残っているのは
 *    「サイドバーが見ていた間」の到着だけで、それ以前の到着は1件も入っていない。
 *    旧実装はここを `span/W` の線形割り戻しで埋め合わせていたが、**減衰の形と違う**ので
 *    観測が短いほど過小になった。実測（毎分5人・W=17・真値85）:
 *
 *      観測2分→16 / 5分→48 / 17分→46 / 30分→63 / 60分→75 / 120分→77
 *
 *    つまり表示は**サイドバーがその番組を何分見ているかで5倍変わる**。W は全カードへ同じ
 *    倍率を掛けるだけなので、この偏りは目盛りでは直せない（校正しても合わない相手が残る）。
 *    さらに「累計500人でも新規が止まれば 0」＝画面に「—」が出る原因でもあった。
 *
 *    観測前のぶんは、その番組自身の平均レート（観測開始時の累計 ÷ そこまでの放送時間）で
 *    散らして同じように減衰させる。積分すると `レート × W × (e^(-a/W) − e^(-b/W))`。
 *
 * 🔴 **場合分けを戻さないこと。** 旧実装には「放送が W より若ければ累計そのもの」という枝が
 *    あり、経過が W をまたぐ瞬間に段差ができた（実測: 300 → 186）。1本の式なら跳ねない。
 *
 * ⚠️ 履歴が1点も無い周期もこの式で通る（観測前の項だけが残る）。専用の代替計算は要らない。
 *
 * @param {object} info programInfo
 * @param {number} now 現在時刻(ms)
 * @param {number} W 平均滞在時間（分）
 * @returns {number}
 */
function estimateFromArrivals(info, now, W) {
    const cum = Number(info.viewers) || 0
    const beginAt = info.onAirTime && info.onAirTime.beginAt ? Date.parse(info.onAirTime.beginAt) : NaN

    const samples = (Array.isArray(info.viewerSamples) ? info.viewerSamples : [])
        .map((s) => [Number(s && s[0]), Number(s && s[1]) || 0])
        .filter((s) => Number.isFinite(s[0]))
        .sort((a, b) => a[0] - b[0])

    // 🔴 **取得が止まっている間は時計を進めない**（doc/09 項目CQ）。
    //    この式は `now` が進むだけで全部の項が減る。通信が切れている間じゅう
    //    推定値が独りでに溶けていた（実測: 85 → 24 → 1 →「—」）。
    // ⚠️ 凍らせるのは**取得できていない時だけ**。取得が成功していて誰も来ないなら
    //    最新サンプルの時刻は進み続けるので、静かな番組はちゃんと減っていく。
    const lastT = samples.length ? samples[samples.length - 1][0] : NaN
    const at = Number.isFinite(lastT) ? Math.min(now, lastT + viewerSampleStaleGraceMs) : now

    let sum = 0
    for (let i = 1; i < samples.length; i++) {
        const arrived = Math.max(0, samples[i][1] - samples[i - 1][1])
        if (!arrived) continue
        // 区間の真ん中に入ってきたとみなす
        const ageMin = Math.max(0, (at - (samples[i - 1][0] + samples[i][0]) / 2) / 60000)
        sum += arrived * Math.exp(-ageMin / W)
    }
    // まだ履歴へ入っていない最新の増分（可動点が今を指していれば 0）
    if (samples.length) sum += Math.max(0, cum - samples[samples.length - 1][1])

    // --- 観測より前に来た人 ---
    const firstT = samples.length ? samples[0][0] : at
    const before = samples.length ? samples[0][1] : cum
    const beforeMin = Number.isFinite(beginAt) ? Math.max(0, (firstT - beginAt) / 60000) : 0
    if (before > 0 && beforeMin > 0) {
        const rate = before / beforeMin
        const a = Math.max(0, (at - firstT) / 60000)  // 観測開始からの経過
        const b = a + beforeMin                       // 放送開始からの経過
        sum += rate * W * (Math.exp(-a / W) - Math.exp(-b / W))
    }

    // 🔴 **累計来場者を超えないこと**（2026-08-10・利用者報告で発覚）。
    //    「今見ている人数」が「これまでに入ってきた人数」を超えるのはあり得ない。
    //    重みが1以下なので式の上では超えないが、**動かせない事実**なので明示して残す。
    // ⚠️ 恣意的な係数ではないので、設定では変えられないようにする。
    return cum > 0 ? Math.min(sum, cum) : sum
}

/**
 * **推定同時視聴者数。人気順の唯一の第1キー。**
 *
 * ⚠️ この説明は以前 `estimateFromArrivals` の手前に置かれており、**実物から1つ離れていた**
 *    （doc/09 項目CY で同じ形の迷子コメントを踏んでいる）。2026-08-13 にここへ移した。
 *
 * 【なぜこれなのか】
 * 人気順の本来の目的は「同時視聴者数で並べること」。ニコ生が同接を公表していないので
 * `momentum`（勢い）という代替指標を作っていたが、Kick 対応で同接が実測で手に入るように
 * なったため、本来の目的に戻した（2026-08-04 決定）。
 * これにより弾幕補正は順位計算の経路から外れ、2026-08-13 に計算ごと撤去した。
 *
 * 式そのものは `estimateFromArrivals` にある（場合分けの無い1本・doc/09 項目CQ）。
 * Kick は同接が実測で返るので、推定せずそのまま使う（呼び出し側で平滑化済みの値が入る）。
 *
 * 🔴 **W は「ニコ生と Kick の釣り合い」だけのつまみではない。**
 *    W を大きくすると古い到着ほど生き残るので、**長く続いている番組が、立ち上がったばかりの
 *    番組より上に来やすくなる**。ニコ生内部の順位も動く（2026-08-04 の設計時に見落とし、
 *    検証で反例が出た）。
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

    const W = Number(dwellMinutes) > 0 ? Number(dwellMinutes) : 1
    const v = estimateFromArrivals(info, now, W)
    return Number.isFinite(v) && v > 0 ? v : 0
}
