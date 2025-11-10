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
        thumbnail_link_url = `https://live.nicovideo.jp/watch/${data.id}`
        thumbnail_url = data.thumbnailUrl || ''
        icon_url = (data.contentOwner && data.contentOwner.icon) || ''

        if (data.providerType === 'user') {
            live_thumbnail_url = data.thumbnailUrl || ''
            if (data.liveScreenshotThumbnailUrls && data.liveScreenshotThumbnailUrls.middle) {
                live_thumbnail_url = `${data.liveScreenshotThumbnailUrls.middle}?cache=${Date.now()}`
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
 * @deprecated 後方互換性のため残しています。makeProgramElementを使用してください。
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

export function attachThumbnailErrorHandlers() {
    document.querySelectorAll('.program_thumbnail_img').forEach(function (element) {
        element.removeEventListener('error', handleThumbnailError)
        element.addEventListener('error', handleThumbnailError)
    })
}

function handleThumbnailError() {
    const dataSrc = this.getAttribute('data-src')
    if (dataSrc && this.src !== dataSrc) {
        this.src = dataSrc
    } else {
        const loading = chrome.runtime.getURL('images/loading.gif')
        this.src = loading
    }
}

import { thumbnailTtlMs, thumbnailRetryBaseMs, thumbnailRetryMaxMs } from '../config/constants.js'

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
    const sourceImgs = thumbObserver && visibleImages.size
        ? Array.from(visibleImages).filter((img) => container.contains(img))
        : Array.from(container.querySelectorAll('.program_thumbnail_img'))
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

    function computeNext(info, parentId) {
        if (!info) return { nextUrl: null, key: '' }
        if (info.isMemberOnly) return { nextUrl: null, key: 'member' }

        if (info.providerType === 'user') {
            const urls = info.liveScreenshotThumbnailUrls
            const base = urls && urls.middle ? urls.middle : info.thumbnailUrl || null
            if (!base) return { nextUrl: null, key: '' }
            // ユーザー配信はスクショURLをベースにする（?cache はTTLで間引くためここでは付けない）
            return { nextUrl: base, key: `u|${base}` }
        }

        if (info.providerType === 'channel') {
            const base = info.large1280x720ThumbnailUrl || info.thumbnailUrl || null
            if (!base) return { nextUrl: null, key: '' }
            return { nextUrl: base, key: `c|${base}` }
        }

        return { nextUrl: null, key: '' }
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

            const { nextUrl, key } = computeNext(info, card.id)
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
            const pre = new Image()
            const urlForAttempt = key.startsWith('u|') ? `${nextUrl}?cache=${now}` : nextUrl
            pre.onload = () => {
                pendingImages--
                if (img.src !== urlForAttempt) img.src = urlForAttempt
                img.dataset.key = key
                img.dataset.errors = '0'
                img.dataset.nextTryAt = '0'
                img.dataset.lastSuccessAt = String(Date.now())
                // 画像読み込み完了時はcheckComplete()を呼ばない
                // ローディング完了は処理の開始完了で判定し、画像読み込みはバックグラウンドで継続
            }
            pre.onerror = () => {
                pendingImages--
                const errors = Number(img.dataset.errors || 0) + 1
                const delay = Math.min(thumbnailRetryMaxMs, thumbnailRetryBaseMs * Math.pow(2, errors - 1))
                img.dataset.errors = String(errors)
                img.dataset.nextTryAt = String(Date.now() + delay)
                // 表示は handleThumbnailError に任せる（既にerrorハンドラが付与済み）
                // エラーを明示的に発火させず、次周期まで現状を維持
                // 画像読み込みエラー時もcheckComplete()を呼ばない
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

// IntersectionObserver-based visibility tracking (optional optimization)
let thumbObserver = null
const visibleImages = new Set()

export function initThumbnailVisibilityObserver() {
    const container = document.getElementById('liveProgramContainer')
    if (!container) return
    if (thumbObserver) thumbObserver.disconnect()
    visibleImages.clear()
    thumbObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                const target = entry.target
                if (!(target instanceof HTMLImageElement)) return
                if (entry.isIntersecting) visibleImages.add(target)
                else visibleImages.delete(target)
            })
        },
        { root: container, rootMargin: '200px', threshold: 0.01 }
    )
    refreshThumbnailObservations()
}

export function refreshThumbnailObservations() {
    if (!thumbObserver) return
    const container = document.getElementById('liveProgramContainer')
    if (!container) return
    const imgs = container.querySelectorAll('.program_thumbnail_img')
    imgs.forEach((img) => thumbObserver.observe(img))
}

export function teardownThumbnailVisibilityObserver() {
    if (thumbObserver) {
        thumbObserver.disconnect()
        thumbObserver = null
    }
    visibleImages.clear()
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
                            <h1>オプション</h1>
                            <form id="optionForm">
                                <h2>表示順序</h2>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="programsSort1" name="programsSort" value="newest">
                                        <label for="programsSort1">新着順</label>
                                    </div>
                                </div>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="programsSort2" name="programsSort" value="active">
                                        <label for="programsSort2">人気順</label>
                                    </div>
                                </div>
                                <h2 class="opt-title-with-help">
                                    自動更新
                                    <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">番組リストを指定秒数で自動更新します。（サイドバー内の更新ボタンで手動で更新することもできます）<br>サムネイル画像はこの設定とは関係なく自動更新されます。（20~60秒）</span></span>
                                </h2>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="updateProgramsInterval1" name="updateProgramsInterval" value="60">
                                        <label for="updateProgramsInterval1">60秒</label>
                                    </div>
                                </div>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="updateProgramsInterval2" name="updateProgramsInterval" value="120">
                                        <label for="updateProgramsInterval2">120秒</label>
                                    </div>
                                </div>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="updateProgramsInterval3" name="updateProgramsInterval" value="180">
                                        <label for="updateProgramsInterval3">180秒</label>
                                    </div>
                                </div>
                                <h2 class="opt-title-with-help">
                                    オートオープン
                                    <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">サイドバーを自動で開くかどうかを設定します。</span></span>
                                </h2>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="autoOpen1" name="autoOpen" value="1">
                                        <label for="autoOpen1">ON</label>
                                    </div>
                                </div>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="autoOpen2" name="autoOpen" value="2">
                                        <label for="autoOpen2">OFF</label>
                                    </div>
                                </div>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="autoOpen3" name="autoOpen" value="3">
                                        <label for="autoOpen3">ページを閉じる前の状態を記憶</label>
                                    </div>
                                </div>
                                <h2 class="opt-title-with-help">
                                    自動移動
                                    <span class="help-wrap"><span class="help-icon" aria-label="ヘルプ" tabindex="0">?</span><span class="help-tooltip" role="tooltip">視聴中の番組終了後、サイドバーの先頭の番組へ移動します。</span></span>
                                </h2>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="autoNextProgramOn" name="autoNextProgram" value="on">
                                        <label for="autoNextProgramOn">ON</label>
                                    </div>
                                </div>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="autoNextProgramOff" name="autoNextProgram" value="off">
                                        <label for="autoNextProgramOff">OFF</label>
                                    </div>
                                </div>
                            </form>
                        </div>`

    return { sidebarHtml, sidebarLine, optionHtml }
}


