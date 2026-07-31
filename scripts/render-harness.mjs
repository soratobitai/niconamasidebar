/**
 * 本物の `UpdateManager.updateSidebar()` を、モックDOM＋差し替えた fetch の上で走らせる土台。
 *
 * 【なぜ要るか】
 * verify:loop はこれまで updateSidebar を**丸ごとスタブ**に差し替えていた。周期・セッション・
 * 二重実行といったスケジューリング論理はそれで検証できるが、**描画経路そのもの**
 * （差分更新・構造変化判定・削除検知・並べ替え・FLIP）は一度も自動検証されていなかった。
 *
 * 【どこまで本物か】
 *   本物 … updateSidebar / _mergeSources / _orderByBeginAtDesc / _sortOrderChanged /
 *          makeProgramElement / applyProgramInfoToCard / deriveCardFields / flipReorder /
 *          sortPrograms / calculateActivePoint / fetchLivePrograms /
 *          fetchFollowedProgramsViaPage / mapApiProgramToInfo
 *   差替え … `globalThis.fetch`（URLで振り分けて用意した応答を返す）と DOM だけ。
 *
 * 【意図的にやらないこと】
 * 詳細API(fetchProgramInfo)を叩かせない。既定の番組データは programProvider と
 * ライブスクショ形の listingThumbnail を埋めてあるので fillMissingDetails の対象が0件になる。
 * 補完経路を試したい場合は明示的に欠けたデータを渡すこと。
 */

import { installMockDom } from './mock-dom.mjs'

/** ライブスクショ判定を通すURL（isLiveScreenshotUrl が /screenshot/ か dlive を見る） */
export const liveThumbUrl = (id) => `https://dlive.nicovideo.jp/live/${id}/screenshot/1.jpg`

/**
 * フォローAPIの生データ1件を作る。
 * @param {object} o
 * @param {string} o.id           - "lv123"
 * @param {number} o.beginAtMs    - 放送開始（エポックms）。新しいほど上に来る
 */
export function apiProgram({ id, beginAtMs, title, providerType = 'user', name, viewers = 10, comments = 5, thumb = true }) {
    const num = String(id).replace(/^lv/, '')
    const isChannel = providerType === 'channel' || providerType === 'official'
    const providerName = name || `配信者${num}`
    return {
        id: String(id),
        title: title || `番組${num}`,
        providerType: providerType === 'user' ? 'community' : providerType,
        listingThumbnail: thumb ? liveThumbUrl(num) : '',
        // 実測（2026-07-31 / 70件）: channel は programProvider に **id もアイコンも無く**、
        // 代わりに socialGroup にチャンネルID・チャンネル名・チャンネルアイコンが入る。
        // user(community) はその逆で programProvider が完備・socialGroup 無し。
        // ここを「両方入っている」形で作ると、実際には出ないアイコンをテストが通してしまう。
        programProvider: isChannel
            ? { name: providerName, icon: '', iconSmall: '' }
            : { id: `u${num}`, name: providerName, icon: `https://icon/${num}.png` },
        ...(isChannel
            ? { socialGroup: { id: `ch${num}`, name: providerName, thumbnailUrl: `https://channel-icon/ch${num}.jpg` } }
            : {}),
        statistics: { watchCount: viewers, commentCount: comments },
        isFollowerOnly: false,
        beginAt: beginAtMs,
        liveCycle: 'ON_AIR',
    }
}

/**
 * @param {object} opts
 * @param {number} [opts.intervalSec=60]
 * @param {string} [opts.programsSort='newest']
 * @param {number} [opts.flipMs] - 省略時は実装の既定値
 */
export function buildRenderHarness({ intervalSec = 60, programsSort = 'newest' } = {}) {
    const dom = installMockDom()

    // --- 応答の差し替え。テストから書き換える ---
    const state = {
        followPrograms: [],   // フォローAPIが返す生データ
        notifyRows: [],       // notifybox が返す行（{ id, title }）
        followFails: false,
        notifyFails: false,
        calls: { notify: 0, follow: 0, detail: 0 },
    }

    const prevFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
        const u = String(url)
        if (u.includes('notifybox')) {
            state.calls.notify++
            if (state.notifyFails) throw new Error('notifybox down (test)')
            return jsonResponse({ meta: { status: 200 }, data: { notifybox_content: state.notifyRows } })
        }
        if (u.includes('/front/api/pages/follow/')) {
            state.calls.follow++
            if (state.followFails) throw new Error('follow api down (test)')
            const offset = Number(/offset=(\d+)/.exec(u)?.[1] ?? 0)
            const limit = Number(/limit=(\d+)/.exec(u)?.[1] ?? 100)
            const page = state.followPrograms.slice(offset * limit, (offset + 1) * limit)
            return jsonResponse({ data: { programs: page, total: state.followPrograms.length } })
        }
        if (u.includes('api.cas.nicovideo.jp')) {
            state.calls.detail++
            // 既定データでは到達しないはず。到達したらテスト側の前提が崩れている。
            return jsonResponse({ data: {} })
        }
        throw new Error('想定外の fetch: ' + u)
    }

    return { dom, state, restore() { globalThis.fetch = prevFetch; dom.restore() }, intervalSec, programsSort }
}

function jsonResponse(body) {
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}

/**
 * UpdateManager を実物の依存で組む。呼び出し側で AppState/LoadingManager を import して渡す。
 * （このファイルから import すると verify 側のスタブ順序に依存してしまうため）
 */
export function wireUpdateManager({ AppState, LoadingManager, UpdateManager }, harness) {
    const appState = new AppState()
    appState.sidebar.isOpen = true
    appState.sidebar.width = 400
    const loadingManager = new LoadingManager(appState, 60000)
    const options = {
        updateProgramsInterval: String(harness.intervalSec),
        programsSort: harness.programsSort,
    }
    const um = new UpdateManager(appState, loadingManager, options, {}, 'loading.gif')
    return { appState, loadingManager, options, um }
}
