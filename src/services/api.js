import { notifyboxAPI, liveInfoAPI, programInfoTtlMs } from '../config/constants.js'
import { handleError } from '../utils/error.js'

/**
 * Fetch followed live programs list.
 * @param {number} [rows=100] - Max number of rows to request.
 * @returns {Promise<false|Array<any>>} notifybox_content array on success, or false on failure.
 */
// In-flight dedupe for list API
const liveProgramsInFlight = new Map()

export async function fetchLivePrograms(rows = 100) {
    const key = String(rows)
    if (liveProgramsInFlight.has(key)) {
        return liveProgramsInFlight.get(key)
    }

    const p = (async () => {
        try {
            let response = await fetch(`${notifyboxAPI}?rows=${rows}`, { credentials: 'include' })
            response = await response.json()
            if (response.meta?.status !== 200 || !response.data || !response.data.notifybox_content) {
                handleError(
                    new Error(`API returned status ${response.meta?.status || 'unknown'}`),
                    { api: 'fetchLivePrograms', rows, response: response.meta }
                )
                return false
            }
            return response.data.notifybox_content
        } catch (error) {
            handleError(error, { api: 'fetchLivePrograms', rows })
            return false
        } finally {
            // clear in-flight regardless of outcome
            liveProgramsInFlight.delete(key)
        }
    })()

    liveProgramsInFlight.set(key, p)
    return p
}

/**
 * Fetch detailed program info by live id (number without "lv").
 * @param {number|string} liveId - Live id without the "lv" prefix.
 * @returns {Promise<any|undefined>} Program data object on success, or undefined on failure.
 */
// In-flight dedupe for detail API（同時リクエストの重複防止のみ）
const programInfoInFlight = new Map() // liveId -> Promise

export async function fetchProgramInfo(liveId) {
    const id = String(liveId)

    // In-flight dedupe（同時リクエストの重複防止）
    if (programInfoInFlight.has(id)) {
        return programInfoInFlight.get(id)
    }

    const p = (async () => {
        try {
            let response = await fetch(`${liveInfoAPI}/lv${id}`)
            response = await response.json()
            if (response.meta?.status !== 200 || !response.data) {
                if (response.meta?.status !== 200) {
                    handleError(
                        new Error(`API returned status ${response.meta.status}`),
                        { api: 'fetchProgramInfo', liveId: id, status: response.meta.status }
                    )
                }
                return undefined
            }
            const data = response.data
            return data
        } catch (error) {
            handleError(error, { api: 'fetchProgramInfo', liveId: id })
            return undefined
        } finally {
            programInfoInFlight.delete(id)
        }
    })()

    programInfoInFlight.set(id, p)
    return p
}


