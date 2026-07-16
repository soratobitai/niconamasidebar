import { thumbnailTtlMs, thumbnailRetryBaseMs, thumbnailRetryMaxMs, watchPageBaseUrl } from '../config/constants.js'

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
 * user: ライブスクショ(middle) → thumbnailUrl / channel: large1280x720 → thumbnailUrl。
 * ?cache 付与・変更検知キー・会員限定判定は呼び出し側の責務。
 * @param {Object} info - 番組詳細
 * @returns {string|null} ベースURL（該当なしは null）
 */
export function resolveLiveThumbnailBaseUrl(info) {
    if (!info) return null
    if (info.providerType === 'user') {
        return (info.liveScreenshotThumbnailUrls && info.liveScreenshotThumbnailUrls.middle) || info.thumbnailUrl || null
    }
    if (info.providerType === 'channel') {
        return info.large1280x720ThumbnailUrl || info.thumbnailUrl || null
    }
    return null
}

/**
 * 番組情報からDOM要素を直接作成（innerHTMLを使用せず、セキュアに）
 * @param {Object} data - 番組データ
 * @param {string} loadingImageURL - ローディング画像のURL
 * @returns {HTMLElement|null} 作成されたDOM要素、またはnull
 */
export function makeProgramElement(data, loadingImageURL) {
    if (!data || !data.id) return null

    const id = data.id.replace('lv', '')
    let user_page_url = ''
    let community_name = ''
    let thumbnail_link_url = ''
    let thumbnail_url = ''
    let icon_url = ''
    let live_thumbnail_url = ''
    const title = data.title || 'タイトル不明'

    if (data.id.includes('lv')) {
        if (data.contentOwner && data.contentOwner.id) {
            user_page_url = `https://www.nicovideo.jp/user/${data.contentOwner.id}`
        }
        community_name = (data.contentOwner && data.contentOwner.name) || 'コミュニティ名不明'
        thumbnail_link_url = `${watchPageBaseUrl}${data.id}`
        thumbnail_url = data.thumbnailUrl || ''
        icon_url = (data.contentOwner && data.contentOwner.icon) || ''

        if (data.providerType === 'user') {
            live_thumbnail_url = data.thumbnailUrl || ''
            if (data.liveScreenshotThumbnailUrls && data.liveScreenshotThumbnailUrls.middle) {
                live_thumbnail_url = appendCacheParam(data.liveScreenshotThumbnailUrls.middle, Date.now())
            }
        }
        if (data.providerType === 'channel') {
            if (data.contentOwner && data.contentOwner.id) {
                user_page_url = `https://ch.nicovideo.jp/${data.contentOwner.id}`
            }
            live_thumbnail_url = data.thumbnailUrl || ''
            if (data.large1280x720ThumbnailUrl) {
                live_thumbnail_url = data.large1280x720ThumbnailUrl
            }
        }
    } else {
        community_name = data.community_name || 'コミュニティ名不明'
        thumbnail_link_url = data.thumbnail_link_url || ''
        thumbnail_url = data.thumbnail_url || ''
        icon_url = data.thumbnail_url || ''
        live_thumbnail_url = data.thumbnail_url || ''

        if (thumbnail_url) {
            const match = thumbnail_url.match(/\/(\d+)\.jpg/i)
            if (match) user_page_url = `https://www.nicovideo.jp/user/${match[1]}`
        }
    }

    if (!live_thumbnail_url) {
        live_thumbnail_url = thumbnail_url || loadingImageURL
    }
    if (!thumbnail_url) {
        thumbnail_url = loadingImageURL
    }

    const activePoint = calculateActivePoint(data)

    // メインコンテナ
    const container = document.createElement('div')
    container.id = id
    container.className = 'program_container'
    container.setAttribute('active-point', String(activePoint))

    // コミュニティセクション
    const communityDiv = document.createElement('div')
    communityDiv.className = 'community'

    // ユーザーアイコン
    if (icon_url) {
        if (user_page_url) {
            const iconLink = document.createElement('a')
            iconLink.href = user_page_url
            iconLink.target = '_blank'
            const iconImg = document.createElement('img')
            iconImg.src = icon_url
            iconLink.appendChild(iconImg)
            communityDiv.appendChild(iconLink)
        } else {
            const iconImg = document.createElement('img')
            iconImg.src = icon_url
            communityDiv.appendChild(iconImg)
        }
    }

    // コミュニティ名
    const communityNameDiv = document.createElement('div')
    communityNameDiv.className = 'community_name'
    communityNameDiv.title = community_name
    communityNameDiv.textContent = community_name
    communityDiv.appendChild(communityNameDiv)

    container.appendChild(communityDiv)

    // サムネイルセクション
    const thumbnailDiv = document.createElement('div')
    thumbnailDiv.className = 'program_thumbnail program-card_'
    const thumbnailLink = document.createElement('a')
    thumbnailLink.href = thumbnail_link_url
    const thumbnailImg = document.createElement('img')
    thumbnailImg.className = 'program_thumbnail_img'
    thumbnailImg.src = live_thumbnail_url
    thumbnailImg.setAttribute('data-src', thumbnail_url)
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
 * 番組データから人気度スコア（active-point）を算出する。
 * point = (視聴者数+1 + コメント数+1) / 放送経過分数
 * ソート（人気順）および DOM属性 active-point の元になる現役の関数。
 * @param {Object} data - 番組データ（viewers/comments/onAirTime.beginAt を参照）
 * @returns {number} 人気度スコア（非有限時は0）
 */
export function calculateActivePoint(data) {
    if (!data) return 0
    const comments = (data.comments || 0) + 1
    const viewers = (data.viewers || 0) + 1
    const elapsedTime = (() => {
        const beginAt = data && data.onAirTime && data.onAirTime.beginAt
        if (!beginAt) return 1
        try {
            const start = new Date(beginAt)
            const now = new Date()
            const minutes = Math.floor((now - start) / (1000 * 60))
            return Math.max(1, minutes)
        } catch (_e) {
            return 1
        }
    })()
    const point = (viewers + comments) / Math.pow(elapsedTime, 1)
    return Number.isFinite(point) ? point : 0
}

// サムネイル画像の読み込み失敗時のフォールバック処理。
// makeProgramElement 生成時に各 img へ addEventListener('error', ...) で配線される。
function handleThumbnailError() {
    const dataSrc = this.getAttribute('data-src')
    if (dataSrc && this.src !== dataSrc) {
        this.src = dataSrc
    } else {
        const loading = chrome.runtime.getURL('images/loading.gif')
        this.src = loading
    }
}

// ---- 動くサムネ(②)への給餌フック ----
// ②ON時、①(この通常サムネ更新)のプリロードを crossOrigin で読み、読めた画像を②へ渡して
// 「最新サムネを①②が別々に取得する二重通信」をなくす。main.js が setAnimThumbnailFeed で注入。
// feed = { isEnabled(): boolean, ingest(cardId, HTMLImageElement): void }
let animThumbFeed = null
export function setAnimThumbnailFeed(feed) { animThumbFeed = feed }

export function updateThumbnailsFromStorage(programInfos, options = {}) {
    const force = !!(options && options.force)
    const onComplete = options.onComplete || null
    // Convert to Map for O(1) lookup if array
    const infoMap = Array.isArray(programInfos)
        ? new Map(programInfos.map((i) => [i.id, i]))
        : programInfos

    const container = document.getElementById('liveProgramContainer')
    if (!container) {
        if (onComplete) onComplete()
        return
    }
    // コンテナ内の全サムネを対象にする（可視限定の最適化は撤去。
    // DOM再構築時の同期ずれで更新が漏れる不具合を避けるため、常に全imgを更新対象とする）。
    const sourceImgs = Array.from(container.querySelectorAll('.program_thumbnail_img'))
    const now = Date.now()

    // 画像が存在しない場合、即座に完了コールバックを呼ぶ
    if (sourceImgs.length === 0) {
        if (onComplete) onComplete()
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

    function checkComplete() {
        // 全ての画像処理が完了した場合（画像読み込みは待たない）
        // ローディング表示は「処理開始」までで完了とし、画像読み込みはバックグラウンドで継続
        if (!isCompleted && index >= sourceImgs.length) {
            isCompleted = true
            if (onComplete) onComplete()
        }
    }

    function tick() {
        const end = Math.min(index + CHUNK, sourceImgs.length)
        for (; index < end; index++) {
            const img = sourceImgs[index]
            if (!img) continue;
            
            const card = img.closest('.program_container')
            if (!card || !card.id) continue;
            
            const info = infoMap.get(`lv${card.id}`)

            const { nextUrl, key } = computeNext(info)
            if (!nextUrl) continue;

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
            const applySuccess = () => {
                if (img.src !== urlForAttempt) img.src = urlForAttempt
                img.dataset.key = key
                img.dataset.errors = '0'
                img.dataset.nextTryAt = '0'
                img.dataset.lastSuccessAt = String(Date.now())
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
                applySuccess()
                if (feeding) animThumbFeed.ingest(card.id, pre) // 再取得なしでフレーム化（②側でON/汚染を再判定）
            }
            pre.onerror = () => {
                if (feeding) {
                    // crossOriginで失敗 → 表示だけは平文で確保（②へは渡さない）。pendingは平文側で解消。
                    const plain = new Image()
                    plain.onload = () => { pendingImages--; applySuccess() }
                    plain.onerror = () => { pendingImages--; applyBackoff() }
                    plain.src = urlForAttempt
                    return
                }
                pendingImages--
                applyBackoff()
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
    programs.sort((a, b) => {
        const activeA = parseFloat(a.getAttribute('active-point'))
        const activeB = parseFloat(b.getAttribute('active-point'))
        return activeB - activeA
    })
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
                                    <div class="opt-segment">
                                        <input type="radio" id="updateProgramsInterval1" name="updateProgramsInterval" value="60"><label for="updateProgramsInterval1">60秒</label>
                                        <input type="radio" id="updateProgramsInterval2" name="updateProgramsInterval" value="120"><label for="updateProgramsInterval2">120秒</label>
                                        <input type="radio" id="updateProgramsInterval3" name="updateProgramsInterval" value="180"><label for="updateProgramsInterval3">180秒</label>
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
                                        <input type="radio" id="autoNextProgramOn" name="autoNextProgram" value="on"><label for="autoNextProgramOn">ON</label>
                                        <input type="radio" id="autoNextProgramOff" name="autoNextProgram" value="off"><label for="autoNextProgramOff">OFF</label>
                                    </div>
                                </div>
                                <div class="opt-section">
                                    <div class="opt-label opt-title-with-help">
                                        動くサムネ<span class="opt-beta-badge">β版</span>
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">サムネにマウスを乗せると直近数枚のライブサムネを切り替えてアニメ表示します。（ベータ版：不具合や重い場合はOFFに）</span></span>
                                    </div>
                                    <div class="opt-segment">
                                        <input type="radio" id="animatedThumbnailOn" name="animatedThumbnail" value="on"><label for="animatedThumbnailOn">ON</label>
                                        <input type="radio" id="animatedThumbnailOff" name="animatedThumbnail" value="off"><label for="animatedThumbnailOff">OFF</label>
                                    </div>
                                </div>
                                <div class="opt-section">
                                    <div class="opt-label opt-title-with-help">
                                        データ取得方式<span class="opt-beta-badge">実験</span>
                                        <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">番組情報の取得元。API=従来のニコ生API。ページ取得=フォロー中ページを1回取得して全詳細を得る実験方式（API激減）。自動=ページ取得を優先し失敗時はAPIへ。</span></span>
                                    </div>
                                    <div class="opt-segment">
                                        <input type="radio" id="dataSourceApi" name="dataSource" value="api"><label for="dataSourceApi">API</label>
                                        <input type="radio" id="dataSourceFollow" name="dataSource" value="followPage"><label for="dataSourceFollow">ページ取得</label>
                                        <input type="radio" id="dataSourceAuto" name="dataSource" value="auto"><label for="dataSourceAuto">自動</label>
                                    </div>
                                </div>
                                <div class="opt-section">
                                    <div class="opt-label">テーマ</div>
                                    <div class="theme_toggle_row">
                                        <span class="theme_toggle_label">ライト</span>
                                        <div id="theme_toggle" title="ライト/ダーク切替"><span class="theme_switch"><span class="theme_switch_knob"></span></span></div>
                                        <span class="theme_toggle_label">ダーク</span>
                                    </div>
                                </div>
                            </form>
                        </div>`

    return { sidebarHtml, sidebarLine, optionHtml }
}


