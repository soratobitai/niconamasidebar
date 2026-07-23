// CSSファイルをインポート（ViteでCSSファイルを出力するため）
import './styles/main.css'
import { sidebarMinWidth, loadingSessionTimeoutMs } from './config/constants.js'
import { debounce } from './utils/dom.js'
import { getOptions as getOptionsFromStorage } from './services/storage.js'
import { buildSidebarShell, setAnimThumbnailFeed } from './render/sidebar.js'
import { createSidebarControl } from './ui/sidebarControl.js'
import { adjustWatchPageChild, setProgramContainerWidth } from './ui/layout.js'
import { AppState } from './core/AppState.js'
import { LoadingManager } from './managers/LoadingManager.js'
import { AutoNextManager } from './managers/AutoNextManager.js'
import { UpdateManager } from './managers/UpdateManager.js'
import { sortPrograms as sortProgramsUtil } from './utils/sorting.js'
import { setupOptionsHandler } from './handlers/optionsHandler.js'
import { setAnimatedThumbnailEnabled, teardownAnimatedThumbnails, ingestAnimatedThumbnailFrame, isAnimatedThumbnailEnabled } from './render/animatedThumbnail.js'
// フォロー中ページ・スクレイプ方式（番組詳細の一括取得）。
// 副作用インポート: window.__testFollowScrape() を登録し、実ページのConsoleから動作確認できるようにする。
import './services/followPageSource.js'

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
};
let options = {};
let elems = {};

// AppStateに設定とDOM要素の参照を保存
appState.config.defaultOptions = defaultOptions;
appState.config.options = options;
appState.elements = elems;

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
    appState.config.options = options;
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
    const shouldOpenAtStart = (options.autoOpen == '1') || (options.autoOpen == '3' && !!options.isOpenSidebar);
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

    // 動くサムネ（β版・設定でON/OFF、既定OFF。ホバー中のみ動作）
    setAnimatedThumbnailEnabled(options.animatedThumbnail === 'on');

    // レイアウト崩れ対策用
    const feedbackAnchor = document.querySelector('[class*="_feedback-anchor_"]');
    if (feedbackAnchor) {
        feedbackAnchor.style.right = 0;
    }

    // ページ離脱時のクリーンアップ
    window.addEventListener('beforeunload', cleanup);
    window.addEventListener('pagehide', cleanup);

    // タブの可視/非表示による一時停止・復帰処理は行わない。
    // サイドバーが開いている間は各更新ループを常時走らせ続ける（非表示中も止めず、復帰時も何もしない）。
    // ※背景でのサムネ描画は requestAnimationFrame により自然停止する（取得ループは継続）。
}

// クリーンアップ関数
const cleanup = () => {
    // 動くサムネの停止とblob解放
    teardownAnimatedThumbnails();

    // 番組ごとの自己連鎖サムネタイマーを停止（appState.timers はセンチネルのみ保持するため、
    // appState.cleanup だけでは実タイマーが止まらない。閉パス stopAllTimers と対称にする）。
    if (updateManager) updateManager.stopThumbnailUpdate();

    // AppStateで全てのリソースをクリーンアップ
    appState.cleanup();

    // イベントハンドラーの削除
    const onResizeHandler = appState.getHandler('onResize');
    if (onResizeHandler) {
        window.removeEventListener('resize', onResizeHandler);
    }

    hideAutoNextModal();
}

// すべての更新タイマーを停止
function stopAllTimers() {
    if (updateManager) updateManager.stopThumbnailUpdate(); // 番組ごとの自己連鎖サムネタイマーを全停止
    appState.clearTimer('thumbnail');
    appState.clearTimer('sidebar');
    appState.clearTimer('autoNext');
}

// 開いたときに即時更新しつつ、各タイマーを開始
async function handleSidebarOpenStateChange(open) {
    if (open) {
        // タイマーを先に開始（UIの反応を優先）
        if (!appState.getTimer('thumbnail')) startThumbnailUpdate();
        if (!appState.getTimer('sidebar')) startSidebarUpdate();

        // データ更新は非同期で実行（サイドバー開閉アニメーションをブロックしない）。
        // requestAnimationFrameで次のフレームに延期し、非アクティブタブ向けに setTimeout フォールバックも用意する。
        let rafExecuted = false;
        requestAnimationFrame(async () => {
            rafExecuted = true;
            await performManualUpdate();
        });

        // requestAnimationFrameが実行されない場合のフォールバック（タブが非アクティブなど）
        setTimeout(() => {
            if (!rafExecuted) {
                console.warn('⚠️ requestAnimationFrameが実行されなかったため、fallbackで更新を呼び出し');
                performManualUpdate();
            }
        }, 100); // 100ms後にチェック
    } else {
        stopAllTimers();
    }
}

// サムネイル更新開始
const startThumbnailUpdate = () => {
    if (updateManager) {
        updateManager.startThumbnailUpdate();
    }
}

const startSidebarUpdate = () => {
    if (updateManager) {
        updateManager.startSidebarUpdate();
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
    if (changes.updateProgramsInterval) {
        options.updateProgramsInterval = changes.updateProgramsInterval.newValue;
        needsRestart = true;
    }
    if (changes.programsSort) options.programsSort = changes.programsSort.newValue;
    if (changes.isOpenSidebar) {
        const newIsOpen = changes.isOpenSidebar.newValue;
        // 自タブのトグル操作は同期的に反映＆ handleSidebarOpenStateChange 呼び済み。
        // storage.onChanged は書いた自タブでも発火するため、未反映（＝他タブ由来）の時だけ処理して
        // 開閉あたり getLivePrograms が2回走る二重発火を防ぐ。
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

    // 更新間隔が変更された場合はタイマーを再起動
    if (needsRestart) {
        restartSidebarUpdate();
    }
});

// サイドバー更新タイマーを再起動
const restartSidebarUpdate = () => {
    if (updateManager) {
        updateManager.restartSidebarUpdate();
    }
}

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

/**
 * ローディングセッションを完了する
 * LoadingManager に完全委譲
 */
function finishLoadingSession() {
    if (loadingManager) {
        loadingManager.finishSession();
    }
}

async function performManualUpdate() {
    if (updateManager) {
        await updateManager.performManualUpdate();
    }
}

// sortPrograms関数: utils/sorting.jsの統一関数を使用
function sortPrograms(container) {
    sortProgramsUtil(container, options.programsSort);
}

async function updateSidebar() {
    if (updateManager) {
        await updateManager.updateSidebar();
    }
}

/**
 * オプション内容を反映
 * handlers/optionsHandler.js に完全委譲
 */
const reflectOptions = () => {
    setupOptionsHandler(options, sortPrograms);
};
