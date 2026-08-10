import { maxSaveProgramInfos } from '../config/constants.js'
import { handleError } from '../utils/error.js'
import { nextMomentum, nextViewerRate } from '../utils/momentum.js'

/**
 * Get options from chrome.storage.local and merge with defaults.
 * @param {Record<string, any>} [defaultOptions]
 * @returns {Promise<Record<string, any>>}
 */
/**
 * 保存済みの古い値を、今ある選択肢へ寄せる。
 *
 * 🔴 **設定の選択肢を消す時は、必ずここへ寄せ先を足すこと。**
 *    保存値に対応するラジオが設定画面に無いと、`updateCheckedState` は**どれも選ばない**状態にし、
 *    `saveOptions` は「1つも選ばれていない」で早期 return する。
 *    その結果、**その利用者はテーマも並び順も含めて設定を一切保存できなくなる**（無言で）。
 *
 * ⚠️ 呼び出し元（getOptions）はこの戻り値をそのまま storage へ書き戻すので、寄せた値は永続化される。
 */
function migrateOptions(options) {
    // 自動更新の「180秒」を廃止し「OFF」に置き換えた（2026-08-07・doc/09 項目BQ）。
    // ⚠️ **OFF ではなく 120秒へ寄せる。** 黙って取得が止まるほうが利用者にとって驚きが大きい。
    if (String(options.updateProgramsInterval) === '180') options.updateProgramsInterval = '120'
    return options
}

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

        const merged = migrateOptions({ ...defaultOptions, ...stored })

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
        // 推定同接（人気順の第1キー）の材料。**来場者だけ**の到着レート。
        // momentum と同じ理由でここが唯一の計算地点であり、同じ理由で渡された info 自身へ
        // 破壊的に書き戻す（保存用のコピーにだけ書くと画面に反映されない）。
        info.viewerRate = nextViewerRate(byId.get(info.id), info, now)
        // 🔴 **サムネのURLを「空」で上書きしないこと**（2026-08-10・doc/09 項目CJ）。
        //    ここは丸ごと置き換えなので、**補完に1回失敗しただけで前回埋まったURLが消える。**
        //    実際にそれで「ライブサムネが出ず配信者アイコンのまま」になっていた（再現済み）。
        //
        //    経路: 一覧APIは縦型配信や固定画像運用のスクショを listing-thumbnail プロキシに
        //    包んで返す（ライブ判定を通らない形＝意図的に弾いている）。その番組は
        //    `fillMissingDetails` が詳細APIで埋めるが、詳細APIが一瞬返らなかった周期は
        //    `thumbnailUrl` が空のまま来る。それをそのまま保存すると前回の成果が消え、
        //    `applyProgramInfoToCard` が `data-src` をアイコンへ戻し、
        //    `syncStaticThumb` が表示までアイコンへ押し戻す。
        //
        // ⚠️ **ライブサムネは「同じURLで中身が変わる」**（doc/09 項目AA）。URLを覚えておくのは
        //    古い絵を出し続けることにはならない。番組が終われば レコードごと消える。
        // 🔴 **渡された info 自身にも書き戻すこと（破壊的）。** momentum と同じ理由で、
        //    呼び出し元は upsert に渡した配列をそのまま描画へ回す。保存用のコピーにだけ書くと
        //    **保存は直るのに画面はアイコンのまま**という、いちばん分かりにくい形になる。
        const prev = byId.get(info.id)
        if (prev) {
            if (!info.thumbnailUrl && prev.thumbnailUrl) info.thumbnailUrl = prev.thumbnailUrl
            if (!info.large1280x720ThumbnailUrl && prev.large1280x720ThumbnailUrl) {
                info.large1280x720ThumbnailUrl = prev.large1280x720ThumbnailUrl
            }
            const nextShot = info.liveScreenshotThumbnailUrls && info.liveScreenshotThumbnailUrls.middle
            const prevShot = prev.liveScreenshotThumbnailUrls && prev.liveScreenshotThumbnailUrls.middle
            if (!nextShot && prevShot) info.liveScreenshotThumbnailUrls = prev.liveScreenshotThumbnailUrls
        }
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


