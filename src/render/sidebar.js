export function makeProgramsHtml(data, loadingImageURL) {
    if (!data || !data.id) return ''

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

    let userIconHtml = ''
    if (user_page_url && icon_url) {
        userIconHtml = `<a href="${user_page_url}" target="_blank"><img src="${icon_url}"></a>`
    } else if (icon_url) {
        userIconHtml = `<img src="${icon_url}">`
    }

    const activePoint = calculateActivePoint(data)

    return `<div id="${id}" class="program_container" active-point="${activePoint}">
                <div class="community">
                    ${userIconHtml}
                    <div class="community_name" title="${escapeHtml(community_name)}">
                        ${escapeHtml(community_name)}
                    </div>
                </div>
                <div class="program_thumbnail program-card_">
                    <a href="${thumbnail_link_url}">
                        <img class="program_thumbnail_img" src="${live_thumbnail_url}" data-src="${thumbnail_url}">
                    </a>
                </div>
                <div class="program_title" title="${escapeHtml(title)}">
                    ${escapeHtml(title)}
                </div>
            </div>`
}

export function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }
    return String(text).replace(/[&<>"']/g, (m) => map[m])
}

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
    // Convert to Map for O(1) lookup if array
    const infoMap = Array.isArray(programInfos)
        ? new Map(programInfos.map((i) => [i.id, i]))
        : programInfos

    const container = document.getElementById('liveProgramContainer')
    if (!container) return
    const sourceImgs = thumbObserver && visibleImages.size
        ? Array.from(visibleImages).filter((img) => container.contains(img))
        : Array.from(container.querySelectorAll('.program_thumbnail_img'))
    const now = Date.now()

    let index = 0
    const CHUNK = 50

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

    function tick() {
        const end = Math.min(index + CHUNK, sourceImgs.length)
        for (; index < end; index++) {
            const img = sourceImgs[index]
            if (!img) continue
            const card = img.closest('.program_container')
            if (!card || !card.id) continue
            const info = infoMap.get(`lv${card.id}`)

            const { nextUrl, key } = computeNext(info, card.id)
            if (!nextUrl) continue

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
            const pre = new Image()
            const urlForAttempt = key.startsWith('u|') ? `${nextUrl}?cache=${now}` : nextUrl
            pre.onload = () => {
                if (img.src !== urlForAttempt) img.src = urlForAttempt
                img.dataset.key = key
                img.dataset.errors = '0'
                img.dataset.nextTryAt = '0'
                img.dataset.lastSuccessAt = String(Date.now())
            }
            pre.onerror = () => {
                const errors = Number(img.dataset.errors || 0) + 1
                const delay = Math.min(thumbnailRetryMaxMs, thumbnailRetryBaseMs * Math.pow(2, errors - 1))
                img.dataset.errors = String(errors)
                img.dataset.nextTryAt = String(Date.now() + delay)
                // 表示は handleThumbnailError に任せる（既にerrorハンドラが付与済み）
                // エラーを明示的に発火させず、次周期まで現状を維持
            }
            pre.src = urlForAttempt
        }
        if (index < sourceImgs.length) requestAnimationFrame(tick)
    }

    requestAnimationFrame(tick)
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
        const activeA = parseFloat(a.getAttribute('active-point'), 10)
        const activeB = parseFloat(b.getAttribute('active-point'), 10)
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


