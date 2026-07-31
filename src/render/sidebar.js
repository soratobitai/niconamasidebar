import { thumbnailTtlMs, thumbnailRetryBaseMs, thumbnailRetryMaxMs, watchPageBaseUrl } from '../config/constants.js'
import { compareByActivePoint } from '../utils/programOrder.js'
import { initialMomentum, totalEngagement } from '../utils/momentum.js'

/**
 * URL に cache バスターを安全に付与する（既に '?' を含む URL は '&' で繋ぐ）。
 * ライブサムネのプロキシURL（listing-thumbnail.live.nicovideo.jp?image=...&v=...）は既にクエリを持つため、
 * 素朴に `?cache=` を付けると '?' が二重になって壊れる。フォロー中ページ・スクレイプ方式で顕在化する。
 * @param {string} url
 * @param {number|string} ts
 * @returns {string}
 */
function appendCacheParam(url, ts) {
    if (!url) return url
    return url + (url.includes('?') ? '&' : '?') + 'cache=' + ts
}

/**
 * 番組詳細から「ライブサムネのベースURL」を providerType 別に選ぶ（共通ロジック）。
 * user: ライブスクショ(middle) → thumbnailUrl / channel: large1280x720 のみ。
 * ?cache 付与・変更検知キー・会員限定判定は呼び出し側の責務。
 * @param {Object} info - 番組詳細
 * @returns {string|null} ベースURL（該当なしは null＝この番組は定期更新の対象外）
 */
export function resolveLiveThumbnailBaseUrl(info) {
    if (!info) return null
    if (info.providerType === 'user') {
        // user は放送開始直後にスクショが未生成のことがある。その間は thumbnailUrl で繋ぎ、
        // 実体は _fetchLiveThumbIfPendingYoung の追撃で埋まるため、ここのフォールバックは残す。
        return (info.liveScreenshotThumbnailUrls && info.liveScreenshotThumbnailUrls.middle) || info.thumbnailUrl || null
    }
    if (info.providerType === 'channel') {
        // thumbnailUrl へフォールバックしないこと。channel のそれは listing-thumbnail プロキシ経由の
        // 「チャンネルアイコン」であってライブのスクショではない（そもそもニコ生はチャンネル番組に
        // ライブサムネを提供しない＝2026-07-26 に利用者確認。アイコン表示が正しい姿）。更新対象に含めると、
        //   1. 永久に変わらない画像を20秒ごとに取り直す（無駄な通信）
        //   2. このホストは ACAO を返さないので crossOrigin 読みが必ず失敗し、平文で読み直す＝1周期2リクエスト
        //   3. ingest に到達せず、その番組だけ動くサムネが機能しない
        // の3つが同時に起きる（実測: 14番組中1件が毎周期100%失敗）。
        // null を返せば computeNext が nextUrl:null を返し、定期更新から外れる。
        // 初期表示は makeProgramElement が入れた画像がそのまま残るので見た目は変わらない。
        return info.large1280x720ThumbnailUrl || null
    }
    return null
}

/**
 * 番組情報からDOM要素を直接作成（innerHTMLを使用せず、セキュアに）
 * @param {Object} data - 番組データ
 * @param {string} loadingImageURL - ローディング画像のURL
 * @returns {HTMLElement|null} 作成されたDOM要素、またはnull
 */
/**
 * programInfo からカードに出す各フィールドを導出する。
 *
 * **カードの新規生成（makeProgramElement）と、既存カードのその場更新（applyProgramInfoToCard）で
 * 必ずこの1つを使うこと。** 2箇所に同じ導出を書くと、片方だけ直して食い違う
 * （doc/02 設計原則 1-b「同じ事実を2箇所に置かない」）。
 *
 * @param {object} data programInfo
 * @returns {object|null} 導出済みフィールド。data が不正なら null
 */
export function deriveCardFields(data) {
    if (!data || !data.id) return null

    // id は取得元によって 'lv123' / '123' の両方がありうるので、数値部に正規化して扱う
    // （カードのDOM id は数値・視聴URLは lv 付き、という規約はここが唯一の生成点）。
    const id = String(data.id).replace(/^lv/, '')
    const owner = data.contentOwner || {}
    const title = data.title || 'タイトル不明'
    // 「コミュニティ名」ではなく**配信者名**（user はユーザー名 / channel はチャンネル名）。
    // ニコ生のコミュニティ機能は廃止済みで、API のキー名(community_name / providerType:'community')
    // だけがレガシーとして残っている。表示・命名を API の古い語彙に引きずられないこと。
    const provider_name = owner.name || '配信者名不明'
    const icon_url = owner.icon || ''
    const thumbnail_link_url = `${watchPageBaseUrl}lv${id}`
    let user_page_url = ''
    if (owner.id) {
        user_page_url = data.providerType === 'channel'
            ? `https://ch.nicovideo.jp/${owner.id}`
            : `https://www.nicovideo.jp/user/${owner.id}`
    }

    const thumbnail_url = data.thumbnailUrl || ''
    let live_thumbnail_url = ''
    if (data.providerType === 'user') {
        live_thumbnail_url = thumbnail_url
        if (data.liveScreenshotThumbnailUrls && data.liveScreenshotThumbnailUrls.middle) {
            live_thumbnail_url = appendCacheParam(data.liveScreenshotThumbnailUrls.middle, Date.now())
        }
    }
    if (data.providerType === 'channel') {
        live_thumbnail_url = data.large1280x720ThumbnailUrl || thumbnail_url
    }

    return { id, user_page_url, provider_name, thumbnail_link_url, thumbnail_url, icon_url, live_thumbnail_url, title }
}

/**
 * 既存カードに programInfo を反映する（**カードは作り直さない**）。
 *
 * 旧実装は updateSidebar が active-point / data-api-index / タイトル / リンク先の4つしか
 * その場更新していなかった。そのため次の2つが後から埋まらなかった（doc/09 項目AK）:
 *   - 配信者名・アイコン: 生成時に空だった番組（notifybox 先行の新着など）は、後の周期で
 *     フォローAPIが埋めてもカードに反映されず「配信者名不明」で固定される。
 *   - `img[data-src]`（静止サムネの戻り先）: 生成時に `thumbnailUrl` が空だと空文字のまま固定され、
 *     読み込み失敗時に `syncStaticThumb` が `if (!dataSrc) return` で塞がる＝
 *     一度 loading.gif に落ちるとページ再読込まで戻らない。
 *
 * ⚠️ **カードを作り直して解決しないこと。** 要素の再利用が img.dataset の TTL/バックオフ・
 * error リスナ・動くサムネのオーバーレイ・ホバー状態を同時に生かしている（doc/09 R-2 調査）。
 *
 * @param {HTMLElement} card `.program_container`
 * @param {object} data programInfo
 */
export function applyProgramInfoToCard(card, data) {
    if (!card) return
    const f = deriveCardFields(data)
    if (!f) return

    const titleEl = card.querySelector('.program_title')
    if (titleEl && titleEl.textContent !== f.title) titleEl.textContent = f.title

    const linkEl = card.querySelector('.program_thumbnail a')
    if (linkEl && f.thumbnail_link_url && linkEl.getAttribute('href') !== f.thumbnail_link_url) {
        linkEl.href = f.thumbnail_link_url
    }

    // 静止サムネの戻り先。**空→実URL に変わった時に更新されないと復帰経路が塞がったままになる。**
    // img.src（今表示している画像）は触らない。差し替えはサムネ更新ループの仕事。
    const img = card.querySelector('.program_thumbnail_img')
    if (img && f.thumbnail_url && img.getAttribute('data-src') !== f.thumbnail_url) {
        img.setAttribute('data-src', f.thumbnail_url)
    }

    const providerDiv = card.querySelector('.provider')
    if (!providerDiv) return

    const nameEl = providerDiv.querySelector('.provider_name')
    if (nameEl && f.provider_name && nameEl.textContent !== f.provider_name) {
        nameEl.textContent = f.provider_name
        nameEl.title = f.provider_name
    }

    // アイコンは**生成時に空だと要素そのものが作られない**ので、後から挿入する必要がある。
    const existingImg = providerDiv.querySelector('img')
    const existingLink = existingImg && existingImg.parentElement !== providerDiv ? existingImg.parentElement : null
    if (f.icon_url) {
        if (existingImg) {
            if (existingImg.getAttribute('src') !== f.icon_url) existingImg.src = f.icon_url
            if (existingLink && f.user_page_url && existingLink.getAttribute('href') !== f.user_page_url) {
                existingLink.href = f.user_page_url
            }
        } else {
            const iconImg = document.createElement('img')
            iconImg.src = f.icon_url
            let node = iconImg
            if (f.user_page_url) {
                const iconLink = document.createElement('a')
                iconLink.href = f.user_page_url
                iconLink.target = '_blank'
                iconLink.appendChild(iconImg)
                node = iconLink
            }
            providerDiv.insertBefore(node, providerDiv.firstChild) // 名前より前＝生成時と同じ並び
        }
    }
}

export function makeProgramElement(data, loadingImageURL) {
    const f = deriveCardFields(data)
    if (!f) return null
    const { id, user_page_url, provider_name, thumbnail_link_url, icon_url, title } = f
    let { thumbnail_url, live_thumbnail_url } = f

    // サムネ枠に出す画像がライブサムネか（＝この後のフォールバックに落ちていないか）。
    // 動くサムネの末尾スロット判定に使う dataset.thumbLive の初期値になる。
    const isLiveSrc = !!live_thumbnail_url

    // ライブサムネも静止サムネも無い間（放送直後でスクショ未生成／notifybox 先行分）は
    // **配信者アイコン**を繋ぎに出す。ローディング画像はアイコンも無い時の最後の砦。
    //   - 昔ここに出ていたのは notifybox の thumbnail_url（＝ユーザーアイコン）と
    //     詳細APIの thumbnailUrl（＝コミュニティアイコン）だった。後者はコミュニティ廃止で
    //     `comch/community-icon/128x128/404.jpg`（汎用404画像）に変わり、前者は
    //     `_mergeSources` が捨てていたため、ローディング画像に落ちていた（doc/09 項目AT）。
    //   - ⚠️ アイコンは**表示のフォールバックにだけ使うこと**。programInfo.thumbnailUrl 側に
    //     入れると「アイコンをライブサムネとして20秒ごとに取り直す」（doc/09 項目AA）の再発になる。
    if (!live_thumbnail_url) {
        live_thumbnail_url = thumbnail_url || icon_url || loadingImageURL
    }
    if (!thumbnail_url) {
        thumbnail_url = icon_url || loadingImageURL
    }

    const activePoint = calculateActivePoint(data)

    // メインコンテナ
    const container = document.createElement('div')
    container.id = id
    container.className = 'program_container'
    container.setAttribute('active-point', String(activePoint))
    // 人気順の第2キー。静かな番組は勢いが 0 で並ぶので、その中は累計の多い順にする。
    // ⚠️ **active-point を書く所では必ずこれも書くこと**（もう1箇所は updateSidebar のその場更新）。
    container.setAttribute('data-total', String(totalEngagement(data)))

    // 配信者セクション（アイコン＋配信者名）
    const providerDiv = document.createElement('div')
    providerDiv.className = 'provider'

    // 配信者アイコン
    if (icon_url) {
        if (user_page_url) {
            const iconLink = document.createElement('a')
            iconLink.href = user_page_url
            iconLink.target = '_blank'
            const iconImg = document.createElement('img')
            iconImg.src = icon_url
            iconLink.appendChild(iconImg)
            providerDiv.appendChild(iconLink)
        } else {
            const iconImg = document.createElement('img')
            iconImg.src = icon_url
            providerDiv.appendChild(iconImg)
        }
    }

    // 配信者名
    const providerNameDiv = document.createElement('div')
    providerNameDiv.className = 'provider_name'
    providerNameDiv.title = provider_name
    providerNameDiv.textContent = provider_name
    providerDiv.appendChild(providerNameDiv)

    container.appendChild(providerDiv)

    // サムネイルセクション
    const thumbnailDiv = document.createElement('div')
    thumbnailDiv.className = 'program_thumbnail program-card_'
    const thumbnailLink = document.createElement('a')
    thumbnailLink.href = thumbnail_link_url
    const thumbnailImg = document.createElement('img')
    thumbnailImg.className = 'program_thumbnail_img'
    thumbnailImg.src = live_thumbnail_url
    thumbnailImg.setAttribute('data-src', thumbnail_url)
    // 繋ぎのアイコン/ローディング画像を「ライブサムネ」と誤認させない印。動くサムネの末尾スロットが
    // 最新コマのフリでこれを混ぜないようにする（サムネ更新が成功したら applySuccess が '1' に戻す）。
    if (!isLiveSrc) thumbnailImg.dataset.thumbLive = '0'
    // 画像読み込み失敗時のフォールバック（data-src → loading.gif）を配線
    thumbnailImg.addEventListener('error', handleThumbnailError)
    thumbnailLink.appendChild(thumbnailImg)
    thumbnailDiv.appendChild(thumbnailLink)
    container.appendChild(thumbnailDiv)

    // タイトルセクション
    const titleDiv = document.createElement('div')
    titleDiv.className = 'program_title'
    titleDiv.title = title
    titleDiv.textContent = title
    container.appendChild(titleDiv)

    return container
}

/**
 * 番組データから「盛り上がり」（人気順のスコア＝DOM属性 active-point）を取り出す。
 *
 * 実体は **直近の増分レートの指数移動平均**で、計算は `utils/momentum.js`、
 * 更新は `storage.upsertProgramInfos`（前回値と出会う唯一の場所）が行う。ここは読むだけ。
 *
 * `momentum` がまだ無いのは「初回描画」と「notifybox 先行でフォローAPIが未着の新番組」。
 * その場合は開始からの平均レートで代用する（若い番組ではそれが実質そのまま直近レート）。
 *
 * ⚠️ **旧スコア `(来場者+1 + コメント+1) / 経過分` に戻さないこと**（doc/09 項目AY）。
 *   - 「開始からの平均」なので長時間放送が構造的に不利（3時間なら3倍の総数が必要）
 *   - `+1` と「最低1分」で、**空の新番組が実在70件中50件より上**に出ていた
 *   - 経過分が切り上がるたびに階段状に下がるため、**データが変わらなくても順位が動く**
 *     （実測: 2分経過しただけで70件中58件、上位10件でも6件が入れ替わる）
 *
 * @param {Object} data - 番組データ
 * @returns {number} 盛り上がり（1分あたり。非有限時は0）
 */
export function calculateActivePoint(data) {
    if (!data) return 0
    const m = Number(data.momentum)
    if (Number.isFinite(m)) return m
    return initialMomentum(data, Date.now())
}

// サムネイル画像の読み込み失敗時のフォールバック処理。
// makeProgramElement 生成時に各 img へ addEventListener('error', ...) で配線される。
function handleThumbnailError() {
    // 静止imgがライブサムネの読込に失敗し、固定画像(data-src)や loading.gif へ差し替わる＝
    // 「今の静止サムネはライブではない」印。動くサムネの末尾スロットがこの非ライブ画像を
    // 最新のフリで映さないよう thumbLive=0 を立てる（applySuccess で '1' に戻る）。
    this.dataset.thumbLive = '0'
    delete this.dataset.thumbSeq // 表示中の絵はもうコマではない（末尾スロットの誤スキップを防ぐ）
    const dataSrc = this.getAttribute('data-src')
    if (dataSrc && this.src !== dataSrc) {
        this.src = dataSrc
    } else {
        const loading = chrome.runtime.getURL('images/loading.gif')
        this.src = loading
    }
}

// ---- 動くサムネ(②)への給餌フック ----
// ②ON時、①(この通常サムネ更新)のプリロードを crossOrigin で読み、読めた画像を②へ渡す。
// **②はコマ化した画像そのものを返し、①はそれを静止サムネの表示にも使う**（同じ1枚を共有する）。
// main.js が setAnimThumbnailFeed で注入。
// feed = { isEnabled(): boolean, ingest(cardId, HTMLImageElement): Promise<{url,seq}|null> }
let animThumbFeed = null
export function setAnimThumbnailFeed(feed) { animThumbFeed = feed }

/**
 * 静止サムネの表示を確定する。②から画像を受け取れた時はそれを出し、無ければ取得URLを出す。
 *
 * 🔴 **②ON時に URL で表示し直さないこと。** 同じURLでも別リクエストになるため、2回の取得の間に
 * スクショが1枚進むと「画面に出ている絵がアニメのどのコマにも無い」状態になる（doc/09 項目AV）。
 * 同じ画像を出せば、その食い違いは**起こりようがなくなる**（判定で当てにいかない）。
 *
 * blob URL の所有者はこちら。差し替え時に**1世代遅れで** revoke する（表示中のものを消さないため）。
 * @param {HTMLImageElement} img カードの静止サムネ
 * @param {string} url ②から画像を受け取れなかった時に使う取得URL
 * @param {{url:string,seq:number}|null} frame ②が返したコマ（null なら url を使う）
 */
function showThumbnail(img, url, frame) {
    const next = frame && frame.url ? frame.url : url
    if (img.src !== next) img.src = next
    if (frame && frame.url) img.dataset.thumbSeq = String(frame.seq)
    else delete img.dataset.thumbSeq   // URL表示＝コマと同一である保証が無い（末尾スロットに任せる）
    // 1世代前の blob を解放する。直前に表示していたものは、新しい画像のデコード中もまだ画面に出て
    // いるので即 revoke しない（2世代ぶん＝カードあたり最大2枚だけ生かす）。
    const prev = img.dataset.thumbBlobPrev
    if (prev && prev !== next) URL.revokeObjectURL(prev)
    const cur = img.dataset.thumbBlobUrl
    if (cur && cur !== next) img.dataset.thumbBlobPrev = cur
    else delete img.dataset.thumbBlobPrev
    if (frame && frame.url) img.dataset.thumbBlobUrl = frame.url
    else delete img.dataset.thumbBlobUrl
}

/**
 * リストから外れるカードが抱えている blob URL を解放する。
 *
 * 静止サムネに②のコマを出すようになったので、カードは blob URL の所有者になっている。
 * 外れた要素はDOMからも辿れなくなるため、ここで手放さないとページ滞在中ずっと残る
 * （番組が終わるたびに数十KB×2が積み上がる）。`updateSidebar` の差し替え直前に呼ぶ。
 * @param {HTMLElement} card `.program_container`
 */
export function releaseThumbnailBlobs(card) {
    const img = card && card.querySelector ? card.querySelector('.program_thumbnail_img') : null
    if (!img || !img.dataset) return
    for (const k of ['thumbBlobUrl', 'thumbBlobPrev']) {
        const u = img.dataset[k]
        if (u) {
            try { URL.revokeObjectURL(u) } catch (_e) { /* 解放済み等は無視 */ }
            delete img.dataset[k]
        }
    }
    delete img.dataset.thumbSeq
}

export function updateThumbnailsFromStorage(programInfos, options = {}) {
    const force = !!(options && options.force)
    const onComplete = options.onComplete || null
    // 指定時、その id 集合の番組だけ更新する（番組ごと独立更新で使う）。未指定なら全件。
    const onlyIds = (options && options.onlyIds) || null
    // 画像の読み込み(全プリロードが settle)が実際に終わったら1回だけ呼ぶ。番組ごと自己連鎖サイクルが
    // 「作業完了後に次の20秒を張る」ために使う（作業時間ぶん自然にドリフトさせる）。
    const onSettled = (options && options.onSettled) || null
    let settledFired = false
    const fireSettled = () => { if (!settledFired) { settledFired = true; if (onSettled) onSettled() } }
    // Convert to Map for O(1) lookup if array
    const infoMap = Array.isArray(programInfos)
        ? new Map(programInfos.map((i) => [i.id, i]))
        : programInfos

    const container = document.getElementById('liveProgramContainer')
    if (!container) {
        if (onComplete) onComplete()
        fireSettled()
        return
    }
    // コンテナ内の全サムネを対象にする（可視限定の最適化は撤去。
    // DOM再構築時の同期ずれで更新が漏れる不具合を避けるため、常に全imgを更新対象とする）。
    const sourceImgs = Array.from(container.querySelectorAll('.program_thumbnail_img'))
    const now = Date.now()

    // 画像が存在しない場合、即座に完了コールバックを呼ぶ
    if (sourceImgs.length === 0) {
        if (onComplete) onComplete()
        fireSettled()
        return
    }

    let index = 0
    const CHUNK = 50
    let pendingImages = 0 // 画像読み込み待機中の数
    let isCompleted = false // 完了コールバックが呼ばれたかどうか

    function computeNext(info) {
        if (!info) return { nextUrl: null, key: '' }
        if (info.isMemberOnly) return { nextUrl: null, key: 'member' }
        // ベースURL選定は共通ヘルパーに集約（?cache はTTLで間引くためここでは付けない）
        const base = resolveLiveThumbnailBaseUrl(info)
        if (!base) return { nextUrl: null, key: '' }
        // 変更検知キーは providerType 別プレフィックス＋URL
        const prefix = info.providerType === 'channel' ? 'c' : 'u'
        return { nextUrl: base, key: `${prefix}|${base}` }
    }

    /**
     * ライブサムネを持たない番組の `<img>` を、静止サムネ（`data-src`）に追従させる。
     *
     * ライブサムネを持たない番組（**チャンネル番組**など）は `computeNext` が null を返して
     * 定期更新の対象から外れるため、この img に触れる経路が他に無い。しかも
     * `applyProgramInfoToCard` は仕様として `img.src` を触らない（差し替えはこのループの仕事）。
     * つまり **ここが唯一の表示経路**である。
     *
     * 🔴 **「loading.gif の時だけ戻す」にしないこと。** 以前はそう書いてあり、繋ぎ画像を
     * loading.gif から配信者アイコンへ変えた瞬間に条件が成立しなくなって、
     * **チャンネル番組の絵がページを再読込するまで永久に出なくなった**（doc/09 項目AZ。
     * 実測: 改修前は58秒で表示 → 改修後は出ない・更新ボタンも効かない・リロードで出る）。
     * 「今なにを表示しているか」ではなく「**出すべき絵と違うか**」で判断すること。
     *
     * 壊れたURLを毎周期叩かないよう、プリロード経路と同じ dataset バックオフに乗せる。
     * ただし **data-src が別のURLに変わった時は仕切り直す**（前のURLの失敗回数を引き継がない）。
     */
    function syncStaticThumb(img) {
        const dataSrc = img.getAttribute('data-src')
        if (!dataSrc) return
        const loadingUrl = chrome.runtime.getURL('images/loading.gif')
        if (dataSrc === loadingUrl) return   // 出す先が無い（元から静止サムネ不明）
        if (img.src === dataSrc) return      // 既に出している
        if (img.dataset.staticTried === dataSrc) {
            // 同じURLで失敗を繰り返している間はバックオフ
            const nextTryAt = Number(img.dataset.nextTryAt || 0)
            if (nextTryAt && Date.now() < nextTryAt) return
            const errors = Number(img.dataset.errors || 0) + 1
            img.dataset.errors = String(errors)
            img.dataset.nextTryAt = String(Date.now() + Math.min(thumbnailRetryMaxMs, thumbnailRetryBaseMs * Math.pow(2, errors - 1)))
        } else {
            // 出すべき絵が変わった＝新しい挑戦。前のURLの失敗回数は持ち越さない
            img.dataset.staticTried = dataSrc
            img.dataset.errors = '0'
            img.dataset.nextTryAt = '0'
        }
        img.src = dataSrc
        img.dataset.thumbLive = '0' // ライブサムネではない（動くサムネが最新コマとして混ぜない）
        delete img.dataset.thumbSeq
    }

    function checkComplete() {
        // 全ての画像処理が完了した場合（onComplete はローディング表示用＝画像読み込みは待たない）
        if (!isCompleted && index >= sourceImgs.length) {
            isCompleted = true
            if (onComplete) onComplete()
        }
        maybeSettled()
    }
    // 「処理も画像読み込みも全て終わった(settle)」ら onSettled を発火する（onComplete と違い読み込み完了を待つ）。
    function maybeSettled() {
        if (isCompleted && pendingImages <= 0) fireSettled()
    }

    function tick() {
        const end = Math.min(index + CHUNK, sourceImgs.length)
        for (; index < end; index++) {
            const img = sourceImgs[index]
            if (!img) continue;
            
            const card = img.closest('.program_container')
            if (!card || !card.id) continue;
            // ローリング更新: 対象外の番組はスキップ（全体を1周期で番組ごとにずらして更新する）
            if (onlyIds && !onlyIds.has(card.id)) continue;

            const info = infoMap.get(`lv${card.id}`)

            const { nextUrl, key } = computeNext(info)
            if (!nextUrl) {
                syncStaticThumb(img) // 更新対象外の番組は、ここだけが静止サムネを出す経路
                continue
            }

            // TTL: 直近成功から一定時間は更新しない（キー変化時は除く）
            if (!force) {
                const lastSuccessAt = Number(img.dataset.lastSuccessAt || 0)
                if (img.dataset.key === key && lastSuccessAt && (now - lastSuccessAt) < thumbnailTtlMs) {
                    continue
                }
            }

            // バックオフ: 失敗が続いている間は次回許可時刻までスキップ
            if (!force) {
                const nextTryAt = Number(img.dataset.nextTryAt || 0)
                if (nextTryAt && now < nextTryAt) continue
            }

            // 事前プリロードして成功したときのみ差し替え（失敗時はバックオフ）
            pendingImages++
            const urlForAttempt = key.startsWith('u|') ? appendCacheParam(nextUrl, now) : nextUrl
            // 成功時の共通処理（表示差替え＋成功記録）。
            // ローディング完了は処理の開始完了で判定し、画像読み込みはバックグラウンドで継続（checkComplete()は呼ばない）。
            // frame: ②が返したコマ（null なら取得URLで表示）。showThumbnail 参照。
            const applySuccess = (frame) => {
                showThumbnail(img, urlForAttempt, frame)
                img.dataset.key = key
                img.dataset.errors = '0'
                img.dataset.nextTryAt = '0'
                img.dataset.lastSuccessAt = String(Date.now())
                // 静止imgは「ライブサムネ」を表示中。動くサムネの末尾スロット判定に使う
                // （error フォールバックで固定画像/loading.gif になっていない印）。
                img.dataset.thumbLive = '1'
            }
            // 失敗時のバックオフ記録（表示は handleThumbnailError／現状維持に任せ、次周期まで維持）。
            const applyBackoff = () => {
                const errors = Number(img.dataset.errors || 0) + 1
                const delay = Math.min(thumbnailRetryMaxMs, thumbnailRetryBaseMs * Math.pow(2, errors - 1))
                img.dataset.errors = String(errors)
                img.dataset.nextTryAt = String(Date.now() + delay)
            }
            // 動くサムネON時は crossOrigin で読み、読めた画像を②へ給餌（②の自前取得＝二重通信を止める）。
            // CORSで読めない環境でも表示は守るため、失敗時は平文で読み直して表示だけ確保する。
            const feeding = !!(animThumbFeed && animThumbFeed.isEnabled())
            const pre = new Image()
            if (feeding) pre.crossOrigin = 'anonymous'
            pre.onload = () => {
                pendingImages--
                if (feeding) {
                    // 再取得なしでフレーム化し、**そのコマをそのまま静止サムネにも出す**
                    // （②側でON/汚染を再判定し、渡せない時は null が返る＝URL表示へ）。
                    // 表示確定が toBlob のぶん数十ms遅れるが、pending/settled はここで先に解消しておく。
                    // Promise.resolve で包むのは、フックの実装が同期値を返しても表示が止まらないようにするため
                    Promise.resolve(animThumbFeed.ingest(card.id, pre))
                        .then((frame) => applySuccess(frame))
                        .catch(() => applySuccess(null))
                } else {
                    applySuccess(null)
                }
                maybeSettled()
            }
            pre.onerror = () => {
                if (feeding) {
                    // crossOriginで失敗 → 表示だけは平文で確保（②へは渡さない）。pendingは平文側で解消。
                    const plain = new Image()
                    plain.onload = () => { pendingImages--; applySuccess(null); maybeSettled() }
                    plain.onerror = () => { pendingImages--; applyBackoff(); maybeSettled() }
                    plain.src = urlForAttempt
                    return
                }
                pendingImages--
                applyBackoff()
                maybeSettled()
            }
            pre.src = urlForAttempt
        }
        if (index < sourceImgs.length) {
            requestAnimationFrame(tick)
        } else {
            // 全ての処理が完了（ただし、画像読み込みはまだ進行中かもしれない）
            checkComplete()
        }
    }

    // 最初のtick呼び出し
    requestAnimationFrame(() => {
        tick()
        // 最初のtick実行後、更新対象がない（全てスキップされた）場合も完了とみなす
        checkComplete()
    })
}

export function sortProgramsByActivePoint(container) {
    const programs = Array.from(container.getElementsByClassName('program_container'))
    // 比較器は utils/programOrder.js が唯一の定義。ここに書き直さないこと。
    programs.sort(compareByActivePoint)
    programs.forEach((program) => container.appendChild(program))
}

/**
 * FLIP アニメーションで並べ替えを滑らかに見せる。
 * reorderFn の中で container の子要素を「同期的に」並べ替えること（appendChild 等）。
 * 位置が変わった要素だけを旧位置から新位置へスライドさせる。
 * @param {HTMLElement} container - 並べ替え対象のコンテナ
 * @param {Function} reorderFn - 実際の並べ替えを行う関数（同期実行）
 * @param {number} [duration=300] - アニメーション時間(ms)
 */
export function flipReorder(container, reorderFn, duration = 300) {
    if (!container || typeof reorderFn !== 'function') {
        if (typeof reorderFn === 'function') reorderFn()
        return
    }

    // First: 並べ替え前の各要素の位置を記録
    const firstRects = new Map()
    Array.from(container.children).forEach((el) => {
        firstRects.set(el, el.getBoundingClientRect())
    })

    // Last: 並べ替えを実行（同期）
    reorderFn()

    // Invert: 旧位置へ戻す（トランジション無しで瞬間移動）
    const moved = []
    Array.from(container.children).forEach((el) => {
        const first = firstRects.get(el)
        if (!first) return
        const last = el.getBoundingClientRect()
        const dx = first.left - last.left
        const dy = first.top - last.top
        if (dx === 0 && dy === 0) return
        el.style.transition = 'none'
        el.style.transform = `translate(${dx}px, ${dy}px)`
        moved.push(el)
    })

    if (moved.length === 0) return

    // 強制リフローで Invert 状態を確定させる
    void container.offsetWidth

    // Play: 新位置へスライド
    requestAnimationFrame(() => {
        moved.forEach((el) => {
            el.style.transition = `transform ${duration}ms ease`
            el.style.transform = ''
        })
    })

    // 後始末: アニメーション終了後にインラインスタイルを除去
    setTimeout(() => {
        moved.forEach((el) => {
            el.style.transition = ''
            el.style.transform = ''
        })
    }, duration + 60)
}

export function buildSidebarShell({ reloadImageURL, optionsImageURL }) {
    const sidebarHtml = `<div id="sidebar" class="sidebar_transition">
                            <div id="sidebar_container">
                                <div class="sidebar_header">
                                    <div class="sidebar_header_item">
                                        <a href="https://live.nicovideo.jp/follow" title="フォロー中の番組ページへ">
                                            フォロー中の番組
                                            <div id="program_count"></div>
                                        </a>
                                    </div>
                                    <div class="sidebar_header_item">
                                        <div class="sidebar_header_item_col" id="reload_programs" title="更新">
                                            <img src='${reloadImageURL}' alt="更新">
                                        </div>
                                        <div class="sidebar_header_item_col" id="setting_options" title="オプション">
                                            <img src='${optionsImageURL}' alt="オプション">
                                        </div>
                                    </div>
                                </div>
                                <div class="sidebar_body">
                                    <div id="api_error">
                                        <a href="https://account.nicovideo.jp/login">ログイン</a>
                                    </div>
                                    <div id="optionContainer"></div>
                                    <div id="liveProgramContainer"></div>
                                </div>
                            </div>
                        </div>`

    const sidebarLine = `<div id="sidebar_line"><div id="sidebar_button"><div id="sidebar_arrow"></div></div></div>`

    const optionHtml = `<div class="container">
                            <div class="settings_header">
                                <h1>設定</h1>
                                <button type="button" id="settings_close" class="settings_close" title="番組リストに戻る" aria-label="閉じる">×</button>
                            </div>
                            <form id="optionForm">
                                <div class="opt-section">
                                    <div class="opt-label">表示順序</div>
                                    <div class="opt-segment">
                                        <input type="radio" id="programsSort1" name="programsSort" value="newest"><label for="programsSort1">新着順</label>
                                        <input type="radio" id="programsSort2" name="programsSort" value="active"><label for="programsSort2">人気順</label>
                                    </div>
                                </div>
                                <div class="opt-section">
                                    <div class="opt-label opt-title-with-help">
                                        自動更新
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">番組リストを指定秒数で自動更新します。（更新ボタンで手動更新も可）<br>サムネイルはこの設定と関係なく自動更新されます（20〜60秒）。</span></span>
                                    </div>
                                    <!-- id は値ベース（旧: updateProgramsInterval1〜3 の連番）。選択肢を増やした時に
                                         連番だと意味がずれ、検証スクリプトの「60秒に設定できた」が黙って別の値を
                                         押すようになるため。増減しても意味が動かない値ベースにしてある。 -->
                                    <div class="opt-segment opt-segment-4">
                                        <input type="radio" id="updateProgramsInterval30" name="updateProgramsInterval" value="30"><label for="updateProgramsInterval30">30秒</label>
                                        <input type="radio" id="updateProgramsInterval60" name="updateProgramsInterval" value="60"><label for="updateProgramsInterval60">60秒</label>
                                        <input type="radio" id="updateProgramsInterval120" name="updateProgramsInterval" value="120"><label for="updateProgramsInterval120">120秒</label>
                                        <input type="radio" id="updateProgramsInterval180" name="updateProgramsInterval" value="180"><label for="updateProgramsInterval180">180秒</label>
                                    </div>
                                </div>
                                <div class="opt-section">
                                    <div class="opt-label opt-title-with-help">
                                        オートオープン
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">ページを開いた時にサイドバーを自動で開くか。「記憶」は前回の開閉状態を復元します。</span></span>
                                    </div>
                                    <div class="opt-segment">
                                        <input type="radio" id="autoOpen1" name="autoOpen" value="1"><label for="autoOpen1">ON</label>
                                        <input type="radio" id="autoOpen2" name="autoOpen" value="2"><label for="autoOpen2">OFF</label>
                                        <input type="radio" id="autoOpen3" name="autoOpen" value="3"><label for="autoOpen3">記憶</label>
                                    </div>
                                </div>
                                <div class="opt-section">
                                    <div class="opt-label opt-title-with-help">
                                        自動移動
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">視聴中の番組終了後、サイドバー先頭の番組へ自動で移動します。</span></span>
                                    </div>
                                    <div class="opt-segment">
                                        <input type="radio" id="autoNextProgramOff" name="autoNextProgram" value="off"><label for="autoNextProgramOff">OFF</label>
                                        <input type="radio" id="autoNextProgramOn" name="autoNextProgram" value="on"><label for="autoNextProgramOn">ON</label>
                                    </div>
                                </div>
                                <div class="opt-section">
                                    <div class="opt-label opt-title-with-help">
                                        動くサムネ<span class="opt-beta-badge">β版</span>
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">サムネにマウスを乗せると直近数枚のライブサムネを切り替えてアニメ表示します。（ベータ版：不具合や重い場合はOFFに）</span></span>
                                    </div>
                                    <div class="opt-segment">
                                        <input type="radio" id="animatedThumbnailOff" name="animatedThumbnail" value="off"><label for="animatedThumbnailOff">OFF</label>
                                        <input type="radio" id="animatedThumbnailOn" name="animatedThumbnail" value="on"><label for="animatedThumbnailOn">ON</label>
                                    </div>
                                </div>
                                <div class="opt-section">
                                    <div class="opt-label">テーマ</div>
                                    <div class="opt-segment">
                                        <input type="radio" id="sidebarThemeLight" name="sidebarTheme" value="light"><label for="sidebarThemeLight">ライト</label>
                                        <input type="radio" id="sidebarThemeDark" name="sidebarTheme" value="dark"><label for="sidebarThemeDark">ダーク</label>
                                    </div>
                                </div>
                            </form>
                        </div>`

    return { sidebarHtml, sidebarLine, optionHtml }
}


