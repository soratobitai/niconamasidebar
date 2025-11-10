// CSSファイルをインポート（ViteでCSSファイルを出力するため）
import './styles/main.css'
import { sidebarMinWidth, maxSaveProgramInfos, toDolistsInterval, loadingSessionTimeoutMs } from './config/constants.js'
import { debounce } from './utils/dom.js'
import { getOptions as getOptionsFromStorage, saveOptions as saveOptionsToStorage } from './services/storage.js'
import { buildSidebarShell, initThumbnailVisibilityObserver, refreshThumbnailObservations, teardownThumbnailVisibilityObserver } from './render/sidebar.js'
import { createSidebarControl } from './ui/sidebarControl.js'
import { adjustWatchPageChild, setProgramContainerWidth } from './ui/layout.js'
import { AppState } from './core/AppState.js'
import { ProgramInfoQueue } from './services/queue.js'
import { LoadingManager } from './managers/LoadingManager.js'
import { AutoNextManager } from './managers/AutoNextManager.js'
import { UpdateManager } from './managers/UpdateManager.js'
import { sortPrograms as sortProgramsUtil } from './utils/sorting.js'
import { initApiStats } from './debug/apiStats.js'
import { setupOptionsHandler } from './handlers/optionsHandler.js'

// アプリケーション状態を管理するインスタンス
const appState = new AppState();

// 番組詳細情報取得キュー
// レートリミッティングを実装して、APIへの負荷を配慮
// 1秒あたり最大4件に制限、1件ずつ処理（0.25秒/件）
const programInfoQueue = new ProgramInfoQueue({
    batchSize: 1, // 1件ずつ処理
    processInterval: toDolistsInterval * 1000, // 0.25秒間隔
    idleTimeout: 50,
    maxSize: maxSaveProgramInfos,
    maxRequestsPerSecond: 4, // 1秒あたり最大4件
    getVisibilityState: () => appState.isVisible(), // 可視状態を取得する関数
    onProcessStart: () => {
        // キュー処理開始を追跡（updateSidebar()完了後のキュー処理開始時のみ）
        // updateSidebar()内で既にstartLoading()が呼ばれているため、ここでは呼ばない
        // ただし、updateSidebar()完了後にキュー処理が開始される場合、ローディングは継続される
    },
    onProcessComplete: (processedCount, results, shouldSort) => {
        // 番組詳細情報取得後、active-pointを更新
        // shouldSortがtrueの場合のみソートを実行（初回/サイドバーオープン/更新ボタン時）
        if (typeof updateActivePointsAndSort === 'function') {
            updateActivePointsAndSort(shouldSort);
        }
        // サムネイル更新は別タイマー（startThumbnailUpdate）で定期実行されるため、ここでは呼ばない
    },
    onQueueEmpty: () => {
        // 何もしない
        // updateSidebar()が120秒ごとに最新の放送中番組リストを取得し、
        // その番組をキューに追加するため、ここでは何もする必要がない
    }
});

let defaultOptions = {
    programsSort: 'newest',
    autoOpen: '3',
    updateProgramsInterval: '120', // 秒
    sidebarWidth: 360,
    isOpenSidebar: false,
    autoNextProgram: 'off',
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

// 初期化（開発用）
// localStorage.setItem('programInfos', JSON.stringify([]));

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
    // サイドバーを挿入
    await insertSidebar();

    // オプション設定を反映（insertSidebar後に実行）
    reflectOptions();
    
    // Managerの初期化
    loadingManager = new LoadingManager(appState, loadingSessionTimeoutMs);
    autoNextManager = new AutoNextManager(appState);
    updateManager = new UpdateManager(appState, programInfoQueue, loadingManager, options, elems, loadingImageURL);

    // Watchページの幅を設定
    adjustWatchPageChild(elems);

    // ウィンドウサイズの変更時（デバウンスを短縮してカクカク感を軽減）
    const onResizeHandler = debounce(() => {
        adjustWatchPageChild(elems);
        sidebarControl.setRootWidth();
        setProgramContainerWidth(elems, elems.sidebar ? elems.sidebar.offsetWidth : appState.sidebar.width);
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
        const width = elems.sidebar ? elems.sidebar.offsetWidth : appState.sidebar.width;
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
            // 手動更新を実行
            await performManualUpdate();
        };
        // 既存のリスナーを削除（もしあれば）
        if (appState.handlers.reloadBtn) {
            reloadBtn.removeEventListener('click', appState.handlers.reloadBtn);
        }
        reloadBtn.addEventListener('click', reloadBtnHandler);
        appState.setHandler('reloadBtn', reloadBtnHandler);
    }

    // オプションボタン（ポップアップ）
    const optionsBtn = document.getElementById('setting_options');
    const optionContainerEl2 = document.getElementById('optionContainer');
    if (optionsBtn && optionContainerEl2) {
        const placePopup = () => {
            if (!optionContainerEl2.classList.contains('show')) return;
            const btnRect = optionsBtn.getBoundingClientRect();
            const popupRect = optionContainerEl2.querySelector('.container')?.getBoundingClientRect();

            const margin = 6; // ボタンのすぐ下に余白
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            const popupWidth = popupRect ? popupRect.width : 320;
            const popupHeight = popupRect ? popupRect.height : 300;

            let left = Math.min(btnRect.left, viewportWidth - popupWidth - margin);
            let top = btnRect.bottom + margin;

            // 下方向に収まらない場合、上に出す
            if (top + popupHeight > viewportHeight - margin) {
                const topCandidate = btnRect.top - margin - popupHeight;
                if (topCandidate >= margin) top = topCandidate;
            }

            optionContainerEl2.style.left = Math.max(margin, left) + 'px';
            optionContainerEl2.style.top = Math.max(margin, top) + 'px';
        };

        const openPopup = () => {
            optionContainerEl2.classList.add('show');
            placePopup();
            // 位置再計算リスナー
            window.addEventListener('resize', placePopup);
            window.addEventListener('scroll', placePopup, true);
            if (elems.sidebar) elems.sidebar.addEventListener('scroll', placePopup, { passive: true });
            document.addEventListener('keydown', onKeydown, true);
            document.addEventListener('click', onDocClick, true);
        };

        const closePopup = () => {
            optionContainerEl2.classList.remove('show');
            optionContainerEl2.style.left = '-9999px';
            optionContainerEl2.style.top = '-9999px';
            window.removeEventListener('resize', placePopup);
            window.removeEventListener('scroll', placePopup, true);
            if (elems.sidebar) elems.sidebar.removeEventListener('scroll', placePopup, { passive: true });
            document.removeEventListener('keydown', onKeydown, true);
            document.removeEventListener('click', onDocClick, true);
        };

        const onKeydown = (e) => {
            if (e.key === 'Escape') closePopup();
        };

        const onDocClick = (e) => {
            if (!optionContainerEl2.classList.contains('show')) return;
            if (optionContainerEl2.contains(e.target) || optionsBtn.contains(e.target)) return;
            closePopup();
        };

        optionsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (optionContainerEl2.classList.contains('show')) closePopup();
            else openPopup();
        });
    }

    // 画面サイズ（固定・自動）切替時（変更時サイズが変更されないため強制する）
    document.addEventListener('click', function () {
        window.dispatchEvent(new Event('resize'));
    });

    // サイドバーOPEN/CLOSEボタン
    const state = {
        sidebarWidth: { value: appState.sidebar.width },
        isOpenSidebar: { value: appState.sidebar.isOpen },
    };
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
                    const sidebarWidth = elems.sidebar ? elems.sidebar.offsetWidth : appState.sidebar.width;
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
                const sidebarWidth = elems.sidebar ? elems.sidebar.offsetWidth : appState.sidebar.width;
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
                setProgramContainerWidth(elems, 0);
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

    // レイアウト崩れ対策用
    const feedbackAnchor = document.querySelector('[class*="_feedback-anchor_"]');
    if (feedbackAnchor) {
        feedbackAnchor.style.right = 0;
    }

    // ページ離脱時のクリーンアップ
    window.addEventListener('beforeunload', cleanup);
    window.addEventListener('pagehide', cleanup);

    // Page Visibility APIを使用してタブの可視状態を監視
    // Chromeの最近の更新により、バックグラウンドタブでのリソース管理が厳しくなったため
    // バックグラウンドタブではタイマーを停止または間隔を延長して、動画プレーヤーのリソースを確保
    const handleVisibilityChange = () => {
        const isVisible = !document.hidden;
        appState.setVisibility(isVisible);
        
        // サイドバーが開いている場合のみ処理
        if (appState.sidebar.isOpen) {
            if (isVisible) {
                // フォアグラウンドに戻ったとき：タイマーを再開し、即座に更新
                if (!appState.getTimer('thumbnail')) startThumbnailUpdate();
                if (!appState.getTimer('todo')) {
                    startToDoListUpdate();
                    // キューがあれば即座に処理開始
                    if (programInfoQueue.size() > 0) {
                        programInfoQueue.processNow().catch(error => {
                            console.warn('可視化後のキュー処理でエラーが発生しました:', error);
                        });
                    }
                }
                if (!appState.getTimer('sidebar')) startSidebarUpdate();
                
                // 即座に更新を実行
                requestAnimationFrame(async () => {
                    // 手動更新を実行
                    await performManualUpdate();
                });
            } else {
                // バックグラウンドに移行したとき：タイマーを停止（リソース消費を抑える）
                // ただし、完全に停止せず、間隔を延長する方式はqueue.jsで実装済み
                // ここではサムネイル更新などの重い処理を停止
                appState.clearTimer('thumbnail');
                // sidebarとtodoはqueue.jsで間隔が延長されるため、停止しない
                
                // バックグラウンドに移行した時にセッションが完了していない場合、
                // キューが空であればセッションを完了
                // これにより、バックグラウンドに移行した後にセッションが残り続ける問題を防ぐ
                const hasActiveSession = loadingManager && loadingManager.getCurrentSessionId();
                if (hasActiveSession && programInfoQueue.size() === 0) {
                    // 少し待ってからチェック（他の処理が完了するのを待つ）
                    setTimeout(() => {
                        const stillHasSession = loadingManager && loadingManager.getCurrentSessionId();
                        if (stillHasSession && programInfoQueue.size() === 0) {
                            console.warn('[ローディング] バックグラウンド移行時: セッションを完了します');
                            finishLoadingSession();
                        }
                    }, 500);
                }
            }
        }
    };
    
    // 初期状態を設定
    appState.setVisibility(!document.hidden);
    
    // visibilitychangeイベントを監視
    document.addEventListener('visibilitychange', handleVisibilityChange);
}

// クリーンアップ関数
const cleanup = () => {
    // AppStateで全てのリソースをクリーンアップ
    appState.cleanup();
    
    // キュー処理を停止
    programInfoQueue.stop();
    programInfoQueue.clear();
    
    // 外部で管理されているオブザーバーのクリーンアップ
    teardownThumbnailVisibilityObserver();
    
    // イベントハンドラーの削除
    const onResizeHandler = appState.getHandler('onResize');
    if (onResizeHandler) {
        window.removeEventListener('resize', onResizeHandler);
    }
    
    hideAutoNextModal();
}

// すべての更新タイマーを停止
function stopAllTimers() {
    appState.clearTimer('thumbnail');
    // todoタイマーはQueueクラスが管理しているため、直接停止
    programInfoQueue.stop();
    appState.clearTimer('todo');
    appState.clearTimer('sidebar');
    appState.clearTimer('autoNext');
    appState.clearTimer('queueRestart');
}

// 開いたときに即時更新しつつ、各タイマーを開始
async function handleSidebarOpenStateChange(open) {
    if (open) {
        // タイマーを先に開始（UIの反応を優先）
        initThumbnailVisibilityObserver();
        if (!appState.getTimer('thumbnail')) startThumbnailUpdate();
        if (!appState.getTimer('sidebar')) startSidebarUpdate();
        
        // データ更新は非同期で実行（サイドバー開閉アニメーションをブロックしない）
        // requestAnimationFrameで次のフレームに延期して、開閉アニメーションを優先
        // ただし、タブが非アクティブの場合、requestAnimationFrameが実行されない可能性があるため、
        // setTimeout のフォールバックも用意する
        let rafExecuted = false;
        requestAnimationFrame(async () => {
            rafExecuted = true;
            // 初回ロードまたは手動更新を実行
            // oneTimeFlagが立っている場合は初回ロード、それ以外は手動更新
            if (appState.update.oneTimeFlag) {
                if (!appState.getTimer('todo')) await startToDoListUpdate();
            } else {
                await performManualUpdate();
            }
        });
        
        // requestAnimationFrameが実行されない場合のフォールバック（タブが非アクティブなど）
        setTimeout(() => {
            if (!rafExecuted) {
                console.warn('⚠️ requestAnimationFrameが実行されなかったため、fallbackで更新を呼び出し');
                if (appState.update.oneTimeFlag) {
                    startToDoListUpdate();
                } else {
                    performManualUpdate();
                }
            }
        }, 100); // 100ms後にチェック
    } else {
        stopAllTimers();
        teardownThumbnailVisibilityObserver();
    }
}

// サムネイル更新開始
const startThumbnailUpdate = () => {
    if (updateManager) {
        updateManager.startThumbnailUpdate();
    }
}

// ToDoリスト更新開始（新しいQueueクラスを使用）
const startToDoListUpdate = async () => {
    if (updateManager) {
        await updateManager.startToDoListUpdate();
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

function ensureAutoNextModal() {
    if (autoNextManager) {
        return autoNextManager.ensureModal();
    }
}

function showAutoNextModal(seconds, preview, onCancel) {
    if (autoNextManager) {
        autoNextManager.showModal(seconds, preview, onCancel);
    }
}

function hideAutoNextModal() {
    if (autoNextManager) {
        autoNextManager.hideModal();
    }
}

function scheduleAutoNextNavigation(nextHref, preview) {
    if (autoNextManager) {
        autoNextManager.scheduleNavigation(nextHref, preview);
    }
}

function startLiveStatusWatcher() {
    if (autoNextManager) {
        autoNextManager.startWatcher();
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
        options.isOpenSidebar = changes.isOpenSidebar.newValue;
        appState.sidebar.isOpen = changes.isOpenSidebar.newValue;
        // 開閉に応じて停止/再開・即時更新
        handleSidebarOpenStateChange(appState.sidebar.isOpen);
    }
    if (changes.sidebarWidth) {
        options.sidebarWidth = changes.sidebarWidth.newValue;
        appState.sidebar.width = changes.sidebarWidth.newValue;
    }
    if (changes.autoNextProgram) {
        options.autoNextProgram = changes.autoNextProgram.newValue;
        if (options.autoNextProgram === 'on') startLiveStatusWatcher();
        else stopLiveStatusWatcher();
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
        optionContainerEl.insertAdjacentHTML('beforeend', optionHtml);
        // サイドバー外にはみ出しても見えるように、body直下へ移動
        document.body.appendChild(optionContainerEl);
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

// API統計の初期化（開発・デバッグ用）
initApiStats();



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

/**
 * 最低ローディング時間を確保してセッションを完了する
 * LoadingManager に完全委譲
 */
async function finishLoadingSessionWithMinDuration(minDuration = 1000) {
    if (loadingManager) {
        await loadingManager.finishSessionWithMinDuration(minDuration);
    }
}

async function performInitialLoad() {
    if (updateManager) {
        await updateManager.performInitialLoad();
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

/**
 * 番組数を表示する
 * @param {number} count - 番組数
 */
function updateProgramCount(count) {
    if (updateManager) {
        updateManager.updateProgramCount(count);
    }
}

/**
 * ローディング状態を更新（更新ボタンにローディング表示を適用）
 * LoadingManager に委譲
 */
function updateLoadingState() {
    if (loadingManager) {
        loadingManager.updateLoadingState();
    }
}

async function updateSidebar() {
    if (updateManager) {
        await updateManager.updateSidebar();
    }
}

/**
 * active-point属性を更新してソートを実行
 * 番組詳細情報が取得された後に呼ばれる
 * @param {boolean} shouldSort - ソートを実行するかどうか（初回/サイドバーオープン/更新ボタン時のみtrue）
 */
function updateActivePointsAndSort(shouldSort = false) {
    if (updateManager) {
        updateManager.updateActivePointsAndSort(shouldSort);
    }
}

function updateThumbnail(force, onComplete) {
    if (updateManager) {
        updateManager.updateThumbnail(force, onComplete);
    }
}

/**
 * オプション内容を反映
 * handlers/optionsHandler.js に完全委譲
 */
const reflectOptions = () => {
    setupOptionsHandler(options, programInfoQueue, sortPrograms);
};
