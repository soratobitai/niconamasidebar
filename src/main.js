// CSSファイルをインポート（ViteでCSSファイルを出力するため）
import './styles/main.css'
import { sidebarMinWidth, loadingSessionTimeoutMs, minLoadingDurationMs, defaultCardSize, defaultShowViewerCount } from './config/constants.js'
import { debounce } from './utils/dom.js'
import { getOptions as getOptionsFromStorage, getProgramInfos } from './services/storage.js'
import { buildSidebarShell, setAnimThumbnailFeed, setupServiceTabHandlers, syncServiceTabs, setThumbnailImageProxy, reapplyRankAttributes, shouldOpenSidebarAtStart, watchTargetIdOf } from './render/sidebar.js'
import { consumeAutoNextHopMark } from './services/status.js'
import { loadWatchHistory, recordWatch, currentOwnerKeyOnNicoPage, startWatchHistorySync, isPageReload, startDwellPoints } from './services/watchHistory.js'
import { createSidebarControl } from './ui/sidebarControl.js'
import { applySidebarPlacement, SIDEBAR_PLACEMENT_DEFAULT } from './ui/placement.js'
import { applyShowViewerCount } from './ui/viewerCount.js'
import { adjustWatchPageChild, setProgramContainerWidth, setCardSize } from './ui/layout.js'
import { AppState } from './core/AppState.js'
import { LoadingManager } from './managers/LoadingManager.js'
import { AutoNextManager } from './managers/AutoNextManager.js'
import { UpdateManager } from './managers/UpdateManager.js'
import { sortPrograms as sortProgramsUtil } from './utils/sorting.js'
import { setupOptionsHandler } from './handlers/optionsHandler.js'
import { setAnimatedThumbnailEnabled, teardownAnimatedThumbnails, ingestAnimatedThumbnailFrame, isAnimatedThumbnailEnabled } from './render/animatedThumbnail.js'
// フォロー中ページ・スクレイプ方式（番組詳細の一括取得）。
import './services/followPageSource.js'
import { nicoPageImageProxy } from './services/kickSource.js'
import { onExtensionInvalidated } from './utils/extensionAlive.js'

// アプリケーション状態を管理するインスタンス
const appState = new AppState();

let defaultOptions = {
    programsSort: 'newest',
    autoOpen: '3',
    updateProgramsInterval: '120', // 秒
    sidebarWidth: 360,
    isOpenSidebar: false,
    sidebarTheme: 'light', // 'dark' | 'light'（既定ライト）
    autoNextProgram: 'off',
    animatedThumbnail: 'off', // β版・既定OFF
    // Kick 連携。**有効かどうかはここに持たない**（chrome.permissions が唯一の真実）。
    // 保存するのは表示方法と、推定同接の W だけ。どちらも拡張のオプションページで変更する。
    kickDisplayMode: 'mixed',  // 'mixed' | 'tabs'
    kickActiveTab: 'nicolive', // タブ分離時にどのタブを選んでいたか（'mixed' | 'nicolive' | 'kick'）
    // 🔴 **既定値を直書きしないこと。** constants.js の default* が唯一の定義。
    cardSize: defaultCardSize,                  // 番組カードの大きさ（'small' | 'medium' | 'large'）
    sidebarPlacement: SIDEBAR_PLACEMENT_DEFAULT, // サイドバーの置き方（'push' = 寄せる / 'overlay' = 重ねる）
    showViewerCount: defaultShowViewerCount,    // 同時視聴者数をサムネ左上に出すか（β版・既定OFF）
};
let options = {};
let elems = {};


// 各Managerのインスタンス化（setupの後で初期化される）
let loadingManager = null;
let autoNextManager = null;
let updateManager = null;

// localStorage初期化
if (!localStorage.getItem('programInfos')) {
    localStorage.setItem('programInfos', JSON.stringify([]));
}

// 各要素を定義
const setElems = () => {
    elems.root = document.getElementById('root');
    elems.watchPage = document.getElementById('watchPage');
    elems.playerSection = document.querySelector('[class*="_player-section_"]');
    elems.leoPlayer = document.querySelector('[class*="_leo-player_"]');
    elems.gaNsProgramSummary = document.querySelector('[class*="ga-ns-program-summary"]');
    elems.programInformationBodyArea = document.querySelector('[class*="_program-information-body-area_"]');
    elems.siteFooterUtility = document.querySelector('nav[class*="_site-utility-footer_"]');
    elems.feedbackAnchor = document.querySelector('a[class*="_feedback-anchor_"]');
    elems.fullscreenButtons = document.querySelectorAll('button[class*="_fullscreen-button_"]');
    elems.theaterButtons = document.querySelectorAll('button[class*="_theater-button_"]');
    elems.enquetePlaceholder = document.getElementById('enquete-placeholder');
};

// テーマ（ダーク/ライト）を body クラスで適用。CSSはこのクラスで変数を切り替える。
function applyTheme(theme) {
    if (document.body) document.body.classList.toggle('nicosidebar-light', theme === 'light');
}

const url = new URL(window.location.href);
const params = url.searchParams;

const loadingImageURL = chrome.runtime.getURL('images/loading.gif');
const reloadImageURL = chrome.runtime.getURL('images/reload.png');
const optionsImageURL = chrome.runtime.getURL('images/options.png');

// setup()の重複実行を防ぐフラグ
let isSetupCompleted = false;

document.addEventListener('DOMContentLoaded', async () => {
    
    // 別窓くんポップアップ時は終了
    if (params.get('popup') === 'on') return;

    // オプションを取得
    options = await getOptions();
    appState.sidebar.width = options.sidebarWidth || sidebarMinWidth;
    appState.sidebar.isOpen = !!options.isOpenSidebar;

    // 各要素を定義
    setElems();
    if (!elems.root) return; // root要素が存在しない場合は終了

    // setup()の重複実行を防ぐ
    if (isSetupCompleted) {
        console.warn('[警告] setup()は既に実行済みです。重複実行を防止しました。');
        return;
    }

    setup();
    isSetupCompleted = true;
});

const setup = async () => {
    // おすすめ順の材料。**最初の描画より前に読むこと**（applyRankAttributes が同期で参照する）。
    await loadWatchHistory()
    // 別のタブで視聴した分をこのタブへも反映する（反映後に並べ直す）。
    startWatchHistorySync(() => rerankInPlace())
    // 🔴 **自動移動で飛んできた分は数えない。** 自分で選んでいないため。
    //    印は chrome.storage 側（kick.com とのやり取り用）。status.js が使う sessionStorage の
    //    印とは別物なので、ここで消費しても終了判定には影響しない。
    // ⚠️ リロードでは数えない（同じ視聴を2回にしない）。**遷移とは区別できる。**
    if (!isPageReload() && !(await consumeAutoNextHopMark(watchTargetIdOf(location.href)))) {
        await recordWatch(currentOwnerKeyOnNicoPage())
    }
    // 見続けている間の加点（上限あり・裏タブでは加点しない）。
    startDwellPoints(currentOwnerKeyOnNicoPage())
    // テーマ（ダーク/ライト）を先に適用してからサイドバー挿入（初回のちらつき回避）
    applyTheme(options.sidebarTheme);

    // サイドバーを挿入
    await insertSidebar();

    // オプション設定を反映（insertSidebar後に実行）
    reflectOptions();
    
    // Managerの初期化
    loadingManager = new LoadingManager(appState, loadingSessionTimeoutMs);
    autoNextManager = new AutoNextManager(appState);
    updateManager = new UpdateManager(appState, loadingManager, options, elems, loadingImageURL);

    // 拡張が再読み込み/更新/無効化された時のクリーンアップ。**ループを起こす前に登録すること。**
    // 検知は各ループの tick 先頭（checkExtensionAlive）で、専用タイマーは増やさない。
    // 検知は1回で打ち止めなので、登録前に tick が先に気付くと後始末が永久に走らなくなる。
    // これが無いと、取り残された content script がニコ生への取得を延々と続ける
    // （実測 2026-08-02: 無効化後60秒で サムネ+9回、別の回で follow+1 / notifybox+1）。
    onExtensionInvalidated(() => cleanup());

    // サイドバー更新の常設ループを開始する。ページ滞在中ずっと1本だけ回り、
    // 停止は cleanup（beforeunload/pagehide の 'unload'、または上の 'invalidated'）だけ。
    // 開閉による停止/再開はしない（閉じている間は _sidebarTick が isOpen を見て素通りする）。
    updateManager.startSidebarLoop();
    // サムネ更新の常設ループも同様に1回だけ開始する（番組ごとの期限はループ内で管理）。
    updateManager.startThumbnailLoop();

    // サイドバーの開閉/幅の状態。ドラッグ中は onMouseMove が sidebarWidth.value を即時更新する。
    // 列数計算(setProgramContainerWidth)は開閉アニメの「途中幅」ではなく、この「意図した幅」を使う
    // ことで、開閉中の列パタつき（1列⇔多列の切替でサムネが一瞬巨大化する崩れ）を防ぐ。
    const state = {
        sidebarWidth: { value: appState.sidebar.width },
        isOpenSidebar: { value: appState.sidebar.isOpen },
    };

    // Watchページの幅を設定
    adjustWatchPageChild(elems);

    // ウィンドウサイズの変更時（デバウンスを短縮してカクカク感を軽減）
    const onResizeHandler = debounce(() => {
        adjustWatchPageChild(elems);
        sidebarControl.setRootWidth();
        // 意図した幅で列数を決める（アニメ中の途中幅では列がパタつくため）
        setProgramContainerWidth(elems, state.sidebarWidth.value);
    }, 30); // 150ms → 30ms に短縮
    appState.setHandler('onResize', onResizeHandler);
    window.addEventListener('resize', onResizeHandler);

    // watchPageサイズ変更時（幅のみ監視）
    let watchPageWidth = elems.watchPage ? elems.watchPage.clientWidth : 0;
    const resizeObserver_watchPage = new ResizeObserver((entries) => {
        entries.forEach(function (entry) {
            if (entry.contentRect.width !== watchPageWidth) {
                adjustWatchPageChild(elems);
                watchPageWidth = entry.contentRect.width;
            }
        });
    });
    appState.setObserver('resizeWatchPage', resizeObserver_watchPage);
    if (elems.watchPage) {
        resizeObserver_watchPage.observe(elems.watchPage);
    }

    // サイドバーのサイズ変更時
    const resizeObserver_sidebar = new ResizeObserver((e) => {
        // 開閉アニメ中の途中幅(offsetWidth)ではなく「意図した幅」で列数を決める。
        // ドラッグ中は onMouseMove が sidebarWidth.value を即時更新するので幅追従は保たれる。
        const width = state.sidebarWidth.value;
        setProgramContainerWidth(elems, width);

        // ウィンドウリサイズイベントを発行（シークポジションのズレ対策）
        window.dispatchEvent(new Event('resize'));
    });
    appState.setObserver('resizeSidebar', resizeObserver_sidebar);
    if (elems.sidebar) {
        resizeObserver_sidebar.observe(elems.sidebar);
    }

    // シアターモード切り替え時に実行
    for (let i = 0; i < elems.theaterButtons.length; i++) {
        elems.theaterButtons[i].addEventListener('click', function () {
            adjustWatchPageChild(elems);
        });
    }

    // 再読み込みボタン（イベントリスナーの重複登録を防ぐ）
    const reloadBtn = document.getElementById('reload_programs');
    if (reloadBtn) {
        // 既存のイベントリスナーを削除してから追加
        const reloadBtnHandler = async function () {
            // ローディング中は処理を無視
            if (appState.isLoading()) {
                return;
            }
            // 手動更新を実行（リスト＋詳細スクレイプを取り直して再描画）
            await performManualUpdate();
        };
        // 既存のリスナーを削除（もしあれば）
        if (appState.handlers.reloadBtn) {
            reloadBtn.removeEventListener('click', appState.handlers.reloadBtn);
        }
        reloadBtn.addEventListener('click', reloadBtnHandler);
        appState.setHandler('reloadBtn', reloadBtnHandler);
    }

    // テーマは設定フォーム（ライト/ダークのセグメント）で切替。
    // 保存は optionsHandler、body への適用は下部の storage.onChanged（changes.sidebarTheme）が担う。

    // オプションボタン（サイドバー内で番組リストと入れ替え表示）
    const optionsBtn = document.getElementById('setting_options');
    const sidebarBodyEl = document.querySelector('.sidebar_body');
    if (optionsBtn && sidebarBodyEl) {
        const closeSettings = () => sidebarBodyEl.classList.remove('show-settings');

        optionsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            sidebarBodyEl.classList.toggle('show-settings'); // 番組リスト⇄設定を入れ替え
        });

        // 設定内の「閉じる（番組リストに戻る）」ボタン
        const settingsCloseBtn = document.getElementById('settings_close');
        if (settingsCloseBtn) {
            settingsCloseBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeSettings();
            });
        }

        // Escで設定を閉じて番組リストへ戻る
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && sidebarBodyEl.classList.contains('show-settings')) closeSettings();
        });
    }

    // 画面サイズ（固定・自動）切替時（変更時サイズが変更されないため強制する）
    document.addEventListener('click', function () {
        window.dispatchEvent(new Event('resize'));
    });

    // サイドバーOPEN/CLOSEボタン（state は上部で定義済み）
    const sidebarControl = createSidebarControl(elems, state);
    const sidebarBtn = document.getElementById('sidebar_button');
    if (sidebarBtn) {
        sidebarBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();

            sidebarControl.toggleSidebar();
            // サイドバーの開閉状態を更新
            appState.sidebar.isOpen = state.isOpenSidebar.value;
            options.isOpenSidebar = state.isOpenSidebar.value;
            // サイドバーを開いた時に即時更新を実行
            handleSidebarOpenStateChange(state.isOpenSidebar.value);
            // CSS transition完了後に調整するため、requestAnimationFrameで次のフレームに延期
            requestAnimationFrame(() => {
                // transition中でも正確な幅を取得するため、さらに次のフレームで実行
                requestAnimationFrame(() => {
                    const sidebarWidth = state.sidebarWidth.value;
                    setProgramContainerWidth(elems, sidebarWidth);
                    adjustWatchPageChild(elems);
                });
            });
        });
    }

    // サイドバー境界線ドラッグ可能にする
    sidebarControl.enableSidebarLine();

    // 初期開閉状態の適用（直接open/close）
    // 解釈は kick.com ページと共有する（shouldOpenSidebarAtStart が唯一の定義）
    const shouldOpenAtStart = shouldOpenSidebarAtStart(options);
    if (shouldOpenAtStart) {
        // サイドバーUIは即座に開く（ユーザーにすぐ見せる）
        state.isOpenSidebar.value = true;
        appState.sidebar.isOpen = true;
        options.isOpenSidebar = true;
        sidebarControl.openSidebar();
        
        // CSS transition完了後に調整するため、requestAnimationFrameで次のフレームに延期
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const sidebarWidth = state.sidebarWidth.value;
                setProgramContainerWidth(elems, sidebarWidth);
                adjustWatchPageChild(elems);
            });
        });

        // データ取得のみ少し遅延（初期ページ読み込みの邪魔をしない）
        setTimeout(() => {
            handleSidebarOpenStateChange(true);
        }, 300); // 300ms後にデータ取得開始
    } else {
        state.isOpenSidebar.value = false;
        appState.sidebar.isOpen = false;
        options.isOpenSidebar = false;
        sidebarControl.closeSidebar();
        // 閉じる場合も同様に調整
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                // 閉じていても列数は「開いた時の幅」で確定させておく（開いた瞬間の列パタつき防止）
                setProgramContainerWidth(elems, state.sidebarWidth.value);
                adjustWatchPageChild(elems);
            });
        });
        handleSidebarOpenStateChange(false);
    }

    sidebarControl.setRootWidth();

    // 自動移動ウォッチャー開始（必要なら）
    if (options.autoNextProgram === 'on') {
        startLiveStatusWatcher();
    }

    // 動くサムネ(②)を①(通常サムネ更新)の取得へ相乗りさせ、最新サムネの二重取得をなくす（給餌方式）。
    // ①ONのプリロード成功画像を②へ渡す経路をここで配線。②OFF時は isEnabled()=false で①は通常動作のまま。
    setAnimThumbnailFeed({ isEnabled: isAnimatedThumbnailEnabled, ingest: ingestAnimatedThumbnailFrame });

    // Kick のサムネだけ SW 経由で読む。`images.kick.com` は**どのオリジンにも** CORS を返さないので、
    // ニコ生の視聴ページでも中継しないとコマ化できない。
    // ⚠️ ニコ生自身の画像はこのページから直接読めるので中継に回さない（`shouldUse` が弾く）。
    setThumbnailImageProxy(nicoPageImageProxy);

    // 動くサムネ（β版・設定でON/OFF、既定OFF。ホバー中のみ動作）
    setAnimatedThumbnailEnabled(options.animatedThumbnail === 'on');

    // レイアウト崩れ対策用
    const feedbackAnchor = document.querySelector('[class*="_feedback-anchor_"]');
    if (feedbackAnchor) {
        feedbackAnchor.style.right = 0;
    }

    // ページ離脱時のクリーンアップ（イベント引数を reason に流し込まないよう包む）
    window.addEventListener('beforeunload', () => cleanup());
    window.addEventListener('pagehide', () => cleanup());
    // ※ 無効化時の後始末（onExtensionInvalidated）は**ループを起こす前**に登録済み（上を参照）。
    //   ここに書き足さないこと。二重登録すると cleanup が2回走る。

    // タブの可視/非表示による一時停止・復帰処理は行わない。
    // サイドバーが開いている間は各更新ループを常時走らせ続ける（非表示中も止めず、復帰時も何もしない）。
    // ※背景でのサムネ描画は requestAnimationFrame により自然停止する（取得ループは継続）。
}

// クリーンアップ関数
// @param {'unload'|'invalidated'} [reason] 既定は 'unload'（ページ離脱）。
//        'invalidated' = 拡張が再読み込み/更新/無効化され、取り残された content script を畳む場合。
const cleanup = () => {
    // 動くサムネの停止とblob解放
    teardownAnimatedThumbnails();

    // 更新ループ2本を破棄。ページ離脱時だけに呼ぶ唯一の停止経路。
    // （サイドバー開閉では止めない。閉じている間は各 tick が isOpen を見て素通りする）
    if (updateManager) updateManager.destroyThumbnailLoop();
    // サイドバー更新の常設ループを破棄（片道）。ページ離脱時だけに呼ぶ唯一の停止経路。
    if (updateManager) updateManager.destroySidebarLoop();

    // AppStateで全てのリソースをクリーンアップ
    appState.cleanup();

    // イベントハンドラーの削除
    const onResizeHandler = appState.getHandler('onResize');
    if (onResizeHandler) {
        window.removeEventListener('resize', onResizeHandler);
    }

    hideAutoNextModal();
}

// 開いたときに即時更新しつつ、各タイマーを開始
//
// 🔴 **閉じた時に止めるものは何も無い**（2026-07-31・利用者判断で変更。doc/09 項目AX）。
//
//   - 更新ループ2本（リスト／サムネ）は常設で、閉じている間は各 tick が isOpen を見て素通りする。
//     ここで止めると、閉じた状態で起動する既定経路でループが即死して二度と復活しない。
//   - 自動移動のカウントダウンも**止めない**。以前は閉じると取り消していたが、
//     モーダルは body 直下にあってサイドバーの外なので、閉じてもカウントダウンは見えている。
//     それが黙って中止されるうえ、`chrome.storage.onChanged` 経由で**別タブの開閉でも中止**されていた
//     （視聴中のタブは何も操作していないのに止まる）。
//
// ⚠️ **ここに自動移動を止める処理を戻さないこと。** 戻すなら `clearTimer('autoNext')` だけでは
//    いけない（`scheduled` が残って以後そのページで自動移動が二度と動かない＝項目AF）。
//    verify:loop が「閉パスが autoNext に触っていないこと」を機械で見ている。
async function handleSidebarOpenStateChange(open) {
    if (open) {
        // 更新ループ2本はどちらも常設なので「開始」は不要。閉じている間は各 tick が
        // isOpen を見て素通りしている。開いた時点から1周期後になるよう位相だけ置き直す。
        resetSidebarSchedule();
        // サムネ側も同様に期限表を置き直す（cleanup 後に生き残ったページではここで再武装される）
        if (updateManager) updateManager._refreshThumbSchedule();

        // データ更新は非同期で実行（サイドバー開閉アニメーションをブロックしない）。
        // rAF で次フレームへ回し、裏タブ用に setTimeout のフォールバックも張る。
        //
        // 🔴 **必ずどちらか片方だけが走るように掛け金で締めること。**
        //    裏タブで止まっていた rAF は**タブを表に戻した時に遅れて実行される**（破棄されない）。
        //    掛け金が無いと、フォールバックが完走した後にもう一度フル更新が走る。
        //    `isPerformingManualUpdate` は「同時」しか防げないので、15〜30秒後に来る2回目は素通しする。
        //
        // ⚠️ フォールバックが走ること自体は異常ではない（裏タブでは rAF が止まるのが正常）。
        //    以前ここで警告を出していたが、正常系なので消した（利用者が異常と誤解した）。
        let updateDispatched = false;
        const dispatchManualUpdateOnce = () => {
            if (updateDispatched) return;
            updateDispatched = true;
            performManualUpdate();
        };
        requestAnimationFrame(dispatchManualUpdateOnce);
        setTimeout(dispatchManualUpdateOnce, 100);
    }
    // else: 閉じた時にすることは無い（上のコメント参照）
}

// サイドバー定期取得の位相リセット（常設ループはこれで作り直されない）
const resetSidebarSchedule = () => {
    if (updateManager) {
        updateManager.resetSidebarSchedule();
    }
}

// 自動次番組モーダル生成と表示/非表示
// ===== 自動次番組関連の関数 =====
// AutoNextManager に委譲

function hideAutoNextModal() {
    if (autoNextManager) {
        autoNextManager.hideModal();
    }
}

function startLiveStatusWatcher() {
    if (autoNextManager) {
        // 番組終了検知時に最新リストを取得できるよう updateSidebar を注入
        // （IIFEビルドではモジュールローカル関数はグローバル参照できないため明示的に渡す）
        autoNextManager.startWatcher(updateSidebar);
    }
}

function stopLiveStatusWatcher() {
    if (autoNextManager) {
        autoNextManager.stopWatcher();
    }
}

// データが変更されたときのイベントリスナー
chrome.storage.onChanged.addListener(function (changes) {
    let needsRestart = false;
    
    if (changes.autoOpen) options.autoOpen = changes.autoOpen.newValue;
    // Kick 連携の設定は**拡張のオプションページ（別コンテキスト）**で変更される。
    // この onChanged がそれを受け取る唯一の経路なので、ここで反映しないと
    // ページを再読込するまで効かない。
    if (changes.kickDisplayMode || changes.kickActiveTab) {
        if (changes.kickDisplayMode) options.kickDisplayMode = changes.kickDisplayMode.newValue;
        if (changes.kickActiveTab) options.kickActiveTab = changes.kickActiveTab.newValue;
        const container = document.getElementById('liveProgramContainer');
        // 表示の出し分けだけなので再取得は不要。CSS の属性を付け替えれば済む。
        if (container) {
            const count = syncServiceTabs(container, options.kickDisplayMode, options.kickActiveTab);
            if (updateManager) updateManager.updateProgramCount(count);
        }
    }
    if (changes.sidebarPlacement) {
        options.sidebarPlacement = changes.sidebarPlacement.newValue;
        applySidebarPlacement(options.sidebarPlacement);
        // 🔴 印を付け替えただけでは #root の幅が古いまま。寄せ幅を計算し直させる。
        if (sidebarControl) sidebarControl.setRootWidth();
    }
    if (changes.showViewerCount) {
        options.showViewerCount = changes.showViewerCount.newValue;
        // 印の付け替えだけ。取得も再描画もしない（見た目の出し分けなので）。
        applyShowViewerCount(options.showViewerCount);
    }
    if (changes.cardSize) {
        options.cardSize = changes.cardSize.newValue;
        setCardSize(options.cardSize);
        // 列数と中身の倍率を当て直す。**取得はしない**（見た目だけの設定なので）。
        // ⚠️ 幅は `appState.sidebar.width` から取ること。setup() 内のローカル `state` は
        //    このリスナー（モジュール直下）からは見えず、参照すると実行時に落ちる。
        //    UpdateManager が列数を決める時と同じ「意図した幅」でもある。
        setProgramContainerWidth(elems, appState.sidebar.width);
    }
    if (changes.updateProgramsInterval) {
        options.updateProgramsInterval = changes.updateProgramsInterval.newValue;
        needsRestart = true;
    }
    if (changes.programsSort) {
        options.programsSort = changes.programsSort.newValue;
        // ⚠️ 値を入れるだけでは並び替わらない（doc/09 項目AJ）。
        // 自タブで変えた時は optionsHandler の change リスナが即ソートするが、そのリスナは
        // **変更したタブでしか発火しない**。この onChanged は他タブ由来の変更を受け取る唯一の経路なので、
        // ここで並べ替えないと「他タブで並び順を変えたのにこのタブは古い順序のまま」になる。
        // 次の定期更新で直る…とも限らない: 構造変化が無い周期は _sortOrderChanged が
        // 「今のDOM順」と「あるべき順」を比べるので、そこで初めて直る＝最大1周期ぶん食い違う。
        const container = document.getElementById('liveProgramContainer');
        if (container) sortPrograms(container);
    }
    if (changes.isOpenSidebar) {
        const newIsOpen = changes.isOpenSidebar.newValue;
        // 自タブのトグル操作は同期的に反映＆ handleSidebarOpenStateChange 呼び済み。
        // storage.onChanged は書いた自タブでも発火するため、未反映（＝他タブ由来）の時だけ処理して
        // 開閉あたり リスト取得 が2回走る二重発火を防ぐ。
        if (appState.sidebar.isOpen !== newIsOpen) {
            options.isOpenSidebar = newIsOpen;
            appState.sidebar.isOpen = newIsOpen;
            // 開閉に応じて停止/再開・即時更新
            handleSidebarOpenStateChange(appState.sidebar.isOpen);
        }
    }
    if (changes.sidebarWidth) {
        options.sidebarWidth = changes.sidebarWidth.newValue;
        appState.sidebar.width = changes.sidebarWidth.newValue;
    }
    if (changes.sidebarTheme) {
        options.sidebarTheme = changes.sidebarTheme.newValue;
        applyTheme(options.sidebarTheme);
    }
    if (changes.autoNextProgram) {
        options.autoNextProgram = changes.autoNextProgram.newValue;
        if (options.autoNextProgram === 'on') startLiveStatusWatcher();
        else stopLiveStatusWatcher();
    }
    if (changes.animatedThumbnail) {
        options.animatedThumbnail = changes.animatedThumbnail.newValue;
        setAnimatedThumbnailEnabled(options.animatedThumbnail === 'on');
    }

    // 更新間隔が変更された場合は位相を置き直す（＝今から新しい間隔ぶん後）。
    // 設定は全タブ共有なので、この listener は「サイドバーを閉じている別タブ」でも発火する。
    // 閉じている場合は何もしなくてよい。次に開いた時の resetSidebarSchedule が新しい間隔で始める。
    // （常設ループ自体は閉じていても回っているが、_sidebarTick が isOpen で素通りするため取得はしない）
    if (needsRestart && appState.sidebar.isOpen) {
        resetSidebarSchedule();
    }
});

// オプションを取得
const getOptions = async () => getOptionsFromStorage(defaultOptions);

// サイドバー要素を挿入
const insertSidebar = () => {
    const { sidebarHtml, sidebarLine, optionHtml } = buildSidebarShell({ reloadImageURL, optionsImageURL });
    document.body.insertAdjacentHTML('afterbegin', sidebarHtml + sidebarLine);
    const optionContainerEl = document.getElementById('optionContainer');
    if (optionContainerEl) {
        // 設定はサイドバー内（.sidebar_body 内）に置き、番組リストと入れ替え表示する（body直下へは移動しない）
        optionContainerEl.insertAdjacentHTML('beforeend', optionHtml);
    }

    // 各要素を定義
    elems.sidebar = document.getElementById('sidebar');
    elems.sidebar_line = document.getElementById('sidebar_line');
    elems.sidebar_container = document.getElementById('sidebar_container');
    elems.apiErrorElement = document.getElementById('api_error');
    // body要素にスタイルを設定
    document.body.style.position = 'relative';
    document.body.style.display = 'flex';
    // #root要素にスタイルを設定
    elems.root.style.flexGrow = '1';
};



// ===== 関数ラッパー（Managerへの委譲） =====


async function performManualUpdate() {
    if (updateManager) {
        await updateManager.performManualUpdate();
    }
}

// sortPrograms関数: utils/sorting.jsの統一関数を使用
function sortPrograms(container) {
    sortProgramsUtil(container, options.programsSort);
}

// 自動移動（番組終了検知 → AutoNextManager）からのリスト更新。
//
// updateSidebar はローディングセッションを開始するが、この経路は誰も閉じていなかった。
// 旧実装では定期チェーンが await 明けに「今開いているセッション」を無条件 finish していたため、
// それが偶然の回収役になっていた。定期tickが自分のセッションだけを閉じるようになった以上、
// ここで自分の後始末をする。閉じないと最大60秒、更新ボタンがスピナー固着のまま押せず、
// appState.isLoading() が真の間は定期取得も素通りし続ける。
async function updateSidebar() {
    if (!updateManager) return;
    const sessionId = await updateManager.updateSidebar();
    if (sessionId && loadingManager) {
        await loadingManager.finishSessionWithMinDuration(minLoadingDurationMs, sessionId);
    }
}

/**
 * オプション内容を反映
 * handlers/optionsHandler.js に完全委譲
 */
/**
 * 取得せずに順位だけ計算し直して並べ替える。
 *
 * 「人気順の基準」を動かした時に使う。`active-point` は描画時に書かれた値なので、
 * 並べ替えるだけでは古い値で並ぶ＝直ったように見えて直っていない。
 * ⚠️ Kick は保存領域に入れていないので、UpdateManager が持っている直近の取得結果を足す。
 */
const rerankInPlace = () => {
    const container = document.getElementById('liveProgramContainer');
    if (!container) return;
    const stored = getProgramInfos() || [];
    const kick = updateManager ? updateManager.getKickPrograms() : [];
    reapplyRankAttributes(container, kick.length ? stored.concat(kick) : stored);
    sortPrograms(container);
};


const reflectOptions = () => {
    // 第3引数: Kick 連携が有効になった直後にリストを取り直す（次の定期更新を待たない）。
    setupOptionsHandler(options, sortPrograms, () => { updateSidebar(); });
    // 🔴 最初の描画より前に入れること。後だと初回だけ既定（中）の列数で並ぶ。
    setCardSize(options.cardSize);
    // サイドバーの置き方（寄せる／重ねる）。**印を付けるだけ。**寄せ幅の計算は setRootWidth。
    applySidebarPlacement(options.sidebarPlacement);
    // 同時視聴者数を出すか（β版）。印を付けるだけで、カードは作り直さない。
    applyShowViewerCount(options.showViewerCount);
    // タブのクリック配線（1回だけ効く。2回目以降は内部で弾く）
    setupServiceTabHandlers((count) => {
        if (updateManager) updateManager.updateProgramCount(count);
    }, (tab) => {
        options.kickActiveTab = tab;
        try { chrome.storage.local.set({ kickActiveTab: tab }); } catch (e) { /* 無効化済み */ }
    });
};
