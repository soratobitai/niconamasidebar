import { liveInfoAPI } from '../config/constants.js'
import { handleError } from '../utils/error.js'

// 2026-07-29: notifybox API（リスト取得）は撤去した。
// フォローAPI（services/followPageSource.js）が同じ番組集合に加えて beginAt まで返すため、
// リストも詳細も1系統で足りる（実測: 集合・並びとも完全一致）。加えて notifybox は
// rows=100 でページングが無く、カードをそちらから作っていたため表示が100件で頭打ちだった。
// 経緯は doc/09 項目AD。

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
