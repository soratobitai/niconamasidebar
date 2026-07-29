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
}

console.log(`\n${failures === 0 ? '全項目 合格' : `${failures} 項目が不合格`}`)
process.exit(failures === 0 ? 0 : 1)
