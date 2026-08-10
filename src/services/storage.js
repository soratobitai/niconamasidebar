import { maxSaveProgramInfos, dwellMinutesScale, defaultDwellMinutes, viewerSampleMinGapMs, viewerSampleMaxAgeMs, viewerSampleMaxCount } from '../config/constants.js'
import { handleError } from '../utils/error.js'
import { nextMomentum, nextViewerRate } from '../utils/momentum.js'

/** 目盛り校正の移行が済んだ印。**消さないこと**（消すと毎回移行が走る）。 */
const DWELL_SCALE_MIGRATED_KEY = 'dwellScaleV3'

/**
 * 来場者の履歴に1点足す。古いものと近すぎるものは捨てる。
 *
 * ⚠️ **間引かないと保存が膨らむ。** 番組は100件規模で、取得は最短30秒ごと。
 *    間引き無しだと1番組あたり300点を超える。`viewerSampleMinGapMs` より近い点は足さない。
 * ⚠️ 上限（`viewerSampleMaxCount`）は歯止め。間引きが効いていれば普通は届かない。
 * 🔴 **来場者が減った時も記録すること。** 取得元の揺れで減ることがあるが、そこで
 *    記録を止めると窓の起点が古いまま固まり、推定が過大になる。
 *
 * @param {Array<[number, number]>|undefined} prev 前回までの履歴
 * @param {number} viewers 今回の累計来場者
 * @param {number} now 現在時刻(ms)
 * @returns {Array<[number, number]>}
 */
function appendViewerSample(prev, viewers, now) {
    const list = Array.isArray(prev) ? prev.filter(
        (s) => Array.isArray(s) && Number.isFinite(Number(s[0])) && Number.isFinite(Number(s[1])),
    ) : []
    const last = list.length ? list[list.length - 1] : null
    // 近すぎる点は足さない（間引き）。ただし最後の1点は最新の値へ更新しておく。
    if (last && now - Number(last[0]) < viewerSampleMinGapMs) {
        list[list.length - 1] = [Number(last[0]), viewers]
    } else {
        list.push([now, viewers])
    }
    const cutoff = now - viewerSampleMaxAgeMs
    const fresh = list.filter((s) => Number(s[0]) >= cutoff)
    return fresh.length > viewerSampleMaxCount ? fresh.slice(fresh.length - viewerSampleMaxCount) : fresh
}

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

    // 「人気順の基準」の目盛りを校正し直した（2026-08-10・doc/09 項目CN）。
    //
    // 経緯: 旧 [3,5,8,10,14,20,30,45] → 一度 [10,17,27,40,58,80,110,150] へ広げたが、
    // 実機比較で**17分あたりが正解**と分かり、17分を中心に幅を狭めた（最終形）。
    //
    // 🔴 **古い保存値は新しい目盛りの外に居る。** 45分も40分も、今の範囲(11〜29)には無い。
    //    範囲外はすべて**新しい既定へ寄せる**。中途半端に端へ丸めると、利用者が意図しない
    //    設定のまま使い続けることになる（今の目盛りでは端＝かなり極端な指定）。
    // ⚠️ **1回だけ動かすこと。** 印が無いと、利用者が端を選ぶたびに既定へ戻され続ける。
    if (!options[DWELL_SCALE_MIGRATED_KEY]) {
        const m = Number(options.dwellMinutes)
        const lo = dwellMinutesScale[0]
        const hi = dwellMinutesScale[dwellMinutesScale.length - 1]
        if (!Number.isFinite(m) || m < lo || m > hi) {
            options.dwellMinutes = defaultDwellMinutes
        } else {
            let best = dwellMinutesScale[0]
            for (const v of dwellMinutesScale) if (Math.abs(v - m) < Math.abs(best - m)) best = v
            options.dwellMinutes = best
        }
        options[DWELL_SCALE_MIGRATED_KEY] = true
    }
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
        // 🔴 **`viewerRateSeeded` も一緒に持ち回すこと**（doc/09 項目CL）。
        //    「この到着レートはまだ仮置き（累計来場者からの当て推量）である」という印で、
        //    次回に実測が取れた時これを見て**混ぜずに置き換える**。落とすと元の
        //    「新着がいきなり上位に入り20分かけて落ちる」動きに戻る。
        const rateInfo = nextViewerRate(byId.get(info.id), info, now)
        info.viewerRate = rateInfo.rate
        info.viewerRateSeeded = rateInfo.seeded
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
        // 来場者の履歴。**推定同接の本体の材料**（doc/09 項目CO）。
        // 🔴 **ここが唯一の記録地点。** 新しい来場者数と時刻が出会うのはここだけで、
        //    momentum / viewerRate と同じ理由で**渡された info 自身にも書き戻す**
        //    （保存用のコピーにだけ書くと、画面が使う側に履歴が無く推定が従来式へ落ちる）。
        info.viewerSamples = appendViewerSample(
            (byId.get(info.id) || {}).viewerSamples, Number(info.viewers) || 0, now,
        )

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


