import { notifyboxAPI, liveInfoAPI } from '../config/constants.js'

/**
 * Fetch followed live programs list.
 * @param {number} [rows=100] - Max number of rows to request.
 * @returns {Promise<false|Array<any>>} notifybox_content array on success, or false on failure.
 */
export async function fetchLivePrograms(rows = 100) {
    try {
        let response = await fetch(`${notifyboxAPI}?rows=${rows}`, { credentials: 'include' })
        response = await response.json()
        if (response.meta?.status !== 200 || !response.data || !response.data.notifybox_content) return false
        return response.data.notifybox_content
    } catch (_e) {
        return false
    }
}

/**
 * Fetch detailed program info by live id (number without "lv").
 * @param {number|string} liveId - Live id without the "lv" prefix.
 * @returns {Promise<any|undefined>} Program data object on success, or undefined on failure.
 */
export async function fetchProgramInfo(liveId) {
    try {
        let response = await fetch(`${liveInfoAPI}/lv${liveId}`)
        response = await response.json()
        if (response.meta?.status !== 200 || !response.data) return undefined
        return response.data
    } catch (_e) {
        return undefined
    }
}


