import { maxSaveProgramInfos } from '../config/constants.js'
import { handleError } from '../utils/error.js'

/**
 * Get options from chrome.storage.local and merge with defaults.
 * @param {Record<string, any>} [defaultOptions]
 * @returns {Promise<Record<string, any>>}
 */
export async function getOptions(defaultOptions = {}) {
    try {
        const stored = await new Promise((resolve, reject) => {
            chrome.storage.local.get((result) => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError)
                } else {
                    resolve(result || {})
                }
            })
        })

        const merged = { ...defaultOptions, ...stored }

        await new Promise((resolve, reject) => {
            chrome.storage.local.set(merged, () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError)
                } else {
                    resolve()
                }
            })
        })

        return merged
    } catch (error) {
        handleError(error, { function: 'getOptions', storage: 'chrome.storage.local' })
        return defaultOptions
    }
}

/**
 * Persist options to chrome.storage.local.
 * @param {Record<string, any>} options
 * @returns {Promise<void>}
 */
export async function saveOptions(options) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set(options, () => {
            if (chrome.runtime.lastError) {
                const error = new Error(chrome.runtime.lastError.message || 'Storage save failed')
                handleError(error, { function: 'saveOptions', storage: 'chrome.storage.local' })
                reject(chrome.runtime.lastError)
            } else {
                resolve()
            }
        })
    })
}

/**
 * Save sidebar open state.
 * @param {boolean} isOpen
 */
export function setIsOpenSidebar(isOpen) {
    chrome.storage.local.set({ isOpenSidebar: isOpen })
}

/**
 * Save sidebar width.
 * @param {number} width
 */
export function setSidebarWidth(width) {
    chrome.storage.local.set({ sidebarWidth: width })
}

/**
 * Save sidebar theme ('dark' | 'light').
 * @param {string} theme
 */
export function setSidebarTheme(theme) {
    chrome.storage.local.set({ sidebarTheme: theme })
}

/**
 * Read programInfos from localStorage.
 * @returns {any[]}
 */
export function getProgramInfos() {
    try {
        return JSON.parse(localStorage.getItem('programInfos')) || []
    } catch (error) {
        handleError(error, { function: 'getProgramInfos', storage: 'localStorage' })
        return []
    }
}

/**
 * Write programInfos to localStorage.
 * @param {any[]} list
 */
function setProgramInfos(list) {
    try {
        localStorage.setItem('programInfos', JSON.stringify(list))
    } catch (error) {
        handleError(error, { function: 'setProgramInfos', storage: 'localStorage' })
        // QuotaExceededなどの場合、古いデータを削除して再試行
        if (error.name === 'QuotaExceededError' || error.code === 22) {
            try {
                // データを半分に減らして再試行
                const reducedList = list.slice(-Math.floor(list.length / 2))
                localStorage.setItem('programInfos', JSON.stringify(reducedList))
            } catch (retryError) {
                handleError(retryError, { function: 'setProgramInfos', storage: 'localStorage', retry: true })
            }
        }
    }
}

/**
 * Insert or replace program info and trim to max size.
 * @param {any} programInfo
 */
export function upsertProgramInfo(programInfo) {
    if (!programInfo || !programInfo.id) return
    const list = getProgramInfos()
    const idx = list.findIndex((info) => info.id === programInfo.id)
    // 取得時刻を記録用メタデータとして付与。
    // 引数オブジェクトを汚さないよう浅いコピーを保存する。
    const record = { ...programInfo, _fetchedAt: Date.now() }
    if (idx !== -1) {
        list[idx] = record
    } else {
        list.push(record)
    }
    while (list.length > maxSaveProgramInfos) {
        list.shift()
    }
    setProgramInfos(list)
}

/**
 * 複数の番組情報を1回の read/merge/write でまとめて upsert する（bulk）。
 * フォロー中ページ・スクレイプは毎サイクル全番組を書き戻すため、upsertProgramInfo を件数分
 * 呼ぶと O(N^2) になる。これを1回の読み書きに畳む。id 一致は上書き、無ければ追加、末尾から上限トリム。
 * 各レコードに _fetchedAt（取得時刻）を付与する。毎回フルレコードで上書きするので、
 * サムネURL未生成のまま古い値が固定化することはない。
 * @param {Array<object>} programInfos
 */
export function upsertProgramInfos(programInfos) {
    if (!Array.isArray(programInfos) || programInfos.length === 0) return
    const list = getProgramInfos()
    const byId = new Map(list.map((info) => [info.id, info]))
    const now = Date.now()
    for (const info of programInfos) {
        if (!info || !info.id) continue
        // 既存idは一度消してから入れ直し、touchしたレコードを末尾（=最新）へ移す。
        // これで上限トリム(先頭shift)は「今回更新されなかった古いレコード(=放送終了済み等)」から落ちる。
        byId.delete(info.id)
        byId.set(info.id, { ...info, _fetchedAt: now })
    }
    const merged = Array.from(byId.values())
    while (merged.length > maxSaveProgramInfos) {
        merged.shift()
    }
    setProgramInfos(merged)
}


