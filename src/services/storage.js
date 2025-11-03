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
export function setProgramInfos(list) {
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
    if (idx !== -1) {
        list[idx] = programInfo
    } else {
        list.push(programInfo)
    }
    while (list.length > maxSaveProgramInfos) {
        list.shift()
    }
    setProgramInfos(list)
}


