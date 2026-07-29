import { notifyboxAPI, liveInfoAPI } from '../config/constants.js'
import { handleError } from '../utils/error.js'

// notifybox はリストの「早さ」担当。2026-07-29 の実測で、user番組の新着検知が
// フォローAPIより 20〜101秒 速いことが分かったため、和集合方式で併用している（doc/09 項目AD）。
// 返すのは実質 id と title だけなので、詳細と並び順はフォローAPI側が担う。

/**
 * フォロー中の放送中番組リストを notifybox から取得する。
 * @param {number} [rows=100] 取得件数（ページングは無い＝最大100件）
 * @returns {Promise<false|Array<any>>} notifybox_content 配列、失敗時は false
 */
const liveProgramsInFlight = new Map()

export async function fetchLivePrograms(rows = 100) {
    const key = String(rows)
    if (liveProgramsInFlight.has(key)) return liveProgramsInFlight.get(key)

    const p = (async () => {
        try {
            let response = await fetch(`${notifyboxAPI}?rows=${rows}`, { credentials: 'include' })
            response = await response.json()
            if (response.meta?.status !== 200 || !response.data || !response.data.notifybox_content) {
                handleError(
                    new Error(`notifybox returned status ${response.meta?.status || 'unknown'}`),
                    { api: 'fetchLivePrograms', rows, response: response.meta }
                )
                return false
            }
            return response.data.notifybox_content
        } catch (error) {
            handleError(error, { api: 'fetchLivePrograms', rows })
            return false
        } finally {
            liveProgramsInFlight.delete(key)
        }
    })()

    liveProgramsInFlight.set(key, p)
    return p
}

/**
 * Fetch detailed program info by live id (number without "lv").
 * 用途を限定: フォローAPIがライブサムネを返さない番組（固定画像配信者など）だけ呼び、
 * liveScreenshotThumbnailUrls を補完する。全番組には使わない。
 * @param {number|string} liveId - Live id without the "lv" prefix.
 * @returns {Promise<any|undefined>} Program data object on success, or undefined on failure.
 */
// In-flight dedupe for detail API（同時リクエストの重複防止のみ）
const programInfoInFlight = new Map() // liveId -> Promise

export async function fetchProgramInfo(liveId) {
    const id = String(liveId)

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
            return response.data
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
