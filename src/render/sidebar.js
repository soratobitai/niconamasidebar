import { elapsedTickMs, thumbnailTtlMs, thumbnailRetryBaseMs, thumbnailRetryMaxMs, thumbnailCrossfadeMs, watchPageBaseUrl, animIngestWaitMaxMs, defaultDwellMinutes, autoUpdateOffValue, fallbackUpdateIntervalSec } from '../config/constants.js'
import { compareByActivePoint } from '../utils/programOrder.js'
import { getWatchPoints, ownerKeyOf } from '../services/watchHistory.js'
import { formatElapsed } from '../ui/elapsedTime.js'
import { estimateConcurrentViewers } from '../utils/momentum.js'

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
/**
 * 番組データ → カードの DOM id。**これが唯一の定義。**
 *
 * id は取得元によって 'lv123' / '123' の両方がありうるので、数値部へ正規化する
 * （カードの DOM id は数値・視聴URLは lv 付き、という規約）。Kick は 'k123' 形式で
 * lv が付かないため素通りする。
 *
 * 🔴 **既存カードを引き当てる側も必ずこれを通すこと。** 生の `data.id` で
 *    `getElementById` / Map を引くと、ニコ生の番組だけ毎回「見つからない」＝
 *    **毎周期カードを作り直す**ことになる。要素が作り直されると画像も読み直され、
 *    リスト全体が一瞬チラつく（2026-08-04・kick.com ページで実際に発生。
 *    35枚中23枚が毎周期「新規」になっていた）。例外もログも出ない壊れ方なので、
 *    手書きで `.replace(/^lv/, '')` を書き足さないこと。→ 検査項目 BM
 */
export function cardIdOf(data) {
    return String((data && data.id) || '').replace(/^lv/, '')
}

/**
 * 更新ボタンのローディング表示。**両ページ共通の唯一の実装。**
 *
 * ニコ生ページは LoadingManager（セッション所有権つき）から、kick.com ページは
 * `refreshPrograms` から呼ぶ。見た目とクリック無効化がずれないよう、DOM を触るのはここだけ。
 */
export function setReloadButtonLoading(isLoading) {
    const btn = document.getElementById('reload_programs')
    if (!btn) return
    if (isLoading) {
        if (btn.classList.contains('loading')) return
        btn.classList.add('loading')
        btn.style.pointerEvents = 'none'
    } else {
        if (!btn.classList.contains('loading')) return
        btn.classList.remove('loading')
        btn.style.pointerEvents = ''
    }
}

/**
 * 起動時にサイドバーを開くか。「自動で開く」設定の解釈は**ここが唯一の定義**。
 *   '1' = 常に開く / '2' = 常に閉じる / '3' = 前回の状態を記憶
 */
export function shouldOpenSidebarAtStart(opts) {
    if (!opts) return false
    return (opts.autoOpen == '1') || (opts.autoOpen == '3' && !!opts.isOpenSidebar)
}

/**
 * 自動更新の間隔（ミリ秒）。**OFF の時は `null` を返す。**「自動更新」設定の解釈はここが唯一の定義。
 *
 * 🔴 **呼び出し側で `Number(options.updateProgramsInterval)` してはいけない。**
 *    保存値は 'off' を取りうるので `Number('off')` は **NaN**。NaN を `setTimeout` /
 *    `setInterval` に渡すと **0ms 扱い**になり、止めたつもりが最速で API を叩き続ける。
 *    `|| 120` で受けると今度は **OFF が 120秒として動く**（止まらない）。
 *    どちらも無言で壊れるので、判定はこの1箇所に集める。
 *
 * ⚠️ **返すのは「ミリ秒」か `null` だけ。** 0 や Infinity を返さないこと。
 *    0 は最速ループ、Infinity は `setTimeout` に渡すと 0 に丸められる（どちらも同じ事故になる）。
 *
 * @returns {number|null} 間隔(ms)。OFF なら null（＝タイマーを張らない）
 */
export function autoUpdateIntervalMs(opts) {
    const raw = opts && opts.updateProgramsInterval
    if (String(raw) === autoUpdateOffValue) return null
    const sec = Number(raw)
    // 壊れた保存値・未設定はここで既定へ寄せる。**NaN を外へ出さない。**
    if (!Number.isFinite(sec) || sec <= 0) return fallbackUpdateIntervalSec * 1000
    return sec * 1000
}

export function deriveCardFields(data) {
    if (!data || !data.id) return null

    const id = cardIdOf(data)
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
 * 繋ぎ画像（配信者アイコン）を img に覚えさせる。**書く場所はこの関数だけ。**
 *
 * 🔴 **`data-src` と兼用にしないこと**（doc/09 項目CD-2）。あちらは「戻り先の静止サムネ」で、
 *    Kick とニコ生の user 番組では**ライブサムネと同じURL**になる。兼用にすると、
 *    そのURLが読めない時に繋ぎ先が自分自身を指し、`handleThumbnailError` が
 *    最後の砦（ローディング画像）へ直行する。別の場所に持てば失敗しても必ずアイコンへ落ちる。
 *
 * 生成時（`makeProgramElement`）と後埋め（`applyProgramInfoToCard`）の両方から呼ぶ。
 * アイコンが未着の間は**書かない**（空文字を入れると「アイコン無し」と区別が付かない）。
 */
function setFallbackThumbSrc(img, iconUrl) {
    if (!img || !iconUrl) return
    if (img.getAttribute('data-fallback-src') !== iconUrl) img.setAttribute('data-fallback-src', iconUrl)
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
    //
    // 🔴 **繋ぎ画像（配信者アイコン）もここで面倒を見ること**（2026-08-08・doc/09 項目CD）。
    //    以前は `f.thumbnail_url`（＝生の `thumbnailUrl`）だけを見ていた。
    //    **放送直後の Kick はサムネも配信者アイコンも空**で来ることがあり、その時に作られた
    //    カードは `data-src` が loading.gif で固定される。次の周期でアイコンが埋まっても
    //    `f.thumbnail_url` は空のままなので**ここが素通りし、ローディング画像が残り続けた。**
    //    「サムネが無い間はアイコンを出す」という決まりが `makeProgramElement` にしか
    //    書かれておらず、**同じ計算が2箇所にあって片方だけ欠けている**形だった。
    const img = card.querySelector('.program_thumbnail_img')
    if (img) {
        // 後から届いたアイコンを繋ぎ画像として覚えさせる（生成時に空だった番組の分）。
        setFallbackThumbSrc(img, f.icon_url)

        const wantDataSrc = f.thumbnail_url || f.icon_url
        if (wantDataSrc && img.getAttribute('data-src') !== wantDataSrc) {
            img.setAttribute('data-src', wantDataSrc)
        }

        // ⚠️ 今ローディング画像を出しているなら、その場で繋ぎ画像へ替える。
        //    `syncStaticThumb` は**ライブサムネを持たない番組にしか回らない**ので、
        //    Kick（providerType:'user'＝ライブサムネあり扱い）はここで替えないと次の取得まで残る。
        //
        // 🔴 **`data-src` が変わった時だけ、にしないこと**（doc/09 項目CD-2）。
        //    以前はこの入れ替えが `data-src` 更新の if の中にあった。**Kick のサムネURLは
        //    放送開始直後から最後まで同じ**なので `data-src` は初回から変わらず、
        //    一度ローディング画像に落ちたカードは**次の周期でも素通りして戻らなかった。**
        //
        // 🔴 **替える先は `wantDataSrc` ではなくアイコン。** ローディングが出ている＝
        //    そのサムネURLは読めなかったということなので、同じURLをここで入れ直すと
        //    また失敗する（読み直しはバックオフを持っているサムネ更新ループの仕事）。
        //
        // ⚠️ **アイコンが無い番組をここで拾わなくてよい。**（2026-08-10・空振り検査で確認）
        //    「アイコンを持たない配信者の、後からサムネURLが届いたカード」は、
        //    **すぐ下の直接表示（`thumbLive === '0'`）が同じ呼び出しの中で拾う**。
        //    ここで `wantDataSrc` も見るようにすると**同じ仕事の書き手が2人**になり、
        //    しかもこちらはバックオフを見ないので、失敗中のURLを叩き直す側に回る。
        const loadingUrl = safeRuntimeUrl('images/loading.gif')
        if (loadingUrl && f.icon_url && img.getAttribute('src') === loadingUrl) {
            img.src = f.icon_url
            img.dataset.thumbLive = '0' // ライブサムネではない（動くサムネが最新コマとして混ぜない）
            delete img.dataset.thumbSeq
        }
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
    // ⚠️ **Kick 専用の差し替え経路はここに置かない（2026-08-04 に一度置いて外した）。**
    //    Kick も `updateThumbnailsFromStorage` の対象になったので、サムネの差し替えは
    //    あちらの仕事。ここで別途 `img.src` を書くと**書き手が2人**になり、
    //    ループが出した動くサムネのコマをリスト更新のたびに上書きしてしまう。
    if (img && img.dataset.thumbLive === '0') {
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
    // 繋ぎ画像は `data-src` と**別に**持たせる。Kick はライブサムネと静止サムネが同じURLなので、
    // 兼用だと読めなかった時に繋ぎ先が自分自身になる（doc/09 項目CD-2）。
    setFallbackThumbSrc(thumbnailImg, icon_url)
    // 繋ぎのアイコン/ローディング画像を「ライブサムネ」と誤認させない印。動くサムネの末尾スロットが
    // 最新コマのフリでこれを混ぜないようにする（サムネ更新が成功したら applySuccess が '1' に戻す）。
    if (!isLiveSrc) thumbnailImg.dataset.thumbLive = '0'
    // 画像読み込み失敗時のフォールバック（data-src → loading.gif）を配線
    thumbnailImg.addEventListener('error', handleThumbnailError)
    thumbnailLink.appendChild(thumbnailImg)
    thumbnailDiv.appendChild(thumbnailLink)

    // 同時視聴者数（ニコ生は推定・Kick は実測）をサムネの左上に重ねる。
    // ⚠️ 中身は applyRankAttributes が書く（順位に使うのと同じ値＝表示と並びがずれない）。
    //    生成時はそれより後なので、ここで一度埋める。
    const viewerOverlay = document.createElement('span')
    viewerOverlay.className = 'viewer_overlay'
    viewerOverlay.textContent = formatViewers(calculateActivePoint(data))
    thumbnailDiv.appendChild(viewerOverlay)

    // 放送開始からの経過時間をサムネの右下に重ねる（doc/09 項目CX）。
    // ⚠️ 中身は applyRankAttributes が書く（同接と同じ扱い＝書き手を増やさない）。
    // 🔴 **生成時はここで一度埋めること。** `applyRankAttributes` はこの関数の**先頭**で
    //    走っており、その時点ではまだこの span が親に付いていないので何も書けない。
    //    埋めないと ticker（30秒）か次のリスト更新（最大120秒）まで空欄のままになる
    //    ―― 実際にそうなって「表示されるまで時間がかかる」と報告された（2026-08-12）。
    //    すぐ上の視聴点数バッジに同じ注意書きがあるのに、同じ失敗をした。
    const elapsedOverlay = document.createElement('span')
    elapsedOverlay.className = 'elapsed_overlay'
    elapsedOverlay.textContent = formatElapsed(
        data && data.onAirTime && data.onAirTime.beginAt ? Date.parse(data.onAirTime.beginAt) : NaN,
        Date.now(),
    )
    thumbnailDiv.appendChild(elapsedOverlay)

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
 * ⚠️ **名前が実体と合っていない。** 2026-08-04 に第1キーが「勢い」から**推定同時視聴者数**へ
 *    変わったので、返すのは人数（`estimateConcurrentViewers`）。属性名 `active-point` ともども
 *    改名候補だが、CSS・検査・保存済みDOMが読む名前なので据え置いている。
 *
 * 計算は `utils/momentum.js` の1本の式（doc/09 項目CQ）。材料の来場者履歴を書くのは
 * `storage.upsertProgramInfos`（新旧が出会う唯一の場所）で、ここは読むだけ。
 *
 * 🔴 **`Date.now()` をここで渡している。** 推定は時刻の関数なので、**取得が無くても描画のたびに
 *    値が変わる**（古い到着ほど軽くなるため）。取得が止まっている間の凍結は
 *    `estimateFromArrivals` 側が見ている。ここで時刻を細工しないこと。
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
    // 🔴 **W は固定**（2026-08-12・doc/09 項目CU）。設定から差し替える経路は廃止した。
    //    同接を画面に出す以上、あれは「推定値」であって好みで動かすつまみではない。
    //    ⚠️ ここに可変の状態を戻さないこと。戻すと、保存値を持つ環境だけ数字が変わる。
    return estimateConcurrentViewers(data, Date.now(), defaultDwellMinutes)
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
 * @param {string} [activeTab] `options.kickActiveTab`（'nicolive' | 'kick'）。
 *   **保存された選択を復元するために渡す。**渡さないと、描画のたびに DOM の現状を見るので、
 *   カードが作り直された時にニコ生側へ戻ってしまう。
 * @returns {number} 表示対象のカード数（件数表示に使う）
 */
/**
 * タブ分離モードで選べるタブ。**HTML の data-service-tab とここが唯一の対応表。**
 * 'mixed' は「統合」＝両サービスを混ぜて全件出す（設定の「統合表示」と同じ見え方）。
 * ⚠️ 並びは表示順と揃えてある（一番左が統合）。
 */
const SERVICE_TABS = ['mixed', 'nicolive', 'kick']

/** ニコ生の案内の種類。**この3つ以外を渡さないこと**（知らない値は「出さない」に倒す）。 */
export const NICO_NOTICE_NONE = 'none'
export const NICO_NOTICE_AUTH = 'auth'              // 401/403。ログインを勧めてよい
export const NICO_NOTICE_UNREACHABLE = 'unreachable' // それ以外。メンテナンス・通信断・仕様変更

/**
 * ニコ生の案内を出す／消す。**この表示を触るのはここだけ**（両ページ共通）。
 *
 * 🔴 **「ログイン」と「接続できません」を取り違えないこと**（doc/09 項目CH）。
 *    メンテナンス中に「ログイン」を出すと、落ちているログインページへ誘導することになる。
 *
 * @param {'none'|'auth'|'unreachable'} kind
 */
export function setNicoNotice(kind) {
    const box = document.getElementById('api_error')
    if (!box) return
    const auth = kind === NICO_NOTICE_AUTH
    const down = kind === NICO_NOTICE_UNREACHABLE
    // ⚠️ 中身が両方隠れているのに枠だけ出すと、**空の余白**が見出しの下に残る。
    box.style.display = (auth || down) ? 'block' : 'none'
    const authEl = document.getElementById('api_error_auth')
    const downEl = document.getElementById('api_error_down')
    if (authEl) authEl.hidden = !auth
    if (downEl) downEl.hidden = !down
}

/**
 * Kick のログイン切れの案内を出す／消す。**この表示を触るのはここだけ。**
 *
 * ニコ生ページ（UpdateManager）と kick.com（refreshProgramsInner）の両方から、
 * 取得のたびに呼ぶ。**毎周期 true/false を渡し切る**こと。片方向だけ（出す時だけ呼ぶ）に
 * すると、ログインし直しても案内が残る。
 *
 * @param {boolean} show
 */
export function setKickNotice(show) {
    const el = document.getElementById('kick_notice')
    if (!el) return
    el.hidden = !show
}

export function syncServiceTabs(container, mode, activeTab) {
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

    // 保存された選択があればそれを正とし、無ければ今のボタンの状態を使う。
    // ⚠️ 知らない値は採用しない。保存値が壊れていた時に、どのタブとも一致しない
    //    `data-service-tab` が付いて**カードが1枚も見えなくなる**のを防ぐ。
    let active = SERVICE_TABS.includes(activeTab) ? activeTab : null
    if (!active) {
        const activeBtn = tabs && tabs.querySelector('.service_tab.is-active')
        const fromDom = activeBtn && activeBtn.dataset.serviceTab
        active = SERVICE_TABS.includes(fromDom) ? fromDom : 'nicolive'
    }
    if (tabs) {
        for (const b of tabs.querySelectorAll('.service_tab')) {
            b.classList.toggle('is-active', b.dataset.serviceTab === active)
        }
    }
    container.setAttribute('data-service-tab', active)
    return countVisibleByTab(container, active)
}

/**
 * そのカードが今のタブで見えているか。
 *
 * 🔴 **出し分けの実体は CSS（main.css の `[data-service-tab]`）。ここはその写し。**
 *    件数表示と自動移動の移動先選びが「見えているもの」を扱うために、同じ規則を JS でも要る。
 *    **2つが食い違うと、見えていないカードへ自動移動する**という形で出る。
 *    JS 側の定義はこの関数**1つだけ**にし、CSS と一致しているかは検査（項目BR）で見る。
 *
 * @param {HTMLElement} container `#liveProgramContainer`
 * @param {HTMLElement} card `.program_container`
 */
export function isCardVisibleInTab(container, card) {
    const active = container && container.getAttribute ? container.getAttribute('data-service-tab') : null
    // タブ分離モードでない、または「統合」タブ＝全部見えている。
    if (!active || active === 'mixed') return true
    const svc = (card && card.getAttribute && card.getAttribute('data-service')) || 'nicolive'
    return active === 'kick' ? svc === 'kick' : svc !== 'kick'
}

/** タブで表示されるカード数。件数表示が「見えていない番組」を数えないようにする。 */
function countVisibleByTab(container, active) {
    // 「統合」は全件見えている。絞り込みの式に混ぜると `svc !== 'kick'` 側に落ちて
    // **Kick のぶんだけ件数が足りなくなる**（見えているのに数えない）。
    if (active === 'mixed') return container.children.length
    let n = 0
    for (const el of container.children) {
        // ⚠️ 判定はここに書かず `isCardVisibleInTab` を通すこと。自動移動と規則を1つにしておく。
        if (isCardVisibleInTab({ getAttribute: () => active }, el)) n++
    }
    return n
}

/**
 * URL が指している「今見ている放送」の識別子。サービスをまたいで比較できる形にする。
 *
 *   ニコ生の視聴ページ … `nico:lv123`
 *   Kick のチャンネル   … `kick:slug`
 *   それ以外（一覧・VOD・判定不能） … `''`
 *
 * 🔴 **`''` は「別の放送」ではなく「分からない」。** 比較する側は、
 *    どちらかが `''` なら**移動しない**こと。分からない時に動くと、
 *    一覧ページや VOD を見ているだけで勝手に飛ばされる。
 *
 * ⚠️ Kick は `kick.com/<slug>` がチャンネルページだが、同じ形の予約パスが多数ある。
 *    ここに無いものが増えても「チャンネル扱い」になるだけで、実害は
 *    「移動先の候補に入る」程度（カードのリンクは自前で作っているので混ざらない）。
 */
const KICK_RESERVED_PATHS = new Set([
    'browse', 'following', 'categories', 'category', 'search', 'subscriptions',
    'messages', 'dashboard', 'video', 'videos', 'clips', 'about', 'help',
    'settings', 'transparency', 'community-guidelines', 'privacy-policy', 'terms-of-service',
])

export function watchTargetIdOf(url) {
    if (!url) return ''
    let u
    try { u = new URL(String(url), 'https://live.nicovideo.jp/') } catch (_e) { return '' }

    if (/(^|\.)nicovideo\.jp$/.test(u.hostname)) {
        const m = u.pathname.match(/\/watch\/(lv\d+)/)
        return m ? 'nico:' + m[1] : ''
    }
    if (/(^|\.)kick\.com$/.test(u.hostname)) {
        const m = u.pathname.match(/^\/([A-Za-z0-9_-]+)\/?$/)
        if (!m) return '' // /video/... や /slug/clips などはチャンネルページではない
        const slug = m[1]
        if (KICK_RESERVED_PATHS.has(slug.toLowerCase())) return ''
        return 'kick:' + slug.toLowerCase()
    }
    return ''
}

/**
 * 自動移動の移動先を選ぶ。**サービスをまたいでよい**（利用者の指定・2026-08-07）。
 *
 * 規則は3つだけ。
 *   1. **今のタブで見えているカード**から選ぶ（隠れているカードへは飛ばない）
 *   2. DOM 順の先頭から
 *   3. 今いる放送と同じものは飛ばす
 *
 * 🔴 **今いる放送が分からない時は選ばない。** 以前は `/watch/(lv\d+)` に一致した時だけ
 *    移動する形で、結果として Kick のカードが**黙って候補から外れていた**。
 *    サービスをまたぐようにした今は、`watchTargetIdOf` が `''` を返す＝分からない、として
 *    はっきり止める（一覧ページや VOD で勝手に飛ばされないため）。
 *
 * @param {HTMLElement} container `#liveProgramContainer`
 * @param {string} currentUrl だいたい `location.href`
 * @returns {{link: HTMLElement, id: string, candidates: string[], currentId: string}}
 */
export function pickAutoNextTarget(container, currentUrl) {
    const currentId = watchTargetIdOf(currentUrl)
    const candidates = []
    let link = null
    let id = ''
    if (!container || !container.children) return { link, id, candidates, currentId }

    for (const card of container.children) {
        if (!isCardVisibleInTab(container, card)) continue
        const a = card.querySelector ? card.querySelector('.program_thumbnail a') : null
        if (!a) continue
        const nextId = watchTargetIdOf(a.href)
        if (!nextId) continue
        candidates.push(nextId)
        if (!link && currentId && nextId !== currentId) {
            link = a
            id = nextId
        }
    }
    return { link, id, candidates, currentId }
}

/**
 * タブのクリックを配線する。サイドバー挿入後に一度だけ呼ぶ。
 * @param {(count:number)=>void} onCountChange 表示件数が変わった時に呼ぶ
 * @param {(tab:string)=>void} [onTabChange] 選択が変わった時に呼ぶ。**保存に使う。**
 *   持たないと、カードが作り直されるたびにニコ生側へ戻る。
 */
export function setupServiceTabHandlers(onCountChange, onTabChange) {
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
        // 選択を覚える。持たないと、カードが作り直されるたびにニコ生側へ戻る。
        if (typeof onTabChange === 'function') onTabChange(active)
    })
}

/**
 * 表示中の全カードの順位属性を計算し直す。**取得はしない。**
 *
 * 別のタブで貯まった視聴点数を反映する時に使う（`startWatchHistorySync` から）。
 * `active-point` も視聴点数も**描画時に書かれた値**なので、並べ替えるだけでは古いまま＝
 * 直ったように見えて直っていない。保存済みの番組データから属性ごと書き直す。
 *
 * ⚠️ かつては「人気順の基準」（W のスライダー）を動かした時にも使っていた。
 *    その設定は 2026-08-12 に廃止（doc/09 項目CU）。呼び出し元が1つ減っただけで役目は同じ。
 *
 * @param {HTMLElement} container `#liveProgramContainer`
 * @param {Array<object>} infos 番組データ（ニコ生＋Kick。id は 'lv123' / 'k123' のどちらでも可）
 */
export function reapplyRankAttributes(container, infos) {
    if (!container || !Array.isArray(infos) || !infos.length) return
    const map = new Map()
    for (const i of infos) if (i && i.id) map.set(String(i.id), i)
    for (const el of container.children) {
        if (!el || !el.id) continue
        // ニコ生はカードのDOM id が数値・info の id が 'lv' 付き。Kick は両者同一。
        const info = map.get(el.id) || map.get('lv' + el.id)
        if (info) applyRankAttributes(el, info)
    }
}

/**
 * 並べ替えが読む属性を**まとめて**書く。カードを作る時と、その場更新の時の両方から呼ぶ。
 *
 * 🔴 **集約してあるのは片方だけ書く事故を構造的に潰すため。** 以前は2箇所で個別に
 * `active-point` と第2キーを書いており、「片方だけ更新すると同点時の並びが古い値で決まる」
 * という⚠️コメントで守っていた。**思い出して守るガードは、書く場所が増えた時に破れる。**
 * 属性を足したくなったらここへ足すこと（doc/09 項目BE）。
 *
 * - `active-point`     … 推定同時視聴者数（人気順の第1キー）
 * - `data-begin-at`    … 放送開始（人気順の同点時の第2キー）
 * - `data-watch-count` … 視聴点数（よく見る順のキー）。**画面には出さない**
 * - `data-service`     … タブ分離の表示切り替えが読む
 *
 * ⚠️ **読み手のない属性を足さないこと。** `data-total` / `data-comment-weight` /
 *    `data-comment-ratio` は実機観察用の覗き窓として書き続けていたが、順位から外れた後も
 *    誰も読まないまま毎周期すべてのカードに書かれていた（2026-08-13 に撤去・doc/09 項目CM-2）。
 *
 * @param {HTMLElement} el カードのコンテナ
 * @param {Object} data 番組データ
 */
/**
 * 同時視聴者数の表示。
 *
 * ニコ生は**推定値**（リトルの法則。到着レート × 滞在時間）、Kick は**実測値**。
 * どちらも `calculateActivePoint` が返すので、ここは見せ方だけを決める。
 *
 * ⚠️ 小数を出さない。推定値に小数点以下の意味は無く、桁が揺れて読みにくいだけ。
 */
function formatViewers(v) {
    const n = Math.round(Number(v) || 0)
    // ⚠️ **数字が無い時の文言（利用者指定・2026-08-12: 「—」→「計算中」）。**
    //    0 になるのは「推定できない」ではなく「ニコ生側の集計がまだ始まっていない」＝待てば出る。
    return n > 0 ? n.toLocaleString('ja-JP') : '計算中'
}

/**
 * サムネ右下の経過時間を1枚ぶん書く。**書き手はここだけ**（描画時と ticker の両方が通る）。
 * @param {HTMLElement} el カードのコンテナ
 * @param {number} beginMs 放送開始（エポックms）
 * @param {number} now 現在時刻(ms)
 */
function writeElapsedLabel(el, beginMs, now) {
    const slot = el && el.querySelector ? el.querySelector('.elapsed_overlay') : null
    if (!slot) return
    slot.textContent = formatElapsed(beginMs, now)
}

/**
 * 経過時間を定期的に書き換える。**両ページが1回だけ呼ぶ。**
 *
 * 【なぜ要るか】リストの取得は既定120秒間隔で、そのままだと最大2分ずれた時間が出る。
 * 分単位でしか出さないので 30秒 ごとに書き直せば、ずれは最大30秒に収まる。
 *
 * 🔴 **取得はしない。** DOM の `data-begin-at` を読んで文字列を書くだけ。
 *    ⚠️ だから拡張が無効化された後も止めていない（doc/09 項目BK が問題にしたのは
 *       「取得が止まらない」こと。ここは通信も storage も触らず、ページと一緒に消える）。
 * ⚠️ **設定が OFF の間も回す。** 判定は CSS 側（`nns-show-elapsed`）が持っており、
 *    ここで見に行くと「設定を読む経路」が増える。書くのは文字列だけなので止める価値が無い。
 */
let elapsedTimer = null
export function startElapsedTicker() {
    if (elapsedTimer !== null) return
    elapsedTimer = setInterval(() => {
        const container = document.getElementById('liveProgramContainer')
        if (!container) return
        const now = Date.now()
        for (const card of container.children) {
            writeElapsedLabel(card, Number(card.getAttribute('data-begin-at')), now)
        }
    }, elapsedTickMs)
}

export function applyRankAttributes(el, data) {
    if (!el) return
    // どのサービスの番組か。タブ分離モードの表示切り替え（CSS）とラベル表示が読む。
    el.setAttribute('data-service', (data && data.service) || 'nicolive')
    const concurrent = calculateActivePoint(data)
    el.setAttribute('active-point', String(concurrent))
    // サムネ左上の同時視聴者数。**順位に使うのと同じ値**なので、表示と並びがずれない。
    const viewers = el.querySelector ? el.querySelector('.viewer_overlay') : null
    if (viewers) viewers.textContent = formatViewers(concurrent)
    // 人気順の第2キー（同点時）。放送開始が新しい方を上にする。
    // 🔴 **`data-total` から差し替えた**（2026-08-04）。累計エンゲージメントはコメントを含むが、
    //    Kick はコメント数を返さないので常に 0 になり、ニコ生と混ぜた時に Kick が必ず下へ沈む。
    //    開始時刻なら両サービスが同じ意味で持っている。
    const beginMs = data && data.onAirTime && data.onAirTime.beginAt ? Date.parse(data.onAirTime.beginAt) : NaN
    el.setAttribute('data-begin-at', Number.isFinite(beginMs) ? String(beginMs) : '0')
    // サムネ右下の経過時間（doc/09 項目CX）。**読むのは上の data-begin-at と同じ値**。
    // ⚠️ ここは取得のたびにしか走らない（既定120秒）。その間の進みは startElapsedTicker が埋める。
    writeElapsedLabel(el, beginMs, Date.now())
    // よく見る順の材料。**書き手はここだけ**（他の順位属性と同じ扱い）。
    // 履歴が未読み込みなら 0。全員 0 なら第2キー（人気順）で並ぶので、順位が壊れることはない。
    // ⚠️ **画面には出さない**（テスト表示の「7pt」は 1.20.4 で撤去・doc/09 項目CM-2）。
    //    値は並べ替え専用。出し直したくなったら設定にすること。
    el.setAttribute('data-watch-count', String(getWatchPoints(ownerKeyOf(data))))
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

    // 🔴 **繋ぎ画像（配信者アイコン）はここでも見ること**（2026-08-10・doc/09 項目CD-2）。
    //    以前は `data-src` だけを見て、駄目なら最後の砦へ直行していた。
    //    **Kick は放送開始直後でもサムネURLを返す**（まだ画像が無いので読み込みは失敗する）。
    //    その時 `data-src` は**同じURL**なので（`deriveCardFields` がライブと静止の両方に
    //    `thumbnailUrl` を入れる）`this.src !== dataSrc` が偽になり、
    //    **配信者アイコンを飛び越してローディング画像になっていた。**
    //    「サムネが出せない間はアイコン」という決まりは、生成時・後埋めだけでなく
    //    **失敗した時のここにも要る**（3箇所目）。
    //
    // ⚠️ **必ず下りだけに進むこと。** 上へ戻せるようにすると、アイコンも読めない時に
    //    サムネURL↔アイコンで error が往復して**無限に鳴り続ける**（loading.gif は
    //    ローカルで必ず読めるので、旧実装は2段しか無くたまたま止まっていた）。
    const chain = [
        this.getAttribute('data-src'),
        this.getAttribute('data-fallback-src'),
        safeRuntimeUrl('images/loading.gif'), // 取れない＝拡張が無効化済み（空文字で下の if が弾く）
    ]
    // 今どこまで落ちているか。-1 ＝ どれでもない（＝ライブサムネを表示中）＝先頭から試す。
    const cur = chain.indexOf(this.src)
    for (let i = cur + 1; i < chain.length; i++) {
        if (chain[i] && chain[i] !== this.src) {
            this.src = chain[i]
            return
        }
    }
    // 出せる絵が尽きた。今出ている絵をそのまま残す（消すより残すほうが見た目の被害が小さい）
}

// ---- 動くサムネ(②)への給餌フック ----
// ②ON時、①(この通常サムネ更新)のプリロードを crossOrigin で読み、読めた画像を②へ渡す。
// **②はコマ化した画像そのものを返し、①はそれを静止サムネの表示にも使う**（同じ1枚を共有する）。
// main.js が setAnimThumbnailFeed で注入。
// feed = { isEnabled(): boolean, ingest(cardId, HTMLImageElement): Promise<{url,seq}|null> }
let animThumbFeed = null
export function setAnimThumbnailFeed(feed) { animThumbFeed = feed }

/**
 * プリロードの取得経路を差し替えるフック。**kick.com 専用。既定は null（＝従来どおり）。**
 *
 * 【なぜ要るのか】
 * 動くサムネは `crossOrigin='anonymous'` で読んだ画像を canvas に描いてコマにする。
 * ところが **kick.com 上では、ニコ生も Kick も画像の配信元が ACAO を返さない**
 * （2026-08-04 実測。ニコ生の配信元はニコ生のオリジンだけ許可している）。
 * CORS はブラウザがページに課す制限で、**拡張の Service Worker からの取得には適用されない**ので、
 * SW に取ってもらって data URL で受け取れば canvas は汚染されない。
 *
 * 🔴 **null のときは1行も挙動が変わらないこと。** ニコ生ページ側はこのフックを設定しないので、
 *    従来どおり crossOrigin で直接読む。ここを共通化しようとしないこと。
 *
 * 🔴 **URL ごとに使うかどうかを決めること（`shouldUse`）。** 全部を中継に回すと、
 *    ニコ生のページでニコ生自身の画像まで SW 往復＋base64 化することになり、
 *    通信も遅延も無駄に増える。中継が要るのは「そのオリジンから CORS が通らない画像」だけ。
 *
 * @param {null | {shouldUse: (url: string) => boolean, fetch: (url: string) => Promise<string|null>}} proxy
 */
let imageProxy = null
export function setThumbnailImageProxy(proxy) {
    imageProxy = (proxy && typeof proxy.fetch === 'function' && typeof proxy.shouldUse === 'function') ? proxy : null
}

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

            // 🔴 **2通りで引く。** ニコ生は「カードのDOM id＝数値」「infoのid＝`lv`付き」という
            //    規約なので `lv${card.id}` で引く。Kick は接頭辞 `k` 付きで両者が同一なので、
            //    そのまま引く。片方だけだと **Kick が永久にこのループの対象外**になり、
            //    動くサムネのコマが1枚も貯まらない（そこで詰まっていた）。
            const info = infoMap.get(card.id) || infoMap.get(`lv${card.id}`)

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
            // Kick も `?versionId=` を外した素のURL（＝常に最新版）を使うので、
            // ニコ生と同じく「同じURLで中身が変わる」形になる。どちらもキャッシュバスターが要る。
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
            // プロキシ経由で読む時は data URL になるので crossOrigin は付けない（付けると逆に失敗する）。
            // ⚠️ **判定は URL ごと。**中継が要るのは「このオリジンから CORS が通らない画像」だけ。
            const viaProxy = feeding && !!imageProxy && imageProxy.shouldUse(urlForAttempt)
            const pre = new Image()
            if (feeding && !viaProxy) pre.crossOrigin = 'anonymous'
            // 🔴 **給餌してよいのは「canvas を汚さない読み方で取れた画像」だけ**（doc/09 項目CV）。
            //    中継（imageProxy）が失敗した時に素のURLで読み直す道があり、そこで読んだ画像は
            //    **crossOrigin が付いていない＝汚染画像**。それを②へ渡すと `getImageData` が例外になり、
            //    ②は共有 canvas ごと汚れて**そのページの動くサムネが以後ずっと止まる**。
            //    ⚠️ `feeding` は「機能がONか」でしかない。**読み方が安全かは別に持つこと。**
            let feedable = feeding
            pre.onload = () => {
                pendingImages--
                if (feedable) {
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
            if (viaProxy) {
                // 失敗しても表示は守る: 素のURLで読み直す（その場合コマ化はできないが絵は出る）。
                // 🔴 **素のURLへ倒したら給餌をやめること。** 中継が返した data URL は同一オリジン扱いで
                //    canvas を汚さないが、素のURLは汚す。ここで倒し忘れると②が壊れる（項目CV）。
                const fallbackPlain = () => { feedable = false; pre.src = urlForAttempt }
                imageProxy.fetch(urlForAttempt).then(
                    (dataUrl) => { if (dataUrl) pre.src = dataUrl; else fallbackPlain() },
                    fallbackPlain,
                )
            } else {
                pre.src = urlForAttempt
            }
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

    // 🔴 **スクロール位置を保存してから並べ替える。**
    //
    //    `replaceChildren` は中身を一度すべて外す。その瞬間リストの高さが 0 になるので、
    //    スクロール要素（`#sidebar` は `overflow: auto`）の `scrollTop` が 0 へ切り詰められる。
    //    戻す前に Last を測ると、**全カードがスクロール量ぶん動いた**ことになり、
    //    順位が1つも変わっていなくても全部がスライドする。
    //    利用者からは「定期更新でリストがチラつく」「動いていない番組までフラップする」に見える
    //    （2026-08-04 に報告。Kick でリストが長くなり実際にスクロールするようになって表面化した）。
    //
    //    ⚠️ 復元は **Last を測る前に、同期で**行うこと。後回しにすると測定値が汚れる。
    const scrollers = []
    for (let n = container.parentNode; n; n = n.parentNode) {
        if (typeof n.scrollTop === 'number' && n.scrollTop > 0) scrollers.push([n, n.scrollTop])
    }

    // Last: 並べ替えを実行（同期）
    reorderFn()

    for (const [n, top] of scrollers) {
        if (n.scrollTop !== top) n.scrollTop = top
    }

    // Invert: 旧位置へ戻す（トランジション無しで瞬間移動）
    const moved = []
    Array.from(container.children).forEach((el, idx) => {
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
                                    <!-- ニコ生の案内。**2通りある**（doc/09 項目CH）。
                                         🔴 「ログイン」を出してよいのは **401/403 の時だけ**。
                                            以前は「2経路とも取れなかった」だけで出しており、
                                            **メンテナンス中でもログインを勧めていた**（落ちている
                                            ログインページへ誘導することになる）。
                                         ⚠️ ここはテンプレートリテラルの中。バックティックを書かないこと。 -->
                                    <div id="api_error">
                                        <span id="api_error_auth" hidden><a href="https://account.nicovideo.jp/login">ログイン</a></span>
                                        <span id="api_error_down" hidden>ニコ生に接続できません。メンテナンス中かもしれません。</span>
                                    </div>
                                    <!-- Kick のログイン切れの案内（2026-08-10・利用者要望・doc/09 項目CG）。
                                         🔴 **api_error と一緒にしないこと。** あちらは「ニコ生の2経路が
                                            **両方**失敗した時」にだけ出す設計で、中身もニコ生のログインリンク。
                                            Kick の事情を相乗りさせると、kick.com で Kick だけ切れた時に
                                            **ニコ生のログインを勧める**ことになる。逆に条件を「片方でも失敗」へ
                                            緩めると、ニコ生を使わない利用者に**永久にニコ生のログイン誘導が出る**。
                                         ⚠️ ここはテンプレートリテラルの中。**この注意書き自身も含めて**
                                            バックティックを書かないこと（2026-08-10 に踏んだ。id を
                                            コード引用しようとして文字列がそこで終わり、ビルドが落ちる）。 -->
                                    <div id="kick_notice" hidden>
                                        Kick のログインが切れています。Kick の番組は更新されません。
                                        <a href="https://kick.com/" target="_blank" rel="noopener">kick.com を開く</a>
                                    </div>
                                    <div id="optionContainer"></div>
                                    <!-- タブ分離モードでのみ表示。混在モードと Kick 無効時は hidden。
                                         切り替えは再描画ではなく CSS の出し分けで行う（描画経路に触らないため）。 -->
                                    <!-- ⚠️ 「統合」は一番左。data-service-tab の値は SERVICE_TABS と揃えること
                                         （知らない値が来ると既定のニコ生へ落ちる）。
                                         「統合」を選んだ時の見え方は設定の「統合表示」と同じ＝全件出す。 -->
                                    <div id="serviceTabs" class="service_tabs" hidden>
                                        <button type="button" class="service_tab" data-service-tab="mixed">統合</button>
                                        <button type="button" class="service_tab is-active" data-service-tab="nicolive">ニコ生</button>
                                        <button type="button" class="service_tab" data-service-tab="kick">Kick</button>
                                    </div>
                                    <div id="liveProgramContainer"></div>
                                </div>
                            </div>
                        </div>`

    // 🔴 ラインにも `sidebar_transition` を付けること（2026-08-08・項目CE-2）。
    //    「重ねる」ではラインは `left` で動く。中身だけアニメすると開閉のたびにズレる。
    //    ⚠️ 中身と**同じクラス**を使う。別の指定を書くと、片方の時間を変えた時に食い違う。
    const sidebarLine = `<div id="sidebar_line" class="sidebar_transition"><div id="sidebar_button"><div id="sidebar_arrow"></div></div></div>`

    const optionHtml = `<div class="container">
                            <div class="settings_header">
                                <h1>設定</h1>
                                <button type="button" id="settings_close" class="settings_close" title="番組リストに戻る" aria-label="閉じる">×</button>
                            </div>
                            <form id="optionForm">
                                <div class="opt-section">
                                    <div class="opt-label opt-title-with-help">
                                        表示順序
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip"><b>新着順</b>: 放送開始が新しい順。<br><b>人気順</b>: 同時視聴者数の多い順。<br><b>よく見る順</b>: よく見る配信者ほど上。履歴が貯まるまでは人気順。</span></span>
                                    </div>
                                    <!-- ⚠️ **値を変えないこと。** 保存済みの設定に対応するラジオが無くなると、
                                         その利用者は設定を一切保存できなくなる（doc/09 項目BQ と同じ罠）。
                                         'recommend' は 2026-08-10 追加。既定は 'newest' のまま。
                                         ⚠️ 2026-08-12 に**表示だけ**「おすすめ」→「よく見る順」に変えた（doc/09 項目CU）。
                                            値 'recommend' はそのまま。ラベルと値を一緒に変えないこと。 -->
                                    <div class="opt-segment">
                                        <input type="radio" id="programsSort1" name="programsSort" value="newest"><label for="programsSort1">新着順</label>
                                        <input type="radio" id="programsSort2" name="programsSort" value="active"><label for="programsSort2">人気順</label>
                                        <input type="radio" id="programsSort3" name="programsSort" value="recommend"><label for="programsSort3">よく見る順</label>
                                    </div>
                                    <!-- よく見る順の履歴をリセットする（doc/09 項目CW）。
                                         ⚠️ ここはテンプレートリテラルの中。バックティックを書かないこと。
                                         🔴 **設定ではなく「操作」。** optionKeys に足さないこと（保存するものが無い）。
                                         🔴 **type="button" にすること。** 既定の submit だとフォームが送信され、
                                            設定パネルが閉じる／ページが再読み込みされる。
                                         ⚠️ 取り消せないので**2段階**（1回目は文言が確認へ変わるだけ）。
                                            状態は**ボタン自身の文言**で出す（小さく目立たなく置くため、別枠を持たない）。
                                         ⚠️ 出すのは「よく見る順」を選んでいる時だけ（opt-recommend-only）。 -->
                                    <div class="opt-recommend-only" hidden>
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">よく見る順で使う視聴履歴を全部消します。<b>元に戻せません。</b><br><br>どの配信者をどれだけ見たかを端末の中に保存しているだけで、どこにも送信していません。</span></span>
                                        <button type="button" id="reset_watch_points" class="opt-inline-reset">履歴をリセット</button>
                                    </div>
                                </div>
                                <!-- 🔴 **「人気順の基準」（W のスライダー）は 2026-08-12 に廃止した**（doc/09 項目CU）。
                                     同接を画面に出すと決めた時点で筋が通らなくなったため:
                                       表示している数字が**実際の同接の推定**なら、正解は1つで好みで動かすものではない
                                       好みで動かす**つまみ**なら、それを「同時視聴者数」として画面に出してはいけない
                                     W は defaultDwellMinutes（17分＝旧スライダーのちょうど中央）に固定した。
                                     ⚠️ **保存値を読む経路も一緒に消してある。** 残すと既存の環境だけ古い W で動く。 -->
                                <div class="opt-section">
                                    <div class="opt-label opt-title-with-help">
                                        自動更新
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">番組リストを指定秒数で自動更新します。（更新ボタンで手動更新も可）<br>サムネイルはこの設定と関係なく自動更新されます（20〜60秒）。</span></span>
                                    </div>
                                    <!-- id は値ベース（旧: updateProgramsInterval1〜3 の連番）。選択肢を増やした時に
                                         連番だと意味がずれ、検証スクリプトの「60秒に設定できた」が黙って別の値を
                                         押すようになるため。増減しても意味が動かない値ベースにしてある。 -->
                                    <div class="opt-segment opt-segment-4">
                                        <!-- 🔴 **選択肢を消したら storage.js の migrateOptions へ寄せ先を足すこと。**
                                             保存値に対応するラジオが無いと、その利用者は設定を一切保存できなくなる
                                             （updateCheckedState がどれも選ばず、saveOptions が早期 return する）。
                                             180秒 は 2026-08-07 に廃止し、120秒 へ寄せている。
                                             ⚠️ 値は文字列 'off'。数値にすると Number() で他の値と区別できなくなる。
                                             ⚠️ **OFF は左端**（利用者判断・2026-08-10）。自動移動・動くサムネと同じ並びにする。 -->
                                        <input type="radio" id="updateProgramsIntervalOff" name="updateProgramsInterval" value="off"><label for="updateProgramsIntervalOff">OFF</label>
                                        <input type="radio" id="updateProgramsInterval30" name="updateProgramsInterval" value="30"><label for="updateProgramsInterval30">30秒</label>
                                        <input type="radio" id="updateProgramsInterval60" name="updateProgramsInterval" value="60"><label for="updateProgramsInterval60">60秒</label>
                                        <input type="radio" id="updateProgramsInterval120" name="updateProgramsInterval" value="120"><label for="updateProgramsInterval120">120秒</label>
                                    </div>
                                </div>
                                <div class="opt-section">
                                    <div class="opt-label opt-title-with-help">
                                        オートオープン
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">ページを開いた時にサイドバーを自動で開くか。「記憶」は前回の開閉状態を復元します。</span></span>
                                    </div>
                                    <!-- ⚠️ **並びは OFF → ON。**他のトグル（自動移動・動くサムネ）と揃える。
                                         🔴 **id と value の対応を動かさないこと。** autoOpen1='1'=ON /
                                            autoOpen2='2'=OFF のまま、入れ替えるのは**表示順だけ**。
                                            値を振り直すと、既存利用者の保存値の意味が反転する。
                                         ⚠️ input:checked + label で色を付けているので、input と label は
                                            必ず隣り合わせのまま動かす。
                                         ⚠️ ここはテンプレートリテラルの中。バックティックを書かないこと。 -->
                                    <div class="opt-segment">
                                        <input type="radio" id="autoOpen2" name="autoOpen" value="2"><label for="autoOpen2">OFF</label>
                                        <input type="radio" id="autoOpen1" name="autoOpen" value="1"><label for="autoOpen1">ON</label>
                                        <input type="radio" id="autoOpen3" name="autoOpen" value="3"><label for="autoOpen3">記憶</label>
                                    </div>
                                </div>
                                <div class="opt-section">
                                    <div class="opt-label opt-title-with-help">
                                        自動移動
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">視聴中の番組が終わったら、リストの先頭の番組へ自動で移動します。<br>タブで分けている時は、表示中のタブの先頭へ移動します。</span></span>
                                    </div>
                                    <div class="opt-segment">
                                        <input type="radio" id="autoNextProgramOff" name="autoNextProgram" value="off"><label for="autoNextProgramOff">OFF</label>
                                        <input type="radio" id="autoNextProgramOn" name="autoNextProgram" value="on"><label for="autoNextProgramOn">ON</label>
                                    </div>
                                </div>
                                <!-- 番組カードの見た目にかかる設定を1つの枠にまとめる（利用者指定・2026-08-12・doc/09 項目CY）。
                                     ⚠️ ここはテンプレートリテラルの中。バックティックを書かないこと。
                                     ⚠️ **サブ項目も opt-title-with-help を保つこと。** ヘルプの吹き出しは
                                        いちばん近い positioned 祖先に合わせて出るので、外すと別の幅で出てはみ出す。
                                     🔴 **name と value は動かさない。** 保存済みの設定に対応するラジオが無くなると、
                                        その利用者は設定を一切保存できなくなる（doc/09 項目BQ）。
                                     ⚠️ カードの大きさに「?」を付けないのは利用者判断（2026-08-10）。設定名と小/中/大で伝わる。
                                        value は constants.js の cardSizes のキーと同じにすること。 -->
                                <div class="opt-section opt-group">
                                    <div class="opt-label">番組カードの設定</div>
                                <div class="opt-subsection">
                                    <!-- 「?」は付けない（利用者判断・2026-08-10）。設定名と小/中/大で伝わる。 -->
                                    <div class="opt-sublabel">カードの大きさ</div>
                                    <div class="opt-segment">
                                        <input type="radio" id="cardSizeSmall" name="cardSize" value="small"><label for="cardSizeSmall">小</label>
                                        <input type="radio" id="cardSizeMedium" name="cardSize" value="medium"><label for="cardSizeMedium">中</label>
                                        <input type="radio" id="cardSizeLarge" name="cardSize" value="large"><label for="cardSizeLarge">大</label>
                                    </div>
                                </div>
                                <div class="opt-subsection">
                                    <div class="opt-sublabel opt-title-with-help">
                                        動くサムネ<span class="opt-beta-badge">β版</span>
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">サムネにマウスを乗せると直近数枚のライブサムネをアニメーション表示します。<br><br>コマが貯まるまで数分かかることがあります。</span></span>
                                    </div>
                                    <div class="opt-segment">
                                        <input type="radio" id="animatedThumbnailOff" name="animatedThumbnail" value="off"><label for="animatedThumbnailOff">OFF</label>
                                        <input type="radio" id="animatedThumbnailOn" name="animatedThumbnail" value="on"><label for="animatedThumbnailOn">ON</label>
                                    </div>
                                </div>
                                <div class="opt-subsection">
                                    <div class="opt-sublabel opt-title-with-help">
                                        同時視聴者数<span class="opt-beta-badge">β版</span>
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">ニコ生の同時視聴者数は公表されていないので独自の計算方法による<b>推定値</b>です。</span></span>
                                    </div>
                                    <div class="opt-segment">
                                        <input type="radio" id="showViewerCountOff" name="showViewerCount" value="off"><label for="showViewerCountOff">OFF</label>
                                        <input type="radio" id="showViewerCountOn" name="showViewerCount" value="on"><label for="showViewerCountOn">ON</label>
                                    </div>
                                </div>
                                <div class="opt-subsection">
                                    <!-- 「?」は付けない（利用者判断・2026-08-12）。設定名だけで伝わる。 -->
                                    <div class="opt-sublabel">経過時間</div>
                                    <div class="opt-segment">
                                        <input type="radio" id="showElapsedTimeOff" name="showElapsedTime" value="off"><label for="showElapsedTimeOff">OFF</label>
                                        <input type="radio" id="showElapsedTimeOn" name="showElapsedTime" value="on"><label for="showElapsedTimeOn">ON</label>
                                    </div>
                                </div>
                                </div>
                                <!-- カードの大きさ。**動くサムネの下**（利用者指定・2026-08-10。以前は自動更新の上だった）。
                                     ⚠️ value は constants.js の cardSizes のキーと同じにすること。
                                        知らない値は既定（medium）に落ちるので、間違えても壊れはしないが効かない。
                                     ⚠️ ここはテンプレートリテラルの中。バックティックを書かないこと。 -->
                                <!-- サイドバーの置き方（2026-08-08・利用者要望・doc/09 項目CE）。
                                     ⚠️ ここはテンプレートリテラルの中。バックティックを書かないこと。 -->
                                <div class="opt-section">
                                    <div class="opt-label opt-title-with-help">
                                        サイドバーの置き方
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip"><b>画面分割</b>: ページを右へずらして、左半分にサイドバーを置きます。<br><br><b>重ねる</b>: ページの上に重ねます。左側が隠れる代わりに、ページのレイアウトを崩しません。</span></span>
                                    </div>
                                    <div class="opt-segment">
                                        <input type="radio" id="sidebarPlacementPush" name="sidebarPlacement" value="push"><label for="sidebarPlacementPush">画面分割</label>
                                        <input type="radio" id="sidebarPlacementOverlay" name="sidebarPlacement" value="overlay"><label for="sidebarPlacementOverlay">重ねる</label>
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
                                        Kick 連携<span class="opt-beta-badge">β版</span>
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
                                    <div class="opt-label opt-title-with-help">
                                        番組表示方法
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">ニコ生と Kick の番組を、1つのリストにまとめるか、タブで切り替えるか。</span></span>
                                    </div>
                                    <div class="opt-segment">
                                        <!-- 保存する値は 'mixed' のまま。表示ラベルだけを「統合表示」にしている。
                                             値を変えると既存ユーザーの設定が既定へ落ちる。 -->
                                        <input type="radio" id="kickDisplayModeMixed" name="kickDisplayMode" value="mixed"><label for="kickDisplayModeMixed">統合表示</label>
                                        <input type="radio" id="kickDisplayModeTabs" name="kickDisplayMode" value="tabs"><label for="kickDisplayModeTabs">タブで分ける</label>
                                    </div>
                                </div>
                            </form>
                        </div>`

    return { sidebarHtml, sidebarLine, optionHtml }
}


