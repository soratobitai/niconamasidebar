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
 * 取得方式（給餌方式・**静止サムネもこの1枚を出す**）:
 *   フレームは全て①(通常サムネ更新 updateThumbnailsFromStorage)の給餌から得る（②は自前取得しない）。
 *   ②ON時、①はプリロードを crossOrigin で読んで `ingestAnimatedThumbnailFrame` へ渡し、
 *   **その戻り値（コマ化した画像そのもの）を静止サムネの表示にも使う**。
 *
 *   🔴 **「静止サムネ＝最新コマ」は判定ではなく構造で保証すること。** 以前は①が
 *   `img.src = <取得URL>` として**もう1回ダウンロードし直して**いた。同じURLでも別リクエストなので、
 *   2回の間にスクショが1枚進むと「画面に出ている絵がアニメのどのコマにも無い」状態になる。しかも
 *   末尾スロットの発火条件が URL文字列比較だったため、URLが同一のこのケースだけ**構造的にすり抜けて**
 *   いた（doc/09 項目AV。2026-07-31 に実ブラウザで再現を確認）。同じ画像を出す＝比較そのものを不要にする。
 *   副次的に、②ON時のライブサムネ取得が1周期2回→1回になる。
 *
 *   給餌できない時（CORS汚染・機能OFF・toBlob失敗）は①が従来どおりURLで表示し、コマ化はされない。
 *   その場合に最新を映すのが末尾スロット（getLiveStaticSrc／shouldAppendStaticTail）で、要否は
 *   **フレーム識別子(seq)の一致**で決める（URL文字列は見ない＝channelのURL不変でも正しく働く）。
 */

// programId(数値文字列) -> { frames: [{ url, sig, blob, seq }], lastSig }
const buffers = new Map()
// アニメ表示中に eviction された blob URL は、表示中フレームを消さないよう遅延revokeする
const pendingRevokes = new Set()
// フレームの通し番号。**バッファをまたいで単調増加させ、決して再利用しない。**
// 静止サムネ側は「今出している絵のseq」を dataset に持ち、末尾スロットの要否をこの一致で判定する。
// バッファごとの連番にすると、IndexedDBからの復元で過去のseqと衝突して「同じ絵」と誤判定しうる。
let frameSeq = 0
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

// バッファを取得（無ければ生成）。hydrated=IndexedDBからの復元済みフラグ。
function getOrCreateBuffer(id) {
    let buf = buffers.get(id)
    if (!buf) {
        buf = { frames: [], lastSig: null, hydrated: false, hydrating: null }
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
                // seq は保存せず復元時に採番し直す。過去セッションのseqを持ち込むと、
                // 静止サムネ側に残っている dataset.thumbSeq と偶然一致して「同じ絵」と誤判定しうる。
                if (f && f.blob) restored.push({ url: URL.createObjectURL(f.blob), sig: f.sig, blob: f.blob, seq: ++frameSeq })
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

// ---- 読み込み済み画像をフレーム化（重複排除して保持） ----
// ①からの給餌(ingestAnimatedThumbnailFrame)の後半処理。b は呼び出し側が用意したバッファ。
//
// 戻り値: `{ url, seq }`（①が静止サムネに表示する画像）または null（表示はURLで、の意）。
//   - `url` は**この呼び出し専用に作った object URL**。所有者は①で、差し替え時に①が revoke する。
//     リングバッファ側の URL を貸すと eviction や機能OFFの revoke で表示中の画像を消してしまう。
//   - 重複で保存しなかった時は**既存の最新コマ**を返す。署名が同じ＝見た目は同一なので、
//     「静止サムネは常にバッファ内の最新コマそのもの」という不変条件を保てる。
function storeFrameFromImage(id, img, b) {
    const sig = computeSignature(img)
    if (!sig) return Promise.resolve(null)
    if (!signatureDiffers(sig, b.lastSig)) {   // 重複 → 保存はしないが、表示は最新コマを使う
        return Promise.resolve(displayHandleOf(b))
    }

    // toBlobは非同期のため、キャプチャcanvasは共有せず都度生成する（競合防止）。
    // 最大幅 MAX_FRAME_W まで縮小して描画・エンコード負荷とサイズを抑える。
    const nw = img.naturalWidth || 320
    const nh = img.naturalHeight || 180
    const scale = Math.min(1, MAX_FRAME_W / nw)
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(nw * scale))
    c.height = Math.max(1, Math.round(nh * scale))
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
    return new Promise((resolve) => {
        c.toBlob(async (blob) => {
            if (!blob || !enabled) { resolve(null); return }
            // 追加の前に、IndexedDBの保存フレームを取り込む（上書き・欠落防止）
            await ensureHydrated(id)
            const b2 = buffers.get(id)
            if (!b2 || !enabled) { resolve(null); return }
            // 復元後の最新フレームとの重複を再チェック（重複なら既存の最新コマを表示に使う）
            if (!signatureDiffers(sig, b2.lastSig)) { resolve(displayHandleOf(b2)); return }
            const objUrl = URL.createObjectURL(blob)
            b2.frames.push({ url: objUrl, sig, blob, seq: ++frameSeq })
            b2.lastSig = sig
            while (b2.frames.length > FRAME_COUNT) {
                const old = b2.frames.shift()
                // アニメ表示中カードは、表示中フレームを消さないよう revoke を遅延し、
                // shift で実blobの位置が1つ前へ詰まる分 animIndex も戻して再生位置のズレ（コマ飛び）を防ぐ。
                // ただし末尾の静止スロット(index === frames.length)は shift で動かないので、そこに居る時は戻さない。
                if (animCard && animCard.id === id) {
                    pendingRevokes.add(old.url)
                    if (animIndex > 0 && animIndex < b2.frames.length) animIndex--
                } else {
                    URL.revokeObjectURL(old.url)
                }
            }
            persistBuffer(id) // IndexedDBへ保存（fire-and-forget）
            // ホバー保持中のカードで2枚目が貯まったら、その場でアニメを開始する
            tryStartAnim()
            resolve(displayHandleOf(b2))
        }, 'image/jpeg', 0.8)
    })
}

// 静止サムネ表示用のハンドル（最新コマの blob から**新しい object URL** を作って渡す）。
// リングバッファ側の URL とは別物なので、eviction や機能OFFの revoke に巻き込まれない。
function displayHandleOf(b) {
    const newest = b && b.frames.length ? b.frames[b.frames.length - 1] : null
    if (!newest || !newest.blob) return null
    return { url: URL.createObjectURL(newest.blob), seq: newest.seq }
}

// ---- ①(通常サムネ更新)が crossOrigin で読み込んだ画像を受け取り、再取得せずフレーム化する ----
// 戻り値は「①が静止サムネに出すべき画像」（storeFrameFromImage 参照）。null なら①はURLで表示する。
// ①は各カードのプリロード成功時に呼ぶ。ここでは自前取得しない。
export function ingestAnimatedThumbnailFrame(id, img) {
    // 可視状態でのガードはしない。給餌は表示用に読み込み済みの画像を使い回すだけ（新規ネット取得なし＝
    // 署名/エンコードのみで軽い）。①の描画は requestAnimationFrame 経由なので非表示中はブラウザ側で
    // 自然停止し、非表示中はそもそもここへほぼ到達しない。
    if (!enabled || captureUnsupported || !id || !img) return Promise.resolve(null)
    const b = getOrCreateBuffer(id) // ①は現在DOMにある番組のみ渡すのでバッファを用意してよい
    try {
        return storeFrameFromImage(id, img, b)
    } catch (_e) {
        return Promise.resolve(null) // 何があっても①の表示は止めない（URL表示へフォールバック）
    }
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
        if (!presentIds.has(id)) {
            // 解放対象が再生中カードなら先に停止（遅延revokeをflushしてからバッファ削除）
            if (animCard && animCard.id === id) stopAnim()
            releaseBuffer(id)
        }
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

// 今カードで表示中の静止サムネ画像のURL（平文でも読める＝crossOrigin不要）。
// ただし error フォールバック中（handleThumbnailError が data-src の固定画像や loading.gif へ
// 差し替えた状態）は「ライブサムネではない」ので null を返す。これで末尾スロットに
// 非ライブ画像（固定コミュ画像/ローディングgif）を最新のフリで混ぜる不具合を防ぐ。
// ライブか否かは ①(sidebar.js) が dataset.thumbLive で通知（成功時'1'/error時'0'）。
function getLiveStaticSrc(card) {
    const im = card && card.querySelector('.program_thumbnail_img')
    if (!im) return null
    if (im.dataset && im.dataset.thumbLive === '0') return null
    return im.currentSrc || im.src || null
}
// 末尾スロット（＝今の静止サムネを最新コマとして1枚足す安全網）を付けるべきか。
//
// 判定は**フレーム識別子(seq)の一致**だけで行う。①が給餌の戻り値をそのまま静止サムネに出した時、
// その seq を `img.dataset.thumbSeq` に書いてくる。それが最新コマと一致していれば
// 「静止サムネ＝最新コマ（同じ絵）」が確定しているので足さない。それ以外は**安全側に倒して足す**。
//
// 🔴 **URL文字列で比較しないこと。** 以前は「静止のsrc ≠ 最新コマの取得元URL」で判定していたが、
//    ①が同じURLをもう一度ダウンロードして表示していたため、URLは同じなのに中身が違う（2回の取得の間に
//    スクショが進んだ）ケースを構造的に見逃していた（doc/09 項目AV）。channel のURL不変で
//    末尾スロットが恒常無効になる問題（項目Yの残ギャップ）も、この方式なら起きない。
// - 非ライブ(error fallback)中は付けない（固定画像/loading.gif の混入を防ぐ）。
function shouldAppendStaticTail(b, card) {
    if (!b.frames.length) return false
    const live = getLiveStaticSrc(card)
    if (!live) return false           // fallback中 → 最新blobを最新扱い
    const im = card.querySelector('.program_thumbnail_img')
    const shownSeq = im && im.dataset ? Number(im.dataset.thumbSeq || 0) : 0
    const newest = b.frames[b.frames.length - 1]
    if (shownSeq && newest && shownSeq === newest.seq) return false // 静止＝最新コマ（同じ絵）
    return true
}
// 再生コマ数。通常時＝blob枚数（末尾スロットなし）。静止だけ先へ進んだ時のみ ＋1（末尾＝今の静止サムネ）。
function playCount(b, card) {
    return b.frames.length + (shouldAppendStaticTail(b, card) ? 1 : 0)
}
// 再生位置 idx のURL。idx<blob枚数ならそのblob、末尾スロットは今の静止サムネ(ライブ)src
// （都度読み直す＝ローリング更新で静止が進んでも常に最新を映す）。fallback中は null で
// showNext 側が先頭へ戻す。
function playUrlAt(b, idx, card) {
    if (idx < b.frames.length) return b.frames[idx].url
    return getLiveStaticSrc(card)
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
    // 古い順→最新の時系列で再生する（frames[0]=最も古い → 末尾）。
    // 通常時は末尾＝最新blob。crossOriginが失敗して静止だけ先に進んだ時のみ、
    // playCount が +1 して末尾に「今の静止サムネ」を足す＝最新が必ず映る（shouldAppendStaticTail 参照）。
    animIndex = 0
    const gen = ++animGen

    // 初期コマは base に即載せる（ホバー直後の即時表示）。fader は隠しておく。
    base.src = playUrlAt(buf, animIndex, card)
    base.classList.add('show')
    fader.classList.remove('show')

    const showNext = () => {
        if (animGen !== gen) return
        const b = buffers.get(card.id)
        if (!enabled || hoverCard !== card || !b || b.frames.length < 2 || !document.contains(card)) {
            stopAnim()
            return
        }
        animIndex = (animIndex + 1) % playCount(b, card)
        let nextUrl = playUrlAt(b, animIndex, card)
        if (!nextUrl) { // 末尾スロット(静止サムネ)が取れない稀ケース → 先頭へ戻す
            animIndex = 0
            nextUrl = b.frames[0].url
        }

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

function setHoverCard(card) {
    if (card === hoverCard) return
    // 別カードへ移ったらアニメを止めてから
    stopAnim()
    hoverCard = card
    if (card && card.id) {
        // 保存フレームを復元して、あれば即アニメ開始（リロード/番組移動後の復帰）
        ensureHydrated(card.id).then(() => { if (enabled && hoverCard === card) tryStartAnim() })
        // ※ホバー時に画像を取り直さない：①（通常のサムネ更新）が記録してきた履歴コマを古→新で流し、
        //   末尾は playUrlAt が「今表示中の静止サムネ」を直接映す（crossOrigin失敗時でも最新が入る）。
    }
    tryStartAnim()
}

// ---- 委譲ホバーリスナ（カードは再生成されるためコンテナに付ける） ----
function onMouseOver(e) {
    // サムネ画像領域(.program_thumbnail)にホバーしている間だけ動かす。
    // サムネ枠の外（同一カード内のタイトル/配信者名/アイコン/余白）やカード外へポインタが出たら止める
    // ＝再生対象を「サムネ画像へのホバー」に厳密に一致させる（ユーザー要望）。
    const thumb = e.target.closest ? e.target.closest('.program_thumbnail') : null
    setHoverCard(thumb ? thumb.closest('.program_container') : null)
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
