/**
 * 拡張オプションページ — Kick 連携の ON/OFF と表示方法。
 *
 * 🔴 **このファイルはバンドルされない。** `static/` から `dist/` へそのままコピーされる。
 *    `import` は書けない。
 *
 * 【なぜ拡張ページが要るのか】
 * `chrome.permissions.request()` は**コンテンツスクリプトから呼べない**。
 * サイドバー内の設定 UI はニコ生のページに描画された DOM なので、そこからは要求できない。
 *
 * 【「有効かどうか」を保存しないこと】
 * 🔴 チェックの状態は `chrome.permissions.contains()` の結果を唯一の真実にしている。
 *    ユーザーは chrome://extensions からこの画面を通さずに権限を取り消せるので、
 *    別に真偽値を保存すると必ずズレる。保存するのは表示方法（mixed / tabs）だけ。
 */

// 🔴 **sw.js の KICK_PERMISSIONS と必ず一致させること。**
//    片方だけに権限を足すと、要求はしたのに判定が false（またはその逆）になり、
//    「有効にしたのに動かない」「チェックが勝手に外れる」という形で出る。
//    このファイルはバンドルされないので import で共有できず、二重管理になっている。
//
//    - cookies              … session_token を読んで Bearer を組み立てる
//    - scripting            … kick.com へサイドバーを動的登録する（静的宣言だと必須権限になる）
//    - live.nicovideo.jp/*  … kick.com 上でニコ生の番組も出すための中継。
//                             ニコ生の視聴ページでは同一オリジンなので不要
//    - 画像ホスト2つ … kick.com 上で動くサムネを作るための中継。
//                       どちらの配信元も kick.com のオリジンに CORS を返さないため、
//                       SW が取って data URL にして渡す
const KICK_PERMISSIONS = {
    permissions: ['cookies', 'scripting'],
    origins: [
        'https://kick.com/*',
        'https://live.nicovideo.jp/*',
        'https://*.dlive.nicovideo.jp/*',
        'https://images.kick.com/*',
    ],
}

// ⚠️ **表示方法（kickDisplayMode）とバランス（dwellMinutes）はここで扱わない。**
//    権限を伴わない設定はサイドバー内の設定 UI が持つ（利用者の要望・2026-08-04）。
//    このページの責務は「権限が必要な ON/OFF」と接続テストだけ。
//    両方に置くと二重管理になり、どちらかが必ず古くなる。

const el = {
    enabled: document.getElementById('kick_enabled'),
    sub: document.getElementById('kick_sub'),
    note: document.getElementById('kick_note'),
    test: document.getElementById('kick_test'),
    testResult: document.getElementById('kick_test_result'),
}

/** 権限の有無。要求も削除もしない、状態を読むだけ。 */
function hasPermission() {
    return new Promise((resolve) => {
        chrome.permissions.contains(KICK_PERMISSIONS, (granted) => {
            resolve(!chrome.runtime.lastError && granted === true)
        })
    })
}

function setNote(text, isError) {
    el.note.textContent = text || ''
    el.note.classList.toggle('ng', !!isError)
}

function setTestResult(text, state) {
    el.testResult.textContent = text || ''
    el.testResult.classList.remove('ok', 'ng')
    if (state) el.testResult.classList.add(state)
}

/** 権限の実態に UI を合わせる。外部から取り消された場合もここを通る。 */
async function syncFromPermissions() {
    const granted = await hasPermission()
    el.enabled.checked = granted
    el.sub.hidden = !granted
    if (!granted) setTestResult('')
    return granted
}


el.enabled.addEventListener('change', async () => {
    setTestResult('')

    if (!el.enabled.checked) {
        // OFF: 権限を返す。表示方法の設定は消さない（再度 ON にしたとき前回の選択が残る）。
        chrome.permissions.remove(KICK_PERMISSIONS, async () => {
            await syncFromPermissions()
            setNote('Kick 連携を無効にしました。')
        })
        return
    }

    // ON: ここは change ハンドラ＝ユーザー操作の文脈なので request() を呼べる。
    // 呼べる文脈から外れると Chrome に拒否されるので、await を挟んでから呼ばないこと。
    chrome.permissions.request(KICK_PERMISSIONS, async (granted) => {
        if (chrome.runtime.lastError) {
            await syncFromPermissions()
            setNote('許可を要求できませんでした: ' + chrome.runtime.lastError.message, true)
            return
        }
        await syncFromPermissions()
        // 拒否は異常ではない。エラー表示にしない。
        setNote(granted ? 'Kick 連携を有効にしました。' : '許可されなかったため、Kick 連携は無効のままです。')
    })
})

/** 取得失敗の理由を、そのまま出しても意味が通る日本語にする。 */
function describeFailure(res) {
    switch (res && res.reason) {
        case 'no-permission': return 'kick.com へのアクセスが許可されていません。'
        case 'no-session': return 'Kick にログインしていません。kick.com でログインしてから再試行してください。'
        case 'unauthorized': return 'Kick の認証が通りませんでした。kick.com でログインし直してください。'
        case 'rate-limited': return 'Kick 側にリクエストを制限されました。時間をおいて再試行してください。'
        case 'network': return 'Kick に接続できませんでした。'
        case 'parse': return 'Kick の応答を解釈できませんでした。'
        case 'http': return 'Kick がエラーを返しました（HTTP ' + (res.status || '?') + '）。'
        case 'internal': return '内部エラー: ' + (res.message || '')
        default: return '取得に失敗しました。'
    }
}

el.test.addEventListener('click', async () => {
    el.test.disabled = true
    setTestResult('確認中…')
    try {
        const res = await chrome.runtime.sendMessage({ type: 'kick:fetch' })
        if (res && res.ok) {
            const n = Array.isArray(res.streams) ? res.streams.length : 0
            const partial = res.partial ? '（途中まで）' : ''
            setTestResult('取得成功: 放送中 ' + n + '件' + partial, 'ok')
        } else {
            setTestResult(describeFailure(res), 'ng')
        }
    } catch (e) {
        setTestResult('拡張と通信できませんでした: ' + String((e && e.message) || e), 'ng')
    } finally {
        el.test.disabled = false
    }
})

// chrome://extensions などから権限が変わった場合にも追従する。
chrome.permissions.onAdded.addListener(syncFromPermissions)
chrome.permissions.onRemoved.addListener(syncFromPermissions)

syncFromPermissions()
