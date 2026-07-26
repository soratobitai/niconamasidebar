import { handleError } from '../utils/error.js'
import { fetchProgramInfo } from './api.js'

/**
 * フォロー中（放送中）番組の詳細を一括取得するデータソース
 *
 * フォロー中ページ（live.nicovideo.jp/follow?status=onair）が「もっと見る」で叩く公開フロントAPI:
 *   GET https://live.nicovideo.jp/front/api/pages/follow/v1/programs
 *       ?status=onair & offset=<0始まりページ番号> & limit=<件数>
 *   credentials: include（Cookie）／応答: { data: { programs: [...], total: N } }
 * を直接呼び、放送中フォロー番組の詳細（視聴者数・コメント数・ライブサムネURL・配信者・会員限定・
 * 開始時刻）を1〜数リクエストで全件取得する。従来「1番組=詳細API×N」だった詳細取得の置換＝効率化。
 *
 * リスト（どの番組を並べるか）は従来どおり notifybox。ここで得た詳細を storage へ一括 upsert し、
 * UpdateManager.updateSidebar がリストと突き合わせて描画する。
 *
 * ページング: offset は「0始まりのページ番号」（offset=0 が先頭 limit 件、offset=1 が次の limit 件）。
 * total まで offset を進めて取り切る（放送中フォローが limit を超えても全件カバー）。安全上限あり。
 * 選択補完(fillMissingDetails): フォローAPIだけでは埋まらない情報を、対象番組だけ詳細API
 * (fetchProgramInfo)で補う（全番組には叩かない＝旧方式の重さを避ける）。
 *  - user で固定画像設定/未生成によりライブサムネが空 → liveScreenshotThumbnailUrls を補完。
 *  - channel/official はフォローAPIが配信者名/アイコン(programProvider)を持たない → contentOwner を補完。
 * 出力は内部 programInfo 形（従来の詳細APIと同じshape）に揃えてあり、makeProgramElement /
 * resolveLiveThumbnailBaseUrl / calculateActivePoint がそのまま読める。
 */

// フォロー中（放送中）番組の公開フロントAPI
const followApiUrl = 'https://live.nicovideo.jp/front/api/pages/follow/v1/programs'
const PAGE_LIMIT = 100 // 1リクエストあたり件数（notifybox の rows=100 に合わせる）
const MAX_PAGES = 5    // 安全上限（放送中フォローが極端に多い場合の暴走防止：最大 500 件）
const MAX_DETAIL_FALLBACK = 30 // 1サイクルで詳細APIを呼ぶ上限（固定画像番組の補完・暴走防止）

/**
 * providerType を内部モデル（'user'|'channel'）へ写像する。
 * API観測値: 'community'（ユーザー生放送）/ 'channel' / 'official'。
 */
function mapProviderType(pt) {
    if (pt === 'channel' || pt === 'official') return 'channel'
    // community / user / 未知 は user 扱い（ライブサムネは liveScreenshotThumbnailUrls 経路で拾う）
    return 'user'
}

/**
 * ライブスクショURLかどうか（配信者が設定した「固定画像」と区別する）。
 * ライブスクショ: asset*.dlive.nicovideo.jp/.../screenshot/.../screenshot.jpg 形。
 * 固定画像: listing-thumbnail.live.nicovideo.jp?image=...thumbnail_{ts}.png 形。
 */
export function isLiveScreenshotUrl(u) {
    if (typeof u !== 'string' || !u) return false
    return u.includes('/screenshot/') || /(^|\/\/|\.)dlive\.nicovideo\.jp\//i.test(u)
}

/**
 * フロントAPIの1番組（data.programs[]）を、詳細API相当の内部 programInfo 形へ変換する。
 * 配信者設定の固定画像は使わず、ライブスクショのときだけサムネURLを採用する（要件）。
 * @param {object} p
 * @returns {object|null}
 */
export function mapApiProgramToInfo(p) {
    if (!p || !p.id) return null
    const providerType = mapProviderType(p.providerType)
    // user は配信者設定の固定画像を出さずライブスクショのみ採用。
    // channel/official は listingThumbnail がそのイベントの正規サムネ（固定画像形でも）なので表示には使う。
    const rawThumb = p.listingThumbnail || ''
    const thumb = providerType === 'user'
        ? (isLiveScreenshotUrl(rawThumb) ? rawThumb : '')
        : rawThumb
    // ただし「20秒周期で取り直す対象」に含めてよいのはライブスクショだけ。
    // 前提（ニコ生の仕様・2026-07-26 に利用者確認）: チャンネル番組にライブサムネは提供されない。
    // チャンネルは固定画像／チャンネルアイコンを出しているのが正しい姿であり、
    // 「チャンネルのサムネが動かない」のは不具合ではない。ここを"直そう"としないこと。
    // listing-thumbnail 経由の固定画像・チャンネルアイコンは中身が変わらないうえ、このホストは
    // Access-Control-Allow-Origin を返さない。動くサムネONだと crossOrigin 読みが必ず失敗して
    // 平文で取り直す＝1周期2リクエストになり、ingest にも到達しない
    // （実測 2026-07-26: 14番組中1件のチャンネルが毎周期100%失敗し続けていた）。
    // 表示用の thumbnailUrl は従来どおり残すので、カードの見た目は変わらない。
    const liveThumb = isLiveScreenshotUrl(thumb) ? thumb : ''
    const provider = p.programProvider || {}
    const stats = p.statistics || {}
    return {
        id: String(p.id),                                    // "lv..."
        title: p.title || 'タイトル不明',
        providerType,
        contentOwner: {
            id: provider.id != null ? String(provider.id) : '',
            name: provider.name || '',
            icon: provider.icon || provider.iconSmall || '',
        },
        // user は liveScreenshotThumbnailUrls.middle、channel は large1280x720ThumbnailUrl を見る。
        // 両方に同じライブスクショURLを入れ、resolveLiveThumbnailBaseUrl が provider 別に拾えるようにする。
        // 入れるのは liveThumb（ライブスクショに限る）＝定期更新の対象を絞る。
        liveScreenshotThumbnailUrls: liveThumb ? { middle: liveThumb } : undefined,
        large1280x720ThumbnailUrl: liveThumb || undefined,
        thumbnailUrl: thumb || '',                           // 表示用（固定画像・イベントサムネもここは従来どおり）
        isMemberOnly: !!p.isFollowerOnly,
        viewers: Number(stats.watchCount) || 0,
        comments: Number(stats.commentCount) || 0,
        // API の beginAt はミリ秒エポック。calculateActivePoint は onAirTime.beginAt を new Date() でパースする。
        onAirTime: { beginAt: p.beginAt ? new Date(p.beginAt).toISOString() : null },
        status: p.liveCycle || null,
        watchPageUrl: p.watchPageUrl || null,
        _source: 'followApi',
    }
}

/**
 * フロントAPIの1ページを取得する。
 * @param {number} offset - 0始まりのページ番号
 * @returns {Promise<{ programs: object[], total: number|null }>}
 */
async function fetchOnePage(offset) {
    const url = `${followApiUrl}?status=onair&offset=${offset}&limit=${PAGE_LIMIT}`
    const res = await fetch(url, { credentials: 'include' })
    if (!res || !res.ok) throw new Error(`follow api HTTP ${res ? res.status : 'no-response'}`)
    const json = await res.json()
    const data = json && json.data
    return {
        programs: (data && Array.isArray(data.programs)) ? data.programs : [],
        total: (data && typeof data.total === 'number') ? data.total : null,
    }
}

/**
 * フォローAPIだけでは埋まらない情報を、番組詳細API(fetchProgramInfo)で選択的に補完する。
 *  - user でライブサムネが空（固定画像配信者／放送直後で未生成）→ liveScreenshotThumbnailUrls を補う。
 *  - channel/official → フォローAPIは programProvider（配信者名/アイコン）を持たないので、詳細APIの
 *    contentOwner で名前/アイコンを補う（イベントサムネが空なら large1280x720ThumbnailUrl も）。
 * 全番組には叩かない（対象の少数だけ・上限あり）＝旧方式の「全番組×詳細API」の重さを避けて穴だけ埋める。
 * @param {Array<object>} programs - map済みの内部 programInfo 配列（破壊的に補完する）
 */
async function fillMissingDetails(programs) {
    const targets = programs.filter((p) => p && (
        (p.providerType === 'user' && !p.thumbnailUrl) ||
        (p.providerType === 'channel' && (!p.contentOwner || !p.contentOwner.name || !p.thumbnailUrl))
    )).slice(0, MAX_DETAIL_FALLBACK)
    if (targets.length === 0) return
    await Promise.all(targets.map(async (p) => {
        try {
            const detail = await fetchProgramInfo(String(p.id).replace(/^lv/, ''))
            if (!detail) return
            // 配信者名/アイコン（公式/チャンネルはフォローAPIに無いので補完）
            const co = detail.contentOwner
            if (co && (!p.contentOwner || !p.contentOwner.name)) {
                p.contentOwner = {
                    id: co.id != null ? String(co.id) : ((p.contentOwner && p.contentOwner.id) || ''),
                    name: co.name || ((p.contentOwner && p.contentOwner.name) || ''),
                    icon: co.icon || ((p.contentOwner && p.contentOwner.icon) || ''),
                }
            }
            // サムネ
            if (!p.thumbnailUrl) {
                if (p.providerType === 'user') {
                    // user はライブスクショのみ（固定画像は出さない）
                    const ss = detail.liveScreenshotThumbnailUrls
                    const cand = (ss && (ss.middle || ss.large || ss.small)) || ''
                    if (isLiveScreenshotUrl(cand)) {
                        p.liveScreenshotThumbnailUrls = { middle: cand }
                        p.large1280x720ThumbnailUrl = cand
                        p.thumbnailUrl = cand
                    }
                } else {
                    // channel/official はイベントサムネ（固定画像形でも可）を表示に採用。
                    // ただし定期更新の対象にするのはライブスクショだけ（mapApiProgramToInfo と同じ理由）。
                    const cand = detail.large1280x720ThumbnailUrl
                        || (detail.liveScreenshotThumbnailUrls && detail.liveScreenshotThumbnailUrls.middle) || ''
                    if (cand) {
                        if (isLiveScreenshotUrl(cand)) p.large1280x720ThumbnailUrl = cand
                        p.thumbnailUrl = cand
                    }
                }
            }
        } catch (_e) { /* 個別失敗は空のまま（次サイクルで再挑戦） */ }
    }))
}

/**
 * 放送中フォロー番組を、内部 programInfo 形の配列で返す（ページングして全件）。
 * ライブサムネが無い番組は詳細APIで補完する（fillMissingLiveThumbnails）。
 * @returns {Promise<Array<object>|null>} 失敗時 null（フォールバックはしない）
 */
export async function fetchFollowedProgramsViaPage() {
    try {
        const all = []
        const seen = new Set()
        let total = Infinity
        for (let offset = 0; offset < MAX_PAGES; offset++) {
            const { programs, total: t } = await fetchOnePage(offset)
            if (t != null) total = t
            if (programs.length === 0) break // これ以上ページが無い
            for (const p of programs) {
                const id = p && p.id
                if (id && !seen.has(id)) { seen.add(id); all.push(p) }
            }
            if (all.length >= total) break   // total まで取り切った
        }
        const mapped = all.map(mapApiProgramToInfo).filter(Boolean)
        // フォローAPIで埋まらない情報（固定画像userのライブサムネ／公式・chの名前アイコン）を選択補完
        await fillMissingDetails(mapped)
        return mapped
    } catch (error) {
        handleError(error, { fn: 'fetchFollowedProgramsViaPage' })
        return null
    }
}

// ---- デバッグ（実ページのConsoleから手動確認） -----------------------------------------
// window.__testFollowScrape() で、取得結果を件数＋表で表示する。
// ※ content script の isolated world に定義される。DevToolsのコンソール実行コンテキストで
//   本拡張のコンテキストを選ぶこと。
export async function debugTestFollowScrape() {
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const t0 = now()
    const list = await fetchFollowedProgramsViaPage()
    const ms = Math.round(now() - t0)
    if (!list) { console.warn('[followApi] 取得失敗（未ログイン/仕様変更/通信エラー）'); return null }
    console.log(`[followApi] ${list.length}件 / ${ms}ms`)
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
}
