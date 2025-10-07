import { notifyboxAPI, liveInfoAPI, programInfoTtlMs } from '../config/constants.js'

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
            if (response.meta?.status !== 200 || !response.data || !response.data.notifybox_content) return false
            return response.data.notifybox_content
        } catch (_e) {
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
// TTL cache and in-flight dedupe for detail API
const programInfoCache = new Map() // liveId -> { data, fetchedAt }
const programInfoInFlight = new Map() // liveId -> Promise

export async function fetchProgramInfo(liveId) {
    const id = String(liveId)
    const now = Date.now()

    // Serve from cache within TTL
    const cached = programInfoCache.get(id)
    if (cached && cached.data && (now - cached.fetchedAt) < programInfoTtlMs) {
        return cached.data
    }

    // In-flight dedupe
    if (programInfoInFlight.has(id)) {
        return programInfoInFlight.get(id)
    }

    const p = (async () => {
        try {
            let response = await fetch(`${liveInfoAPI}/lv${id}`)
            response = await response.json()
            if (response.meta?.status !== 200 || !response.data) return undefined
            const data = response.data
            programInfoCache.set(id, { data, fetchedAt: Date.now() })
            return data
        } catch (_e) {
            return undefined
        } finally {
            programInfoInFlight.delete(id)
        }
    })()

    programInfoInFlight.set(id, p)
    return p
}


