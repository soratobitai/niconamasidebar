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
/** 配信者が設定した固定画像のURL（ライブスクショ判定を通らない形） */
export const fixedImageUrl = (id) => `https://listing-thumbnail.live.nicovideo.jp?image=prod-lv${id}/thumbnail_1.png&w=352&h=198`

/**
 * フォローAPIの生データ1件を作る。
 * @param {object} o
 * @param {string} o.id           - "lv123"
 * @param {number} o.beginAtMs    - 放送開始（エポックms）。新しいほど上に来る
 */
export function apiProgram({ id, beginAtMs, title, providerType = 'user', name, viewers = 10, comments = 5, thumb = true, fixedImage = false }) {
    const num = String(id).replace(/^lv/, '')
    const isChannel = providerType === 'channel' || providerType === 'official'
    const providerName = name || `配信者${num}`
    return {
        id: String(id),
        title: title || `番組${num}`,
        providerType: providerType === 'user' ? 'community' : providerType,
        // fixedImage: 配信者が固定画像を設定している番組の形（listingThumbnail は固定画像で、
        // ライブスクショは flippedListingThumbnail 側に入る）。実測 user の約1/3がこの形。
        listingThumbnail: fixedImage ? fixedImageUrl(num) : (thumb ? liveThumbUrl(num) : ''),
        ...(fixedImage ? { flippedListingThumbnail: liveThumbUrl(num) } : {}),
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

    // localStorage の programInfos を空にしてから始める。
    // ⚠️ **テスト間で持ち越すと、盛り上がり(momentum)が前のブロックの値から始まって結果が変わる。**
    // 実際にこれで「実装は正しいのに人気順が並ばない」という誤診をした。土台は毎回まっさらにする。
    try { globalThis.localStorage.removeItem('programInfos') } catch (_e) { /* 未設定なら無視 */ }

    // --- 応答の差し替え。テストから書き換える ---
    const state = {
        followPrograms: [],   // フォローAPIが返す生データ
        notifyRows: [],       // notifybox が返す行（{ id, title }）
        followFails: false,
        notifyFails: false,
        // 番組詳細API が「終了した」と答える番組id（'lv700' でも '700' でも可）。
        // 項目BF-2 の終了確認は、notifybox の不在を疑いにして**ここへ問い合わせる**。
        endedIds: new Set(),
        detailFails: false,   // 詳細APIが答えない状況（通信断・404）を作る
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
            if (state.detailFails) throw new Error('detail api down (test)')
            // 実物と同じ形で答える（2026-08-02 実測）:
            //   放送中 → { meta:{status:200}, data:{ liveCycle:'on_air', … } }
            //   終了   → { meta:{status:200}, data:{ liveCycle:'ended',  … } }
            //   無い番組 → HTTP 404 / meta.status 404
            const id = (/\/lv(\d+)/.exec(u) || [])[1] || ''
            const ended = state.endedIds.has(id) || state.endedIds.has('lv' + id)
            const data = { liveCycle: ended ? 'ended' : 'on_air' }
            // `state.detailThumb` を立てた時だけ、ライブスクショを返す番組詳細としても振る舞う
            // （notifybox 先行の新番組をフォローAPI抜きで追撃できるかの検証に使う）。
            if (state.detailThumb) {
                data.providerType = 'user'
                data.liveScreenshotThumbnailUrls = { middle: state.detailThumb }
            }
            return jsonResponse({ meta: { status: 200 }, data })
        }
        throw new Error('想定外の fetch: ' + u)
    }

    /**
     * 保存済みレコードの時刻を ms だけ過去へずらす＝「時間が経ったこと」にする。
     *
     * 盛り上がり(momentum)は「前回取得からの増分 ÷ 経過時間」なので、実時間が進まない検証環境では
     * **1ミリ秒差の更新が続き、値が一切動かない**（Δt<1秒は据え置く仕様。α も実質0）。
     * 数字を変えても順位が変わらず「壊れている」ように見えるが、それは検証側の都合である。
     * 周期をまたぐ挙動を見たいテストは、run() の間にこれを呼ぶこと。
     *
     * 🔴 **時刻を持つフィールドを取り残さないこと**（2026-08-11・doc/09 項目CQ）。
     *    `_fetchedAt` だけずらして `viewerSamples` を置き去りにしていた。推定同接は
     *    `now` とサンプル時刻の差で減衰させるので、**推定から見ると1秒も経っていない**ことになり、
     *    減衰が一切起きない。実測: 2833人の番組を22分ぶん「経過」させても 2745 のまま
     *    （本来は 900 前後まで下がる）。**実装が壊れていても検査が気付かない形**だった。
     * ⚠️ 時刻を持つフィールドを増やしたら、ここへも足すこと。足し忘れは静かに検査を骨抜きにする。
     * @param {number} ms 経過させたい時間
     */
    function ageStorage(ms) {
        const raw = globalThis.localStorage.getItem('programInfos')
        if (!raw) return
        const list = JSON.parse(raw).map((info) => {
            const next = { ...info, _fetchedAt: (info._fetchedAt || Date.now()) - ms }
            if (Array.isArray(info.viewerSamples)) {
                next.viewerSamples = info.viewerSamples.map((s) => [Number(s[0]) - ms, s[1]])
            }
            return next
        })
        globalThis.localStorage.setItem('programInfos', JSON.stringify(list))
    }

    return { dom, state, ageStorage, restore() { globalThis.fetch = prevFetch; dom.restore() }, intervalSec, programsSort }
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
