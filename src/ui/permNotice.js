/**
 * 【追加の許可の案内】kick.com のサイドバーに「アップデートで新しい許可が必要になりました」を出す（doc/09 項目DE）。
 *
 * 【なぜ要るか】Kick 連携の権限は optional なので、後から origin を足しても**既に連携を有効に
 * している利用者には付かない。** Chrome は ON にし直すまで聞かないし、
 * `chrome.permissions.request()` は拡張のページでのボタン操作からしか呼べない
 * （コンテンツスクリプトからも SW からも呼べない）。よって「案内 → 設定ページのボタン」の2手になる。
 *
 * ⚠️ **ここは案内だけ。許可は設定ページ（static/options.js の「追加の許可」）で取る。**
 * ⚠️ **kick.com だけに出す。** 足した origin はどれも kick.com 上の中継用で、ニコ生ページは
 *    自分で叩けるので要らない（kickIntro の逆向きの例外。検査 DE で固定）。
 *
 * 🔴 **保存キーを `optionKeys` に入れないこと**（kickIntro と同じ理由）。設定ではなく一度きりのUI状態。
 */

/** ×で閉じた時に、その時足りなかった origin を覚えるキー。 */
export const PERM_NOTICE_KEY = 'permNoticeDismissedOrigins'

/**
 * 案内を出してよいか。
 *
 * 🔴 **×で閉じた origin では二度と出さない。** ただし**後でまた origin を足したら出す**
 *    （閉じた時に無かった origin が足りなくなった＝新しい話なので）。
 * ⚠️ **判断できない時は出さない。** SW が答えない・storage が読めない時に出すと、
 *    閉じたはずの案内が復活する。壊れ方は「出ない」側へ倒す。
 *
 * @param {{missing: string[]|null, dismissed: string[]|null}} state
 * @returns {boolean}
 */
export function shouldShowPermNotice(state) {
    if (!state || !Array.isArray(state.missing) || !Array.isArray(state.dismissed)) return false
    return state.missing.some((origin) => !state.dismissed.includes(origin))
}

/**
 * まだ許可されていない origin を SW に聞く（`chrome.permissions` はコンテンツスクリプトから呼べない）。
 * ⚠️ Kick 連携が無効なら SW は空を返す（連携を使っていない人に「足りない」とは言わない）。
 * @returns {Promise<string[]|null>} 答えが得られなければ null（＝出さない側へ倒す）
 */
export function readMissingPermissions() {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ type: 'kick:extraPermissions' }, (res) => {
                if (chrome.runtime.lastError || !res || res.ok !== true || !Array.isArray(res.missing)) {
                    resolve(null)
                    return
                }
                resolve(res.missing.filter((o) => typeof o === 'string'))
            })
        } catch (e) {
            resolve(null) // 拡張が無効化済み
        }
    })
}

/**
 * ×で閉じた origin を読む。**キーが無ければ空**（＝まだ閉じていない）。
 * @returns {Promise<string[]|null>} 読めなければ null（＝出さない側へ倒す）
 */
export function readPermNoticeDismissed() {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get(PERM_NOTICE_KEY, (res) => {
                if (chrome.runtime.lastError) { resolve(null); return }
                const v = res && res[PERM_NOTICE_KEY]
                resolve(Array.isArray(v) ? v.filter((o) => typeof o === 'string') : [])
            })
        } catch (e) {
            resolve(null)
        }
    })
}

/**
 * ×で閉じたことを保存する。**前に閉じた分に足す**（上書きすると、前に閉じた origin の案内が復活する）。
 * @param {string[]} missing 閉じた時点で足りなかった origin
 * @returns {Promise<void>}
 */
export async function savePermNoticeDismissed(missing) {
    const before = (await readPermNoticeDismissed()) || []
    const merged = Array.from(new Set([...before, ...(Array.isArray(missing) ? missing : [])]))
    return new Promise((resolve) => {
        try {
            chrome.storage.local.set({ [PERM_NOTICE_KEY]: merged }, () => {
                // lastError を読んでおかないと未処理エラーとして残る。保存できなくても画面は閉じる。
                void chrome.runtime.lastError
                resolve()
            })
        } catch (e) {
            resolve()
        }
    })
}
