import { notifyboxAPI, liveInfoAPI, notifyboxRows, notifyboxRowsFallback } from '../config/constants.js'
import { handleError } from '../utils/error.js'
import { mapProviderType } from '../utils/providerType.js'

// notifybox はリストの「早さ」担当。2026-07-29 の実測で、user番組の新着検知が
// フォローAPIより 20〜101秒 速いことが分かったため、和集合方式で併用している（doc/09 項目AD）。
// 視聴者数・コメント数・ライブサムネは無いので、詳細と並び順はフォローAPI側が担う。
// ただし**配信者名とアイコンは notifybox にも入っている**（下記 mapNotifyboxRowToInfo）。
// フォローAPIが同じ番組を拾うまでの 20〜101秒＋1周期のあいだ、それを使わないと
// カードが「名前なし・アイコンなし」で立つ（doc/09 項目AT）。

/**
 * 今この瞬間 notifybox に要求している件数。
 *
 * ⚠️ **2026-08-02 時点で本体からの呼び出しは無い。** 終了判定が「件数を見て推測する」形を
 * やめて「詳細APIに聞いて確かめる」形になったため（doc/09 項目BF-2）。
 * 実測スクリプトから読めるように残してある。**件数を根拠にする判定をここから再生させないこと。**
 * @returns {number}
 */
export function currentNotifyboxRows() {
    return effectiveRows
}

// 実際に投げる件数。`rows=500` を受け付けないAPIだった場合に備え、失敗したら実績値へ落とす。
// 落とさないと notifybox が永久に死に、新着検知が 20〜101秒 遅くなる（エラーは1回出るだけ）。
let effectiveRows = notifyboxRows

/**
 * フォロー中の放送中番組リストを notifybox から取得する。
 * @param {number} [rows] 取得件数。既定は現在の要求件数（失敗時に下がる）
 * @returns {Promise<false|Array<any>>} notifybox_content 配列、失敗時は false
 */
const liveProgramsInFlight = new Map()

export async function fetchLivePrograms(rows = effectiveRows) {
    const key = String(rows)
    if (liveProgramsInFlight.has(key)) return liveProgramsInFlight.get(key)

    const p = (async () => {
        try {
            let response = await fetch(`${notifyboxAPI}?rows=${rows}`, { credentials: 'include' })
            response = await response.json()
            if (response.meta?.status !== 200 || !response.data || !response.data.notifybox_content) {
                handleError(
                    new Error(`notifybox returned status ${response.meta?.status || 'unknown'}`),
                    { api: 'fetchLivePrograms', rows, response: response.meta }
                )
                downgradeRows(rows)
                return false
            }
            warnIfNotifyboxShapeChanged(response.data.notifybox_content)
            return response.data.notifybox_content
        } catch (error) {
            // 🔴 **ここでは件数を下げない。** 通信断・オフラインでも来る経路なので、下げると
            //    ネットが一瞬切れただけで以後ずっと少ない件数になる。「APIが rows を拒否した」なら
            //    応答は返ってきて meta.status が 200 以外になるはずで、それは上の分岐で捕まえる。
            handleError(error, { api: 'fetchLivePrograms', rows })
            return false
        } finally {
            liveProgramsInFlight.delete(key)
        }
    })()

    liveProgramsInFlight.set(key, p)
    return p
}

/**
 * APIに拒否されたら要求件数を実績値へ落とす（1回だけ・以後そのまま）。
 *
 * `rows=500` を受け付けないAPIだった場合の保険。落とさないと notifybox が永久に死に、
 * **新着検知が 20〜101秒 遅くなり、終了検知も効かなくなる**（しかもエラーは1回出るだけ）。
 *
 * ⚠️ **呼ぶのは「応答は返ってきたが meta.status が異常」の時だけ。** 通信断の catch から
 * 呼ぶと、ネットが一瞬切れただけで以後ずっと少ない件数になる（検証で実際に踏んだ）。
 */
function downgradeRows(usedRows) {
    if (effectiveRows <= notifyboxRowsFallback || usedRows !== effectiveRows) return
    effectiveRows = notifyboxRowsFallback
    console.warn(
        `[notifybox] rows=${usedRows} の取得に失敗したため、以後は rows=${notifyboxRowsFallback} で取得します。`
    )
}

/**
 * notifybox の応答形が変わっていたら1回だけ警告する（鳴る罠）。
 *
 * 配信者名/アイコンが取れなくなると、新着カードが「名前なし・アイコンなし・ローディング画像」で
 * 立つだけで**エラーは一切出ない**。原因に辿り着けない類の壊れ方なので、ここで鳴らす。
 * 正常時は完全に無言（毎サイクル出すと埋もれるので1回だけ）。
 */
let notifyboxShapeWarned = false
function warnIfNotifyboxShapeChanged(rows) {
    if (notifyboxShapeWarned || !Array.isArray(rows) || rows.length === 0) return
    const row = rows[0] || {}
    // 値の中身ではなくキーの有無を見る（空文字は「フィールドはある」＝仕様変更ではない）
    if (row.community_name !== undefined && row.thumbnail_url !== undefined) return
    notifyboxShapeWarned = true
    console.warn(
        '[notifybox] 配信者名/アイコンのフィールドが見つかりません。'
        + '新着番組のカードが「名前なし・アイコンなし」で表示されます。実際のキー:',
        Object.keys(row)
    )
}

/**
 * アイコンURLから配信者IDを取り出す。
 * notifybox は配信者IDを直接返さないが、アイコンURLに埋まっている（実測値）:
 *   user    : `https://secure-dcdn.cdn.nimg.jp/nicoaccount/usericon/5255/52553742.jpg?…` → `52553742`
 *   channel : `https://secure-dcdn.cdn.nimg.jp/comch/channel-icon/128x128/ch2607134.jpg?…` → `ch2607134`
 * 取れなければ空文字（＝カードのアイコンにリンクを張らないだけ。表示は壊れない）。
 * @param {string} url
 * @returns {string}
 */
function providerIdFromIconUrl(url) {
    if (!url) return ''
    const m = String(url).match(/\/(ch\d+|\d+)\.jpg/i)
    return m ? m[1] : ''
}

/**
 * notifybox の1行を内部 programInfo 形へ写像する。
 *
 * **notifybox が返すのは id と title だけではない。** 実測の1行:
 * ```json
 * { "id": "341121933", "title": "…",
 *   "thumbnail_url": "https://secure-dcdn.cdn.nimg.jp/nicoaccount/usericon/5255/52553742.jpg?…",
 *   "community_name": "配信者の表示名", "provider_type": "community", "elapsed_time": 137 }
 * ```
 * `community_name` はコミュニティ廃止後もキー名だけ残っているレガシー名で、**中身は配信者名**
 * （user ならユーザー名 / channel ならチャンネル名）。`thumbnail_url` も同様に**配信者アイコン**で、
 * ライブサムネではない（ここを thumbnailUrl に入れると「アイコンをライブサムネとして20秒ごとに
 * 取り直す」doc/09 項目AA の再発になる。入れないこと）。
 *
 * `elapsed_time`（放送開始からの経過秒）は**意図的に使っていない**。新着順の基準は
 * 呼び出し側が渡す beginAt（notifybox の返却順を保つための擬似値）に一本化している。
 *
 * @param {object} row notifybox_content の1要素
 * @param {string} beginAtIso 新着順の基準に使う beginAt（ISO文字列）。呼び出し側が決める
 * @returns {object|null} 内部 programInfo（不正な行は null）
 */
export function mapNotifyboxRowToInfo(row, beginAtIso) {
    if (!row || row.id == null) return null
    const icon = row.thumbnail_url || ''
    return {
        id: 'lv' + String(row.id).replace(/^lv/, ''),
        title: row.title || 'タイトル不明',
        providerType: mapProviderType(row.provider_type),
        contentOwner: {
            id: providerIdFromIconUrl(icon),
            name: row.community_name || '',
            icon,
        },
        thumbnailUrl: '',   // notifybox はライブサムネを持たない（アイコンを入れないこと・上記参照）
        isMemberOnly: false,
        viewers: 0,
        comments: 0,
        onAirTime: { beginAt: beginAtIso },
        _source: 'notifybox',
    }
}

/**
 * Fetch detailed program info by live id (number without "lv").
 * 用途を限定: フォローAPIがライブサムネを返さない番組（固定画像配信者など）だけ呼び、
 * liveScreenshotThumbnailUrls を補完する。全番組には使わない。
 * @param {number|string} liveId - Live id without the "lv" prefix.
 * @returns {Promise<any|undefined>} Program data object on success, or undefined on failure.
 */
// In-flight dedupe for detail API（同時リクエストの重複防止のみ）
const programInfoInFlight = new Map() // liveId -> Promise

export async function fetchProgramInfo(liveId) {
    const id = String(liveId)

    if (programInfoInFlight.has(id)) {
        return programInfoInFlight.get(id)
    }

    const p = (async () => {
        try {
            let response = await fetch(`${liveInfoAPI}/lv${id}`)
            response = await response.json()
            if (response.meta?.status !== 200 || !response.data) {
                if (response.meta?.status !== 200) {
                    handleError(
                        new Error(`API returned status ${response.meta.status}`),
                        { api: 'fetchProgramInfo', liveId: id, status: response.meta.status }
                    )
                }
                return undefined
            }
            return response.data
        } catch (error) {
            handleError(error, { api: 'fetchProgramInfo', liveId: id })
            return undefined
        } finally {
            programInfoInFlight.delete(id)
        }
    })()

    programInfoInFlight.set(id, p)
    return p
}
