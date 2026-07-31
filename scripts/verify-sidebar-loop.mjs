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
    const thumbHasHidden = /_isBackgroundTab/.test(um.slice(um.indexOf('async _thumbTick'), um.indexOf('async _thumbTick') + 3000))
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
 * AZ: 新番組のサムネイルが出るまで。
 *
 * ① ライブサムネを持たない番組（チャンネル等）は、カードが先に立つと**そのカードに触れる経路が
 *    サムネ更新ループしか無い**。そこが「loading.gif の時だけ戻す」だったため、繋ぎ画像を
 *    アイコンに変えた瞬間に絵が永久に出なくなった（実測: 改修前58秒 → 出ない・更新ボタンも効かない）。
 * ② notifybox が先に見つけた新番組は storage に居ないため、ライブサムネの追撃が始まらず
 *    フォローAPI（20〜101秒遅い）を待っていた。
 */
async function newProgramThumb() {
    const { buildRenderHarness, wireUpdateManager, apiProgram, fixedImageUrl } = await import('./render-harness.mjs')
    console.log('=== AZ 新番組のサムネイルが出るまで ===')
    const T = Date.now() - 600000

    // --- ① 静止サムネしか無い番組が、後からでも表示されるか ---
    {
        const h = buildRenderHarness({ programsSort: 'newest' })
        const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)
        const run = async () => { const s = await um.updateSidebar(); if (s) loadingManager.finishSession(s) }
        // まず notifybox だけが知っている状態でカードを作らせる（サムネURL無し＝繋ぎはアイコン）
        h.state.followPrograms = []
        h.state.notifyRows = [{ id: 555, title: 'ch番組', community_name: 'ch名', thumbnail_url: 'https://icon/ch.jpg', provider_type: 'channel' }]
        await run()
        const img = h.dom.getById('555').querySelector('.program_thumbnail_img')
        check('AZ ① 新着カードの繋ぎは配信者アイコン', img.src === 'https://icon/ch.jpg', img.src)

        // フォローAPIが「絵はあるがライブスクショではない」番組として返す（＝チャンネル番組）
        h.state.notifyRows = []
        h.state.followPrograms = [apiProgram({ id: 'lv555', beginAtMs: T, providerType: 'channel', fixedImage: false, thumb: false })]
        h.state.followPrograms[0].listingThumbnail = fixedImageUrl('555')
        await run()
        check('AZ ① 静止サムネが data-src に入る', img.getAttribute('data-src') === fixedImageUrl('555'), img.getAttribute('data-src'))
        check('AZ ① この時点では img.src はまだアイコン（その場更新は src を触らない設計）',
            img.src === 'https://icon/ch.jpg', img.src)

        // サムネ更新ループが回れば表示される（ここが唯一の表示経路）
        await new Promise((resolve) => um.updateThumbnail(false, resolve))
        check('AZ ① 🔴 ライブサムネを持たない番組でも、サムネ更新ループが静止サムネを表示する',
            img.src === fixedImageUrl('555'), img.src)
        check('AZ ① 静止サムネは thumbLive=0（動くサムネが最新コマとして混ぜない）',
            img.dataset.thumbLive === '0', img.dataset.thumbLive)
        h.restore()
    }

    // --- ② notifybox だけの新番組も storage に載る（＝ライブサムネの追撃が始められる） ---
    {
        const h = buildRenderHarness({ programsSort: 'newest' })
        const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)
        const run = async () => { const s = await um.updateSidebar(); if (s) loadingManager.finishSession(s) }
        h.state.followPrograms = []
        h.state.notifyRows = [{ id: 777, title: '新着', community_name: '配信者', thumbnail_url: 'https://icon/u.jpg', provider_type: 'community' }]
        await run()
        const stored = JSON.parse(globalThis.localStorage.getItem('programInfos') || '[]')
        const seed = stored.find((i) => i.id === 'lv777')
        check('AZ ② 🔴 notifybox だけの新番組も storage に載る（追撃の前提）', !!seed, stored.map((i) => i.id).join(','))
        check('AZ ② 種は最小レコード（ライブサムネ空・user 扱い）',
            !!seed && seed.thumbnailUrl === '' && seed.providerType === 'user')

        // 追撃が実際に詳細APIを叩き、取れたサムネが storage に入るか
        h.state.detailThumb = 'https://dlive.nicovideo.jp/live/777/screenshot/1.jpg'
        await um._fetchLiveThumbIfPendingYoung('777')
        const after = JSON.parse(globalThis.localStorage.getItem('programInfos') || '[]').find((i) => i.id === 'lv777')
        check('AZ ② 🔴 フォローAPIを待たずにライブサムネを取得できる',
            !!after && after.thumbnailUrl === h.state.detailThumb, after ? after.thumbnailUrl : '(レコード無し)')
        check('AZ ② そのために詳細APIを1回だけ叩いた', h.state.calls.detail === 1, `${h.state.calls.detail} 回`)
        h.restore()
    }
}

/**
 * AY: 盛り上がり（人気順のスコア）＝直近の増分レートの指数移動平均。
 *
 * 旧スコアは「開始からの平均」だったので、長時間放送は今どれだけ盛り上がっていても不利で、
 * 序盤だけ人が来た枠は貯金で上位に残り続けた。ここでは「新旧が同じ土俵に乗る」ことを固定する。
 */
async function momentumScore() {
    console.log('=== AY 盛り上がり（人気順のスコア） ===')
    const { initialMomentum, nextMomentum } = await import(new URL('../src/utils/momentum.js', import.meta.url).href)
    const { compareByActivePoint } = await import(new URL('../src/utils/programOrder.js', import.meta.url).href)
    const { momentumTauMs } = await import(new URL('../src/config/constants.js', import.meta.url).href)
    const NOW = Date.now()
    const prog = (v, c, ageMin) => ({ viewers: v, comments: c, onAirTime: { beginAt: new Date(NOW - ageMin * 60000).toISOString() } })
    const near = (a, b) => Math.abs(a - b) < 1e-9

    // --- 立ち上げ ---
    check('AY 初回は開始からの平均レート', near(initialMomentum(prog(100, 20, 10), NOW), 12), '(100+20)/10分 = 12')
    check('AY 開始直後は1分として扱う（0除算しない）', near(initialMomentum(prog(5, 0, 0), NOW), 5))
    check('AY 開始時刻が不明でも落ちない', Number.isFinite(initialMomentum({ viewers: 3, comments: 0 }, NOW)))
    check('AY 前回値が無ければ初回扱い',
        near(nextMomentum(null, prog(100, 20, 10), NOW), initialMomentum(prog(100, 20, 10), NOW)))

    // --- 更新（EMA） ---
    const a60 = 1 - Math.exp(-60000 / momentumTauMs)
    const prev = { viewers: 100, comments: 20, momentum: 0, _fetchedAt: NOW - 60000 }
    check('AY 直近の増分レートが指数移動平均で入る',
        near(nextMomentum(prev, prog(160, 20, 11), NOW), 0 + (60 - 0) * a60), '60秒で+60 → 60/分 が α で混ざる')
    check('AY 🔴 累計が減っても負の勢いにしない（取得元の揺れ対策）',
        near(nextMomentum({ ...prev, momentum: 10 }, prog(50, 10, 11), NOW), 10 + (0 - 10) * a60))
    check('AY 極小のΔtでは据え置く（勢いが爆発しない）',
        nextMomentum({ viewers: 0, comments: 0, momentum: 7, _fetchedAt: NOW - 10 }, prog(500, 0, 5), NOW) === 7)
    // notifybox 由来の種（来場者0）を前回値に使うと、0→実数の丸ごとが「急増」に化ける（項目AZ）
    const seed = { viewers: 0, comments: 0, momentum: 0, _fetchedAt: NOW - 60000, _source: 'notifybox' }
    check('AY 🔴 notifybox の種を「前回値」に使わない（新着が不当に1位へ飛ぶのを防ぐ）',
        near(nextMomentum(seed, prog(600, 0, 10), NOW), initialMomentum(prog(600, 0, 10), NOW)),
        `種から計算=${nextMomentum(seed, prog(600, 0, 10), NOW).toFixed(1)} / 開始からの平均=${initialMomentum(prog(600, 0, 10), NOW).toFixed(1)}（差分方式なら 600/分 に跳ねる）`)

    // --- 更新間隔が変わっても手触りが揃うか（時間ベースのα） ---
    // 30秒×6回 と 180秒×1回。どちらも「1分あたり10」で伸び続けた3分間なので、結果は一致するはず。
    let m30 = 0
    for (let i = 0; i < 6; i++) {
        m30 = nextMomentum({ viewers: 0, comments: 0, momentum: m30, _fetchedAt: NOW - 30000 }, prog(5, 0, 1), NOW)
    }
    const m180 = nextMomentum({ viewers: 0, comments: 0, momentum: 0, _fetchedAt: NOW - 180000 }, prog(30, 0, 3), NOW)
    check('AY 🔴 更新間隔が違っても同じ実時間なら同じ値になる（30秒×6 と 180秒×1）',
        near(m30, m180), `30秒×6=${m30.toFixed(6)} / 180秒×1=${m180.toFixed(6)}`)

    // --- 同点時の第2キー（静かな番組は勢いが0で並ぶ） ---
    const el = (ap, total) => ({ getAttribute: (k) => (k === 'active-point' ? ap : k === 'data-total' ? total : null) })
    check('AY 勢いが違えば勢いが優先',
        [el('1', '9999'), el('5', '1')].sort(compareByActivePoint)[0].getAttribute('active-point') === '5')
    check('AY 同点（静かな番組）は累計の多い順',
        [el('0', '5'), el('0', '50')].sort(compareByActivePoint)[0].getAttribute('data-total') === '50')
    check('AY 属性が欠けたカードが混ざっても落ちない',
        Number.isFinite(compareByActivePoint(el(null, null), el(null, null))))
}

/**
 * AY(実描画経路): 長時間放送と新しい番組が同じ土俵に乗るか。
 *
 * 旧スコア `(来場者+1 + コメント+1) / 経過分` なら、下の 3時間番組(累計30000)は 167、
 * 10分の番組(累計400)は 40 で、**今どちらが伸びていても3時間番組が勝つ**。
 * ここが入れ替わることを固定する＝この検証は旧実装では必ず落ちる。
 */
async function momentumRanking() {
    const { buildRenderHarness, wireUpdateManager, apiProgram } = await import('./render-harness.mjs')
    console.log('=== AY 長時間放送と新番組を同じ土俵で比べる（実描画経路） ===')
    const NOW = Date.now()
    const h = buildRenderHarness({ programsSort: 'active' })
    const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)
    const run = async () => { const s = await um.updateSidebar(); if (s) loadingManager.finishSession(s) }
    const ids = () => h.dom.ids().join(',')
    h.state.notifyRows = []

    // ① 基準。lv900=3時間で累計30000（今は静か） / lv901=10分で累計100（これから伸びる）
    h.state.followPrograms = [
        apiProgram({ id: 'lv900', beginAtMs: NOW - 180 * 60000, viewers: 30000, comments: 0 }),
        apiProgram({ id: 'lv901', beginAtMs: NOW - 10 * 60000, viewers: 100, comments: 0 }),
    ]
    await run()
    // ② 1分ずつ経過させ、直近の伸びを 10/分 対 300/分 で与える。
    // 初回は前回値が無いので「開始からの平均」で立ち上がる（lv900=167, lv901=10）。そこから
    // 実際の直近レートへ寄っていくので、**入れ替わりは1周期目ではなく数周期かけて起きる**。
    // これは EMA の暖機であって、旧スコアのような構造的な不利ではない（時定数3分＝実時間で数分）。
    const ap = (id) => parseFloat(h.dom.getById(id).getAttribute('active-point'))
    let v900 = 30000; let v901 = 100
    for (let cycle = 1; cycle <= 3; cycle++) {
        h.ageStorage(60000)
        v900 += 10; v901 += 300
        h.state.followPrograms = [
            apiProgram({ id: 'lv900', beginAtMs: NOW - (180 + cycle) * 60000, viewers: v900, comments: 0 }),
            apiProgram({ id: 'lv901', beginAtMs: NOW - (10 + cycle) * 60000, viewers: v901, comments: 0 }),
        ]
        await run()
        if (cycle === 1) {
            check('AY 1周期目はまだ暖機中（開始からの平均から寄り始める）',
                ap('900') < 167 && ap('901') > 10,
                `lv900 ${ap('900').toFixed(1)}（初期値167から下降中） / lv901 ${ap('901').toFixed(1)}（初期値10から上昇中）`)
        }
    }
    check('AY 🔴 長時間放送より、いま伸びている番組が上に来る', ids() === '901,900', ids())
    // 3周期後は「初期値(167 / 10)」から「実レート(10 / 300)」の側へ十分寄っているはず。
    // ぴったりの値ではなく“どちらの側に居るか”で見る（時定数を変えても意味が壊れないように）。
    check('AY 🔴 スコアが「開始からの平均」ではなく「直近の勢い」に寄る',
        ap('901') > ap('900') && ap('900') < 80 && ap('901') > 150,
        `3周期後: lv901=${ap('901').toFixed(1)}（初期10→実レート300へ） / lv900=${ap('900').toFixed(1)}（初期167→実レート10へ）`
        + ' ※旧スコアなら lv900=167, lv901=40 で永久に逆転しない')
    check('AY 第2キー data-total が両方のカードに入っている',
        h.dom.getById('900').getAttribute('data-total') === String(v900)
        && h.dom.getById('901').getAttribute('data-total') === String(v901),
        `lv900=${h.dom.getById('900').getAttribute('data-total')} / lv901=${h.dom.getById('901').getAttribute('data-total')}`)

    // ④ 数字が変わらない周期は順位も動かない（旧スコアは経過分の切り上がりだけで動いていた）
    const before = ids()
    h.ageStorage(60000)
    await run()
    check('AY 数字が変わらなければ順位も動かない（時間だけでは入れ替わらない）', ids() === before, ids())
    h.restore()
}

/**
 * AW: 固定画像運用の番組から flippedListingThumbnail でライブスクショを回収できるか。
 *
 * 回収できないと、その番組は毎サイクル「詳細APIで番組ごとに問い合わせ」に回る（実測で user の約1/3）。
 * しかもリスト描画はその応答を待つので、更新が丸ごと遅くなる。
 */
async function flippedThumb() {
    console.log('=== AW 固定画像の番組からライブスクショを回収する（flippedListingThumbnail） ===')
    const { mapApiProgramToInfo, isLiveScreenshotUrl } = await import(
        new URL('../src/services/followPageSource.js', import.meta.url).href)
    const FIXED = 'https://listing-thumbnail.live.nicovideo.jp?image=prod-lv1/thumbnail_1774977137608.png&w=352&h=198'
    const SHOT = 'https://asset2.dlive.nicovideo.jp/915e/abc/screenshot/123/thumbnail-352x198/screenshot.jpg'
    // 実測22件中2件はこの形（プロキシに包まれたスクショ）。判定を通さないのが正解
    const WRAPPED = 'https://listing-thumbnail.live.nicovideo.jp/?url=' + encodeURIComponent(SHOT)
    const base = { id: 'lv1', title: 't', providerType: 'community', programProvider: { id: '1', name: 'n' }, statistics: {}, beginAt: Date.now() }

    const fixedOnly = mapApiProgramToInfo({ ...base, listingThumbnail: FIXED })
    check('AW 固定画像だけの番組はライブサムネ空のまま（詳細APIの補完に回す）',
        fixedOnly.thumbnailUrl === '' && !fixedOnly.liveScreenshotThumbnailUrls, fixedOnly.thumbnailUrl)

    const withFlipped = mapApiProgramToInfo({ ...base, listingThumbnail: FIXED, flippedListingThumbnail: SHOT })
    check('AW 🔴 flippedListingThumbnail からライブスクショを回収する',
        withFlipped.thumbnailUrl === SHOT, withFlipped.thumbnailUrl)
    check('AW 回収したURLは定期更新の対象にも入る（liveScreenshotThumbnailUrls）',
        withFlipped.liveScreenshotThumbnailUrls && withFlipped.liveScreenshotThumbnailUrls.middle === SHOT)

    const wrapped = mapApiProgramToInfo({ ...base, listingThumbnail: FIXED, flippedListingThumbnail: WRAPPED })
    check('AW 🔴 プロキシに包まれた形は採用しない（項目AA の事故を避ける）',
        wrapped.thumbnailUrl === '' && !isLiveScreenshotUrl(WRAPPED), wrapped.thumbnailUrl)

    const normal = mapApiProgramToInfo({ ...base, listingThumbnail: SHOT, flippedListingThumbnail: FIXED })
    check('AW listingThumbnail がスクショなら従来どおりそれを使う（flipped に引きずられない）',
        normal.thumbnailUrl === SHOT, normal.thumbnailUrl)

    const ch = mapApiProgramToInfo({ ...base, providerType: 'channel', listingThumbnail: FIXED, flippedListingThumbnail: SHOT })
    check('AW channel の表示サムネは従来どおり listingThumbnail（ライブサムネは提供されない前提）',
        ch.thumbnailUrl === FIXED && !ch.liveScreenshotThumbnailUrls, ch.thumbnailUrl)
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

    // --- 項目AT: notifybox の行を id と title だけに削らない ---
    // フォローAPIが同じ番組を拾うまでの 20〜101秒＋1周期、ここで捨てた情報がそのまま
    // 「配信者名不明・アイコンなし・ローディング画像」として画面に出る。
    const userRow = {
        id: '880', title: 'ユーザー生放送', community_name: '速報の配信者', provider_type: 'community',
        thumbnail_url: 'https://secure-dcdn.cdn.nimg.jp/nicoaccount/usericon/5255/52553742.jpg?1673509950',
    }
    const chRow = {
        id: '881', title: 'チャンネル番組', community_name: 'チャンネルX', provider_type: 'official',
        thumbnail_url: 'https://secure-dcdn.cdn.nimg.jp/comch/channel-icon/128x128/ch2607134.jpg?1680231845',
    }
    const rich = um._mergeSources([userRow, chRow], [])
    const u880 = rich.find((x) => x.id === 'lv880')
    const c881 = rich.find((x) => x.id === 'lv881')
    check('AT notifybox の配信者名(community_name)を捨てない',
        u880?.contentOwner?.name === '速報の配信者', `"${u880?.contentOwner?.name}"`)
    check('AT notifybox のアイコン(thumbnail_url)を捨てない',
        (u880?.contentOwner?.icon || '').includes('usericon'), u880?.contentOwner?.icon)
    check('AT アイコンURLから配信者IDを復元する（投稿者ページへのリンク用）',
        u880?.contentOwner?.id === '52553742', `"${u880?.contentOwner?.id}"`)
    check('AT 🔴 アイコンを thumbnailUrl に入れない（アイコンをライブサムネとして20秒ごとに取り直す事故の防止・項目AA）',
        u880?.thumbnailUrl === '', `thumbnailUrl="${u880?.thumbnailUrl}"`)
    check('AT notifybox の provider_type を反映する（official → channel）',
        c881?.providerType === 'channel', c881?.providerType)
    check('AT チャンネルアイコンURLからはチャンネルIDを復元する',
        c881?.contentOwner?.id === 'ch2607134', `"${c881?.contentOwner?.id}"`)
    check('AT 想定外の行でも落ちない（欠損は空で埋める）',
        um._mergeSources([{ id: '882', title: 'x' }], [])
            .find((x) => x.id === 'lv882')?.contentOwner?.name === '')

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

    // --- 閉パスが自動移動に触っていないか（項目AX で「閉じても止めない」へ変更した） ---
    // 旧: 閉じると cancelScheduledNavigation で取り消していた。その時の不変条件は
    //     「タイマーだけ殺すな（scheduled が残ると以後動かない＝項目AF）」だった。
    // 今: そもそも触らないのが正。**うっかり clearTimer('autoNext') を書き戻すと項目AF が再発する**ので、
    //     触っていないこと自体を機械で見る。終端は実際の文字列でアンカーする（固定幅で切らない）。
    const openFnStart = mainSrc.indexOf('async function handleSidebarOpenStateChange(open)')
    const openFn = mainSrc.slice(openFnStart, mainSrc.indexOf('\n}', mainSrc.indexOf('// else: 閉じた時にすることは無い', openFnStart)))
    check('R-7 閉パスが自動移動のカウントダウンに触らない（閉じても止めない）',
        !/clearTimer\(['"]autoNext['"]\)/.test(openFn) && !/cancelScheduledNavigation/.test(openFn),
        'タイマーだけ clearTimer すると scheduled が残り、以後そのページで自動移動が動かなくなる（項目AF）')
    check('R-7 閉パスの中身が空（閉じて止めるものはループ側の素通りに一本化）',
        /else: 閉じた時にすることは無い/.test(openFn))

    // --- 停止経路（stopWatcher）は3点セットで戻すか ---
    const anm = rd('managers/AutoNextManager.js')
    const stopFn = anm.slice(anm.indexOf('stopWatcher() {'), anm.indexOf('\n    }', anm.indexOf('stopWatcher() {')))
    check('R-7 監視停止はタイマー・フラグ・モーダルの3点を戻す',
        /_clearAutoNextTimer\(\)/.test(stopFn) && /hideModal\(\)/.test(stopFn) && /scheduled = false/.test(stopFn))

    // --- カウントダウンが「期限」で持たれているか（裏タブの間引き対策） ---
    const schedFn = anm.slice(anm.indexOf('scheduleNavigation(nextHref, preview) {'), anm.indexOf('startWatcher('))
    check('R-7 カウントダウンが期限(Date.now)で計算されている（1秒ずつ引き算しない）',
        /deadlineAt/.test(schedFn) && /Date\.now\(\)/.test(schedFn) && !/remaining -= 1/.test(schedFn),
        '引き算方式だと裏タブの間引き（1分に1回）で10秒が最大10分に化ける')
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

/**
 * R-5: 実行可否ポリシーが表どおりに実装されていることの検証（UpdateManager 冒頭の表）。
 *
 * 「今この処理をしてよいか」の判定は、どこで何を見るかが**意図的に違う**。
 * 同じ判定に見えるので取り違えやすく、実際に説明を誤ったことがある。表を機械で守らせる。
 */
async function r5() {
    const { readFileSync } = await import('fs')
    const um = readFileSync(new URL('../src/managers/UpdateManager.js', import.meta.url), 'utf8')
    // ⚠️ 固定幅で切らないこと。コメントを足しただけで判定対象が窓から押し出され、
    //    「実装は正しいのにNG」になる（この罠を4回踏んだ）。終端は実際の内容で指定する。
    const body = (start, endAnchor) => {
        const i = um.indexOf(start)
        if (i < 0) return ''
        const j = endAnchor ? um.indexOf(endAnchor, i) : -1
        return um.slice(i, j > i ? j : i + 2500)
    }

    // --- 生の判定が直書きされていないか（述語の定義を除く） ---
    // ⚠️ コメント行は数えない。ポリシー表そのものが「document.hidden を直書きするな」と
    //    書いているため、素朴に数えると表の記述を違反として数えてしまう。
    const code = um.split('\n')
        .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) })
        .join('\n')
    const rawCount = (re) => [...code.matchAll(re)].length
    check('R-5 document.hidden の直書きは述語の定義1箇所だけ',
        rawCount(/document\.hidden/g) === 1, `${rawCount(/document\.hidden/g)} 箇所`)
    check('R-5 appState.sidebar.isOpen の直書きは述語の定義1箇所だけ',
        rawCount(/appState\.sidebar\.isOpen/g) === 1, `${rawCount(/appState\.sidebar\.isOpen/g)} 箇所`)
    check('R-5 appState.isLoading() の直書きは述語の定義1箇所だけ',
        rawCount(/appState\.isLoading\(\)/g) === 1, `${rawCount(/appState\.isLoading\(\)/g)} 箇所`)

    // --- 表のとおりか ---
    const sidebarTick = body('async _sidebarTick()', 'async _thumbTick()')
    const thumbTick = body('async _thumbTick()', '_fetchLiveThumbIfPendingYoung(id)')
    const updThumb = body('updateThumbnail(force, onComplete', 'updateThumbnailsFromStorage(programInfos')

    check('R-5 リスト更新は「閉じているか」を見る', /_isSidebarOpen\(\)/.test(sidebarTick))
    check('R-5 リスト更新は「別の更新中か」を見る', /_isUpdateInFlight\(\)/.test(sidebarTick))
    check('R-5 🔴 リスト更新は背景タブを見ない（655df9c の意図的決定）',
        !/_isBackgroundTab\(\)/.test(sidebarTick),
        'ここに可視判定を足すと仕様変更。裏タブでもリストを取り続けるのが仕様')

    check('R-5 サムネ更新は「閉じているか」を見る', /_isSidebarOpen\(\)/.test(thumbTick))
    check('R-5 サムネ更新は背景タブを見る（rAF が止まるため）', /_isBackgroundTab\(\)/.test(thumbTick))

    check('R-5 サムネ反映は背景タブを見る（完了通知が来ないため）', /_isBackgroundTab\(\)/.test(updThumb))
    check('R-5 サムネ反映は DOM差し替え中を見る', /isInserting/.test(updThumb))

    // --- ポリシー表そのものが残っているか（消されると意図が失われる） ---
    check('R-5 実行可否ポリシーの表がコードに残っている',
        um.includes('実行可否ポリシー') && um.includes('リスト更新だけが背景タブを見ない'),
        '表が消えると「なぜ違うのか」が失われ、また取り違える')
}

/**
 * FLIP: 定期更新で順位が入れ替わった時だけスライドさせる（doc/09 項目AI）。
 *
 * 入れ替わり自体は FLIP の有無に関係なく起きている。FLIP は動きを足すのではなく、
 * 既に起きている瞬間移動を目で追える形にするだけ。
 */
async function flip() {
    const { readFileSync } = await import('fs')
    const um = readFileSync(new URL('../src/managers/UpdateManager.js', import.meta.url), 'utf8')
    const sb = readFileSync(new URL('../src/render/sidebar.js', import.meta.url), 'utf8')
    const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')

    // --- 定期更新の組み替えが FLIP を通っているか ---
    // ⚠️ **固定幅で切らないこと。** 以前は +2200文字で切っており、この区間に数行足しただけで
    //    sortProgramsInContainer( が窓の外へ押し出され、実装は正しいのに NG が出た（4回目の再発）。
    //    終端は実際に存在する文字列でアンカーする。
    const branchStart = um.indexOf('if (structuralChange) {')
    const branch = um.slice(branchStart, um.indexOf('// else: その場更新のみ', branchStart))
    check('FLIP 定期更新の組み替えが flipReorder を通る', /flipReorder\(/.test(branch))
    check('FLIP replaceChildren と sort が flipReorder の中にある',
        branch.indexOf('flipReorder(') < branch.indexOf('replaceChildren(') &&
        branch.indexOf('flipReorder(') < branch.indexOf('sortProgramsInContainer('),
        '外に出ると First/Last の実測が噛み合わない')

    // --- 並べ替えが同期のままか（await/rAF を挟んでいないか） ---
    const cb = branch.slice(branch.indexOf('flipReorder('), branch.indexOf('reorderFlipDurationMs'))
    check('FLIP 並べ替えのコールバックが同期のまま',
        !/await |requestAnimationFrame|setTimeout|\.then\(/.test(cb),
        'ここに非同期を挟むと isInserting が生き返り、サムネが「更新0回・エラー0件」で止まる')

    // --- 設定変更の経路は通っていないこと ---
    const wrapper = mainSrc.slice(mainSrc.indexOf('function sortPrograms('), mainSrc.indexOf('function sortPrograms(') + 300)
    check('FLIP 設定で並び順を変えた時は通さない（ユーザー自身の操作なので瞬時でよい）',
        !/flipReorder/.test(wrapper), wrapper.trim().split('\n')[0])

    // --- flipReorder 本体の性質 ---
    // ここも終端アンカー方式（次の export まで）。固定幅にすると同じ罠を踏む。
    const frStart = sb.indexOf('export function flipReorder')
    const fr = sb.slice(frStart, sb.indexOf('export function buildSidebarShell', frStart))
    check('FLIP 移動量0の要素はスキップする', /dx === 0 && dy === 0/.test(fr))
    check('FLIP First が取れない要素（新規カード）はスキップする', /if \(!first\) return/.test(fr),
        '初回描画は既存カードが無いので自動的にアニメ無しになる')
    check('FLIP 終了後にインラインスタイルを消す', /style\.transform = ''/.test(fr) && /setTimeout/.test(fr))

    // --- 時間が定数化されているか ---
    const c = await import(new URL('../src/config/constants.js', import.meta.url).href)
    check('FLIP アニメ時間が定数化されている（0で実質無効にできる）',
        Number.isFinite(c.reorderFlipDurationMs) && c.reorderFlipDurationMs >= 0,
        `reorderFlipDurationMs=${c.reorderFlipDurationMs}ms`)
}

/**
 * 他タブで設定を変えた時に、このタブが追随するか（doc/09 項目AJ）。
 * optionsHandler の change リスナは変更したタブでしか発火しない。
 * storage.onChanged が他タブ由来の変更を受け取る唯一の経路。
 */
async function crossTab() {
    const { readFileSync } = await import('fs')
    const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
    const i = mainSrc.indexOf('if (changes.programsSort)')
    const blk = mainSrc.slice(i, i + 900)
    check('他タブで並び順を変えたらこのタブも並べ替える', blk.includes('sortPrograms('),
        '値を入れるだけだと古い順序のまま残る')
    // ⚠️ needsRestart は宣言(435行付近)と使用(487行付近)が50行以上離れている。
    //    先頭からの固定幅で切ると使用箇所に届かず「実装は正しいのにNG」になる（実際に踏んだ）。
    const iv = mainSrc.slice(mainSrc.lastIndexOf('needsRestart'), mainSrc.lastIndexOf('needsRestart') + 300)
    check('他タブで更新間隔を変えたらこのタブも位相を置き直す', iv.includes('resetSidebarSchedule()'),
        iv.split('\n').slice(0, 2).join(' / ').trim())
    check('他タブでテーマを変えたらこのタブも適用する',
        mainSrc.includes('changes.sidebarTheme') && mainSrc.includes('applyTheme('))
}

/**
 * 既存カードのその場更新が「後から埋まった情報」を反映するか（doc/09 項目AK）。
 *
 * フォローAPIは channel の programProvider を返さないので、配信者名/アイコンは
 * fillMissingDetails が詳細APIで後から埋める。生成時サムネが空の番組も同様。
 * その場更新がそれらを反映しないと、カードは生成時のまま固定される。
 */
async function inPlaceUpdate() {
    const sb = await import(`${SRC}render/sidebar.js`)

    // 最小限の要素モック（querySelector / insertBefore / 属性）
    const mkEl = (cls) => {
        const el = {
            className: cls || '', children: [], attrs: {}, style: {},
            textContent: '', title: '', _src: '', _href: '',
            get src() { return this.attrs.src || '' }, set src(v) { this.attrs.src = v },
            get href() { return this.attrs.href || '' }, set href(v) { this.attrs.href = v },
            getAttribute(k) { return this.attrs[k] ?? null },
            setAttribute(k, v) { this.attrs[k] = String(v) },
            appendChild(c) { this.children.push(c); c.parentElement = this; return c },
            insertBefore(c, ref) { const i = ref ? this.children.indexOf(ref) : 0; this.children.splice(i < 0 ? 0 : i, 0, c); c.parentElement = this; return c },
            get firstChild() { return this.children[0] || null },
            querySelector(sel) {
                const want = sel.replace(/^\./, '').split(' ').pop().replace(/^\./, '')
                const walk = (n) => {
                    for (const c of n.children) {
                        if ((c.className || '').split(' ').includes(want) || c.tag === want) return c
                        const r = walk(c); if (r) return r
                    }
                    return null
                }
                return walk(this)
            },
        }
        return el
    }
    globalThis.document.createElement = (tag) => { const e = mkEl(''); e.tag = tag; return e }

    // 生成時: 配信者名もアイコンもサムネURLも無い状態のカードを手で組む
    const card = mkEl('program_container')
    const provider = mkEl('provider')
    const name = mkEl('provider_name'); name.textContent = '配信者名不明'
    provider.appendChild(name)
    card.appendChild(provider)
    const thumb = mkEl('program_thumbnail')
    const a = mkEl(''); a.tag = 'a'
    const img = mkEl('program_thumbnail_img'); img.setAttribute('data-src', '')
    a.appendChild(img); thumb.appendChild(a); card.appendChild(thumb)
    const title = mkEl('program_title'); title.textContent = '旧タイトル'; card.appendChild(title)

    // 後から詳細が埋まった programInfo を反映
    sb.applyProgramInfoToCard(card, {
        id: 'lv555', title: '新タイトル', providerType: 'channel',
        contentOwner: { id: 'ch99', name: '公式チャンネル', icon: 'https://x/icon.png' },
        thumbnailUrl: 'https://dlive.nicovideo.jp/s.jpg',
        viewers: 1, comments: 1, onAirTime: { beginAt: new Date().toISOString() },
    })

    check('AK 後から埋まった配信者名が反映される', name.textContent === '公式チャンネル',
        `"${name.textContent}"`)
    const iconImg = provider.children.find((c) => c.tag === 'img' || (c.children[0] && c.children[0].tag === 'img'))
    check('AK 生成時に無かったアイコンが後から挿入される', !!iconImg,
        iconImg ? '挿入された' : 'provider の子: ' + provider.children.map((c) => c.tag || c.className).join(','))
    check('AK アイコンは配信者名より前に入る', provider.children[0] !== name)
    check('AK 空だった data-src が実URLに更新される',
        img.getAttribute('data-src') === 'https://dlive.nicovideo.jp/s.jpg',
        `data-src="${img.getAttribute('data-src')}"`)
    check('AK タイトルも更新される', title.textContent === '新タイトル')
    check('AK 表示中の画像(src)は触らない（差し替えはサムネ更新ループの仕事）',
        !img.attrs.src, `src="${img.attrs.src || ''}"`)

    // 2回目の適用で重複挿入しないこと
    const before = provider.children.length
    sb.applyProgramInfoToCard(card, {
        id: 'lv555', title: '新タイトル', providerType: 'channel',
        contentOwner: { id: 'ch99', name: '公式チャンネル', icon: 'https://x/icon.png' },
        thumbnailUrl: 'https://dlive.nicovideo.jp/s.jpg',
        viewers: 1, comments: 1, onAirTime: { beginAt: new Date().toISOString() },
    })
    check('AK 2回適用してもアイコンが増殖しない', provider.children.length === before,
        `${before} → ${provider.children.length}`)

    // 導出が1箇所に集約されているか（同じ事実を2箇所に置かない）
    const { readFileSync } = await import('fs')
    const src = readFileSync(new URL('../src/render/sidebar.js', import.meta.url), 'utf8')
    // ⚠️ コメント行は数えない。説明文が同じ語を含むため、素朴に数えると自分の説明を
    //    違反として数えてしまう（R-5 でも同じ罠を踏んだ）。
    const codeOnly = src.split('\n')
        .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) })
        .join('\n')
    const derivations = (codeOnly.match(/配信者名不明/g) || []).length
    check('AK 配信者名のフォールバックが deriveCardFields に集約されている', derivations === 1,
        `コード中の出現 ${derivations} 箇所（deriveCardFields の1箇所だけが正常）`)
    const applyFn = src.slice(src.indexOf('export function applyProgramInfoToCard'),
        src.indexOf('export function makeProgramElement'))
    check('AK その場更新も deriveCardFields を通す（導出を二重に書かない）',
        /deriveCardFields\(/.test(applyFn))
}

/**
 * 描画が同期のままであることの保証（doc/09 項目AL）。
 *
 * isInserting=true 〜 false の区間に await が入ると、updateThumbnail の早期returnが
 * 到達可能になる。その分岐は onComplete を呼んで「完了した」と嘘をつくため、
 * サムネが「更新0回・エラー0件」で静かに止まる。区間を機械で守る。
 */
async function syncRender() {
    const { readFileSync } = await import('fs')
    const um = readFileSync(new URL('../src/managers/UpdateManager.js', import.meta.url), 'utf8')

    const s = um.indexOf('this.appState.update.isInserting = true;')
    const e = um.indexOf('this.appState.update.isInserting = false;', s)
    const block = s >= 0 && e > s ? um.slice(s, e) : ''
    check('AL DOM差し替え区間を特定できる', block.length > 100, `${block.length} 文字`)

    // コメント行は除く（⚠️の説明文に await などの語が入るため）
    const code = block.split('\n')
        .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) })
        .join('\n')
    check('AL 差し替え区間に await が無い', !/\bawait\b/.test(code),
        '入れると updateThumbnail の早期returnが到達可能になり、サムネが無言で止まる')
    check('AL 差し替え区間に直接の rAF / setTimeout / .then が無い',
        !/requestAnimationFrame|setTimeout|\.then\(/.test(code),
        'flipReorder の内部で使うのは可（reorderFn は同期）。ここに直接書くのは不可')

    // 到達したら黙って通さず警告すること
    const guard = um.slice(um.indexOf('if (this.appState.update.isInserting) {'),
        um.indexOf('if (this.appState.update.isInserting) {') + 500)
    check('AL 到達したら警告を出す（黙って「完了」と嘘をつかない）',
        /console\.warn/.test(guard),
        'この分岐は onComplete を呼ぶので、無警告だと原因に辿り着けない')
    check('AL 警告は1回だけ（毎サイクル出して埋もれさせない）', /_warnedInserting/.test(guard))

    // --- ここから: 「DOM を唯一の真実にしておいてよい」根拠を機械で守る（項目AO） ---
    //
    // 根拠は2つ。どちらかが崩れたら、DOM から毎周期作り直す方式は成り立たなくなる。
    //   (1) DOM を読んでから差し替えるまでが**同期**（間に await が無い）
    //       → 読んだ内容が古くなりようがないので、作り直しがゼロコストで常に正しい
    //   (2) カードの増減が**1箇所**しか無い
    //       → 「どこかで勝手に増減している」経路が存在しない
    const rs = um.indexOf('const existingMap = new Map();')
    const re2 = um.indexOf('this.appState.update.isInserting = false;', rs)
    const region = rs >= 0 && re2 > rs ? um.slice(rs, re2) : ''
    check('AO 読み取り〜差し替えの全区間を特定できる', region.length > 1000, `${region.length} 文字`)
    const regionCode = stripComments(region)
    check('AO 読み取り〜差し替えの全区間が同期（await が無い）', !/\bawait\b/.test(regionCode),
        'ここに await が入ると、読んだ DOM の内容が差し替え時点で古くなりうる')
    check('AO 同区間に直接の rAF / setTimeout / .then が無い',
        !/requestAnimationFrame|setTimeout|\.then\(/.test(regionCode))

    const mutations = []
    for (const f of await listSrcFiles()) {
        const t = stripComments(readFileSync(f, 'utf8'))
        for (const m of t.matchAll(/\.(replaceChildren|removeChild)\(|\.remove\(\)|\.innerHTML\s*=/g)) {
            mutations.push(`${f.split(/[\\/]/).pop()} ${m[0]}`)
        }
    }
    check('AO カードの増減点は container.replaceChildren の1箇所だけ', mutations.length === 1,
        mutations.length ? mutations.join(' , ') : '(0件＝差し替え自体が消えている。それも異常)')

    // --- AM: FLIP が空振りしない配線になっているか（静的側の網） ---
    const iFlip = um.indexOf('flipReorder(container')
    const iFrag = um.indexOf('createDocumentFragment')
    check('AM フラグメントの組み立ては flipReorder のコールバック内にある',
        iFlip >= 0 && iFrag > iFlip,
        iFrag >= 0 && iFrag < iFlip
            ? '外で組むと既存カードが container から抜けたあとに First を測ることになり、FLIP が毎回空振りする'
            : `flipReorder ${iFlip} / createDocumentFragment ${iFrag}`)
}

/** コメント行を落とす。⚠️の説明文に await などの語が入るため、これを忘れると嘘のNGが出る。 */
function stripComments(text) {
    return text.split('\n')
        .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) })
        .join('\n')
}

/** src/ 配下の .js を全部集める */
async function listSrcFiles() {
    const { readdirSync, statSync } = await import('fs')
    const { fileURLToPath } = await import('url')
    const root = fileURLToPath(new URL('../src/', import.meta.url)).replace(/[\\/]$/, '')
    const out = []
    const walkDir = (d) => {
        for (const name of readdirSync(d)) {
            const p = d + '/' + name
            if (statSync(p).isDirectory()) walkDir(p)
            else if (name.endsWith('.js')) out.push(p)
        }
    }
    walkDir(root)
    return out
}

/**
 * 描画経路そのものを、**本物の updateSidebar** で検証する。
 *
 * ここまでの検証は updateSidebar を丸ごとスタブに差し替えていた（周期・セッション・二重実行は
 * それで足りる）。だが差分更新・構造変化判定・削除検知・並べ替え・FLIP は一度も自動検証されて
 * おらず、実際にその穴から**FLIP が本番で一度も動いていない**という欠陥が漏れていた（項目AM）。
 *
 * 差し替えるのは globalThis.fetch と DOM だけ。それ以外は実コードが動く。
 */
async function render() {
    const { buildRenderHarness, wireUpdateManager, apiProgram } = await import('./render-harness.mjs')
    // ⚠️ 必ず**過去**の時刻を基準にすること。calculateActivePoint は
    //    `Math.max(1, Math.floor((now - beginAt) / 60000))` で経過分を出すので、未来時刻だと
    //    全番組が 1 に潰れて active-point が視聴者数だけの関数になり、人気順の検証が骨抜きになる。
    //    固定の未来エポックを書くと、その日付が来た瞬間に挙動が変わって間欠NGになる。
    const T = Date.now() - 600000
    const h = buildRenderHarness({ intervalSec: 60, programsSort: 'newest' })
    const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)

    // updateSidebar はセッションを開けたまま返す（閉じるのは呼び出し元の役目）。
    // 閉じないと 60 秒後にタイムアウト警告が出て出力が汚れるので、毎回ここで閉じる。
    const run = async () => { const sid = await um.updateSidebar(); if (sid) loadingManager.finishSession(sid) }
    const ids = () => h.dom.ids()
    const transforms = () => h.dom.container.children.map((c) => c.style.transform || '')

    console.log('=== 描画経路（本物の updateSidebar をモックDOMで動かす）===')

    // --- 初回描画 ---
    h.state.followPrograms = [
        apiProgram({ id: 'lv100', beginAtMs: T + 3000 }),
        apiProgram({ id: 'lv200', beginAtMs: T + 2000 }),
        apiProgram({ id: 'lv300', beginAtMs: T + 1000 }),
    ]
    h.state.notifyRows = [{ id: 100, title: 'x' }]
    await run()
    check('初回描画: 放送開始が新しい順に並ぶ', ids().join(',') === '100,200,300', ids().join(','))
    check('初回描画: data-api-index が並び位置と一致',
        h.dom.container.children.map((c) => c.dataset.apiIndex).join(',') === '0,1,2')
    check('初回描画: タイトルと配信者名が入る',
        h.dom.container.children[0].querySelector('.program_title').textContent === '番組100' &&
        h.dom.container.children[0].querySelector('.provider_name').textContent === '配信者100')
    check('初回描画: 件数表示がカード数と一致',
        h.dom.getById('program_count').textContent === String(h.dom.container.children.length))
    check('初回描画では FLIP を出さない（比較対象が無いので動かしようがない）',
        transforms().every((t) => t === ''), transforms().join('|') || '(全て空)')

    // --- 変化なし ---
    const same = h.dom.container.children.slice()
    await run()
    check('変化なし: カードを作り直さない（同一オブジェクトのまま）',
        same.length === h.dom.container.children.length && same.every((el, i) => el === h.dom.container.children[i]))
    check('変化なし: 並べ替えもしない（FLIP が走らない）', transforms().every((t) => t === ''))

    // --- 新番組が先頭に入る（構造変化＋FLIP） ---
    // 🔴 これが項目AM の回帰テスト。フラグメントを flipReorder の外で組むと、
    //    既存カードが container から抜けたあとに First を測ることになり transform が空になる。
    const keep = h.dom.container.children.slice()
    h.state.followPrograms.unshift(apiProgram({ id: 'lv400', beginAtMs: T + 9000 }))
    await run()
    check('新番組: 先頭に入り既存は再利用される',
        ids().join(',') === '400,100,200,300' && keep.every((el) => h.dom.container.children.includes(el)),
        ids().join(','))
    check('AM 順位が下がった既存カードに FLIP の transform が入る',
        h.dom.container.children.slice(1).every((c) => /translate\(/.test(c.style.transform || '')),
        transforms().map((t, i) => `${ids()[i]}:${t || '空'}`).join(' '))
    check('AM 新規カードは動かさない（元位置が無いので）', (h.dom.container.children[0].style.transform || '') === '')

    // FLIP の後始末（rAF → transform 解除）が効くこと
    await sleep(30)
    check('AM FLIP は次フレームで transform を外す（Play フェーズ）',
        transforms().every((t) => t === ''), transforms().join('|') || '(全て空)')

    // --- 削除 ---
    h.state.followPrograms = h.state.followPrograms.filter((p) => p.id !== 'lv200')
    h.state.notifyRows = []
    await run()
    check('削除: 終了した番組のカードが消える', ids().join(',') === '400,100,300', ids().join(','))
    check('削除: 件数表示がカード数と一致',
        h.dom.getById('program_count').textContent === String(h.dom.container.children.length))

    // --- 両API失敗 ---
    const beforeFail = ids().join(',')
    h.state.followFails = true
    h.state.notifyFails = true
    await run()
    check('両API失敗: DOM を維持する（消さない）', ids().join(',') === beforeFail, ids().join(','))
    h.state.followFails = false
    h.state.notifyFails = false

    // --- 放送中0件 ---
    h.state.followPrograms = []
    h.state.notifyRows = []
    await run()
    check('放送中0件: カードは維持される（取得成功なので消さない設計）', ids().join(',') === beforeFail, ids().join(','))
    check('放送中0件: 件数表示は 0 になる（＝カード数と食い違う。現仕様。doc/09 項目AN）',
        h.dom.getById('program_count').textContent === '0')

    // --- notifybox だけ生きている（和集合） ---
    h.state.notifyRows = [{
        id: 777, title: '速報だけの番組', community_name: '速報の配信者', provider_type: 'community',
        thumbnail_url: 'https://secure-dcdn.cdn.nimg.jp/nicoaccount/usericon/5255/52553742.jpg?1673509950',
    }]
    await run()
    check('和集合: フォローAPIが0件でも notifybox の番組が出る', ids().includes('777'), ids().join(','))
    check('和集合: 詳細が無くてもタイトルは出る',
        h.dom.getById('777').querySelector('.program_title').textContent === '速報だけの番組')

    // --- 項目AT: フォローAPIが拾う前でも配信者名・アイコン・繋ぎ画像が出る（実描画経路） ---
    const card777 = h.dom.getById('777')
    check('AT 新着カードに配信者名が出る（"配信者名不明" で立たない）',
        card777.querySelector('.provider_name').textContent === '速報の配信者',
        `"${card777.querySelector('.provider_name').textContent}"`)
    const icon777 = card777.querySelector('.provider img')
    check('AT 新着カードに配信者アイコンが付く', !!icon777 && icon777.src.includes('usericon'),
        icon777 ? icon777.src : '(img が無い)')
    check('AT アイコンには投稿者ページへのリンクが張られる',
        (card777.querySelector('.provider a') || {}).href === 'https://www.nicovideo.jp/user/52553742',
        (card777.querySelector('.provider a') || {}).href)
    const img777 = card777.querySelector('.program_thumbnail_img')
    check('AT サムネ生成までの繋ぎはローディング画像ではなく配信者アイコン',
        img777.src.includes('usericon'), img777.src)
    check('AT 繋ぎ画像の戻り先(data-src)もアイコン（loading.gif に固定されない）',
        (img777.getAttribute('data-src') || '').includes('usericon'), img777.getAttribute('data-src'))
    check('AT 繋ぎ画像は thumbLive=0（動くサムネが最新コマとして混ぜない）',
        img777.dataset.thumbLive === '0', `thumbLive="${img777.dataset.thumbLive}"`)
    check('AT 視聴ページへのリンクは lv 付きで張られる',
        (card777.querySelector('.program_thumbnail a') || {}).href === 'https://live.nicovideo.jp/watch/lv777',
        (card777.querySelector('.program_thumbnail a') || {}).href)

    // 繋ぎで立てたカードに、後からフォローAPIの実データが乗るか（カードは作り直さない）
    h.state.followPrograms = [apiProgram({ id: 'lv777', beginAtMs: T + 4000, name: '正式な配信者名' })]
    await run()
    check('AT 繋ぎで立てたカードは作り直されない（動くサムネ・TTLの状態を保つ）',
        h.dom.getById('777') === card777)
    check('AT 後からフォローAPIの配信者名で上書きされる',
        card777.querySelector('.provider_name').textContent === '正式な配信者名',
        `"${card777.querySelector('.provider_name').textContent}"`)
    check('AT 繋ぎのアイコンだった data-src が実サムネURLに差し替わる',
        (img777.getAttribute('data-src') || '').includes('/screenshot/'), img777.getAttribute('data-src'))

    // --- channel のアイコン: フォローAPIは programProvider.icon を空で返す（socialGroup から拾う） ---
    h.state.notifyRows = []
    h.state.followPrograms = [apiProgram({ id: 'lv555', beginAtMs: T + 5000, providerType: 'channel', name: 'チャンネルX' })]
    await run()
    const card555 = h.dom.getById('555')
    check('channel カードに配信者名（チャンネル名）が出る',
        card555.querySelector('.provider_name').textContent === 'チャンネルX',
        `"${card555.querySelector('.provider_name').textContent}"`)
    const icon555 = card555.querySelector('.provider img')
    check('channel カードのアイコンを socialGroup.thumbnailUrl から拾う',
        !!icon555 && icon555.src.includes('channel-icon'), icon555 ? icon555.src : '(img が無い)')
    check('channel のアイコンリンクはチャンネルページ',
        (card555.querySelector('.provider a') || {}).href === 'https://ch.nicovideo.jp/ch555',
        (card555.querySelector('.provider a') || {}).href)
    check('channel のアイコン補完で詳細APIを呼んでいない（socialGroup で足りている）',
        h.state.calls.detail === 0, `詳細API ${h.state.calls.detail} 回`)

    // --- 固定画像運用の番組: flipped からスクショを回収し、詳細APIを呼ばずに済むか（項目AW・実描画経路） ---
    h.state.followPrograms = [apiProgram({ id: 'lv666', beginAtMs: T + 6000, fixedImage: true })]
    await run()
    const img666 = h.dom.getById('666').querySelector('.program_thumbnail_img')
    check('AW 固定画像の番組でもライブサムネが入る（flipped から回収）',
        (img666.src || '').includes('/screenshot/'), img666.src)
    check('AW そのために詳細APIを呼んでいない（リスト描画が補完待ちで遅れない）',
        h.state.calls.detail === 0, `詳細API ${h.state.calls.detail} 回`)

    // --- ソート切替 ---
    // ⚠️ 盛り上がりは「前回取得からの増分 ÷ 経過時間」なので、**手順の順番が結果を決める**。
    //    ①基準の値で1回取得 → ②時間を進める → ③伸びた値で取得、の順でないと増分が計上されない。
    //    「値を変えてから時間を進める」と、変化が Δt<1秒の回に飲まれて何も起きない（実際に踏んだ）。
    h.state.notifyRows = []
    h.state.followPrograms = [
        apiProgram({ id: 'lv100', beginAtMs: T + 3000, viewers: 1 }),
        apiProgram({ id: 'lv300', beginAtMs: T + 1000, viewers: 1 }),
        apiProgram({ id: 'lv400', beginAtMs: T + 9000, viewers: 1 }),
    ]
    await run()
    check('新着順: beginAt 降順', ids().join(',') === '400,100,300', ids().join(','))
    um.options.programsSort = 'active'
    h.ageStorage(60000)                       // ② 1分経ったことにする
    h.state.followPrograms = [                // ③ それぞれ違う伸び方をした
        apiProgram({ id: 'lv100', beginAtMs: T + 3000, viewers: 2 }),      // +1
        apiProgram({ id: 'lv300', beginAtMs: T + 1000, viewers: 99999 }),  // 爆伸び
        apiProgram({ id: 'lv400', beginAtMs: T + 9000, viewers: 50 }),     // そこそこ
    ]
    await run()
    check('人気順: 直近で伸びた順に並ぶ', ids().join(',') === '300,400,100', ids().join(','))
    um.options.programsSort = 'newest'

    // --- その場更新で後から埋まった情報が反映される（項目AK の実経路版） ---
    h.state.followPrograms = h.state.followPrograms.map((p) =>
        p.id === 'lv100' ? { ...p, title: '差し替え後タイトル', programProvider: { ...p.programProvider, name: '改名した配信者' } } : p)
    await run()
    check('AK その場更新でタイトルが反映される',
        h.dom.getById('100').querySelector('.program_title').textContent === '差し替え後タイトル')
    check('AK その場更新で配信者名が反映される',
        h.dom.getById('100').querySelector('.provider_name').textContent === '改名した配信者')

    check('詳細API(fetchProgramInfo)は呼ばれていない（前提が崩れていない）', h.state.calls.detail === 0,
        `notifybox ${h.state.calls.notify} / フォローAPI ${h.state.calls.follow} / 詳細 ${h.state.calls.detail}`)

    h.restore()
}

/**
 * 項目AS: 「番組の増減が無く、順位だけが入れ替わる周期」でも FLIP が効くこと。
 *
 * render() が確かめているのは「新番組が挿入された時」の経路。こちらは
 * `_sortOrderChanged` → structuralChange という**別経路**で、人気順の定期更新がこれに当たる。
 * ソート設定によって発火頻度が全く違うので、両モードを固定しておく。
 */
async function flipOnReorder() {
    const { buildRenderHarness, wireUpdateManager, apiProgram } = await import('./render-harness.mjs')
    const T = Date.now() - 600000
    const moved = (h) => h.dom.container.children.filter((c) => /translate\(/.test(c.style.transform || '')).length

    console.log('=== AS 番組の増減が無く順位だけ入れ替わる周期の FLIP ===')

    // --- 人気順: active-point が動くので順位が入れ替わる ---
    {
        const h = buildRenderHarness({ programsSort: 'active' })
        const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)
        const run = async () => { const s = await um.updateSidebar(); if (s) loadingManager.finishSession(s) }
        h.state.notifyRows = []
        const mk = (v100) => [
            apiProgram({ id: 'lv100', beginAtMs: T + 3000, viewers: v100 }),
            apiProgram({ id: 'lv200', beginAtMs: T + 2000, viewers: 200 }),
            apiProgram({ id: 'lv300', beginAtMs: T + 1000, viewers: 300 }),
        ]
        h.state.followPrograms = mk(100)
        await run()
        check('AS 前提: 人気順に並ぶ', h.dom.ids().join(',') === '300,200,100', h.dom.ids().join(','))
        const els = h.dom.container.children.slice()

        // ⚠️ 旧スコアは「経過時間で割る」形だったので、**数字が動かなくても時間が経つだけで**順位が
        //    入れ替わった（実測: 2分で70件中58件）。今のスコアは直近の増分レートなので、
        //    順位が動くのは**実際に伸びた時だけ**。時間だけ進めても動かない（下でそれも確かめる）。
        h.ageStorage(60000)                  // 1分経ったことにする（検証環境は実時間が進まない）
        h.state.followPrograms = mk(99999)   // 番組の増減は無し。lv100 だけ1分で +99899 → 1位へ
        await run()
        check('AS 人気順: 伸びた番組が上がる（順位が入れ替わる）', h.dom.ids().join(',') === '100,300,200', h.dom.ids().join(','))
        check('AS 人気順: 入れ替わった全カードに FLIP が入る', moved(h) === 3, `${moved(h)} / 3 枚`)
        check('AS 人気順: カードは作り直されない（動くサムネの状態が消えない）',
            els.every((e) => h.dom.container.children.includes(e)))
        await sleep(30)
        check('AS 人気順: 次フレームで transform が外れる', moved(h) === 0)

        await run()   // 何も変わらない周期
        check('AS 人気順: 順位が変わらない周期はアニメを出さない', moved(h) === 0, `${moved(h)} 枚`)
        h.restore()
    }

    // --- 新着順（既定）: data-api-index は beginAt 順なので、増減が無ければ順位も動かない ---
    {
        const h = buildRenderHarness({ programsSort: 'newest' })
        const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)
        const run = async () => { const s = await um.updateSidebar(); if (s) loadingManager.finishSession(s) }
        h.state.notifyRows = []
        h.state.followPrograms = [
            apiProgram({ id: 'lv100', beginAtMs: T + 3000, viewers: 1 }),
            apiProgram({ id: 'lv200', beginAtMs: T + 2000, viewers: 1 }),
        ]
        await run()
        h.state.followPrograms = [   // 視聴者数だけ激変させても新着順は動かない
            apiProgram({ id: 'lv100', beginAtMs: T + 3000, viewers: 1 }),
            apiProgram({ id: 'lv200', beginAtMs: T + 2000, viewers: 99999 }),
        ]
        await run()
        check('AS 新着順: 視聴者数が変わっても順位は動かない（＝アニメも出ない）',
            h.dom.ids().join(',') === '100,200' && moved(h) === 0, `${h.dom.ids().join(',')} / 動いた ${moved(h)} 枚`)

        h.state.followPrograms.unshift(apiProgram({ id: 'lv400', beginAtMs: T + 9000 }))
        await run()
        check('AS 新着順: 番組が増えた時はアニメが出る', h.dom.ids().join(',') === '400,100,200' && moved(h) === 2,
            `${h.dom.ids().join(',')} / 動いた ${moved(h)} 枚`)
        h.restore()
    }
}

/**
 * 項目AP: 遅れて着地した古い取得結果が、新しい描画を巻き戻さないこと。
 *
 * updateSidebar は3経路から呼ばれるが、AutoNext 経路（main.js）だけ _isUpdateInFlight() ガードが
 * 無いので、定期tickの取得中に別の updateSidebar が始まりうる。取得は「始めた時刻のスナップショット」
 * なので、遅い方が後から着地すると、その数秒間に始まった新番組を削除検知が「終わった番組」と
 * 誤判定して消す。
 */
async function raceRender() {
    const { buildRenderHarness, wireUpdateManager, apiProgram } = await import('./render-harness.mjs')
    const h = buildRenderHarness({})
    const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)
    // active-point が「放送開始からの経過分」を使うので、必ず**過去**の時刻にする。
    // 未来時刻だと Math.max(1, ...) に潰れて人気順の検証が骨抜きになる。
    const T = Date.now() - 600000

    // フォローAPI応答に遅延を足す。呼ばれた瞬間の一覧をスナップショットしてから遅延させる
    // ＝実物の「取得に数秒かかる間に世界が進む」の再現。
    const base = globalThis.fetch
    let latency = 0
    globalThis.fetch = async (url) => {
        if (!String(url).includes('/front/api/pages/follow/')) return base(url)
        const snap = h.state.followPrograms.slice()
        await sleep(latency)
        const saved = h.state.followPrograms
        h.state.followPrograms = snap
        try { return await base(url) } finally { h.state.followPrograms = saved }
    }

    const run = async () => { const s = await um.updateSidebar(); if (s) loadingManager.finishSession(s) }
    h.state.notifyRows = []
    h.state.followPrograms = [apiProgram({ id: 'lv100', beginAtMs: T + 2000 }), apiProgram({ id: 'lv200', beginAtMs: T + 1000 })]
    await run()

    console.log('=== AP 遅れて着地した古い取得が新しい描画を巻き戻さないか ===')
    check('AP 前提: 初期描画ができている', h.dom.ids().join(',') === '100,200', h.dom.ids().join(','))

    latency = 300
    const A = run()                       // 遅い方（lv400 を知らない）
    await sleep(40)
    h.state.followPrograms = [apiProgram({ id: 'lv400', beginAtMs: T + 9000 }), ...h.state.followPrograms]
    latency = 0
    const B = run()                       // 速い方（lv400 を知っている）
    await B
    const afterB = h.dom.ids().join(',')
    check('AP 後発の取得が新番組を描画する', afterB === '400,100,200', afterB)
    await A
    const afterA = h.dom.ids().join(',')
    check('AP 先発（古い）取得が着地しても新番組が消えない', afterA === '400,100,200',
        afterA === '100,200' ? '消えた＝世代チェックが効いていない' : afterA)
    check('AP 件数表示も巻き戻らない', h.dom.getById('program_count').textContent === '3',
        h.dom.getById('program_count').textContent)

    globalThis.fetch = base
    h.restore()
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
    await flippedThumb()
    console.log('')
    await newProgramThumb()
    console.log('')
    await momentumScore()
    console.log('')
    await momentumRanking()
    console.log('')
    await r1NoSpin()
    console.log('')
    await r7()
    console.log('')
    await r4()
    console.log('')
    await r5()
    console.log('')
    await flip()
    console.log('')
    await crossTab()
    console.log('')
    await inPlaceUpdate()
    console.log('')
    await syncRender()
    console.log('')
    // 最後に置く。モックDOMを globalThis へ差し込むので、他のグループの最小スタブと混ぜない。
    await render()
    console.log('')
    await flipOnReorder()
    console.log('')
    await raceRender()
}

console.log(`\n${failures === 0 ? '全項目 合格' : `${failures} 項目が不合格`}`)
process.exit(failures === 0 ? 0 : 1)
