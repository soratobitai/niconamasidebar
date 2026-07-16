import { handleError } from '../utils/error.js'

/**
 * 【実験】フォロー中ページ・スクレイプ方式のデータソース
 *
 * ニコ生の「フォロー中の番組（放送中）」ページ:
 *   https://live.nicovideo.jp/follow?status=onair
 * は完全SSRで、`<script id="embedded-data" data-props="...">` に放送中の全フォロー番組が
 * 詳細込み（ライブサムネ・視聴者数・コメント数・配信者・providerType・会員限定・開始時刻）で
 * 埋め込まれている。watchページと同一オリジンなので content script から credentials 付き fetch で
 * 生HTMLを取得し、パースするだけで全部得られる。
 *
 * 現行の「notifybox（リスト）＋ 番組ごとに詳細API×N」を、HTML1枚の取得＋パースへ置換する狙い。
 * → API激減／全詳細を即入手（新着サムネ遅延・サムネURL未生成問題も原理的に消える）。
 *
 * このモジュールは既存フローを壊さない「並走アダプタ」。出力は詳細API(fetchProgramInfo)相当の
 * 内部 programInfo 形に揃えてあり、makeProgramElement / resolveLiveThumbnailBaseUrl /
 * calculateActivePoint / computeNext がそのまま読める。
 */

// フォロー中の放送中番組ページ（SSR）
export const followPageUrl = 'https://live.nicovideo.jp/follow?status=onair'

/**
 * embedded-data の providerType を内部モデル（'user'|'channel'）へ写像する。
 * 観測値: 'community'（ユーザー生放送）。公式/チャンネル系は 'channel'/'official' を想定。
 */
function mapProviderType(pt) {
    if (pt === 'channel' || pt === 'official') return 'channel'
    // community / user / 未知 は user 扱い（ライブサムネは liveScreenshotThumbnailUrls 経路で拾う）
    return 'user'
}

/**
 * ライブスクショURLかどうか（配信者が設定した「固定画像」と区別する）。
 * 実測パターン: ライブスクショは常に asset*.dlive.nicovideo.jp/.../screenshot/.../screenshot.jpg 形。
 * 固定画像は listing-thumbnail.live.nicovideo.jp?image=...thumbnail_{ts}.png 形。
 */
function isLiveScreenshotUrl(u) {
    if (typeof u !== 'string' || !u) return false
    return u.includes('/screenshot/') || /(^|\/\/|\.)dlive\.nicovideo\.jp\//i.test(u)
}

/**
 * 常にライブスクショを選ぶ（配信者設定の固定画像は使わない、というユーザー要件）。
 * 実測: 固定画像設定時 listingThumbnail=固定・flippedListingThumbnail=ライブ／未設定時 listingThumbnail=ライブ・flipped無し。
 * → 両候補からライブスクショ形を最優先。どちらもライブ形でなければ空（=固定画像は表示せず、
 *   makeProgramElement/updateThumbnailsFromStorage 側でローディング/現状維持に委ねる）。
 * @param {object} value
 * @returns {string}
 */
function pickLiveThumbnail(value) {
    const cands = [value && value.listingThumbnail, value && value.flippedListingThumbnail].filter(Boolean)
    return cands.find(isLiveScreenshotUrl) || ''
}

/**
 * embedded-data の1番組(value) を、詳細API相当の内部 programInfo 形へ変換する。
 * @param {object} value - followedPrograms.onairProgramListState.domain.items[].value
 * @returns {object|null}
 */
export function mapFollowItemToProgramInfo(value) {
    if (!value || !value.nicoliveProgramId) return null
    // 配信者が設定した固定画像は使わず、常にライブスクショを選ぶ（要件）。
    // 固定画像設定時は listingThumbnail が固定画像・flippedListingThumbnail がライブになる。
    const thumb = pickLiveThumbnail(value)
    const supplier = value.supplier || {}
    const icons = supplier.icons || {}
    const stats = value.statistics || {}
    return {
        id: String(value.nicoliveProgramId),                 // "lv..."
        title: value.title || 'タイトル不明',
        providerType: mapProviderType(value.providerType),
        contentOwner: {
            id: supplier.programProviderId != null ? String(supplier.programProviderId) : '',
            name: supplier.name || '',
            icon: icons.uri150x150 || icons.uri50x50 || '',
        },
        // user は liveScreenshotThumbnailUrls.middle、channel は large1280x720ThumbnailUrl を見る。
        // 両方に listingThumbnail を入れ、resolveLiveThumbnailBaseUrl が provider 別に拾えるようにする。
        liveScreenshotThumbnailUrls: thumb ? { middle: thumb } : undefined,
        large1280x720ThumbnailUrl: thumb || undefined,
        thumbnailUrl: thumb || '',                           // フォールバック＆静的サムネ兼用
        isMemberOnly: !!value.isFollowerOnly,
        viewers: Number(stats.watchCount) || 0,
        comments: Number(stats.commentCount) || 0,
        // calculateActivePoint は onAirTime.beginAt を new Date() でパースする。beginTime は unix秒。
        onAirTime: { beginAt: value.beginTime ? new Date(value.beginTime * 1000).toISOString() : null },
        status: value.status || null,
        watchPageUrl: value.watchPageUrl || null,
        _source: 'followPage',
    }
}

/**
 * 生HTMLから embedded-data を取り出し、放送中番組の value 配列＋メタを返す。
 * @param {string} html
 * @returns {{ items: object[], total: number, canFetchMore: boolean, raw: object|null }}
 */
export function extractFollowItemsFromHtml(html) {
    const empty = { items: [], total: 0, canFetchMore: false, raw: null }
    if (!html) return empty
    let props = null
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html')
        const el = doc.getElementById('embedded-data')
        props = el && el.getAttribute('data-props')
    } catch (_e) {
        return empty
    }
    if (!props) return empty
    let json
    try { json = JSON.parse(props) } catch (_e) { return empty }
    const state = json && json.followedPrograms && json.followedPrograms.onairProgramListState
    const domainItems = (state && state.domain && state.domain.items) || []
    const items = domainItems.map((it) => it && it.value).filter(Boolean)
    return {
        items,
        total: (state && state.totalProgramsCount) != null ? state.totalProgramsCount : items.length,
        canFetchMore: !!(state && state.canFetchMore),
        raw: json,
    }
}

/**
 * フォロー中ページを取得して、放送中番組を内部 programInfo 形の配列で返す。
 * @returns {Promise<Array<object>|null>} 失敗時 null
 */
export async function fetchFollowedProgramsViaPage() {
    try {
        const res = await fetch(followPageUrl, { credentials: 'include' })
        if (!res || !res.ok) {
            handleError(new Error(`follow page HTTP ${res ? res.status : 'no-response'}`), { fn: 'fetchFollowedProgramsViaPage' })
            return null
        }
        const html = await res.text()
        const { items } = extractFollowItemsFromHtml(html)
        // TODO(ページング): canFetchMore=true（フォロー70件超が同時放送）のとき offset を進めて追加取得する。
        return items.map(mapFollowItemToProgramInfo).filter(Boolean)
    } catch (error) {
        handleError(error, { fn: 'fetchFollowedProgramsViaPage' })
        return null
    }
}

// ---- デバッグ（実ページのConsoleから手動確認） -----------------------------------------
// window.__testFollowScrape() で、スクレイプ方式の取得結果を件数＋表で表示する。
// ※ content script の isolated world に定義される。DevToolsのコンソール実行コンテキストで
//   本拡張のコンテキストを選ぶこと（window.showApiStats と同じ注意）。
export async function debugTestFollowScrape() {
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const t0 = now()
    const list = await fetchFollowedProgramsViaPage()
    const ms = Math.round(now() - t0)
    if (!list) { console.warn('[followScrape] 取得失敗（未ログイン/構造変化/通信エラー）'); return null }
    console.log(`[followScrape] ${list.length}件 / ${ms}ms  (${followPageUrl})`)
    console.table(list.map((p) => ({
        id: p.id,
        title: (p.title || '').slice(0, 16),
        viewers: p.viewers,
        comments: p.comments,
        provider: p.providerType,
        member: p.isMemberOnly,
        beginAt: p.onAirTime && p.onAirTime.beginAt,
        thumb: (p.thumbnailUrl || '').slice(0, 44),
    })))
    return list
}
if (typeof window !== 'undefined') {
    window.__testFollowScrape = debugTestFollowScrape
    // データソースを切替（'api' | 'followPage' | 'auto'）。chrome.storage.local 経由で onChanged が反映。
    // 例: window.__setDataSource('followPage') / window.__setDataSource('api')
    window.__setDataSource = (v) => {
        try { chrome.storage.local.set({ dataSource: v }, () => console.log('dataSource =', v)) }
        catch (e) { console.warn('[followScrape] dataSource切替失敗:', e) }
    }
}
