import { mapNotifyboxRowToInfo } from './api.js'
import { isLiveScreenshotUrl } from './followPageSource.js'
import { upsertProgramInfos, getProgramInfos, patchProgramThumbnail } from './storage.js'
import { newProgramFastPollMs } from '../config/constants.js'

/**
 * 【新しく始まった番組を早く出す】ニコ生ページと kick.com の**両方がこれを使う**（doc/09 項目AD・AT・AZ・DF）。
 *
 * notifybox は user番組の新着検知がフォローAPIより **20〜101秒** 速い（2026-07-29 実測）。
 * そこで両方を**和集合**にし、notifybox にしか居ない番組（＝フォローAPIがまだ拾えていない新着）も
 * すぐカードにする。部品は3つで、**3つ揃って初めて「早く・絵つきで」出る**:
 *
 *   1. `mergeProgramSources`       … 和集合を作る（新着は notifybox の行から最小レコードを作る）
 *   2. `seedNewProgramsToStorage`  … 新着の最小レコードを storage に蒔く（3 の前提）
 *   3. `chaseLiveThumbIfYoung`     … 若くてライブサムネが空の番組だけ、詳細APIでライブサムネを取る
 *
 * 🔴 **各ページに写さないこと。** 2026-09-23 まではニコ生ページ（UpdateManager）にしか無く、
 *    kick.com では新着がフォローAPIの拾うまで出なかった（項目DF）。ページごとに違うのは
 *    「詳細APIの聞き方」だけなので、3 はそれを引数で受け取る。
 */

/**
 * 2つの取得元を和集合にする。
 *
 * 優先順位は「フォローAPI の実データ ＞ storage の前回値 ＞ notifybox の最小情報」。
 * notifybox にしか無い番組＝フォローAPIがまだ拾えていない**新着**なので、
 * 詳細が来るまでの間だけ最小レコードのカードを出す（フォローAPIが拾えば本来の姿になる）。
 *
 * ⚠️ storage を読むのは notifybox が取れた周期だけ（`getStored` は必要な時にだけ呼ぶ）。
 *
 * @param {false|Array<any>} notifyList notifybox の notifybox_content（失敗時・権限なし false）
 * @param {null|Array<object>} fetched  フォローAPI の programInfo 配列（失敗時 null）
 * @param {() => Array<object>} getStored storage の programInfo 配列を返す
 * @returns {Array<object>} 表示対象の programInfo 配列
 */
export function mergeProgramSources(notifyList, fetched, getStored) {
    const byId = new Map()
    if (Array.isArray(fetched)) {
        for (const p of fetched) if (p && p.id) byId.set(String(p.id), p)
    }
    if (!Array.isArray(notifyList)) return Array.from(byId.values())

    // フォローAPIが失敗した周期でも、storage の前回値で詳細を補って描画を保つ
    const stored = getStored()
    const storedById = new Map(Array.isArray(stored) ? stored.map((x) => [x.id, x]) : [])
    const now = Date.now()

    notifyList.forEach((row, i) => {
        if (!row || row.id == null) return
        const id = 'lv' + String(row.id).replace(/^lv/, '')
        if (byId.has(id)) return                     // フォローAPI側にあるならそちらが正
        const cached = storedById.get(id)
        if (cached) { byId.set(id, cached); return } // 前回値があれば使う（古くても出す）

        // どこにも詳細が無い＝たった今始まった番組。
        // notifybox は放送開始が新しい順に返すので、その並びを保ったまま
        // 「今この瞬間に始まった」扱いにして新着順の先頭へ置く。
        //
        // ⚠️ **notifybox の行を id と title だけに削らないこと。** 配信者名(community_name)と
        // アイコン(thumbnail_url)と種別(provider_type)も入っている。ここで捨てると、
        // フォローAPIが同じ番組を拾うまでの 20〜101秒＋1周期のあいだ、新着カードが
        // 「配信者名不明・アイコンなし・ローディング画像」で立つ（doc/09 項目AT）。
        const info = mapNotifyboxRowToInfo(row, new Date(now - i).toISOString())
        if (info) byId.set(id, info)
    })
    return Array.from(byId.values())
}

/**
 * notifybox が先に見つけた新番組の最小レコードを storage にも載せる。
 *
 * 【なぜ必要か】ライブサムネの追撃 `chaseLiveThumbIfYoung` は **storage のレコードを
 * 見て動く**。notifybox 由来の番組は storage に居ないので追撃が始まらず、フォローAPIが
 * その番組を返すまで（実測 **20〜101秒**）サムネを取りに行けなかった。
 * ここで種を蒔いておけば、サムネの周期（20秒）が来た時点で詳細APIを叩ける＝
 * フォローAPIを待たずにライブサムネが出る（doc/09 項目AZ）。
 * 次の周期からは `mergeProgramSources` が storage の前回値として拾うので、
 * 開始時刻（並び順）も周期ごとに揺れない。
 *
 * ⚠️ 蒔くのは `_source==='notifybox'`（＝フォローAPIにも storage にも無い正真正銘の新着）だけ。
 *    フォローAPI由来のレコードを上書きしないこと。`mergeProgramSources` の優先順位がそれを保証している。
 * ⚠️ この最小レコードは 来場者0・コメント0 なので、**盛り上がりの計算で「前回値」に使わない**
 *    （0からの差分を急増と誤認する）。`nextMomentum` が `_source` を見て弾いている。
 * @param {Array<object>} programs `mergeProgramSources` の結果
 */
export function seedNewProgramsToStorage(programs) {
    const seeds = programs.filter((p) => p && p._source === 'notifybox')
    if (seeds.length) upsertProgramInfos(seeds)
}

/**
 * 追撃が要る番組か（user・非会員・ライブサムネ空・開始から newProgramFastPollMs 以内）。
 * **判定はここ1箇所。** `chaseLiveThumbIfYoung` も、呼ぶ前に候補を絞る側（kick.com のサムネ周期）も使う。
 * ⚠️ 絞り込みを呼ぶ側で書き直さないこと。条件がずれると、追撃が要る番組を取りこぼす。
 * @param {object|undefined} info storage の programInfo
 * @param {number} [now]
 * @returns {boolean}
 */
export function needsLiveThumbChase(info, now = Date.now()) {
    if (!info || info.providerType !== 'user' || info.isMemberOnly) return false
    const hasLive = info.liveScreenshotThumbnailUrls && info.liveScreenshotThumbnailUrls.middle
    if (hasLive || info.thumbnailUrl) return false // 既にライブサムネあり＝追撃不要
    // beginAt ゲート：開始から newProgramFastPollMs 以内の若い番組だけ追撃（古い/不明は追わない）
    const beginAt = info.onAirTime && info.onAirTime.beginAt
    const startMs = beginAt ? Date.parse(beginAt) : NaN
    return Number.isFinite(startMs) && (now - startMs) < newProgramFastPollMs
}

/**
 * 「user・非会員・ライブサムネ空」かつ beginAt が「若い」番組だけ、詳細APIでライブスクショを
 * 1回追撃し、取れたら storage を更新する（doc/09 項目AZ）。
 * 若さ(newProgramFastPollMs)を過ぎた空番組＝ほぼ固定画像運用とみなし追撃しない
 * （以降はリスト更新の補完に委譲）。旧「8回打ち切り」の代替。
 *
 * @param {string} id 番組ID（数値文字列・lvなし）
 * @param {(liveId: string) => Promise<any|undefined>} fetchDetail 詳細APIの `data` を返す（取れなければ undefined）。
 *   ニコ生ページは `fetchProgramInfo`、kick.com は SW 経由（`nico:programInfo`）を渡す
 * @returns {Promise<boolean>} storage のサムネを書き換えたら true
 */
export async function chaseLiveThumbIfYoung(id, fetchDetail) {
    const infos = getProgramInfos()
    if (!Array.isArray(infos)) return false
    const info = infos.find((i) => i && i.id === `lv${id}`)
    if (!needsLiveThumbChase(info)) return false
    try {
        const detail = await fetchDetail(id)
        if (!detail) return false
        const ss = detail.liveScreenshotThumbnailUrls
        const cand = (ss && (ss.middle || ss.large || ss.small)) || ''
        if (isLiveScreenshotUrl(cand)) {
            // await を跨いだ stale スナップショットの全置換だと、その間にスクレイプが入れた最新の
            // 視聴者数等を巻き戻す(lost update)。サムネ欄だけを最新レコードに再read→マージする。
            return patchProgramThumbnail(id, { liveScreenshotThumbnailUrls: { middle: cand }, large1280x720ThumbnailUrl: cand, thumbnailUrl: cand })
        }
    } catch (_e) { /* 個別失敗は次サイクルで再挑戦（若いうちは） */ }
    return false
}
