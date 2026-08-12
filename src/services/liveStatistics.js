import { liveStatisticsApi, liveStatisticsMaxConcurrent } from '../config/constants.js'

/**
 * 【来場者数を早く・細かく取る】`live2.nicovideo.jp/watch/{lv}/statistics`（doc/09 項目CT）。
 *
 * 【なぜ要るか】フォローAPI（一覧）の `statistics.watchCount` は遅い。2026-08-12 の実測:
 *
 *   経過  74s  live2=11  一覧=1     ← 一覧は 30〜45秒 遅れている
 *         89s  live2=13  一覧=1
 *        104s  live2=14  一覧=11
 *        119s  live2=16  一覧=11
 *        149s  live2=18  一覧=11
 *        164s  live2=20  一覧=16
 *        180s  live2=21  一覧=16
 *
 * 🔴 **遅れより「粒度」のほうが効く。** 一覧は約60秒に1回しか動かない（階段状）。
 *    推定同接は**来場者の増分**から計算しているので、60秒粒度だと増分ゼロの周期が大量に出る
 *    （2026-07-31 実測: 30秒窓の79%がゼロ）。live2 は15秒ごとに動くので材料そのものが細かくなる。
 *    ついでに新着番組の「—」も早く消える。
 *
 * 【制約】
 * ⚠️ **要ログイン**（未ログインは 401）。フォローAPIと同じなので新しい制約ではない。
 * 🔴 **CORS は `https://live.nicovideo.jp` オリジンにしか開いていない**（2026-08-12 実測。
 *    プリフライト200・`allow-credentials: true`）。**kick.com のページからは直接叩けない**ので、
 *    あちらは SW 経由（`nico:statistics`）にしてある。取り方だけが違い、混ぜ方はここに1つ。
 * ⚠️ `liveCycle` は入っていない。**終了確認の置き換えには使えない**（項目BF-2 は詳細APIのまま）。
 */

/** `live2` に聞くURL。⚠️ `static/sw.js` にも同じURLの組み立てがある（バンドル外なので共有できない）。 */
export function liveStatisticsUrl(id) {
    return `${liveStatisticsApi}/${String(id).replace(/^lv/, 'lv')}/statistics`
}

/**
 * 同時に走らせる数を絞って順に処理する。
 * ⚠️ **全番組ぶんを一斉に投げないこと。** フォロー数が多い利用者では70件級になる。
 */
async function mapWithLimit(items, limit, worker) {
    const out = new Map()
    let next = 0
    const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        for (let i = next++; i < items.length; i = next++) {
            const id = items[i]
            const got = await worker(id)
            if (got) out.set(id, got)
        }
    })
    await Promise.all(runners)
    return out
}

/**
 * ニコ生ページ（live.nicovideo.jp）から直接聞く。
 *
 * 🔴 **ホスト権限は要らない。** live2 が `live.nicovideo.jp` オリジンへ CORS を開いているので、
 *    コンテンツスクリプトからの普通の CORS リクエストとして通る。
 * @param {string[]} ids `lv…` の配列
 * @returns {Promise<Map<string, {watchCount:number, commentCount:number}>>}
 */
export async function fetchLiveStatisticsDirect(ids) {
    return mapWithLimit(ids, liveStatisticsMaxConcurrent, async (id) => {
        try {
            const res = await fetch(liveStatisticsUrl(id), { credentials: 'include', cache: 'no-store' })
            if (!res.ok) return null
            const json = await res.json()
            return normalizeLiveStatistics(json)
        } catch (e) {
            // 1件の失敗で全体を落とさない。取れなかった番組は一覧APIの値のまま。
            return null
        }
    })
}

/** 応答から数字だけ取り出す。**形が違えば null**（壊れた値で上書きしない）。 */
export function normalizeLiveStatistics(json) {
    const d = json && json.data
    if (!d) return null
    const watchCount = Number(d.watchCount)
    const commentCount = Number(d.commentCount)
    if (!Number.isFinite(watchCount) || watchCount < 0) return null
    return { watchCount, commentCount: Number.isFinite(commentCount) && commentCount >= 0 ? commentCount : 0 }
}

/**
 * フォローAPIの**生の**応答へ、live2 の新しい数字を上書きする。**破壊的。**
 *
 * 🔴 **小さくしないこと（`Math.max` で入れる）。** 来場者数もコメント数も累計＝減らない量で、
 *    live2 のほうが新しいので普通は live2 が大きい。それでも max にしてあるのは、
 *    取得に失敗した番組と成功した番組が混ざる周期に、**値が行ったり来たりしない**ようにするため。
 *    下がると `nextViewerRate` / `appendViewerSample` が「誰も来ていない」と読む。
 * ⚠️ **上書きするのは `statistics` だけ。** 他の欄（サムネ・配信者・beginAt）は一覧APIが正。
 *
 * @param {Array<object>} programs フォローAPIの生データ（`statistics.watchCount` を持つ形）
 * @param {(ids: string[]) => Promise<Map<string, {watchCount:number, commentCount:number}>|null>} getStats
 * @returns {Promise<number>} 実際に上書きできた件数（診断・検査用）
 */
export async function applyLiveStatistics(programs, getStats) {
    if (!Array.isArray(programs) || !programs.length || typeof getStats !== 'function') return 0
    const ids = programs.map((p) => (p && p.id ? String(p.id) : '')).filter((id) => /^lv\d+$/.test(id))
    if (!ids.length) return 0

    let stats
    try {
        stats = await getStats(ids)
    } catch (e) {
        return 0   // 取れなければ一覧APIの値のまま。**描画は止めない。**
    }
    if (!stats || typeof stats.get !== 'function') return 0

    let applied = 0
    for (const p of programs) {
        const id = p && p.id ? String(p.id) : ''
        const s = id ? stats.get(id) : null
        if (!s) continue
        const cur = p.statistics && typeof p.statistics === 'object' ? p.statistics : (p.statistics = {})
        const w = Math.max(Number(cur.watchCount) || 0, s.watchCount)
        const c = Math.max(Number(cur.commentCount) || 0, s.commentCount)
        if (w !== (Number(cur.watchCount) || 0) || c !== (Number(cur.commentCount) || 0)) applied++
        cur.watchCount = w
        cur.commentCount = c
    }
    return applied
}
