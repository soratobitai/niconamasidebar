/**
 * 動くサムネのフレーム永続化ストア。
 *
 * 🔴 **実体は Service Worker 側の IndexedDB。ここは中継。**
 *    以前はこのファイルが直接 IndexedDB を開いていたが、**IndexedDB はオリジンごとに
 *    完全に分離される**ため、live.nicovideo.jp と kick.com で別々の保管庫になっていた。
 *    サイトを移るたびにコマを貯め直しになる（実測で1〜2分）。
 *    SW は拡張のオリジンなので、どちらのサイトから来ても同じ保管庫を見られる。
 *
 * ⚠️ **Blob は `chrome.runtime` のメッセージを通れない**（JSON 直列化のため）。
 *    ここで base64 にしてから渡し、受け取り側で Blob に戻す。
 *    ・保存は1周期あたり1〜3件（ローリング更新なので全件同時ではない）
 *    ・復元はホバーしたカード1件分だけ（`ensureHydrated` が呼ぶ）
 *    実測規模ではどちらも数十〜数百KBで、ローカルIPCとして問題にならない。
 *
 * 使えない状況（拡張の無効化・SW 応答なし・容量超過）では**静かに no-op / null を返す**。
 * 永続化が落ちてもメモリ上のコマだけで動き続ける。
 */

/** 拡張が生きているか。無効化後もコンテンツスクリプトは動き続けるので、呼ぶ前に確かめる。 */
function alive() {
    try {
        return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id
    } catch (e) {
        return false
    }
}

/** 引数が多すぎて落ちないよう分割して base64 化する。 */
function bytesToB64(bytes) {
    let bin = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
    }
    return btoa(bin)
}

function b64ToBytes(b64) {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
}

async function blobToWire(blob) {
    const buf = await blob.arrayBuffer()
    return { b64: bytesToB64(new Uint8Array(buf)), type: blob.type || 'image/jpeg' }
}

// 🔴 **どのコマを SW へ送り済みかを覚えておく（番組ID -> sig の集合）。**
//    毎回すべてのコマを base64 化して送ると、1回の保存が数百KBになる。
//    kick.com は全カードをまとめて更新するので、1周期で1MBを超えていた。
//    送るのは**新しく増えたコマだけ**にする。
const sentSigs = new Map()

function sentSetFor(id) {
    let s = sentSigs.get(id)
    if (!s) { s = new Set(); sentSigs.set(id, s) }
    return s
}

/**
 * メモリ上のレコードを差分の形へ。
 * `order` は全コマの並び（sig の base64）。`payload` は**未送信のコマだけ**。
 * `sig`（知覚ハッシュ）は Uint8Array なのでこれも base64 にする。
 */
async function toDelta(id, record) {
    const sent = sentSetFor(id)
    const order = []
    const payload = {}
    for (const f of (record && record.frames) || []) {
        if (!f || !f.blob) continue
        // sig が無いコマは同一性を判断できない。毎回送るしかないので、内容から鍵を作る。
        const sig = f.sig ? bytesToB64(f.sig) : null
        if (!sig) continue
        order.push(sig)
        if (!sent.has(sig)) {
            const { b64, type } = await blobToWire(f.blob)
            payload[sig] = { b64, type }
        }
    }
    return {
        delta: {
            order,
            payload,
            lastSig: record && record.lastSig ? bytesToB64(record.lastSig) : null,
            updatedAt: (record && record.updatedAt) || Date.now(),
        },
        order,
    }
}

/** 運ばれてきた形をメモリ上のレコードへ戻す。 */
function fromWire(wire) {
    if (!wire) return null
    const frames = []
    for (const f of wire.frames || []) {
        if (!f || !f.b64) continue
        frames.push({
            blob: new Blob([b64ToBytes(f.b64)], { type: f.type || 'image/jpeg' }),
            sig: f.sig ? b64ToBytes(f.sig) : null,
        })
    }
    return { frames, lastSig: wire.lastSig ? b64ToBytes(wire.lastSig) : null, updatedAt: wire.updatedAt || 0 }
}

/**
 * 番組1件のフレームを保存（置換）。
 * @param {string} id 番組ID
 * @param {{frames: Array<{blob: Blob, sig: Uint8Array}>, lastSig: Uint8Array|null, updatedAt: number}} record
 */
export async function saveFrames(id, record) {
    if (!alive() || !id) return
    const key = String(id)
    try {
        const { delta, order } = await toDelta(key, record)
        if (!order.length) return
        const res = await chrome.runtime.sendMessage({ type: 'frames:save', id: key, record: delta })

        // 揃わなかった＝SW 側が cleanup で消していた等。送信済みの記録を捨てて、
        // 次回に全部送り直す（黙って欠けたまま固定されるのを防ぐ）。
        if (!res || res.ok !== true || res.stored !== order.length) {
            sentSigs.delete(key)
            return
        }
        sentSigs.set(key, new Set(order))
    } catch (e) {
        // 永続化はスキップ（機能はメモリのみで継続）。次回に全部送り直す。
        sentSigs.delete(key)
    }
}

/**
 * 番組1件のフレームを取得。無ければ null。
 * @param {string} id
 * @returns {Promise<null|{frames: Array<{blob: Blob, sig: Uint8Array}>, lastSig: Uint8Array|null, updatedAt: number}>}
 */
export async function loadFrames(id) {
    if (!alive() || !id) return null
    const key = String(id)
    try {
        const res = await chrome.runtime.sendMessage({ type: 'frames:load', id: key })
        const wire = res && res.ok ? res.record : null
        // 🔴 **復元したコマは「送信済み」として記録すること。**
        //    記録しないと、復元直後の保存で**同じコマをもう一度全部送る**ことになる
        //    （差分にした意味が半分無くなる）。
        if (wire && Array.isArray(wire.frames)) {
            sentSigs.set(key, new Set(wire.frames.map((f) => f && f.sig).filter(Boolean)))
        }
        return fromWire(wire)
    } catch (e) {
        return null
    }
}

/**
 * 期限切れ・上限超過のレコードを掃除する。実処理は SW 側。
 * @param {number} ttlMs これより古いレコードは削除
 * @param {number} maxEntries 生存レコードの上限
 */
export async function cleanupFrames(ttlMs, maxEntries) {
    if (!alive()) return
    try {
        await chrome.runtime.sendMessage({ type: 'frames:cleanup', ttlMs, maxEntries })
    } catch (e) {
        // skip
    } finally {
        // ⚠️ 掃除で何が消えたかは分からない。**送信済みの記録を全部捨てる。**
        //    残したままだと「SW には無いのに送らない」コマが生まれ、
        //    そのコマは二度と保存されない（次回の保存で `stored` が合わず自己修復はするが、
        //    ここで捨てておけば1周期無駄にせずに済む）。
        sentSigs.clear()
    }
}
