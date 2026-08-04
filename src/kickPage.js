/**
 * kick.com 用のサイドバー（2本目のエントリ）。
 *
 * 🔴 **これは `main.js` とは別のバンドル。** ビルドが単一 IIFE のため、Rollup は複数エントリを
 *    iife 形式で出せない。`vite.kickpage.config.js` で2本目のビルドとして `dist/kickpage.js` を作る。
 *
 * 🔴 **静的な content_scripts で宣言していない。** そうすると kick.com が必須のホスト権限になり、
 *    既存ユーザーの拡張が更新時に無効化される。SW が `chrome.scripting.registerContentScripts` で
 *    動的に登録する（連携ONで登録・OFFで解除）。
 *
 * 【main.js と何が違うか】
 * ニコ生固有の機能は持たない: 自動移動・番組終了検知・notifybox・フォロー中ページのスクレイプ・
 * 動くサムネ。持っているのは「フォロー中の放送を一覧して、クリックで飛ぶ」という芯だけ。
 * カードの描画・並び替え・サムネのクロスフェードは main.js と同じモジュールを共有している。
 *
 * 【レイアウト】
 * ニコ生では視聴ページの DOM を組み替えて場所を空けているが、Kick の DOM 構造には依存しない。
 * 画面右に固定配置し、開いている間だけ `<html>` に `margin-right` を付けて内容を寄せる。
 */

import './styles/main.css'
import './styles/kickPage.css'
import { buildSidebarShell, makeProgramElement, applyRankAttributes, applyProgramInfoToCard, setDwellMinutes, syncServiceTabs, setupServiceTabHandlers } from './render/sidebar.js'
import { sortPrograms } from './utils/sorting.js'
import { fetchKickPrograms } from './services/kickSource.js'
import { mapApiProgramToInfo } from './services/followPageSource.js'
import { getOptions as getOptionsFromStorage, upsertProgramInfos } from './services/storage.js'
import { setupOptionsHandler } from './handlers/optionsHandler.js'
import { setProgramContainerWidth } from './ui/layout.js'
import { sidebarMinWidth } from './config/constants.js'

const SIDEBAR_ROOT_ID = 'niconamasidebar-kick-root'

// ⚠️ **main.js の defaultOptions と揃えること。**サイドバーの中身は両ページで同一仕様にする、
//    というのが利用者の要求（2026-08-04）。ここだけ欠けると設定画面のラジオが無選択になる。
//    自動移動（autoNextProgram）はニコ生専用だが、設定画面には出るので値は持っておく。
const defaultOptions = {
    programsSort: 'newest',
    autoOpen: '3',
    updateProgramsInterval: '120',
    sidebarWidth: 360,
    isOpenSidebar: false,
    sidebarTheme: 'light',
    autoNextProgram: 'off',
    animatedThumbnail: 'off',
    kickDisplayMode: 'mixed',
    dwellMinutes: 10,
}

let options = { ...defaultOptions }
let updateTimer = null
let reconcileTimer = null
let isOpen = false

// 寄せが打ち消されていないか確かめる間隔。短くしても目に見えて良くならず、
// 長いと打ち消された状態が見えてしまう。
const RECONCILE_MS = 500

/** 拡張が無効化された後もこのスクリプトは動き続ける。呼ぶ前に必ず確かめる。 */
function extensionAlive() {
    try {
        return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id
    } catch (e) {
        return false
    }
}

function runtimeUrl(path) {
    try {
        return extensionAlive() ? chrome.runtime.getURL(path) : ''
    } catch (e) {
        return ''
    }
}

/**
 * サイドバーを差し込む。既にあれば何もしない。
 *
 * ⚠️ Kick は Next.js の SPA。ページ遷移で React が body 配下を作り替えることがあるため、
 *    差し込み先は body 直下の**専用ルート**にして、消えたら作り直す（下の watchForRemoval）。
 */
function insertSidebar() {
    if (document.getElementById(SIDEBAR_ROOT_ID)) return

    const { sidebarHtml, sidebarLine, optionHtml } = buildSidebarShell({
        reloadImageURL: runtimeUrl('images/reload.png'),
        optionsImageURL: runtimeUrl('images/options.png'),
    })

    const root = document.createElement('div')
    root.id = SIDEBAR_ROOT_ID
    root.innerHTML = sidebarLine + sidebarHtml
    // 🔴 **`<body>` ではなく `<html>` 直下に置く。**
    //    ページを寄せるのに body へ `transform` を掛けるため、body の中に居ると
    //    サイドバー自身も一緒に動いてしまう（transform は子孫すべてに効く）。
    //    html 直下なら影響を受けない。
    document.documentElement.appendChild(root)

    const optionContainer = root.querySelector('#optionContainer')
    if (optionContainer) optionContainer.innerHTML = optionHtml

    // ⚠️ クラス名は `nicosidebar-light`（ダークが既定、ライトの時だけ付ける）。
    //    付ける先は **body ではなくこのルート**。body の外に居るので body のクラスは効かない。
    applyTheme(options.sidebarTheme)

    applyWidth(options.sidebarWidth)
    setOpen(options.isOpenSidebar === true, { save: false })
    wireControls(root)
}

/** いま適用されているサイドバー幅（px）。列数計算と body を寄せる量の両方がこれを使う。 */
function currentWidth() {
    return Math.max(sidebarMinWidth, Number(options.sidebarWidth) || defaultOptions.sidebarWidth)
}

/** テーマ。ダークが既定で、ライトの時だけクラスを付ける（ニコ生側と同じ規約）。 */
function applyTheme(theme) {
    const root = document.getElementById(SIDEBAR_ROOT_ID)
    if (root) root.classList.toggle('nicosidebar-light', theme === 'light')
}

function applyWidth(width) {
    options.sidebarWidth = Math.max(sidebarMinWidth, Number(width) || defaultOptions.sidebarWidth)
    // サイドバー自身の幅は CSS 変数で。body を寄せる量は applyShift がインラインで当てる。
    document.documentElement.style.setProperty('--nns-kick-width', currentWidth() + 'px')
    applyShift()
}

/**
 * ページ本体を右へ寄せる。**インラインスタイルで当てる。**
 *
 * 🔴 **`transform` で寄せる方式は捨てた（2026-08-04）。**
 *    「transform を掛けた要素は子孫の `position: fixed` の包含ブロックになる」ことを
 *    当てにしていたが、実機の計測で **body に transform が効いているのに子孫が x=0 に居る**
 *    という結果になり、当てが外れた。そもそも Kick のレイアウト要素は fixed ではなく
 *    static / relative だった（fixed は不可視の計測用 iframe だけ）ので、
 *    transform で固定要素を動かす必要自体が無かった。
 *
 * 🔴 **これだけでは足りない。** Kick は `w-xvw`（ビューポート幅）などの単位でレイアウトを
 *    組んでおり、body を細くしても中身は 100vw を主張し続ける。
 *    残り幅への読み替えは kickPage.css の `!important` ルールが担当する。**両方で1組。**
 */
function applyShift() {
    const body = document.body
    if (!body) return

    const w = currentWidth()
    const want = isOpen
        ? { marginLeft: `${w}px`, width: `calc(100vw - ${w}px)`, minWidth: '0px' }
        : { marginLeft: '', width: '', minWidth: '' }

    // 既に同じなら書かない（無駄な再レイアウトを避ける）。
    if (body.style.marginLeft !== want.marginLeft) body.style.marginLeft = want.marginLeft
    if (body.style.width !== want.width) body.style.width = want.width
    if (body.style.minWidth !== want.minWidth) body.style.minWidth = want.minWidth
}

/**
 * Kick 側が body の style / html の class を書き換えて寄せを打ち消したら、当て直す。
 *
 * 🔴 **MutationObserver で書き換えを検知しないこと。**
 *    2026-08-04、`body` の属性変化を監視して `applyShift()` を呼ぶ実装にしたところ、
 *    kick.com を開いた瞬間に**ブラウザごと操作不能になった**。
 *    MutationObserver のコールバックはマイクロタスクで走るため、こちらの書き戻しと
 *    相手の書き換えが噛み合うとフレームを1つも返さないまま延々と往復する。
 *    値が同じ時は書かないガードを入れても、**相手が書き換え続ける限り止まらない。**
 *
 *    そこで「変化に反応する」のをやめ、**一定間隔で現状を突き合わせて直すだけ**にした。
 *    取りこぼしても次の周期で直る。最悪でも `RECONCILE_MS` ぶん遅れるだけで、固まらない。
 */
function startReconciler() {
    stopReconciler()
    reconcileTimer = setInterval(() => {
        if (!extensionAlive()) return stopReconciler()

        // SPA 対策も兼ねる。Kick は Next.js App Router なので、遷移で body 配下が
        // 作り替えられうる。サイドバーごと消えていたら差し込み直す。
        if (!document.getElementById(SIDEBAR_ROOT_ID)) {
            insertSidebar()
            return
        }

        if (!isOpen) return
        // html の class は Kick 側のテーマ切り替えで丸ごと書き換えられることがある。
        document.documentElement.classList.add('nns-kick-open')
        applyShift()
    }, RECONCILE_MS)
}

function stopReconciler() {
    if (reconcileTimer) clearInterval(reconcileTimer)
    reconcileTimer = null
}

/**
 * 開閉。開いている間だけページ側を寄せる。
 *
 * ⚠️ 寄せるのは CSS（`html.nns-kick-open body` に transform）の仕事。ここではクラスを付けるだけ。
 *    JS で個別に style を書くと、Kick 側の再描画で消された時に戻せない。
 */
function setOpen(open, { save = true } = {}) {
    isOpen = !!open
    const root = document.getElementById(SIDEBAR_ROOT_ID)
    if (root) root.classList.toggle('is-open', isOpen)
    document.documentElement.classList.toggle('nns-kick-open', isOpen)
    applyShift()

    if (save && extensionAlive()) {
        options.isOpenSidebar = isOpen
        try {
            chrome.storage.local.set({ isOpenSidebar: isOpen })
        } catch (e) { /* 無効化済み */ }
    }
    if (isOpen) refreshPrograms()
}

function wireControls(root) {
    const toggle = root.querySelector('#sidebar_button')
    if (toggle) toggle.addEventListener('click', () => setOpen(!isOpen))

    const reload = root.querySelector('#reload_programs')
    if (reload) reload.addEventListener('click', () => refreshPrograms())

    // 設定は番組リストと入れ替え表示（ニコ生側と同じ挙動）
    const optionsBtn = root.querySelector('#setting_options')
    const body = root.querySelector('.sidebar_body')
    if (optionsBtn && body) {
        optionsBtn.addEventListener('click', (e) => {
            e.preventDefault()
            body.classList.toggle('show-settings')
        })
        const close = root.querySelector('#settings_close')
        if (close) close.addEventListener('click', () => body.classList.remove('show-settings'))
    }

    // 設定パネルの中身はニコ生ページと同一。保存も同じ経路（chrome.storage）なので
    // どちらで変えても両方に効く。
    setupOptionsHandler(options, (c) => sortPrograms(c, options.programsSort))
    setupServiceTabHandlers((count) => {
        const el = document.getElementById('program_count')
        if (el) el.textContent = String(count)
    })
}

/**
 * ニコ生のフォロー中番組を SW 経由で取得する。
 *
 * 🔴 **kick.com からは直接叩けない。** クロスオリジンで、ニコ生は任意のオリジンに
 *    CORS を許可していない。SW ならホスト権限（optional）でログインcookieごと叩ける。
 *    写像は `mapApiProgramToInfo` を共有しているので、ニコ生側と同じ形になる。
 */
async function fetchNicoPrograms() {
    let res
    try {
        res = await chrome.runtime.sendMessage({ type: 'nico:followed' })
    } catch (e) {
        return []
    }
    if (!res || res.ok !== true || !Array.isArray(res.programs)) return []

    const out = []
    for (const p of res.programs) {
        try {
            const info = mapApiProgramToInfo(p)
            if (info) out.push(info)
        } catch (e) { /* 1件の不正データでリスト全体を落とさない */ }
    }
    return out
}

/** 両サービスの番組を取得して描画する。中身の仕様はニコ生ページ側と同じ。 */
async function refreshPrograms() {
    if (!extensionAlive()) return stopTimer()

    const container = document.getElementById('liveProgramContainer')
    if (!container) return

    const [kickRes, nicoPrograms] = await Promise.all([fetchKickPrograms(), fetchNicoPrograms()])
    const kickPrograms = kickRes.ok ? kickRes.programs : []
    if (!kickRes.ok && nicoPrograms.length === 0) {
        // 両方取れない（権限が無い・未ログイン）は異常ではない。既存の表示を残して黙る。
        return
    }

    // 「盛り上がり」と到着レートは前回値との差分なので、保存を通さないと計算できない。
    // ⚠️ ここは kick.com の localStorage。ニコ生ページ側とは別に貯まるが、
    //    数周期で収束するので実害は無い（初回は開始からの平均で代用される）。
    if (nicoPrograms.length) upsertProgramInfos(nicoPrograms)

    const combined = nicoPrograms.concat(kickPrograms)

    // 新着順の基準。data-api-index はこの並びの位置を表す（比較器はニコ生側と共有）。
    const ordered = combined.sort((a, b) => {
        const ta = a.onAirTime && a.onAirTime.beginAt ? Date.parse(a.onAirTime.beginAt) : 0
        const tb = b.onAirTime && b.onAirTime.beginAt ? Date.parse(b.onAirTime.beginAt) : 0
        return tb - ta
    })

    const existing = new Map()
    for (const el of container.children) if (el && el.id) existing.set(el.id, el)

    const frag = document.createDocumentFragment()
    ordered.forEach((data, apiIndex) => {
        const id = String(data.id)
        let el = existing.get(id)
        if (el) {
            applyRankAttributes(el, data)
            applyProgramInfoToCard(el, data)
        } else {
            el = makeProgramElement(data, runtimeUrl('images/loading.gif'))
            if (!el) return
            applyRankAttributes(el, data)
        }
        el.setAttribute('data-api-index', String(apiIndex))
        frag.appendChild(el)
    })

    container.replaceChildren(frag)
    sortPrograms(container, options.programsSort)

    // 🔴 **列数の設定を忘れないこと。** これを呼ばないとカードが `width` 未設定のまま
    //    コンテナ幅いっぱいに広がり、どれだけ広げても1列になる（2026-08-04 に実際に踏んだ）。
    //    ニコ生側は描画のたびに呼んでいる。
    setProgramContainerWidth(null, currentWidth())

    // タブ分離／混在の出し分け。ニコ生ページ側と同じ関数・同じ仕様。
    const visible = syncServiceTabs(container, options.kickDisplayMode)

    const count = document.getElementById('program_count')
    if (count) count.textContent = String(visible)
}

function startTimer() {
    stopTimer()
    const sec = Math.max(30, Number(options.updateProgramsInterval) || 120)
    updateTimer = setInterval(() => {
        if (!extensionAlive()) return stopTimer()
        if (isOpen) refreshPrograms()
    }, sec * 1000)
}

function stopTimer() {
    if (updateTimer) clearInterval(updateTimer)
    updateTimer = null
}

/**
 * 連携が無効化された時の後始末。
 *
 * SW は `unregisterContentScripts` で**今後の注入**を止めるが、
 * **既に開いているページで動いているスクリプトは止まらない**。
 * 権限を外したのにサイドバーが残り、ページも寄ったままになるので、自分で畳む。
 */
function teardown() {
    stopTimer()
    stopReconciler()
    isOpen = false
    applyShift() // body のインラインスタイルを外して元の幅へ戻す
    document.documentElement.classList.remove('nns-kick-open')
    document.documentElement.style.removeProperty('--nns-kick-width')
    const root = document.getElementById(SIDEBAR_ROOT_ID)
    if (root) root.remove()
}

async function init() {
    if (!extensionAlive()) return
    options = await getOptionsFromStorage(defaultOptions)
    setDwellMinutes(options.dwellMinutes)

    insertSidebar()
    // 🔴 **この拡張の kick.com 側に MutationObserver は置かない。**
    //    書き換えに反応して書き戻す形にすると、相手の書き換えと噛み合った時に
    //    マイクロタスクの中で延々と往復し、**ブラウザごと固まる**（2026-08-04 に実際に発生）。
    //    差し込み直しも寄せの復帰も、この定期の突き合わせ1本に集約する。
    startReconciler()
    startTimer()

    try {
        chrome.runtime.onMessage.addListener((msg) => {
            if (!msg || msg.type !== 'kick:stateChanged') return
            if (!msg.granted) teardown()
        })
    } catch (e) { /* 拡張が無効化されている */ }

    try {
        chrome.storage.onChanged.addListener((changes) => {
            if (changes.sidebarTheme) {
                options.sidebarTheme = changes.sidebarTheme.newValue
                applyTheme(options.sidebarTheme)
            }
            if (changes.programsSort) {
                options.programsSort = changes.programsSort.newValue
                const container = document.getElementById('liveProgramContainer')
                if (container) sortPrograms(container, options.programsSort)
            }
            if (changes.dwellMinutes) {
                options.dwellMinutes = changes.dwellMinutes.newValue
                setDwellMinutes(options.dwellMinutes)
            }
            if (changes.updateProgramsInterval) {
                options.updateProgramsInterval = changes.updateProgramsInterval.newValue
                startTimer()
            }
            if (changes.kickDisplayMode) {
                options.kickDisplayMode = changes.kickDisplayMode.newValue
                const container = document.getElementById('liveProgramContainer')
                if (container) {
                    const visible = syncServiceTabs(container, options.kickDisplayMode)
                    const el = document.getElementById('program_count')
                    if (el) el.textContent = String(visible)
                }
            }
            if (changes.sidebarWidth) {
                applyWidth(changes.sidebarWidth.newValue)
                // 幅が変われば列数も変わる。
                const container = document.getElementById('liveProgramContainer')
                if (container) setProgramContainerWidth(null, currentWidth())
            }
        })
    } catch (e) { /* 無効化済み */ }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true })
} else {
    init()
}
