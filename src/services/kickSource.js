/**
 * Kick 取得元 — Service Worker から生 JSON を受け取り、内部 programInfo 形へ写像する。
 *
 * 【取得は SW が行う】
 * 認証は `Authorization: Bearer <session_token cookie>` で、cookie の値を読む必要がある。
 * `chrome.cookies` はコンテンツスクリプトから呼べないので、取得は `static/sw.js` の担当。
 * ここは「頼んで、受け取って、形を変える」だけ。
 *
 * 【権限が無いのは正常】
 * Kick 連携は optional permission。既定では許可されていない。
 * `reason:'no-permission'` は**エラーではなく既定の状態**なので、警告もログも出さない。
 */

import { handleError } from '../utils/error.js'
import { kickConcurrentTauMs , kickIconRetryMs } from '../config/constants.js'

/** Kick の番組カードにだけ付く DOM id の接頭辞。 */
export const KICK_ID_PREFIX = 'k'

/**
 * Kick の livestream 1件を内部 programInfo 形へ写像する。
 *
 * 🔴 **`viewers` に入れないこと。** このコードベースの `viewers` はニコ生の
 *    **累計来場者数**（減らない量）で、`momentum.js` はその差分を「勢い」として扱う。
 *    Kick の `viewer_count` は**同時視聴者数**なので減る。ここへ入れると
 *    `Math.max(0, Δ)` に潰されて意味の無い値になる。
 *    同接は `concurrentViewers` という別のフィールドに入れ、
 *    順位付けの統一（推定同接）は別途行う。
 *
 * ⚠️ `start_time` は **UTC** だがオフセットが付いていない（`"2026-08-04 01:08:08"`）。
 *    そのまま `Date.parse` するとローカル時刻と解釈されて **9時間ずれる**（2026-08-04 実測）。
 *    `T` に置き換えて `Z` を付けること。
 *
 * @param {object} s `/api/v1/user/livestreams` の1要素
 * @returns {object|null} 内部 programInfo（不正な行は null）
 */
export function mapKickLivestreamToInfo(s) {
    if (!s || s.id == null) return null

    const channel = s.channel || {}
    const user = channel.user || {}
    const slug = channel.slug || ''
    if (!slug) return null // 視聴URLを作れない番組は出せない

    return {
        // DOM id にそのまま使われる。記号を入れないこと（`#id` セレクタが壊れる）。
        // ニコ生側は「lv を外した数値」なので、接頭辞 k を付けるだけで衝突しない。
        id: KICK_ID_PREFIX + String(s.id),
        service: 'kick',
        title: s.session_title || 'タイトル不明',
        // 🔴 カード側で URL を組み立てさせない。ニコ生は `watchPageBaseUrl + 'lv' + id` を
        //    直接組んでいるが、その規約は Kick には通じない。programInfo が完成した URL を持つ。
        watchUrl: 'https://kick.com/' + slug,
        providerType: 'user',
        contentOwner: {
            id: slug,
            name: user.username || slug,
            // ⚠️ **`/api/v1/user/livestreams` はここを返さない。**
            //    あちらの `channel` は軽量版で、`channel.user` にアイコンが入っていない
            //    （2026-08-04 実測）。空のままにしておき、`fillMissingIcons` が
            //    公開API `/api/v2/channels/<slug>` から補完してキャッシュする。
            //    将来 livestreams 側が返すようになれば、その値がそのまま使われる。
            icon: user.profile_pic || '',
        },
        // 🔴 **`?versionId=` を外す。**
        //    付いたままだと「その版」を指すので、同じURLを何度取り直しても同じ絵になり、
        //    新しい絵はリストを取り直さないと手に入らない（＝鮮度がリスト間隔に縛られる）。
        //    素のURLは最新版を返す（2026-08-04 実測: 1280x720 が取得できた）。
        //    これでニコ生と同じ「同じURLをキャッシュバスター付きで叩く」方式に乗せられる。
        thumbnailUrl: stripQuery((s.thumbnail && s.thumbnail.src) || ''),
        // srcset を保持しておく。解像度を選べるのは Kick 側の利点で、後で使う。
        thumbnailSrcset: (s.thumbnail && s.thumbnail.srcset) || '',
        isMemberOnly: false,
        viewers: 0,      // ニコ生の「累計来場者」に相当する値を Kick は返さない。0 のまま。
        comments: 0,     // Kick の API はコメント数を返さない。
        concurrentViewers: Number(s.viewer_count) || 0,
        showViewerCount: s.show_view_count !== false,
        categoryName: (Array.isArray(s.categories) && s.categories[0] && s.categories[0].name) || '',
        onAirTime: { beginAt: parseKickTimeToIso(s.start_time || s.created_at) },
        _source: 'kick',
    }
}

/**
 * Kick の時刻文字列（UTC・オフセット無し）を ISO 文字列にする。
 * `"2026-08-04 01:08:08"` → `"2026-08-04T01:08:08.000Z"`
 * @param {string} raw
 * @returns {string|null}
 */
/** クエリを落とす。`?versionId=` を外して「最新版」を指すURLにするために使う。 */
function stripQuery(url) {
    if (typeof url !== 'string') return ''
    const q = url.indexOf('?')
    return q === -1 ? url : url.slice(0, q)
}

export function parseKickTimeToIso(raw) {
    if (!raw || typeof raw !== 'string') return null
    const ms = Date.parse(raw.replace(' ', 'T') + 'Z')
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/**
 * Service Worker に取得を依頼する。
 *
 * **throw しない。**戻り値は必ず `{ ok, programs, reason }` の形。
 * 拡張が無効化された後もコンテンツスクリプトは動き続けるので、`sendMessage` の例外も
 * ここで受け止める（doc/09・拡張の無効化検知）。
 *
 * @returns {Promise<{ok:true, programs:Array, partial?:boolean}|{ok:false, reason:string, status?:number}>}
 */
export async function fetchKickPrograms() {
    let res
    try {
        res = await chrome.runtime.sendMessage({ type: 'kick:fetch' })
    } catch (e) {
        // 拡張が無効化された／SW が応答しない。呼び出し側は Kick を出さないだけでよい。
        return { ok: false, reason: 'unavailable' }
    }

    if (!res || res.ok !== true) {
        return { ok: false, reason: (res && res.reason) || 'unknown', status: res && res.status }
    }

    const now = Date.now()
    const programs = []
    const alive = new Set()
    for (const s of res.streams || []) {
        try {
            const info = mapKickLivestreamToInfo(s)
            if (!info) continue
            info.concurrentViewersSmoothed = smoothConcurrent(info.id, info.concurrentViewers, now)
            alive.add(info.id)
            programs.push(info)
        } catch (e) {
            // 1件の不正データでリスト全体を落とさない（ニコ生側のカード生成と同じ方針）。
            handleError(e, { function: 'mapKickLivestreamToInfo', id: s && s.id })
        }
    }
    pruneSmoothing(alive)
    await fillMissingIcons(programs)

    return { ok: true, programs, partial: !!res.partial }
}

/**
 * その失敗は「Kick にログインし直せば直るもの」か。**判定はここだけに書く。**
 *
 * 🔴 **一時的な失敗で真を返さないこと。** `network` / `http` / `rate-limited` / `parse` は
 *    通信が揺れただけで起こる。ここに入れると、取得のたびに案内が点いたり消えたりする。
 *
 * 🔴 **`no-permission` は失敗ではない。** Kick 連携は optional permission で、
 *    既定は許可されていない状態。連携していない利用者に「ログインが切れています」と
 *    出すのは誤報になる。
 *
 * 🔴 **`unavailable` も違う。** あれは拡張が無効化された（SW と話せない）状態で、
 *    Kick にログインし直しても直らない。
 *
 * @param {{ok:boolean, reason?:string}} res `fetchKickPrograms` の戻り値
 * @returns {boolean}
 */
export function isKickSessionLost(res) {
    if (!res || res.ok) return false
    return res.reason === 'no-session' || res.reason === 'unauthorized'
}

// ---- 配信者アイコンの補完 ----
//
// 🔴 **`/api/v1/user/livestreams` の `channel.user` にはアイコンが入っていない。**
//    公開APIの `/api/v2/channels/<slug>` が返す channel は 21 キーあるが、
//    livestreams 側の channel は 11 キーの**軽量版**で、`user` の中身も削られている
//    （2026-08-04 実測。この取り違えでアイコンが出ていなかった）。
//
// アイコンは滅多に変わらないので、**1配信者につき一度だけ**公開APIで取って覚える。
// 認証不要で、Kick は任意のオリジンからの取得を許可しているため、
// ニコ生のページからでも kick.com のページからでも同じように叩ける。

const KICK_ICON_CACHE_KEY = 'kickIconCache'
/**
 * slug -> url。**取れたものだけ**を入れる。
 *
 * 🔴 **失敗を「空文字」としてここに入れないこと**（2026-08-08・doc/09 項目CD）。
 *    以前はそうしており、`iconCache.has(slug)` が真になるので**二度と取りに行かなかった。**
 *    通信が一瞬途切れただけで、その配信者のカードは**永久にローディング画像**になる。
 *    失敗は下の `iconRetryAfter` に期限つきで覚え、時間が経ったらまた試す。
 */
const iconCache = new Map()
/** slug -> この時刻までは再取得しない（メモリのみ。ページを開き直せば仕切り直し）。 */
const iconRetryAfter = new Map()
let iconCacheLoaded = false

// 1周期に投げる補完リクエストの上限。新しくフォローした配信者が一斉に放送を始めても、
// ここで頭打ちにする。残りは次の周期で埋まる。
const MAX_ICON_FETCH_PER_CYCLE = 12

async function loadIconCache() {
    if (iconCacheLoaded) return
    iconCacheLoaded = true
    try {
        const stored = await chrome.storage.local.get(KICK_ICON_CACHE_KEY)
        const map = stored && stored[KICK_ICON_CACHE_KEY]
        if (map && typeof map === 'object') {
            // ⚠️ 空文字は**以前の版が保存した「失敗の記録」**。読み込まずに捨てて、取り直させる。
            for (const [slug, url] of Object.entries(map)) if (url) iconCache.set(slug, url)
        }
    } catch (e) { /* 読めなくても実害は無い。毎回取り直すだけ */ }
}

function saveIconCache() {
    try {
        chrome.storage.local.set({ [KICK_ICON_CACHE_KEY]: Object.fromEntries(iconCache) })
    } catch (e) { /* 保存できなくてもメモリ上のキャッシュは効く */ }
}

/**
 * アイコンが空の番組を、公開APIで補完する。
 * **失敗しても番組は消さない。**アイコンが無いカードになるだけ。
 * @param {Array<object>} programs `mapKickLivestreamToInfo` の結果
 */
async function fillMissingIcons(programs) {
    await loadIconCache()

    const now = Date.now()
    const need = []
    for (const p of programs) {
        const slug = p.contentOwner && p.contentOwner.id
        if (!slug) continue
        if (p.contentOwner.icon) continue
        if (iconCache.has(slug)) {
            p.contentOwner.icon = iconCache.get(slug)
            continue
        }
        // 直近で失敗した相手は少し待つ。**ただし諦めない**（待ちが明ければまた試す）。
        if ((iconRetryAfter.get(slug) || 0) > now) continue
        if (!need.includes(slug)) need.push(slug)
    }
    if (!need.length) return

    const targets = need.slice(0, MAX_ICON_FETCH_PER_CYCLE)
    await Promise.all(targets.map(async (slug) => {
        try {
            const res = await fetch('https://kick.com/api/v2/channels/' + encodeURIComponent(slug), {
                headers: { Accept: 'application/json' },
                credentials: 'omit', // 公開APIなので認証は不要
            })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            const ch = await res.json()
            const url = (ch && ch.user && ch.user.profile_pic) || ''
            // 🔴 空で返ってきた時も**覚えない。** アイコン未設定の配信者もいるが、
            //    その判別は付かないうえ、覚えると「後で設定した」に一生追従できない。
            if (url) iconCache.set(slug, url)
            else iconRetryAfter.set(slug, now + kickIconRetryMs)
        } catch (e) {
            iconRetryAfter.set(slug, now + kickIconRetryMs)
        }
    }))
    saveIconCache()

    for (const p of programs) {
        const slug = p.contentOwner && p.contentOwner.id
        if (slug && !p.contentOwner.icon && iconCache.has(slug)) {
            p.contentOwner.icon = iconCache.get(slug)
        }
    }
}

// ---- 動くサムネ用の画像中継 ----
//
// 🔴 **CORS はブラウザがページに課す制限で、拡張の Service Worker からの取得には適用されない。**
//    動くサムネは crossOrigin で読んだ画像を canvas に描く方式なので、
//    ACAO を返さないホストの画像は SW に取ってもらって data URL で受け取る。
//
// どのオリジンから何が通るか（2026-08-04 実測）:
//   `images.kick.com`         … **どこからも通らない**（ニコ生ページでも kick.com でも中継が要る）
//   `*.dlive.nicovideo.jp`    … ニコ生ページからは通る。kick.com からは通らない

const KICK_IMAGE_HOST = /^https:\/\/images\.kick\.com\//i
const NICO_THUMB_HOST = /^https:\/\/[a-z0-9-]+\.dlive\.nicovideo\.jp\//i

// 同じURLへの取得が重ならないようにする。サムネ更新は全カードを同時に走らせる。
const imageInFlight = new Map()

/**
 * 画像を SW 経由で取り、data URL を返す。**取れなければ null**（呼び出し側が素のURLへ倒す）。
 * @param {string} url
 * @returns {Promise<string|null>}
 */
export async function fetchImageViaWorker(url) {
    if (!url) return null
    if (imageInFlight.has(url)) return imageInFlight.get(url)

    const p = (async () => {
        try {
            const res = await chrome.runtime.sendMessage({ type: 'img:fetch', url })
            return res && res.ok && res.dataUrl ? res.dataUrl : null
        } catch (e) {
            return null // 拡張が無効化されている等
        } finally {
            imageInFlight.delete(url)
        }
    })()
    imageInFlight.set(url, p)
    return p
}

/** ニコ生の視聴ページ用。**Kick の画像だけ**中継する（ニコ生自身の画像は直接読める）。 */
export const nicoPageImageProxy = {
    shouldUse: (url) => KICK_IMAGE_HOST.test(url),
    fetch: fetchImageViaWorker,
}

/** kick.com 用。**両方とも**中継が要る。 */
export const kickPageImageProxy = {
    shouldUse: (url) => KICK_IMAGE_HOST.test(url) || NICO_THUMB_HOST.test(url),
    fetch: fetchImageViaWorker,
}

// id -> { value, at }。放送が終わった番組は pruneSmoothing で落とす。
const concurrentEma = new Map()

/**
 * Kick の同接を均す。
 *
 * 実測で 155〜1275 のように大きく飛ぶことがあり、生値をそのまま順位に使うとカードが跳ねる。
 * 時定数はニコ生側の平滑化と揃えてある（片方だけ滑らかだと混在時に比較の土台がずれる）。
 *
 * ⚠️ 平滑化しても**同接であることは変わらない**。ニコ生の推定同接と同じ土俵に乗る。
 *
 * @param {string} id programInfo の id
 * @param {number} value 今回の同接
 * @param {number} now 現在時刻(ms)
 * @returns {number} 平滑化後の同接
 */
function smoothConcurrent(id, value, now) {
    const v = Number(value) || 0
    const prev = concurrentEma.get(id)
    if (!prev || !Number.isFinite(prev.value)) {
        concurrentEma.set(id, { value: v, at: now })
        return v
    }
    const dtMs = now - prev.at
    // 極小の Δt（連続呼び出し）では動かさない。ニコ生側の nextMomentum と同じ考え方。
    if (!(dtMs >= 1000)) return prev.value

    const alpha = 1 - Math.exp(-dtMs / kickConcurrentTauMs)
    const next = prev.value + (v - prev.value) * alpha
    const out = Number.isFinite(next) && next > 0 ? next : v
    concurrentEma.set(id, { value: out, at: now })
    return out
}

/** 放送が終わった番組の平滑化状態を捨てる（ページ滞在中に溜め続けない）。 */
function pruneSmoothing(aliveIds) {
    if (concurrentEma.size <= aliveIds.size) return
    for (const id of concurrentEma.keys()) {
        if (!aliveIds.has(id)) concurrentEma.delete(id)
    }
}

