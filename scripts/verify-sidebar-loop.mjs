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
    // 🔴 `id` を消さないこと。本物の content script では必ず入っており、**これが undefined になる＝
    // 拡張が無効化された合図**として各ループが自分を止める（項目BK）。スタブに無いと全ループが
    // 「無効化された」と判断して即死し、周期・描画まわりの項目が丸ごと落ちる。
    runtime: { id: 'test-extension-id', getURL: (p) => 'chrome-extension://test/' + p },
    storage: { local: { get: () => {}, set: () => {} }, onChanged: { addListener: () => {} } },
}
/** 本物の要素の style の代わり。書かれた値を持っておくだけ。 */
const mockStyle = () => ({ _props: {}, setProperty(k, v) { this._props[k] = v }, removeProperty(k) { delete this._props[k] }, getPropertyValue(k) { return this._props[k] ?? "" } })

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

/**
 * BK: 拡張が無効化されたら、取り残されたループが自分で止まること。
 *
 * 【なぜ要るか】拡張を再読み込み/更新/無効化しても、注入済みの content script は動き続ける。
 * 検知が無かった頃は**ニコ生への取得が延々と続いていた**（実測 2026-08-02: 無効化後60秒で
 * サムネ+9回・別の回で follow+1 / notifybox+1）。doc/09 項目BK。
 *
 * 【落とし穴】「止まった」だけを見る検査は、**常に止まる実装でも通ってしまう**（空振り）。
 * 先に「生きている間は回り続ける」を同じ土台で確かめてから、無効化して止まることを見る。
 * さらに **finally の張り直しを通っていないこと**（＝内部タイマーが残っていないこと）まで見る。
 * try の中で return すると finally が次を張るので、止めたつもりで生き残る。
 */
async function invalidated() {
    const realChrome = globalThis.chrome
    try {
        // --- ① 生きている間は回る（この土台で本当に取得が起きることの確認＝空振り防止） ---
        const { um, marks } = build(1, 100)
        um.startSidebarLoop()
        await sleep(5200) // 周期は約2秒（間隔1s＋最低表示1s）。2周期は確実に入る長さを取る
        const alive = marks.length
        check('BK 前提: 拡張が生きている間はリスト取得が回る', alive >= 2, `${alive} 回`)

        // --- ② 無効化する（本物と同じく chrome.runtime.id が消える） ---
        globalThis.chrome = { ...realChrome, runtime: { ...realChrome.runtime, id: undefined } }
        const atInvalidate = marks.length
        await sleep(5200) // 生きていれば2回は回る長さ。ここで0回なら本当に止まっている
        const after = marks.length - atInvalidate
        check('BK 🔴 無効化した後はリスト取得が1回も起きない', after === 0, `無効化後 ${after} 回`)

        // --- ③ 内部タイマーが残っていない（finally の張り直しを通っていない） ---
        check('BK 次の目覚ましを張り直していない（止めたつもりで生き残らない）',
            um._sidebarLoopTimer === null, `_sidebarLoopTimer=${um._sidebarLoopTimer}`)

        // --- ④ 後始末フックが1回だけ走る（毎tick走ると cleanup が何度も動く） ---
        const { _resetExtensionAliveForTest, onExtensionInvalidated, checkExtensionAlive } =
            await import(`${SRC}utils/extensionAlive.js`)
        _resetExtensionAliveForTest()
        let fired = 0
        onExtensionInvalidated(() => { fired++ })
        checkExtensionAlive(); checkExtensionAlive(); checkExtensionAlive()
        check('BK 後始末フックは何度検知しても1回だけ', fired === 1, `${fired} 回`)

        // ⑤ 登録が1箇所だけであること。④は「1回の検知で複数回呼ばない」を見るが、
        //    **同じ後始末を2箇所で登録する**ミスは素通りする（実際に一度やった）。
        //    その場合 cleanup が2回走り、動くサムネの解放やモーダル操作が二重に動く。
        const { readFileSync } = await import('fs')
        const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
        const regs = (mainSrc.match(/^\s*onExtensionInvalidated\(/gm) || []).length
        check('BK 後始末の登録は1箇所だけ（二重登録で cleanup が2回走らない）', regs === 1, `${regs} 箇所`)
        // 登録はループを起こす前に済んでいること（検知は1回で打ち止め＝先に気付かれると永久に走らない）
        const regAt = mainSrc.search(/^\s*onExtensionInvalidated\(/m)
        const loopAt = mainSrc.indexOf('startSidebarLoop()')
        check('BK 後始末の登録がループ開始より前にある', regAt >= 0 && loopAt >= 0 && regAt < loopAt,
            `登録=${regAt} / ループ開始=${loopAt}`)

        um.destroySidebarLoop()
    } finally {
        globalThis.chrome = realChrome
        const { _resetExtensionAliveForTest } = await import(`${SRC}utils/extensionAlive.js`)
        _resetExtensionAliveForTest()
    }
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

    // --- BH: サイドバーを開いた時の更新が2回走らないこと ---
    //
    // rAF と setTimeout の2経路で更新を撃っている。裏タブで止まっていた rAF は
    // **タブを表に戻した時に遅れて実行される**ので、掛け金が無いとフォールバック完走後に
    // もう一度フル更新が走る（isPerformingManualUpdate は「同時」しか防げない）。
    //
    // ⚠️ **開くパスを固定幅で切り出さないこと**（コメントを足すと窓から押し出される）。
    //    関数名でアンカーし、次の `async function` までを見る。
    const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
    const openStart = mainSrc.indexOf('async function handleSidebarOpenStateChange')
    const openEnd = mainSrc.indexOf('\nasync function ', openStart + 1)
    const openBody = openStart >= 0
        ? mainSrc.slice(openStart, openEnd > openStart ? openEnd : mainSrc.indexOf('\nconst resetSidebarSchedule', openStart))
        : ''
    check('BH handleSidebarOpenStateChange を特定できる', openBody.length > 200, `${openBody.length} 文字`)
    // 「rAF と setTimeout の両方から撃つ」構造自体は維持されていること（＝裏タブでも更新が走る）
    check('BH 裏タブ用のフォールバックが残っている（rAF と setTimeout の両方から撃つ）',
        /requestAnimationFrame\(/.test(openBody) && /setTimeout\(/.test(openBody))
    // 🔴 呼び出し口は1つだけ。2経路がそれぞれ performManualUpdate() を直接呼ぶ形に戻すと落ちる。
    const calls = (openBody.match(/performManualUpdate\s*\(/g) || []).length
    check('BH 🔴 performManualUpdate の呼び出しは1箇所だけ（rAF とフォールバックの二重発火を防ぐ）',
        calls === 1, `${calls}箇所（2箇所なら掛け金が外れている＝タブ復帰時にフル更新が2回走る）`)
    // 正常系（裏タブで rAF が止まる）で警告を出さないこと。利用者が異常と誤解した実績がある。
    check('BH 裏タブのフォールバックで警告を出さない（正常系なので）',
        !/console\.(warn|error)/.test(openBody),
        '⚠️ requestAnimationFrameが実行されなかったため… は正常系。鳴らさない')
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
    // ⚠️ style を持たせること。本物の要素には必ずあり、setProgramContainerWidth が
    //    カードの拡縮倍率（--nns-card-scale）をここへ書く。無いと描画系の検査が丸ごと落ちる。
    const container = { id: 'liveProgramContainer', children: [], style: mockStyle(), contains: (el) => container.children.includes(el) }
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

    // ⚠️ ここには以前「初回の位相が分散している」という検査があったが、**機械的な位相分散は
    //    撤去した**（利用者判断・2026-08-01。doc/09 項目BD）。分散は「同時に取ると帯域を分け合って
    //    遅くなる」という誤った前提の細工で、実際の重さは相手の応答待ちなので重ねてよい。
    //    ズレは「各番組の取得が終わってから20秒」で自然に生まれる（上の周期の検査がそれを見ている）。
    //    初回は全員同じ期限になるのが**正しい姿**なので、分散を要求する検査は残さない。
    const firsts = [...per.values()].map((ts) => ts[0]).sort((a, b) => a - b)
    const spread = firsts.length > 1 ? firsts[firsts.length - 1] - firsts[0] : 0
    check('R-1 初回は全番組をまとめて取りにいく（機械的な位相分散はしない）', spread < cycleMs * 0.5,
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

        // フォローAPIが「絵はあるがライブスクショではない」番組として返す（＝チャンネル番組）。
        // ⚠️ **notifybox の行は残すこと**（lv555 はまだ放送中という設定なので）。空にすると
        //    項目BF の終了判定が働いて正しくカードが消え、この先のサムネ検証が空振りする。
        h.state.followPrograms = [apiProgram({ id: 'lv555', beginAtMs: T, providerType: 'channel', fixedImage: false, thumb: false })]
        h.state.followPrograms[0].listingThumbnail = fixedImageUrl('555')
        await run()
        check('AZ ① 静止サムネが data-src に入る', img.getAttribute('data-src') === fixedImageUrl('555'), img.getAttribute('data-src'))

        // サムネ更新ループが回れば表示される（項目BB で経路を2本にするまでは、ここが唯一の表示経路だった）。
        // 直接表示の経路が先に絵を出してしまうと syncStaticThumb の検証にならないので、繋ぎ画像へ戻して試す
        // （実際にも、読み込み失敗で handleThumbnailError が繋ぎ画像へ落とした後はこの状態になる）。
        img.src = 'https://icon/ch.jpg'
        await new Promise((resolve) => um.updateThumbnail(false, resolve))
        check('AZ ① 🔴 ライブサムネを持たない番組でも、サムネ更新ループが静止サムネを表示する',
            img.src === fixedImageUrl('555'), img.src)
        check('AZ ① 静止サムネは thumbLive=0（動くサムネが最新コマとして混ぜない）',
            img.dataset.thumbLive === '0', img.dataset.thumbLive)
        h.restore()
    }

    // --- ③ 動くサムネへの給餌が返ってこなくても、静止サムネの表示は止まらない ---
    {
        const sb = await import(new URL('../src/render/sidebar.js', import.meta.url).href)
        const { animIngestWaitMaxMs } = await import(new URL('../src/config/constants.js', import.meta.url).href)
        const h = buildRenderHarness({ programsSort: 'newest' })
        const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)
        const run = async () => { const s = await um.updateSidebar(); if (s) loadingManager.finishSession(s) }
        h.state.notifyRows = []
        h.state.followPrograms = [apiProgram({ id: 'lv888', beginAtMs: T })]
        await run()
        const img = h.dom.getById('888').querySelector('.program_thumbnail_img')
        img.src = 'https://old/thumb.jpg'   // 前の絵を表示中ということにする

        // 給餌フックが**永久に返らない**（IndexedDB が応答しない環境の再現）
        sb.setAnimThumbnailFeed({ isEnabled: () => true, ingest: () => new Promise(() => {}) })
        try {
            await new Promise((resolve) => um.updateThumbnail(true, resolve))
            await sleep(animIngestWaitMaxMs + 200)
            check('AZ ③ 🔴 給餌が返らなくても静止サムネは表示される（更新ボタンが効かない事故の防止）',
                img.src.includes('/screenshot/'), img.src)
        } finally {
            sb.setAnimThumbnailFeed(null)
            h.restore()
        }
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
 * BB: 表示経路の二重化と、新着の初回サムネを待たせないこと。
 *
 * 「更新ボタンでは出ないのにページ再読込では出る」という報告が3回続いた。原因は個別の穴ではなく
 * **構造**だった: ページ再読込は makeProgramElement が storage のURLを img.src へ直接入れて絵を出すが、
 * その場更新は img.src を触らない設計だったため、表示を変えられるのは**サムネ更新ループのプリロード
 * 経路ただ1本**しか無かった。その1本には crossOrigin・②給餌・TTL・バックオフ・期限表が直列に載って
 * いるので、どこか1つ滑れば必ずこの症状になる（項目AZ・BA はどちらもその1本の中の穴）。
 *
 * 加えて、本来の目的は「何も押さずに早く出ること」。新着カードの初回サムネ期限を基準間隔ぶん
 * 後ろへ倒していたため、notifybox 先行で立った新着は**アイコンのまま20〜40秒**放置されていた。
 */
async function twoDisplayPaths() {
    const { buildRenderHarness, wireUpdateManager, apiProgram, liveThumbUrl, fixedImageUrl } = await import('./render-harness.mjs')
    const { updateThumbnailInterval } = await import(new URL('../src/config/constants.js', import.meta.url).href)
    console.log('=== BB 表示経路の二重化と新着の初回サムネ ===')
    const T = Date.now() - 600000

    // --- ① サムネ更新ループを1度も回さずに、その場更新だけで絵が出るか ---
    {
        const h = buildRenderHarness({ programsSort: 'newest' })
        const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)
        const run = async () => { const s = await um.updateSidebar(); if (s) loadingManager.finishSession(s) }
        // notifybox だけが知っている段階（サムネURL未取得）＝繋ぎはアイコン
        h.state.followPrograms = []
        h.state.notifyRows = [{ id: 601, title: '新着', community_name: '配信者', thumbnail_url: 'https://icon/601.png', provider_type: 'community' }]
        await run()
        const img = h.dom.getById('601').querySelector('.program_thumbnail_img')
        check('BB ① 出はじめはアイコン', img.src === 'https://icon/601.png', img.src)
        check('BB ① 繋ぎ画像のカードは thumbLive=0（＝直接表示の対象になる印）',
            img.dataset.thumbLive === '0', String(img.dataset.thumbLive))

        // フォローAPIがライブサムネ付きで返す。**updateThumbnail は一度も呼ばない**
        // ⚠️ **notifybox の行は残すこと**（lv601 はまだ放送中）。空にすると項目BF の終了判定で
        //    カードが消え、この先のサムネ検証が空振りする。
        h.state.followPrograms = [apiProgram({ id: 'lv601', beginAtMs: T })]
        await run()
        check('BB ① 🔴 サムネ更新ループを回さなくても、その場更新が既知のURLを表示する',
            img.src === liveThumbUrl('601'), img.src)
        // ⚠️ この2つは「直接表示が起きたこと」を条件に入れること。単に !includes('cache=') /
        //    thumbLive==='0' だけを見ると、**機能を消してアイコンのままでも合格する**（空振り検査）。
        check('BB ① 直接表示は ?cache= を付けない（同一URLなら再代入されない＝無駄な再取得が出ない）',
            img.src.startsWith('https://dlive.nicovideo.jp/') && !img.src.includes('cache='), img.src)
        check('BB ① 直接表示した絵は thumbLive=0（②の最新コマのフリをさせない）',
            img.src === liveThumbUrl('601') && img.dataset.thumbLive === '0',
            `src=${img.src} thumbLive=${img.dataset.thumbLive}`)
        h.restore()
    }

    // --- ⑤ 既にライブサムネを表示中のカードを、直接表示が取り直さないこと ---
    // ページ再読込直後の正常なカードは thumbLive **未設定**（makeProgramElement は
    // 「ライブサムネではない」時だけ '0' を書く）。ここを `!== '1'` で判定すると、②が '1' を立てるまでの
    // 間、正常なカード全部が毎リスト周期で再代入対象になり **カードの数だけ無駄な再取得**が走る。
    {
        const h = buildRenderHarness({ programsSort: 'newest' })
        const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)
        const run = async () => { const s = await um.updateSidebar(); if (s) loadingManager.finishSession(s) }
        h.state.notifyRows = []
        h.state.followPrograms = [apiProgram({ id: 'lv603', beginAtMs: T })]
        await run()
        const img = h.dom.getById('603').querySelector('.program_thumbnail_img')
        const atBirth = img.src
        check('BB ⑤ 生成時からライブサムネを出しているカードは thumbLive 未設定（＝ライブ表示中の意味）',
            img.dataset.thumbLive === undefined && atBirth.includes('cache='), `thumbLive=${img.dataset.thumbLive} src=${atBirth}`)
        await run()
        check('BB ⑤ 🔴 表示中のライブサムネを直接表示が取り直さない（毎周期の無駄な再取得を作らない）',
            img.src === atBirth, `${atBirth} → ${img.src}`)
        h.restore()
    }

    // --- ⑥ 直接表示がバックオフを無視しない（項目BC） ---
    // 読み込みに失敗したURLは handleThumbnailError が繋ぎ画像へ落とすので、`img.src !== best` は
    // **毎周期成立してしまう**。バックオフを見ないと、壊れたURLをリスト更新のたびに叩き直すことになり、
    // 指数的な再試行間隔が意味を失う（実測: 利用者環境でチャンネル1件の静止サムネが失敗し err が増えていた）。
    {
        const h = buildRenderHarness({ programsSort: 'newest' })
        const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)
        const run = async () => { const s = await um.updateSidebar(); if (s) loadingManager.finishSession(s) }
        h.state.notifyRows = []
        h.state.followPrograms = [apiProgram({ id: 'lv604', beginAtMs: T, providerType: 'channel', thumb: false })]
        h.state.followPrograms[0].listingThumbnail = fixedImageUrl('604')
        await run()
        const img = h.dom.getById('604').querySelector('.program_thumbnail_img')
        // 失敗して繋ぎ画像へ落ちた直後（バックオフ中）を作る
        img.src = 'https://icon/604.png'
        img.dataset.thumbLive = '0'
        img.dataset.nextTryAt = String(Date.now() + 60000)
        await run()
        check('BB ⑥ 🔴 バックオフ中は直接表示も控える（壊れたURLを毎周期叩き直さない）',
            img.src === 'https://icon/604.png', img.src)
        // 期限が切れれば再挑戦する（復旧経路を塞いでいないこと）
        img.dataset.nextTryAt = String(Date.now() - 1)
        await run()
        check('BB ⑥ バックオフが明ければ直接表示が再挑戦する（復旧経路を塞がない）',
            img.src === fixedImageUrl('604'), img.src)
        h.restore()
    }

    // --- ⑦ 一斉取得は全部まとめて投げる（利用者判断・2026-08-01。項目BD） ---
    // 「同時に投げると帯域を分け合って遅くなる」という前提で本数を絞っていたが、実際の重さは
    // 回線ではなく相手の応答待ちで、重ねても問題ない。絞ると逆に「4本ずつ揃って着地」して
    // バラけなくなるので撤去した。
    {
        const h = buildRenderHarness({ programsSort: 'newest' })
        const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)
        const run = async () => { const s = await um.updateSidebar(); if (s) loadingManager.finishSession(s) }
        h.state.notifyRows = []
        h.state.followPrograms = Array.from({ length: 12 }, (_, i) => apiProgram({ id: `lv70${i}`, beginAtMs: T - i * 1000 }))
        await run()
        let live = 0
        const holders = []
        const RealImage = globalThis.Image
        globalThis.Image = class {
            constructor() { this.onload = null; this.onerror = null; this.crossOrigin = null; this._src = '' }
            get src() { return this._src }
            set src(v) { this._src = String(v); live++; holders.push(this) }
        }
        try {
            um.updateThumbnail(true, null)
            await sleep(120)
            check('BB ⑦ 🔴 一斉更新は本数を絞らずまとめて取りにいく（待ち行列を作らない）',
                live === 12, `${live} 本（対象12件）`)
        } finally {
            globalThis.Image = RealImage
            h.restore()
        }
    }

    // --- ② 既にライブサムネを出しているカードには触らない（項目AV を壊さない） ---
    {
        const h = buildRenderHarness({ programsSort: 'newest' })
        const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)
        const run = async () => { const s = await um.updateSidebar(); if (s) loadingManager.finishSession(s) }
        h.state.notifyRows = []
        h.state.followPrograms = [apiProgram({ id: 'lv602', beginAtMs: T })]
        await run()
        const img = h.dom.getById('602').querySelector('.program_thumbnail_img')
        // ②が返したコマを表示中の状態を作る（blob URL ＋ thumbLive=1）
        img.src = 'blob:frame-latest'
        img.dataset.thumbLive = '1'
        img.dataset.thumbSeq = '7'
        await run()
        check('BB ② 🔴 ライブサムネ表示中のカードは直接表示で上書きしない（表示中の絵＝コマ を守る）',
            img.src === 'blob:frame-latest', img.src)
        check('BB ② コマの通し番号も消さない', img.dataset.thumbSeq === '7', img.dataset.thumbSeq)
        h.restore()
    }

    // --- ③ 途中で増えた新着カードは、初回サムネ取得を待たされない ---
    {
        const h = buildRenderHarness({ programsSort: 'newest' })
        const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)
        const run = async () => { const s = await um.updateSidebar(); if (s) loadingManager.finishSession(s) }
        const cycleMs = updateThumbnailInterval * 1000
        h.state.notifyRows = []
        h.state.followPrograms = [apiProgram({ id: 'lv611', beginAtMs: T }), apiProgram({ id: 'lv612', beginAtMs: T - 1000 })]
        um.startThumbnailLoop()   // ここで初回の一斉配布が起きる
        await run()
        const d611 = um._thumbDueAt.get('611') - Date.now()
        const d612 = um._thumbDueAt.get('612') - Date.now()
        check('BB ④ 読み込み直後の一斉配布は1周期ぶん後ろへ倒す（force 一斉更新と衝突させない）',
            d611 > cycleMs * 0.9 && d612 > cycleMs * 0.9,
            `${(d611 / 1000).toFixed(1)}秒後 / ${(d612 / 1000).toFixed(1)}秒後（基準間隔 ${updateThumbnailInterval}秒）`)
        check('BB ④ 🔴 機械的な位相分散はしない（全員同じ期限。ズレは「取得完了＋20秒」で自然に生む）',
            Math.abs(d611 - d612) < 50, `2件の期限の差 ${Math.abs(d611 - d612)}ms`)

        // 放送が始まって新しい番組がリストに増える
        h.state.followPrograms.unshift(apiProgram({ id: 'lv613', beginAtMs: Date.now() }))
        await run()
        const newDue = um._thumbDueAt.get('613') - Date.now()
        check('BB ③ 🔴 途中で増えた新着は待たされない（他は未来の期限なので次の起床で真っ先に選ばれる）',
            newDue <= 50, `${(newDue / 1000).toFixed(1)}秒後`)

        // 手動更新（force 一斉更新）が動いている間は後ろへ倒す
        um.isPerformingManualUpdate = true
        h.state.followPrograms.unshift(apiProgram({ id: 'lv614', beginAtMs: Date.now() }))
        await run()
        const duringManual = um._thumbDueAt.get('614') - Date.now()
        um.isPerformingManualUpdate = false
        check('BB ④ 手動更新の一斉取得中は後ろへ倒す（同じ<img>に2本目の取得が走るのを避ける）',
            duringManual > cycleMs * 0.9, `${(duringManual / 1000).toFixed(1)}秒後`)
        um.destroyThumbnailLoop()
        h.restore()
    }
}

/**
 * BD: 番組数が増えても、各番組の更新間隔が伸びないこと。
 *
 * 🔴 **この検証が無かったせいで1年ぶんの遅延を見逃した。**
 * 常設ループ化（項目AE）の時に「ドリフトはタイマーの本数と無関係」と判断したが、その検証は
 * **4カード・作業0.2秒**（一周0.8秒＝間隔2秒に余裕で収まる）でしか行っていなかった。
 * 実際は1件の完了を `await` で待っていたため、
 *     一周の時間 ＝ 番組数 × 1件あたりの所要時間
 * となり、**収まらない件数になると各番組の間隔が黙って伸びる**。実測では18番組で一周60秒以上、
 * 新着カードは行列の最後尾で62秒待たされた（doc/09 項目BD）。
 *
 * ここでは「1件の取得が、間隔÷件数 より長くかかる」状況を作る。**直列に待つ実装なら必ず落ちる。**
 */
async function loopKeepsUpWithManyCards() {
    console.log('=== BD 番組数が増えても各番組の間隔が伸びないこと ===')
    const { buildRenderHarness, wireUpdateManager, apiProgram } = await import('./render-harness.mjs')
    const N = 10
    const cycleSec = 2          // 基準間隔2秒（短縮スケール）
    const fetchMs = 600         // 1件の取得に0.6秒 → 直列なら一周 10×0.6=6秒（間隔2秒を大きく超える）
    const T = Date.now() - 600000

    const h = buildRenderHarness({ programsSort: 'newest' })
    const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)
    um.options.updateThumbnailInterval = cycleSec
    h.state.notifyRows = []
    h.state.followPrograms = Array.from({ length: N }, (_, i) => apiProgram({ id: `lv80${i}`, beginAtMs: T - i * 1000 }))
    const s = await um.updateSidebar(); if (s) loadingManager.finishSession(s)

    // 画像の読み込みに fetchMs かかる状況を作る
    const RealImage = globalThis.Image
    globalThis.Image = class {
        constructor() { this.onload = null; this.onerror = null; this.crossOrigin = null; this._src = '' }
        get src() { return this._src }
        set src(v) { this._src = String(v); setTimeout(() => { if (this.onload) this.onload() }, fetchMs) }
    }
    // 番組ごとの更新時刻を記録する
    const hits = new Map()
    const origUpdate = um._updateOneThumbnailAndWait.bind(um)
    um._updateOneThumbnailAndWait = (id) => {
        if (!hits.has(id)) hits.set(id, [])
        hits.get(id).push(Date.now())
        return origUpdate(id)
    }
    try {
        um.startThumbnailLoop()
        // 初回配布は「1周期後」なので、そこから3周期ぶん観測する
        await sleep(cycleSec * 1000 * 4 + fetchMs * 2)
        um.destroyThumbnailLoop()

        const covered = Array.from(hits.keys()).length
        check('BD 前提: 観測中に全番組が少なくとも1回は更新される',
            covered === N, `${covered}/${N} 番組`)

        // 各番組の「連続する更新の間隔」を集め、その最大値を見る
        let worst = 0, worstId = ''
        for (const [id, times] of hits) {
            for (let i = 1; i < times.length; i++) {
                const gap = times[i] - times[i - 1]
                if (gap > worst) { worst = gap; worstId = id }
            }
        }
        const limit = cycleSec * 1000 + fetchMs * 2 + 400   // 間隔＋取得時間ぶんの余裕
        check('BD 🔴 番組数が増えても各番組の間隔が伸びない（直列に待つ実装なら必ず落ちる）',
            worst > 0 && worst <= limit,
            `最悪の間隔 ${(worst / 1000).toFixed(2)}秒（許容 ${(limit / 1000).toFixed(2)}秒 / 直列なら ${(N * fetchMs / 1000).toFixed(1)}秒級）id=${worstId}`)

        // 同じ番組を二重に走らせていないこと（飛行中の番組は選ばない）
        let dup = 0
        for (const times of hits.values()) {
            for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] < fetchMs * 0.8) dup++
        }
        check('BD 同じ番組の取得を重ねて走らせない（飛行中は選ばない）', dup === 0, `重なり ${dup} 回`)
    } finally {
        globalThis.Image = RealImage
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
    const { momentumTauMs, initialMomentumMinWindowMin } = await import(new URL('../src/config/constants.js', import.meta.url).href)
    const NOW = Date.now()
    const prog = (v, c, ageMin) => ({ viewers: v, comments: c, onAirTime: { beginAt: new Date(NOW - ageMin * 60000).toISOString() } })
    const near = (a, b) => Math.abs(a - b) < 1e-9

    // --- 立ち上げ ---
    // 弾幕補正(BE)が入る前は (100+20)/10分 = 12 ちょうどだった。コメントに重みが乗ったので
    // **コメントを含む番組でぴったりの数値を書かない**（定数を変えるたびに嘘のNGが出る）。
    // 「開始からの平均レート」であること自体は、重みが確実に1になるコメント0の番組で厳密に見る。
    check('AY 初回は開始からの平均レート', near(initialMomentum(prog(120, 0, 10), NOW), 12), '120/10分 = 12')
    // コメントは足されるが、来場者より軽い（2026-08-01 に 1:1 から変更・項目BE-2）。
    // 🔴 **両側から挟む。** 上限だけだと「コメントを完全に捨てても合格」、
    //    下限だけだと「1:1 に戻しても合格」になる。
    check('AY 初回にコメントも足される。ただし来場者より軽い（1:1 に戻しても、捨てても落ちる）',
        initialMomentum(prog(100, 20, 10), NOW) > 10 && initialMomentum(prog(100, 20, 10), NOW) < 12,
        `(100 + w×20)/10分 = ${initialMomentum(prog(100, 20, 10), NOW).toFixed(3)}`
        + '（コメントを捨てれば 10.0 ／ 1:1 なら 12.0）')
    check('AY 開始時刻が不明でも落ちない', Number.isFinite(initialMomentum({ viewers: 3, comments: 0 }, NOW)))

    // --- BG: 初回スコアの分母には下限がある（入室ラッシュが勢いに化けるのを防ぐ） ---
    // 🔴 **効くのは初回の1点だけ。** 落ち着いた後の順位には影響しない（下の「下限を超えた番組」で固定）。
    const W = initialMomentumMinWindowMin
    // ⚠️ **期待値を `120 / W` と書かないこと。** 定数そのものと比較する形になり、W を何に変えても
    //    通る＝空振り検査になる（**実際に一度そう書いて、下限を1へ戻しても落ちなかった**）。
    //    ここは「1分で割った生の値の半分以下であること」という**定数から独立した絶対値**で見る。
    check('BG 🔴 開始直後の入室ラッシュをそのまま勢いにしない（下限を1分に戻すと落ちる）',
        initialMomentum(prog(120, 0, 0), NOW) <= 60 && initialMomentum(prog(120, 0, 0), NOW) > 0,
        `開始0分・累計120人 → ${initialMomentum(prog(120, 0, 0), NOW).toFixed(1)}/分`
        + `（下限1分なら120。現在の下限は${W}分）`)
    check('BG 🔴 下限を超えた番組は素通し（＝落ち着いた後の順位を動かさない）',
        near(initialMomentum(prog(120, 0, 10), NOW), 12), '開始10分・累計120人 → 12/分')
    check('BG 下限の内と外で値が跳ばない（連続）',
        near(initialMomentum(prog(120, 0, W), NOW), initialMomentum(prog(120, 0, W - 1e-9), NOW)))
    check('BG 🔴 新着は「落ち着き先より上」から入る（下から登らせる補正にはしない）',
        initialMomentum(prog(200, 0, 1), NOW) > 20,
        `開始1分・累計200人（＝定常20/分の番組の入室ラッシュ）→ ${initialMomentum(prog(200, 0, 1), NOW).toFixed(0)}/分`
        + ' ※落ち着き先の20より上から入ること。利用者の好み（項目BG）')
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

    // --- 同点時の第2キー ---
    // 🔴 **2026-08-04 に `data-total`（累計エンゲージメント）から `data-begin-at` へ変えた。**
    //    累計はコメントを含むので Kick では常に 0 になり、統合表示で Kick が必ず沈む（項目BL-5）。
    //    ここが `data-total` に戻ったら、その回帰を意味する。
    const el = (ap, beginAt) => ({ getAttribute: (k) => (k === 'active-point' ? ap : k === 'data-begin-at' ? beginAt : null) })
    check('AY 推定同接が違えば推定同接が優先',
        [el('1', '9999'), el('5', '1')].sort(compareByActivePoint)[0].getAttribute('active-point') === '5')
    check('AY 同点なら放送開始が新しい順',
        [el('0', '1000'), el('0', '5000')].sort(compareByActivePoint)[0].getAttribute('data-begin-at') === '5000')
    check('AY 第2キーに data-total を使っていない',
        [
            { getAttribute: (k) => (k === 'active-point' ? '0' : k === 'data-total' ? '50' : k === 'data-begin-at' ? '1000' : null) },
            { getAttribute: (k) => (k === 'active-point' ? '0' : k === 'data-total' ? '5' : k === 'data-begin-at' ? '5000' : null) },
        ].sort(compareByActivePoint)[0].getAttribute('data-total') === '5',
        '累計が少ない方でも、開始が新しければ上に来る')
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
    // 🔴 **絶対値で判定しないこと。** 2026-08-04 に active-point の中身が
    //    「勢い（人/分）」から「推定同接（人）＝到着レート×min(W,経過分)」へ変わった。
    //    W は設定で動くので、167 や 150 のような固定値を書くと目盛りを変えるたびに落ちる。
    //    **初期値（開始からの平均で立ち上がった値）との比**で見れば、W が変わっても意味が保たれる。
    const base900 = ap('900'); const base901 = ap('901')
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
                ap('900') < base900 && ap('901') > base901,
                `lv900 ${ap('900').toFixed(1)}（初期${base900.toFixed(1)}から下降中）`
                + ` / lv901 ${ap('901').toFixed(1)}（初期${base901.toFixed(1)}から上昇中）`)
        }
    }
    check('AY 🔴 長時間放送より、いま伸びている番組が上に来る', ids() === '901,900', ids())
    // 3周期後は「初期値(167 / 10)」から「実レート(10 / 300)」の側へ十分寄っているはず。
    // ぴったりの値ではなく“どちらの側に居るか”で見る（時定数を変えても意味が壊れないように）。
    check('AY 🔴 スコアが「開始からの平均」ではなく「直近の勢い」に寄る',
        ap('901') > ap('900') && ap('900') < base900 * 0.6 && ap('901') > base901 * 3,
        `3周期後: lv901=${ap('901').toFixed(1)}（初期${base901.toFixed(1)}の3倍超へ）`
        + ` / lv900=${ap('900').toFixed(1)}（初期${base900.toFixed(1)}の6割未満へ）`
        + ' ※旧スコア（開始からの平均）なら、どちらも初期値のまま動かず逆転しない')
    check('AY 第2キー data-begin-at が両方のカードに入っている',
        Number.isFinite(parseFloat(h.dom.getById('900').getAttribute('data-begin-at')))
        && Number.isFinite(parseFloat(h.dom.getById('901').getAttribute('data-begin-at'))),
        `lv900=${h.dom.getById('900').getAttribute('data-begin-at')} / lv901=${h.dom.getById('901').getAttribute('data-begin-at')}`)
    // data-total は順位に使っていないが、弾幕補正の効き方を実機で見るための覗き窓として残っている。
    check('AY 覗き窓の data-total も引き続き書かれている',
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
 * BE: 弾幕補正の「形」を固定する。
 *
 * 🔴 **ここで守りたいのは値そのものではなく性質。** 定数（半減比・鋭さ・下駄）は実機で
 * 数日かけて詰める前提の暫定値なので、**定数を動かしても落ちない検証**でなければ意味が無い。
 * 固定するのは「連続・単調・ゼロにならない・普通の番組を触らない」の4つ。
 */
async function commentWeightShape() {
    console.log('=== BE 弾幕補正（コメントの重み）の形 ===')
    const { commentWeight, commentRatio, totalEngagement, nextMomentum, initialMomentum } =
        await import(new URL('../src/utils/momentum.js', import.meta.url).href)
    const { commentWeightHalfRatio, commentWeightViewerFloor } =
        await import(new URL('../src/config/constants.js', import.meta.url).href)
    const NOW = Date.now()
    const p = (v, c) => ({ viewers: v, comments: c })

    check('BE 空の番組でも落ちない',
        Number.isFinite(commentWeight(p(0, 0))) && Number.isFinite(commentWeight(null)))
    check('BE 重みは常に 0 より大きく 1 以下',
        [p(0, 0), p(1000, 0), p(10, 1e9), p(0, 1)].every((x) => commentWeight(x) > 0 && commentWeight(x) <= 1))

    // 🔴 **来場者を重く見る（基礎重み）** — 2026-08-01 に 1:1 から変更。
    //    弾幕でない普通の番組でも、コメントは来場者より軽く扱われる。
    //    ⚠️ 期待値を commentBaseWeight から作らないこと（定数と比較する形＝空振りになる。項目BG）。
    check('BE-2 🔴 弾幕でない番組でもコメントは来場者より軽い（基礎重み。1:1 に戻すと落ちる）',
        commentWeight(p(10000, 5000)) < 0.8,
        `来場者1万・コメント5千（r=${commentRatio(p(10000, 5000)).toFixed(2)}＝弾幕ではない）`
        + ` → w=${commentWeight(p(10000, 5000)).toFixed(3)}（基礎重み1.0なら0.9超）`)

    // 🔴 **弾幕っぽさで差がつく（形）** — 利用者の実機報告: 1人あたり3〜4倍でも弾幕の可能性がある。
    //    半減点が10だった時は 0.85 対 0.95 で**差が1割しかなく、順位がほぼ動かなかった**。
    const susp = p(200, 700)     // 1人あたり約3.2倍（弾幕疑い）
    const modest = p(1000, 1500) // 1人あたり約1.5倍（本物）
    check('BE-2 🔴 1人あたり3倍の番組は1.5倍の番組より3割以上軽い（半減点10なら落ちる）',
        commentWeight(susp) < 0.7 * commentWeight(modest),
        `r=${commentRatio(susp).toFixed(1)}→w=${commentWeight(susp).toFixed(3)} /`
        + ` r=${commentRatio(modest).toFixed(1)}→w=${commentWeight(modest).toFixed(3)}`
        + ` （比=${(commentWeight(susp) / commentWeight(modest)).toFixed(2)}。半減点10なら0.90で差がつかない）`)

    check('BE 🔴 少人数が大量投稿する「弾幕」は強く効く（重み<0.1）',
        commentWeight(p(150, 30000)) < 0.1,
        `来場者150・コメント3万 → r=${commentRatio(p(150, 30000)).toFixed(1)} / w=${commentWeight(p(150, 30000)).toFixed(3)}`)
    // 下駄の役目は「データが少ないうちは弾幕扱いしない」。基礎重みは掛かるので絶対値では見ず、
    // **弾幕でない番組の重みと比べて遜色ないか**で見る（定数から独立させるため）。
    check('BE 若い番組は弾幕扱いされない（下駄で「疑わしきは罰せず」側へ寄る）',
        commentWeight(p(3, 15)) > 0.9 * commentWeight(p(10000, 10)),
        `来場者3・コメント15 → r=${commentRatio(p(3, 15)).toFixed(2)}（下駄${commentWeightViewerFloor}が無ければ r=5）`
        + ` / w=${commentWeight(p(3, 15)).toFixed(3)} 対 ほぼ無補正=${commentWeight(p(10000, 10)).toFixed(3)}`)

    // --- 形（定数を変えても成り立つ性質） ---
    // r を細かく掃いて、単調減少・連続・正であることを見る。**閾値方式ならここで落ちる。**
    let monotone = true, positive = true, maxJump = 0, prevW = commentWeight(p(0, 0))
    const STEPS = 4000, R_MAX = commentWeightHalfRatio * 40
    for (let i = 1; i <= STEPS; i++) {
        const r = (R_MAX * i) / STEPS
        // r = c / (v + floor) を満たす番組を作る（v=0 なら c = r * floor）
        const w = commentWeight(p(0, r * commentWeightViewerFloor))
        if (!(w < prevW)) monotone = false
        if (!(w > 0)) positive = false
        maxJump = Math.max(maxJump, prevW - w)
        prevW = w
    }
    check('BE 🔴 重みは r に対して単調に減る（増える区間が無い）', monotone)
    check('BE 🔴 重みはゼロにならない（漸近するだけ＝コメントを完全には捨てない）',
        positive && commentWeight(p(0, 1e9)) > 0,
        `r=5000万でも w=${commentWeight(p(0, 1e9)).toExponential(2)}`)
    check('BE 🔴 連続でなだらか（隣接する r で重みが跳ばない＝判定・閾値が無い）',
        maxJump < 0.01,
        `r を ${R_MAX} まで ${STEPS} 分割して掃いた時の最大の落差 = ${maxJump.toFixed(5)}`)

    // --- 勢いの計算に効いているか ---
    const dt = 60000
    const prevRec = (v, c) => ({ viewers: v, comments: c, momentum: 0, _fetchedAt: NOW - dt })
    const withAge = (v, c, min) => ({ ...p(v, c), onAirTime: { beginAt: new Date(NOW - min * 60000).toISOString() } })
    // 来場者の増分は素通し、コメントの増分だけが重みを受ける
    const real = nextMomentum(prevRec(10000, 20000), p(10200, 20600), NOW)
    const danmaku = nextMomentum(prevRec(150, 30000), p(152, 31000), NOW)
    check('BE 🔴 増分が同規模でも、弾幕側は勢いに乗らない',
        danmaku < real / 10,
        `本物(+200来場,+600コメ)=${real.toFixed(2)} / 弾幕(+2来場,+1000コメ)=${danmaku.toFixed(2)}`
        + ' ※旧実装(1:1)なら 800 対 1002 で弾幕が勝つ')
    check('BE 初回（前回値なし）にも同じ補正が乗る',
        initialMomentum(withAge(150, 30000, 60), NOW) < initialMomentum(withAge(150, 3000, 60), NOW) * 2,
        'コメントが10倍でも勢いは10倍にならない')
    check('BE 第2キー（累計）にも同じ補正が乗る',
        totalEngagement(p(150, 30000)) < totalEngagement(p(10000, 0)),
        `弾幕の累計=${totalEngagement(p(150, 30000)).toFixed(1)} / 来場者1万コメント0の累計=${totalEngagement(p(10000, 0))}`)

    // --- 旧実装との一致条件（🔴 「置き換えても同じ」を口約束にしない） ---
    // コメントが増えず両方が減らない周期では、旧 `max(0, Δ合計)` と新 `max(0,Δ来場)+w·max(0,Δコメ)`
    // は一致する。**一致しないのは「片方だけ減った周期」だけ**で、そこは新のほうが正しい。
    const legacyEquiv = nextMomentum(prevRec(100, 0), p(160, 0), NOW)
    const a60 = 1 - Math.exp(-dt / 180000)
    check('BE コメントが増えない周期は旧実装と一致する', Math.abs(legacyEquiv - 60 * a60) < 1e-9)
    check('BE 🔴 片方だけ減った周期は旧実装と一致しない（新のほうが正しい）',
        nextMomentum(prevRec(100, 100), p(95, 110), NOW) > nextMomentum(prevRec(100, 100), p(95, 105), NOW),
        '来場者側の揺れ(-5)が実在するコメント(+10)を食い潰さない')
}

/**
 * BE(実描画経路): 弾幕番組が本物の人気番組より上に来ないか。
 *
 * **旧実装(1:1)ではこの検証は必ず落ちる**（弾幕のほうが増分合計で勝つ数字にしてある）。
 */
async function danmakuRanking() {
    const { buildRenderHarness, wireUpdateManager, apiProgram } = await import('./render-harness.mjs')
    console.log('=== BE 弾幕より本物の人気番組が上に来る（実描画経路） ===')
    const NOW = Date.now()
    const h = buildRenderHarness({ programsSort: 'active' })
    const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)
    const run = async () => { const s = await um.updateSidebar(); if (s) loadingManager.finishSession(s) }
    const ids = () => h.dom.ids().join(',')
    h.state.notifyRows = []

    // lv910 = 本物（来場者1万・コメント2万 → 1人あたり2件）。毎分 +200来場者 +600コメント
    // lv911 = 弾幕（来場者150・コメント3万 → 1人あたり176件）。毎分 +2来場者 +1000コメント
    // 増分の単純合計は 800 対 1002 で**弾幕が勝つ**。それでも本物が上に来ることを見る。
    let v910 = 10000, c910 = 20000, v911 = 150, c911 = 30000
    const feed = (cycle) => {
        h.state.followPrograms = [
            apiProgram({ id: 'lv910', beginAtMs: NOW - (60 + cycle) * 60000, viewers: v910, comments: c910 }),
            apiProgram({ id: 'lv911', beginAtMs: NOW - (60 + cycle) * 60000, viewers: v911, comments: c911 }),
        ]
    }
    feed(0)
    await run()
    for (let cycle = 1; cycle <= 4; cycle++) {
        h.ageStorage(60000)
        v910 += 200; c910 += 600
        v911 += 2; c911 += 1000
        feed(cycle)
        await run()
    }
    const ap = (id) => parseFloat(h.dom.getById(id).getAttribute('active-point'))
    check('BE 🔴 増分合計では弾幕が勝つ数字でも、本物の人気番組が上に来る',
        ids() === '910,911',
        `並び=${ids()} / 本物=${ap('910').toFixed(1)} 弾幕=${ap('911').toFixed(1)}`
        + '（旧実装1:1なら弾幕が上）')
    check('BE 覗き窓の属性が両方のカードに入っている（実機で定数を詰めるのに使う）',
        parseFloat(h.dom.getById('911').getAttribute('data-comment-ratio')) > 100
        && parseFloat(h.dom.getById('911').getAttribute('data-comment-weight')) < 0.1
        && parseFloat(h.dom.getById('910').getAttribute('data-comment-weight'))
           > 10 * parseFloat(h.dom.getById('911').getAttribute('data-comment-weight')),
        `弾幕 r=${h.dom.getById('911').getAttribute('data-comment-ratio')} w=${h.dom.getById('911').getAttribute('data-comment-weight')}`
        + ` / 本物 r=${h.dom.getById('910').getAttribute('data-comment-ratio')} w=${h.dom.getById('910').getAttribute('data-comment-weight')}`)
    h.restore()
}

/**
 * BF-2: 番組が終了したかを**詳細APIに聞いて確かめてから**外す。
 *
 * 🔴 **この機能の失敗は「放送中の番組が黙って消える」で、エラーが一切出ない。**
 * よって「消えること」より**「消えてはいけない時に消えないこと」**のほうを厚く固定する。
 *
 * 🔴 **件数で守ろうとして3回失敗した歴史がある**（2026-08-01〜02）。
 *   - 「要求数ぴったり／実績値ちょうどの応答は疑う」→ 5件の応答が素通りして事故が起きた
 *   - 「フォローAPIより少なければ怪しい」→ 終了検知が常に止まる
 *   - 「notifybox が返した範囲より古い番組は触らない」→ **いちばん古い番組が永久に消えない**
 * **不在から終了を導くのをやめた**のが今の形。ここでは「導いていないこと」を固定する。
 */
async function programEndConfirmation() {
    const { buildRenderHarness, wireUpdateManager, apiProgram } = await import('./render-harness.mjs')
    console.log('=== BF-2 番組終了は詳細APIに聞いて確かめる ===')
    const NOW = Date.now()
    const h = buildRenderHarness({ programsSort: 'newest' })
    const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)
    const run = async () => { const s = await um.updateSidebar(); if (s) loadingManager.finishSession(s) }
    const ids = () => h.dom.ids().join(',')
    const has = (n) => ids().split(',').includes(String(n))
    const prog = (n, ageMin) => apiProgram({ id: `lv${n}`, beginAtMs: NOW - ageMin * 60000 })
    const row = (n) => ({ id: String(n), title: `t${n}`, community_name: `c${n}`, thumbnail_url: '', provider_type: 'community' })

    // ① 3番組。フォローAPI・notifybox の両方に居る
    h.state.followPrograms = [prog(700, 30), prog(701, 20), prog(702, 10)]
    h.state.notifyRows = [row(702), row(701), row(700)]
    await run()
    check('BF-2 前提: 3番組が並ぶ', ids() === '702,701,700', ids())

    // ② notifybox から消え、詳細APIも「終了した」と答える → 外す。
    //    **フォローAPI はまだ返し続けている**（これが直したい状況）
    h.state.notifyRows = [row(702), row(700)]
    h.state.endedIds = new Set(['701'])
    await run()
    check('BF-2 🔴 詳細APIが ended と答えたら、フォローAPIがまだ返していても外す',
        ids() === '702,700', ids() + '（フォローAPIは3件返し続けている）')

    // ③ 🔴 **ここが今の設計の肝。** notifybox から消えても、詳細APIが「放送中」と答えるなら残す。
    //    旧実装は notifybox の不在だけで消していたので、この状況で放送中の番組が消えていた。
    h.state.notifyRows = [row(702)]           // 700 も notifybox から消える
    h.state.endedIds = new Set(['701'])       // が、700 は放送中のまま
    await run()
    check('BF-2 🔴 notifybox から消えても、詳細APIが on_air なら消さない',
        has(700), ids() + '（700 は notifybox に居ないが放送中）')

    // ④ 詳細APIが答えない周期（通信断・404）は消さない。**判断材料が無い時は消さない。**
    h.state.followPrograms = [prog(700, 30), prog(702, 10), prog(704, 5)]
    h.state.notifyRows = [row(702)]
    h.state.detailFails = true
    await run()
    check('BF-2 🔴 詳細APIが答えない周期は1件も消さない',
        has(700) && has(704), ids())
    h.state.detailFails = false

    // ⑤ notifybox の取得が失敗した周期は、新たな疑いを立てない（通信断で全消しが最悪の壊れ方）。
    //    ⚠️ ただし**既に確認済みの番組は消えたまま**にする。ここで戻すと、notifybox が不安定な間
    //       「終わった番組が出たり消えたり」を繰り返す。
    h.state.followPrograms = [prog(700, 30), prog(701, 20), prog(702, 10)]
    h.state.notifyRows = [row(702), row(700)]
    h.state.endedIds = new Set(['701'])
    await run()
    check('BF-2 前提: 701 を終了として外している', !has(701), ids())
    h.state.notifyFails = true
    await run()
    check('BF-2 🔴 notifybox が失敗した周期は、新たに消さない（700 が生きている）', has(700), ids())
    check('BF-2 🔴 確認済みの番組は notifybox の失敗では戻らない', !has(701), ids())
    h.state.notifyFails = false

    // ⑥ 🔴 **いちばん古い番組が終了しても消えること。**
    //
    //    2026-08-02 に実コードで再現したバグの再発防止。旧実装の条件4は
    //    「notifybox が返した中でいちばん古い番組より古い番組は触らない」だったため、
    //    **いちばん古い番組が終わると基準がそれより新しい番組へ繰り上がり、自分が自動的に
    //    範囲の外になって永久に消えなかった**（長時間放送の番組ほど当たる）。
    //    真ん中の番組で試すと通ってしまうので、**必ずいちばん古い番組で試すこと。**
    h.state.followPrograms = [prog(810, 180), prog(811, 120), prog(812, 60)]
    h.state.notifyRows = [row(812), row(811), row(810)]
    h.state.endedIds = new Set()
    await run()
    check('BF-2⑥ 前提: 3番組（810 がいちばん古い）', ids() === '812,811,810', ids())
    h.state.notifyRows = [row(812), row(811)]
    h.state.endedIds = new Set(['810'])
    await run()
    check('BF-2⑥ 🔴 いちばん古い番組が終了しても消える（範囲の外に逃げないこと）',
        !has(810), ids() + '（810 は3時間前開始でいちばん古い）')

    // ⑦ 🔴 **2026-08-01 の事故の再現。** notifybox が rows を無視して新しい順に5件しか返さない。
    //    旧実装は「返らなかった＝終了」と推測したので放送中の番組が大量に消えた。
    //    今は**全部に問い合わせて on_air が返る**ので、1件も消えない。
    //    ⚠️ 件数で守っていないことの証明でもある。5件は要求数にも実績値にも一致しない。
    const many = []
    const manyRows = []
    for (let i = 0; i < 21; i++) {
        many.push(prog(9000 + i, 200 - i * 5)) // 古い順に並ぶ（9000 がいちばん古い）
        manyRows.push(row(9000 + i))
    }
    h.state.followPrograms = many
    h.state.notifyRows = manyRows.slice().reverse() // notifybox は新しい順
    h.state.endedIds = new Set()
    await run()
    check('BF-2⑦ 前提: 21番組が並ぶ', ids().split(',').length === 21, `${ids().split(',').length}件`)
    // notifybox が新しい順に5件しか返さなくなる（rows が黙って無視された時の形）
    h.state.notifyRows = manyRows.slice().reverse().slice(0, 5)
    await run()
    check('BF-2⑦ 🔴 notifybox が5件しか返さなくても、放送中の番組は1件も消えない',
        ids().split(',').length === 21, `${ids().split(',').length}件 / ${ids()}`)
    // その状態で1件だけ本当に終了したら、その1件だけ消える
    h.state.endedIds = new Set(['9000']) // いちばん古い番組
    await run()
    check('BF-2⑦ 🔴 5件しか返らない状態でも、本当に終了した番組は消える',
        !has(9000) && ids().split(',').length === 20, `${ids().split(',').length}件`)

    // ⑧ 応答が空の周期でも、確認して初めて消える（空応答での全消しが最悪の壊れ方）
    h.state.followPrograms = [prog(820, 60), prog(821, 30)]
    h.state.notifyRows = [row(820), row(821)]
    h.state.endedIds = new Set()
    await run()
    check('BF-2⑧ 前提: 2番組が並ぶ', ids().split(',').length === 2, ids())
    h.state.notifyRows = []
    await run()
    check('BF-2⑧ 🔴 notifybox が空でも、詳細APIが on_air なら全部残る',
        has(820) && has(821), ids())

    // ⑨ 1周期の問い合わせ数に上限があること（notifybox が壊れた時の暴走止め）。
    //    上限を超えた分は次の周期に回るだけで、消えることはない。
    const { endCheckMaxPerCycle } = await import(new URL('../src/config/constants.js', import.meta.url).href)
    const lots = [], lotsRows = []
    for (let i = 0; i < endCheckMaxPerCycle + 10; i++) {
        lots.push(prog(8500 + i, 200 - i))
        lotsRows.push(row(8500 + i))
    }
    h.state.followPrograms = lots
    h.state.notifyRows = lotsRows.slice().reverse()
    h.state.endedIds = new Set()
    await run()
    h.state.notifyRows = []          // 全部が疑いになる
    h.state.calls.detail = 0
    await run()
    check(`BF-2⑨ 🔴 1周期の問い合わせは上限(${endCheckMaxPerCycle}件)まで`,
        h.state.calls.detail <= endCheckMaxPerCycle,
        `${h.state.calls.detail}件 問い合わせた（疑いは ${lots.length}件）`)
    check('BF-2⑨ 上限を超えても番組は消えない（次の周期に回るだけ）',
        ids().split(',').length === lots.length, `${ids().split(',').length}/${lots.length}件`)
    h.restore()
}

/**
 * BI-3: 番組終了の再検知で、リストを何度も取り直さないこと。
 *
 * 🔴 **終了ガイドが出ている間、検知は20秒ごとに再発火する。**
 * 毎回リストを取り直すと、**移動先が見つからないページで取得が止まらない**
 * （移動先が決まらないと `scheduled` が立たず、多重進入ガードにも掛からない）。
 * 実測（2026-08-02・DOM変異を45秒で900回発火）: 通常 6回/分・最悪 66回/分が延々と続いた。
 * 暴走ではない（回数は変異ではなく時間で決まる）が、常設ループの3倍が止まらない。
 *
 * ここでは実物の `observeProgramEnd` と `AutoNextManager` を動かし、
 * **時計を進めて**スロットルの窓を越えさせ、取り直しが1回だけであることを見る。
 * （実時間で待つと1項目に20秒かかるため、`Date.now` を差し替えて即座に進める）
 */
async function endedRecheckDoesNotRefetch() {
    console.log('=== BI-3 終了の再検知でリストを取り直し続けないこと ===')

    // --- 最小限の DOM/環境スタブ（この項目専用。他の項目の mock-dom とは別物）---
    const saved = {
        document: globalThis.document, location: globalThis.location,
        MutationObserver: globalThis.MutationObserver, now: Date.now,
        sessionStorage: globalThis.sessionStorage,
    }
    let mutationCallbacks = []
    globalThis.MutationObserver = class {
        constructor(cb) { this.cb = cb }
        observe() { mutationCallbacks.push(this.cb) }
        disconnect() { mutationCallbacks = mutationCallbacks.filter((c) => c !== this.cb) }
    }
    const fire = () => { for (const cb of mutationCallbacks.slice()) cb() }

    // 終了ガイドが出ている状態。中身は実装が見る2つ（announcement / next-action-area）を持たせる。
    let guidePresent = true
    const guideEl = {
        querySelector: (sel) => ((sel.includes('announcement') || sel.includes('next-action-area')) ? {} : null),
        querySelectorAll: () => [],
    }
    globalThis.document = {
        body: {},
        getElementById: () => null,
        querySelector: (sel) => ((String(sel).includes('program-end-guide') && guidePresent) ? guideEl : null),
        querySelectorAll: () => [],   // 移動先の候補は無い＝`scheduled` が立たない経路
        hidden: false,
    }
    globalThis.location = { href: 'https://live.nicovideo.jp/watch/lv1', pathname: '/watch/lv1' }
    globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }

    // 時計を差し替えてスロットルの窓（20秒）を跨がせる
    let clock = saved.now()
    Date.now = () => clock
    const advance = (ms) => { clock += ms }

    try {
        const { AutoNextManager } = await import(`${SRC}managers/AutoNextManager.js`)
        const appState = new AppState()
        const anm = new AutoNextManager(appState, {}, {})

        let refetches = 0
        anm.startWatcher(async () => { refetches++ })   // startWatcher 内で即時1回チェックされる

        // 変異を大量に起こしても、スロットルの窓の中では再検知しない
        for (let i = 0; i < 50; i++) fire()
        check('BI-3 前提: 終了を検知してリストを1回取り直す', refetches === 1, `${refetches} 回`)

        // 窓を越えさせて再検知させる。**ここで取り直してはいけない。**
        for (let round = 0; round < 5; round++) {
            advance(21000)
            fire()
            await new Promise((r) => setTimeout(r, 0)) // コールバックの await を進める
        }
        check('BI-3 🔴 2回目以降の再検知ではリストを取り直さない（20秒ごとの取得が止まらない形にしない）',
            refetches === 1, `窓を5回跨いで ${refetches} 回`)

        // ガイドが消えて再び出た＝別の番組が終わった。この時は取り直してよい（再武装）。
        guidePresent = false
        advance(21000)
        fire()
        guidePresent = true
        advance(21000)
        fire()
        await new Promise((r) => setTimeout(r, 0))
        check('BI-3 ガイドが消えて再び出たら、また取り直す（再武装が効いている）',
            refetches === 2, `${refetches} 回`)

        anm.stopWatcher()
    } finally {
        Date.now = saved.now
        globalThis.document = saved.document
        globalThis.location = saved.location
        globalThis.MutationObserver = saved.MutationObserver
        globalThis.sessionStorage = saved.sessionStorage
    }
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
 * BK: 固定画像の警告（鳴る罠）が、正常な応答で鳴らないこと。
 *
 * 【なぜ要るか】旧条件は「回収できた数が0なら鳴らす」だった。実測（2026-08-02・公開の recent 版で
 * user 70件）では固定画像19件のうち**2件は listingThumbnail 自体が包まれたスクショ**で、
 * その形の時 API は flippedListingThumbnail を返さない＝**回収するものが無いのが正常**。
 * リストにその形が1件しか無い回は必ず鳴っていた（利用者のコンソールで実際に発生）。
 *
 * 【空振り防止】「鳴らない」だけを並べると、罠を丸ごと消しても全部通る。
 * **鳴るべき2つの壊れ方（フィールド消失・形の変化）で実際に鳴ること**を同じ土台で確かめる。
 */
async function flippedTrap() {
    console.log('=== BK 固定画像の警告が誤報しない／壊れた時は鳴る ===')
    const SHOT = 'https://asset2.dlive.nicovideo.jp/915e/abc/screenshot/123/thumbnail-352x198/screenshot.jpg'
    const FIXED = 'https://listing-thumbnail.live.nicovideo.jp?image=prod-lv1/thumbnail_1.png&w=352&h=198'
    // 実測で「回収できない」に分類された形。listingThumbnail 自体が包まれたスクショで flipped は来ない
    const WRAPPED = 'https://listing-thumbnail.live.nicovideo.jp/?url=' + encodeURIComponent(SHOT)
    let seq = 0
    const prog = (extra) => ({
        id: `lv${++seq}`, title: 't', providerType: 'community', liveCycle: 'ON_AIR',
        programProvider: { id: String(seq), name: 'n' }, statistics: {}, beginAt: Date.now(), ...extra,
    })

    // 応答だけ差し替えて**本物の fetchFollowedProgramsViaPage** を走らせ、console.warn を拾う。
    // 罠は1回で打ち止めるモジュール変数なので、シナリオごとに import を作り直す。
    let tag = 0
    const warnsFor = async (programs) => {
        const realFetch = globalThis.fetch, realWarn = console.warn, realErr = console.error
        const warns = []
        console.warn = (...a) => warns.push(a.map((x) => (Array.isArray(x) ? x.join(',') : String(x))).join(' '))
        console.error = () => {} // 詳細API補完の失敗ログは本題ではないので伏せる
        globalThis.fetch = async (url) => String(url).includes('/front/api/pages/follow/v1/programs')
            ? { ok: true, status: 200, json: async () => ({ data: { programs, total: programs.length } }) }
            : { ok: false, status: 404, json: async () => ({}) }
        try {
            const mod = await import(new URL(`../src/services/followPageSource.js?trap=${++tag}`, import.meta.url).href)
            await mod.fetchFollowedProgramsViaPage()
        } finally {
            globalThis.fetch = realFetch; console.warn = realWarn; console.error = realErr
        }
        return warns.filter((w) => w.includes('[followApi]'))
    }

    // ① 利用者のコンソールで実際に鳴った形。これが本命の回帰テスト
    const one = await warnsFor([prog({ listingThumbnail: SHOT }), prog({ listingThumbnail: WRAPPED })])
    check('BK 🔴 包まれた固定画像が1件だけの回で鳴らない（利用者が踏んだ誤報）',
        one.length === 0, one[0] ? one[0].slice(0, 100) : '無言')

    // ② 今日の実データ相当（回収できる番組と、できない包まれた番組が混在）
    const mixed = await warnsFor([
        ...Array.from({ length: 5 }, () => prog({ listingThumbnail: FIXED, flippedListingThumbnail: SHOT })),
        ...Array.from({ length: 2 }, () => prog({ listingThumbnail: WRAPPED })),
        prog({ listingThumbnail: SHOT }),
    ])
    check('BK 回収できている回は無言（実測 17/19 が回収できる形）', mixed.length === 0,
        mixed[0] ? mixed[0].slice(0, 100) : '無言')

    // ③ 母数が少なく全部が包まれた形 → 偶然と区別できないので黙る
    const few = await warnsFor(Array.from({ length: 3 }, () => prog({ listingThumbnail: WRAPPED })))
    check('BK 母数が少ない回（3件）は黙る', few.length === 0, few[0] ? few[0].slice(0, 100) : '無言')

    // ④ 壊れ方その1: フィールドごと消えた（固定画像が10件あるのに誰も flipped を持たない）
    const gone = await warnsFor(Array.from({ length: 10 }, () => prog({ listingThumbnail: FIXED })))
    check('BK 🔴 flipped がフィールドごと消えたら鳴る', gone.length === 1,
        gone[0] ? gone[0].slice(0, 90) : '鳴らなかった')

    // ⑤ flipped が包まれた形で来る番組が1件だけ → これも偶然ありうるので黙る
    //    （doc/09 項目AW の実測 2026-07-31 では 22件中2件がこの形だった）
    const oneWrappedFlip = await warnsFor([
        prog({ listingThumbnail: FIXED, flippedListingThumbnail: WRAPPED }),
        prog({ listingThumbnail: SHOT }),
    ])
    check('BK flipped が包まれた形の番組が1件だけの回も黙る', oneWrappedFlip.length === 0,
        oneWrappedFlip[0] ? oneWrappedFlip[0].slice(0, 100) : '無言')

    // ⑥ 壊れ方その2: flipped は来るが全部が採用できない形になった（母数あり）
    const changed = await warnsFor(Array.from({ length: 3 }, () =>
        prog({ listingThumbnail: FIXED, flippedListingThumbnail: WRAPPED })))
    check('BK 🔴 flipped の形が変わったら鳴る', changed.length === 1,
        changed[0] ? changed[0].slice(0, 90) : '鳴らなかった')
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

    // ⚠️ style を持たせること。本物の要素には必ずあり、setProgramContainerWidth が
    //    カードの拡縮倍率（--nns-card-scale）をここへ書く。無いと描画系の検査が丸ごと落ちる。
    const container = { id: 'liveProgramContainer', children: [], style: mockStyle(), contains: (el) => container.children.includes(el) }
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
 * BJ-static: サムネのクロスフェード用レイヤーが番組リンクを塞いでいないこと。
 *
 * `.thumb_fade_layer` はサムネ枠を全面に覆う `<img>` で、ベースサムネは `<a>` の**中**にある。
 * `pointer-events: none` が抜けると**透明なまま常時**クリックを吸うので、番組カードが押せなくなる
 * （opacity:0 でもヒットテストには残る＝フェード中だけの問題ではない）。
 *
 * 実挙動は `verify:e2e`（項目BJ）が elementFromPoint で見ているが、そちらは約8分かかる。
 * 一番痛い1点だけはここで即座に落とせるようにしておく。
 */
async function fadeLayerStatic() {
    const { readFileSync } = await import('fs')
    const css = readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8')

    // ルール本体を切り出す（見つからない＝レイヤーごと消えた or 改名された、も検出したい）
    const at = css.indexOf('.thumb_fade_layer {')
    const rule = at >= 0 ? css.slice(at, css.indexOf('}', at)) : ''
    check('BJ-static .thumb_fade_layer のCSSルールがある', rule.length > 0,
        at >= 0 ? `${rule.length} 文字` : '⚠ ルールが見つからない（改名したなら本検査も直すこと）')
    check('BJ-static 🔴 覆いが pointer-events:none（番組リンクを塞がない）',
        /pointer-events\s*:\s*none/.test(rule),
        rule ? '' : '（ルールが取れていないので判定不能）')
    // 位置指定ありで z-index を持たない＝ベースサムネの上・動くサムネのオーバーレイ(z-index:1)の下。
    // z-index を足すと重なり順がDOM順や値に依存し、ホバーアニメを覆い隠しうる。
    check('BJ-static 覆いに z-index を足していない（動くサムネの下に留まる）',
        rule.length > 0 && !/z-index/.test(rule),
        /z-index/.test(rule) ? '⚠ z-index が入った。.anim_thumb_overlay(z-index:1) との上下を再確認すること' : '')

    // 逆向き（新しい絵を上でフェードイン→baseへ確定）へ作り替えられていないこと。
    // 確定処理が走らないと古い絵が残る＝更新が止まって見えるので、向きは設計上の要。
    const sb = readFileSync(new URL('../src/render/sidebar.js', import.meta.url), 'utf8')
    const fn = sb.slice(sb.indexOf('function crossfadeThumbnail'), sb.indexOf('\n}', sb.indexOf('function crossfadeThumbnail')))
    check('BJ-static 覆いに載せるのは「古い絵」・base へ入れるのが「新しい絵」',
        /layer\.src\s*=\s*prev/.test(fn) && /img\.src\s*=\s*next/.test(fn),
        fn.length ? '' : '⚠ crossfadeThumbnail を特定できなかった')
    check('BJ-static 覆いを外す蹴り出しタイマーがある（decode が返らなくても固まらない）',
        /setTimeout\(fadeOut/.test(fn))
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
            // style は素の {} にしないこと。本物は `setProperty` を持つので、
            // 実装が CSS 変数を書いた瞬間に落ちる（2026-08-07・カードの拡縮で実際に落ちた）。
            // dataset と同じ話で、実装の正否と無関係な NG が13件出た。
            className: cls || '', children: [], attrs: {}, style: mockStyle(),
            // 本物の要素は必ず dataset を持つ。省くと「実装が dataset を読んだ瞬間に落ちる」
            // 検証になり、実装の正否と無関係な NG が出る（doc/09 項目AR）。
            dataset: {},
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
    // 生成時にサムネURLが無かったカードは makeProgramElement が thumbLive='0' を書く。
    // ここを省くと「未設定＝ライブ表示中」と解釈され、実物と違う前提の検証になる。
    img.dataset.thumbLive = '0'
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
    // 🔴 かつては「表示中の画像(src)は触らない（差し替えはループの仕事）」だった。その結果、表示経路が
    // ループ1本しか無くなり「更新ボタンでは出ないがページ再読込では出る」を3回生んだ（項目BB）。
    check('AK まだ絵を出せていないカードには既知のURLを直接出す（項目BB で経路を2本にした）',
        img.attrs.src === 'https://dlive.nicovideo.jp/s.jpg', `src="${img.attrs.src || ''}"`)

    // 逆側: 既にライブサムネを出しているカードは直接表示で上書きしない（②のコマを守る）
    const shown = mkEl('program_thumbnail_img')
    shown.src = 'blob:frame'
    shown.dataset.thumbLive = '1'
    const card2 = mkEl('program_container')
    const thumb2 = mkEl('program_thumbnail'); thumb2.appendChild(shown); card2.appendChild(thumb2)
    sb.applyProgramInfoToCard(card2, {
        id: 'lv556', title: 't', providerType: 'user',
        contentOwner: {}, thumbnailUrl: 'https://dlive.nicovideo.jp/other.jpg',
        onAirTime: { beginAt: new Date().toISOString() },
    })
    check('AK ライブサムネ表示中のカードは直接表示で上書きしない', shown.src === 'blob:frame', shown.src)

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
/**
 * BM. 同じ番組が続いている間、カードの DOM 要素が**使い回されている**か。
 *
 * 既存カードを引き当てる鍵（Map のキー）と、カードの DOM id がずれると、
 * 引き当てに毎回失敗して**毎周期カードを作り直す**。作り直すと画像も読み直され、
 * リスト全体が一瞬チラつく。例外もログも出ず、見た目も一応正しいので気付けない。
 *
 * 2026-08-04 に kick.com ページで実際に発生。ニコ生の番組は `lv123` で来るのに
 * カードの DOM id は `123` なので、生の `data.id` で引いていた側が全滅していた
 * （35枚中23枚＝ニコ生の全件が毎周期「新規」）。
 *
 * 🔴 **数ではなく「同じオブジェクトか」で見ること。** 件数だけ数えても、作り直しは
 *    件数が変わらないので素通りする（この事故がまさにそれだった）。
 */
async function cardIdentity() {
    const { buildRenderHarness, wireUpdateManager, apiProgram } = await import('./render-harness.mjs')
    console.log('=== BM カードを毎周期作り直していないか ===')
    const T = Date.now() - 600000

    // --- 実挙動: 同じ番組で2周させて、要素が同一オブジェクトのままか ---
    {
        const h = buildRenderHarness({ programsSort: 'newest' })
        const { um, loadingManager } = wireUpdateManager({ AppState, LoadingManager, UpdateManager }, h)
        const run = async () => { const s = await um.updateSidebar(); if (s) loadingManager.finishSession(s) }
        h.state.notifyRows = []
        h.state.followPrograms = [
            apiProgram({ id: 'lv701', beginAtMs: T }),
            apiProgram({ id: 'lv702', beginAtMs: T - 1000 }),
        ]
        await run()
        const first = ['701', '702'].map((id) => h.dom.getById(id))
        check('BM カードが立っている（この検査自体が空振りしていない）',
            first.every(Boolean), first.map((e) => (e ? e.id : 'なし')).join(','))

        await run()
        const second = ['701', '702'].map((id) => h.dom.getById(id))
        const reused = first.every((el, i) => el && second[i] === el)
        check('BM 🔴 番組が変わらなければカードの要素は使い回される（作り直さない）',
            reused,
            reused ? '2周とも同一オブジェクト'
                : '作り直されている。引き当ての鍵とカードの DOM id がずれていないか（cardIdOf）')
        h.restore()
    }

    // --- 鍵の作り方が1箇所に閉じているか ---
    {
        const { readFileSync } = await import('fs')
        const sb = readFileSync(new URL('../src/render/sidebar.js', import.meta.url), 'utf8')
        check('BM カードidの正規化は sidebar.js の cardIdOf が唯一の定義',
            (sb.match(/export function cardIdOf\(/g) || []).length === 1)

        // 引き当ての鍵が cardIdOf 由来か。両ページとも「Map を作る」〜「Map を引く」の間に
        // cardIdOf の呼び出しが無ければ、生の id で引いている疑いがある。
        for (const [name, rel] of [['ニコ生', '../src/managers/UpdateManager.js'], ['kick.com', '../src/kickPage.js']]) {
            const t = stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'))
            const a = t.indexOf('existingMap = new Map(')
            const b = t.indexOf('existingMap.get(', a)
            const seg = a >= 0 && b > a ? t.slice(a, b) : ''
            check(`BM ${name}ページの引き当ての鍵は cardIdOf から作る`,
                seg.length > 0 && seg.includes('cardIdOf('),
                seg.length === 0 ? '引き当ての区間を特定できない（構造が変わった？）'
                    : '生の data.id で引くと lv 付きの番組を毎回取りこぼす')
        }
    }
}

/**
 * BN. ニコ生ページと kick.com ページで**同じ仕様**になっているか。
 *
 * サイドバーの中身は両ページで同一、というのが利用者の要求（2026-08-04）。
 * 同じことを2箇所に書くと片方だけ直して食い違うので、共有できるものは共有し、
 * 「共有されているか」を機械で見る。
 *
 * 実際に kick.com 側だけ抜けていたもの:
 *   更新ボタンのローディング / 境界線ドラッグでの幅変更 / 開いた時の矢印の向き /
 *   「自動で開く=ON」/ Esc で設定を閉じる / 取得失敗の案内表示
 */
async function bothPagesSameSpec() {
    const { readFileSync } = await import('fs')
    const rd = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')
    const kp = rd('kickPage.js')
    const kpc = stripComments(kp)
    const mn = stripComments(rd('main.js'))
    const lm = stripComments(rd('managers/LoadingManager.js'))
    const um = stripComments(rd('managers/UpdateManager.js'))
    const sb = rd('render/sidebar.js')
    console.log('=== BN 両ページで同じ仕様になっているか ===')

    // --- 更新ボタンのローディング表示 ---
    check('BN ローディング表示の実装は sidebar.js に1つだけ',
        (sb.match(/export function setReloadButtonLoading\(/g) || []).length === 1)
    // 🔴 実装が1つでも、他所が直接 class を触っていれば意味が無い。そちらも見る。
    const touchers = []
    for (const f of await listSrcFiles()) {
        const t = stripComments(readFileSync(f, 'utf8'))
        if (/classList\.(add|remove|toggle)\(\s*'loading'/.test(t)) touchers.push(f.split(/[\\/]/).pop())
    }
    check('BN ローディングの class を直接触るのは sidebar.js だけ',
        touchers.length === 1 && touchers[0] === 'sidebar.js', touchers.join(',') || 'なし')
    check('BN ニコ生ページはその実装を使う', /setReloadButtonLoading\(/.test(lm))
    check('BN kick.com ページはその実装を使う', /setReloadButtonLoading\(/.test(kpc))

    // 🔴 消灯は finally に置くこと。途中で throw した時に**スピナーが点きっぱなし**になり、
    //    多重防止のフラグも下りず、そのページでは更新が二度と通らなくなる。
    const iFinally = kpc.indexOf('} finally {')
    const iOff = kpc.indexOf('setReloadButtonLoading(false)')
    check('BN kick.com のスピナー消灯は finally の中（例外で点きっぱなしにしない）',
        iFinally >= 0 && iOff > iFinally, `finally ${iFinally} / 消灯 ${iOff}`)
    check('BN kick.com は多重実行を防ぐ', /if \(isRefreshing\) return/.test(kpc))
    check('BN 最低表示時間は両ページ共通の定数から取る',
        /minLoadingDurationMs/.test(kpc) && /minLoadingDurationMs/.test(mn),
        'ここが数値リテラルだと片方だけ変わる')

    // --- 「自動で開く」の解釈 ---
    check('BN 「自動で開く」の解釈は sidebar.js に1つだけ',
        (sb.match(/export function shouldOpenSidebarAtStart\(/g) || []).length === 1)
    for (const [name, t] of [['ニコ生', mn], ['kick.com', kpc]]) {
        check(`BN ${name}ページは「自動で開く」の共有実装を使う`,
            /shouldOpenSidebarAtStart\(/.test(t) && !/autoOpen == '1'/.test(t),
            '自前で条件を書くと、片方だけ「ON」が効かない状態になる')
    }

    // --- kick.com 側にだけ無かった配線 ---
    for (const [what, re, why] of [
        ['境界線ドラッグで幅を変えられる', /addEventListener\('pointerdown'/, 'ニコ生の enableSidebarLine 相当'],
        ['開くと矢印の向きが変わる', /sidebar_arrow_re/, 'ニコ生と同じクラスを使う'],
        ['開くと境界線がリサイズカーソルになる', /col_resize/, '掴めることに気付けない'],
        ['Esc で設定を閉じる', /'Escape'/, 'ニコ生ページと同じ'],
        ['取得できない時に案内を出す', /api_error/, 'ニコ生ページと同じ場所に出す'],
    ]) {
        check(`BN kick.com ${what}`, re.test(kpc), why)
    }

    // --- 取得失敗を「0件」と混同していないか ---
    // 🔴 これを混同すると、片方のAPIが一瞬落ちただけでそのサービスのカードが全部消え、
    //    次の周期で戻る＝リストが点滅する。
    check('BN kick.com はニコ生の取得失敗と0件を区別する',
        /ok: false, programs: \[\]/.test(kpc) && /ok: true, programs:/.test(kpc),
        '両方 [] を返すと「取れなかった」が「居なかった」になる')
    check('BN kick.com は取得できなかったサービスの前回結果を据え置く',
        /kickRes\.ok \? kickRes\.programs : lastKickPrograms/.test(kpc)
        && /nicoRes\.ok \? nicoRes\.programs : lastNicoPrograms/.test(kpc))
    // 🔴 取れなかった周期に空へ落とすと、Kick のカードが全部消えて次の周期で戻る＝点滅する。
    //    2026-08-07 まで**ニコ生ページ側だけ**が空に落としていた（kick.com 側は据え置き）。
    check('BN ニコ生ページも Kick の取得失敗で据え置く（点滅させない）',
        /kickResult\.programs\s*:\s*\(this\._kickPrograms \|\| \[\]\)/.test(um),
        '空に落とすと、一瞬の失敗のたびに Kick のカードが消えて戻る')
    check('BN kick.com は据え置いた値で保存を上書きしない',
        /if \(nicoRes\.ok && nicoPrograms\.length\) upsertProgramInfos/.test(kpc),
        '同じ値で上書きすると差分が 0 になり、盛り上がりが実際より低く出る')

    // --- document へ張るリスナーが積み上がらないか ---
    // kick.com は SPA でサイドバーごと差し込み直す。root の中のリスナーは一緒に消えるが、
    // document へ張ったものは残る。
    const docListeners = (kpc.match(/document\.addEventListener\(/g) || []).length
    check('BN kick.com が document へ張るリスナーには張り直しの歯止めがある',
        docListeners === 0 || /escKeyWired/.test(kpc),
        `document へ ${docListeners} 件。差し込み直しのたびに増えないこと`)
}

/**
 * 「セレクタ { 宣言 }」に割る。kickPage.css は入れ子（@media 等）を使っていない前提。
 * 使う側でルール数を確かめること（0件なら割れていない＝検査が空振りしている）。
 */
function cssRules(text) {
    const src = text.replace(/\/\*[\s\S]*?\*\//g, '')
    const out = []
    const re = /([^{}]+)\{([^{}]*)\}/g
    let m
    while ((m = re.exec(src))) out.push({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] })
    return out
}

/**
 * BO. kick.com のサイドバーは**1枚の箱として動く**か。
 *
 * 中身（#sidebar）と境目ライン（#sidebar_line）を別々にアニメーションさせると、
 * 開閉の 180ms のあいだにメインスレッドが詰まった時に**分離して見える**。
 * `transform` はコンポジタで進み、`left` はメインスレッドでしか進まないため。
 * 2026-08-07 まで実際にそうなっており、利用者の実機で「まれに分離する」として出た。
 *
 * 直し方は「動く要素を1つに減らす」。root だけを動かし、中身とラインはその箱に貼り付ける。
 * ここで守るのは **kickPage.css の中でアニメーションする要素が root と body だけ**という一点。
 */
async function kickSidebarMovesAsOnePiece() {
    const { readFileSync } = await import('fs')
    const css = readFileSync(new URL('../src/styles/kickPage.css', import.meta.url), 'utf8')
    const kpc = stripComments(readFileSync(new URL('../src/kickPage.js', import.meta.url), 'utf8'))
    console.log('=== BO kick.com のサイドバーが1枚で動くか ===')

    const rules = cssRules(css)
    // 🔴 空振り防止。割れていなければ以下の検査は全部「見つからないから合格」になる。
    check('BO kickPage.css をルールに割れている', rules.length >= 10, `${rules.length} 件`)

    // --- アニメーションする要素は root と body だけ ---
    const animated = rules
        .filter((r) => /transition\s*:/.test(r.body) && !/transition\s*:\s*none/.test(r.body))
        .map((r) => r.sel)
        .sort()
    // 期待値は**べた書き**。実装から作ると、実装が変わった時に一緒に動いて何も検査しなくなる。
    const want = ['#niconamasidebar-kick-root', 'body']
    check('BO 開閉でアニメーションするのは root とページ本体だけ',
        animated.length === want.length && animated.every((s, i) => s === want[i]),
        `実際: ${animated.join(' / ') || 'なし'}`)

    // --- 中身とラインを個別に動かしていないか ---
    const perPart = rules.filter((r) => /#sidebar(_line)?\b/.test(r.sel))
    check('BO 中身とラインを指すルールがある（空振りしていない）', perPart.length >= 3, `${perPart.length} 件`)
    for (const r of perPart) {
        check(`BO 個別に transform を持たない: ${r.sel}`,
            !/(^|[;{\s])transform\s*:/.test(r.body),
            'root と別に動くと、詰まった時に分離する')
        check(`BO 個別に位置のアニメを持たない: ${r.sel}`,
            !/transition\s*:/.test(r.body) || /transition\s*:\s*none/.test(r.body),
            'left / transform のどちらで動かしても、root と足並みが揃わない')
    }
    check('BO 開いた時に中身やラインを個別に動かすルールが無い',
        !rules.some((r) => /\.is-open/.test(r.sel) && /#sidebar/.test(r.sel)),
        '.is-open で動かしてよいのは root だけ')

    // --- 貼り付き方 ---
    const rootRule = rules.find((r) => r.sel === '#niconamasidebar-kick-root')
    check('BO root 自体が動く箱になっている',
        !!rootRule && /transform\s*:\s*translateX/.test(rootRule.body) && /position\s*:\s*fixed/.test(rootRule.body))
    check('BO 閉じている時にラインが切られない（root は overflow: visible）',
        !!rootRule && /overflow\s*:\s*visible/.test(rootRule.body),
        '切ると閉じた時にラインが消え、二度と開けなくなる')
    const lineRule = rules.find((r) => r.sel === '#niconamasidebar-kick-root #sidebar_line')
    check('BO ラインは root の右隣に貼り付く（left: 100%）',
        !!lineRule && /left\s*:\s*100%/.test(lineRule.body) && /position\s*:\s*absolute/.test(lineRule.body),
        'fixed のまま独立した座標を持つと、また分離する')

    // --- ハンドルとページ本体の間の余白 ---
    // ラインは [W, W+5]、その中の開閉ボタンは [W, W+20] に居る。W だけ寄せると被る。
    // 閉じている時もハンドルは残る（[0,5] と [0,20]）ので、0 にすると同じく被る。
    check('BO 余白の定数は constants.js に1つだけ',
        (readFileSync(new URL('../src/config/constants.js', import.meta.url), 'utf8')
            .match(/export const kickContentGap\s*=/g) || []).length === 1)
    // 🔴 開いていても閉じていても余白を足すこと。`kickContentGap` が三項の**外**に無いと、
    //    閉じた時に 0 になってハンドルがコンテンツに被る。
    check('BO 閉じていてもハンドルのぶんを空ける',
        /\(isOpen \? currentWidth\(\) : 0\) \+ kickContentGap/.test(kpc),
        '余白を三項の中に入れると、閉じた時に 0 になって被りが戻る')
    // 🔴 **書き方ではなく意図で縛ること。** 以前は `const want = isActive` という字面で
    //    見ており、条件を1つ足した（重ねる設定のとき外す）だけで落ちた。
    //    守りたいのは「**閉じただけでは外さない**」＝この条件が `isOpen` を見ないこと。
    const wantCond = (kpc.match(/const want = ([^\n]*)/) || [])[1] || ""
    check('BO ページの寄せを外すのは連携を切った時だけ（閉じただけでは外さない）',
        wantCond.includes('isActive') && !wantCond.includes('isOpen'),
        `条件: ${wantCond} / isOpen で分岐すると、閉じた瞬間にページが 100vw へ戻ってハンドルの下へ潜り込む`)

    // 🔴 **CSS 側で寄せ幅を計算し直さないこと。** JS が body に当てた数値を変数1本で受け取る。
    //    以前は CSS が `100vw - 幅 - 余白` と同じ計算をしており、開閉で式が変わった時点で
    //    2箇所を手で揃える約束が保てなくなった。
    // ⚠️ 「どこかに式があるか」では駄目。このルールは `width` と `max-width` の2つを書くので、
    //    片方だけ直っていても通ってしまう（実際に一度そうなった）。**両方を個別に見る。**
    const remap = rules.find((r) => /w-xvw/.test(r.sel))
    const EXPECT_W = 'calc(100vw - var(--nns-kick-reserved))'
    const declW = remap && (remap.body.match(/(?:^|;)\s*width\s*:\s*([^;!]+)/) || [])[1]
    const declMax = remap && (remap.body.match(/max-width\s*:\s*([^;!]+)/) || [])[1]
    check('BO 読み替えは JS が出した幅を引くだけ（width / max-width とも）',
        !!declW && !!declMax && declW.trim() === EXPECT_W && declMax.trim() === EXPECT_W,
        `width: ${declW} / max-width: ${declMax}。CSS で計算し直すと寄せ幅と食い違う`)
    check('BO その幅は JS が書き込んでいる',
        /setHostVar\('--nns-kick-reserved', reservedWidth\(\) \+ 'px'\)/.test(kpc),
        'CSS が読む変数を誰も書かないと、読み替えが 0 のまま効かない')

    // 🔴 読み替えと保護は「有効な間ずっと」当てること。開いている間だけだと、
    //    閉じた瞬間に中身が 100vw へ戻ってハンドルの下へ潜り込む。
    const openGated = rules.filter((r) => /nns-kick-open\b/.test(r.sel)).map((r) => r.sel)
    check('BO 読み替え・保護は開閉ではなく「連携が有効か」で当てる',
        openGated.length === 0,
        `nns-kick-open で当てているルール: ${openGated.join(' / ') || 'なし'}`)
    check('BO その class を JS が付け外ししている',
        /classList\.toggle\('nns-kick-active', isActive\)/.test(kpc)
        && /classList\.remove\('nns-kick-active'\)/.test(kpc),
        '付け忘れると読み替えが一切効かず、Kick の中身がサイドバーの下へ潜り込む')

    // --- テーマ: 境目ラインが背景に溶けていないか ---
    // 🔴 `--sb-line` はラインと開閉ボタンの両方の背景色。`--sb-bg` と同じ値にすると
    //    **開閉ボタンが見えなくなる**（ダークが実際にそうなっていた・2026-08-07）。
    const mainRules = cssRules(readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8'))
    const themes = mainRules.filter((r) => /--sb-line\s*:/.test(r.body) && /--sb-bg\s*:/.test(r.body))
    check('BO テーマ定義を2つ（ダーク／ライト）見つけられる', themes.length === 2, `${themes.length} 件`)
    for (const t of themes) {
        const bg = (t.body.match(/--sb-bg\s*:\s*([^;]+);/) || [])[1]
        const line = (t.body.match(/--sb-line\s*:\s*([^;]+);/) || [])[1]
        check(`BO 境目ラインが背景に溶けていない: ${t.sel.split(',')[0]}`,
            !!bg && !!line && bg.trim().toLowerCase() !== line.trim().toLowerCase(),
            `--sb-bg ${bg} / --sb-line ${line}。同じだと開閉ボタンが見えなくなる`)
    }

    // --- ドラッグは掴んだポインタを取りこぼさないか ---
    // ウィンドウの外で離すと mouseup が来ない。capture を取れば pointerup は必ず届く。
    check('BO 幅のドラッグは pointer capture を取る', /setPointerCapture\(/.test(kpc))
    // ⚠️ 単に `lostpointercapture` の語があるかでは駄目。`removeEventListener` の側にも
    //    同じ語が出るので、配線を消しても通ってしまう（実際に一度そうなった）。
    check('BO 掴み終わりを lostpointercapture でも受ける',
        /addEventListener\('lostpointercapture'/.test(kpc),
        'pointercancel（OSにポインタを取られた）もここに集まる')
    check('BO ドラッグに mousemove / mouseup を使っていない',
        !/addEventListener\('mouse(move|up)'/.test(kpc),
        '枠外で離すと mouseup が来ず、幅がカーソルに追従し続ける')
    check('BO 取りこぼした「ドラッグ中」の印を定期の突き合わせが剥がす',
        /!isDraggingLine\) document\.documentElement\.classList\.remove\('nns-kick-dragging'\)/.test(kpc),
        '付いたままだと開閉のアニメが死んだままになる')
}

/**
 * BP. 設定パネルの ON/OFF の並びが揃っているか。
 *
 * オートオープンだけ `ON / OFF` で、他（自動移動・動くサムネ）は `OFF / ON` だった。
 * 並びが揃っていないと、隣の設定と同じ位置を押したつもりで逆の値を選んでしまう。
 *
 * 🔴 **値ではなく表示順だけを見る。** id と value の対応を動かすと既存利用者の保存値の
 *    意味が変わるので、そこは触らせない前提。この検査は「ラベルの出る順」だけを見る。
 */
async function settingsSegmentOrder() {
    const { readFileSync } = await import('fs')
    const sb = readFileSync(new URL('../src/render/sidebar.js', import.meta.url), 'utf8')
    console.log('=== BP 設定パネルの ON/OFF の並び ===')

    // ラジオ群を name ごとに集める。`<input ...name="X"...><label ...>ラベル</label>` の並び順がそのまま表示順。
    const pairs = [...sb.matchAll(/<input type="radio" id="([^"]+)" name="([^"]+)" value="([^"]+)"><label for="\1">([^<]+)<\/label>/g)]
    // 🔴 空振り防止。0件なら以下は「見つからないから合格」になる。
    check('BP 設定のラジオを拾えている', pairs.length >= 10, `${pairs.length} 件`)

    const byName = new Map()
    for (const [, , name, , label] of pairs) {
        if (!byName.has(name)) byName.set(name, [])
        byName.get(name).push(label.trim())
    }

    // ON と OFF の両方を持つ設定だけが対象。3つ目以降（「記憶」など）は問わない。
    const targets = [...byName].filter(([, labels]) => labels.includes('ON') && labels.includes('OFF'))
    check('BP ON/OFF を持つ設定が2つ以上ある（空振りしていない）', targets.length >= 2,
        targets.map(([n]) => n).join(',') || 'なし')
    for (const [name, labels] of targets) {
        check(`BP OFF が ON より先に出る: ${name}`,
            labels.indexOf('OFF') < labels.indexOf('ON'),
            `実際の並び: ${labels.join(' / ')}`)
    }
}

/**
 * BQ. 自動更新「OFF」が本当に止まるか / 廃止した選択肢の移行があるか。
 *
 * 2026-08-07 に「180秒」を廃止して「OFF」を足した。無言で壊れる形が3つある。
 *   1. `Number('off')` = NaN → `|| 120` で受けると **OFF が 120秒として動く**（止まらない）
 *   2. NaN をそのまま `setTimeout` へ渡すと **0ms 扱い**で API を叩き続ける
 *   3. 保存値 '180' に対応するラジオが無いと、その利用者は**設定を一切保存できなくなる**
 */
async function autoUpdateOff() {
    const { readFileSync } = await import('fs')
    const rd = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')
    const sb = rd('render/sidebar.js')
    const kpc = stripComments(rd('kickPage.js'))
    const mn = stripComments(rd('main.js'))
    const um = stripComments(rd('managers/UpdateManager.js'))
    console.log('=== BQ 自動更新 OFF ===')

    // --- 実際に動かして確かめる（正規表現より強い） ---
    const { autoUpdateIntervalMs } = await import('../src/render/sidebar.js')
    // 🔴 期待値はべた書き。実装側の定数から作ると、定数を何にしても通る検査になる。
    check('BQ OFF は null を返す（＝タイマーを張らない）',
        autoUpdateIntervalMs({ updateProgramsInterval: 'off' }) === null)
    check('BQ 60秒は 60000ms', autoUpdateIntervalMs({ updateProgramsInterval: '60' }) === 60000)
    check('BQ 壊れた保存値でも NaN を返さない',
        Number.isFinite(autoUpdateIntervalMs({ updateProgramsInterval: 'ほげ' })),
        'NaN を setTimeout へ渡すと 0ms 扱いになり、API を叩き続ける')
    check('BQ 未設定でも NaN を返さない', Number.isFinite(autoUpdateIntervalMs({})))
    check('BQ 0 や負値を間隔として採用しない',
        autoUpdateIntervalMs({ updateProgramsInterval: '0' }) > 0
        && autoUpdateIntervalMs({ updateProgramsInterval: '-5' }) > 0)

    // --- 判定は1箇所。各所で Number() し直さない ---
    check('BQ 自動更新の解釈は sidebar.js に1つだけ',
        (sb.match(/export function autoUpdateIntervalMs\(/g) || []).length === 1)
    const rawReaders = []
    for (const f of await listSrcFiles()) {
        const t = stripComments(readFileSync(f, 'utf8'))
        if (/Number\(\s*[\w.]*\.?updateProgramsInterval/.test(t)) rawReaders.push(f.split(/[\\/]/).pop())
    }
    check('BQ 保存値を直接 Number() している場所が無い', rawReaders.length === 0,
        `${rawReaders.join(',') || 'なし'}。'off' が NaN になり、無言で 120秒 か 0ms に化ける`)
    check('BQ ニコ生ページは共有実装を使う', /autoUpdateIntervalMs\(/.test(um))
    check('BQ kick.com ページは共有実装を使う', /autoUpdateIntervalMs\(/.test(kpc))
    // 張らない判定は1箇所に集めること（開始・位相リセット・張り直しが全部そこを通る）
    check('BQ ニコ生ページは目覚ましを張る直前で弾く',
        /_scheduleSidebarTick\(delayMs\) \{[\s\S]*?autoUpdateIntervalMs\(this\.options\) === null\) return;/.test(um),
        '上流それぞれで弾くと、経路が増えた時に漏れる')
    check('BQ kick.com ページはリスト更新だけ止める（サムネは止めない）',
        /if \(listMs !== null\) \{/.test(kpc) && /thumbTimer = setInterval/.test(kpc),
        'サムネまで止めるとヘルプの記述（サムネはこの設定と無関係）と食い違う')

    // --- 選択肢と保存値の整合 ---
    const radioVals = [...sb.matchAll(/name="updateProgramsInterval" value="([^"]+)"/g)].map((m) => m[1])
    check('BQ 自動更新の選択肢を拾えている', radioVals.length >= 3, radioVals.join(' / '))
    check('BQ OFF の選択肢がある', radioVals.includes('off'))

    // 🔴 廃止した値には必ず寄せ先を用意すること。無いと設定画面のラジオが無選択になり、
    //    saveOptions が早期 return して**何も保存できなくなる**。
    const st = stripComments(rd('services/storage.js'))
    const mig = [...st.matchAll(/updateProgramsInterval\) === '([^']+)'\) options\.updateProgramsInterval = '([^']+)'/g)]
    check('BQ 廃止した選択肢の移行が書いてある', mig.length >= 1, `${mig.length} 件`)
    for (const [, from, to] of mig) {
        check(`BQ 移行元 '${from}' は選択肢から消えている`, !radioVals.includes(from),
            '残っているなら移行は不要＝書き間違い')
        check(`BQ 移行先 '${to}' は選択肢に実在する`, radioVals.includes(to),
            '実在しない値へ寄せると、無選択のまま何も保存できない')
    }
    check('BQ 移行は保存値を読む唯一の入口（getOptions）を通る',
        /const merged = migrateOptions\(/.test(st),
        'ここを通さないと、片方のページだけ古い値のまま動く')

    // 既定値そのものが選択肢に無い、という壊れ方も同じ結果になる
    for (const [name, txt] of [['ニコ生', mn], ['kick.com', kpc]]) {
        const d = (txt.match(/updateProgramsInterval:\s*'([^']+)'/) || [])[1]
        check(`BQ ${name}ページの既定値が選択肢に実在する`, radioVals.includes(d), `既定 '${d}'`)
    }
}

/**
 * BR. サービスタブ（統合 / ニコ生 / Kick）。
 *
 * タブの定義は3箇所に散る: JS の一覧・HTML のボタン・CSS の出し分け。
 * ずれると**カードが1枚も見えない**か**絞ったはずのカードが残る**という形で出る。
 * 「統合」を足した時（2026-08-07）に実際に危なかった点を機械で守る。
 */
async function serviceTabs() {
    const { readFileSync } = await import('fs')
    const sb = readFileSync(new URL('../src/render/sidebar.js', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8')
    console.log('=== BR サービスタブ ===')

    // --- 定義が3箇所で一致しているか ---
    const listed = (stripComments(sb).match(/const SERVICE_TABS = \[([^\]]+)\]/) || [])[1]
    const inJs = listed ? listed.split(',').map((s) => s.trim().replace(/'/g, '')) : []
    const inHtml = [...sb.matchAll(/class="service_tab[^"]*" data-service-tab="([^"]+)"/g)].map((m) => m[1])
    check('BR タブのボタンを拾えている', inHtml.length >= 3, inHtml.join(' / ') || 'なし')
    // 期待値はべた書き。実装から作ると、どちらを変えても通る検査になる。
    check('BR 並びは 統合 → ニコ生 → Kick',
        inHtml.length === 3 && inHtml[0] === 'mixed' && inHtml[1] === 'nicolive' && inHtml[2] === 'kick',
        `実際: ${inHtml.join(' / ')}`)
    check('BR JS の一覧と HTML のボタンが完全一致',
        inJs.length === inHtml.length && inJs.every((v, i) => v === inHtml[i]),
        `JS: ${inJs.join(',')} / HTML: ${inHtml.join(',')}。ずれると知らない値として既定へ落ちる`)

    // --- 「統合」は何も隠さない ---
    // 🔴 出し分けの CSS に mixed を書くと、統合タブなのにカードが消える。
    const rules = cssRules(css)
    const hideRules = rules.filter((r) => /data-service-tab=/.test(r.sel) && /display\s*:\s*none/.test(r.body))
    check('BR 出し分けの CSS を拾えている', hideRules.length >= 1, `${hideRules.length} 件`)
    for (const r of hideRules) {
        check('BR 統合タブではカードを隠さない',
            !/data-service-tab="mixed"/.test(r.sel),
            `${r.sel}。統合は全件出るのが正しい`)
    }
    // 🔴 バッジは統合タブでだけ出す。片方だけのタブはタブ自体がラベルなので要らないが、
    //    統合は両方混ざるので、消すとどちらのカードか分からなくなる。
    const badgeHide = rules.find((r) => /data-service-tab/.test(r.sel) && /service_badge/.test(r.sel))
    check('BR バッジの出し分けルールがある', !!badgeHide, badgeHide ? badgeHide.sel : 'なし')
    check('BR バッジ隠しはタブを名指ししている（一括指定にしない）',
        !!badgeHide && !/\[data-service-tab\]\s/.test(badgeHide.sel)
        && /data-service-tab="nicolive"/.test(badgeHide.sel)
        && /data-service-tab="kick"/.test(badgeHide.sel),
        '[data-service-tab] の一括指定だと統合タブでもバッジが消える')

    // --- 件数 ---
    check('BR 統合タブの件数は全件を数える',
        /if \(active === 'mixed'\) return container\.children\.length/.test(stripComments(sb)),
        '絞り込みの式に混ぜると Kick のぶんだけ件数が足りなくなる')
    // 知らない値をそのまま採用すると、どのタブとも一致しない属性が付いて全部消える
    check('BR 知らないタブ名は採用しない',
        /SERVICE_TABS\.includes\(activeTab\)/.test(stripComments(sb)),
        '保存値が壊れていた時にカードが1枚も見えなくなる')

    // --- 余白（見出し→タブ→リスト） ---
    // 🔴 margin で組むと兄弟間で相殺し、足し算にならない。padding で持つこと。
    const body = rules.find((r) => r.sel === '.sidebar_body')
    const list = rules.find((r) => r.sel === '#liveProgramContainer')
    const header = rules.find((r) => r.sel === '.sidebar_header')
    // ⚠️ 単位なしの `0` も拾うこと。`px` を必須にすると `margin-bottom: 0` を見落として
    //    「見つからない＝null」になり、検査が意図と逆の結果を出す（実際に一度そうなった）。
    const px = (r, prop) => {
        const m = r && r.body.match(new RegExp(prop + '\\s*:\\s*(-?\\d+)(?:px)?\\s*;'))
        return m ? Number(m[1]) : null
    }
    check('BR 見出しは下余白を持たない（相殺を避ける）', px(header, 'margin-bottom') === 0,
        `margin-bottom: ${px(header, 'margin-bottom')}`)
    const above = px(body, 'padding-top')
    const belowList = px(list, 'padding-top')
    check('BR 余白を padding で持っている', above !== null && belowList !== null,
        `.sidebar_body ${above} / #liveProgramContainer ${belowList}`)
    // タブが無い時の見た目は従来どおり 20px。ここが変わるとタブを使わない利用者にも影響する。
    check('BR タブ無しの時の余白は従来どおり 20px', above + belowList === 20,
        `${above} + ${belowList} = ${above + belowList}`)
    // margin ショートハンドの3つ目（下）。単位なしの 0 も混じるので、値を分解して取る。
    const tabs = rules.find((r) => r.sel === '.service_tabs')
    const shorthand = tabs && (tabs.body.match(/(?:^|;)\s*margin\s*:\s*([^;]+)/) || [])[1]
    const parts = shorthand ? shorthand.trim().split(/\s+/) : []
    const tabBottom = parts.length >= 3 ? Number(parts[2].replace('px', '')) : null
    check('BR タブの下余白を読めている', Number.isFinite(tabBottom), `margin: ${shorthand || 'なし'}`)
    check('BR タブとリストの間は見出しとの間より広い',
        Number.isFinite(tabBottom) && tabBottom + belowList > above,
        `タブ上 ${above}px / タブ下 ${tabBottom + belowList}px`)
}

/**
 * BS. 番組カードの大きさ（小/中/大）。
 *
 * カード幅は「サイドバー幅 ÷ 列数」しか取れない。設定は列の増え方（`columnFactor`）と
 * 中身の倍率（`contentScale`）の2つを動かす。
 *
 * 🔴 **既定の「中」は従来と完全に同じでなければならない。** 全利用者の既定値なので、
 *    ここがずれると誰も設定を触っていないのにレイアウトが変わる。
 */
async function cardSize() {
    const { readFileSync } = await import('fs')
    const rd = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')
    const sb = rd('render/sidebar.js')
    const css = rd('styles/main.css')
    const mn = stripComments(rd('main.js'))
    const kpc = stripComments(rd('kickPage.js'))
    console.log('=== BS カードの大きさ ===')

    const { columnsForWidth } = await import('../src/ui/layout.js')

    // --- 「中」＝従来の式と一致するか（**期待値はべた書き**） ---
    // 旧実装: しきい値 [300,500,700,900,1100,1300,1500] を超えるたび +1列。
    const widths = [200, 300, 301, 500, 501, 900, 901, 1600]
    const expected = [1, 1, 2, 2, 3, 4, 5, 8]
    const got = widths.map((w) => columnsForWidth(w, 'medium'))
    check('BS 「中」は従来の列数と完全に一致',
        got.every((c, i) => c === expected[i]),
        `幅 ${widths.join('/')} → 期待 ${expected.join('/')} / 実際 ${got.join('/')}`)

    // --- 小・大が意図した向きに効くか ---
    check('BS 「小」は列が増える（＝1枚が狭い）',
        columnsForWidth(360, 'small') === 3 && columnsForWidth(600, 'small') === 4,
        `360→${columnsForWidth(360, 'small')}列 / 600→${columnsForWidth(600, 'small')}列`)
    check('BS 「大」は列が減る（＝1枚が広い）',
        columnsForWidth(360, 'large') === 1 && columnsForWidth(600, 'large') === 2,
        `360→${columnsForWidth(360, 'large')}列 / 600→${columnsForWidth(600, 'large')}列`)
    for (const w of [180, 360, 600, 1200]) {
        check(`BS 大小の順序が崩れない（幅${w}）`,
            columnsForWidth(w, 'small') >= columnsForWidth(w, 'medium')
            && columnsForWidth(w, 'medium') >= columnsForWidth(w, 'large'),
            `小${columnsForWidth(w, 'small')} / 中${columnsForWidth(w, 'medium')} / 大${columnsForWidth(w, 'large')}`)
    }
    // 壊れた保存値・異常な幅で列数が 0 や NaN にならないこと（0 だと幅が Infinity% になる）
    check('BS 知らない大きさは既定に落ちる',
        columnsForWidth(360, 'ほげ') === columnsForWidth(360, 'medium'))
    for (const [label, w] of [['NaN', NaN], ['0', 0], ['負', -100], ['未指定', undefined]]) {
        check(`BS 幅が${label}でも列数は1以上`, columnsForWidth(w, 'medium') >= 1,
            `${columnsForWidth(w, 'medium')} 列。0 だと幅が Infinity% になる`)
    }

    // --- 設定の値と定義がそろっているか ---
    const { cardSizes, defaultCardSize } = await import('../src/config/constants.js')
    const radioVals = [...sb.matchAll(/name="cardSize" value="([^"]+)"/g)].map((m) => m[1])
    check('BS カードの大きさの選択肢を拾えている', radioVals.length === 3, radioVals.join(' / '))
    check('BS 選択肢と定義（cardSizes）のキーが一致',
        radioVals.length === Object.keys(cardSizes).length
        && radioVals.every((v) => !!cardSizes[v]),
        `選択肢 ${radioVals.join(',')} / 定義 ${Object.keys(cardSizes).join(',')}`)
    check('BS 既定は「中」で、倍率は 1/1（＝従来のまま）',
        defaultCardSize === 'medium'
        && cardSizes.medium.columnFactor === 1 && cardSizes.medium.contentScale === 1,
        `既定 ${defaultCardSize} / ${JSON.stringify(cardSizes.medium)}`)
    for (const [name, txt] of [['ニコ生', mn], ['kick.com', kpc]]) {
        const d = (txt.match(/cardSize:\s*'([^']+)'/) || [])[1]
        check(`BS ${name}ページの既定値が選択肢に実在する`, radioVals.includes(d), `既定 '${d}'`)
    }

    // --- 両ページが反映しているか ---
    // ⚠️ setProgramContainerWidth の呼び出しは10箇所ある。引数ではなく setCardSize で
    //    流し込む形なので、**呼び忘れるとそのページだけ既定（中）のまま**になる。
    // ⚠️ 「setCardSize があるか」では駄目。起動時と設定変更時の**2箇所**に要るので、
    //    片方を消しても残りが引っかかって通ってしまう（実際に一度そうなった）。
    //    数と、設定変更ブロックの中身の両方を見る。
    for (const [name, txt] of [['ニコ生', mn], ['kick.com', kpc]]) {
        const n = (txt.match(/setCardSize\(options\.cardSize\)/g) || []).length
        check(`BS ${name}ページは起動時と設定変更時の2箇所で反映する`, n >= 2,
            `${n} 箇所。起動時が抜けると初回だけ既定、変更時が抜けると次の取得まで効かない`)
        check(`BS ${name}ページは設定変更のブロック内で当て直す`,
            /changes\.cardSize[\s\S]{0,200}?setCardSize\(options\.cardSize\)/.test(txt),
            '受けないと、変えても次の取得までカードの大きさが変わらない')
    }
    check('BS 設定パネルが cardSize を保存する',
        /options\.cardSize = cardSizeElement\.value/.test(stripComments(rd('handlers/optionsHandler.js')))
        && /updateCheckedState\('cardSize'/.test(rd('handlers/optionsHandler.js')),
        '保存と復元の両方が要る。片方だけだと開くたびに戻る')
    // 後から足した設定なので、必須ガードに入れて保存全体を止めないこと
    check('BS cardSize は保存の必須ガードに入っていない',
        !/!cardSizeElement/.test(stripComments(rd('handlers/optionsHandler.js'))),
        '古い DOM で無選択だと、設定が何ひとつ保存できなくなる')

    // --- 中身の拡縮 ---
    const rules = cssRules(css)
    const listRule = rules.find((r) => r.sel === '#liveProgramContainer')
    check('BS 倍率の CSS 変数に既定 1 がある',
        !!listRule && /--nns-card-scale:\s*1\s*;/.test(listRule.body),
        'JS が入れなかった時に従来どおりにならない')
    const scaled = rules.filter((r) => /var\(--nns-card-scale\)/.test(r.body)).map((r) => r.sel)
    check('BS 中身の拡縮が効いている箇所がある', scaled.length >= 3, scaled.join(' / ') || 'なし')
    // 🔴 アイコンは枠(a)と画像(img)の両方。片方だけだと枠から画像がはみ出す。
    check('BS アイコンは枠と画像の両方を拡縮している',
        scaled.includes('.program_container .provider a')
        && scaled.includes('.program_container .provider img'),
        `実際: ${scaled.join(' / ')}`)
}

/**
 * BT. 自動移動の移動先選び（サービスをまたぐ）。
 *
 * 2026-08-07 まで `/watch/(lv\d+)` に一致するリンクだけを見ており、**Kick のカードは
 * 黙って候補から外れていた**。またぐようにしたので、規則を機械で縛る。
 *   1. 今のタブで見えているカードから選ぶ
 *   2. DOM 順の先頭から
 *   3. 今いる放送と同じものは飛ばす
 *   4. **今いる放送が分からない時は選ばない**（一覧ページや VOD で飛ばされないため）
 */
async function autoNextTarget() {
    const { readFileSync } = await import('fs')
    const sb = readFileSync(new URL('../src/render/sidebar.js', import.meta.url), 'utf8')
    const anm = stripComments(readFileSync(new URL('../src/managers/AutoNextManager.js', import.meta.url), 'utf8'))
    const css = readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8')
    console.log('=== BT 自動移動の移動先選び ===')

    const { watchTargetIdOf, pickAutoNextTarget, isCardVisibleInTab } = await import('../src/render/sidebar.js')

    // --- URL から放送の識別子（期待値はべた書き） ---
    const table = [
        ['https://live.nicovideo.jp/watch/lv346', 'nico:lv346'],
        ['https://live.nicovideo.jp/follow', ''],
        ['https://kick.com/muramako', 'kick:muramako'],
        ['https://kick.com/MuraMako', 'kick:muramako'],   // 大小を無視して同一視する
        ['https://kick.com/muramako/', 'kick:muramako'],
        ['https://kick.com/browse', ''],                  // 予約パスはチャンネルではない
        ['https://kick.com/video/abc', ''],
        ['https://kick.com/muramako/clips', ''],
        ['https://example.com/x', ''],
        ['', ''],
    ]
    for (const [url, want] of table) {
        check(`BT 識別子: ${url || '(空)'} → ${want || '(判定不能)'}`,
            watchTargetIdOf(url) === want, `実際: ${JSON.stringify(watchTargetIdOf(url))}`)
    }

    // --- 移動先選び（作り物の DOM で実際に動かす） ---
    const card = (service, href) => ({
        getAttribute: (k) => (k === 'data-service' ? service : null),
        querySelector: (q) => (q === '.program_thumbnail a' ? { href } : null),
    })
    const box = (tab, cards) => ({ getAttribute: (k) => (k === 'data-service-tab' ? tab : null), children: cards })
    const cards = [
        card('nicolive', 'https://live.nicovideo.jp/watch/lv1'),
        card('kick', 'https://kick.com/aaa'),
        card('nicolive', 'https://live.nicovideo.jp/watch/lv2'),
    ]

    // 今いる番組は飛ばして、次の候補（＝Kick）へ。**ここが従来は動かなかった。**
    let r = pickAutoNextTarget(box(null, cards), 'https://live.nicovideo.jp/watch/lv1')
    check('BT ニコ生から Kick のチャンネルへ移動できる', r.id === 'kick:aaa', `選んだ先: ${r.id || 'なし'}`)
    r = pickAutoNextTarget(box(null, cards), 'https://kick.com/aaa')
    check('BT Kick からニコ生の番組へ移動できる', r.id === 'nico:lv1', `選んだ先: ${r.id || 'なし'}`)

    // タブで分けている時は見えているものだけ
    r = pickAutoNextTarget(box('nicolive', cards), 'https://live.nicovideo.jp/watch/lv1')
    check('BT ニコ生タブでは Kick を飛ばす', r.id === 'nico:lv2', `選んだ先: ${r.id || 'なし'}`)
    r = pickAutoNextTarget(box('kick', cards), 'https://kick.com/aaa')
    check('BT Kick タブでは Kick の中から選ぶ（他が居なければ選ばない）',
        r.id === '', `選んだ先: ${r.id || 'なし'}`)
    r = pickAutoNextTarget(box('mixed', cards), 'https://kick.com/aaa')
    check('BT 統合タブでは全部が候補', r.id === 'nico:lv1' && r.candidates.length === 3,
        `選んだ先: ${r.id} / 候補 ${r.candidates.length}件`)

    // 🔴 今いる放送が分からない時は動かさない
    for (const [label, url] of [['一覧ページ', 'https://live.nicovideo.jp/follow'], ['Kick の VOD', 'https://kick.com/video/x'], ['空', '']]) {
        const rr = pickAutoNextTarget(box(null, cards), url)
        check(`BT 今いる放送が分からない時は選ばない（${label}）`, rr.link === null && rr.id === '',
            `選んだ先: ${rr.id || 'なし'}。分からない時に動くと一覧ページで飛ばされる`)
    }
    // カードが自分1枚だけなら移動先なし（同じ放送へ飛び直さない）
    r = pickAutoNextTarget(box(null, [cards[0]]), 'https://live.nicovideo.jp/watch/lv1')
    check('BT 自分しか居なければ移動しない', r.link === null)

    // --- タブの見え方の規則が CSS と JS で1つになっているか ---
    check('BT 見え方の判定は sidebar.js に1つだけ',
        (sb.match(/export function isCardVisibleInTab\(/g) || []).length === 1)
    check('BT 件数もその判定を通す（規則を2つ持たない）',
        /function countVisibleByTab[\s\S]{0,400}?isCardVisibleInTab\(/.test(stripComments(sb)),
        '別々に書くと、見えていないカードへ自動移動する形で食い違いが出る')
    // CSS が隠す組み合わせと、JS が false を返す組み合わせが一致するか
    // 🔴 CSS の「隠す組み合わせ」を**べた書きの期待値**と突き合わせる。
    //    CSS を足し引きしたらここが落ちるので、JS の判定も直したか必ず考えることになる。
    const hideSel = cssRules(css)
        .filter((r) => /data-service-tab=/.test(r.sel) && /program_container/.test(r.sel))
        .map((r) => r.sel.replace(/\s+/g, ' ').trim())
    check('BT カードを隠す CSS を拾えている', hideSel.length === 1, hideSel.join(' || ') || 'なし')
    check('BT 隠す組み合わせは「ニコ生タブ×Kick」と「Kickタブ×ニコ生」の2つだけ',
        hideSel[0] === '#liveProgramContainer[data-service-tab="nicolive"] .program_container[data-service="kick"], '
        + '#liveProgramContainer[data-service-tab="kick"] .program_container:not([data-service="kick"])',
        `実際: ${hideSel[0] || 'なし'}。増減したら isCardVisibleInTab も直すこと`)
    for (const [tab, svc, want] of [
        ['nicolive', 'kick', false], ['nicolive', 'nicolive', true],
        ['kick', 'nicolive', false], ['kick', 'kick', true],
        ['mixed', 'kick', true], ['mixed', 'nicolive', true],
        [null, 'kick', true],
    ]) {
        check(`BT 見え方: タブ${tab || '(なし)'} × ${svc} → ${want ? '見える' : '隠れる'}`,
            isCardVisibleInTab(box(tab, []), card(svc, '')) === want)
    }

    // --- 呼び出し側が自前で選び直していないか ---
    check('BT AutoNextManager は共有の選び方を使う', /pickAutoNextTarget\(/.test(anm))
    check('BT AutoNextManager が lv 決め打ちの判定を持たない',
        !/watch\\\/\(lv/.test(anm) && !/\/watch\/\(lv/.test(anm),
        'ここに書き戻すと Kick のカードがまた黙って候補から外れる')
}

/**
 * BU. kick.com の自動移動（終了検知）。
 *
 * ニコ生側が事故を経て辿り着いた規則を、Kick でも機械で守る。
 *   ・不在から終了を導かない（本人に聞く）
 *   ・答えが得られなければ動かない
 *   ・自分で開いたページを奪わない
 */
async function sidebarPlacementGroup() {
    console.log('=== CE サイドバーの置き方（寄せる／重ねる） ===')
    const { readFileSync } = await import('fs')
    const rd = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')
    const stripCss = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ')
    const mainJs = stripComments(rd('main.js'))
    const kickJs = stripComments(rd('kickPage.js'))
    const ctrl = stripComments(rd('ui/sidebarControl.js'))
    const shell = rd('render/sidebar.js')
    const optH = stripComments(rd('handlers/optionsHandler.js'))
    const mainCss = stripCss(rd('styles/main.css'))
    const kickCss = stripCss(rd('styles/kickPage.css'))

    // --- ① 判定は1箇所（両ページで写し漏れない） ---
    const { normalizeSidebarPlacement, isOverlayPlacement, applySidebarPlacement, OVERLAY_CLASS } =
        await import('../src/ui/placement.js')
    check('CE 既定は「寄せる」（今までの動きを変えない）', normalizeSidebarPlacement(undefined) === 'push')
    check('CE 🔴 知らない値は「寄せる」に倒す（画面を覆い隠さない）',
        normalizeSidebarPlacement('zzz') === 'push' && normalizeSidebarPlacement(null) === 'push'
        && normalizeSidebarPlacement('') === 'push')
    check('CE overlay は overlay', isOverlayPlacement('overlay') === true)
    check('CE push は overlay ではない', isOverlayPlacement('push') === false)
    check('CE 🔴 印を付けるのは <html>（kick のサイドバーは body の外に居る）',
        /document\.documentElement\.classList\.toggle/.test(stripComments(rd('ui/placement.js')))
        && !/document\.body\.classList\.toggle\(OVERLAY_CLASS/.test(rd('ui/placement.js')))

    // 🔴 写し漏れ対策（doc/09 項目BN と同じ縛り）
    check('CE 🔴 ニコ生ページが共有の判定を使う', /applySidebarPlacement\(/.test(mainJs))
    check('CE 🔴 kick.com ページが共有の判定を使う', /applySidebarPlacement\(/.test(kickJs))
    check('CE 両ページに既定値がある',
        /sidebarPlacement:\s*'push'/.test(mainJs) && /sidebarPlacement:\s*'push'/.test(kickJs))
    check('CE 両ページが設定変更に反応する',
        /changes\.sidebarPlacement/.test(mainJs) && /changes\.sidebarPlacement/.test(kickJs))
    check('CE 🔴 印だけ付けて終わりにしない（寄せ幅を当て直す）',
        /changes\.sidebarPlacement[\s\S]{0,300}setRootWidth\(\)/.test(mainJs)
        && /changes\.sidebarPlacement[\s\S]{0,300}applyHostStyles\(\)/.test(kickJs))

    // --- ② 設定 UI ---
    check('CE 設定に「サイドバーの置き方」がある', /name="sidebarPlacement"/.test(shell))
    check('CE 選択肢は push / overlay の2つ',
        /value="push"/.test(shell) && /value="overlay"/.test(shell)
        && (shell.match(/name="sidebarPlacement"/g) || []).length === 2)
    check('CE 保存する', /input\[name="sidebarPlacement"\]:checked/.test(optH)
        && /options\.sidebarPlacement = sidebarPlacementElement\.value/.test(optH))
    check('CE 開いた時に選択状態を復元する', /updateCheckedState\('sidebarPlacement'/.test(optH))

    // --- ③ kick: 寄せ幅 0 で全部止まる ---
    check('CE 🔴 kick は寄せ幅を 0 にするだけ（置き方ごとに分岐を増やさない）',
        /function reservedWidth\(\)[\s\S]{0,400}isOverlayPlacement\(options\.sidebarPlacement\)\) return 0/.test(kickJs))
    check('CE 🔴 寄せ幅 0 なら body の指定ごと外す（0px を書き込まない）',
        /const want = isActive && w > 0/.test(kickJs))
    // 寄せ幅 0 で降りることを、実装から確かめる
    const { nudgeFixedOverlays, nudgedCount } = await import('../src/services/fixedOverlayNudge.js')
    const { applyGridColumnFix, gridFixCount } = await import('../src/services/gridColumnFix.js')
    check('CE 寄せ幅 0 なら固定要素を押さない', nudgeFixedOverlays(0) === 0 && nudgedCount() === 0)
    check('CE 寄せ幅 0 ならカードの列数も触らない', applyGridColumnFix(0) === 0 && gridFixCount() === 0)

    // --- ④ CSS: 重ねる時は読み替えを一切しない ---
    // 🔴 **セレクタは1本ずつ見ること。** カンマ区切りのまとまりで見ると、4本のうち1本だけ
    //    元に戻しても、他の行に文字列が残っているので通ってしまう（実際に踏んだ）。
    const rewriteSelectors = (kickCss.match(/html\.nns-kick-active[^{]*\[class[^{]*\{/g) || [])
        .flatMap((r) => r.replace(/\{$/, '').split(','))
        .map((x) => x.trim()).filter((x) => x.includes('[class'))
    check('CE （空振り防止）読み替えのセレクタを1本ずつ取り出せている',
        rewriteSelectors.length >= 8, `${rewriteSelectors.length}本`)
    check('CE 🔴 読み替えのセレクタはすべて「重ねる時は効かない」',
        rewriteSelectors.every((r) => r.includes(':not(.nns-overlay)')),
        rewriteSelectors.filter((r) => !r.includes(':not(.nns-overlay)')).join(' / ') || 'なし')
    check('CE サイドバー自身を守る規則は重ねる時も効く（幅を奪われないため）',
        /html\.nns-kick-active #niconamasidebar-kick-root \{/.test(kickCss))

    // --- ⑤ CSS: ニコ生は中身とラインの両方を流れから外す ---
    const overlayRules = (mainCss.match(/html\.nns-overlay[^{]*\{[^}]*\}/g) || [])
    check('CE （空振り防止）重ねる用の規則がある', overlayRules.length >= 2, `${overlayRules.length}件`)
    const body = (sel) => (overlayRules.find((r) => r.startsWith(sel)) || '')
    const sbRule = body('html.nns-overlay body > #sidebar {')
    const lineRule = body('html.nns-overlay body > #sidebar_line {')
    check('CE 🔴 中身を流れから外す（fixed）', /position:\s*fixed/.test(sbRule), sbRule.replace(/\s+/g, ' '))
    check('CE 🔴 ラインも流れから外す（片方だけだと場所を取り続ける）',
        /position:\s*fixed/.test(lineRule), lineRule.replace(/\s+/g, ' '))
    check('CE 🔴 ラインは中身の右隣（幅の変数を使う。CSS 側で計算し直さない）',
        /left:\s*var\(--nns-sb-w/.test(lineRule) && !/calc\(/.test(lineRule),
        lineRule.replace(/\s+/g, ' '))
    check('CE 🔴 ニコ生用の規則は body 直下に限定（kick のサイドバーに当てない）',
        overlayRules.every((r) => r.startsWith('html.nns-overlay body >')),
        overlayRules.filter((r) => !r.startsWith('html.nns-overlay body >')).map((r) => r.split('{')[0]).join(' / ') || 'なし')
    check('CE ラインは中身より上（閉じている時に掴めなくならない）',
        (Number((lineRule.match(/z-index:\s*(\d+)/) || [])[1]) || 0)
        > (Number((sbRule.match(/z-index:\s*(\d+)/) || [])[1]) || 0))

    // --- ⑥ 幅の受け渡し ---
    check('CE 🔴 幅を CSS へ渡している（ラインの位置に要る）',
        /setProperty\('--nns-sb-w'/.test(ctrl))
    check('CE 🔴 幅が変わる経路すべてが通る場所で渡している（setRootWidth の中）',
        /function setRootWidth\(\)[\s\S]{0,700}setProperty\('--nns-sb-w'/.test(ctrl))
    check('CE 🔴 重ねる時はページの幅を触らない',
        /if \(isOverlay\(\)\) \{[\s\S]{0,200}elems\.root\.style\.width = ''/.test(ctrl))
    check('CE 🔴 空文字で消す（前の値が残ると切り替えても戻らない）',
        /elems\.root\.style\.maxWidth = ''/.test(ctrl))
    check('CE 判定は設定値ではなく <html> の印を見る（渡し忘れが起きない）',
        /classList\.contains\(OVERLAY_CLASS\)/.test(ctrl))

    // --- ⑦ ラインが遅れて付いてこないこと（CE-2・利用者が実機で発見） ---
    // 🔴 幅を書く場所と変数を更新する場所が分かれていると、掴んでいる間ラインだけ遅れる。
    //    kick.com で踏んだ「動かすものが2つに分かれてズレる」と同じ形（doc/09 項目BO）。
    const widthWrites = (ctrl.match(/elems\.sidebar\.style\.(width|maxWidth|minWidth)\s*=/g) || [])
    check('CE-2 🔴 サイドバーの幅を書く場所は1箇所だけ（散らばると変数の更新を取りこぼす）',
        widthWrites.length === 3, `${widthWrites.length}箇所（幅・最大・最小の3つが1関数に収まっている想定）`)
    check('CE-2 🔴 幅と変数を同じ場所で書く',
        /function applySidebarWidth\(px\)[\s\S]{0,400}setProperty\('--nns-sb-w', px/.test(ctrl))
    check('CE-2 🔴 変数の更新を rAF に入れない（1フレーム遅れる）',
        /function applySidebarWidth\(px\)[\s\S]{0,400}setProperty\('--nns-sb-w'/.test(ctrl)
        && !/function applySidebarWidth\(px\)[\s\S]{0,400}requestAnimationFrame/.test(ctrl))
    check('CE-2 🔴 ドラッグ中もその場所を通る（ここが本命）',
        /function onMouseMove\(e\)[\s\S]{0,400}applySidebarWidth\(width\)/.test(ctrl))
    check('CE-2 開閉もその場所を通る',
        /function openSidebar\(\)[\s\S]{0,300}applySidebarWidth\(/.test(ctrl)
        && /function closeSidebar\(\)[\s\S]{0,300}applySidebarWidth\(0\)/.test(ctrl))

    // 開閉のアニメ中もズレないこと（中身とラインで同じ掛け外し）
    check('CE-2 🔴 ラインにもアニメの掛け外しをする（片方だけ止めると 0.5秒遅れて追ってくる）',
        /classList\.remove\('sidebar_transition'\)[\s\S]{0,300}sidebar_line\.classList\.remove\('sidebar_transition'\)/.test(ctrl)
        && /sidebar\.classList\.add\('sidebar_transition'\)[\s\S]{0,200}sidebar_line\.classList\.add\('sidebar_transition'\)/.test(ctrl))
    check('CE-2 ラインは最初からアニメ付き（初回の開閉でズレない）',
        /<div id="sidebar_line" class="sidebar_transition">/.test(shell))
    check('CE-2 🔴 中身とラインは同じクラスを使う（別々に書くと片方の時間を変えた時に食い違う）',
        (mainCss.match(/\.sidebar_transition\s*\{/g) || []).length === 1
        && !/#sidebar_line[^{]*\{[^}]*transition:/.test(mainCss),
        '重ねる用の規則にラインだけの transition を書かないこと')
}

async function kickPlaceholderIconGroup() {
    console.log('=== CD 放送直後の Kick カードに、ローディングではなく配信者アイコンを出す ===')
    const { readFileSync } = await import('fs')
    const ks = stripComments(readFileSync(new URL('../src/services/kickSource.js', import.meta.url), 'utf8'))

    // --- ① アイコン取得の失敗を永久に覚えない（ソース検査） ---
    // 🔴 以前は失敗を空文字でキャッシュしており、`has(slug)` が真になって**二度と取りに行かなかった。**
    check('CD 🔴 失敗を空文字としてキャッシュへ入れない',
        !/iconCache\.set\([^)]*,\s*''\s*\)/.test(ks) && !/iconCache\.set\(slug, \(ch/.test(ks),
        (ks.match(/iconCache\.set\([^\n]*/g) || []).join(' / '))
    check('CD 🔴 失敗は期限つきで覚える（時間が経てばまた試す）',
        /iconRetryAfter\.set\([^)]*kickIconRetryMs\)/.test(ks))
    check('CD 待ちが明けていない相手は飛ばす',
        /iconRetryAfter\.get\(slug\)[\s\S]{0,40}>\s*now[\s\S]{0,20}continue/.test(ks))
    check('CD 🔴 空で返ってきた時も覚えない（後でアイコンを設定した人に追従できなくなる）',
        /if \(url\) iconCache\.set\(slug, url\)/.test(ks))
    check('CD 以前の版が保存した空文字は読み込まずに捨てる',
        /Object\.entries\(map\)\) if \(url\) iconCache\.set/.test(ks))

    // --- ② カードの繋ぎ画像（モックDOMで実際に組み立てる） ---
    const { installMockDom } = await import('./mock-dom.mjs')
    const restore = {
        document: globalThis.document, window: globalThis.window,
        Image: globalThis.Image, chrome: globalThis.chrome,
    }
    installMockDom()
    globalThis.chrome = {
        runtime: { id: 'test', getURL: (p) => 'chrome-extension://test/' + p },
        storage: { local: { get: async () => ({}), set: async () => {} } },
    }
    try {
        const { makeProgramElement, applyProgramInfoToCard } =
            await import('../src/render/sidebar.js')
        const LOADING = 'chrome-extension://test/images/loading.gif'
        const ICON = 'https://files.kick.com/icon.webp'
        const THUMB = 'https://images.kick.com/thumb.webp'

        // 🔴 実測どおりの形（`services/kickSource.js` の写像そのまま）。
        //    放送直後は **サムネもアイコンも空**で来ることがある。
        const kick = ({ thumb = '', icon = '' }) => ({
            id: 'k12345', service: 'kick', title: 'テスト配信',
            watchUrl: 'https://kick.com/someone', providerType: 'user',
            contentOwner: { id: 'someone', name: 'someone', icon },
            thumbnailUrl: thumb, isMemberOnly: false,
            viewers: 0, comments: 0, concurrentViewers: 3,
            onAirTime: { beginAt: '2026-08-08T00:00:00.000Z' },
        })
        const thumbImg = (card) => card.querySelector('.program_thumbnail_img')

        // サムネ無し・アイコンあり → アイコンが出る
        const a = makeProgramElement(kick({ icon: ICON }), LOADING)
        check('CD サムネが無ければ配信者アイコンを出す（ローディングではない）',
            thumbImg(a).getAttribute('src') === ICON && thumbImg(a).getAttribute('data-src') === ICON,
            `src=${thumbImg(a).getAttribute('src')}`)

        // 両方無い → ローディング（最後の砦）
        const b = makeProgramElement(kick({}), LOADING)
        check('CD アイコンも無ければローディング（最後の砦）',
            thumbImg(b).getAttribute('src') === LOADING)

        // 🔴 ここが今回の本題。
        //    アイコンが**後から**埋まった時、ローディングのままにしない。
        // 🔴 **この行が守る状態を、テスト側で作ること。** 何もしないと生成時から既に
        //    thumbLive=0 なので、実装から外しても落ちず**空振り**になる（実際に踏んだ）。
        //    「もし何かの経路でライブ扱いのまま繋ぎ画像に落ちたら、ライブ印を外す」が意図。
        thumbImg(b).dataset.thumbLive = '1'
        thumbImg(b).dataset.thumbSeq = '42'
        applyProgramInfoToCard(b, kick({ icon: ICON }))
        check('CD 🔴 後からアイコンが埋まったらローディングを置き換える（本題）',
            thumbImg(b).getAttribute('src') === ICON && thumbImg(b).getAttribute('data-src') === ICON,
            `src=${thumbImg(b).getAttribute('src')} data-src=${thumbImg(b).getAttribute('data-src')}`)
        check('CD 置き換えた絵はライブサムネ扱いにしない（動くサムネが最新コマとして混ぜない）',
            thumbImg(b).dataset.thumbLive === '0' && !thumbImg(b).dataset.thumbSeq,
            `thumbLive=${thumbImg(b).dataset.thumbLive}`)

        // 本物のサムネが来たら、そちらが勝つ
        applyProgramInfoToCard(b, kick({ thumb: THUMB, icon: ICON }))
        check('CD 本物のサムネが来たら data-src はそちらへ',
            thumbImg(b).getAttribute('data-src') === THUMB,
            `data-src=${thumbImg(b).getAttribute('data-src')}`)

        // ⚠️ **今出している絵がローディングでないなら触らない。**
        //    表示中の絵をアイコンで踏み潰すと、出ているサムネが消える。
        const c = makeProgramElement(kick({ thumb: THUMB, icon: ICON }), LOADING)
        applyProgramInfoToCard(c, kick({ icon: ICON })) // サムネが一時的に取れなかった周期
        check('CD 🔴 表示中の絵がローディングでなければ踏み潰さない',
            thumbImg(c).getAttribute('src') === THUMB,
            `src=${thumbImg(c).getAttribute('src')}`)

        // ニコ生側（アイコンのみ・サムネ無し）でも同じ扱いになること
        const nico = {
            id: '345678901', title: 'ニコ生', providerType: 'user',
            contentOwner: { id: 'u1', name: '主', icon: ICON },
            thumbnailUrl: '', onAirTime: { beginAt: '2026-08-08T00:00:00.000Z' },
        }
        const d = makeProgramElement(nico, LOADING)
        check('CD ニコ生でも同じ（繋ぎはアイコン）', thumbImg(d).getAttribute('src') === ICON)

        // ---- CD-2: サムネURLは来るのに画像がまだ無い（Kick の放送開始直後の実態） ----
        //
        // 🔴 **ここが CD の穴だった。** 上の CD は「サムネURLが空で来る」形しか試しておらず、
        //    実際に起きていたのは「**URLは来るが画像がまだ生成されていない**」形。
        //    この時 data-src は同じURLなので、error フォールバックが
        //    `this.src !== dataSrc` を偽と見て**アイコンを飛び越しローディング画像へ直行**していた。
        //    利用者報告（2026-08-10）＝「放送開始直後の Kick カードがローディングのまま」。
        const e = makeProgramElement(kick({ thumb: THUMB, icon: ICON }), LOADING)
        const eImg = thumbImg(e)
        check('CD-2 生成時はサムネURLを出す（ここは従来どおり）',
            eImg.getAttribute('src') === THUMB && eImg.getAttribute('data-src') === THUMB,
            `src=${eImg.getAttribute('src')}`)
        check('CD-2 繋ぎ画像を data-src とは別に持つ',
            eImg.getAttribute('data-fallback-src') === ICON,
            `data-fallback-src=${eImg.getAttribute('data-fallback-src')}`)

        // 画像が無い＝読み込み失敗。**本物の DOM と同じく img の error を鳴らして通す。**
        eImg.fire('error')
        check('CD-2 🔴 サムネが読めなければ配信者アイコンへ落ちる（ローディングではない・本題）',
            eImg.getAttribute('src') === ICON,
            `src=${eImg.getAttribute('src')}`)
        check('CD-2 落ちた絵はライブサムネ扱いにしない（動くサムネが最新コマとして混ぜない）',
            eImg.dataset.thumbLive === '0' && !eImg.dataset.thumbSeq,
            `thumbLive=${eImg.dataset.thumbLive}`)

        // アイコンまで読めない時だけ最後の砦へ。
        eImg.fire('error')
        check('CD-2 アイコンも読めなければローディング（最後の砦）',
            eImg.getAttribute('src') === LOADING, `src=${eImg.getAttribute('src')}`)
        // 🔴 **上へ戻らないこと。** 戻せるとサムネURL↔アイコンで error が無限に往復する。
        eImg.fire('error')
        check('CD-2 🔴 最後の砦から上へ戻らない（error の無限往復を作らない）',
            eImg.getAttribute('src') === LOADING, `src=${eImg.getAttribute('src')}`)

        // 失敗が続いてバックオフ中のカードは、リスト更新のたびに繋ぎ画像へ戻す。
        // 🔴 **data-src は初回から一度も変わっていない。** 旧実装はこの入れ替えを
        //    「data-src が変わった時」の中に置いていたため、ここで素通りしていた。
        eImg.dataset.nextTryAt = String(Date.now() + 60000)
        applyProgramInfoToCard(e, kick({ thumb: THUMB, icon: ICON }))
        check('CD-2 🔴 data-src が変わらなくてもローディングから繋ぎ画像へ戻す',
            eImg.getAttribute('src') === ICON, `src=${eImg.getAttribute('src')}`)

        // ニコ生の user 番組はライブサムネと静止サムネが別URL。**順番を変えていない**ことを見る
        // （アイコンを先に出すと、出せるはずの静止サムネが出なくなる）。
        const g = makeProgramElement({
            id: '345678902', title: 'ニコ生', providerType: 'user',
            contentOwner: { id: 'u2', name: '主', icon: ICON },
            thumbnailUrl: 'https://nico.example/static.jpg',
            liveScreenshotThumbnailUrls: { middle: 'https://nico.example/live.jpg' },
            onAirTime: { beginAt: '2026-08-08T00:00:00.000Z' },
        }, LOADING)
        thumbImg(g).fire('error')
        check('CD-2 ライブサムネが読めない時はまず静止サムネ（アイコンを先に出さない）',
            thumbImg(g).getAttribute('src') === 'https://nico.example/static.jpg',
            `src=${thumbImg(g).getAttribute('src')}`)

        // **アイコンを持たない配信者**でもローディングから復帰できること。
        // ⚠️ **これを守っているのは繋ぎ画像の入れ替えではなく、その直後の直接表示
        //    （`thumbLive === '0'`）**。繋ぎ先をアイコンだけに狭めても落ちないことを
        //    空振り検査で確認済み（2026-08-10）。ここは**経路をまたいだ挙動**の回帰止め。
        const h = makeProgramElement(kick({}), LOADING) // サムネもアイコンも無い
        check('CD-2 前提: 出せる絵が無ければローディング',
            thumbImg(h).getAttribute('src') === LOADING)
        applyProgramInfoToCard(h, kick({ thumb: THUMB })) // サムネだけ届いた（アイコンは無いまま）
        check('CD-2 アイコンが無くても、届いたサムネURLでローディングから復帰する',
            thumbImg(h).getAttribute('src') === THUMB,
            `src=${thumbImg(h).getAttribute('src')}`)
    } finally {
        globalThis.document = restore.document
        globalThis.window = restore.window
        globalThis.Image = restore.Image
        globalThis.chrome = restore.chrome
    }
}

async function widthRewriteSelectorGroup() {
    console.log('=== CB ビューポート幅の読み替えセレクタが誤爆しない ===')
    const { readFileSync } = await import('fs')
    const raw = readFileSync(new URL('../src/styles/kickPage.css', import.meta.url), 'utf8')
    // 🔴 **コメントを先に剥がすこと。** ここには「こう書いてはいけない」の例が日本語で
    //    書いてある。剥がさずに走査すると、その例を実物と読み違えて必ず落ちる
    //    （禁止事項を説明する自分のコメントに引っかかるのは通算3回目）。
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, ' ')
    check('CB （空振り防止）コメントを剥がせている（悪い例の記述を実物と読み違えない）',
        raw.includes('[class*="w-screen"]') && !css.includes('[class*="w-screen"]'),
        'コメント中の例が残っていないこと')

    // 🔴 **CSS ファイルから実物のセレクタを取り出して判定する。**
    //    ここに期待するセレクタを書き写すと、実装を変えた時に一緒に書き換えてしまい、
    //    「同じものを2箇所に書いて手で揃える」いつもの破れ方になる。
    const rules = []
    const re = /([^{}]+)\{([^}]*)\}/g
    let m
    while ((m = re.exec(css)) !== null) {
        const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim()
        if (!sel.includes('nns-kick-active')) continue
        if (!/\[class[~*]=/.test(sel)) continue
        rules.push({ sel, body: m[2] })
    }
    check('CB （空振り防止）読み替えの規則を CSS から取り出せている', rules.length >= 3,
        `${rules.length}件`)

    // `[class~="X"]` / `[class*="X"]` をブラウザと同じ意味で評価する
    const matches = (sel, cls) => {
        const tokens = cls.split(/\s+/).filter(Boolean)
        for (const part of sel.split(',')) {
            let ok = true
            const conds = [...part.matchAll(/\[class([~*])="([^"]+)"\]/g)]
            if (!conds.length) { ok = false }
            for (const [, op, val] of conds) {
                const hit = op === '~' ? tokens.includes(val) : cls.includes(val)
                if (!hit) { ok = false; break }
            }
            if (ok) return true
        }
        return false
    }
    // どの宣言が当たるか
    const applied = (cls) => {
        const out = {}
        for (const r of rules) {
            if (!matches(r.sel, cls)) continue
            for (const decl of r.body.split(';')) {
                const [k, v] = decl.split(':')
                if (k && v) out[k.trim()] = v.trim()
            }
        }
        return out
    }

    // --- 拾ってほしいもの ---
    for (const cls of ['w-xvw', 'w-screen', 'lg:w-screen', '3xl:w-xvw',
        'group-data-[sidebar=false]/main:w-xvw', 'flex flex-1 w-xvw items-center']) {
        check(`CB 幅を読み替える: "${cls}"`, !!applied(cls).width,
            JSON.stringify(applied(cls)))
    }

    // --- 🔴 拾ってはいけないもの（今回の発端） ---
    // `max-w-screen-*` は Tailwind の**固定値**。全幅へ広げると隣が潰れる。
    for (const cls of ['max-w-screen-lg', 'max-w-screen-sm', 'lg:max-w-screen-md',
        'mx-auto w-full max-w-screen-xl px-4']) {
        const got = applied(cls)
        check(`CB 🔴 固定値の上限を全幅にしない: "${cls}"`,
            !got.width && !got['max-width'], JSON.stringify(got))
    }
    for (const cls of ['w-full', 'max-w-lg', 'min-w-0', 'h-xvh', 'w-fit']) {
        check(`CB 関係ないクラスに当てない: "${cls}"`,
            Object.keys(applied(cls)).length === 0, JSON.stringify(applied(cls)))
    }

    // --- 下限・上限は「その性質だけ」当てる ---
    const minOnly = applied('min-w-xvw')
    check('CB 🔴 min-w-xvw には下限だけ当てる（width まで固定しない）',
        !!minOnly['min-width'] && !minOnly.width, JSON.stringify(minOnly))
    const maxOnly = applied('max-w-xvw')
    check('CB 🔴 max-w-xvw には上限だけ当てる', !!maxOnly['max-width'] && !maxOnly.width,
        JSON.stringify(maxOnly))
    check('CB min-w-screen も下限だけ', !!applied('min-w-screen')['min-width'] && !applied('min-w-screen').width)

    // --- 引く量は1本（CSS 側で計算し直さない） ---
    const calcs = [...css.matchAll(/calc\(100vw - ([^)]*)\)/g)].map((x) => x[1].trim())
    check('CB 🔴 引くのは --nns-kick-reserved ただ1つ（2箇所で同じ計算をしない）',
        // ⚠️ 取り出しは最初の ')' で切れるので 'var(--nns-kick-reserved' になる。閉じ括弧まで求めない。
        calcs.length >= 4 && calcs.every((c) => c === 'var(--nns-kick-reserved'),
        [...new Set(calcs)].join(' / '))

    // --- 🔴 部分一致が残っていないか（これが今回の原因そのもの） ---
    const broad = [...css.matchAll(/\[class\*="([^"]+)"\]/g)].map((x) => x[1])
    // ⚠️ 対象は**幅の読み替えの一族だけ**。モーダルの中央寄せ（`left-[50%]`）は別件で、
    //    あちらは `lg:` が付くので部分一致が要る（項目BW）。
    const widthFamily = broad.filter((v) => /w-screen|w-xvw/.test(v))
    const bad = widthFamily.filter((v) => !v.startsWith(':'))
    check('CB 🔴 幅の読み替えの部分一致は必ず ":" 始まり（単語の途中に当たらない）',
        bad.length === 0 && widthFamily.length >= 4, `悪い=${bad.join(' / ') || 'なし'} / 総数=${widthFamily.length}`)
    check('CB 🔴 ":max-w-screen" を足さない（lg:max-w-screen-md を拾ってしまう）',
        !css.includes(':max-w-screen'))
}

async function gridColumnFixGroup() {
    console.log('=== CA カードの列数を「使える幅」で決め直す ===')
    const { columnsOf, minWidthOf, pickColumns, planGridColumns, planFromMeasurement, collectColumnRules,
        applyGridColumnFix, clearAllGridFixes, gridFixCount, GRID_ATTR } =
        await import('../src/services/gridColumnFix.js')
    const { readFileSync } = await import('fs')
    const kpc = stripComments(readFileSync(new URL('../src/kickPage.js', import.meta.url), 'utf8'))

    // 🔴 **実測した値をそのまま使う**（2026-08-08・/following・利用者の実機）。
    //    期待値を実装から作らない。ここに書いてある数字は全部ログから写したもの。
    const VW = 1920
    const RESERVED = 702
    const EFFECTIVE = 1218 // 1920 - 702
    const OBSERVED = 7 // 実際に適用されていた列数
    const CONTAINER_W = 1078
    const GAP = 16

    // --- ① 値の読み取り ---
    check('CA repeat(4, minmax(0,1fr)) から 4 を読む', columnsOf('repeat(4, minmax(0, 1fr))') === 4)
    check('CA 🔴 px の並びは読まない（列数に読み替えると意味が変わる）',
        columnsOf('140.281px 140.281px 140.281px') === null)
    check('CA 🔴 auto-fill は読まない（本来こちらの出番が無い）',
        columnsOf('repeat(auto-fill, minmax(240px, 1fr))') === null)
    check('CA min-width を px から読む', minWidthOf('(min-width: 1600px)') === 1600)
    check('CA min-width を rem からも読む（Tailwind v4）', minWidthOf('(min-width: 96rem)', 16) === 1536)
    check('CA メディア指定が無ければ 0（常に効く）', minWidthOf('') === 0)

    // --- ② 実測どおりの規則表で、実測どおりの答えになるか ---
    // ログの class から起こした表。3xl は Kick 独自なので 1600px と仮定して両方試す。
    const mk = (list) => list.map(([min, cols], i) => ({ min, cols, index: i + 1 }))
    const REAL = mk([
        [0, 1],       // grid-cols-1
        [640, 2],     // sm:grid-cols-2
        [1024, 4],    // lg:grid-cols-4
        [1280, 4],    // xl:grid-cols-4
        [1280, 5],    // group-data-[sidebar=false]:xl:grid-cols-5
        [1536, 5],    // 2xl:grid-cols-5
        [1536, 6],    // group-data-[sidebar=false]:2xl:grid-cols-6
        [1600, 6],    // 3xl:grid-cols-6
        [1600, 7],    // group-data-[sidebar=false]:3xl:grid-cols-7
    ])
    check('CA 🔴 実測どおり、画面幅1920 で 7列と出る（読み方が合っている）',
        pickColumns(REAL, VW) === OBSERVED, `${pickColumns(REAL, VW)}列`)
    check('CA 🔴 使える幅1218 では 4列（これが当てたい値）',
        pickColumns(REAL, EFFECTIVE) === 4, `${pickColumns(REAL, EFFECTIVE)}列`)
    check('CA 同じ折り返し幅なら後に書いたほうが勝つ（CSS の順序）',
        pickColumns(mk([[1536, 5], [1536, 6]]), 1600) === 6)

    // 当てた後のカードの幅が、拡張なしの幅に近いこと（痩せが直る）
    const cardW = (n, w) => Math.round((w - (n - 1) * GAP) / n)
    const before = cardW(OBSERVED, CONTAINER_W)          // 140
    const after = cardW(4, CONTAINER_W)                  // 257
    const natural = cardW(OBSERVED, CONTAINER_W + RESERVED) // 拡張が無い時の 240
    check('CA 🔴 直すとカードの幅が「拡張なし」に近づく',
        before === 140 && after === 258 && natural === 241 && Math.abs(after - natural) < 40,
        `今${before}px → 直すと${after}px（拡張なしなら${natural}px）`)

    // --- ③ 答え合わせに落ちたら何もしない ---
    const plan = (o) => planGridColumns({ entries: REAL, observed: o, viewportWidth: VW, effectiveWidth: EFFECTIVE })
    check('CA 一致すれば当てる', plan(7).target === 4, JSON.stringify(plan(7)))
    check('CA 🔴 実際の列数と食い違ったら何もしない（理解できていない相手に触らない）',
        plan(5).target === null, JSON.stringify(plan(5)))
    check('CA 規則が読めなければ何もしない',
        planGridColumns({ entries: [], observed: 7, viewportWidth: VW, effectiveWidth: EFFECTIVE }).target === null)
    check('CA 変える必要が無ければ何もしない',
        planGridColumns({ entries: REAL, observed: 7, viewportWidth: VW, effectiveWidth: VW }).target === null)

    // 🔴 既定の折り返し表だけで読もうとすると失敗すること（＝CSS から読む必要があった証拠）
    const TW_ONLY = mk([[0, 1], [640, 2], [1024, 4], [1280, 4], [1536, 5]])
    check('CA 🔴 Tailwind 既定の表だけでは実測の7列を再現できない（だから CSS から読む）',
        pickColumns(TW_ONLY, VW) === 5 && pickColumns(TW_ONLY, VW) !== OBSERVED,
        `既定表の予測=${pickColumns(TW_ONLY, VW)}列 / 実際=${OBSERVED}列`)

    // --- ④ CSS からの収集（偽のスタイルシート） ---
    const mkSheet = (rules) => ({ cssRules: rules })
    const rule = (sel, value) => ({ selectorText: sel, style: { gridTemplateColumns: value } })
    const media = (cond, rules) => ({ conditionText: cond, cssRules: rules })
    const mkEl = (matches) => ({
        matches: (sel) => matches.includes(sel),
        getBoundingClientRect: () => ({ width: CONTAINER_W, height: 800, left: 798, top: 0 }),
        className: 'grid grid-cols-1',
        style: {},
    })
    const el = mkEl(['.grid-cols-1', '.lg\\:grid-cols-4', '.g\\:3xl\\:grid-cols-7'])
    const doc = {
        styleSheets: [mkSheet([
            rule('.grid-cols-1', 'repeat(1, minmax(0, 1fr))'),
            rule('.not-mine', 'repeat(9, minmax(0, 1fr))'),
            media('(min-width: 1024px)', [rule('.lg\\:grid-cols-4', 'repeat(4, minmax(0, 1fr))')]),
            media('(min-width: 1600px)', [rule('.g\\:3xl\\:grid-cols-7', 'repeat(7, minmax(0, 1fr))')]),
        ])],
    }
    const got = collectColumnRules(el, doc)
    check('CA CSS から、この要素に効く指定だけを集める（他人の規則は拾わない）',
        got.length === 3 && !got.some((e) => e.cols === 9), JSON.stringify(got))
    check('CA 🔴 @media の折り返し幅を規則に紐づけて読む',
        pickColumns(got, 1920) === 7 && pickColumns(got, 1218) === 4,
        `1920→${pickColumns(got, 1920)}列 / 1218→${pickColumns(got, 1218)}列`)

    // 🔴 別オリジンのスタイルシートは例外を投げる。**黙って飛ばして、触らない側に倒れること。**
    const hostile = { styleSheets: [{ get cssRules() { throw new Error('SecurityError') } }, ...doc.styleSheets] }
    check('CA 🔴 別オリジンの CSS で落ちない（読める分だけ使う）',
        collectColumnRules(el, hostile).length === 3)
    // 🔴 `adoptedStyleSheets` は `styleSheets` に入らない。見ないと丸ごと落とす。
    const adopted = {
        styleSheets: [],
        adoptedStyleSheets: [mkSheet([rule('.grid-cols-1', 'repeat(1, minmax(0, 1fr))')])],
    }
    check('CA 🔴 adoptedStyleSheets も見る（styleSheets には入らない）',
        collectColumnRules(el, adopted).length === 1,
        `${collectColumnRules(el, adopted).length}件`)

    check('CA 読めるものが1つも無ければ空（＝何もしない側へ）',
        collectColumnRules(el, { styleSheets: [{ get cssRules() { throw new Error('x') } }] }).length === 0)

    // --- ⑤ 当てる・戻す（DOM あり） ---
    clearAllGridFixes()
    const attrs = new Map()
    const live = {
        tagName: 'SECTION', className: 'grid grid-cols-1 lg:grid-cols-4',
        // 🔴 本物の Chrome は使用値（px の並び）を返す。実機ログの値をそのまま使う。
        _cols: '140.281px 140.281px 140.281px 140.297px 140.281px 140.281px 140.297px',
        style: {
            gridTemplateColumns: '',
            setProperty(p, v) { if (p === 'grid-template-columns') this.gridTemplateColumns = v },
            removeProperty(p) { if (p === 'grid-template-columns') this.gridTemplateColumns = '' },
        },
        matches: (sel) => ['.grid-cols-1', '.lg\\:grid-cols-4', '.g\\:3xl\\:grid-cols-7'].includes(sel),
        closest: () => null,
        getBoundingClientRect: () => ({ width: CONTAINER_W, height: 800, left: 798, top: 0 }),
        getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
        setAttribute: (n, v) => attrs.set(n, String(v)),
        removeAttribute: (n) => attrs.delete(n),
        hasAttribute: (n) => attrs.has(n),
    }
    const liveDoc = {
        ...doc,
        documentElement: {},
        querySelectorAll: () => [live],
    }
    const liveWin = {
        innerWidth: VW,
        getComputedStyle: (n) => {
            if (n !== live) return { fontSize: '16px' }
            // こちらが当てていればその列数ぶんの px 並びを、無ければ Kick 本来の並びを返す。
            const mine = /^repeat\((\d+),/.exec(live.style.gridTemplateColumns || '')
            const cols = mine
                ? Array.from({ length: Number(mine[1]) }, () => '257.5px').join(' ')
                : live._cols
            return { display: 'grid', gridTemplateColumns: cols }
        },
    }
    const run = (reserved) => applyGridColumnFix(reserved, { doc: liveDoc, win: liveWin })

    run(RESERVED)
    check('CA 🔴 実測の場面で 7列 → 4列 に当たる',
        live.style.gridTemplateColumns === 'repeat(4, minmax(0, 1fr))',
        `grid-template-columns=${live.style.gridTemplateColumns}`)
    check('CA 印を残す（自分が当てたものだけ後で戻せるように）',
        live.getAttribute(GRID_ATTR) === '4')

    run(RESERVED); run(RESERVED)
    check('CA 🔴 何周期回しても 4列のまま（自分の値を読み返して縮み続けない）',
        live.style.gridTemplateColumns === 'repeat(4, minmax(0, 1fr))',
        `grid-template-columns=${live.style.gridTemplateColumns}`)

    // 🔴 Kick 自身が inline で持っていたら奪わないこと。
    //    こちらは測り直す前に必ず一度外すので、印を見ないと**他人の指定を消してしまう。**
    clearAllGridFixes()
    const theirs = { ...live }
    theirs.style = {
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        setProperty(p, v) { if (p === 'grid-template-columns') this.gridTemplateColumns = v },
        removeProperty(p) { if (p === 'grid-template-columns') this.gridTemplateColumns = '' },
    }
    const theirAttrs = new Map()
    theirs.getAttribute = (n) => (theirAttrs.has(n) ? theirAttrs.get(n) : null)
    theirs.setAttribute = (n, v) => theirAttrs.set(n, String(v))
    theirs.removeAttribute = (n) => theirAttrs.delete(n)
    theirs.hasAttribute = (n) => theirAttrs.has(n)
    const theirDoc = { ...liveDoc, querySelectorAll: () => [theirs] }
    // 🔴 **当てない判断をした時**で試すこと。当てる道だとどちらにせよ上書きするので、
    //    「奪ったかどうか」が見えない（最初そう書いて、変異を1つ取り逃した）。
    //    ここでは実際の列数を 5 にして答え合わせをわざと外し、触らない判断をさせる。
    const theirWin = {
        innerWidth: VW,
        getComputedStyle: (n) => (n === theirs
            ? { display: 'grid', gridTemplateColumns: '200px 200px 200px 200px 200px' } // 5列＝予測の7列と食い違う
            : { fontSize: '16px' }),
    }
    // ⚠️ **CSS の答え合わせと実測の推定を両方断らせる必要がある。**
    //    サイドバーを 40px にすると痩せ方がわずか（96%）なので、実測側は「変えない」と判断する。
    applyGridColumnFix(40, { doc: theirDoc, win: theirWin })
    check('CA 🔴 触らない判断をした時、Kick 自身が inline で置いた指定を奪わない',
        theirs.style.gridTemplateColumns === 'repeat(3, minmax(0, 1fr))' && !theirAttrs.has(GRID_ATTR),
        `grid-template-columns=${theirs.style.gridTemplateColumns} / 印=${theirAttrs.get(GRID_ATTR)}`)
    check('CA 触らない判断をした相手は抱え込まない', gridFixCount() === 0, `管理数=${gridFixCount()}`)
    clearAllGridFixes()

    // 🔴 Kick が状態を切り替えた（class が変わった）ら、**自分の値を外してから**測り直すこと。
    //    外さないと「自分が当てた4列」を Kick 本来の値だと思い込み、答え合わせに落ちて手放す。
    run(RESERVED)
    live.className = live.className + ' data-changed'
    run(RESERVED)
    check('CA 🔴 class が変わっても、自分の値と答え合わせしない（測り直す）',
        gridFixCount() === 1 && live.style.gridTemplateColumns === 'repeat(4, minmax(0, 1fr))',
        `管理数=${gridFixCount()} / ${live.style.gridTemplateColumns}`)
    live.className = 'grid grid-cols-1 lg:grid-cols-4'

    run(0) // 連携を切った
    check('CA 連携を切ったら戻す',
        live.style.gridTemplateColumns === '' && !live.hasAttribute(GRID_ATTR) && gridFixCount() === 0)

    // サイドバーを細くすると列数も戻る
    run(RESERVED)
    const at702 = live.style.gridTemplateColumns
    run(120) // 使える幅 1800 → 7列のまま＝当てる必要なし
    check('CA サイドバーが細ければ元の列数に戻る（余計なことをしない）',
        at702 === 'repeat(4, minmax(0, 1fr))' && live.style.gridTemplateColumns === '',
        `702→${at702} / 120→${live.style.gridTemplateColumns || '(なし)'}`)
    clearAllGridFixes()

    // --- ⑤-2 CSS が読めない時の逃げ道（実機で styleSheets を読めなかった。項目BZ-2） ---
    const est = (containerWidth, gap, reserved, observed) =>
        planFromMeasurement({ containerWidth, gap, reserved }, observed)
    check('CA-2 🔴 実測の場面: 器1078・7列・サイドバー702 → 4列（CSS 版と同じ答え）',
        est(CONTAINER_W, GAP, RESERVED, OBSERVED) === 4, `${est(CONTAINER_W, GAP, RESERVED, OBSERVED)}列`)
    check('CA-2 🔴 わずかな痩せでは列を落とさない（サイドバー5px で 7列のまま）',
        est(CONTAINER_W, GAP, 5, OBSERVED) === null, `${est(CONTAINER_W, GAP, 5, OBSERVED)}`)
    // 🔴 **上限で挟んでいない。**「サイドバーぶんがある限り列は増えない」は算術で決まる
    //    （`器+gap = 列数 ×(1枚+gap)` がちょうど成り立つため）。挟むと死んだコードになるので、
    //    ここでは**総当たりで性質そのものを確かめる。**
    let grew = 0
    for (const w of [400, 700, 1078, 1600, 2400]) {
        for (const g of [0, 8, 16, 32]) {
            for (const rv of [1, 24, 120, 360, 702, 1200]) {
                for (const n of [2, 3, 4, 5, 6, 7, 8, 12]) {
                    const t = est(w, g, rv, n)
                    if (t !== null && t > n) grew++
                }
            }
        }
    }
    check('CA-2 🔴 どんな組み合わせでも列は増えない（960通り）', grew === 0, `増えた=${grew}件`)
    check('CA-2 器が本来のカード1枚より狭くても 1列は残す',
        est(200, 0, 100000, 4) === 1, `${est(200, 0, 100000, 4)}`)
    check('CA-2 サイドバーぶんが 0 なら何もしない', est(CONTAINER_W, GAP, 0, OBSERVED) === null)
    check('CA-2 器の幅が取れなければ何もしない', est(0, GAP, RESERVED, OBSERVED) === null)

    // 🔴 CSS が1つも読めない時に、逃げ道が使われること
    const fallback = planGridColumns({
        entries: [], observed: OBSERVED, viewportWidth: VW, effectiveWidth: EFFECTIVE,
        measured: { containerWidth: CONTAINER_W, gap: GAP, reserved: RESERVED },
    })
    check('CA-2 🔴 CSS を読めなくても実測から直す（別オリジン配信でも動く）',
        fallback.target === 4, JSON.stringify(fallback))

    // 🔴 CSS を読み違えた時も逃げ道へ回る
    const misread = planGridColumns({
        entries: REAL, observed: 5, viewportWidth: VW, effectiveWidth: EFFECTIVE,
        measured: { containerWidth: CONTAINER_W, gap: GAP, reserved: RESERVED },
    })
    check('CA-2 読み違えた時も実測から直す', misread.target !== null, JSON.stringify(misread))

    // 🔴 **「変える必要が無い」だけは逃げ道へ回さない。**
    //    あれは正しく読めた上での結論。推定で上書きすると、触らなくてよい相手を動かす。
    const noNeed = planGridColumns({
        entries: REAL, observed: 7, viewportWidth: VW, effectiveWidth: VW,
        measured: { containerWidth: CONTAINER_W, gap: GAP, reserved: RESERVED },
    })
    check('CA-2 🔴 CSS が「変える必要が無い」と言ったら、実測で上書きしない',
        noNeed.target === null, JSON.stringify(noNeed))

    // --- ⑥ 呼び出し位置（構造） ---
    check('CA 🔴 毎周期は走らせない（変わった時だけ）',
        /gridKey !== lastGridKey/.test(kpc) && /applyGridColumnFix\(/.test(kpc))
    // 🔴 **幅だけでは足りない**（利用者が実機で発見。BZ-3）。SPA で別ページから来ると
    //    器が作り直されて別物になるのに、幅は変わらないので走らずカードが小さいままだった。
    check('CA-3 🔴 ページが変わっても走る（pathname を見張っている）',
        /lastGridKey[\s\S]{0,200}location\.pathname/.test(kpc) || /location\.pathname[\s\S]{0,200}lastGridKey/.test(kpc))
    check('CA-3 🔴 器そのものが入れ替わっても走る（React の作り直し）',
        /gridEl !== lastGridEl/.test(kpc) && /querySelector\(/.test(kpc))
    check('CA-3 見張りは軽い方法で（querySelectorAll で全部数えない）',
        !/lastGridEl[\s\S]{0,120}querySelectorAll/.test(kpc))
    check('CA 連携を切る時に戻している',
        /isActive = false[\s\S]{0,600}clearAllGridFixes\(\)/.test(kpc))
    check('CA 🔴 SPA で作り替えられたら測り直す（覚え書きを捨てる）',
        /insertSidebar\(\)[\s\S]{0,600}lastGridKey = ''/.test(kpc))
}

async function fixedOverlayNudgeGroup() {
    console.log('=== BY 帯に潜り込む固定要素を実測して押す（小窓・モーダル） ===')
    const { nudgeFixedOverlays, clearAllNudges, nudgedCount, collectFixedNearStrip } =
        await import('../src/services/fixedOverlayNudge.js')
    const { readFileSync } = await import('fs')
    const kpc = stripComments(readFileSync(new URL('../src/kickPage.js', import.meta.url), 'utf8'))

    // 🔴 **期待値は実装の定数から作らない。**確保幅も押した後の位置もここに直接書く。
    //    実装の TOLERANCE_PX / PARKED_LEFT_PX / 採取点を import して組み立てると、
    //    実装が変わった時に検証も一緒に動いて、何も落ちなくなる。
    const RESERVED = 360
    const VH = 1080

    // 生えている margin-left を rect に反映する偽要素。
    // 🔴 **押した結果を測り直す形になっていること。**固定値を返す作りでは収束も往復も見えない。
    const mkEl = (o = {}) => {
        const attrs = new Map()
        const style = {
            marginLeft: '', transform: o.inlineTransform || '', left: o.inlineLeft || '',
            setProperty(p, v) { if (p === 'margin-left') this.marginLeft = v },
            removeProperty(p) { if (p === 'margin-left') this.marginLeft = '' },
        }
        return {
            nodeType: 1, tagName: o.tag || 'DIV', id: o.id || '', className: o.className || '',
            style, isConnected: o.isConnected !== false, parentElement: null,
            _pos: o.pos || 'fixed', _left: o.left ?? 0, _top: o.top ?? 0, _w: o.w ?? 400, _h: o.h ?? 300,
            _inSidebar: !!o.inSidebar,
            getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
            setAttribute: (n, v) => attrs.set(n, String(v)),
            removeAttribute: (n) => attrs.delete(n),
            hasAttribute: (n) => attrs.has(n),
            closest(sel) { return (this._inSidebar && sel === '#niconamasidebar-kick-root') ? {} : null },
            getBoundingClientRect() {
                const ml = Number.parseFloat(this.style.marginLeft) || 0
                return {
                    left: this._left + ml, right: this._left + ml + this._w,
                    top: this._top, bottom: this._top + this._h,
                    width: this._w, height: this._h,
                }
            },
            ml() { return Number.parseFloat(this.style.marginLeft) || 0 },
        }
    }
    const env = (els, { fullscreen = null, hidden = false, bodyChildren = [] } = {}) => ({
        doc: {
            fullscreenElement: fullscreen, hidden,
            // 🔴 既定は**空**。portal 経由の収集で素通りさせると、格子の検証が全部空振りになる。
            body: { children: bodyChildren },
            // 🔴 **本物と同じく「その点を覆っている要素だけ」を返すこと。**
            //    全部返す作りにすると、採取点の置き方（画面の端に寄ったものへ届くか・
            //    押し出した後も見え続けるか）を一切検証できなくなる。
            elementsFromPoint: (x, y) => els.filter((el) => {
                const r = el.getBoundingClientRect()
                return x >= r.left && x < r.right && y >= r.top && y < r.bottom
            }),
        },
        win: { innerHeight: VH, getComputedStyle: (el) => ({ position: el._pos }) },
    })
    const run = (els, reserved = RESERVED, opts = {}) =>
        nudgeFixedOverlays(reserved, { ...env(els, opts), ...opts })

    // --- ① 画面の下の角に出る小窓（今回の発端。番組視聴中にフォローページを開くと出る） ---
    // 🔴 位置は実物どおり「下から 16px・高さ 180px」＝ y は 884〜1064。
    //    採取点が粗い（0/25/50/75/100%）と**どの点も掠らない。**
    clearAllNudges()
    const mini = mkEl({ left: 16, top: VH - 180 - 16, w: 320, h: 180 })
    run([mini])
    check('BY 🔴 画面の下の角の小窓に採取点が届く（粗い格子だと漏れる）',
        mini.ml() > 0, `margin-left=${mini.ml()}`)
    check('BY 🔴 帯に潜り込んだ小窓を押し出す（左端 16 → 360）',
        mini.ml() === 344 && mini.getBoundingClientRect().left === 360,
        `margin-left=${mini.ml()} 左端=${mini.getBoundingClientRect().left}`)

    // --- ② 収束する。押した後も採取点から見え続ける（reserved より右にも点を置いているか） ---
    run([mini]); run([mini]); run([mini])
    check('BY 🔴 何周期回しても二重に押さない（344 のまま）',
        mini.ml() === 344, `margin-left=${mini.ml()}`)
    // 🔴 **管理数で見ても意味が無い**（覚えている集合が必ず 1 を返すので、採取点を消しても通る）。
    //    押し終えた位置に居る要素が採取点に掛かるかを、収集そのものに聞く。
    const pushed = mkEl({ left: RESERVED, top: 300, w: 400, h: 300 })
    check('BY 🔴 押し出した先（左端＝帯の右端）にも採取点がある（無いと 500ms ごとに往復する）',
        collectFixedNearStrip(RESERVED, env([pushed]).doc, { innerHeight: VH }).has(pushed))

    // --- ③ それでも見失った場合に押し戻さない（覚えている相手は毎回測り直す） ---
    run([])
    check('BY 🔴 採取点から消えても戻さない（500ms ごとの往復を防ぐ）',
        mini.ml() === 344 && nudgedCount() === 1, `margin-left=${mini.ml()} 管理数=${nudgedCount()}`)

    // --- ④ React が style だけ剥がしたら当て直す。**二重には押さない** ---
    mini.style.marginLeft = ''
    run([mini])
    check('BY 🔴 style を剥がされたら当て直す（688 にならず 344）',
        mini.ml() === 344, `margin-left=${mini.ml()}`)

    // 🔴 **剥がし方は「空にする」だけではない。** React が margin-left を 0px で上書きすると、
    //    style は数値のまま属性と食い違う。ここを 0 とみなさないと natural を負に見積もって
    //    「画面外に退避している」と判定し、**押し直さないまま隠れ続ける。**
    mini.style.marginLeft = '0px'
    run([mini])
    check('BY 🔴 style を 0px で上書きされても当て直す（空文字だけが剥がし方ではない）',
        mini.ml() === 344, `margin-left=${mini.ml()}`)
    // --- ⑤ 触ってはいけない相手。**全部、採取点に掛かる位置に置く**（掛からないと素通りで空振り） ---
    clearAllNudges()
    const outside = mkEl({ left: 364, w: 300, h: 300 })          // 既に帯の外
    const popper = mkEl({ left: 0, w: 400, h: 300, inlineTransform: 'translate(100px, 40px)' })
    const jsLeft = mkEl({ left: 0, w: 400, h: 300, inlineLeft: '20px' })
    const parked = mkEl({ left: -300, w: 400, h: 300 })          // 画面外で待機
    const tiny = mkEl({ left: 0, w: 20, h: 300 })                // 細すぎる
    const notFixed = mkEl({ left: 0, w: 400, h: 300, pos: 'absolute' })
    const inSb = mkEl({ left: 0, w: 400, h: 300, inSidebar: true })
    const sbRoot = mkEl({ left: 0, w: 400, h: 300, id: 'niconamasidebar-kick-root' })
    const all5 = [outside, popper, jsLeft, parked, tiny, notFixed, inSb, sbRoot]
    // 空振り防止: そもそも採取点に掛かっているか（掛かっていなければ検証になっていない）
    const e5 = env(all5).doc
    const reached = new Set()
    for (const x of [4, 60, 116, 172, 228, 284, 340, 364]) {
        for (const y of [10, 130, 324, 540, 756, 950, 1070]) {
            for (const el of e5.elementsFromPoint(x, y)) reached.add(el)
        }
    }
    check('BY （空振り防止）触らない相手はすべて採取点に掛かっている',
        all5.every((el) => reached.has(el)), `届いた数=${reached.size}/${all5.length}`)

    run(all5)
    check('BY 帯の外に居るものは触らない', outside.ml() === 0)
    // 🔴 **インラインで座標を持っていても、食い込んでいるなら押す**（BY-2）。
    //    小窓は掴んで動かせる。掴んだ瞬間に Kick がインライン座標を書くので、
    //    ここで手放すと**サイドバーの裏に置かれて二度と出てこない**（裏では掴めない）。
    check('BY-2 🔴 インライン transform を持っていても、裏に居るなら押し出す',
        popper.ml() === 360, `margin-left=${popper.ml()}`)
    check('BY-2 🔴 インライン left を持っていても、裏に居るなら押し出す',
        jsLeft.ml() === 360, `margin-left=${jsLeft.ml()}`)
    check('BY 🔴 画面外に退避しているもの（left:-300）を引きずり出さない', parked.ml() === 0)
    check('BY 細すぎるもの（計測用の不可視要素）は触らない', tiny.ml() === 0)
    check('BY fixed でないものは触らない', notFixed.ml() === 0)
    check('BY サイドバーの中身は触らない', inSb.ml() === 0)
    check('BY サイドバーのルート自身は触らない', sbRoot.ml() === 0)
    // ⚠️ インライン座標の2つ（popper / jsLeft）は**押す側**に回った（BY-2）。0 ではなく 2 が正しい。
    //    ここを 0 のままにすると、BY-2 を入れた瞬間に落ちて「退行した」と読み違える。
    check('BY 押す相手はインライン座標の2件だけ（他は抱え込まない）', nudgedCount() === 2,
        `管理数=${nudgedCount()}`)

    // --- ⑤-2 portal で body 直下／その子に差し込まれたもの（当たり判定に掛からなくても拾う） ---
    clearAllNudges()
    const portal = mkEl({ left: 0, top: 200, w: 400, h: 300 })
    const deep = mkEl({ left: 0, top: 600, w: 400, h: 300 })
    const holder = mkEl({ left: 0, top: 600, w: 400, h: 300, pos: 'static' })
    holder.children = [deep]
    run([], RESERVED, { bodyChildren: [portal, holder] }) // 当たり判定では一切見つからない
    check('BY 🔴 portal で body 直下に出たものは、採取点に当たらなくても拾う',
        portal.ml() === 360, `margin-left=${portal.ml()}`)
    check('BY portal の1階層下も拾う', deep.ml() === 360, `margin-left=${deep.ml()}`)

    // --- ⑤-3 掴んで動かしている最中は触らない（BY-2。利用者が実機で発見） ---
    clearAllNudges()
    // 🔴 **採取点に掛かる位置に置くこと。**far right（600 など）だと一度も観測されず、
    //    「触らない」ではなく「見ていない」で通る。前回位置を覚えている前提が崩れる。
    const dragged = mkEl({ left: 364, top: 200, w: 320, h: 180 })
    run([dragged])                                    // 帯の外に居る。押す必要なし
    check('BY-2 動かす前: 帯の外に居るので触らない', dragged.ml() === 0)
    check('BY-2 （空振り防止）動かす前にちゃんと観測している',
        collectFixedNearStrip(RESERVED, env([dragged]).doc, { innerHeight: VH }).has(dragged))

    // 掴んでサイドバーの裏へ運ぶ。**運んでいる最中に押すとカーソルから 360px 飛ぶ。**
    dragged._left = 300; run([dragged], RESERVED, { pointerActive: true })
    check('BY-2 🔴 掴んでいる間は押さない（小窓がカーソルから飛ぶ）', dragged.ml() === 0,
        `margin-left=${dragged.ml()}`)
    dragged._left = 40;  run([dragged], RESERVED, { pointerActive: true })
    check('BY-2 🔴 裏まで運ばれても、掴んでいる間は押さない', dragged.ml() === 0)

    // 離した。🔴 **離した瞬間の位置は、最後に記録した周期の位置とは違う**
    //    （周期は 500ms おき・離すのはその間）。ここを同じ位置で試すと
    //    「移動中」判定を素通りしてしまい、**穴が見えない。**
    dragged._left = 24
    run([dragged], RESERVED, { ignoreMoving: true }) // pointerup 相当
    check('BY-2 🔴 離したその場で裏から出てくる（次の周期を待たない）',
        dragged.getBoundingClientRect().left === 360,
        `margin-left=${dragged.ml()} 左端=${dragged.getBoundingClientRect().left}`)

    // ⚠️ 逆に、離していない（＝ふつうの周期）なら移動中として素通りすること。
    clearAllNudges()
    const still = mkEl({ left: 364, top: 200, w: 320, h: 180 })
    run([still]); still._left = 24; run([still])
    check('BY-2 ふつうの周期では、移動直後は押さない（ignoreMoving は離した時だけ）',
        still.ml() === 0, `margin-left=${still.ml()}`)

    // --- ⑤-4 動いている最中は触らない（他所が位置を計算し直しているものと押し合わない） ---
    clearAllNudges()
    const slide = mkEl({ left: 40, top: 200, w: 320, h: 180 })
    run([slide])                                      // 初見は「止まっている」扱い＝すぐ押す
    check('BY-2 初めて見た相手はすぐ押す（1周期＝最悪500ms 待たせない）', slide.ml() === 320,
        `margin-left=${slide.ml()}`)

    // 🔴 **裏を返すと「初めて帯に入ってきた相手が移動中か」は判別できない。**
    //    採取は帯の近くしか見ていないので、遠くから運ばれてきた相手には前回位置が無い。
    //    掴んで運ぶ場合は `pointerActive` が守る。**移動中ガードだけに頼らないこと。**
    clearAllNudges()
    const arriving = mkEl({ left: 24, top: 500, w: 320, h: 180 })
    run([arriving], RESERVED, { pointerActive: true })
    check('BY-2 🔴 遠くから掴んで運ばれてきた初見の相手も、掴んでいる間は押さない',
        arriving.ml() === 0, `margin-left=${arriving.ml()}`)
    clearAllNudges(); slide.style.marginLeft = ''
    run([slide]); slide._left = 100; run([slide])     // 2周期目で位置が変わった＝移動中
    check('BY-2 🔴 動いている最中は押し直さない（向こうと押し合わない）',
        slide.ml() === 320, `margin-left=${slide.ml()}`)
    run([slide])                                      // 止まった
    check('BY-2 止まったら押し直す', slide.ml() === 260, `margin-left=${slide.ml()}`)

    // --- ⑥ 帯の幅が変わったら追従する（開閉・ドラッグ） ---
    clearAllNudges()
    const modal = mkEl({ left: 0, w: 800, h: 500 })
    run([modal], 360)
    const at360 = modal.ml()
    run([modal], 500)
    check('BY 帯が広がったら押す量も増える（360→500）',
        at360 === 360 && modal.ml() === 500, `${at360} → ${modal.ml()}`)
    run([modal], 24) // 閉じた状態（ハンドルのぶんだけ）
    check('BY 閉じたら押す量も減る（ハンドルのぶんまで）', modal.ml() === 24, `margin-left=${modal.ml()}`)

    // --- ⑦ 全画面・連携OFF では全部戻す。裏タブでは戻さない ---
    clearAllNudges()
    const fs1 = mkEl({ left: 0, w: 800, h: 500 })
    run([fs1])
    const beforeFs = fs1.ml()
    run([fs1], RESERVED, { fullscreen: fs1 })
    check('BY 🔴 全画面表示に入ったら押した指定を全部戻す',
        beforeFs === 360 && fs1.ml() === 0 && nudgedCount() === 0, `${beforeFs} → ${fs1.ml()}`)

    clearAllNudges()
    const off = mkEl({ left: 0, w: 800, h: 500 })
    run([off])
    run([off], 0)
    check('BY 連携を切った（確保幅0）ら押した指定を戻す', off.ml() === 0 && nudgedCount() === 0)

    clearAllNudges()
    const bg = mkEl({ left: 0, w: 800, h: 500 })
    run([bg])
    run([bg], RESERVED, { hidden: true })
    check('BY 🔴 裏タブでは測らないが、押した指定は外さない（表に戻った瞬間に潜り込まない）',
        bg.ml() === 360, `margin-left=${bg.ml()}`)

    // --- ⑧ 自分で付けていない margin-left は奪わない ---
    clearAllNudges()
    // 🔴 **採取点に掛かる位置に置くこと。**left:400 だと 1本も当たらず、
    //    「触っていない」のではなく「見てすらいない」状態で通ってしまう（空振り）。
    // ⚠️ 自前の margin-left 40px ぶん右へ出る。**それを足した位置**が採取点に掛かるように置く。
    const theirs = mkEl({ left: 324, w: 300, h: 300 })
    theirs.style.marginLeft = '40px'
    const seen = collectFixedNearStrip(RESERVED, env([theirs]).doc, { innerHeight: VH }).has(theirs)
    run([theirs])
    check('BY （空振り防止）その相手を実際に見ている', seen)
    check('BY 🔴 Kick が自分で当てた margin-left は奪わない', theirs.style.marginLeft === '40px',
        `margin-left=${theirs.style.marginLeft}`)

    // --- ⑨ 消えた要素を握り続けない ---
    clearAllNudges()
    const gone = mkEl({ left: 0, w: 800, h: 500 })
    run([gone])
    gone.isConnected = false
    run([])
    check('BY DOM から消えた要素は管理から外す', nudgedCount() === 0, `管理数=${nudgedCount()}`)
    clearAllNudges()

    // --- ⑩ 呼び出し位置（構造） ---
    check('BY 定期の突き合わせから押している',
        /reconcileTimer\s*=\s*setInterval[\s\S]*?nudgeFixedOverlays\(/.test(kpc))
    check('BY 開閉でも押し直している（次の周期を待たない）',
        /function setOpen\([\s\S]*?nudgeFixedOverlays\(/.test(kpc))
    check('BY 🔴 連携を切る時に戻している（body の寄せを外すだけでは戻らない）',
        /isActive = false[\s\S]{0,400}clearAllNudges\(\)/.test(kpc))
    check('BY-2 ポインタの上下を見張っている',
        /addEventListener\('pointerdown'/.test(kpc) && /addEventListener\('pointerup'/.test(kpc))
    check('BY-2 🔴 離した時にその場で押し直す（次の周期を待たない）',
        /pointerActive = false[\s\S]{0,200}nudgeFixedOverlays\(/.test(kpc))
    // 🔴 渡していないと「移動中」で素通りし、**離しても次の周期まで出てこない。**
    check('BY-2 🔴 離した時の呼び出しには ignoreMoving を渡す',
        /pointerActive = false[\s\S]{0,200}ignoreMoving:\s*true/.test(kpc))
    check('BY-2 🔴 ウィンドウ外で離した取りこぼしを拾う（pointercancel / blur）',
        /pointercancel/.test(kpc) && /addEventListener\('blur'/.test(kpc))
    // ⚠️ `[^)]*` では `reservedWidth()` の ")" を跨げず、渡していても落ちる（実際に踏んだ）。
    check('BY-2 押す時に pointerActive を渡している',
        /nudgeFixedOverlays\([\s\S]{0,120}pointerActive/.test(kpc))
    // 🔴 ドラッグ中に毎フレーム走らせない。applyHostStyles は pointermove から呼ばれる。
    const ahs = kpc.match(/function applyHostStyles\(\)[\s\S]*?\n\}/)
    check('BY 🔴 applyHostStyles の中では押さない（ドラッグ中に毎フレーム走る）',
        !!ahs && !/nudgeFixedOverlays/.test(ahs[0]))
}

async function kickAutoNext() {
    const { readFileSync } = await import('fs')
    const rd = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')
    const kpc = stripComments(rd('kickPage.js'))
    const ks = stripComments(rd('services/kickStatus.js'))
    console.log('=== BU kick.com の自動移動 ===')

    const { fetchKickChannelState, observeKickProgramEnd, KICK_LIVE, KICK_OFFLINE, KICK_UNKNOWN } =
        await import('../src/services/kickStatus.js')

    // --- 応答の読み方（実測した形をそのまま並べる。2026-08-07） ---
    const origFetch = globalThis.fetch
    const withBody = (body, ok = true, status = 200) => {
        globalThis.fetch = async () => ({ ok, status, json: async () => body })
    }
    try {
        withBody({ livestream: { id: 1, is_live: true, viewer_count: 3 } })
        check('BU livestream がオブジェクト → 配信中', await fetchKickChannelState('x') === KICK_LIVE)
        withBody({ livestream: null })
        check('BU livestream が null → 配信なし', await fetchKickChannelState('x') === KICK_OFFLINE)
        withBody({ livestream: { id: 1, is_live: false } })
        check('BU is_live が false なら配信なし', await fetchKickChannelState('x') === KICK_OFFLINE)

        // 🔴 ここが要。**分からない時に「配信なし」へ倒さないこと。**
        //    倒すと、回線が不安定なだけで勝手にページを移る。
        withBody({ id: 1, slug: 'x' }) // livestream キーそのものが無い＝仕様が変わった
        check('BU livestream キーが無い → 分からない（配信なしにしない）',
            await fetchKickChannelState('x') === KICK_UNKNOWN)
        withBody({}, false, 403)
        check('BU HTTP エラー → 分からない', await fetchKickChannelState('x') === KICK_UNKNOWN)
        globalThis.fetch = async () => { throw new Error('network') }
        check('BU 通信エラー → 分からない', await fetchKickChannelState('x') === KICK_UNKNOWN)
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })
        check('BU JSON が壊れていても分からない扱い', await fetchKickChannelState('x') === KICK_UNKNOWN)
        check('BU slug が空なら聞きに行かない', await fetchKickChannelState('') === KICK_UNKNOWN)

        // --- 動いてよい場面・いけない場面 ---
        const runObserver = async (states, opts) => {
            let i = 0
            globalThis.fetch = async () => {
                const s = states[Math.min(i++, states.length - 1)]
                return { ok: true, status: 200, json: async () => ({ livestream: s === 'live' ? { is_live: true } : null }) }
            }
            let fired = 0
            const stop = observeKickProgramEnd(() => 'ch', () => { fired++ }, { intervalMs: 5000, ...opts })
            // 即時の1回ぶんだけ進める（setInterval は待たない）
            await new Promise((r) => setTimeout(r, 30))
            stop()
            return fired
        }
        check('BU 自分で開いたチャンネルが配信していないだけでは動かない',
            await runObserver(['offline'], {}) === 0,
            '動くと、配信前のチャンネルを開いた瞬間に連れて行かれる')
        check('BU 自動移動で飛んできた先が配信していなければ動く',
            await runObserver(['offline'], { arrivedByAutoNext: true }) === 1)
        check('BU 分からない時は動かない',
            await (async () => {
                globalThis.fetch = async () => ({ ok: false, status: 500 })
                let fired = 0
                const stop = observeKickProgramEnd(() => 'ch', () => { fired++ }, { intervalMs: 5000, arrivedByAutoNext: true })
                await new Promise((r) => setTimeout(r, 30))
                stop()
                return fired
            })() === 0)
        check('BU チャンネルページでなければ聞きに行かない',
            await (async () => {
                let calls = 0
                globalThis.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ livestream: null }) } }
                const stop = observeKickProgramEnd(() => '', () => {}, { intervalMs: 5000, arrivedByAutoNext: true })
                await new Promise((r) => setTimeout(r, 30))
                stop()
                return calls
            })() === 0)
        // --- レイド（配信者が終了時にリスナーをまとめて別チャンネルへ送る機能）との干渉 ---
        // 🔴 向こうもモーダルとカウントダウンを出す。こちらが先に決着すると
        //    **配信者が決めた移動先を奪う。**
        const runTwice = async (states, opts) => {
            let i = 0
            globalThis.fetch = async () => {
                const s = states[Math.min(i++, states.length - 1)]
                return { ok: true, status: 200, json: async () => ({ livestream: s === 'live' ? { is_live: true } : null }) }
            }
            let fired = 0
            const stop = observeKickProgramEnd(() => 'ch', () => { fired++ }, { intervalMs: 5000, ...opts })
            await new Promise((r) => setTimeout(r, 30))   // 1回目（配信中）
            await new Promise((r) => setTimeout(r, 5030)) // 2回目（配信なし）
            stop()
            return fired
        }
        check('BU 目の前で終わった直後は動かない（レイドに先を譲る）',
            await runTwice(['live', 'offline'], { graceMs: 60000 }) === 0,
            'こちらが先に決着すると、配信者が決めたレイド先を奪う')
        check('BU 猶予を過ぎれば動く',
            await runTwice(['live', 'offline'], { graceMs: 0 }) === 1)
        // 飛んできた先が最初から配信なしの時はレイドが飛んでくる余地が無いので待たない
        check('BU 飛んできた先が配信なしなら猶予を待たない',
            await runObserver(['offline'], { arrivedByAutoNext: true, graceMs: 60000 }) === 1,
            '待つと、終わったチャンネルを延々と見せることになる')
    } finally {
        globalThis.fetch = origFetch
    }


    // --- 作りの縛り ---
    check('BU Kick の DOM を見ていない',
        !/querySelector|getElementsByClassName|MutationObserver/.test(ks),
        'kick.com の DOM に依存すると、向こうの実装変更で無言で壊れる')
    check('BU 不在（フォロー中一覧から消えた）で終了を導いていない',
        !/lastKickPrograms/.test(ks) && !/livestreams/.test(ks),
        'ニコ生側が事故を起こしてやめた形（doc/09 項目BF-2）')
    // ⚠️ 語の有無では駄目。代入だけ残して**門番の if を消しても通ってしまう**（実際にそうなった）。
    check('BU 取得を重ねない', /if \(stopped \|\| inFlight\) return/.test(ks),
        '応答は実測 1117ms まで伸びる。門番が無いと取得が積み上がる')
    check('BU ページ側のイベントを購読していない',
        !/addEventListener/.test(ks), 'visibilitychange 等を足さない方針（D6）')

    // --- kickPage 側の配線 ---
    check('BU kick.com が自動移動の監視を持つ', /startKickAutoNext\(\)/.test(kpc))
    check('BU 設定が ON の時だけ監視する', /options\.autoNextProgram !== 'on'\) return/.test(kpc))
    check('BU 設定の切り替えを受ける', /changes\.autoNextProgram/.test(kpc))
    check('BU 連携を切ったら監視も止める',
        /function teardown\(\)[\s\S]{0,200}?stopKickAutoNext\(\)/.test(kpc))
    // 🔴 印を読み切ってから監視を始めること。監視は開いた直後に1回聞くので、
    //    先に始めると「飛んできた先か」が未確定のまま最初の判定が走る。
    check('BU 飛んできた印を読み切ってから監視を始める',
        /await consumeAutoNextHopMark\([\s\S]{0,80}?startKickAutoNext\(\)/.test(kpc),
        '順序が逆だと、飛んできた先が配信していなくても1周期ぶん動かない')
    check('BU モーダルと移動先選びはニコ生と共有',
        /new AutoNextManager\(/.test(kpc) && /startWatcher\(/.test(kpc),
        '自前で作ると仕様が食い違う')
    // 予約パスの一覧を2つ持たない（watchTargetIdOf が唯一の定義）
    check('BU チャンネル判定は共有実装を使う',
        /watchTargetIdOf\(location\.href\)/.test(kpc) && !/'browse'/.test(kpc),
        '予約パスの一覧が2つあると片方だけ古くなる')

    // --- オリジンをまたぐ印 ---
    const st = stripComments(rd('services/status.js'))
    // ⚠️ 定数名で見ること。キーの文字列は宣言側にしか出ないので、`autoNextHop` を
    //    set の近くで探すと**書いてあっても見つからない**（実際に一度そうなった）。
    check('BU 飛んだ印は拡張のストレージにも置く',
        /function markAutoNextHop\([\s\S]{0,400}?chrome\.storage\.local\.set\(\{[\s\S]{0,80}?AUTO_NEXT_HOP_STORE_KEY/.test(st),
        'sessionStorage はオリジンごとなので、ニコ生 ⇄ kick.com では読めない')
    check('BU 印は飛び先の識別子で照合する',
        /mark\.to === currentId/.test(st),
        '照合しないと、残った印が後から自分で開いたページに効いてしまう')
    check('BU 印は1回で使い切る', /chrome\.storage\.local\.remove\(/.test(st))

    // --- 固定オーバーレイ（モーダル）がサイドバーの下へ潜り込まないか ---
    // 🔴 `position: fixed` はビューポート基準。幅の読み替えだけでは位置が直らない。
    //    実測（2026-08-07）: 暗幕は `fixed inset-0`、本体は `fixed … lg:left-[50%] translate-x-[-50%]`。
    const kickCss = cssRules(rd('styles/kickPage.css'))
    const backdrop = kickCss.find((r) => /\[class~="inset-0"\]/.test(r.sel))
    check('BU 画面いっぱいの固定オーバーレイを可視領域へ寄せる',
        !!backdrop && /left:\s*var\(--nns-kick-reserved\)\s*!important/.test(backdrop.body),
        'サイドバーの下へ潜り込む')
    const centered = kickCss.find((r) => /\[class\*="left-\[50%\]"\]/.test(r.sel))
    check('BU 中央寄せのダイアログは可視領域の中央へ',
        !!centered && /left:\s*calc\(50% \+ var\(--nns-kick-reserved\) \/ 2\)\s*!important/.test(centered.body),
        '可視領域は [reserved, 100vw] なので中心は 50% + reserved/2。左端が reserved/2 だけ隠れる')
    for (const r of [backdrop, centered]) {
        // ⚠️ **絞り込み（`:not(...)`）が増えるのは構わない。** 守りたいのは
        //    「`nns-kick-active` が前提であること」だけ。先頭の字面で縛ると、
        //    条件を足した時に意図と関係なく落ちる（実際に踏んだ）。
        check(`BU 連携が有効な間だけ当てる: ${r ? r.sel.slice(0, 40) : 'なし'}`,
            !!r && /^html\.nns-kick-active(:not\([^)]*\))?[\s.[]/.test(r.sel),
            '連携を切った後も Kick のモーダルを動かし続けてはいけない')
    }

    // --- レイドで移された時に引きはがさないか（AutoNextManager 側の関門） ---
    // 🔴 kick.com は SPA。レイドはページを破棄せず URL だけ変えるので、カウントダウンの
    //    タイマーが**生き残る**。関門が無いと、レイド先に着いた数秒後にこちらが引きはがす。
    const anm = stripComments(rd('managers/AutoNextManager.js'))
    check('BU 移動前に「まだ同じ配信を見ているか」を確かめる',
        /const startedAtId = watchTargetIdOf\(location\.href\)/.test(anm)
        && /const movedAway = \(\)/.test(anm))
    for (const [where, re] of [
        ['毎秒の見張り', /setInterval\(\(\) => \{[\s\S]{0,300}?if \(movedAway\(\)\) return abandon\(/],
        ['満了時', /!this\.appState\.autoNext\.canceled && !movedAway\(\)/],
        ['サムネクリック', /const goNow = \(\) => \{[\s\S]{0,300}?if \(movedAway\(\)\) return abandon\(/],
    ]) {
        check(`BU 関門がある: ${where}`, re.test(anm),
            'レイドで移された直後に、こちらが別の配信へ引きはがす')
    }
    // 取りやめは「利用者の取り消し」と別扱い。次の終了ではまた動けること。
    check('BU 取りやめても次の終了では動ける（取り消しとは別扱い）',
        /const abandon = \([\s\S]{0,300}?autoNext\.scheduled = false/.test(anm),
        'scheduled を立てたままにすると、そのページでは二度と動かない')
}

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
    //   (2) カードを増減させる経路が**あらかじめ決めた場所にしか無い**
    //       → 「どこかで勝手に増減している」経路が存在しない
    //
    // 🔴 **(2) を「1箇所だけ」で数えるのはやめた（2026-08-04）。** Kick 連携で
    //    ページが2本（ニコ生 / kick.com）になり、それぞれに差し替え地点ができた。
    //    数を数えるだけだと、増えたら緩めるしかなくなって検査が形骸化する。
    //    **許可した場所の一覧と完全一致するか**を見る形にした。
    //    新しい増減経路が増えれば「予期しない場所」として落ちるので、目的は保たれている。
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
    // 許可した増減経路。**ここに無い場所で DOM を増減させたら落ちる。**
    // 増やす時は「なぜそこで増減してよいのか」を書いてから足すこと。
    const ALLOWED_MUTATIONS = [
        // ニコ生ページのリスト差し替え（唯一の描画地点）
        'UpdateManager.js .replaceChildren(',
        // kick.com ページのリスト差し替え（同上。ページが分かれているぶん2箇所目）
        'kickPage.js .replaceChildren(',
        // kick.com ページのサイドバー枠の組み立て・撤去。カードの増減ではない
        'kickPage.js .innerHTML =',
        'kickPage.js .innerHTML =',
        'kickPage.js .remove()',
        // 権限を外した直後に Kick のカードだけ撤去する。
        // 次の更新周期でも消えるが、それだと最大120秒残って「無効にしたのに消えない」に見える
        'optionsHandler.js .remove()',
    ].sort()
    const found = mutations.slice().sort()
    const missing = ALLOWED_MUTATIONS.filter((m) => !found.includes(m))
    const unexpected = found.filter((m) => !ALLOWED_MUTATIONS.includes(m))
    check('AO カードの増減は許可した場所だけで起きている',
        unexpected.length === 0 && missing.length === 0,
        unexpected.length ? `予期しない増減: ${unexpected.join(' , ')}`
            : missing.length ? `許可した経路が消えている: ${missing.join(' , ')}（差し替え自体が無くなっていないか）`
                : `${found.length}件すべて既知`)

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

    // --- 削除（フォローAPIも手放した番組が消えること。notifybox 経由の削除は項目BF で別に見る）---
    h.state.followPrograms = h.state.followPrograms.filter((p) => p.id !== 'lv200')
    // ⚠️ **lv100 の行は残すこと**（まだ放送中の設定）。空にすると項目BF の終了判定が働いて
    //    lv100 まで消え、「フォローAPI由来の削除」を見ているつもりが別の経路を見ることになる。
    h.state.notifyRows = [{ id: 100, title: 'x' }]
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

    // 🔴 **放送中の番組は notifybox にも載っているのが実際の姿。**
    //    片方にしか載せないと、項目BF-2 の終了確認が「notifybox に居ない＝疑い」として
    //    詳細APIに問い合わせる。**それは正しい動作**なので、下の「詳細APIを呼んでいない」
    //    （＝サムネ/名前の補完で呼んでいないこと）を見たい検証では、両方に載せて土台を揃える。
    const syncNotify = () => {
        h.state.notifyRows = h.state.followPrograms.map((p) => ({ id: String(p.id).replace(/^lv/, ''), title: p.title || 'x' }))
    }

    // --- channel のアイコン: フォローAPIは programProvider.icon を空で返す（socialGroup から拾う） ---
    // ⚠️ **ここでカウンタを0に戻す。** この検査が見たいのは「サムネ／名前の補完で詳細APIを
    //    呼んでいないこと」だけ。項目BF-2 の終了確認も同じAPIを使うので、通算で数えると
    //    別の経路の呼び出しまで拾ってしまう（実際にそれで落ちた）。区間ごとに見ること。
    h.state.calls.detail = 0
    h.state.followPrograms = [apiProgram({ id: 'lv555', beginAtMs: T + 5000, providerType: 'channel', name: 'チャンネルX' })]
    syncNotify()
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
    // ⚠️ **ここでカウンタを0に戻す。** この検査が見たいのは「サムネ／名前の補完で詳細APIを
    //    呼んでいないこと」だけ。項目BF-2 の終了確認も同じAPIを使うので、通算で数えると
    //    別の経路の呼び出しまで拾ってしまう（実際にそれで落ちた）。区間ごとに見ること。
    h.state.calls.detail = 0
    h.state.followPrograms = [apiProgram({ id: 'lv666', beginAtMs: T + 6000, fixedImage: true })]
    syncNotify()
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
    // ⚠️ **ここでカウンタを0に戻す。** この検査が見たいのは「サムネ／名前の補完で詳細APIを
    //    呼んでいないこと」だけ。項目BF-2 の終了確認も同じAPIを使うので、通算で数えると
    //    別の経路の呼び出しまで拾ってしまう（実際にそれで落ちた）。区間ごとに見ること。
    h.state.calls.detail = 0
    h.state.followPrograms = [
        apiProgram({ id: 'lv100', beginAtMs: T + 3000, viewers: 1 }),
        apiProgram({ id: 'lv300', beginAtMs: T + 1000, viewers: 1 }),
        apiProgram({ id: 'lv400', beginAtMs: T + 9000, viewers: 1 }),
    ]
    syncNotify()
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

    check('この区間で詳細API(fetchProgramInfo)は呼ばれていない（補完待ちで描画が遅れない）', h.state.calls.detail === 0,
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
    await fadeLayerStatic()
    console.log('')
    await invalidated()
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
    await flippedTrap()
    console.log('')
    await newProgramThumb()
    console.log('')
    await twoDisplayPaths()
    console.log('')
    await loopKeepsUpWithManyCards()
    console.log('')
    await momentumScore()
    console.log('')
    await momentumRanking()
    console.log('')
    await commentWeightShape()
    console.log('')
    await danmakuRanking()
    console.log('')
    await programEndConfirmation()
    await endedRecheckDoesNotRefetch()
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
    await cardIdentity()
    console.log('')
    await bothPagesSameSpec()
    await kickSidebarMovesAsOnePiece()
    await settingsSegmentOrder()
    await autoUpdateOff()
    await serviceTabs()
    await cardSize()
    await autoNextTarget()
    await kickAutoNext()
    await fixedOverlayNudgeGroup()
    await gridColumnFixGroup()
    await widthRewriteSelectorGroup()
    await sidebarPlacementGroup()
    await kickPlaceholderIconGroup()
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
