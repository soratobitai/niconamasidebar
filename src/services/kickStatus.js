/**
 * Kick の「今そのチャンネルが配信中か」を**本人に直接聞く**。
 *
 * 🔴 **「フォロー中一覧から消えた＝終了」にしないこと。**
 *    ニコ生側は 2026-08-01 にそれで事故を起こし（notifybox が5件しか返さず、放送中16件が
 *    「終了した」と誤判定されてカードが消えた）、**不在から終了を導くのをやめた**（doc/09 項目BF-2）。
 *    Kick でも同じで、そもそもフォローしていないチャンネルは最初から一覧に居ない。
 *
 * 🔴 **Kick の DOM を見ないこと。** この拡張は kick.com の DOM 構造・クラス名に一切依存しない
 *    方針で作ってある。向こうの実装が変わった時に無言で壊れる。
 *
 * 使うのは公開API `/api/v2/channels/<slug>`。認証不要で、アイコン補完でも使っている。
 * 2026-08-07 に実機で両方の状態を確認済み:
 *
 *     配信中     livestream = {id, slug, ..., is_live, viewer_count, ...}
 *     配信なし   livestream = null
 *
 * 応答は 64ms 〜 1117ms（実測）とばらつく。**重ねて投げないこと。**
 */

// 応答の解釈。**「分からない」を必ず区別すること。**
export const KICK_LIVE = 'live'
export const KICK_OFFLINE = 'offline'
export const KICK_UNKNOWN = 'unknown'

/**
 * チャンネルの配信状態を1回聞く。
 *
 * 🔴 **答えが得られなければ `KICK_UNKNOWN`。`KICK_OFFLINE` に倒さないこと。**
 *    通信エラーや 403 を「終了した」と読むと、**回線が不安定なだけで勝手にページを移る**。
 *    ニコ生側の「答えが得られなければ消さない」と同じ規則。
 *
 * @param {string} slug
 * @returns {Promise<'live'|'offline'|'unknown'>}
 */
export async function fetchKickChannelState(slug) {
    if (!slug) return KICK_UNKNOWN
    try {
        const res = await fetch('https://kick.com/api/v2/channels/' + encodeURIComponent(slug), {
            headers: { Accept: 'application/json' },
            credentials: 'omit', // 公開APIなので認証は不要
        })
        if (!res.ok) return KICK_UNKNOWN
        const ch = await res.json()
        if (!ch || typeof ch !== 'object') return KICK_UNKNOWN
        // ⚠️ キーそのものが無い＝仕様が変わった。**「配信していない」ではない。**
        if (!('livestream' in ch)) return KICK_UNKNOWN
        const ls = ch.livestream
        if (ls === null) return KICK_OFFLINE
        if (!ls || typeof ls !== 'object') return KICK_UNKNOWN
        // オブジェクトがあっても is_live が明示的に false なら配信していない。
        return ls.is_live === false ? KICK_OFFLINE : KICK_LIVE
    } catch (_e) {
        return KICK_UNKNOWN
    }
}

/**
 * 見ているチャンネルの配信終了を見張る。`services/status.js` の `observeProgramEnd` と同じ形。
 *
 * ⚠️ **ニコ生と違い MutationObserver は使えない**（DOM に依存しない方針）。一定間隔で聞きに行く。
 *    そのぶん検知は最大で1周期ぶん遅れるが、移動まで10秒のカウントダウンがあるので体感は変わらない。
 *
 * 🔴 **重ねて投げないこと。** 応答が1秒を超えることがあり、間隔を詰めると取得が積み上がる。
 * 🔴 **`visibilitychange` などのリスナーを足さないこと。** この拡張はページ側のイベントを
 *    購読しない方針で、verify:loop の D6 が機械で見ている。裏タブでは Chrome が
 *    タイマーを間引くので、それに任せる。
 *
 * 🔴 **「開いた時点で配信していない」だけでは動かないこと。**
 *    自分で開いたチャンネルが配信前／配信後だった時に、**見始めた瞬間に連れて行かれる。**
 *    動いてよいのは次の2つだけ:
 *      1. **配信中を一度見たあとに**配信なしへ変わった（＝目の前で終わった）
 *      2. 自動移動で**飛んできた先**が配信していなかった（＝続けて次を探す）
 *    ニコ生側の「タイムシフトを自分で開いた時は動かさない」と同じ規則（doc/09 項目BI-2）。
 *
 * @param {() => string} getSlug 今見ているチャンネル。チャンネルページでなければ `''` を返すこと
 * @param {(firstSinceArmed: boolean) => void} onEnded
 * @param {{intervalMs?: number, arrivedByAutoNext?: boolean, graceMs?: number}} [opts]
 *   `arrivedByAutoNext` … 自動移動で飛んできた先なら true。上の 2. を許す
 * @returns {() => void} 監視を止める
 */
export function observeKickProgramEnd(getSlug, onEnded, opts = {}) {
    if (typeof getSlug !== 'function' || typeof onEnded !== 'function') return () => {}
    const intervalMs = opts.intervalMs
    // レイドに先を譲る猶予。0 を渡せば待たない（検査で待ちを飛ばすため）。
    const graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : 15000
    const arrivedByAutoNext = !!opts.arrivedByAutoNext

    let stopped = false
    let inFlight = false
    let lastFiredAt = 0
    // 一度でも「配信中」と確認できたか。これが立っていない間の「配信なし」は、
    // 終わったのではなく**最初から配信していなかった**可能性がある。
    let sawLive = false
    // 「配信なし」と分かった時刻。レイドに先を譲るための猶予に使う。
    let offlineSince = 0

    const tick = async () => {
        if (stopped || inFlight) return
        const slug = getSlug()
        if (!slug) return
        inFlight = true
        try {
            const state = await fetchKickChannelState(slug)
            if (stopped) return
            // 🔴 分からない時は何もしない。**再武装もしない**（次の周期でまた聞く）。
            if (state === KICK_UNKNOWN) return
            if (state === KICK_LIVE) {
                sawLive = true
                offlineSince = 0
                // 配信中に戻った／続いている。次の終了で即発火できるよう再武装する。
                lastFiredAt = 0
                return
            }
            // ここから下は「配信していないと確認できた」場合だけ。
            // 🔴 目の前で終わったのでも、飛んできた先でもないなら動かない（上の説明を参照）。
            if (!sawLive && !arrivedByAutoNext) return

            // 🔴 **目の前で終わった時は、レイドに先を譲る。**
            //    Kick のレイドは配信者が決めた移動先へリスナーをまとめて送る機能で、
            //    向こうもカウントダウンを出す。こちらが先に決着すると**その移動先を奪う。**
            //    レイドが起きればこの後の周期で「別のチャンネルが配信中」に変わるので、
            //    こちらは何もせず黙ることになる。
            // ⚠️ 飛んできた先が最初から配信なしの時は待たない（レイドが飛んでくる余地が無い）。
            // ⚠️ 待つのは**時間**であって回数ではない。`offlineSince` を立てた回で必ず return する
            //    書き方にすると、猶予 0 でも1周期ぶん待つことになる（定数の意味と食い違う）。
            if (sawLive) {
                if (!offlineSince) offlineSince = Date.now()
                if (Date.now() - offlineSince < graceMs) return
            }
            // ⚠️ ニコ生側と同じく、**最初の1回かどうか**を呼び出し側へ伝える。
            //    受け手はこれを見てリストの取り直しを1回に絞る（doc/09 項目BI-3）。
            const firstSinceArmed = lastFiredAt === 0
            lastFiredAt = Date.now()
            onEnded(firstSinceArmed)
        } finally {
            inFlight = false
        }
    }

    // 開いた直後にも1回聞く（自動移動で飛んできた先が既に終わっていた場合のため）。
    tick()
    const timer = setInterval(tick, Math.max(5000, Number(intervalMs) || 15000))

    return () => {
        stopped = true
        try { clearInterval(timer) } catch (_e) {}
    }
}
