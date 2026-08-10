import { handleError } from '../utils/error.js'
import { mapProviderType } from '../utils/providerType.js'
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
 *  - user でライブサムネが空（放送直後で未生成など）→ liveScreenshotThumbnailUrls を補完。
 *    ※ 固定画像運用の番組は flippedListingThumbnail から回収するのでここには来ない（下記）。
 *  - 配信者名が空のまま（想定外の応答）→ contentOwner を補完。
 *    ※ channel のアイコンは socialGroup.thumbnailUrl から拾えるので、この補完には頼らない。
 * 出力は内部 programInfo 形（従来の詳細APIと同じshape）に揃えてあり、makeProgramElement /
 * resolveLiveThumbnailBaseUrl / calculateActivePoint がそのまま読める。
 */

// フォロー中（放送中）番組の公開フロントAPI
const followApiUrl = 'https://live.nicovideo.jp/front/api/pages/follow/v1/programs'
const PAGE_LIMIT = 100 // 1リクエストあたり件数（notifybox の rows=100 に合わせる）
const MAX_PAGES = 5    // 安全上限（放送中フォローが極端に多い場合の暴走防止：最大 500 件）
const MAX_DETAIL_FALLBACK = 30 // 1サイクルで詳細APIを呼ぶ上限（固定画像番組の補完・暴走防止）

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
    // 配信者が固定画像を設定している番組は listingThumbnail が固定画像になるが、
    // **同じ応答の flippedListingThumbnail にライブスクショが入っている**
    // （一覧ページでこの手の番組のサムネが固定画像とスクショで交互に入れ替わるのは、この2枚のこと）。
    // ここで拾えば、その番組ごとに詳細APIを叩き直す fillMissingDetails がほぼ不要になる
    // （2026-07-31 実測: user 67件中22件が固定画像運用＝約1/3。その22件すべてが flipped を持っていた）。
    // ⚠️ 採用は **isLiveScreenshotUrl を通る素直な形だけ**。同22件中2件は listing-thumbnail プロキシに
    //    包まれた形（`?url=<エンコードしたスクショURL>`）で来ており、判定を通らない。ここを緩めて
    //    ホストで通すと、同じホストが配る固定画像・チャンネルアイコンまで「ライブサムネ」として
    //    登録してしまう（doc/09 項目AA の事故そのもの）。包まれた分は従来どおり詳細APIの補完に回す。
    const flipped = p.flippedListingThumbnail || ''
    const shot = isLiveScreenshotUrl(rawThumb) ? rawThumb
        : (isLiveScreenshotUrl(flipped) ? flipped : '')
    const thumb = providerType === 'user' ? shot : rawThumb
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
    // channel/official は `programProvider` が `{name, icon:'', iconSmall:''}` で **id とアイコンが空**、
    // 代わりに `socialGroup:{id:'ch…', name, thumbnailUrl}` にチャンネル名とチャンネルアイコンが入る
    // （2026-07-31 実測: community 67件は programProvider.icon が 67/67 埋まり socialGroup 無し、
    //   channel 3件は programProvider.icon が 0/3・socialGroup が 3/3）。
    // ここで拾わないと channel カードのアイコンは**永久に空**になる（fillMissingDetails は
    // 「名前が空」でしか発火せず、名前は埋まっているので対象にならない）。
    const social = p.socialGroup || {}
    const stats = p.statistics || {}
    return {
        id: String(p.id),                                    // "lv..."
        title: p.title || 'タイトル不明',
        providerType,
        contentOwner: {
            id: provider.id != null ? String(provider.id) : (social.id || ''),
            name: provider.name || social.name || '',
            icon: provider.icon || provider.iconSmall || social.thumbnailUrl || '',
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
 *  - user でライブサムネが空（放送直後で未生成／flipped が包まれた形だった番組）→
 *    liveScreenshotThumbnailUrls を補う。**固定画像運用の番組の大半は mapApiProgramToInfo が
 *    flippedListingThumbnail から回収済みなので、ここへ来る件数は実測で 22件中2件程度まで減る。**
 *  - 配信者名が空 → 詳細APIの contentOwner で名前/アイコンを補う（イベントサムネが空なら
 *    large1280x720ThumbnailUrl も）。通常はフォローAPIの programProvider / socialGroup で埋まるので、
 *    ここに落ちてくるのは応答が想定と違うときだけ。
 * 全番組には叩かない（対象の少数だけ・上限あり）＝旧方式の「全番組×詳細API」の重さを避けて穴だけ埋める。
 * @param {Array<object>} programs - map済みの内部 programInfo 配列（破壊的に補完する）
 */
async function fillMissingDetails(programs) {
    // 穴は2種類だけ:「サムネが空」または「配信者名が空」。providerType 別に条件を分けない
    // （旧実装は channel のときだけ名前の空を見ていたが、channel は名前が埋まるので発火せず、
    //   逆に名前が空の user は拾えなかった。実測上どちらもほぼ起きないが、条件を狭く書く理由が無い）。
    const targets = programs.filter((p) => p && (
        !p.thumbnailUrl || !p.contentOwner || !p.contentOwner.name
    )).slice(0, MAX_DETAIL_FALLBACK)
    if (targets.length === 0) return
    await Promise.all(targets.map(async (p) => {
        try {
            const detail = await fetchProgramInfo(String(p.id).replace(/^lv/, ''))
            if (!detail) return
            // 配信者名/アイコン（フォローAPIの programProvider / socialGroup で埋まらなかった時だけ）
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
 * 固定画像の番組から flippedListingThumbnail でライブスクショを回収できなくなったら1回だけ警告する（鳴る罠）。
 *
 * 回収できていれば**完全に無言**。応答から flipped が消える／形が変わると、詳細APIでの補完
 * （番組ごと・毎サイクル・最大30件）が静かに復活するだけで、画面上は何も変わらないので気付けない。
 *
 * 🔴 **`flipped` を持っていない番組を母数に入れないこと。** 旧実装はそれをやっていて誤報していた
 * （2026-08-02 に利用者のコンソールで実際に1件鳴った。doc/09 項目BK）。
 * 実測（同日・公開の recent 版で user 70件）:
 *   - `flippedListingThumbnail` を持つ番組は **17/70**。持たないのが普通で、欠落ではない。
 *   - 固定画像運用は19件。うち flipped を持つ17件は **17/17 回収できていた**。
 *   - 残る2件は `listingThumbnail` 自体が**プロキシに包まれたスクショ**
 *     (`listing-thumbnail…/?url=<エンコードした dlive URL>`) で、この形の時 API は flipped を返さない。
 *     これは**こちらが意図的に弾いている形**（緩めると項目AA の事故）＝仕様どおり詳細APIへ回るだけ。
 * 旧条件は「回収できた数が0なら鳴らす」だったので、リストにこの形が1件しか無い回に必ず鳴った。
 *
 * @param {Array<object>} raw フォローAPIの生データ
 * @param {Array<object>} mapped 写像後の programInfo
 */
// 「1件も flipped を持っていない」を異常とみなすのに必要な母数。実測で持たない番組は約1割なので、
// 数件の回はたまたま全部そうなりうる。少ない回は黙る（誤報より見逃しを選ぶ＝実害は通信量だけ）。
const FLIPPED_TRAP_MIN_SAMPLE = 8
// 「flipped は来ているが1件も使えない」を異常とみなすのに必要な母数（下記②）。
const FLIPPED_TRAP_MIN_CARRIERS = 3
let flippedWarned = false
function warnIfFlippedThumbMissing(raw, mapped) {
    if (flippedWarned) return
    const byId = new Map(mapped.map((m) => [m.id, m]))
    // 「固定画像運用」＝ listingThumbnail はあるがライブスクショ形ではない user 番組。
    // （放送直後でスクショ未生成の番組は listingThumbnail 自体が空なので、ここには入らない）
    const fixed = raw.filter((p) => {
        const m = p && p.id ? byId.get(String(p.id)) : null
        return m && m.providerType === 'user' && p.listingThumbnail && !isLiveScreenshotUrl(p.listingThumbnail)
    })
    if (fixed.length === 0) return

    const warn = (why, sample) => {
        flippedWarned = true
        console.warn(
            `[followApi] ${why}（詳細APIでの番組ごと補完に戻ります）。`
            + 'flippedListingThumbnail の有無/形を確認してください。実際のキー:',
            Object.keys(sample || {})
        )
    }

    // ① フィールドごと消えた疑い: 固定画像番組がそれなりの数あるのに、誰も flipped を持っていない。
    const carriers = fixed.filter((p) => !!p.flippedListingThumbnail)
    if (carriers.length === 0) {
        if (fixed.length < FLIPPED_TRAP_MIN_SAMPLE) return // 母数不足。偶然と区別できないので黙る
        warn(`固定画像の番組 ${fixed.length}件が1つも flippedListingThumbnail を持っていません`, fixed[0])
        return
    }

    // ② 形が変わった疑い: flipped は来ているのに、1件も採用できる形ではない。
    // こちらも1件だけの回では鳴らさない。**flipped が包まれた形で来ることもある**
    // （doc/09 項目AW の実測 2026-07-31: 22件中2件。※2026-08-02 の70件では0件）ので、
    // 母数1でそれを引いたら①と同じ誤報になる。本当に形が変わったなら母数は十分大きくなる
    // （実測の carriers は17件）。
    if (carriers.length < FLIPPED_TRAP_MIN_CARRIERS) return
    const recovered = carriers.filter((p) => byId.get(String(p.id)).thumbnailUrl).length
    if (recovered > 0) return
    warn(`flippedListingThumbnail を持つ ${carriers.length}件からライブスクショを回収できませんでした`, carriers[0])
}

/**
 * 放送中フォロー番組を、内部 programInfo 形の配列で返す（ページングして全件）。
 * ライブサムネが無い番組・名前やアイコンが無い番組は詳細APIで補完する（fillMissingDetails）。
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
        warnIfFlippedThumbMissing(all, mapped)
        // フォローAPIで埋まらない情報（スクショ未生成の番組／想定外に名前が空の番組）を選択補完
        await fillMissingDetails(mapped)
        return mapped
    } catch (error) {
        handleError(error, { fn: 'fetchFollowedProgramsViaPage' })
        return null
    }
}
