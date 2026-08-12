/**
 * Service Worker — Kick 連携の取得役。
 *
 * 🔴 **このファイルはバンドルされない。** `static/` から `dist/` へそのままコピーされる
 *    （vite.config.js の copyAssetsPlugin）。`import` は書けない。定数の重複は許容している。
 *
 * 【なぜ SW が要るのか】
 * `chrome.cookies` はコンテンツスクリプトから呼べない。Kick の認証は
 * `Authorization: Bearer <session_token cookie の値>` で、cookie の自動付与だけでは 401 になる
 * （2026-08-04 実測）。トークンの値を読む必要があるため SW が要る。
 * これにより「Service Worker なし」という以前の構成上の特徴は無くなった。
 *
 * 【責務を薄く保つこと】
 * ここでやるのは「cookie を読む → fetch する → 生の JSON を返す」だけ。
 * 正規化・並び替え・キャッシュはコンテンツスクリプト側（バンドルされる本体）の仕事。
 * SW に寄せるとバンドル外のコードが増え、共有できないロジックが二重管理になる。
 *
 * 【タイマーを置かないこと】
 * 定期取得はコンテンツスクリプトの既存の更新サイクルから叩く。ここに `chrome.alarms` を
 * 置くと `alarms` 権限が要るうえ、MV3 の SW スリープを相手にすることになる。
 */

const KICK_API = 'https://kick.com/api/v1/user/livestreams'
const KICK_ORIGIN = 'https://kick.com'
const COOKIE_NAME = 'session_token'

// Kick 連携に必要な権限。optional なので既定では持っていない。
//
// `scripting` は **kick.com にサイドバーを注入する**ために要る。静的な content_scripts で
// 宣言すると kick.com が必須のホスト権限になり、既存ユーザーが再承認を求められる
// （＝拡張が無効化される）。動的登録なら optional のままでいられる。
// `live.nicovideo.jp` は **kick.com 上でニコ生の番組も出す**ために要る。
// ニコ生の視聴ページでは同一オリジンなので権限は不要で、Kick 上でだけ中継が必要になる。
// 画像ホストは **kick.com 上で動くサムネを作る**ために要る。
// 動くサムネは crossOrigin で読んだ画像を canvas に描く方式だが、
// どちらの配信元も kick.com のオリジンに ACAO を返さない（2026-08-04 実測）。
// SW からの取得には CORS が適用されないので、ここで取って data URL にして渡す。
const KICK_PERMISSIONS = {
    permissions: ['cookies', 'scripting'],
    origins: [
        'https://kick.com/*',
        'https://live.nicovideo.jp/*',
        'https://*.dlive.nicovideo.jp/*',
        'https://images.kick.com/*',
    ],
}

// 来場者数を早く・細かく取るAPI（doc/09 項目CT）。**kick.com 上でだけ中継が要る。**
// live2 は `https://live.nicovideo.jp` オリジンにしか CORS を開いていないので、
// ニコ生の視聴ページは自分で叩ける（権限も不要）。kick.com からは叩けないのでここを通す。
//
// 🔴 **`KICK_PERMISSIONS` に足さないこと。** あれは `hasKickPermission()` が
//    `permissions.contains` で丸ごと照合しており、origin を1つ足すと**既に許可済みの
//    利用者が全員 false になって Kick 連携ごと止まる。** 要求する集合（KICK_REQUEST_PERMISSIONS）
//    にだけ足し、確認は下の hasLive2Permission で別に行う。
// ⚠️ 許可が無い時は「取れない」だけにする（kick.com では一覧APIの値のまま出る）。
const LIVE2_ORIGIN = 'https://live2.nicovideo.jp/*'
// ⚠️ src/config/constants.js の liveStatisticsApi と同じURL・同じ値にすること（検査 CT が突き合わせる）。
const LIVE2_STATISTICS_API = 'https://live2.nicovideo.jp/watch'
const LIVE2_MAX_CONCURRENT = 8

// 権限を**要求する**時の集合。⚠️ 確認（contains）には使わない。上の 🔴 を参照。
const KICK_REQUEST_PERMISSIONS = {
    permissions: KICK_PERMISSIONS.permissions,
    origins: [...KICK_PERMISSIONS.origins, LIVE2_ORIGIN],
}

// 画像中継で受け付ける最大サイズ。サムネは数十KBなので、これを超えるものは想定外。
const IMAGE_PROXY_MAX_BYTES = 2 * 1024 * 1024

// 中継してよいホスト。**ここに無いURLは取りに行かない。**
// 任意のURLを取れる中継を作ると、ページ側から拡張の権限を借りて何でも読めてしまう。
const IMAGE_PROXY_ALLOWED = [/^https:\/\/[a-z0-9-]+\.dlive\.nicovideo\.jp\//i, /^https:\/\/images\.kick\.com\//i]

// ニコ生のフォロー中番組API（放送中のみ）。src/services/followPageSource.js と同じURL。
const NICO_FOLLOW_API = 'https://live.nicovideo.jp/front/api/pages/follow/v1/programs'
const NICO_PAGE_LIMIT = 100
const NICO_MAX_PAGES = 10

// kick.com へ動的登録するコンテンツスクリプトの定義。
// 🔴 id は登録解除でも使う。変えると古い登録が消せなくなる。
const KICK_SCRIPT_ID = 'kick-sidebar'
const KICK_SCRIPT = {
    id: KICK_SCRIPT_ID,
    matches: ['https://kick.com/*'],
    js: ['kickpage.js'],
    css: ['kickpage.css'],
    runAt: 'document_idle', // Next.js の SPA。document_start だと土台がまだ無い
    persistAcrossSessions: true,
}

/**
 * kick.com へのサイドバー注入を、権限の有無に合わせて登録／解除する。
 *
 * **権限が無い状態で呼ばれても何もしない。**これは異常ではなく既定の状態。
 * 起動時・権限の増減時・インストール時に呼ぶ。何度呼んでも同じ結果になるようにしてある。
 */
async function syncKickContentScript() {
    const granted = await hasKickPermission()

    // scripting 権限が無いと chrome.scripting 自体が使えない。
    if (!chrome.scripting || !chrome.scripting.getRegisteredContentScripts) return

    let registered = []
    try {
        registered = await chrome.scripting.getRegisteredContentScripts({ ids: [KICK_SCRIPT_ID] })
    } catch (e) {
        registered = []
    }
    const already = registered.some((s) => s && s.id === KICK_SCRIPT_ID)

    try {
        if (granted && !already) {
            await chrome.scripting.registerContentScripts([KICK_SCRIPT])
        } else if (!granted && already) {
            await chrome.scripting.unregisterContentScripts({ ids: [KICK_SCRIPT_ID] })
        }
    } catch (e) {
        // 権限を落とした直後などで競合しうる。次の起動で揃うので黙って諦める。
    }
}

/**
 * 開いているタブへ Kick 連携の状態変化を知らせる。
 *
 * これが無いと、権限を外しても**次の更新周期（既定120秒）まで Kick のカードが残る**。
 * 「無効にしたのに消えない」は不具合に見えるので、その場で消えるようにする。
 *
 * ⚠️ `tabs` 権限は要らない。`chrome.tabs.query({})` は権限が無くても id は返し、
 *    こちらのコンテンツスクリプトが入っていないタブは応答しないだけ（lastError を捨てる）。
 */
async function broadcastKickState(forced) {
    // 🔴 **無効化するときは「権限を外す前に」呼ぶこと（`forced === false`）。**
    //    `permissions.onRemoved` の時点では**既にホスト権限を失っている**ため、
    //    `chrome.tabs.sendMessage` が届かず、開いているタブに撤去を伝えられない。
    //    外部（chrome://extensions）から外された場合は届かないが、その場合も
    //    次の更新周期で Kick のカードが消える（取得が no-permission を返すため）。
    const granted = typeof forced === 'boolean' ? forced : await hasKickPermission()
    let tabs = []
    try {
        tabs = await chrome.tabs.query({})
    } catch (e) {
        return
    }
    for (const tab of tabs) {
        if (!tab || tab.id == null) continue
        try {
            chrome.tabs.sendMessage(tab.id, { type: 'kick:stateChanged', granted }, () => {
                // 受け手が居ないタブでは必ずエラーになる。読み捨てないと警告が出る。
                void chrome.runtime.lastError
            })
        } catch (e) { /* 送れないタブは無視 */ }
    }
}

/**
 * 既に開いている kick.com のタブへ、その場でサイドバーを注入する。
 *
 * 🔴 **`registerContentScripts` は「これから読み込まれるページ」にしか効かない。**
 *    有効にした時点で開いている kick.com のタブは、リロードするまで何も起きない。
 *    「有効にしたのにサイドバーが出ない」に見えるので、ここで流し込む。
 */
async function injectIntoOpenKickTabs() {
    if (!chrome.scripting || !chrome.scripting.executeScript) return
    let tabs = []
    try {
        tabs = await chrome.tabs.query({ url: 'https://kick.com/*' })
    } catch (e) {
        return
    }
    for (const tab of tabs) {
        if (!tab || tab.id == null) continue
        try {
            await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: [KICK_SCRIPT.css[0]] })
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [KICK_SCRIPT.js[0]] })
        } catch (e) {
            // 既に入っている・権限が間に合っていない等。リロードすれば入るので黙って諦める。
        }
    }
}

// 権限の増減に追従する。ユーザーは chrome://extensions からも権限を外せるので、
// オプションページ側の処理だけに任せない。
if (chrome.permissions && chrome.permissions.onAdded) {
    chrome.permissions.onAdded.addListener(() => {
        syncKickContentScript()
        broadcastKickState()
        injectIntoOpenKickTabs()
    })
    chrome.permissions.onRemoved.addListener(() => {
        syncKickContentScript()
        broadcastKickState()
    })
}
// SW は寝て起きるので、起き直したときにも実態を揃える。
chrome.runtime.onStartup.addListener(syncKickContentScript)
chrome.runtime.onInstalled.addListener(syncKickContentScript)
syncKickContentScript()

// ページングの上限。`?page=N` を空になるまで回すが、暴走の保険として上限を置く。
const MAX_PAGES = 20

/**
 * Kick 連携の権限を持っているか。
 * 権限が無い状態は**異常ではなく既定**なので、例外にせず false を返す。
 */
function hasKickPermission() {
    return new Promise((resolve) => {
        try {
            chrome.permissions.contains(KICK_PERMISSIONS, (granted) => {
                resolve(!chrome.runtime.lastError && granted === true)
            })
        } catch (e) {
            resolve(false)
        }
    })
}

/**
 * live2（来場者数）の中継が使えるか。**Kick 連携とは別に確かめる。**
 *
 * 🔴 **`hasKickPermission` に混ぜないこと。** 混ぜると、この origin を足す前に Kick を
 *    許可していた利用者が全員 false になり、**Kick 連携そのものが止まる。**
 *    ここが false でも kick.com のリストは出る（一覧APIの値のまま＝従来どおり）。
 */
function hasLive2Permission() {
    return new Promise((resolve) => {
        try {
            chrome.permissions.contains({ origins: [LIVE2_ORIGIN] }, (granted) => {
                resolve(!chrome.runtime.lastError && granted === true)
            })
        } catch (e) {
            resolve(false)
        }
    })
}

/**
 * live2 の statistics を中継する（**kick.com 用**）。
 *
 * ⚠️ **任意のURLを取れる中継にしないこと。** 受け取るのは `lv` 番号だけで、URLはここで組む。
 * ⚠️ 混ぜ方（どちらを採るか）は持たない。**数字を返すだけ**で、上書きはページ側の
 *    `applyLiveStatistics` が1箇所でやる（ニコ生ページと同じ関数）。
 */
async function fetchLive2Statistics(ids) {
    if (!Array.isArray(ids) || !ids.length) return { ok: true, stats: {} }
    if (!(await hasLive2Permission())) return { ok: false, reason: 'no-permission' }

    const wanted = ids.filter((id) => typeof id === 'string' && /^lv\d+$/.test(id)).slice(0, 200)
    const stats = {}
    let next = 0
    const runners = Array.from({ length: Math.min(LIVE2_MAX_CONCURRENT, wanted.length) }, async () => {
        for (let i = next++; i < wanted.length; i = next++) {
            const id = wanted[i]
            try {
                const res = await fetch(`${LIVE2_STATISTICS_API}/${id}/statistics`, {
                    credentials: 'include', cache: 'no-store',
                })
                if (!res.ok) continue
                const json = await res.json()
                const d = json && json.data
                const w = d ? Number(d.watchCount) : NaN
                if (!Number.isFinite(w) || w < 0) continue
                const c = d ? Number(d.commentCount) : NaN
                stats[id] = { watchCount: w, commentCount: Number.isFinite(c) && c >= 0 ? c : 0 }
            } catch (e) { /* 1件の失敗で全体を落とさない */ }
        }
    })
    await Promise.all(runners)
    return { ok: true, stats }
}

/**
 * Bearer トークンを cookie から読む。
 *
 * ⚠️ cookie の値は URL エンコードされている（`408486934%7C...`）。
 * デコードして `<id>|<文字列>` の形に戻したものが Laravel Sanctum のトークン本体。
 */
async function readKickToken() {
    if (!chrome.cookies) return null
    let cookie = null
    try {
        cookie = await chrome.cookies.get({ url: KICK_ORIGIN, name: COOKIE_NAME })
    } catch (e) {
        return null
    }
    if (!cookie || !cookie.value) return null
    try {
        return decodeURIComponent(cookie.value)
    } catch (e) {
        return cookie.value
    }
}

/**
 * フォロー中の放送中番組を全件取得する。
 *
 * 戻り値は必ず `{ ok: boolean, ... }`。**throw しない。**
 * 呼び出し側（コンテンツスクリプト）は `reason` を見て表示を出し分ける。
 *
 * @returns {Promise<{ok:true, streams:Array, pages:number, partial?:boolean}|{ok:false, reason:string, status?:number}>}
 */
async function fetchKickLivestreams() {
    if (!(await hasKickPermission())) return { ok: false, reason: 'no-permission' }

    const token = await readKickToken()
    if (!token) return { ok: false, reason: 'no-session' }

    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' }
    const seen = new Set()
    const streams = []
    let pages = 0

    for (let page = 1; page <= MAX_PAGES; page++) {
        const url = page === 1 ? KICK_API : KICK_API + '?page=' + page

        let res
        try {
            // credentials:'omit' — cookie は不要（Bearer だけで 200。2026-08-04 実測）。
            // 送っても害は無いが、送らないことで「Bearer が唯一の認証」であることを明示する。
            res = await fetch(url, { headers, credentials: 'omit', cache: 'no-store' })
        } catch (e) {
            // 途中まで取れているなら、それを返す方が「全部消える」より良い。
            return streams.length ? { ok: true, streams, pages, partial: true } : { ok: false, reason: 'network' }
        }

        if (res.status === 401) return { ok: false, reason: 'unauthorized' }
        if (res.status === 429) {
            return streams.length ? { ok: true, streams, pages, partial: true } : { ok: false, reason: 'rate-limited' }
        }
        if (!res.ok) {
            return streams.length
                ? { ok: true, streams, pages, partial: true }
                : { ok: false, reason: 'http', status: res.status }
        }

        let list
        try {
            list = await res.json()
        } catch (e) {
            return { ok: false, reason: 'parse' }
        }

        if (!Array.isArray(list) || list.length === 0) break

        pages++
        let added = 0
        for (const s of list) {
            const id = s && s.id
            if (id === undefined || id === null || seen.has(id)) continue
            seen.add(id)
            streams.push(s)
            added++
        }

        // 🔴 `?page=` が無視される実装だった場合の保険。
        //    ページサイズは未確定で、「page=2 が空を返した」ことからページングを推定している
        //    （doc/05 の 6-1）。もし無視されるなら毎回同じ配列が返り、`added` が 0 になる。
        //    この打ち切りが無いと MAX_PAGES 回まで無駄に叩き続ける。
        if (added === 0) break
    }

    return { ok: true, streams, pages }
}

/**
 * ニコ生のフォロー中番組（放送中）を全件取得して**生のまま**返す。
 *
 * kick.com 上のサイドバー専用。ニコ生の視聴ページでは同一オリジンで直接叩けるので、
 * こちらを通す必要は無い（通すと既存の動作を変えることになる）。
 *
 * 写像は呼び出し側の `mapApiProgramToInfo` が行う。ここは中継に徹する。
 */
async function fetchNicoFollowed() {
    if (!(await hasKickPermission())) return { ok: false, reason: 'no-permission' }

    const programs = []
    for (let page = 0; page < NICO_MAX_PAGES; page++) {
        const url = `${NICO_FOLLOW_API}?status=onair&offset=${page * NICO_PAGE_LIMIT}&limit=${NICO_PAGE_LIMIT}`
        let res
        try {
            // credentials:'include' でニコ生のログインcookieを載せる（ホスト権限が要る理由）。
            res = await fetch(url, { credentials: 'include', cache: 'no-store' })
        } catch (e) {
            return programs.length ? { ok: true, programs, partial: true } : { ok: false, reason: 'network' }
        }
        if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized' }
        if (!res.ok) {
            return programs.length
                ? { ok: true, programs, partial: true }
                : { ok: false, reason: 'http', status: res.status }
        }

        let json
        try {
            json = await res.json()
        } catch (e) {
            return { ok: false, reason: 'parse' }
        }
        const list = json && json.data && Array.isArray(json.data.programs) ? json.data.programs : []
        if (list.length === 0) break
        programs.push(...list)
        // 1ページに満たなければ最後のページ。
        if (list.length < NICO_PAGE_LIMIT) break
    }
    return { ok: true, programs }
}

/**
 * 画像を取得して data URL で返す（**kick.com 上の動くサムネ専用**）。
 *
 * 🔴 **CORS はブラウザがページに課す制限で、SW からの取得には適用されない。**
 *    ここで取って data URL にすれば、ページ側の canvas は汚染されない（同一オリジン扱い）。
 *
 * ⚠️ **許可ホストを必ず確認すること。** 任意のURLを取れる中継にすると、
 *    ページ側から拡張のホスト権限を借りて何でも読めてしまう。
 */
async function fetchImageAsDataUrl(url) {
    if (typeof url !== 'string' || !IMAGE_PROXY_ALLOWED.some((re) => re.test(url))) {
        return { ok: false, reason: 'not-allowed' }
    }
    if (!(await hasKickPermission())) return { ok: false, reason: 'no-permission' }

    let res
    try {
        res = await fetch(url, { credentials: 'omit', cache: 'no-store' })
    } catch (e) {
        return { ok: false, reason: 'network' }
    }
    if (!res.ok) return { ok: false, reason: 'http', status: res.status }

    let buf
    try {
        buf = await res.arrayBuffer()
    } catch (e) {
        return { ok: false, reason: 'read' }
    }
    if (buf.byteLength > IMAGE_PROXY_MAX_BYTES) return { ok: false, reason: 'too-large' }

    // btoa は SW でも使える。文字列化は分割しないと引数が多すぎて落ちる。
    const bytes = new Uint8Array(buf)
    let bin = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
    }
    const type = res.headers.get('content-type') || 'image/jpeg'
    return { ok: true, dataUrl: 'data:' + type + ';base64,' + btoa(bin) }
}

// ============================================================
// 動くサムネのフレーム保管庫（IndexedDB）
//
// 🔴 **ここに置く理由は「両サイトで共有するため」。**
//    IndexedDB は**オリジンごとに完全に分離**されるので、コンテンツスクリプト側に置くと
//    live.nicovideo.jp と kick.com で別々の保管庫になり、サイトを移るたびにコマを貯め直しになる。
//    SW は拡張のオリジンなので、どのサイトから来ても同じ保管庫を見られる。
//
// ⚠️ **Blob は chrome.runtime のメッセージを通れない**（JSON 直列化のため）。
//    呼び出し側が base64 にして渡してくる。ここではその文字列をそのまま保存する。
//    デコードし直して Uint8Array で持つとディスクは減るが、読み書きのたびに
//    変換が入るだけで、転送量は変わらない。
// ============================================================

const FRAME_DB_NAME = 'niconamasidebar'
const FRAME_STORE = 'animFrames'
const FRAME_DB_VERSION = 1

let frameDbPromise = null

function openFrameDB() {
    if (frameDbPromise) return frameDbPromise
    frameDbPromise = new Promise((resolve, reject) => {
        let req
        try {
            req = indexedDB.open(FRAME_DB_NAME, FRAME_DB_VERSION)
        } catch (e) {
            reject(e)
            return
        }
        req.onupgradeneeded = () => {
            const db = req.result
            if (!db.objectStoreNames.contains(FRAME_STORE)) {
                db.createObjectStore(FRAME_STORE, { keyPath: 'id' })
            }
        }
        req.onsuccess = () => {
            const db = req.result
            db.onversionchange = () => { try { db.close() } catch (e) { /* noop */ } frameDbPromise = null }
            db.onclose = () => { frameDbPromise = null }
            resolve(db)
        }
        req.onerror = () => reject(req.error)
        // onblocked を拾わないと、どちらのハンドラも呼ばれず Promise が永久に未解決になる。
        req.onblocked = () => reject(new Error('IndexedDB open blocked'))
    })
    frameDbPromise.catch(() => { frameDbPromise = null })
    return frameDbPromise
}

/**
 * 番組1件のフレームを保存する。**差分で受け取る。**
 *
 * 🔴 **毎回すべてのコマを送らせないこと。** コマは1枚あたり base64 で50KB前後あり、
 *    バッファは数枚持つ。全部送ると1回の保存で数百KBになり、
 *    kick.com のように全カードをまとめて更新するページでは1周期で1MBを超える。
 *
 * `order`（コマの並びを sig で表したもの）と、**送り主が「そちらは持っていない」と判断した分だけ**の
 * `payload` を受け取る。こちらに残っているコマと突き合わせて組み立て直す。
 *
 * 揃わなかった場合は `stored` を実際の枚数で返す。送り主はそれを見て次回に全部送り直す
 * （こちらが cleanup で消していた場合の自己修復）。
 *
 * @param {string} id
 * @param {{order: string[], payload: Record<string,{b64:string,type:string}>, lastSig: string|null, updatedAt: number}} delta
 */
async function framesSave(id, delta) {
    if (!id || !delta || !Array.isArray(delta.order)) return { ok: false, reason: 'bad-args' }
    try {
        const db = await openFrameDB()

        const existing = await new Promise((resolve) => {
            const tx = db.transaction(FRAME_STORE, 'readonly')
            const req = tx.objectStore(FRAME_STORE).get(id)
            req.onsuccess = () => resolve(req.result || null)
            req.onerror = () => resolve(null)
            tx.onabort = () => resolve(null)
            tx.onerror = () => resolve(null)
        })

        const have = new Map()
        for (const f of (existing && existing.frames) || []) {
            if (f && f.sig) have.set(f.sig, f)
        }

        const payload = delta.payload || {}
        const frames = []
        for (const sig of delta.order) {
            const add = payload[sig]
            if (add && add.b64) frames.push({ b64: add.b64, type: add.type || 'image/jpeg', sig })
            else if (have.has(sig)) frames.push(have.get(sig))
            // どちらにも無い＝こちらが消していて送り主も送ってこなかった。落として次回に任せる。
        }

        const record = { id, frames, lastSig: delta.lastSig || null, updatedAt: delta.updatedAt || Date.now() }
        await new Promise((resolve, reject) => {
            const tx = db.transaction(FRAME_STORE, 'readwrite')
            tx.objectStore(FRAME_STORE).put(record)
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
            tx.onabort = () => reject(tx.error)
        })
        return { ok: true, stored: frames.length, wanted: delta.order.length }
    } catch (e) {
        // 容量超過・使用不可など。永続化はあきらめ、メモリ上のコマだけで動き続ける。
        return { ok: false, reason: 'idb' }
    }
}

async function framesLoad(id) {
    try {
        const db = await openFrameDB()
        const rec = await new Promise((resolve, reject) => {
            const tx = db.transaction(FRAME_STORE, 'readonly')
            const req = tx.objectStore(FRAME_STORE).get(id)
            req.onsuccess = () => resolve(req.result || null)
            req.onerror = () => reject(req.error)
            // トランザクション中断時は req のハンドラがどちらも呼ばれない。
            // 拾わないと呼び出し元が返らなくなる（doc/09 項目BA と同じ形）。
            tx.onabort = () => reject(tx.error || new Error('tx aborted'))
            tx.onerror = () => reject(tx.error || new Error('tx error'))
        })
        return { ok: true, record: rec }
    } catch (e) {
        return { ok: true, record: null }
    }
}

async function framesCleanup(ttlMs, maxEntries) {
    try {
        const db = await openFrameDB()
        await new Promise((resolve) => {
            const tx = db.transaction(FRAME_STORE, 'readwrite')
            const store = tx.objectStore(FRAME_STORE)
            const cutoff = Date.now() - ttlMs
            const survivors = []
            store.openCursor().onsuccess = (e) => {
                const cursor = e.target.result
                if (cursor) {
                    const v = cursor.value
                    if (!v || typeof v.updatedAt !== 'number' || v.updatedAt < cutoff) {
                        cursor.delete()
                    } else {
                        survivors.push({ id: v.id, updatedAt: v.updatedAt })
                    }
                    cursor.continue()
                } else if (survivors.length > maxEntries) {
                    survivors.sort((a, b) => a.updatedAt - b.updatedAt)
                    const overflow = survivors.length - maxEntries
                    for (let i = 0; i < overflow; i++) store.delete(survivors[i].id)
                }
            }
            tx.oncomplete = () => resolve()
            tx.onerror = () => resolve()
            tx.onabort = () => resolve()
        })
    } catch (e) { /* skip */ }
    return { ok: true }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return undefined

    if (msg.type === 'frames:save') {
        framesSave(msg.id, msg.record).then(sendResponse, () => sendResponse({ ok: false }))
        return true
    }
    if (msg.type === 'frames:load') {
        framesLoad(msg.id).then(sendResponse, () => sendResponse({ ok: true, record: null }))
        return true
    }
    if (msg.type === 'frames:cleanup') {
        framesCleanup(Number(msg.ttlMs) || 0, Number(msg.maxEntries) || 0)
            .then(sendResponse, () => sendResponse({ ok: true }))
        return true
    }

    if (msg.type === 'img:fetch') {
        fetchImageAsDataUrl(msg.url).then(sendResponse, (e) => {
            sendResponse({ ok: false, reason: 'internal', message: String((e && e.message) || e) })
        })
        return true
    }

    if (msg.type === 'nico:followed') {
        fetchNicoFollowed().then(sendResponse, (e) => {
            sendResponse({ ok: false, reason: 'internal', message: String((e && e.message) || e) })
        })
        return true
    }

    if (msg.type === 'nico:statistics') {
        fetchLive2Statistics(msg.ids).then(sendResponse, (e) => {
            sendResponse({ ok: false, reason: 'internal', message: String((e && e.message) || e) })
        })
        return true
    }

    if (msg.type === 'kick:fetch') {
        fetchKickLivestreams().then(sendResponse, (e) => {
            sendResponse({ ok: false, reason: 'internal', message: String((e && e.message) || e) })
        })
        return true // 非同期応答
    }

    if (msg.type === 'kick:broadcastState') {
        // オプションページが「権限を外す直前」に呼ぶ。まだホスト権限があるうちに伝える。
        broadcastKickState(msg.granted === true).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }))
        return true
    }

    if (msg.type === 'kick:status') {
        hasKickPermission().then((granted) => sendResponse({ ok: true, granted }))
        return true
    }

    if (msg.type === 'kick:openOptions') {
        // コンテンツスクリプトからは chrome.runtime.openOptionsPage() を呼べないので、
        // ここで代行する。chrome-extension:// への window.open はページ文脈では
        // web_accessible_resources が必要になり、options.html を web に露出させてしまう。
        chrome.runtime.openOptionsPage()
        sendResponse({ ok: true })
        return undefined
    }

    return undefined
})
