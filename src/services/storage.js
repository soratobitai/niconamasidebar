import { maxSaveProgramInfos, viewerSampleMinGapMs, viewerSampleMaxAgeMs, viewerSampleMaxCount, optionKeys } from '../config/constants.js'
import { handleError } from '../utils/error.js'

/**
 * 設定として保存してよいキーだけを取り出す。**storage へ書く手前の唯一の関所。**
 *
 * 🔴 **`getOptions` の戻り値をそのまま storage へ書かないこと**（2026-08-11・doc/09 項目CP）。
 *    あれは `chrome.storage.local.get()` をキー未指定で呼んだ結果＝**storage 全体**であり、
 *    視聴履歴 `watchCounts` や Kick のアイコンキャッシュまで混ざっている。
 *    しかも**ページを開いた瞬間のスナップショット**なので、書き戻すとその後に他の書き手が
 *    足したものが消える（利用者報告「おすすめ順の点数が急に0に戻る」の正体）。
 *
 * ⚠️ 値が無いキーは**書かない**。`undefined` を渡すと storage に null が入り、
 *    次回の `{...defaultOptions, ...stored}` で既定値を上書きしてしまう。
 * @param {Record<string, any>} obj
 * @returns {Record<string, any>}
 */
function pickOptionKeys(obj) {
    const out = {}
    if (!obj) return out
    for (const k of optionKeys) if (obj[k] !== undefined) out[k] = obj[k]
    return out
}

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
    // 末尾は**可動点**。毎回 `[now, 今の累計]` へ進める。その手前が最後の確定点。
    //
    // 🔴 **時刻を据え置いたまま値だけ更新しないこと**（2026-08-11・doc/09 項目CQ）。
    //    旧実装は `[last[0], viewers]` と書いていた。すると「その時刻に累計はこれだった」が
    //    嘘になり、**次の点との差分＝その区間に来た人数が足りなくなる。**
    //    しかもいちばん重みの大きい直近の区間で起きるので、推定が常に1割ほど低く出た
    //    （実測: 真値85に対し 77 で頭打ち。観測を始めた直後は 16）。
    //
    // ⚠️ 確定させるのは「可動点が最後の確定点から間隔ぶん離れたら」。可動点の**今の時刻**で
    //    判定すること。`now` で判定すると確定点どうしが間隔より詰まり、
    //    170分ぶん持つと上限（`viewerSampleMaxCount`）に当たって古い方から落ちる。
    const n = list.length
    if (n < 2) {
        list.push([now, viewers])                    // 1点目＝観測の起点、2点目＝可動点
    } else if (Number(list[n - 1][0]) - Number(list[n - 2][0]) >= viewerSampleMinGapMs) {
        list.push([now, viewers])                    // 可動点が離れた → そこで確定させ、新しい可動点を作る
    } else {
        list[n - 1] = [now, viewers]                 // まだ近い → 可動点を今へ進める
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

    return options
}

export async function getOptions(defaultOptions = {}) {
    let merged
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

        merged = migrateOptions({ ...defaultOptions, ...stored })
    } catch (error) {
        // ここだけが「設定を読めなかった」＝既定へ倒してよい唯一の場合。
        // 🔴 **静かに倒さないこと。** 症状は「設定が全部あの日だけ効かない」で、
        //    利用者からは原因が絶対に分からない（2026-08-17・doc/09 項目CZ）。
        handleError(error, { function: 'getOptions', phase: 'read', storage: 'chrome.storage.local' })
        console.warn(
            '[設定] 保存済みの設定を読めなかったため、このページでは既定値で動きます。'
            + '同時視聴者数・経過時間などの表示が出ないのはこのためです。ページを再読込すると直ります。'
        )
        // ⚠️ **控えを返すこと。** 呼び出し元は戻り値を `options` として持ち回り、
        //    `storage.onChanged` で書き換える（`options.showViewerCount = …`）。
        //    渡された既定オブジェクトそのものを返すと、その書き換えが**呼び出し元の
        //    `defaultOptions` を汚染する**。今は getOptions がページ1回だけなので実害は出ないが、
        //    2回目の呼び出しが増えた瞬間に「既定のはずが前回の値」になる。
        return { ...defaultOptions }
    }

    // 既定値の焼き付け。**読み取りとは別の try に置くこと。**
    // 🔴 **ここが失敗しても `merged` を捨ててはいけない**（2026-08-17・doc/09 項目CZ）。
    //    以前は read と同じ try に入っており、**書き戻しがこけただけで読めていた設定を捨てて
    //    既定を返していた。** 既定は同時視聴者数も経過時間も OFF なので、
    //    「両方ONにしているのに全番組で出ない・再読込すると直る」になる（利用者報告）。
    //    書き戻しは次回を速くするための副作用であって、戻り値の正しさとは関係が無い。
    // 🔴 **書き戻すのは設定キーだけ。** `merged` は storage 全体を含んでいるので、
    //    そのまま set すると読み込み時点のスナップショットで他の書き手を上書きする。
    try {
        await new Promise((resolve, reject) => {
            chrome.storage.local.set(pickOptionKeys(merged), () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError)
                } else {
                    resolve()
                }
            })
        })
    } catch (error) {
        handleError(error, { function: 'getOptions', phase: 'writeback', storage: 'chrome.storage.local' })
    }

    return merged
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
    // 🔴 **設定キーだけを取り出してから書く**（doc/09 項目CP）。呼び出し側が渡してくるのは
    //    `getOptions` の戻り値＝storage 全体のスナップショットで、視聴履歴などが混ざっている。
    const toSave = pickOptionKeys(options)
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
 * @param {Array<object>} programInfos **破壊的に `viewerSamples`（来場者の履歴）を書き戻す**。
 *   前回値との差分が要るのでここでしか計算できず、描画側も同じ配列を使うため（本文の🔴を参照）。
 */
export function upsertProgramInfos(programInfos) {
    if (!Array.isArray(programInfos) || programInfos.length === 0) return
    const list = getProgramInfos()
    const byId = new Map(list.map((info) => [info.id, info]))
    const now = Date.now()
    for (const info of programInfos) {
        if (!info || !info.id) continue
        // ⚠️ **ここで「誰も読まない値」を作らないこと**（2026-08-13・doc/09 項目CM-2）。
        //    以前は `momentum`（勢い）と `viewerRate`（到着レート）も毎周期ここで計算して
        //    保存していたが、順位が推定同接へ移った後は**読み手が自分自身しか居なかった**。
        //    番組数ぶんの計算と storage への書き込みだけが残るので、撤去した。
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
        //    サムネURLの引き継ぎと同じ理由で**渡された info 自身にも書き戻す**
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


