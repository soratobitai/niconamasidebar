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
 * ニコ生固有の機能は持たない: notifybox・フォロー中ページのスクレイプ。
 * **自動移動は 2026-08-07 から動く**（終了の見張り方だけ違う。doc/09 項目BU）。
 * カードの描画・並び替え・サムネのクロスフェードは main.js と同じモジュールを共有している。
 *
 * 【レイアウト】
 * ニコ生では視聴ページの DOM を組み替えて場所を空けているが、Kick の DOM 構造には依存しない。
 * 画面**左**に固定配置し、開いている間だけ `<body>` にインラインで `margin-left` と
 * `width: calc(100vw - 幅)` を当てて内容を寄せる（`applyShift`）。
 * それだけでは Kick のビューポート単位のレイアウトが 100vw を主張し続けるので、
 * kickPage.css の読み替えルールと**両方で1組**。
 */

import './styles/main.css'
import './styles/kickPage.css'
import { watchTargetIdOf, buildSidebarShell, makeProgramElement, applyRankAttributes, applyProgramInfoToCard, setDwellMinutes, syncServiceTabs, setKickNotice, setNicoNotice, NICO_NOTICE_NONE, NICO_NOTICE_AUTH, NICO_NOTICE_UNREACHABLE, setupServiceTabHandlers, updateThumbnailsFromStorage, setAnimThumbnailFeed, setThumbnailImageProxy, flipReorder, reapplyRankAttributes, releaseThumbnailBlobs, cardIdOf, setReloadButtonLoading, shouldOpenSidebarAtStart, autoUpdateIntervalMs } from './render/sidebar.js'
import { setAnimatedThumbnailEnabled, teardownAnimatedThumbnails, ingestAnimatedThumbnailFrame, isAnimatedThumbnailEnabled } from './render/animatedThumbnail.js'
import { sortPrograms } from './utils/sorting.js'
import { orderComparator } from './utils/programOrder.js'
import { fetchKickPrograms, isKickSessionLost, kickPageImageProxy } from './services/kickSource.js'
import { nudgeFixedOverlays, clearAllNudges } from './services/fixedOverlayNudge.js'
import { applyGridColumnFix, clearAllGridFixes } from './services/gridColumnFix.js'
import { mapApiProgramToInfo } from './services/followPageSource.js'
import { getOptions as getOptionsFromStorage, upsertProgramInfos, getProgramInfos, setSidebarWidth } from './services/storage.js'
import { setupOptionsHandler } from './handlers/optionsHandler.js'
import { AppState } from './core/AppState.js'
import { AutoNextManager } from './managers/AutoNextManager.js'
import { observeKickProgramEnd } from './services/kickStatus.js'
import { consumeAutoNextHopMark } from './services/status.js'
import { loadWatchHistory, recordWatch, currentOwnerKeyOnKickPage, startWatchHistorySync, isPageReload, startDwellPoints } from './services/watchHistory.js'
import { setProgramContainerWidth, setCardSize } from './ui/layout.js'
import { applySidebarPlacement, isOverlayPlacement, SIDEBAR_PLACEMENT_DEFAULT } from './ui/placement.js'
import { applyShowViewerCount } from './ui/viewerCount.js'
import { sidebarMinWidth, kickContentGap, updateThumbnailInterval, kickThumbnailInterval, reorderFlipDurationMs, minLoadingDurationMs, kickEndCheckIntervalMs, kickRaidGraceMs, defaultDwellMinutes, defaultCardSize, defaultShowViewerCount } from './config/constants.js'

const SIDEBAR_ROOT_ID = 'niconamasidebar-kick-root'

// ⚠️ **main.js の defaultOptions と揃えること。**サイドバーの中身は両ページで同一仕様にする、
//    というのが利用者の要求（2026-08-04）。ここだけ欠けると設定画面のラジオが無選択になる。
//    自動移動（autoNextProgram）は 2026-08-07 から kick.com でも動く（doc/09 項目BU）。
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
    kickActiveTab: 'nicolive', // 'mixed'（統合）| 'nicolive' | 'kick'
    // 🔴 **既定値を直書きしないこと**（main.js と同じ理由）。constants.js の default* が唯一の定義。
    dwellMinutes: defaultDwellMinutes,
    cardSize: defaultCardSize,
    sidebarPlacement: SIDEBAR_PLACEMENT_DEFAULT,
    showViewerCount: defaultShowViewerCount,
}

let options = { ...defaultOptions }
let updateTimer = null
let thumbTimer = null
let reconcileTimer = null
let isOpen = false
// 直近に取得した Kick の番組。サムネ更新ループへ渡すために持つ（storage には入れていない）。
let lastKickPrograms = []
// 直近に取得したニコ生の番組。取得に失敗した周期で「0件」に落とさず据え置くために持つ。
let lastNicoPrograms = []
// 更新中か。定期・ボタン・開閉・設定変更の4経路から呼ばれるので多重実行を防ぐ。
let isRefreshing = false
// document へ張るリスナーはサイドバーを差し込み直しても残るので、1度だけにする。
let escKeyWired = false
// ポインタのボタンが押されている間 true。**小窓を掴んで動かしている最中に押さない**ため
// （doc/09 項目BY-2）。掴んでいる最中に押すと、小窓がカーソルから 360px 離れて飛ぶ。
let pointerActive = false
let pointerWatchWired = false

// 列数を当て直した時の目印。**変わった時だけ走らせる**ための覚え書き。
// 🔴 毎周期やらないこと。CSS 規則の走査が入るので、定期処理に置く種類ではない。
let lastGridKey = ''
// 🔴 **幅だけを見張っていては足りない**（2026-08-08・利用者が実機で発見）。
//    Kick は SPA なので、別のページから来るとカードの器が React に作り直されて**別物**になる。
//    幅は変わらないので走らず、カードが小さいままだった（サイドバー幅を動かすと直る＝これが証拠）。
//    器そのものが入れ替わったかも見る。`querySelector` は最初の1件で止まるので軽い。
let lastGridEl = null
// 境界線を掴んでいる最中か。掴んだまま画面外で離された等の取りこぼしを
// 定期の突き合わせが拾えるようにするために持つ。
let isDraggingLine = false
// サイドバーが有効か。連携を切る（teardown）まで true。
// ⚠️ **`isOpen` と混同しないこと。**閉じていてもハンドルのぶんはページを寄せ続ける。
let isActive = false
// 自動移動。ニコ生ページと同じ Manager を使う（モーダル・カウントダウン・移動先選びを共有）。
// ⚠️ 終了の見張り方だけが違う。ニコ生は DOM、Kick は公開APIに聞く（kickStatus.js）。
let appState = null
let autoNextManager = null
// このページが「自動移動で飛んできた先」か。飛んできたのでなければ、
// **開いた時点で配信していなくても勝手に移動しない**（自分で開いたチャンネルを奪わない）。
let arrivedByAutoNext = false
// サムネ更新の tick 回数。Kick を混ぜる周期を数えるのに使う。
let thumbTickCount = 0
// おすすめ順: 直近で数えたチャンネル。Kick は SPA なのでページ読み込みが起きず、
// 起動時の1回だけでは**別のチャンネルへ移っても数えられない**。突き合わせで拾う。
// ⚠️ 二重に数えない仕組みは watchHistory 側（タブ単位）。ここは呼びすぎを避けるだけ。
let lastCountedOwnerKey = ''

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
 *    差し込み先は html 直下の**専用ルート**にして、消えたら作り直す（下の startReconciler）。
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
    //    ページを寄せるのに body へ `margin-left` と `width` を当てるため（applyShift）、
    //    body の中に居るとサイドバー自身もその内側に押し込まれて一緒に寄ってしまう。
    //    html 直下なら影響を受けない。
    // ⚠️ この root 自体が開閉で動く箱。中身とラインはこの中に貼り付いている（kickPage.css）。
    document.documentElement.appendChild(root)
    // 🔴 **applyWidth / setOpen より前に立てること。**これが false だと reservedWidth() が 0 を返し、
    //    ページが一切寄らない（＝ハンドルがコンテンツに被ったままになる）。
    isActive = true

    const optionContainer = root.querySelector('#optionContainer')
    if (optionContainer) optionContainer.innerHTML = optionHtml

    // ⚠️ クラス名は `nicosidebar-light`（ダークが既定、ライトの時だけ付ける）。
    //    付ける先は **body ではなくこのルート**。body の外に居るので body のクラスは効かない。
    applyTheme(options.sidebarTheme)

    applyWidth(options.sidebarWidth)
    // 「自動で開く」の解釈はニコ生ページと共有する。以前はここが `isOpenSidebar` 直読みで、
    // **設定を「ON（常に開く）」にしても効かなかった**（記憶と同じ動きになっていた）。
    setOpen(shouldOpenSidebarAtStart(options), { save: false })
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
    applyHostStyles()
}

/**
 * ページ本体の左に確保する幅（px）。**開いていても閉じていても空ける。**
 *
 * 🔴 **閉じている時も 0 ではない。** 閉じるとサイドバーは画面外へ出るが、開閉ハンドルは
 *    残る（ラインが `[0, 5]`、その中の開閉ボタンが `[0, 20]`）。0 にすると
 *    **閉じた状態でハンドルが Kick のコンテンツに被る**（2026-08-07 に利用者が指摘）。
 * ⚠️ 空ける量は**ラインの 5px ではなくボタンの 20px** を基準にした `kickContentGap`。
 */
function reservedWidth() {
    if (!isActive) return 0
    // 🔴 **重ねる時は 0。** ここを 0 にするだけで、body の寄せ・ビューポート単位の読み替え・
    //    固定要素の押し出し・カードの列数の決め直しが**すべて止まる**（どれも 0 で降りる作り）。
    //    置き方ごとに分岐を増やさない。
    if (isOverlayPlacement(options.sidebarPlacement)) return 0
    return (isOpen ? currentWidth() : 0) + kickContentGap
}

/**
 * `<html>` に当てている印（class と CSS 変数）と、ページ本体の寄せをまとめて当て直す。
 *
 * 🔴 **確保した幅は `--nns-kick-reserved` 1本で CSS へ渡すこと。**
 *    以前は CSS 側が `calc(100vw - var(--nns-kick-width) - var(--nns-kick-gap))` と
 *    **同じ計算をもう一度やっていた**。開閉で式が変わる（閉じている時はサイドバー幅を足さない）
 *    ようになった時点で、2箇所を手で揃える約束は必ず破れる。
 *    **JS が実際に body へ当てた数値をそのまま渡し、CSS は引くだけにする。**
 */
function applyHostStyles() {
    const root = document.documentElement
    // ⚠️ Kick 側のテーマ切り替えで html の class が丸ごと書き換わることがある。
    //    定期の突き合わせがここを呼び直すので、毎回 toggle でよい。
    root.classList.toggle('nns-kick-active', isActive)
    setHostVar('--nns-kick-width', currentWidth() + 'px')
    setHostVar('--nns-kick-reserved', reservedWidth() + 'px')
    applyShift()
}

/** 同じ値なら書かない。定期の突き合わせから毎回呼ばれるので、無駄な再計算を避ける。 */
function setHostVar(name, value) {
    const style = document.documentElement.style
    if (style.getPropertyValue(name) !== value) style.setProperty(name, value)
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
 *
 * ⚠️ **寄せる量は `reservedWidth()` が唯一の定義**（開いていても閉じていても空ける）。
 *    空いた帯はページ自身の背景が見える（body の背景がキャンバスへ伝播する）。
 * ⚠️ 寄せを外すのは**連携を切った時（`isActive === false`）だけ**。閉じただけでは外さない。
 */
function applyShift() {
    const body = document.body
    if (!body) return

    const w = reservedWidth()
    // 🔴 **寄せ幅が 0（＝重ねる設定）なら、指定ごと外すこと。**
    //    `margin-left: 0px` と `width: calc(100vw - 0px)` を当てても見た目は同じに見えるが、
    //    body に元から付いていた幅の指定を上書きしてしまう。**何も書かないのが正しい。**
    const want = isActive && w > 0
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
/**
 * 「今ボタンが押されているか」を見張る。**小窓は掴んで動かせる**（利用者が実機で発見）。
 *
 * ⚠️ 張り先は document・capture 付き。Kick 側が止めても届かせるため。
 *    SPA で差し込み直しても生き残るので**1度だけ**張る。
 * 🔴 離した直後にその場で押し直すこと。次の周期を待たせると、
 *    サイドバーの裏へ置いた小窓が最悪 500ms 見えないままになる。
 */
function watchPointerForNudge() {
    if (pointerWatchWired) return
    pointerWatchWired = true
    const opts = { capture: true, passive: true }
    document.addEventListener('pointerdown', () => { pointerActive = true }, opts)
    const release = () => {
        if (!pointerActive) return
        pointerActive = false
        try { nudgeFixedOverlays(reservedWidth(), { ignoreMoving: true }) } catch (e) { /* 押せなくても本体は止めない */ }

    }
    document.addEventListener('pointerup', release, opts)
    // ⚠️ ウィンドウ外で離すと pointerup が来ない。pointercancel と blur で取りこぼしを拾う
    //    （境界線のドラッグで同じ穴を踏んでいる。doc/09 項目BO）。
    document.addEventListener('pointercancel', release, opts)
    window.addEventListener('blur', release)
}

/**
 * 取得せずに順位だけ計算し直して並べ替える。
 * 「人気順の基準」を動かした時と、**別のタブで視聴回数が増えた時**に使う。
 * ⚠️ Kick は保存領域に入れていないので、直近の取得結果を足す。
 */
function rerankInPlace() {
    const c = document.getElementById('liveProgramContainer')
    if (!c) return
    const stored = getProgramInfos() || []
    reapplyRankAttributes(c, lastKickPrograms.length ? stored.concat(lastKickPrograms) : stored)
    sortPrograms(c, options.programsSort)
}

function startReconciler() {
    stopReconciler()
    watchPointerForNudge()
    reconcileTimer = setInterval(() => {
        if (!extensionAlive()) return stopReconciler()

        // 掴んでいないのに「ドラッグ中」の印が残っていたら剥がす。
        // pointer capture の取りこぼし（掴んだままハンドルごと差し替えられた等）で
        // ここに落ちる。付いたままだと開閉のアニメが死んだままになる。
        if (!isDraggingLine) document.documentElement.classList.remove('nns-kick-dragging')

        // おすすめ順: SPA でチャンネルを移った時にも数える（ページ読み込みが起きないため）。
        // ⚠️ 自動移動で飛んできた直後は数えない。その判定は起動時に済んでいる。
        // 🔴 ここで `arrivedByAutoNext` を見ないこと。あれは**このページに来た時**の話で、
        //    ずっと true のまま残る。見てしまうと、飛んできた後に**自分で選んだ**チャンネルまで
        //    数えられなくなる。最初のチャンネルは起動時に処理済み（下で印を置いてある）。
        const ownerKey = currentOwnerKeyOnKickPage()
        if (ownerKey && ownerKey !== lastCountedOwnerKey) {
            lastCountedOwnerKey = ownerKey
            recordWatch(ownerKey)
        }


        // SPA 対策も兼ねる。Kick は Next.js App Router なので、遷移で body 配下が
        // 作り替えられうる。サイドバーごと消えていたら差し込み直す。
        if (!document.getElementById(SIDEBAR_ROOT_ID)) {
            insertSidebar()
            // 🔴 **差し込み直したら動くサムネを張り直すこと。**
            //    ホバーのリスナーは `#liveProgramContainer` に付いており、SPA で作り直されると
            //    新しいコンテナには付かない。`enabled` フラグは立ったままなので取得だけ走り、
            //    **ホバーしても動かない**状態になる（初回配線で踏んだのと同じ形）。
            setAnimatedThumbnailEnabled(false)
            setAnimatedThumbnailEnabled(options.animatedThumbnail === 'on')
            // 🔴 ページが作り替わった＝カードの器も別物。覚え書きを捨てて測り直させる。
            lastGridKey = ''
            lastGridEl = null
            return
        }

        // 🔴 **開いている時だけ当て直す形にしないこと。** 閉じていてもハンドルのぶんは
        //    ページを寄せているので、打ち消されたまま戻らなくなる。
        applyHostStyles()

        // カードの列数を、ウィンドウ幅ではなく実際に使える幅で決め直す（doc/09 項目BZ・BZ-2）。
        // ⚠️ 走らせるのは「変わった時」だけ。毎周期やると CSS 規則の走査が走り続ける。
        //    見張るのは3つ: 画面幅・使える幅・**今のページと器そのもの**（SPA 対策）。
        let gridEl = null
        try { gridEl = document.querySelector('[class*="grid-cols-"]') } catch (e) { /* 無ければ null */ }
        const gridKey = window.innerWidth + '|' + reservedWidth() + '|' + location.pathname
        if (gridKey !== lastGridKey || gridEl !== lastGridEl) {
            lastGridKey = gridKey
            lastGridEl = gridEl
            try { applyGridColumnFix(reservedWidth()) } catch (e) { /* 直せなくても本体は止めない */ }
        }

        // 帯に潜り込んだ固定要素（モーダル・番組視聴中の小窓）を測って押す。
        // 🔴 **ここ（定期の突き合わせ）からだけ呼ぶこと。** `applyHostStyles` の中に入れると
        //    境界線のドラッグ中に pointermove のたびに走る。採取は 15 点の当たり判定なので
        //    1回は軽いが、毎フレームやる種類の処理ではない。ドラッグ後は次の周期で揃う。
        try { nudgeFixedOverlays(reservedWidth(), { pointerActive }) } catch (e) { /* 押せなくても本体は止めない */ }
    }, RECONCILE_MS)
}

function stopReconciler() {
    if (reconcileTimer) clearInterval(reconcileTimer)
    reconcileTimer = null
}

/**
 * 開閉。開いている間だけページ側を寄せる。
 *
 * ⚠️ サイドバー側の移動は CSS の仕事。ここでは `is-open` を付けるだけで、
 *    **動くのは root 1枚**（中身とラインはその箱に貼り付いている）。
 *    2つを別々に動かすと、メインスレッドが詰まった時に分離する（kickPage.css の説明を参照）。
 * ⚠️ ページ本体の寄せだけはインラインで当てる。CSS に書くと Kick 側のインライン style に負ける。
 */
function setOpen(open, { save = true } = {}) {
    isOpen = !!open
    const root = document.getElementById(SIDEBAR_ROOT_ID)
    if (root) root.classList.toggle('is-open', isOpen)
    // 開閉ボタンの矢印の向きと、境界線のリサイズカーソル。**ニコ生ページと同じクラスを使う**
    // （main.css の `.sidebar_arrow_re` / `.col_resize`）。付け忘れると開いても矢印が
    // 「開く向き」のままで、境界線を掴めることにも気付けない。
    const arrow = root && root.querySelector('#sidebar_arrow')
    if (arrow) arrow.classList.toggle('sidebar_arrow_re', isOpen)
    const line = root && root.querySelector('#sidebar_line')
    if (line) line.classList.toggle('col_resize', isOpen)
    applyHostStyles()
    // 開閉で帯の幅が変わる。次の周期（最悪 500ms）を待たずにここでも押し直す。
    // 待たせると、開いた直後にモーダルが半分隠れたまま一拍置いて動く。
    try { nudgeFixedOverlays(reservedWidth(), { pointerActive }) } catch (e) { /* 押せなくても開閉は続ける */ }

    if (save && extensionAlive()) {
        options.isOpenSidebar = isOpen
        try {
            chrome.storage.local.set({ isOpenSidebar: isOpen })
        } catch (e) { /* 無効化済み */ }
    }
    if (isOpen) refreshPrograms()
}

/**
 * 境界線をドラッグしてサイドバーの幅を変える（ニコ生ページの `enableSidebarLine` と同じ操作感）。
 *
 * ニコ生側は `#sidebar` の style を直接いじるが、こちらは幅の出どころが CSS 変数
 * `--nns-kick-width` の1本なので `applyWidth` を呼ぶだけでよい（サイドバー・ハンドルの位置・
 * ページの寄せ幅がまとめて追従する）。
 *
 * ⚠️ 張り先は root の中の `#sidebar_line`。差し込み直しでハンドルごと作り直されるので、
 *    リスナーも一緒に消える＝積み上がらない。
 *
 * 🔴 **mouse ではなく pointer イベント＋`setPointerCapture` を使うこと。**
 *    2026-08-07 まで `mousemove` / `mouseup` を documentElement に張っていた。
 *    **ウィンドウの外へポインタを出して離すと `mouseup` が来ない**ため、リスナーが
 *    張られたまま残り、以降はボタンを押していなくてもカーソルを動かすだけで幅が
 *    変わり続けた（`nns-kick-dragging` も付いたまま＝アニメが死んだまま）。
 *    capture を取れば枠外で離しても `pointerup` はこの要素に届き、OS にポインタを
 *    取り上げられた場合は `pointercancel` になる。どちらも `lostpointercapture` に集まる。
 */
function enableSidebarLineDrag(root) {
    const line = root.querySelector('#sidebar_line')
    if (!line) return

    let startX = 0
    let startWidth = 0

    const onMove = (e) => {
        // サイドバーは画面左。右へ引くほど広くなる（ニコ生側と同じ式）。
        // ⚠️ 上限を切る。kick.com は本体を `calc(100vw - 幅 - 余白)` で寄せているので、
        //    画面幅を越えるとページ側の幅が 0 以下になって中身が潰れる。
        //    ⚠️ 余白のぶんも引くこと。忘れるとページ側に残るのが 240px を切る。
        const max = Math.max(sidebarMinWidth, (window.innerWidth || 0) - 240 - kickContentGap)
        applyWidth(Math.min(max, startWidth + (e.clientX - startX)))
        const container = document.getElementById('liveProgramContainer')
        if (container) setProgramContainerWidth(null, currentWidth())
    }

    // ⚠️ 複数の経路（lostpointercapture / pointerup / pointercancel）から呼ばれる。
    //    何度呼ばれても壊れないよう、最初の1回で全部畳む。
    const endDrag = () => {
        if (!isDraggingLine) return
        isDraggingLine = false
        document.documentElement.classList.remove('nns-kick-dragging')
        line.removeEventListener('pointermove', onMove)
        line.removeEventListener('lostpointercapture', endDrag)
        document.documentElement.removeEventListener('pointerup', endDrag)
        document.documentElement.removeEventListener('pointercancel', endDrag)
        // 保存はニコ生ページと同じ経路。どちらで変えても両方に効く。
        if (extensionAlive()) setSidebarWidth(currentWidth())
    }

    line.addEventListener('pointerdown', (e) => {
        if (!isOpen) return
        if (e.button !== 0) return // 左ボタン以外では掴まない
        // ハンドルの中の開閉ボタンはドラッグ開始にしない（クリックを潰さないため）
        if (e.target && (e.target.id === 'sidebar_button' || e.target.id === 'sidebar_arrow')) return
        e.preventDefault()
        e.stopPropagation()

        startX = e.clientX
        startWidth = currentWidth()
        isDraggingLine = true
        // 🔴 **掴んでいる間はアニメを切ること。** 開閉用の transition（.18s）が付いたままだと
        //    幅がひと呼吸遅れて追従し、掴んでいる感触が無くなる。
        document.documentElement.classList.add('nns-kick-dragging')

        try { line.setPointerCapture(e.pointerId) } catch (err) { /* 取れなくても下の保険で終われる */ }
        line.addEventListener('pointermove', onMove)
        line.addEventListener('lostpointercapture', endDrag)
        // capture が取れなかった場合の保険。取れていればこちらは届かず、endDrag が外す。
        document.documentElement.addEventListener('pointerup', endDrag)
        document.documentElement.addEventListener('pointercancel', endDrag)
    })
}

function wireControls(root) {
    const toggle = root.querySelector('#sidebar_button')
    if (toggle) toggle.addEventListener('click', () => setOpen(!isOpen))

    const reload = root.querySelector('#reload_programs')
    if (reload) reload.addEventListener('click', () => refreshPrograms())

    enableSidebarLineDrag(root)

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
        // Esc で設定を閉じて番組リストへ戻る（ニコ生ページと同じ）。
        // ⚠️ 張り先が document なので、SPA でサイドバーを差し込み直しても**生き残る**。
        //    毎回張ると積み上がるので1度だけにし、その時々の .sidebar_body を引き直す。
        if (!escKeyWired) {
            escKeyWired = true
            document.addEventListener('keydown', (e) => {
                if (e.key !== 'Escape') return
                const b = document.querySelector(`#${SIDEBAR_ROOT_ID} .sidebar_body`)
                if (b && b.classList.contains('show-settings')) b.classList.remove('show-settings')
            })
        }
    }

    // 設定パネルの中身はニコ生ページと同一。保存も同じ経路（chrome.storage）なので
    // どちらで変えても両方に効く。
    setupOptionsHandler(
        options,
        (c) => sortPrograms(c, options.programsSort),
        () => { refreshPrograms() },
        // 「人気順の基準」。**取得はせず**その場で順位を計算し直す。
        // Kick は保存領域に入れていないので、直近の取得結果を足す。
        (minutes) => {
            setDwellMinutes(minutes)
            rerankInPlace()
        },
    )
    setupServiceTabHandlers((count) => {
        const el = document.getElementById('program_count')
        if (el) el.textContent = String(count)
    }, (tab) => {
        options.kickActiveTab = tab
        try { chrome.storage.local.set({ kickActiveTab: tab }) } catch (e) { /* 無効化済み */ }
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
    // 🔴 **「失敗」と「0件」を区別して返すこと。** 両方 `[]` にすると、取得に失敗しただけの周期で
    //    ニコ生のカードが**全部消えて次の周期で戻る**（＝リストが点滅する）。
    //    ok:false は「今回は分からない」であって「0件だった」ではない。
    let res
    try {
        res = await chrome.runtime.sendMessage({ type: 'nico:followed' })
    } catch (e) {
        return { ok: false, programs: [] }
    }
    if (!res || res.ok !== true || !Array.isArray(res.programs)) return { ok: false, programs: [] }

    const out = []
    for (const p of res.programs) {
        try {
            const info = mapApiProgramToInfo(p)
            if (info) out.push(info)
        } catch (e) { /* 1件の不正データでリスト全体を落とさない */ }
    }
    return { ok: true, programs: out }
}

/**
 * ニコ生の案内。ニコ生ページ側と同じ `#api_error` を、同じ関数で出し分ける。
 *
 * 🔴 **「ログイン」を出すのは 401/403 の時だけ**（doc/09 項目CH）。SW の
 *    `nico:fetch` が理由を返すので、それをそのまま使う。
 */
function setApiError(show, reason) {
    if (!show) return setNicoNotice(NICO_NOTICE_NONE)
    setNicoNotice(reason === 'unauthorized' ? NICO_NOTICE_AUTH : NICO_NOTICE_UNREACHABLE)
}

/**
 * 両サービスの番組を取得して描画する。中身の仕様はニコ生ページ側と同じ。
 *
 * ⚠️ **多重実行を防ぐこと。** 定期更新・更新ボタン・開閉・設定変更の4経路から呼ばれる。
 *    重なるとスピナーの消灯が先に来た方に引きずられ、実行中なのにボタンが復活する。
 */
async function refreshPrograms() {
    if (!extensionAlive()) return stopTimer()
    if (isRefreshing) return

    const container = document.getElementById('liveProgramContainer')
    if (!container) return

    isRefreshing = true
    const startedAt = Date.now()
    setReloadButtonLoading(true)
    try {
        await refreshProgramsInner(container)
    } catch (e) {
        console.error('[kickPage] 更新に失敗しました:', e)
    } finally {
        // 取得が速くても最低 minLoadingDurationMs は回す（ニコ生ページと同じ）。
        // 一瞬で消えると「押しても何も起きなかった」ように見える。
        const remain = minLoadingDurationMs - (Date.now() - startedAt)
        if (remain > 0) await new Promise((r) => setTimeout(r, remain))
        setReloadButtonLoading(false)
        isRefreshing = false
    }
}

async function refreshProgramsInner(container) {
    const [kickRes, nicoRes] = await Promise.all([fetchKickPrograms(), fetchNicoPrograms()])

    // 🔴 **取れなかったサービスは「0件」にせず、前回の結果を据え置く。**
    //    片方だけ落ちた周期でそのサービスのカードが全消えし、次の周期で戻る＝点滅する。
    //    連携OFF（そもそも取りに行かない）と取得失敗を混同しないよう、ok で分ける。
    const kickPrograms = kickRes.ok ? kickRes.programs : lastKickPrograms
    const nicoPrograms = nicoRes.ok ? nicoRes.programs : lastNicoPrograms

    // 両方ダメ＝未ログイン・権限なしの可能性。ニコ生ページと同じ場所に案内を出す。
    // ⚠️ **「片方でも失敗」に緩めないこと。** `#api_error` の中身はニコ生のログインリンクなので、
    //    ニコ生を使わない利用者の kick.com に**永久にニコ生のログイン誘導**が出ることになる。
    const bothFailed = !kickRes.ok && !nicoRes.ok
    setApiError(bothFailed, nicoRes.reason)

    // Kick のログイン切れはニコ生と別枠で知らせる（doc/09 項目CG）。
    // ⚠️ **毎周期 true/false を渡し切る。** 出す時だけ呼ぶと、ログインし直しても消えない。
    setKickNotice(isKickSessionLost(kickRes))
    if (bothFailed && !kickPrograms.length && !nicoPrograms.length) return

    // 「盛り上がり」と到着レートは前回値との差分なので、保存を通さないと計算できない。
    // ⚠️ ここは kick.com の localStorage。ニコ生ページ側とは別に貯まるが、
    //    数周期で収束するので実害は無い（初回は開始からの平均で代用される）。
    // ⚠️ 据え置き（取得失敗）の値は書かない。同じ値で上書きすると差分が 0 になり、
    //    盛り上がりの推定が実際より低く出る。
    if (nicoRes.ok && nicoPrograms.length) upsertProgramInfos(nicoPrograms)

    // サムネ更新ループへ渡すために控える。Kick は storage に入れていないので、
    // `getProgramInfos()` からは引けない（渡し忘れるとコマが貯まらない）。
    lastKickPrograms = kickPrograms
    lastNicoPrograms = nicoPrograms

    const combined = nicoPrograms.concat(kickPrograms)

    // 新着順の基準。data-api-index はこの並びの位置を表す（比較器はニコ生側と共有）。
    const ordered = combined.sort((a, b) => {
        const ta = a.onAirTime && a.onAirTime.beginAt ? Date.parse(a.onAirTime.beginAt) : 0
        const tb = b.onAirTime && b.onAirTime.beginAt ? Date.parse(b.onAirTime.beginAt) : 0
        return tb - ta
    })

    // 🔴 **毎周期 `replaceChildren` しないこと。**
    //    以前はここで無条件に全カードを入れ替えていた。要素自体は再利用しているので画像は
    //    読み直されないが、**DOM から一度外れるのでリストがチラつき、FLIP も効かない**
    //    （2026-08-04 に利用者から報告。ニコ生ページ側は元から差分更新になっている）。
    //
    //    ニコ生側と同じ形にする: 既存カードは**その場で属性だけ更新**し、
    //    追加・削除・並び替えが必要な時だけ組み替える。
    const existingMap = new Map()
    for (const el of container.children) if (el && el.id) existingMap.set(el.id, el)

    let structuralChange = false
    const orderedIds = []
    const newElements = new Map()

    ordered.forEach((data, apiIndex) => {
        // 🔴 **`String(data.id)` を直接使わないこと。** ニコ生の番組は `lv123` で来るのに
        //    カードの DOM id は `123`（lv を外した数値）なので、生の id で引くと
        //    **ニコ生の番組だけ毎周期「新規」扱いになり、カードが作り直される**。
        //    2026-08-04 まで実際にそうなっており、35枚中23枚（＝ニコ生の全件）が
        //    毎周期作り直されてリストがチラついていた。cardIdOf が唯一の定義。
        const id = cardIdOf(data)
        const el = existingMap.get(id)
        if (el) {
            // その場更新。**DOM は動かさない。**
            applyRankAttributes(el, data)
            applyProgramInfoToCard(el, data)
            el.setAttribute('data-api-index', String(apiIndex))
            orderedIds.push(id)
        } else {
            const created = makeProgramElement(data, runtimeUrl('images/loading.gif'))
            if (!created) return
            applyRankAttributes(created, data)
            created.setAttribute('data-api-index', String(apiIndex))
            newElements.set(id, created)
            orderedIds.push(id)
            structuralChange = true
        }
    })

    // 削除: DOM にあって新リストに無いものがあれば構造変更
    if (!structuralChange) {
        const wanted = new Set(orderedIds)
        for (const el of container.children) {
            if (el && el.id && !wanted.has(el.id)) { structuralChange = true; break }
        }
    }

    // 追加も削除も無くても、その場更新で順位が入れ替わっていれば並べ替えが要る。
    // ⚠️ 判定に使う比較器は実際に並べ替えるものと**同一**にすること（`programOrder.js` が唯一の定義）。
    //    食い違うと毎周期組み替えが走り、ユーザーが何もしていないのにカードが動き続ける。
    if (!structuralChange) {
        // ⚠️ 見えているカードだけで判定する形は試して撤回した（UpdateManager._sortOrderChanged 参照）。
        const els = Array.from(container.children)
        const sorted = els.slice().sort(orderComparator(options.programsSort))
        for (let i = 0; i < els.length; i++) {
            if (els[i] !== sorted[i]) { structuralChange = true; break }
        }
    }

    if (structuralChange) {
        // 🔴 **フラグメントの組み立ては flipReorder のコールバックの中で行うこと。**
        //    `frag.appendChild(既存カード)` は DOM 仕様上そのカードを現在の親から外すため、
        //    外で組むと FLIP が First を測る時点で container が空になり、**アニメが出ない**。
        // リストから外れるカードが抱えている blob URL（動くサムネのコマ）をここで解放する。
        // 外れた要素は DOM から辿れなくなるので、手放さないとページ滞在中ずっと残る。
        // ⚠️ ニコ生ページ側（UpdateManager）には元からある処理で、ここだけ抜けていた。
        //    id の不一致で毎周期23枚が捨てられていた間、そのぶん漏れ続けていた。
        {
            const keep = new Set(orderedIds)
            for (const el of container.children) {
                if (el && el.id && !keep.has(el.id)) releaseThumbnailBlobs(el)
            }
        }
        flipReorder(container, () => {
            const frag = document.createDocumentFragment()
            for (const id of orderedIds) {
                const el = existingMap.get(id) || newElements.get(id)
                if (el) frag.appendChild(el)
            }
            container.replaceChildren(frag)
            // 🔴 **幅の設定はここ（flipReorder の中）。**外でやると新規カードが幅未設定のまま
            //    測られ、折り返しが崩れた座標で FLIP が当たる（UpdateManager 側の同じ箇所を参照）。
            setProgramContainerWidth(null, currentWidth())
            sortPrograms(container, options.programsSort)
        }, reorderFlipDurationMs)
    }

    // 🔴 **列数の設定を忘れないこと。** これを呼ばないとカードが `width` 未設定のまま
    //    コンテナ幅いっぱいに広がり、どれだけ広げても1列になる（2026-08-04 に実際に踏んだ）。
    //    ニコ生側は描画のたびに呼んでいる。
    setProgramContainerWidth(null, currentWidth())

    // タブ分離／混在の出し分け。ニコ生ページ側と同じ関数・同じ仕様。
    const visible = syncServiceTabs(container, options.kickDisplayMode, options.kickActiveTab)

    const count = document.getElementById('program_count')
    if (count) count.textContent = String(visible)
}

function startTimer() {
    stopTimer()

    // 🔴 **OFF はタイマーを張らない。** 判定はニコ生ページと共有（`autoUpdateIntervalMs`）。
    //    ここで `Number(...) || 120` と書くと、`Number('off')` = NaN が 120 に落ちて
    //    **OFF にしたのに 120秒で回り続ける**。無言で効かない設定になる。
    // ⚠️ 止めるのはリスト更新だけ。**サムネのタイマーは下でそのまま張る**（OFF でも回す）。
    const listMs = autoUpdateIntervalMs(options)
    if (listMs !== null) {
        updateTimer = setInterval(() => {
            if (!extensionAlive()) return stopTimer()
            if (isOpen) refreshPrograms()
        }, Math.max(30000, listMs))
    }

    // 🔴 **ニコ生のライブサムネはリスト更新では差し替わらない。**
    //    ニコ生は「同じURLで中身が変わる」形式なので、`applyProgramInfoToCard` は
    //    ライブサムネを表示中のカードに触らない設計になっている（doc/09 項目BB）。
    //    差し替えは `updateThumbnailsFromStorage` の仕事で、**これを呼ばないと
    //    初回に描いた絵のまま固まる**。Kick 側だけ専用経路で更新されるので、
    //    呼び忘れると「Kickは動くのにニコ生だけ止まる」という形で出る。
    //
    //    ⚠️ ニコ生ページ側は番組ごとに位相をずらす自己連鎖サイクルを持つが、ここでは持たない。
    //       Kick ページの主役は Kick 側で、ニコ生は一覧として見えていれば十分なため、
    //       全件を一定間隔で回すだけの簡素な形にしてある。
    // 🔴 **`updateThumbnailInterval` は「秒」。ミリ秒ではない。**
    //    UpdateManager 側も `* 1000` して使っている。そのまま setInterval に渡すと
    //    **20ミリ秒間隔**になり、カードの枚数ぶん毎フレーム再取得が走る
    //    （2026-08-04 に実際にやった。コンソールがCORSエラーで埋まり、
    //     20msごとに画像を差し替えるのでクロスフェードも見えなくなる）。
    const thumbMs = Math.max(5000, (Number(updateThumbnailInterval) || 20) * 1000)
    thumbTimer = setInterval(() => {
        if (!extensionAlive()) return stopThumbTimer()
        if (!isOpen || document.hidden) return
        const container = document.getElementById('liveProgramContainer')
        if (!container) return

        const stored = getProgramInfos() || []
        // 🔴 **Kick を「データから外す」ことで間引かないこと。**
        //    `updateThumbnailsFromStorage` は対象データが見つからないカードに対して
        //    `syncStaticThumb()` を呼ぶ。外すと Kick カードが毎20秒ごとに素のURLへ戻され、
        //    `thumbLive='0'` が立って**動くサムネのコマ表示まで打ち消される**
        //    （2026-08-04 に実際にこの形で作ってしまった）。
        //
        //    間引くなら `onlyIds`。こちらは `syncStaticThumb` より手前で弾かれる。
        //    Kick は絵が約60秒でしか変わらない（実測平均57秒）ので、その周期でだけ対象に入れる。
        const infos = lastKickPrograms.length ? stored.concat(lastKickPrograms) : stored
        if (!infos.length) return

        thumbTickCount++
        const everyN = Math.max(1, Math.round((kickThumbnailInterval * 1000) / thumbMs))
        const includeKick = thumbTickCount % everyN === 0

        const onlyIds = new Set()
        for (const el of container.children) {
            if (!el || !el.id) continue
            if (el.getAttribute('data-service') === 'kick' && !includeKick) continue
            onlyIds.add(el.id)
        }
        if (onlyIds.size) updateThumbnailsFromStorage(infos, { onlyIds })
    }, thumbMs)
}


/**
 * 今いる kick.com のチャンネル名。チャンネルページでなければ `''`。
 * 判定は両ページ共有の `watchTargetIdOf`（`kick:slug` を返す）に任せる。
 * ⚠️ ここで自前に正規表現を書かないこと。予約パス（/browse, /video/... 等）の一覧が2つになる。
 */
function currentKickSlug() {
    const id = watchTargetIdOf(location.href)
    return id.startsWith('kick:') ? id.slice('kick:'.length) : ''
}

/**
 * 自動移動の監視を始める（設定がONで、チャンネルページに居る時だけ）。
 *
 * モーダル・カウントダウン・移動先選びはニコ生ページと同じ `AutoNextManager` を使う。
 * **違うのは終了の見張り方だけ**で、ニコ生は DOM の終了ガイド、Kick は公開APIに聞く。
 *
 * 🔴 **飛んできたのでなければ、開いた時点で配信していなくても移動しないこと。**
 *    自分で開いたチャンネルが配信前/配信後だった時に、**見始めた瞬間に連れて行かれる**。
 *    ニコ生側の「タイムシフトを自分で開いた時は動かさない」と同じ規則（doc/09 項目BI-2）。
 */
function startKickAutoNext() {
    stopKickAutoNext()
    if (options.autoNextProgram !== 'on') return
    if (!currentKickSlug()) return // チャンネルページでなければ何もしない

    if (!appState) appState = new AppState()
    if (!autoNextManager) autoNextManager = new AutoNextManager(appState)

    autoNextManager.startWatcher(
        // 終了を検知した最初の1回だけリストを取り直す（2回目以降は今あるカードから選ぶ）。
        () => refreshPrograms(),
        (onEnded) => observeKickProgramEnd(currentKickSlug, onEnded, {
            intervalMs: kickEndCheckIntervalMs,
            graceMs: kickRaidGraceMs,
            arrivedByAutoNext,
        }),
    )
}

function stopKickAutoNext() {
    if (autoNextManager) autoNextManager.stopWatcher()
}

function stopTimer() {
    if (updateTimer) clearInterval(updateTimer)
    updateTimer = null
    stopThumbTimer()
}

function stopThumbTimer() {
    if (thumbTimer) clearInterval(thumbTimer)
    thumbTimer = null
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
    stopKickAutoNext()
    // 動くサムネが抱えている blob URL とホバーのリスナーを手放す。
    try { teardownAnimatedThumbnails() } catch (e) { /* 未初期化なら何もしない */ }
    setThumbnailImageProxy(null)
    // 🔴 **`isActive` を先に倒すこと。** これを落とさないと reservedWidth() が幅を返し続け、
    //    連携を切ったのにページが寄ったままになる。
    isActive = false
    isOpen = false
    document.documentElement.classList.remove('nns-kick-active')
    // 🔴 押した固定要素を戻す。**`applyShift` だけでは戻らない**（あちらは body の指定で、
    //    こちらは相手の要素に直接あてているため）。放置すると連携を切った後も
    //    モーダルや小窓が右にずれたままになる。
    try { clearAllNudges() } catch (e) { /* 何もできなくても撤収は続ける */ }
    // 🔴 列数の指定も戻す。放置すると連携を切った後もカードの並びが変わったままになる。
    try { clearAllGridFixes() } catch (e) { /* 同上 */ }
    applyShift() // body のインラインスタイルを外して元の幅へ戻す
    document.documentElement.style.removeProperty('--nns-kick-width')
    document.documentElement.style.removeProperty('--nns-kick-reserved')
    const root = document.getElementById(SIDEBAR_ROOT_ID)
    if (root) root.remove()
}

async function init() {
    if (!extensionAlive()) return
    options = await getOptionsFromStorage(defaultOptions)
    setDwellMinutes(options.dwellMinutes)
    // 🔴 insertSidebar より前に入れること。後だと初回だけ既定（中）の列数で並ぶ。
    setCardSize(options.cardSize)
    applySidebarPlacement(options.sidebarPlacement)
    // 同時視聴者数を出すか（β版）。印を付けるだけで、カードは作り直さない。
    applyShowViewerCount(options.showViewerCount)


    // 動くサムネ。**kick.com では画像を SW 経由で取る。**
    //
    // 画像の配信元はどちらも kick.com のオリジンに ACAO を返さない（2026-08-04 実測）:
    //   - ニコ生の `*.dlive.nicovideo.jp` … ニコ生のページでは通るが kick.com からは拒否
    //   - Kick の `images.kick.com`        … どこからも返さない
    // CORS はブラウザがページに課す制限なので、**拡張の SW からの取得には適用されない**。
    // SW に取ってもらって data URL で受け取れば canvas は汚染されない。
    setAnimThumbnailFeed({ isEnabled: isAnimatedThumbnailEnabled, ingest: ingestAnimatedThumbnailFrame })
    setThumbnailImageProxy(kickPageImageProxy)

    insertSidebar()

    // 🔴 **`setAnimatedThumbnailEnabled` は insertSidebar の「後」で呼ぶこと。**
    //    中で `getContainer()`（= `#liveProgramContainer`）にホバーのリスナーを張るため、
    //    前に呼ぶと **リスナーが一度も付かず、ホバーしても何も起きない**。
    //    `enabled` フラグだけは立つので取得は走る＝「設定はONで通信も増えるのに動かない」
    //    という気付きにくい壊れ方をする（2026-08-04 に実際に踏んだ）。
    setAnimatedThumbnailEnabled(options.animatedThumbnail === 'on')

    // 🔴 **この拡張の kick.com 側に MutationObserver は置かない。**
    //    書き換えに反応して書き戻す形にすると、相手の書き換えと噛み合った時に
    //    マイクロタスクの中で延々と往復し、**ブラウザごと固まる**（2026-08-04 に実際に発生）。
    //    差し込み直しも寄せの復帰も、この定期の突き合わせ1本に集約する。
    // 🔴 **突き合わせを始める前に、今のチャンネルへ印を置くこと（同期で）。**
    //    あちらは「印と違うチャンネルなら数える」なので、印が空のまま回ると
    //    **自動移動で飛んできた先を数えてしまう**。await を挟むと間に合わない。
    lastCountedOwnerKey = currentOwnerKeyOnKickPage()

    startReconciler()
    startTimer()

    // 自動移動。**印の確認を待ってから**始めること。
    // 監視は開いた直後に1回聞きに行くので、先に始めると
    // 「飛んできた先か」が未確定のまま最初の判定が走る。
    arrivedByAutoNext = await consumeAutoNextHopMark(watchTargetIdOf(location.href))
    startKickAutoNext()

    // おすすめ順の材料。**自分で開いた時だけ数える**（自動移動で飛んできた分は除く）。
    // ⚠️ **上の2行の間に挟まないこと。** 「印を読み切ってから監視を始める」という順序が肝で、
    //    間に await を入れると最初の終了判定がそのぶん遅れる（検査BUが鳴って気付いた）。
    //    印の値は `arrivedByAutoNext` に取ってあるので、こちらは後で構わない。
    // ⚠️ 今のチャンネルの印（lastCountedOwnerKey）は startReconciler より前に同期で置いてある。
    await loadWatchHistory()
    // 別のタブで視聴した分をこのタブへも反映する（反映後に並べ直す）。
    startWatchHistorySync(() => rerankInPlace())
    if (!arrivedByAutoNext && !isPageReload()) await recordWatch(lastCountedOwnerKey)
    // 見続けている間の加点（上限あり・裏タブでは加点しない）。
    startDwellPoints(lastCountedOwnerKey)

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
            if (changes.animatedThumbnail) {
                options.animatedThumbnail = changes.animatedThumbnail.newValue
                setAnimatedThumbnailEnabled(options.animatedThumbnail === 'on')
            }
            if (changes.kickDisplayMode || changes.kickActiveTab) {
                if (changes.kickDisplayMode) options.kickDisplayMode = changes.kickDisplayMode.newValue
                if (changes.kickActiveTab) options.kickActiveTab = changes.kickActiveTab.newValue
                const container = document.getElementById('liveProgramContainer')
                if (container) {
                    const visible = syncServiceTabs(container, options.kickDisplayMode, options.kickActiveTab)
                    const el = document.getElementById('program_count')
                    if (el) el.textContent = String(visible)
                }
            }
            if (changes.autoNextProgram) {
                options.autoNextProgram = changes.autoNextProgram.newValue
                startKickAutoNext() // OFF なら中で止めるだけ
            }
            if (changes.sidebarPlacement) {
                options.sidebarPlacement = changes.sidebarPlacement.newValue
                applySidebarPlacement(options.sidebarPlacement)
                // 🔴 寄せ幅が変わる。当て直さないとページが寄ったまま／寄らないままになる。
                applyHostStyles()
            }
            if (changes.showViewerCount) {
                options.showViewerCount = changes.showViewerCount.newValue
                // 印の付け替えだけ。取得も再描画もしない（見た目の出し分けなので）。
                applyShowViewerCount(options.showViewerCount)
            }
            if (changes.cardSize) {
                options.cardSize = changes.cardSize.newValue
                setCardSize(options.cardSize)
                // 列数と中身の倍率を当て直す。**取得はしない**（見た目だけの設定なので）。
                const container = document.getElementById('liveProgramContainer')
                if (container) setProgramContainerWidth(null, currentWidth())
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
