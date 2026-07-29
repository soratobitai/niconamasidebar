/**
 * サイドバー常設ループの自動検証（ブラウザ・ログイン不要）
 *
 *   npm run verify:loop          … 短縮スケールで全項目（約1分）
 *   npm run verify:loop -- --real … 実スケール(間隔60秒)で周期だけ確認（約4分）
 *
 * doc/10-verification-playbook.md ブロックD の D1〜D5 を機械的に検証する。
 * これらは純粋なスケジューリング論理なので、実機・ログイン・DevTools は要らない。
 * ブロックDで**手作業が残るのは D6（裏タブでも取得が続く）と D7（スピナー固着）だけ**。
 *
 * 【何を本物のまま動かしているか】
 *   UpdateManager の _sidebarTick / _scheduleSidebarTick / _sidebarDelayToNextMs /
 *   resetSidebarSchedule / startSidebarLoop / destroySidebarLoop、および
 *   LoadingManager と AppState は実コードをそのまま import して使う。
 *
 * 【何を差し替えているか】
 *   ネットワークに出る updateSidebar() だけ。差し替え版は実物と同じセッション処理
 *   （動いているセッションがあれば相乗りして null を返す）を再現し、
 *   「取得に F ミリ秒かかる」という振る舞いだけを足したもの。
 *
 * 【なぜ短縮スケールでよいか】
 *   周期の式は 間隔 ＋ max(取得時間, 最低表示1秒) でスケール不変のため。
 *   ただし最低表示1秒は固定値なので、短縮時もそこは実寸で効いている。
 */

const SRC = new URL('../src/', import.meta.url).href

// --- 最小限のブラウザAPIスタブ（import と LoadingManager.updateLoadingState 用） ---
globalThis.chrome = {
    runtime: { getURL: (p) => 'chrome-extension://test/' + p },
    storage: { local: { get: () => {}, set: () => {} }, onChanged: { addListener: () => {} } },
}
globalThis.document = {
    getElementById: () => null, // 更新ボタンは無い扱い（.loading の付け外しは検証対象外）
    hidden: false,
}

// localStorage / location も最小限だけ用意する（storage.js と utils/error.js が触るため）
const _ls = new Map([['programInfos', '[]']])
globalThis.localStorage = {
    getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
    setItem: (k, v) => { _ls.set(k, String(v)) },
    removeItem: (k) => { _ls.delete(k) },
}
globalThis.location = { href: 'https://live.nicovideo.jp/watch/lv1' }

const { AppState } = await import(`${SRC}core/AppState.js`)
const { LoadingManager } = await import(`${SRC}managers/LoadingManager.js`)
const { UpdateManager } = await import(`${SRC}managers/UpdateManager.js`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MIN_LOADING_MS = 1000 // _sidebarTick が finishSessionWithMinDuration に渡す値

function build(intervalSec, fetchMs) {
    const appState = new AppState()
    appState.sidebar.isOpen = true
    const loadingManager = new LoadingManager(appState, 60000)
    const options = { updateProgramsInterval: String(intervalSec) }
    const um = new UpdateManager(appState, loadingManager, options, {}, 'loading.gif')

    const marks = [] // 取得を開始した時刻（= notifybox の Started at 相当）

    um.updateSidebar = async () => {
        const sessionId = loadingManager.getCurrentSessionId()
            ? null
            : loadingManager.startSession()
        marks.push(Date.now())
        await sleep(fetchMs)
        return sessionId
    }
    return { appState, loadingManager, options, um, marks }
}

const periods = (marks) => marks.slice(1).map((t, i) => t - marks[i])
const fmt = (a) => a.map((x) => (x / 1000).toFixed(2) + 's').join(', ')

let failures = 0
function check(label, ok, detail) {
    console.log(`${ok ? '  OK  ' : '  NG  '} ${label}`)
    if (detail) console.log(`       ${detail}`)
    if (!ok) failures++
}

/** D1: 周期は「間隔 ＋ 作業時間」か。間隔ちょうどに詰まっていたら修正前の退行 */
async function d1(intervalSec, fetchMs, cycles = 3) {
    const I = intervalSec * 1000
    const W = Math.max(fetchMs, MIN_LOADING_MS)
    const expect = I + W
    const { um, marks } = build(intervalSec, fetchMs)

    um.startSidebarLoop()
    await sleep(expect * cycles + I * 0.6)
    um.destroySidebarLoop()

    const p = periods(marks)
    const tol = Math.max(250, I * 0.02)
    const ok = p.length >= 2 && p.every((x) => Math.abs(x - expect) < tol)
    check(
        `D1 間隔${intervalSec}s / 取得${fetchMs}ms → 周期 ${(expect / 1000).toFixed(2)}s`,
        ok,
        `実測: ${fmt(p)}${ok ? '' : `  <- 期待 ${(expect / 1000).toFixed(2)}s`}`
    )
    const exactly = p.some((x) => Math.abs(x - I) < 150)
    check(
        `D1 間隔ちょうど(${intervalSec}.00s)に詰まっていない`,
        !exactly,
        exactly
            ? '取得の前に期限を進めている＝ニコ生への取得頻度が上がる退行（doc/09 AB-2）'
            : `最小の周期 ${(Math.min(...p) / 1000).toFixed(2)}s > ${intervalSec}.00s`
    )
}

/** D2: 開いている状態から閉じたら止まるか */
async function d2() {
    const I = 2000
    const { appState, um, marks } = build(2, 200)
    um.startSidebarLoop()
    await sleep((I + MIN_LOADING_MS) * 2 + 300)
    const before = marks.length
    appState.sidebar.isOpen = false
    await sleep((I + MIN_LOADING_MS) * 3)
    um.destroySidebarLoop()
    check('D2 閉じたら取得が止まる', marks.length - before === 0,
        `閉じた後 ${marks.length - before} 回（閉じる前 ${before} 回）`)
}

/** D3: 閉じた状態で起動 → 開くと動き出すか（ループが殺されていないか）*/
async function d3() {
    const I = 3000
    const { appState, um, marks } = build(3, 200)

    appState.sidebar.isOpen = false // 閉じた状態で起動＝初回ユーザーの既定
    um.startSidebarLoop()

    // 閉パス（main.js の stopAllTimers 相当）が走ってもループが死なないこと。
    // 現行 stopAllTimers が触るのは autoNext だけ。'sidebar'/'thumbnail' は削除済みキー。
    appState.clearTimer('autoNext')   // 現行 stopAllTimers が触るのはこれだけ
    appState.clearTimer('autoNext')
    appState.clearTimer('sidebar')

    await sleep(I * 2.5)
    check('D3 閉じている間は取得しない', marks.length === 0, `取得 ${marks.length} 回`)

    appState.sidebar.isOpen = true // 開く（handleSidebarOpenStateChange(true) 相当）
    um.resetSidebarSchedule()

    await sleep((I + MIN_LOADING_MS) * 3 + 500)
    um.destroySidebarLoop()
    check('D3 開いた後に定期取得が復活する（最重要）', marks.length >= 2,
        `開いた後 ${marks.length} 回 / 周期: ${fmt(periods(marks))}`)
}

/** D4: 更新間隔の変更が効くか／変更の瞬間に取得しないか */
async function d4() {
    const { options, um, marks } = build(5, 200)
    um.startSidebarLoop()
    await sleep(1000)
    const before = marks.length
    options.updateProgramsInterval = '2'
    um.resetSidebarSchedule()
    await sleep(200)
    check('D4 間隔を変えた瞬間には取得しない', marks.length === before,
        `変更直後 ${marks.length - before} 回`)

    await sleep((2000 + MIN_LOADING_MS) * 3 + 400)
    um.destroySidebarLoop()
    const p = periods(marks)
    const ok = p.length >= 2 && p.slice(-2).every((x) => Math.abs(x - 3000) < 250)
    check('D4 新しい間隔（2s＋作業1s＝3.00s）で回る', ok, `実測: ${fmt(p)}`)
}

/** D5: 手動更新の後に位相が数え直されるか */
async function d5() {
    const I = 4000
    const { um, marks } = build(4, 200)
    um.startSidebarLoop()
    await sleep(2500) // 次回まで残り約1.5秒のところで
    um.resetSidebarSchedule() // 手動更新の完了相当
    const t0 = Date.now()
    await sleep(I + MIN_LOADING_MS + 800)
    um.destroySidebarLoop()
    const first = marks.find((t) => t > t0)
    const ok = first && Math.abs(first - t0 - I) < 300
    check('D5 手動更新の後は「そこから1周期後」に取得する', !!ok,
        first
            ? `リセットから ${((first - t0) / 1000).toFixed(2)}s 後（期待 ${(I / 1000).toFixed(2)}s。リセット前の残り約1.5sではない）`
            : '取得されなかった')
}

/** 破棄後にページが生き残った場合（bfcache 復帰・遷移キャンセル）、開き直しで復活するか */
async function revive() {
    const I = 2000
    const { um, marks } = build(2, 200)
    um.startSidebarLoop()
    await sleep(500)
    um.destroySidebarLoop() // cleanup 相当
    await sleep((I + MIN_LOADING_MS) * 2)
    check('破棄後は取得が止まる', marks.length === 0, `取得 ${marks.length} 回`)

    um.resetSidebarSchedule() // 開き直し相当
    await sleep((I + MIN_LOADING_MS) * 2 + 400)
    um.destroySidebarLoop()
    check('破棄後もページが生きていれば開き直しで復活する', marks.length >= 1,
        `復活後 ${marks.length} 回`)
}

/** ループが二重にならないか（start 連打・取得中の start）*/
async function noDouble() {
    const I = 2000, F = 1500
    const { um, marks } = build(2, F)
    um.startSidebarLoop()
    um.startSidebarLoop()
    um.startSidebarLoop()
    await sleep(I + 300) // 取得中（await 中）＝_sidebarLoopTimer は null のはず
    um.startSidebarLoop()
    um.startSidebarLoop()
    await sleep((I + F) * 3)
    um.destroySidebarLoop()
    const p = periods(marks)
    const expect = I + Math.max(F, MIN_LOADING_MS)
    const ok = p.length >= 2 && p.every((x) => Math.abs(x - expect) < 300)
    check('start を連打・取得中に呼んでもループは1本のまま', ok,
        `周期: ${fmt(p)}（期待 ${(expect / 1000).toFixed(2)}s。2本になると半分の間隔が混ざる）`)
}

/** 取得中に閉じても、自分のセッションは閉じられるか（スピナー固着の防止＝D7の論理部分）*/
async function sessionOnClose() {
    const I = 2000, F = 1500
    const { appState, loadingManager, um } = build(2, F)
    um.startSidebarLoop()
    await sleep(I + 300) // 取得中
    appState.sidebar.isOpen = false // その最中に閉じる
    await sleep(F + MIN_LOADING_MS + 600)
    um.destroySidebarLoop()
    check('取得中に閉じてもローディングセッションが宙吊りにならない',
        !appState.isLoading() && !loadingManager.getCurrentSessionId(),
        `isLoading=${appState.isLoading()} / sessionId=${loadingManager.getCurrentSessionId()}`)
}

/**
 * D6: サイドバーの更新ループに「裏タブでは走らない」ガードが混入していないこと。
 *
 * これは実ブラウザでの挙動テストにできない。CDP で操作しているページは Chrome が
 * 常に visible 扱いにするため、自動化から本物の非表示状態を作れない
 * （別タブ前面化・ウィンドウ最小化・Page.setWebLifecycleState('frozen') を試して全滅。
 *  Emulation.setPageVisibilityOverride は現行 Chrome に存在しない）。
 *
 * しかし D6 が本当に問うているのは「可視ガードを混入させていないか」なので、
 * ソースを直接検査するほうが挙動テストより決定的。655df9c で意図的に全撤去した仕様を守る。
 */
async function d6Static() {
    const { readFileSync } = await import('fs')
    const um = readFileSync(new URL('../src/managers/UpdateManager.js', import.meta.url), 'utf8')

    // _sidebarTick 本体を切り出す
    const start = um.indexOf('async _sidebarTick()')
    const end = um.indexOf('\n    }', um.indexOf('} finally {', start))
    const tick = start >= 0 && end > start ? um.slice(start, end) : ''
    check('D6 _sidebarTick を特定できる', tick.length > 200, `${tick.length} 文字`)

    const hasVis = /document\.hidden|visibilityState|isVisible\s*\(/.test(tick)
    check('D6 サイドバーの tick に可視ガードが無い（655df9c の仕様）', !hasVis,
        hasVis ? '⚠ 可視判定が混入している。裏タブでリスト取得が止まる＝仕様変更' : '可視判定なし')

    // サムネ側にだけ document.hidden があること（取り違えて消していないかの裏返し）
    const thumbHasHidden = /document.hidden/.test(um.slice(um.indexOf('async _thumbTick'), um.indexOf('async _thumbTick') + 3000))
    check('D6 サムネ側の document.hidden は残っている（消し違えていない）', thumbHasHidden)

    // visibilitychange リスナーが src 全体で0件であること
    const files = [
        'main.js', 'core/AppState.js', 'managers/UpdateManager.js',
        'managers/LoadingManager.js', 'managers/AutoNextManager.js', 'render/sidebar.js',
    ]
    let listeners = []
    for (const f of files) {
        const s = readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')
        if (/addEventListener\(\s*['"]visibilitychange/.test(s)) listeners.push(f)
    }
    check('D6 visibilitychange のリスナーが1つも無い', listeners.length === 0,
        listeners.length ? `混入: ${listeners.join(', ')}` : '0件')
}

/**
 * 項目AC-1: 背景タブで手動更新が固まらないこと。
 *
 * updateThumbnailsFromStorage は requestAnimationFrame で始まるため、背景タブでは
 * tick が一度も走らず onComplete が永久に来ない。待っている performManualUpdate が固まり、
 * isPerformingManualUpdate が立ちっぱなしで「押せるのに無反応」になっていた。
 */
async function ac1() {
    const { appState, um } = build(3, 200)

    // 背景タブでは即座に完了扱いになること。
    // ※この判定は getProgramInfos（localStorage 依存＝Node には無い）より手前に無いといけない。
    //   下へ移すとここで例外になるので、順序の入れ替えもこのテストが検出する。
    globalThis.document.hidden = true
    let completed = false, settled = false
    um.updateThumbnail(true, () => { completed = true }, undefined, () => { settled = true })
    globalThis.document.hidden = false
    check('AC-1 背景タブでは updateThumbnail が即座に完了通知を返す（固まらない）',
        completed && settled, `onComplete=${completed} / onSettled=${settled}`)

    // 待ち上限が定義され、ローディングのタイムアウトより手前で切れること
    const c = await import(new URL('../src/config/constants.js', import.meta.url).href)
    const ok = Number.isFinite(c.manualThumbWaitMaxMs)
        && c.manualThumbWaitMaxMs > 0
        && c.manualThumbWaitMaxMs < c.loadingSessionTimeoutMs
    check('AC-1 サムネ待ちの上限がローディングのタイムアウトより手前にある', ok,
        `manualThumbWaitMaxMs=${c.manualThumbWaitMaxMs} / loadingSessionTimeoutMs=${c.loadingSessionTimeoutMs}`)

    // 手動更新が「待ちっぱなし」にならないこと。
    // 完了通知が一切来ない状況（＝待っている最中にタブが背景へ回り rAF が止まった状態）を作る。
    // 上限は実運用30秒なので、検証用に 600ms へ短縮して打ち切りが効くことを確かめる。
    um._manualThumbWaitMs = 600
    um.updateSidebar = async () => null                // ネットワークは出さない
    um.updateThumbnail = () => { /* 完了通知を一切呼ばない */ }
    const t0 = Date.now()
    const p = um.performManualUpdate()
    const raced = await Promise.race([p.then(() => 'done'), sleep(4000).then(() => 'hang')])
    const elapsed = Date.now() - t0
    check('AC-1 完了通知が来なくても手動更新が上限で打ち切られる', raced === 'done',
        raced === 'done' ? `${elapsed}ms で完了（上限600msで打ち切られた）` : '4秒待っても抜けない＝固まっている')
    check('AC-1 手動更新の多重防止フラグが残らない（次回以降も押せる）',
        um.isPerformingManualUpdate === false, `isPerformingManualUpdate=${um.isPerformingManualUpdate}`)
    appState.sidebar.isOpen = false
}

/** 項目AC-2: 設定の保存が「サイドバーの開閉状態・幅」を書き込まないこと */
async function ac2() {
    const { saveOptions } = await import(new URL('../src/services/storage.js', import.meta.url).href)
    let written = null
    globalThis.chrome.storage.local.set = (obj, cb) => { written = obj; if (cb) cb() }
    await saveOptions({
        updateProgramsInterval: '60', programsSort: 'active', sidebarTheme: 'dark',
        isOpenSidebar: true, sidebarWidth: 480,
    })
    const keys = Object.keys(written || {})
    check('AC-2 設定保存が isOpenSidebar を書き込まない', !keys.includes('isOpenSidebar'),
        `書き込まれたキー: ${keys.join(', ')}`)
    check('AC-2 設定保存が sidebarWidth を書き込まない', !keys.includes('sidebarWidth'))
    check('AC-2 本来の設定はちゃんと書き込まれる',
        keys.includes('updateProgramsInterval') && keys.includes('sidebarTheme'))
}

/**
 * R-1: サムネ更新も常設ループ1本になったことの検証。
 *
 * 旧実装は番組数ぶんの自己連鎖タイマー＋世代トークン（_thumbGen）で、stop→即再開の境界で
 * 二重化する「ゴースト連鎖」を世代照合で押さえていた。作り直さない構造にして発生源ごと消した。
 * ドリフト（番組ごとに更新タイミングがばらける）は「完了時点＋20秒」という期限の持ち方で
 * 表現されるので、タイマーが1本でも保たれる——それをここで確かめる。
 */
async function r1(cards = 4, cycleSec = 2, workMs = 200) {
    const { appState, um } = build(60, 0)   // サイドバー側は動かさない
    um.options.updateThumbnailInterval = cycleSec
    appState.sidebar.isOpen = true

    // DOM を差し替えてカードを模す
    const container = { id: 'liveProgramContainer', children: [], contains: (el) => container.children.includes(el) }
    const els = Array.from({ length: cards }, (_, i) => ({ id: String(1000 + i) }))
    container.children = els
    globalThis.document.getElementById = (q) =>
        q === 'liveProgramContainer' ? container : (els.find((e) => e.id === q) || null)

    const marks = []   // [id, 時刻]
    um._fetchLiveThumbIfPendingYoung = async () => {}
    um._updateOneThumbnailAndWait = async (id) => { marks.push([id, Date.now()]); await sleep(workMs) }

    um.startThumbnailLoop()
    um.startThumbnailLoop()      // 連打しても増えないこと
    const cycleMs = cycleSec * 1000
    await sleep(cycleMs * 2 + (cycleMs + workMs) * 2 + 600)
    um.destroyThumbnailLoop()

    check('R-1 全カードが更新される', new Set(marks.map((m) => m[0])).size === cards,
        `更新された番組 ${new Set(marks.map((m) => m[0])).size} / ${cards}`)

    // 同一番組の周期＝間隔＋作業時間 になっているか（ドリフトの根拠）
    const per = new Map()
    for (const [id, t] of marks) { if (!per.has(id)) per.set(id, []); per.get(id).push(t) }
    const periods = []
    for (const ts of per.values()) for (let i = 1; i < ts.length; i++) periods.push(ts[i] - ts[i - 1])
    const expect = cycleMs + workMs
    const ok = periods.length > 0 && periods.every((p) => Math.abs(p - expect) < 400)
    check('R-1 同一番組の周期が「間隔＋作業時間」（ドリフトが保たれている）', ok,
        periods.length ? `実測 ${periods.map((p) => (p / 1000).toFixed(2) + 's').join(', ')}（期待 ${(expect / 1000).toFixed(2)}s）` : '2周目まで到達せず')

    // 位相がばらけているか（同時に更新されていない）
    const firsts = [...per.values()].map((ts) => ts[0]).sort((a, b) => a - b)
    const spread = firsts.length > 1 ? firsts[firsts.length - 1] - firsts[0] : 0
    check('R-1 初回の位相が分散している（一斉更新になっていない）', spread > cycleMs * 0.4,
        `先頭と末尾の差 ${(spread / 1000).toFixed(2)}s（1周期 ${cycleSec}s）`)

    // 閉じている間は動かないこと
    marks.length = 0
    appState.sidebar.isOpen = false
    um.startThumbnailLoop()
    await sleep(cycleMs * 2 + 500)
    um.destroyThumbnailLoop()
    check('R-1 サイドバーを閉じている間はサムネを更新しない', marks.length === 0, `更新 ${marks.length} 回`)

    // 閉→開で復活すること
    appState.sidebar.isOpen = true
    um.startThumbnailLoop()
    await sleep(cycleMs * 2 + workMs + 600)
    um.destroyThumbnailLoop()
    check('R-1 開き直すとサムネ更新が復活する', marks.length >= 1, `復活後 ${marks.length} 回`)

    // 世代トークンが消えていること（構造の保証）
    const { readFileSync } = await import('fs')
    const src = readFileSync(new URL('../src/managers/UpdateManager.js', import.meta.url), 'utf8')
    check('R-1 サムネ側の世代トークン・番組ごとタイマーが消えている',
        !/_thumbGen|_thumbTimers|_scheduleThumbCycle/.test(src),
        '_thumbGen / _thumbTimers / _scheduleThumbCycle の残存なし')
}

/**
 * R-3(A): 2つの取得元の和集合が正しく作られるか。
 *
 * notifybox は「早さ」担当（user番組の新着検知が 20〜101秒 速い）、
 * フォローAPI は詳細・並び順・100件超の担当。旧実装は notifybox を絞り込みに使っていたため
 * 表示が100件で頭打ちだった。和集合にして両方の利点を取る。
 */
async function r3merge() {
    const { um } = build(60, 0)
    const iso = (ms) => new Date(ms).toISOString()
    const t = Date.now()

    const follow = [
        { id: 'lv100', title: 'F古い', onAirTime: { beginAt: iso(t - 300000) }, viewers: 1, comments: 0 },
        { id: 'lv101', title: 'F新しい', onAirTime: { beginAt: iso(t - 60000) }, viewers: 2, comments: 0 },
    ]
    const notify = [
        { id: '999', title: 'たった今始まった' },  // フォローAPIがまだ拾えていない新着
        { id: '101', title: 'F新しい' },           // 重複（フォローAPI側が正）
    ]

    // --- 和集合になるか ---
    let m = um._mergeSources(notify, follow)
    check('R-3A 両方の番組が漏れなく含まれる', m.length === 3,
        `${m.length} 件: ${m.map((x) => x.id).join(', ')}`)
    check('R-3A 重複した番組はフォローAPI側の実データを使う',
        m.find((x) => x.id === 'lv101')?.viewers === 2, '視聴者数が保持されている')

    // --- notifybox にしか無い新着が先頭に来るか ---
    const ordered = um._orderByBeginAtDesc(m)
    check('R-3A notifybox にしか無い新着が新着順の先頭に来る', ordered[0].id === 'lv999',
        `並び: ${ordered.map((x) => x.id).join(' → ')}`)

    // --- 片方が失敗しても描画できるか ---
    check('R-3A notifybox が失敗してもフォローAPIだけで描画できる',
        um._mergeSources(false, follow).length === 2)
    const onlyNotify = um._mergeSources(notify, null)
    check('R-3A フォローAPIが失敗しても notifybox だけで描画できる', onlyNotify.length === 2,
        `${onlyNotify.length} 件`)
    check('R-3A 詳細が無い番組もタイトルは出る',
        onlyNotify.every((x) => x.title && x.id.startsWith('lv')),
        onlyNotify.map((x) => `${x.id}:${x.title}`).join(', '))

    // --- 並びの安定性（同時刻は lv番号降順で決定的） ---
    const same = [
        { id: 'lv200', title: 'a', onAirTime: { beginAt: iso(t) } },
        { id: 'lv300', title: 'b', onAirTime: { beginAt: iso(t) } },
    ]
    const o1 = um._orderByBeginAtDesc(same).map((x) => x.id).join()
    const o2 = um._orderByBeginAtDesc([...same].reverse()).map((x) => x.id).join()
    check('R-3A 同時刻の並びが入力順に依存せず安定している', o1 === o2 && o1 === 'lv300,lv200',
        `${o1} / ${o2}`)
}

/**
 * R-1 追加: 素通りする回でも tick が暴走しないこと。
 *
 * サイドバーを閉じている／背景タブの間、_thumbDueAt の期限は過去のまま残る。
 * 素通り後の再スケジュールを「いちばん早い期限まで」で計算すると 0ms になり、
 * **0ms 再スケジュールの無限ループ**になってCPUを焼く（R-1 実装時に実際に作り込んだ）。
 * 更新回数だけを数えるテストでは検出できない（更新は0回のまま暴走する）ので、
 * ここでは tick の発火回数そのものを数える。
 */
async function r1NoSpin() {
    const cycleSec = 1
    const { appState, um } = build(60, 0)
    um.options.updateThumbnailInterval = cycleSec
    appState.sidebar.isOpen = true

    const container = { id: 'liveProgramContainer', children: [], contains: (el) => container.children.includes(el) }
    const els = [{ id: '2001' }, { id: '2002' }]
    container.children = els
    globalThis.document.getElementById = (q) =>
        q === 'liveProgramContainer' ? container : (els.find((e) => e.id === q) || null)

    let ticks = 0
    um._fetchLiveThumbIfPendingYoung = async () => {}
    um._updateOneThumbnailAndWait = async () => { await sleep(50) }
    const orig = um._thumbTick.bind(um)
    um._thumbTick = async () => { ticks++; return orig() }

    um.startThumbnailLoop()
    await sleep(cycleSec * 1000 * 2.5)      // 期限が過ぎるまで動かす

    // --- 閉じている間 ---
    appState.sidebar.isOpen = false
    ticks = 0
    await sleep(2000)
    const closedTicks = ticks
    check('R-1 閉じている間に tick が暴走しない', closedTicks <= 6,
        `2秒間の tick 発火 ${closedTicks} 回（1秒周期なので数回が正常。数百〜数千なら0ms暴走）`)

    // --- 背景タブの間 ---
    appState.sidebar.isOpen = true
    globalThis.document.hidden = true
    await sleep(cycleSec * 1000 * 1.5)
    ticks = 0
    await sleep(2000)
    const hiddenTicks = ticks
    globalThis.document.hidden = false
    check('R-1 背景タブの間に tick が暴走しない', hiddenTicks <= 6,
        `2秒間の tick 発火 ${hiddenTicks} 回`)

    // --- 停止判定で busy が立ちっぱなしにならないか ---
    um.destroyThumbnailLoop()
    check('R-1 破棄後に再入ガードが立ちっぱなしにならない', um._thumbTickBusy !== true,
        `_thumbTickBusy=${um._thumbTickBusy}`)

    // 破棄後に開き直して復活できること（busy が残っていると復活しない）
    appState.sidebar.isOpen = true
    let updated = 0
    um._updateOneThumbnailAndWait = async () => { updated++; await sleep(20) }
    um.startThumbnailLoop()
    await sleep(cycleSec * 1000 * 2.5 + 300)
    um.destroyThumbnailLoop()
    check('R-1 破棄→開き直しでサムネ更新が復活する', updated >= 1, `復活後 ${updated} 回`)
}

/**
 * R-7: 状態の置き場所の原則が守られていることの検証（doc/02 設計原則①）。
 *
 * - AppState に読み手ゼロのフィールドを増やしていないか
 * - 更新ループ2本が AppState.timers に載っていないか（載せると外部から殺される）
 * - 自動移動の状態が「タイマーだけ殺される」形になっていないか
 */
async function r7() {
    const { readFileSync } = await import('fs')
    const rd = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')
    const all = ['main.js', 'core/AppState.js', 'managers/UpdateManager.js', 'managers/LoadingManager.js',
        'managers/AutoNextManager.js', 'render/sidebar.js', 'render/animatedThumbnail.js',
        'ui/sidebarControl.js', 'ui/layout.js', 'handlers/optionsHandler.js', 'services/storage.js',
        'services/status.js', 'services/api.js', 'services/followPageSource.js'].map(rd).join('\n')

    // --- AppState.timers に更新ループを載せていないか ---
    const st = rd('core/AppState.js')
    const timersBlock = st.slice(st.indexOf('this.timers = {'), st.indexOf('};', st.indexOf('this.timers = {')))
    check('R-7 AppState.timers に更新ループ2本が載っていない',
        !/sidebar|thumbnail/.test(timersBlock),
        'timers のキー: ' + (timersBlock.match(/^\s*(\w+):/gm) || []).map((x) => x.trim()).join(' '))

    // --- 死にフィールドを復活させていないか ---
    const dead = ['isUpdating', 'pending:', 'config = {', 'this.elements =']
    const revived = dead.filter((d) => st.includes(d))
    check('R-7 削除した読み手ゼロのフィールドが復活していない', revived.length === 0,
        revived.length ? '復活: ' + revived.join(', ') : 'なし')

    // --- AppState の全フィールドに読み手がいるか ---
    // ⚠️ observers / timers / handlers は setObserver('resizeSidebar', ...) のように
    // **文字列キー**でしか触られない。ドットアクセスだけを数えると誤検出する。
    // （裏を返すと、これらは文字列を打ち間違えても AppState 側の `name in this.xxx` で
    //   無言で捨てられ、エラーにならない。増やす時は注意すること）
    // 判定は「宣言行以外にどこかで参照されているか」。
    // 触られ方は3通りあり、どれも正しい:
    //   1. 外からドットで   （例: appState.sidebar.isOpen）
    //   2. 外から文字列キーで（例: setObserver('resizeSidebar', ...)。読むのは cleanup の keys ループ）
    //   3. AppState.js 内のメソッド経由のみ（例: loading.updateSession は isLoading() などに閉じている）
    // したがって「宣言行を除いて1回も現れない」ものだけを死にフィールドとする。
    const declLine = (f) => new RegExp('^\\s+' + f + ':', 'm')
    const fields = [...st.matchAll(/^\s{12}(\w+):/gm)].map((m) => m[1])
    const unread = fields.filter((f) => {
        const inSelf = st.split('\n').filter((l) => l.includes(f) && !declLine(f).test(l)).length
        const dot = (all.match(new RegExp('\\.' + f + '\\b', 'g')) || []).length
        const str = (all.match(new RegExp("['\"]" + f + "['\"]", 'g')) || []).length
        return inSelf === 0 && dot === 0 && str === 0
    })
    check('R-7 AppState に宣言だけの死にフィールドが無い', unread.length === 0,
        unread.length ? '疑わしい: ' + unread.join(', ') : `${fields.length} フィールドすべてに参照あり`)

    // --- 更新ループの破棄が cleanup から呼ばれているか ---
    const mainSrc = rd('main.js')
    check('R-7 更新ループ2本の破棄が cleanup から呼ばれている',
        /destroySidebarLoop\(\)/.test(mainSrc) && /destroyThumbnailLoop\(\)/.test(mainSrc))

    // --- 破棄が片道になっていないか（再武装の入口があるか） ---
    const um = rd('managers/UpdateManager.js')
    const resetFn = um.slice(um.indexOf('resetSidebarSchedule() {'), um.indexOf('resetSidebarSchedule() {') + 600)
    const refreshFn = um.slice(um.indexOf('_refreshThumbSchedule() {'), um.indexOf('_refreshThumbSchedule() {') + 600)
    check('R-7 サイドバーループに再武装の入口がある', /_sidebarLoopStopped/.test(resetFn))
    check('R-7 サムネループにも再武装の入口がある', /_thumbLoopStopped/.test(refreshFn))

    // --- 自動移動を「タイマーだけ」殺していないか ---
    const stopAll = mainSrc.slice(mainSrc.indexOf('function stopAllTimers()'), mainSrc.indexOf('function stopAllTimers()') + 800)
    check('R-7 閉パスが自動移動をタイマーだけ殺していない（フラグとモーダルも戻す）',
        /cancelScheduledNavigation\(\)/.test(stopAll),
        'タイマーだけ clearTimer すると scheduled が残り、以後そのページで自動移動が動かなくなる')

    const anm = rd('managers/AutoNextManager.js')
    const cancelFn = anm.slice(anm.indexOf('cancelScheduledNavigation() {'), anm.indexOf('cancelScheduledNavigation() {') + 500)
    check('R-7 取り消しがタイマー・フラグ・モーダルの3点を戻す',
        /_clearAutoNextTimer\(\)/.test(cancelFn) && /hideModal\(\)/.test(cancelFn) && /scheduled = false/.test(cancelFn))
}

/**
 * R-4: ローディングセッションを「奪えない」構造にしたことの検証（doc/09 項目AG）。
 *
 * 旧実装は startSession が前のセッションを finish せずに黙って上書きしていた。
 * 後から来た者が持ち主からロックを奪い、それを閉じると持ち主がまだ実行中なのに
 * isLoading() が false へ落ちて「押せるのに無反応」になる。
 * IDスコープや相乗り判定は後付けの防御で、奪える構造がある限り同種の問題は出続けた。
 */
async function r4() {
    const { appState, loadingManager: lm } = build(60, 0)

    // --- 奪えないこと ---
    const a = lm.startSession()
    check('R-4 最初の開始でIDが返る', typeof a === 'string' && a.length > 0)
    const b = lm.startSession()
    check('R-4 動いている間の開始は null を返す（奪わない）', b === null, `2回目の戻り値: ${b}`)
    check('R-4 持ち主のIDが保持されている', lm.getCurrentSessionId() === a)
    check('R-4 施錠されたまま', appState.isLoading() === true)

    // --- 相乗り側が閉じられないこと ---
    await lm.finishSessionWithMinDuration(0, b)   // b は null＝相乗り。閉じてはいけない
    check('R-4 相乗り側が finish しても施錠は解けない', appState.isLoading() === true,
        `isLoading=${appState.isLoading()}`)

    // --- 持ち主だけが閉じられること ---
    await lm.finishSessionWithMinDuration(0, a)
    check('R-4 持ち主が finish すると施錠が解ける', appState.isLoading() === false)
    check('R-4 解けた後は新しく開始できる', typeof lm.startSession() === 'string')
    await lm.finishSessionWithMinDuration(0, lm.getCurrentSessionId())

    // --- 他人のIDでは閉じられないこと（IDスコープの二重防御） ---
    const c = lm.startSession()
    await lm.finishSessionWithMinDuration(0, 'update_999_bogus')
    check('R-4 他人のIDでは閉じられない', appState.isLoading() === true)
    await lm.finishSessionWithMinDuration(0, c)

    // --- updateSidebar が相乗り時に null を返すこと ---
    const { um: um2, loadingManager: lm2 } = build(60, 0)
    const own = lm2.startSession()          // 先に誰かが持っている状態を作る
    const joined = await um2.updateSidebar() // 実物ではなく差し替え版だが startSession の挙動は同じ
    check('R-4 先客がいる時 updateSidebar は null を返す（＝finish してはいけない合図）',
        joined === null, `戻り値: ${joined}`)
    await lm2.finishSessionWithMinDuration(0, own)

    // --- 構造の保証: 上書きを復活させていないか ---
    const { readFileSync } = await import('fs')
    const src = readFileSync(new URL('../src/managers/LoadingManager.js', import.meta.url), 'utf8')
    const startFn = src.slice(src.indexOf('startSession() {'), src.indexOf('startSession() {') + 400)
    check('R-4 startSession の先頭に「奪わない」ガードがある',
        /if \(this\.currentUpdateSessionId\) return null/.test(startFn),
        'これが消えると上書きが復活し、押せるのに無反応が再発する')
}

// ============================================================
const real = process.argv.includes('--real')

if (real) {
    console.log('=== 実スケール: 間隔60秒 / 取得300ms（約4分）===\n')
    await d1(60, 300, 3)
} else {
    console.log('=== サイドバー常設ループ 自動検証（doc/10 ブロックD の D1〜D5）===\n')
    await d1(3, 200)
    await d1(3, 1800)
    await d2()
    await d3()
    await d4()
    await d5()
    await revive()
    await noDouble()
    await sessionOnClose()
    await d6Static()
    console.log('')
    await ac1()
    await ac2()
    console.log('')
    await r1()
    console.log('')
    await r3merge()
    console.log('')
    await r1NoSpin()
    console.log('')
    await r7()
    console.log('')
    await r4()
}

console.log(`\n${failures === 0 ? '全項目 合格' : `${failures} 項目が不合格`}`)
process.exit(failures === 0 ? 0 : 1)
