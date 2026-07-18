import { getProgramInfos as getProgramInfosFromStorage } from '../services/storage.js'
import { resolveLiveThumbnailBaseUrl } from './sidebar.js'
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
 * - 対象はサイドバー内の全カード（可視/画面外を問わず）。画面外の番組でもフレームが貯まり、
 *   どの番組でも均等にアニメが用意される（旧: 可視カードのみ→下の番組が貯まらない差が出ていた）。
 * - 各カードにつき直近 FRAME_COUNT 枚を blob URL のリングバッファで保持。
 * - ホバー中のカードだけ、貯まったフレームを一定間隔で巡回表示（オーバーレイimgをフェード）。
 * - 追加権限・Service Worker は不要（すべて content script 内で完結）。
 *
 * 取得方式（給餌方式・二重取得の解消）:
 *   最新サムネの取得は①(通常サムネ更新 updateThumbnailsFromStorage)へ一本化。②ON時、①はプリロードを
 *   crossOrigin で読み、成功画像を ingestAnimatedThumbnailFrame へ渡す（再取得なし）。②は自前の定期取得をせず、
 *   ホバー即時取得（captureFrame）だけ自前で行う。これで「同一サムネを①②が別々に取る二重通信」をなくす。
 *   ①の crossOrigin が失敗した環境では①が平文で表示だけ確保し（表示は無傷）、②へは渡さない（アニメのみ休止）。
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

// ---- 計測（デバッグ用・一本化の効き目確認のため） ----
// window.showAnimThumbStats() でコンソール確認。給餌方式(①一本化)が効いているかを見る。
//   - ingested = ①から再取得なしで受け取ったフレーム数（一本化で二重を消した分。これが主役になるのが正常）
//   - fetches  = ②が自前でネットへ出した回数（ホバー即時が主。定期は0が正常）
//   - taintStops = crossOrigin 給餌が汚染で失敗した回数（0が正常。出ると①は平文へ自動フォールバック）
//   - dup破棄率  = 解析したが直前と同じで捨てた割合（ニコ生更新が最速20秒＝想定内。間隔短縮/延長の判断には使わない）
// ON時のみ意味を持つ（OFF時は一切動作しない）。計測は enable のたびにリセット。
const STATS_WINDOW_MS = 60000 // 「直近1分」の集計窓
const stats = {
    startedAt: 0,
    fetches: 0,       // ②が自前でネットワークへ出した取得回数（captureFrame＝主にホバー）
    periodic: 0,      // うち定期(通常は0＝①給餌に一本化済み)
    hover: 0,         // うちホバー即時
    ingested: 0,      // ①(通常サムネ更新)から受け取ったフレーム数（再取得なし＝二重解消分）
    loaded: 0,        // 解析まで到達した画像数(storeFrameFromImage)
    errors: 0,        // ②自前取得の読み込み失敗(onerror)
    stored: 0,        // 新規フレームとして保存(署名が変化)
    dupDiscarded: 0,  // 読めたが直前と同じで破棄(重複)
    taintStops: 0,    // CORS汚染で取得停止（①は自動で平文へ戻る）
    recent: [],       // 直近の②自前取得タイムスタンプ(req/分算出用)
}
function resetStats() {
    stats.startedAt = Date.now()
    stats.fetches = stats.periodic = stats.hover = stats.ingested = 0
    stats.loaded = stats.errors = stats.stored = stats.dupDiscarded = stats.taintStops = 0
    stats.recent = []
}

// ホバー状態（カーソル下のカードと、アニメ再生状態を分離）
let hoverCard = null   // カーソル下のカード
let animCard = null    // オーバーレイ再生中のカード
let animTimer = null
let animIndex = 0      // 現在表示中のフレーム番号（リングバッファ内）
let animGen = 0        // 再生世代。stop/再開のたび++し、遅延中の decode/commit コールバックを無効化する
// クロスフェードのフェード時間。CSS .anim_thumb_layer の transition: opacity 0.4s と一致させること。
const FADE_MS = 400
// フェード完了後、次コマへ進むまでの静止時間。1コマの周期 ≈ FADE_MS + HOLD_MS ≈ PLAY_INTERVAL_MS。
// setInterval ではなく「commit 後に次を予約」する自己連鎖にし、decode が遅い時もサイクルが重ならないようにする。
const HOLD_MS = Math.max(0, PLAY_INTERVAL_MS - FADE_MS)

// 署名（重複排除）用の使い回しcanvas
const SIG_SIZE = 16
// 別画像とみなす閾値（0-255/マス）。平均差か、1マス(=フレームの1/256領域)の最大差の
// どちらかが超えたら「別画像」。局所的な動き（顔だけ・一部だけ変化）も拾える。
const SIG_MEAN_THRESHOLD = 2  // 全体の平均差がこれ以下は「ほぼ同一」（真の重複=全マス0を破棄）
const SIG_CELL_THRESHOLD = 24 // どこか1マスがこれを超えたら局所変化ありとみなす
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
        // CORSがtaintした場合（本来CORS OK確認済みなので通常は起きない）→ 以降の取得を止める。
        // 給餌方式では①がcrossOrigin失敗をonerrorで検知して平文にフォールバックするため通常ここには来ないが、
        // 万一到達したら1回だけ警告（コンソールのコンテキスト選択に関係なく top にも表示される）。
        if (!captureUnsupported) {
            console.warn('⚠️ 動くサムネ: CORS汚染で解析不可 → 以降は①が平文取得へ自動フォールバック（表示は維持）')
        }
        captureUnsupported = true
        return null
    }
}

// 別画像とみなすか（重複排除）。真の重複（サーバ未更新＝全マス同一）は破棄しつつ、
// 局所的な変化（顔だけ・画面の一部だけ動く配信）も拾えるよう、フレーム全体の平均差だけでなく
// 「1マスの最大差」も見る。平均で薄まって落ちていた小さな/局所的な変化を保存できる。
function signatureDiffers(a, b) {
    if (!a || !b) return true
    if (a.length !== b.length) return true
    let sum = 0
    let maxCell = 0
    for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i])
        sum += d
        if (d > maxCell) maxCell = d
    }
    return (sum / a.length) > SIG_MEAN_THRESHOLD || maxCell > SIG_CELL_THRESHOLD
}

// ---- 番組詳細からライブサムネURLを得る（会員限定は除外し、ベース選定は共通ヘルパーに委譲） ----
function getScreenshotUrl(info) {
    if (!info || info.isMemberOnly) return null
    return resolveLiveThumbnailBaseUrl(info)
}

// ---- 読み込み済み画像をフレーム化（重複排除して保持） ----
// 自前取得(captureFrame)と①からの給餌(ingestAnimatedThumbnailFrame)の共通後半。
// b は呼び出し側が用意したバッファ（給餌時は必ず存在、自前取得時は取得中の解放を考慮済み）。
function storeFrameFromImage(id, img, b) {
    stats.loaded++
    const sig = computeSignature(img)
    if (!sig) { if (captureUnsupported) stats.taintStops++; return }
    if (!signatureDiffers(sig, b.lastSig)) { stats.dupDiscarded++; return } // 重複 → 破棄

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
        stats.stored++
        while (b2.frames.length > FRAME_COUNT) {
            const old = b2.frames.shift()
            // アニメ表示中カードは、表示中フレームを消さないよう revoke を遅延し、
            // shift で全体が前へ詰まる分 animIndex も1つ戻して再生位置のズレ（コマ飛び）を防ぐ
            if (animCard && animCard.id === id) {
                pendingRevokes.add(old.url)
                if (animIndex > 0) animIndex--
            } else {
                URL.revokeObjectURL(old.url)
            }
        }
        persistBuffer(id) // IndexedDBへ保存（fire-and-forget）
        // ホバー保持中のカードで2枚目が貯まったら、その場でアニメを開始する
        tryStartAnim()
    }, 'image/jpeg', 0.8)
}

// ---- 1カード分を②が自前取得（ホバー即時用。定期取得は①給餌へ一本化済み） ----
// source: 'hover'(ホバー即時) / 'periodic'(通常は使わない)。計測の内訳用。
function captureFrame(id, url, source) {
    // バッファを用意し、取得開始時刻を記録（ホバー即キャプチャのスロットル用）
    const buf = getOrCreateBuffer(id)
    buf.lastCaptureAt = Date.now()

    // 計測: 実際にネットワークへ出す取得を記録
    stats.fetches++
    if (source === 'hover') stats.hover++
    else stats.periodic++
    stats.recent.push(Date.now())

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
        if (!enabled) return
        const b = buffers.get(id)
        if (!b) return // 取得中に解放された（リストから消えた）
        storeFrameFromImage(id, img, b)
    }
    img.onerror = () => { stats.errors++ /* CORS/読込失敗時は静かにスキップ（ベースサムネには影響しない） */ }
    img.src = url + (url.includes('?') ? '&' : '?') + 'cache=' + Date.now()
}

// ---- ①(通常サムネ更新)が crossOrigin で読み込んだ画像を受け取り、再取得せずフレーム化する ----
// これにより「最新サムネを①②が別々に取得する二重通信」をなくす（給餌方式）。
// ①は各カードのプリロード成功時に呼ぶ。ここでは自前取得しない（stats.fetchesは増えない）。
export function ingestAnimatedThumbnailFrame(id, img) {
    // 旧・自前キャプチャと同じガード（初回ロード/重い更新中・タブ非表示中は解析を控え、動画プレーヤーとの競合を避ける）
    if (!enabled || captureUnsupported || document.hidden || isSidebarLoading() || !id || !img) return
    stats.ingested++
    const b = getOrCreateBuffer(id) // ①は現在DOMにある番組のみ渡すのでバッファを用意してよい
    storeFrameFromImage(id, img, b)
}

// ①が「crossOriginで読んで②へ給餌するか」を判断するためのフラグ。
// taint(CORS汚染)後は false に戻し、①を平文取得へ自動フォールバックさせる。
export function isAnimatedThumbnailEnabled() {
    return enabled && !captureUnsupported
}

// ---- 定期メンテナンス: リストから消えた番組のバッファ解放（prune）----
// フレーム取得は①(通常サムネ更新)の給餌に一本化したため、ここでは自前取得しない
// （画面外含む全カードのフレームは①のプリロード成功時に ingestAnimatedThumbnailFrame で貯まる）。
// 役割は、外れた番組の blob を解放してメモリを保つことのみ（20秒周期）。
function pruneAbsentBuffers() {
    if (!enabled) return
    const container = getContainer()
    if (!container) return

    const presentIds = new Set()
    container.querySelectorAll('.program_container').forEach((card) => {
        if (card.id) presentIds.add(card.id)
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
// クロスフェード方式（別カットの一瞬混入を防ぐ）:
//   - layers[0]=base を「常に不透明で現在のコマ」を表示する下地に固定 → フェード中も合計不透明度が
//     100%を保ち、下の実サムネ（最新カット）が透けて混ざらない。
//   - layers[1]=fader（DOM後ろ＝base の上に描画）に次コマを載せ、decode 完了を待ってから 0→1 で
//     フェードイン → 古い絵の一瞬の露出を防ぐ。フェード後、base を次コマへ差し替えて fader を
//     即座に隠す（下地が同じ絵なので不可視に切替）。
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

    const base = layers[0]   // 下地（常に不透明で現在のコマ）
    const fader = layers[1]  // 上に重ねて次コマをフェードインする専用レイヤー

    animCard = card
    animIndex = 0
    const gen = ++animGen

    // 初期コマは base に即載せる（ホバー直後の即時表示）。fader は隠しておく。
    base.src = buf.frames[0].url
    base.classList.add('show')
    fader.classList.remove('show')

    const showNext = () => {
        if (animGen !== gen) return
        const b = buffers.get(card.id)
        if (!enabled || hoverCard !== card || !b || b.frames.length < 2 || !document.contains(card)) {
            stopAnim()
            return
        }
        animIndex = (animIndex + 1) % b.frames.length
        const nextUrl = b.frames[animIndex].url

        const reveal = () => {
            if (animGen !== gen) return
            fader.classList.add('show') // base(不透明)の上に 0→1。下地が常に不透明＝実サムネは透けない
            // フェード完了後、base を次コマへ確定し fader を即座に隠す（下地が同じ絵なので不可視）
            setTimeout(() => {
                if (animGen !== gen) return
                base.src = nextUrl
                // transition を一瞬無効化して fader を瞬時に opacity0 へ（下地と同じ絵なので見えない）。
                // 次のフェードインで transition を効かせるため、reflow 後に戻す。
                fader.style.transition = 'none'
                fader.classList.remove('show')
                void fader.offsetWidth
                fader.style.transition = ''
                // 次コマは commit 後に予約（decode 遅延時もサイクルが重ならない＝ちらつき防止）
                animTimer = setTimeout(showNext, HOLD_MS)
            }, FADE_MS)
        }
        // 次コマをデコード完了まで待ってから見せる（古い絵の一瞬の露出を防ぐ）
        fader.src = nextUrl
        if (fader.decode) fader.decode().then(reveal).catch(reveal)
        else reveal()
    }
    // 自己連鎖で開始（frame0 を少し見せてから frame1 へ進む）
    animTimer = setTimeout(showNext, HOLD_MS)
}

function stopAnim() {
    animGen++ // 遅延中の decode/commit コールバックを無効化（再生停止・カード切替時）
    if (animTimer) {
        clearTimeout(animTimer)
        animTimer = null
    }
    if (animCard) {
        const overlay = getOverlay(animCard, false)
        if (overlay) {
            // src は消さない。消すと fade-out 中に「壊れた画像」アイコンが一瞬出るため、
            // opacity を 0 にする（.show を外す）だけにして最後のフレームのままフェードアウトさせる。
            overlay.querySelectorAll('.anim_thumb_layer').forEach((l) => {
                l.classList.remove('show')
            })
        }
    }
    animCard = null
    animIndex = 0
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
    if (url) captureFrame(card.id, url, 'hover')
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

// ---- 統計表示（コンソールから手動確認: window.showAnimThumbStats()） ----
function showAnimThumbStats() {
    const now = Date.now()
    const elapsed = stats.startedAt ? (now - stats.startedAt) / 1000 : 0
    const mins = elapsed / 60
    stats.recent = stats.recent.filter((t) => now - t < STATS_WINDOW_MS)
    const ingPerMin = mins > 0 ? stats.ingested / mins : 0
    const selfPerMin = mins > 0 ? stats.fetches / mins : 0
    const dupRate = stats.loaded ? (stats.dupDiscarded / stats.loaded) * 100 : 0
    const container = getContainer()
    const cards = container ? container.querySelectorAll('.program_container').length : 0
    console.log('=== 動くサムネ 取得統計（②・①給餌方式） ===')
    console.log(`状態: ${enabled ? 'ON' : 'OFF（最後の計測値）'} / 番組カード数: ${cards} / バッファ保持: ${buffers.size}`)
    console.log(`経過: ${elapsed.toFixed(0)}秒 (${mins.toFixed(1)}分)`)
    console.log(`①給餌(通常更新から/再取得なし): ${stats.ingested}回  平均: ${ingPerMin.toFixed(1)}回/分`)
    console.log(`②自前取得(ネット/主にホバー): ${stats.fetches}回  = 定期${stats.periodic} + ホバー${stats.hover}  平均: ${selfPerMin.toFixed(1)}回/分（直近1分${stats.recent.length}）`)
    console.log(`フレーム化: 解析${stats.loaded}  新規保存${stats.stored}  重複破棄${stats.dupDiscarded}（約${dupRate.toFixed(0)}%）`)
    console.log(`②自前取得の失敗(onerror): ${stats.errors}回`)
    if (stats.taintStops) console.warn(`⚠️ CORS汚染(tainted): ${stats.taintStops}回 → ①は自動で平文取得へフォールバック（表示は維持）`)
    console.log('— 一本化の効き目 —')
    console.log('・「①給餌」が主で「②自前取得」がホバー分だけなら、最新サムネの二重取得は解消できている。')
    console.log('・「CORS汚染」が0なら crossOrigin 給餌は安定。出た場合のみ①が平文へ自動フォールバックし表示を守る。')
    return { ...stats }
}
// モジュール読込時に無条件で公開（showApiStatsと同様）。ON前でも呼べば「まだ計測なし」を返す。
// ※content scriptのisolated worldに定義される。コンソールは拡張の実行コンテキストを選ぶこと。
if (typeof window !== 'undefined') window.showAnimThumbStats = showAnimThumbStats

// ---- 公開API ----
export function setAnimatedThumbnailEnabled(on) {
    const next = !!on
    if (next === enabled) return
    enabled = next

    const container = getContainer()
    if (enabled) {
        captureUnsupported = false
        resetStats() // 計測をリセット（enableごと）
        // 起動時に期限切れ/上限超過の保存フレームを掃除（fire-and-forget）
        cleanupFrames(PERSIST_TTL_MS, PERSIST_MAX_ENTRIES)
        if (container) {
            container.addEventListener('mouseover', onMouseOver)
            container.addEventListener('mouseout', onMouseOut)
        }
        pruneAbsentBuffers()
        captureTimer = setInterval(pruneAbsentBuffers, CAPTURE_INTERVAL_MS)
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
