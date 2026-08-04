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
const KICK_PERMISSIONS = {
    permissions: ['cookies', 'scripting'],
    origins: ['https://kick.com/*', 'https://live.nicovideo.jp/*'],
}

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
async function broadcastKickState() {
    const granted = await hasKickPermission()
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

// 権限の増減に追従する。ユーザーは chrome://extensions からも権限を外せるので、
// オプションページ側の処理だけに任せない。
if (chrome.permissions && chrome.permissions.onAdded) {
    chrome.permissions.onAdded.addListener(() => {
        syncKickContentScript()
        broadcastKickState()
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return undefined

    if (msg.type === 'nico:followed') {
        fetchNicoFollowed().then(sendResponse, (e) => {
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
