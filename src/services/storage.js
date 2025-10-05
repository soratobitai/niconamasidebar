import { maxSaveProgramInfos } from '../config/constants.js'

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
    } catch (_e) {
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
    } catch (_e) {
        return []
    }
}

/**
 * Write programInfos to localStorage.
 * @param {any[]} list
 */
export function setProgramInfos(list) {
    localStorage.setItem('programInfos', JSON.stringify(list))
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


