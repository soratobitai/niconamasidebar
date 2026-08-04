import { thumbnailTtlMs, thumbnailRetryBaseMs, thumbnailRetryMaxMs, thumbnailCrossfadeMs, watchPageBaseUrl, animIngestWaitMaxMs, defaultDwellMinutes } from '../config/constants.js'
import { compareByActivePoint } from '../utils/programOrder.js'
import { totalEngagement, commentWeight, commentRatio, estimateConcurrentViewers } from '../utils/momentum.js'

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
    // 🔴 **URL をここで組み立てるのはニコ生だけ。** Kick は `watchUrl` を持って来る。
    //    `watchPageBaseUrl + 'lv' + id` という規約は Kick には通じないので、
    //    programInfo 側が完成した URL を持つ形にしてある（無ければ従来どおり）。
    const thumbnail_link_url = data.watchUrl || `${watchPageBaseUrl}lv${id}`
    let user_page_url = ''
    if (data.service === 'kick') {
        // Kick の配信者ページ＝チャンネルページ＝番組ページ。分かれていない。
        user_page_url = data.watchUrl || ''
    } else if (owner.id) {
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
    const img = card.querySelector('.program_thumbnail_img')
    if (img && f.thumbnail_url && img.getAttribute('data-src') !== f.thumbnail_url) {
        img.setAttribute('data-src', f.thumbnail_url)
    }

    // 🔴 **表示経路を2本にすること。**
    //
    // ページ再読込では makeProgramElement が storage のURLを img.src へ**直接**入れるので絵が出る。
    // 一方その場更新は長らく img.src を触らない設計だった（「差し替えはループの仕事」）。その結果、
    // 表示を変えられるのは**サムネ更新ループのプリロード経路ただ1本**になっていた。その1本には
    // crossOrigin・②動くサムネへの給餌・TTL・バックオフ・期限表が直列に載っており、どこか1つ
    // 滑ると症状は必ず「更新ボタンは無反応・ページ再読込では出る」になる。実際この形で2回踏んでいる
    // （項目AZ = チャンネルの静止経路 / 項目BA = ②給餌の宙吊り）。穴を塞ぎ続けるのではなく、
    // **経路を分ける**のが根治（doc/09 項目BB）。
    //
    // 触ってよい条件を狭く固定する:
    //   - `thumbLive === '0'` ＝ **いまライブサムネを出せていない**カードだけ。既に出しているカードには
    //     触らない → 「表示中の絵＝②のコマ」（項目AV）を壊さない。
    //     ⚠️ `!== '1'` にしないこと。**未設定は「storage のライブサムネを表示中」を意味する**
    //     （makeProgramElement は `if (!isLiveSrc)` の時だけ '0' を書く＝未設定はライブ表示中）。
    //     `!== '1'` だと、ページ再読込直後の正常なカード全部が毎リスト周期で再代入対象になり、
    //     ②が '1' を立てるまでの間、**カードの数だけ無駄な再取得**が走る。
    //   - `?cache=` は付けない。同一URLなら再代入されないので無駄な再取得も起きない。
    //     「同じURLで中身が変わる」ライブサムネの更新は従来どおりループの仕事。
    // 🔴 **Kick のサムネを差し替える唯一の経路がここ。**
    //
    // Kick はニコ生の localStorage キャッシュに入れていないので、storage 駆動の
    // サムネ更新ループ（`updateThumbnailsFromStorage`）が拾えない。あちらは
    // `infoMap.get(\`lv${card.id}\`)` で引くため、Kick の id では必ず undefined になる。
    //
    // 代わりに、毎周期のリスト更新で来る新しい URL をそのまま反映する。Kick のサムネURLは
    // 画像が更新されるたび `?versionId=` が変わるので、**URL が変わった＝絵が変わった**。
    // 同じ URL なら差し替えない＝無駄なクロスフェードが起きない（ニコ生側では
    // 「同じURLで中身が変わる」ため、この判定は使えなかった）。
    //
    // ⚠️ 下のニコ生用の分岐（thumbLive / バックオフ / storage 前提）へ落とさないこと。
    //    Kick は `isLiveSrc` が真になるので `thumbLive` が未設定で、あの条件には入らない。
    if (img && data.service === 'kick') {
        const next = f.thumbnail_url
        if (next && img.src !== next) crossfadeThumbnail(img, next)
    } else if (img && img.dataset.thumbLive === '0') {
        const best = resolveLiveThumbnailBaseUrl(data) || f.thumbnail_url
        // 🔴 **バックオフ中は触らないこと。** 直接表示はループのバックオフ状態を持っていないので、
        // ここを見ないと**読み込みに失敗し続けるURLをリスト更新のたびに叩き直す**ことになる
        // （実測: チャンネル1件の静止サムネが失敗しており、err が 1→2 と増えていた。項目BC）。
        // 失敗したURLは `handleThumbnailError` が繋ぎ画像へ落とすため、`img.src !== best` は
        // 毎周期成立してしまう＝バックオフを見ないと指数的な間隔が意味を失う。
        const nextTryAt = Number(img.dataset.nextTryAt || 0)
        const backingOff = nextTryAt > 0 && Date.now() < nextTryAt
        if (best && img.src !== best && !backingOff) {
            img.src = best
            img.dataset.thumbLive = '0' // ②のコマではない（最新コマのフリをさせない）
            delete img.dataset.thumbSeq
        }
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

    // メインコンテナ
    const container = document.createElement('div')
    container.id = id
    container.className = 'program_container'
    applyRankAttributes(container, data)

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

    // サービスのラベル。**Kick のカードにだけ付ける**（無印＝ニコ生）。
    // サムネ上に置かない: `.program_thumbnail` には既にクロスフェード層と
    // 動くサムネのオーバーレイが重なっており、3層目は z-index の管理が増えるうえ、
    // 動くサムネの再生中にラベルが覆われる。`.provider` 行は高さが安定していて崩れない。
    // 混在時だけ見せる（タブ分離時はタブ自体がラベルなので CSS で隠す）。
    if (data.service === 'kick') {
        const badge = document.createElement('span')
        badge.className = 'service_badge service_badge_kick'
        badge.textContent = 'Kick'
        providerDiv.appendChild(badge)
    }

    container.appendChild(providerDiv)

    // サムネイルセクション
    const thumbnailDiv = document.createElement('div')
    thumbnailDiv.className = 'program_thumbnail program-card_'
    const thumbnailLink = document.createElement('a')
    thumbnailLink.href = thumbnail_link_url
    // ⚠️ **同じタブで移動する（target は付けない）。**
    //    一時期 Kick だけ別タブにしていたが、kick.com にもサイドバーを注入するようになったので
    //    移動先でも一覧が残る。ニコ生と挙動を揃える（利用者の要望・2026-08-04）。
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
    return estimateConcurrentViewers(data, Date.now(), dwellMinutes)
}

// W（平均滞在時間・分）。推定同接の唯一の調整つまみ。
// 🔴 効き方は2通りある（momentum.js の estimateConcurrentViewers 参照）。
//    「ニコ生と Kick の釣り合い」だけだと思って触らないこと。
let dwellMinutes = defaultDwellMinutes

/**
 * W を差し替える。オプション読み込み時と変更時に main.js から呼ぶ。
 * @param {number|string} value 分
 */
export function setDwellMinutes(value) {
    const v = Number(value)
    dwellMinutes = Number.isFinite(v) && v > 0 ? v : defaultDwellMinutes
}

/**
 * タブ分離モードの表示状態を実態に合わせる。描画のたびに呼ぶ。
 *
 * 🔴 **タブの切り替えで再描画しない。** カードは常に両サービスぶん DOM に入れておき、
 *    `#liveProgramContainer[data-service-tab]` と CSS で出し分ける。
 *    再描画方式にすると、差分更新・FLIP・ソートという最も壊れやすい経路に
 *    「今どのタブか」という条件が増える（doc/09 の警告領域）。
 *
 * @param {HTMLElement} container `#liveProgramContainer`
 * @param {string} mode `options.kickDisplayMode`（'mixed' | 'tabs'）
 * @returns {number} 表示対象のカード数（件数表示に使う）
 */
export function syncServiceTabs(container, mode) {
    const tabs = document.getElementById('serviceTabs')
    if (!container) return 0

    const total = container.children.length
    // Kick のカードが1件も無いならタブを出さない（Kick 無効・未ログイン・放送中0件）。
    const hasKick = !!container.querySelector('.program_container[data-service="kick"]')
    const useTabs = mode === 'tabs' && hasKick

    if (tabs) tabs.hidden = !useTabs

    if (!useTabs) {
        container.removeAttribute('data-service-tab')
        return total
    }

    const activeBtn = tabs && tabs.querySelector('.service_tab.is-active')
    const active = (activeBtn && activeBtn.dataset.serviceTab) || 'nicolive'
    container.setAttribute('data-service-tab', active)
    return countVisibleByTab(container, active)
}

/** タブで表示されるカード数。件数表示が「見えていない番組」を数えないようにする。 */
function countVisibleByTab(container, active) {
    let n = 0
    for (const el of container.children) {
        const svc = el.getAttribute('data-service') || 'nicolive'
        if (active === 'kick' ? svc === 'kick' : svc !== 'kick') n++
    }
    return n
}

/**
 * タブのクリックを配線する。サイドバー挿入後に一度だけ呼ぶ。
 * @param {(count:number)=>void} onCountChange 表示件数が変わった時に呼ぶ
 */
export function setupServiceTabHandlers(onCountChange) {
    const tabs = document.getElementById('serviceTabs')
    if (!tabs || tabs.dataset.wired === '1') return
    tabs.dataset.wired = '1'

    tabs.addEventListener('click', (event) => {
        const btn = event.target.closest('.service_tab')
        if (!btn || btn.classList.contains('is-active')) return

        for (const b of tabs.querySelectorAll('.service_tab')) {
            b.classList.toggle('is-active', b === btn)
        }
        const container = document.getElementById('liveProgramContainer')
        if (!container) return
        const active = btn.dataset.serviceTab || 'nicolive'
        container.setAttribute('data-service-tab', active)
        if (typeof onCountChange === 'function') onCountChange(countVisibleByTab(container, active))
    })
}

/**
 * 人気順が読む属性を**まとめて**書く。カードを作る時と、その場更新の時の両方から呼ぶ。
 *
 * 🔴 **集約してあるのは片方だけ書く事故を構造的に潰すため。** 以前は2箇所で個別に
 * `active-point` と `data-total` を書いており、「片方だけ更新すると同点時の並びが古い値で決まる」
 * という⚠️コメントで守っていた。**思い出して守るガードは、書く場所が増えた時に破れる。**
 * 属性を足したくなったらここへ足すこと（doc/09 項目BE）。
 *
 * - `active-point` … 盛り上がり（第1キー）
 * - `data-total`   … 来場者＋重み付きコメントの累計（同点時の第2キー）
 * - `data-comment-weight` / `data-comment-ratio` … 弾幕補正の実効値。**順位計算には使わない**。
 *   暫定定数を実機で詰めるための覗き窓で、DevTools で要素を見れば効き方が分かる。
 *   定数が固まったらこの2つは消してよい。
 *
 * @param {HTMLElement} el カードのコンテナ
 * @param {Object} data 番組データ
 */
export function applyRankAttributes(el, data) {
    if (!el) return
    // どのサービスの番組か。タブ分離モードの表示切り替え（CSS）とラベル表示が読む。
    el.setAttribute('data-service', (data && data.service) || 'nicolive')
    el.setAttribute('active-point', String(calculateActivePoint(data)))
    // 人気順の第2キー（同点時）。放送開始が新しい方を上にする。
    // 🔴 **`data-total` から差し替えた**（2026-08-04）。累計エンゲージメントはコメントを含むが、
    //    Kick はコメント数を返さないので常に 0 になり、ニコ生と混ぜた時に Kick が必ず下へ沈む。
    //    開始時刻なら両サービスが同じ意味で持っている。
    const beginMs = data && data.onAirTime && data.onAirTime.beginAt ? Date.parse(data.onAirTime.beginAt) : NaN
    el.setAttribute('data-begin-at', Number.isFinite(beginMs) ? String(beginMs) : '0')
    // ⚠️ 以下3つは**順位計算に使っていない**。弾幕補正の効き方を実機で見るための覗き窓。
    //    順位が推定同接へ移行した今、消してよい候補（doc/09 項目BE の後日談）。
    el.setAttribute('data-total', String(Math.round(totalEngagement(data) * 10) / 10))
    el.setAttribute('data-comment-weight', commentWeight(data).toFixed(3))
    el.setAttribute('data-comment-ratio', commentRatio(data).toFixed(2))
}

/**
 * 拡張が無効化された後でも投げない `chrome.runtime.getURL`。
 *
 * 🔴 **この2箇所（handleThumbnailError / syncStaticThumb）が実際に投げていた。**
 * 2026-08-02 に拡張をアンインストールして観測したスタックがこの2つだけを指した。
 * 前者は img の error リスナ、後者は rAF の中なので、投げると **Uncaught** になる。
 * どちらも「ライブサムネを持たない番組がリストに居る回」しか通らないため、
 * その番組が無い構成では0件・1件足すと2件、と再現も切り分けも取れている。
 *
 * 無効化の検知と全ループ停止は checkExtensionAlive の仕事。ここは、
 * 検知が走るまでの隙間（最大1周期）で uncaught を出さないための当て木。
 * @returns {string} 取れなければ空文字
 */
function safeRuntimeUrl(path) {
    try {
        return (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id)
            ? chrome.runtime.getURL(path) : ''
    } catch (_e) {
        return ''
    }
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
        const loading = safeRuntimeUrl('images/loading.gif')
        if (loading) this.src = loading // 取れない＝拡張が無効化済み。今出ている絵をそのまま残す
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
 * 給餌が時間内に返らなかったら1回だけ警告する（鳴る罠）。
 *
 * 上限で倒しているので**表示は無事**だが、②のコマ化が詰まっているサインではある。
 * 黙って倒すと「動くサムネだけ動かない」に気付けないので、1回だけ鳴らす。
 *
 * 🔴 **IndexedDB を疑わせる文面に戻さないこと。** 旧文面はそう書いてあったが、2026-08-02 に
 * 実測して**外れだと確定した**（doc/09 項目BK）。調べる人を確実に空振りさせる:
 *   - 起動時の掃除(cleanupFrames)が読みを塞ぐ説 → 600件（上限の2倍）で走査189ms・裏のget 188ms
 *   - 書き込み量が読みを塞ぐ説 → 35本/秒（現実の10倍・5.25MB/秒）でも get は 6〜15ms
 *   - 実拡張の正常運転90秒（動くサムネON）では **0回**
 * IndexedDB はボトルネックではない。1回きりの警告なので、単発の重い瞬間を拾ったと考えるのが妥当。
 */
let ingestStallWarned = false
function warnIngestStall() {
    if (ingestStallWarned) return
    ingestStallWarned = true
    console.warn(
        `[サムネ] 動くサムネへの給餌が ${animIngestWaitMaxMs}ms 以内に返りませんでした。`
        + '静止サムネはURLで表示します（表示は無事・コマ化は裏で続きます）。'
        + '1回きりならメインスレッドが詰まった瞬間を拾っただけで、対処は不要です。'
        + '毎回出る場合だけ調べてください（IndexedDB は実測で白＝doc/09 項目BK）。'
    )
}

// ---- ライブサムネ差し替え時のクロスフェード ----
// レイヤーごとの進行中フェード。差し替えが続けて来た時に前のを止める（WeakMapなのでカード破棄で自然に消える）。
const thumbFades = new WeakMap()

/**
 * 古い絵を上に載せてから src を差し替え、新しい絵が出せるようになったら上の絵を薄れさせる
 * （＝ライブサムネがふわっと入れ替わる）。
 *
 * 🔴 **覆いと差し替えは同じ処理の中で済ませること（間に await や setTimeout を挟まない）。**
 * 挟むと描画が入りうるので、覆う前に新しい絵が出てしまいフェードが無意味になる。
 * 同期で並んでいる限り**この2行の前後関係自体はどちらでもよい**（次の描画まで画面には出ない）。
 *
 * 🔴 **「新しい絵を上でフェードイン → base へ確定」の向きにしないこと。** 確定処理が何かの理由で
 * 走らないと古い絵が残り続ける＝更新が止まって見える。この向きなら base には常に最新が入っているので、
 * フェードがどう失敗しても最悪「従来どおり瞬時に切り替わる」までしか壊れない。
 *
 * 🔴 **フェードの開始は `decode()` を待つこと。** 待たずに始めると、新しい絵が出るより先に覆いが
 * 薄れて、途中で絵がボンと入れ替わる（ここが「ふわっと」の実質）。
 *
 * @param {HTMLImageElement} img カードの静止サムネ
 * @param {string} next 新しく表示する画像のURL
 */
function crossfadeThumbnail(img, next) {
    const thumb = img.closest ? img.closest('.program_thumbnail') : null
    const prev = img.currentSrc || img.src
    // 覆う絵が無い（初回表示・読込失敗中）ならフェードのしようがない。そのまま差し替える。
    if (!(thumbnailCrossfadeMs > 0) || !thumb || !prev || !img.complete || !img.naturalWidth) {
        img.src = next
        return
    }

    let layer = thumb.querySelector('.thumb_fade_layer')
    if (!layer) {
        layer = document.createElement('img')
        layer.className = 'thumb_fade_layer'
        // 🔴 `alt=""` を外さないこと。フェード後に src を手放すので、次の差し替えでは
        // 「まだ何も読めていない img」を不透明にする瞬間がある。alt が空なら仕様上そこは
        // **何も描かれない**（＝下のベースサムネがそのまま見える＝見た目に変化なし）。
        // alt があると壊れた画像アイコンが全面に一瞬出る。
        layer.alt = ''
        thumb.appendChild(layer)
    }
    // 前回のフェードを先に畳む。アニメーションは style.opacity より強いので、
    // 走ったままだと下の「不透明で覆う」指定が効かない。
    const running = thumbFades.get(layer)
    if (running) {
        clearTimeout(running.safety)
        if (running.anim) running.anim.cancel()
    }
    const state = { anim: null, safety: 0 }
    thumbFades.set(layer, state)

    // ① 古い絵で不透明に覆い、② そのまま差し替える。ここは同期で続けること（上の🔴）。
    layer.style.opacity = '1'
    layer.src = prev
    img.src = next

    // ③ 新しい絵が出せる状態になったら薄れさせ、下の新しい絵を見せる
    let started = false
    const fadeOut = () => {
        if (started || thumbFades.get(layer) !== state) return // 次の差し替えが始まっていたら手を引く
        started = true
        clearTimeout(state.safety)
        layer.style.opacity = '' // CSSの0へ戻し、その間をアニメーションで埋める（fill無しで終了後は0）
        state.anim = layer.animate(
            [{ opacity: 1 }, { opacity: 0 }],
            { duration: thumbnailCrossfadeMs, easing: 'ease' }
        )
        state.anim.finished.then(() => {
            // デコード済み画像を抱えたままにしない（カードの数だけ積み上がる）
            if (thumbFades.get(layer) !== state) return
            layer.removeAttribute('src')
            thumbFades.delete(layer)
        }, () => { /* cancel＝次の差し替えが来た。後始末はそちらの担当 */ })
    }
    // decode を待つのは「新しい絵が出る前に覆いが消えて、切り替わりがボンと見える」のを防ぐため。
    // 🔴 **タイマーの蹴り出しを外さないこと。** タブが非表示だと decode が返らないことがあり、
    // 返らないままだと古い絵で覆ったまま固まる（＝更新が止まって見える）。
    state.safety = setTimeout(fadeOut, thumbnailCrossfadeMs + 1000)
    if (img.decode) img.decode().then(fadeOut, fadeOut)
    else fadeOut()
}

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
    if (img.src !== next) crossfadeThumbnail(img, next)
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
        const loadingUrl = safeRuntimeUrl('images/loading.gif')
        if (!loadingUrl) return              // 拡張が無効化済み。触らず帰る（次の tick で全体が止まる）
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
                    //
                    // 🔴 **表示を②の完了に依存させないこと。** ②は IndexedDB を触るので、別タブとの
                    // 競合などで応答が返らないことがありうる。返らないと applySuccess が呼ばれず、
                    // **そのカードのサムネがページ再読込まで固まる**（更新ボタンも効かない＝doc/09 項目BA）。
                    // 上限を切ってURL表示へ倒す。②のコマ化は裏で続くので次の周期で追いつく。
                    let done = false
                    const show = (frame) => { if (!done) { done = true; applySuccess(frame) } }
                    const guard = setTimeout(() => {
                        if (done) return
                        warnIngestStall()
                        show(null)
                    }, animIngestWaitMaxMs)
                    // Promise.resolve で包むのは、フックの実装が同期値を返しても表示が止まらないようにするため
                    Promise.resolve(animThumbFeed.ingest(card.id, pre))
                        .then((frame) => { clearTimeout(guard); show(frame) })
                        .catch(() => { clearTimeout(guard); show(null) })
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
                                    <!-- タブ分離モードでのみ表示。混在モードと Kick 無効時は hidden。
                                         切り替えは再描画ではなく CSS の出し分けで行う（描画経路に触らないため）。 -->
                                    <div id="serviceTabs" class="service_tabs" hidden>
                                        <button type="button" class="service_tab is-active" data-service-tab="nicolive">ニコ生</button>
                                        <button type="button" class="service_tab" data-service-tab="kick">Kick</button>
                                    </div>
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
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">サムネにマウスを乗せると直近数枚のライブサムネを切り替えてアニメ表示します。（ベータ版：不具合や重い場合はOFFに）<br><br>⚠️ <b>ニコ生の番組のみ。</b>Kick のサムネは配信元が CORS を許可していないため、コマを取り出せません。</span></span>
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
                                <!-- Kick 連携だけは他の設定と置き場所が違う。chrome.permissions.request() は
                                     コンテンツスクリプトから呼べず、この設定 UI はニコ生ページ内の DOM なので
                                     ここでは ON/OFF できない。拡張のオプションページを開く導線だけを置く。 -->
                                <div class="opt-section">
                                    <div class="opt-label opt-title-with-help">
                                        Kick 連携
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">Kick でフォロー中の配信をサイドバーに表示します。kick.com へのアクセス許可が必要なため、拡張機能の設定ページで有効にします。</span></span>
                                    </div>
                                    <div class="opt-external">
                                        <button type="button" id="open_kick_settings" class="opt-external-button">連携設定を開く</button>
                                        <span id="kick_status" class="opt-external-status"></span>
                                    </div>
                                </div>
                                <!-- 以下2つは Kick が有効な時だけ出す。ON/OFF と違って権限を伴わないので、
                                     ここ（サイドバー内）で完結できる。表示/非表示は optionsHandler が
                                     kick:status の応答で切り替える。 -->
                                <div class="opt-section opt-kick-only" hidden>
                                    <div class="opt-label">Kickの表示</div>
                                    <div class="opt-segment">
                                        <input type="radio" id="kickDisplayModeMixed" name="kickDisplayMode" value="mixed"><label for="kickDisplayModeMixed">混ぜる</label>
                                        <input type="radio" id="kickDisplayModeTabs" name="kickDisplayMode" value="tabs"><label for="kickDisplayModeTabs">タブで分ける</label>
                                    </div>
                                </div>
                                <div class="opt-section opt-kick-only" hidden>
                                    <div class="opt-label opt-title-with-help">
                                        ニコ生とのバランス
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">人気順は同時視聴者数で並べます。ニコ生は同時視聴者数を公表していないので、来場者が増えるペースから推定しています。ニコ生が下に沈むと感じたら右へ、上に来すぎるなら左へ。<br>右にするほど、始まったばかりの番組より長く続いている番組が上に来ます。</span></span>
                                    </div>
                                    <div class="opt-segment opt-segment-4">
                                        <input type="radio" id="dwellMinutes5" name="dwellMinutes" value="5"><label for="dwellMinutes5">Kick寄り</label>
                                        <input type="radio" id="dwellMinutes10" name="dwellMinutes" value="10"><label for="dwellMinutes10">標準</label>
                                        <input type="radio" id="dwellMinutes20" name="dwellMinutes" value="20"><label for="dwellMinutes20">ニコ生寄り</label>
                                        <input type="radio" id="dwellMinutes40" name="dwellMinutes" value="40"><label for="dwellMinutes40">かなり</label>
                                    </div>
                                </div>
                            </form>
                        </div>`

    return { sidebarHtml, sidebarLine, optionHtml }
}


