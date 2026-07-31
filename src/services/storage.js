import { maxSaveProgramInfos } from '../config/constants.js'
import { handleError } from '../utils/error.js'
import { nextMomentum } from '../utils/momentum.js'

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
 * 設定フォームの内容を chrome.storage.local へ保存する。
 *
 * **サイドバーの開閉状態(`isOpenSidebar`)と幅(`sidebarWidth`)は書かない**（doc/09 項目AC-2）。
 * この2つは「設定」ではなく各タブのUI状態で、専用の setIsOpenSidebar / setSidebarWidth が
 * 持ち主。呼び出し側（optionsHandler）は getOptions のマージ結果をそのまま渡してくるため、
 * 素直に全キーを set すると自タブのUI状態まで storage へ書き込まれ、chrome.storage.onChanged で
 * 全タブへ配信されてしまう。
 * 実害: オートオープンで開いたタブ（storage は false のまま options.isOpenSidebar=true）で
 * テーマや並び順を変えると isOpenSidebar が false→true に変化し、**サイドバーを閉じている
 * 別タブが「開いた」と誤認して**幅0のまま notifybox＋フォローAPI の取得を始める。
 * 「閉じているタブでは取得しない」という不変条件が、更新間隔以外の設定変更で破れていた。
 *
 * @param {Record<string, any>} options
 * @returns {Promise<void>}
 */
const UI_STATE_KEYS = ['isOpenSidebar', 'sidebarWidth']

export async function saveOptions(options) {
    const toSave = { ...options }
    for (const k of UI_STATE_KEYS) delete toSave[k]
    return new Promise((resolve, reject) => {
        chrome.storage.local.set(toSave, () => {
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
 * 1番組の「ライブサムネ関連フィールドだけ」を、最新の storage レコードにマージして書き込む。
 * A1追撃(_fetchLiveThumbIfPendingYoung)の書き戻し用。upsertProgramInfos のフルレコード置換だと、
 * 詳細API await を跨いで captured した古いスナップショットを書き、その間にスクレイプが入れた
 * 最新の視聴者数/コメント数等を巻き戻す(lost update)。ここでは await 後に再read→サムネ欄だけ上書きする。
 * @param {string} id 番組ID（'lv'あり/なしどちらでも可）
 * @param {{liveScreenshotThumbnailUrls?: any, large1280x720ThumbnailUrl?: string, thumbnailUrl?: string}} fields
 * @returns {boolean} 対象idが存在し書き込めたら true
 */
export function patchProgramThumbnail(id, fields) {
    const key = String(id).startsWith('lv') ? String(id) : `lv${id}`;
    const list = getProgramInfos();
    const idx = list.findIndex((info) => info && info.id === key);
    if (idx === -1) return false;
    list[idx] = { ...list[idx], ...fields, _fetchedAt: Date.now() };
    setProgramInfos(list);
    return true;
}

/**
 * 複数の番組情報を1回の read/merge/write でまとめて upsert する（bulk）。
 * フォロー中ページ・スクレイプは毎サイクル全番組を書き戻すため、upsertProgramInfo を件数分
 * 呼ぶと O(N^2) になる。これを1回の読み書きに畳む。id 一致は上書き、無ければ追加、末尾から上限トリム。
 * 各レコードに _fetchedAt（取得時刻）を付与する。毎回フルレコードで上書きするので、
 * サムネURL未生成のまま古い値が固定化することはない。
 * @param {Array<object>} programInfos **破壊的に `momentum`（盛り上がり）を書き戻す**。
 *   前回値との差分が要るのでここでしか計算できず、描画側も同じ配列を使うため（本文の🔴を参照）。
 */
export function upsertProgramInfos(programInfos) {
    if (!Array.isArray(programInfos) || programInfos.length === 0) return
    const list = getProgramInfos()
    const byId = new Map(list.map((info) => [info.id, info]))
    const now = Date.now()
    for (const info of programInfos) {
        if (!info || !info.id) continue
        // 「盛り上がり」は前回値との差分なので、**新旧が出会うここが唯一の計算地点**。
        //
        // 🔴 **渡された info 自身にも書き戻すこと（破壊的）。** 呼び出し元は upsert に渡した配列を
        //    そのまま描画へ回す（`_refreshDetailsViaScrape` → `_mergeSources`）。保存用のコピーにだけ
        //    書くと、画面が使うオブジェクトは momentum を知らないまま＝**計算しても順位に何も反映されない**。
        //    例外もログも出ないので、気付けるのは「人気順にしても並びが変わらない」という形だけになる。
        info.momentum = nextMomentum(byId.get(info.id), info, now)
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


