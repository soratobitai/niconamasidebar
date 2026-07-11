import { getProgramInfos as getProgramInfosFromStorage } from '../services/storage.js'
import { saveFrames, loadFrames, cleanupFrames } from '../services/animFrameStore.js'
import {
    animatedThumbnailFrameCount as FRAME_COUNT,
    animatedThumbnailCaptureIntervalMs as CAPTURE_INTERVAL_MS,
    animatedThumbnailPlayIntervalMs as PLAY_INTERVAL_MS,
    animatedThumbnailPersistTtlMs as PERSIST_TTL_MS,
    animatedThumbnailPersistMaxEntries as PERSIST_MAX_ENTRIES,
} from '../config/constants.js'

/**
 * 動くサムネ（実験機能・ホバー中のみ）
 *
 * ライブサムネは同じURLで内容が時間変化するため、取得した「その瞬間の画像」を保持する必要がある。
 * CORS対応が確認できているので、crossOrigin='anonymous' で読み込み → 小さなcanvasで知覚ハッシュを作り、
 * 直前フレームと違う時だけ blob として保持する（重複排除。ニコ生の更新間隔が時間帯で変わっても
 * 「同じ画像が複数コマ」にならない）。
 *
 * - 対象は「サイドバーに見えているカード」のみ（メモリ/通信の節約。アニメはホバー時しか使わないため）。
 * - 各カードにつき直近 FRAME_COUNT 枚を blob URL のリングバッファで保持。
 * - ホバー中のカードだけ、貯まったフレームを一定間隔で巡回表示（オーバーレイimgをフェード）。
 * - 追加権限・Service Worker は不要（すべて content script 内で完結）。
 *
 * 注意: ON時は既存のサムネ更新（updateThumbnailsFromStorage）とは別に、可視カードの画像を
 * 20秒ごとに追加取得する（同一サムネへ実質二重リクエスト）。ONにした時だけの通信増。
 */

// programId(数値文字列) -> { frames: [{ url, sig }], lastSig, lastCaptureAt }
const buffers = new Map()
// アニメ表示中に eviction された blob URL は、表示中フレームを消さないよう遅延revokeする
const pendingRevokes = new Set()
// ホバー即キャプチャのスロットル（同一カードは直近この時間内は再取得しない）
const HOVER_CAPTURE_THROTTLE_MS = 3000
// 保存フレームの最大幅（縮小して drawImage/エンコード負荷とストレージを軽減。表示は小さいので十分）
const MAX_FRAME_W = 480

let enabled = false
let captureTimer = null
// CORSが想定外にtaintした場合、無駄な取得を止めるためのフラグ
let captureUnsupported = false

// ホバー状態（カーソル下のカードと、アニメ再生状態を分離）
let hoverCard = null   // カーソル下のカード
let animCard = null    // オーバーレイ再生中のカード
let animTimer = null
let animIndex = 0
let animFront = 0      // クロスフェードの表レイヤー(0/1)

// 署名（重複排除）用の使い回しcanvas
const SIG_SIZE = 16
let sigCanvas = null
let sigCtx = null

function getContainer() {
    return document.getElementById('liveProgramContainer')
}

// サイドバーが読み込み中（更新ボタンにローディング表示）かどうか。
// 初回ロードや更新の重い処理中はキャプチャを控え、動画プレーヤーへの負荷・通信競合を避ける。
function isSidebarLoading() {
    const btn = document.getElementById('reload_programs')
    return !!(btn && btn.classList.contains('loading'))
}

// バッファを取得（無ければ生成）。hydrated=IndexedDBからの復元済みフラグ。
function getOrCreateBuffer(id) {
    let buf = buffers.get(id)
    if (!buf) {
        buf = { frames: [], lastSig: null, lastCaptureAt: 0, hydrated: false, hydrating: null }
        buffers.set(id, buf)
    }
    return buf
}

// IndexedDB から保存フレームを1度だけ復元してバッファに取り込む（ライブ取得より前に呼ぶ）。
function ensureHydrated(id) {
    const buf = getOrCreateBuffer(id)
    if (buf.hydrated) return Promise.resolve()
    if (buf.hydrating) return buf.hydrating
    buf.hydrating = (async () => {
        let rec = null
        try { rec = await loadFrames(id) } catch (_e) { rec = null }
        const b = buffers.get(id)
        if (!b) return
        b.hydrated = true
        b.hydrating = null
        if (!enabled) return
        // まだライブフレームが入っておらず、TTL内の保存があれば復元
        if (b.frames.length === 0 && rec && Array.isArray(rec.frames) && rec.frames.length
            && typeof rec.updatedAt === 'number' && (Date.now() - rec.updatedAt) < PERSIST_TTL_MS) {
            const restored = []
            for (const f of rec.frames) {
                if (f && f.blob) restored.push({ url: URL.createObjectURL(f.blob), sig: f.sig, blob: f.blob })
            }
            if (restored.length) {
                b.frames = restored.slice(-FRAME_COUNT)
                b.lastSig = rec.lastSig || b.frames[b.frames.length - 1].sig
            }
        }
    })()
    return buf.hydrating
}

// 現在のバッファを IndexedDB に保存（新フレーム追加時のみ呼ぶ＝頻度は低い）。
function persistBuffer(id) {
    const buf = buffers.get(id)
    if (!buf || !buf.frames.length) return
    saveFrames(id, {
        frames: buf.frames.map((f) => ({ blob: f.blob, sig: f.sig })),
        lastSig: buf.lastSig,
        updatedAt: Date.now(),
    })
}

// ---- フレーム署名（知覚ハッシュ的な縮小輝度配列） ----
function computeSignature(img) {
    if (!sigCanvas) {
        sigCanvas = document.createElement('canvas')
        sigCanvas.width = SIG_SIZE
        sigCanvas.height = SIG_SIZE
        // getImageDataを毎回呼ぶため willReadFrequently で読み戻しを最適化（Chromeの警告も解消）
        sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true })
    }
    const ctx = sigCtx
    try {
        ctx.clearRect(0, 0, SIG_SIZE, SIG_SIZE)
        ctx.drawImage(img, 0, 0, SIG_SIZE, SIG_SIZE)
        const data = ctx.getImageData(0, 0, SIG_SIZE, SIG_SIZE).data
        const lum = new Uint8Array(SIG_SIZE * SIG_SIZE)
        for (let i = 0, j = 0; i < data.length; i += 4, j++) {
            lum[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
        }
        return lum
    } catch (_e) {
        // CORSがtaintした場合（本来CORS OK確認済みなので通常は起きない）→ 以降の取得を止める
        captureUnsupported = true
        return null
    }
}

function signatureDiffers(a, b, threshold = 8) {
    if (!a || !b) return true
    if (a.length !== b.length) return true
    let sum = 0
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
    return sum / a.length > threshold
}

// ---- 番組詳細からライブサムネURLを得る ----
function getScreenshotUrl(info) {
    if (!info || info.isMemberOnly) return null
    if (info.providerType === 'user') {
        return (info.liveScreenshotThumbnailUrls && info.liveScreenshotThumbnailUrls.middle) || info.thumbnailUrl || null
    }
    if (info.providerType === 'channel') {
        return info.large1280x720ThumbnailUrl || info.thumbnailUrl || null
    }
    return null
}

// ---- 1カード分のフレーム取得（重複排除して保持） ----
function captureFrame(id, url) {
    // バッファを用意し、取得開始時刻を記録（ホバー即キャプチャのスロットル用）
    const buf = getOrCreateBuffer(id)
    buf.lastCaptureAt = Date.now()

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
        if (!enabled) return
        const b = buffers.get(id)
        if (!b) return // 取得中に解放された（リストから消えた）
        const sig = computeSignature(img)
        if (!sig) return
        if (!signatureDiffers(sig, b.lastSig)) return // 重複 → 破棄

        // toBlobは非同期のため、キャプチャcanvasは共有せず都度生成する（競合防止）。
        // 最大幅 MAX_FRAME_W まで縮小して描画・エンコード負荷とサイズを抑える。
        const nw = img.naturalWidth || 320
        const nh = img.naturalHeight || 180
        const scale = Math.min(1, MAX_FRAME_W / nw)
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(nw * scale))
        c.height = Math.max(1, Math.round(nh * scale))
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
        c.toBlob(async (blob) => {
            if (!blob || !enabled) return
            // 追加の前に、IndexedDBの保存フレームを取り込む（上書き・欠落防止）
            await ensureHydrated(id)
            const b2 = buffers.get(id)
            if (!b2 || !enabled) return
            // 復元後の最新フレームとの重複を再チェック
            if (!signatureDiffers(sig, b2.lastSig)) return
            const objUrl = URL.createObjectURL(blob)
            b2.frames.push({ url: objUrl, sig, blob })
            b2.lastSig = sig
            while (b2.frames.length > FRAME_COUNT) {
                const old = b2.frames.shift()
                // アニメ表示中カードは、表示中フレームを消さないよう revoke を遅延
                if (animCard && animCard.id === id) pendingRevokes.add(old.url)
                else URL.revokeObjectURL(old.url)
            }
            persistBuffer(id) // IndexedDBへ保存（fire-and-forget）
            // ホバー保持中のカードで2枚目が貯まったら、その場でアニメを開始する
            tryStartAnim()
        }, 'image/jpeg', 0.8)
    }
    img.onerror = () => { /* CORS/読込失敗時は静かにスキップ（ベースサムネには影響しない） */ }
    img.src = url + (url.includes('?') ? '&' : '?') + 'cache=' + Date.now()
}

// ---- カードがサイドバー内で見えているか ----
function isCardVisible(card) {
    const r = card.getBoundingClientRect()
    let top = 0
    let bottom = window.innerHeight
    const sb = document.getElementById('sidebar')
    if (sb) {
        const sr = sb.getBoundingClientRect()
        top = Math.max(top, sr.top)
        bottom = Math.min(bottom, sr.bottom)
    }
    return r.bottom > top && r.top < bottom && r.right > 0 && r.left < window.innerWidth
}

// ---- 可視カードのフレームを取得＋不要バッファのprune ----
function captureVisibleFrames() {
    // 読み込み中（初回ロード等）は負荷/通信競合を避けてスキップ
    if (!enabled || captureUnsupported || document.hidden || isSidebarLoading()) return
    const container = getContainer()
    if (!container) return

    const infos = getProgramInfosFromStorage()
    const infoMap = new Map((infos || []).map((i) => [i.id, i]))
    const presentIds = new Set()

    container.querySelectorAll('.program_container').forEach((card) => {
        if (!card.id) return
        presentIds.add(card.id)
        if (!isCardVisible(card)) return
        const url = getScreenshotUrl(infoMap.get('lv' + card.id))
        if (url) captureFrame(card.id, url)
    })

    // リストから消えた番組のバッファを解放
    for (const id of Array.from(buffers.keys())) {
        if (!presentIds.has(id)) releaseBuffer(id)
    }
}

function releaseBuffer(id) {
    const buf = buffers.get(id)
    if (buf) {
        buf.frames.forEach((f) => URL.revokeObjectURL(f.url))
        buffers.delete(id)
    }
}

// 遅延していた revoke をまとめて実行（アニメ停止/無効化時に呼ぶ）
function flushPendingRevokes() {
    if (pendingRevokes.size === 0) return
    for (const u of pendingRevokes) URL.revokeObjectURL(u)
    pendingRevokes.clear()
}

// ---- ホバーアニメーション ----
function getOverlay(card, create) {
    const thumb = card.querySelector('.program_thumbnail')
    if (!thumb) return null
    let ov = thumb.querySelector('.anim_thumb_overlay')
    if (!ov && create) {
        // クロスフェード用に2枚のレイヤーimgを重ねたコンテナ
        ov = document.createElement('div')
        ov.className = 'anim_thumb_overlay'
        const a = document.createElement('img')
        a.className = 'anim_thumb_layer'
        const b = document.createElement('img')
        b.className = 'anim_thumb_layer'
        ov.appendChild(a)
        ov.appendChild(b)
        thumb.appendChild(ov)
    }
    return ov
}

// ホバー中カードが条件を満たせばアニメ開始（冪等：既に再生中/枚数不足なら何もしない）
function tryStartAnim() {
    if (!enabled || animTimer) return
    const card = hoverCard
    if (!card || !card.id || !document.contains(card)) return
    const buf = buffers.get(card.id)
    if (!buf || buf.frames.length < 2) return

    const overlay = getOverlay(card, true)
    if (!overlay) return
    const layers = overlay.querySelectorAll('.anim_thumb_layer')
    if (layers.length < 2) return

    animCard = card
    animIndex = 0
    animFront = 0

    // クロスフェード: 次フレームを裏レイヤーに載せてfade in、表レイヤーをfade out、表裏を入れ替え。
    // 裏レイヤーは前サイクルでfade out済み(opacity0)なので、src差し替えは見えず自然に切り替わる。
    const showNext = () => {
        const b = buffers.get(card.id)
        if (!enabled || hoverCard !== card || !b || b.frames.length < 2 || !document.contains(card)) {
            stopAnim()
            return
        }
        const incoming = layers[1 - animFront]
        const outgoing = layers[animFront]
        incoming.src = b.frames[animIndex % b.frames.length].url
        incoming.classList.add('show')
        outgoing.classList.remove('show')
        animFront = 1 - animFront
        animIndex++
    }
    showNext()
    animTimer = setInterval(showNext, PLAY_INTERVAL_MS)
}

function stopAnim() {
    if (animTimer) {
        clearInterval(animTimer)
        animTimer = null
    }
    if (animCard) {
        const overlay = getOverlay(animCard, false)
        if (overlay) {
            overlay.querySelectorAll('.anim_thumb_layer').forEach((l) => {
                l.classList.remove('show')
                l.removeAttribute('src')
            })
        }
    }
    animCard = null
    animIndex = 0
    animFront = 0
    // 表示中だったために遅延していた revoke をここで実行
    flushPendingRevokes()
}

// ホバーしたカードのフレームを即キャプチャ（周期20秒を待たず、貯まり＝アニメ開始を早める）
function captureHoveredCard(card) {
    if (!enabled || captureUnsupported || document.hidden || isSidebarLoading() || !card || !card.id) return
    // 直近に取得済みならスキップ（ホバー横断・連打時の fetch/localStorage parse バーストを抑制）
    const buf = buffers.get(card.id)
    if (buf && buf.lastCaptureAt && (Date.now() - buf.lastCaptureAt) < HOVER_CAPTURE_THROTTLE_MS) return
    const infos = getProgramInfosFromStorage()
    const info = (infos || []).find((i) => i.id === 'lv' + card.id)
    const url = getScreenshotUrl(info)
    if (url) captureFrame(card.id, url)
}

function setHoverCard(card) {
    if (card === hoverCard) return
    // 別カードへ移ったらアニメを止めてから
    stopAnim()
    hoverCard = card
    if (card && card.id) {
        // 保存フレームを復元して、あれば即アニメ開始（リロード/番組移動後の復帰）
        ensureHydrated(card.id).then(() => { if (enabled && hoverCard === card) tryStartAnim() })
        captureHoveredCard(card)
    }
    tryStartAnim()
}

// ---- 委譲ホバーリスナ（カードは再生成されるためコンテナに付ける） ----
function onMouseOver(e) {
    const card = e.target.closest ? e.target.closest('.program_container') : null
    if (card) setHoverCard(card)
    else setHoverCard(null)
}

function onMouseOut(e) {
    // コンテナ外へ出たら停止
    const container = getContainer()
    if (!container) return
    const to = e.relatedTarget
    if (!to || !container.contains(to)) setHoverCard(null)
}

// ---- 公開API ----
export function setAnimatedThumbnailEnabled(on) {
    const next = !!on
    if (next === enabled) return
    enabled = next

    const container = getContainer()
    if (enabled) {
        captureUnsupported = false
        // 起動時に期限切れ/上限超過の保存フレームを掃除（fire-and-forget）
        cleanupFrames(PERSIST_TTL_MS, PERSIST_MAX_ENTRIES)
        if (container) {
            container.addEventListener('mouseover', onMouseOver)
            container.addEventListener('mouseout', onMouseOut)
        }
        captureVisibleFrames()
        captureTimer = setInterval(captureVisibleFrames, CAPTURE_INTERVAL_MS)
    } else {
        if (captureTimer) {
            clearInterval(captureTimer)
            captureTimer = null
        }
        stopAnim()
        hoverCard = null
        if (container) {
            container.removeEventListener('mouseover', onMouseOver)
            container.removeEventListener('mouseout', onMouseOut)
        }
        for (const id of Array.from(buffers.keys())) releaseBuffer(id)
        flushPendingRevokes()
    }
}

export function teardownAnimatedThumbnails() {
    setAnimatedThumbnailEnabled(false)
}
