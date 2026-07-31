/**
 * 動くサムネのフレーム永続化ストア（IndexedDB）
 *
 * ライブサムネのフレーム(blob)を番組IDキーで保存し、リロードや番組移動をまたいで復元できるようにする。
 * サイドバーに出るのはフォロー中番組でページ間で同じなので、復元フレームはそのまま使える。
 *
 * - Blob をそのまま保存（structured clone）。追加権限は不要（content script でも IndexedDB は使える）。
 * - IndexedDB が使えない環境（プライベート等）では全メソッドが静かに no-op/null を返す（グレースフル）。
 */

const DB_NAME = 'niconamasidebar'
const STORE = 'animFrames'
const DB_VERSION = 1

let dbPromise = null

function openDB() {
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
        let req
        try {
            req = indexedDB.open(DB_NAME, DB_VERSION)
        } catch (e) {
            reject(e)
            return
        }
        req.onupgradeneeded = () => {
            const db = req.result
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'id' })
            }
        }
        req.onsuccess = () => {
            const db = req.result
            // 🔴 **別タブがバージョンを上げようとしたら接続を手放すこと。**
            // 掴んだままだと相手の open が blocked で止まり、こちらの読み書きも道連れになる。
            // 利用者は視聴ページを複数タブ開くので、ここは現実に起きうる（doc/09 項目BA）。
            db.onversionchange = () => { try { db.close() } catch (_e) { /* noop */ } dbPromise = null }
            db.onclose = () => { dbPromise = null }
            resolve(db)
        }
        req.onerror = () => reject(req.error)
        // onblocked を拾わないと、**どちらのハンドラも呼ばれずこの Promise が永久に未解決**になる。
        req.onblocked = () => reject(new Error('IndexedDB open blocked'))
    })
    // 失敗時は次回リトライできるよう promise をリセット
    dbPromise.catch(() => { dbPromise = null })
    return dbPromise
}

/**
 * 番組1件のフレームを保存（put で置換）。
 * @param {string} id 番組ID（数値文字列）
 * @param {{frames: Array<{blob: Blob, sig: Uint8Array}>, lastSig: Uint8Array|null, updatedAt: number}} record
 */
export async function saveFrames(id, record) {
    try {
        const db = await openDB()
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite')
            tx.objectStore(STORE).put({ id, ...record })
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
            tx.onabort = () => reject(tx.error)
        })
    } catch (_e) {
        // IndexedDB 使用不可・容量超過など → 永続化はスキップ（機能はメモリのみで継続）
    }
}

/**
 * 番組1件のフレームを取得。無ければ null。
 * @param {string} id
 * @returns {Promise<null|{frames: Array<{blob: Blob, sig: Uint8Array}>, lastSig: Uint8Array|null, updatedAt: number}>}
 */
export async function loadFrames(id) {
    try {
        const db = await openDB()
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly')
            const req = tx.objectStore(STORE).get(id)
            req.onsuccess = () => resolve(req.result || null)
            req.onerror = () => reject(req.error)
            // ⚠️ トランザクションが中断した時（別タブのバージョン変更・接続断など）は
            // req のハンドラが**どちらも呼ばれない**。ここを拾わないと Promise が永久に未解決になり、
            // 呼び出し元（ensureHydrated → 給餌）が返らなくなる（doc/09 項目BA）。
            tx.onabort = () => reject(tx.error || new Error('tx aborted'))
            tx.onerror = () => reject(tx.error || new Error('tx error'))
        })
    } catch (_e) {
        return null
    }
}

/**
 * 期限切れ（updatedAt が古い）レコードを削除し、件数上限を超えた分を古い順に削除。
 * @param {number} ttlMs これより古いレコードは削除
 * @param {number} maxEntries 生存レコードの上限
 */
export async function cleanupFrames(ttlMs, maxEntries) {
    try {
        const db = await openDB()
        await new Promise((resolve) => {
            const tx = db.transaction(STORE, 'readwrite')
            const store = tx.objectStore(STORE)
            const cutoff = Date.now() - ttlMs
            const survivors = []
            store.openCursor().onsuccess = (e) => {
                const cursor = e.target.result
                if (cursor) {
                    const v = cursor.value
                    if (!v || typeof v.updatedAt !== 'number' || v.updatedAt < cutoff) {
                        cursor.delete()
                    } else {
                        survivors.push({ id: v.id, updatedAt: v.updatedAt })
                    }
                    cursor.continue()
                } else if (survivors.length > maxEntries) {
                    survivors.sort((a, b) => a.updatedAt - b.updatedAt)
                    const overflow = survivors.length - maxEntries
                    for (let i = 0; i < overflow; i++) store.delete(survivors[i].id)
                }
            }
            tx.oncomplete = () => resolve()
            tx.onerror = () => resolve()
            tx.onabort = () => resolve()
        })
    } catch (_e) {
        // skip
    }
}
