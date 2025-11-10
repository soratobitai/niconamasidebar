// CSSファイルをインポート（ViteでCSSファイルを出力するため）
import './styles/main.css'
import { sidebarMinWidth, maxSaveProgramInfos, updateThumbnailInterval, toDolistsInterval, loadingSessionTimeoutMs } from './config/constants.js'
import { debounce } from './utils/dom.js'
import { getOptions as getOptionsFromStorage, saveOptions as saveOptionsToStorage, getProgramInfos as getProgramInfosFromStorage, upsertProgramInfo as upsertProgramInfoFromStorage } from './services/storage.js'
import { fetchLivePrograms, fetchProgramInfo } from './services/api.js'
import { makeProgramElement, makeProgramsHtml, calculateActivePoint, attachThumbnailErrorHandlers, updateThumbnailsFromStorage, sortProgramsByActivePoint, buildSidebarShell, initThumbnailVisibilityObserver, refreshThumbnailObservations, teardownThumbnailVisibilityObserver } from './render/sidebar.js'
import { createSidebarControl } from './ui/sidebarControl.js'
import { adjustWatchPageChild, setProgramContainerWidth } from './ui/layout.js'
import { observeProgramEnd } from './services/status.js'
import { AppState } from './core/AppState.js'
import { ProgramInfoQueue } from './services/queue.js'

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
        // 独立サイクル: キューが空になったら設定時間後に再度キュー処理を開始
        // shouldSortがfalseの場合のみ（初回/サイドバーオープン/更新ボタン時は除外）
        if (!programInfoQueue.shouldSort && appState.sidebar.isOpen) {
            // 既存のタイマーをクリア
            if (appState.getTimer('queueRestart')) {
                clearTimeout(appState.getTimer('queueRestart'));
            }
            // 設定時間後に再開
            const timer = setTimeout(() => {
                if (appState.sidebar.isOpen) {
                    // DOM上の番組をキューに追加
                    const container = document.getElementById('liveProgramContainer');
                    if (container) {
                        const programElements = container.querySelectorAll('.program_container');
                        const programIds = Array.from(programElements).map(el => el.id).filter(id => id);
                        if (programIds.length > 0) {
                            programInfoQueue.add(programIds);
                        }
                    }
                }
                appState.clearTimer('queueRestart');
            }, Number(options.updateProgramsInterval) * 1000);
            appState.setTimer('queueRestart', timer);
        }
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
        await handleSidebarOpenStateChange(true);
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
                // キューが空でサムネイル更新も完了していればセッションを完了
                // これにより、バックグラウンドに移行した後にセッションが残り続ける問題を防ぐ
                if (currentUpdateSessionId && programInfoQueue.size() === 0 && !isUpdatingThumbnail) {
                    // 少し待ってからチェック（他の処理が完了するのを待つ）
                    setTimeout(() => {
                        if (currentUpdateSessionId && programInfoQueue.size() === 0 && !isUpdatingThumbnail) {
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
        // startToDoListUpdate()はここでは呼ばない（performInitialLoad内で呼ばれるため重複を避ける）
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
    function runUpdateThumbnail() {
        updateThumbnail();
        const timer = setTimeout(runUpdateThumbnail, updateThumbnailInterval * 1000);
        appState.setTimer('thumbnail', timer);
    }
    const timer = setTimeout(runUpdateThumbnail, updateThumbnailInterval * 1000);
    appState.setTimer('thumbnail', timer);
}

// ToDoリスト更新開始（新しいQueueクラスを使用）
const startToDoListUpdate = async () => {
    // oneTimeFlagの処理（ページ読み込み時の初回更新）
    if (appState.update.oneTimeFlag) {
        await performInitialLoad(); // 初回ロードを実行（番組詳細も全件取得、完了まで待つ）
        appState.update.oneTimeFlag = false;
    }
    
    // キュー処理を開始
    programInfoQueue.start();
    
    // タイマーIDを保存（停止用）
    // Queueクラスの内部タイマーを使用するため、ここではダミーを設定
    appState.setTimer('todo', 'queue-managed');
}

// サイドバー更新開始
const startSidebarUpdate = () => {
    // 既存のタイマーがある場合は確実にクリア
    const existingTimer = appState.getTimer('sidebar');
    if (existingTimer && existingTimer !== 'queue-managed') {
        clearTimeout(existingTimer);
    }
    
    async function updateSidebarInterval() {
        // ソートフラグはOFFのまま（定期更新ではソートしない）
        await updateSidebar(); // 完了を待つ
        // 定期更新時：最低1秒のローディング時間を確保して終了
        if (currentUpdateSessionId) {
            await finishLoadingSessionWithMinDuration(1000);
        }
        // 完了後にタイマーをセット
        const timer = setTimeout(updateSidebarInterval, Number(options.updateProgramsInterval) * 1000);
        appState.setTimer('sidebar', timer);
    }
    const timer = setTimeout(updateSidebarInterval, Number(options.updateProgramsInterval) * 1000);
    appState.setTimer('sidebar', timer);
}

// 自動次番組モーダル生成と表示/非表示
function ensureAutoNextModal() {
    let modal = document.getElementById('auto_next_modal');
    if (modal) return modal;
    
    // DOM要素を直接作成（innerHTMLを使用しない）
    modal = document.createElement('div');
    modal.id = 'auto_next_modal';
    
    // バックドロップ
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    modal.appendChild(backdrop);
    
    // ダイアログ
    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    
    // タイトル
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'ニコ生サイドバーによる自動移動';
    dialog.appendChild(title);
    
    // メッセージ
    const message = document.createElement('div');
    message.className = 'message';
    const countSpan = document.createElement('span');
    countSpan.id = 'auto_next_count';
    countSpan.textContent = '10';
    message.appendChild(countSpan);
    message.appendChild(document.createTextNode('秒後に次の番組へ移動します。'));
    dialog.appendChild(message);
    
    // プレビュー
    const preview = document.createElement('div');
    preview.className = 'preview';
    
    const providerDiv = document.createElement('div');
    providerDiv.id = 'auto_next_provider';
    providerDiv.className = 'preview-provider';
    preview.appendChild(providerDiv);
    
    const thumbDiv = document.createElement('div');
    thumbDiv.className = 'thumb';
    const thumbImg = document.createElement('img');
    thumbImg.id = 'auto_next_thumb';
    thumbImg.alt = '';
    thumbDiv.appendChild(thumbImg);
    preview.appendChild(thumbDiv);
    
    const titleDiv = document.createElement('div');
    titleDiv.id = 'auto_next_title';
    titleDiv.className = 'preview-title';
    preview.appendChild(titleDiv);
    
    dialog.appendChild(preview);
    
    // アクション
    const actions = document.createElement('div');
    actions.className = 'actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'auto_next_cancel';
    cancelBtn.textContent = 'キャンセル';
    actions.appendChild(cancelBtn);
    dialog.appendChild(actions);
    
    modal.appendChild(dialog);
    document.body.appendChild(modal);
    return modal;
}

function showAutoNextModal(seconds, preview, onCancel) {
    const modal = ensureAutoNextModal();
    const countEl = modal.querySelector('#auto_next_count');
    const cancelBtn = modal.querySelector('#auto_next_cancel');
    if (countEl) countEl.textContent = String(seconds);

    // プレビュー設定
    try {
        const thumbEl = modal.querySelector('#auto_next_thumb');
        const titleEl = modal.querySelector('#auto_next_title');
        const providerEl = modal.querySelector('#auto_next_provider');
        if (thumbEl && preview && preview.thumb) thumbEl.src = preview.thumb;
        if (titleEl && preview && typeof preview.title === 'string') titleEl.textContent = preview.title;
        if (providerEl && preview && typeof preview.provider === 'string') providerEl.textContent = preview.provider;
    } catch (_e) {}
    modal.classList.add('show');
    const onCancelHandler = (e) => {
        e.preventDefault();
        hideAutoNextModal();
        appState.autoNext.canceled = true;
        if (typeof onCancel === 'function') onCancel();
    };
    if (cancelBtn) {
        cancelBtn.addEventListener('click', onCancelHandler, { once: true });
    }
}

function hideAutoNextModal() {
    const modal = document.getElementById('auto_next_modal');
    if (modal) modal.classList.remove('show');
}

function scheduleAutoNextNavigation(nextHref, preview) {
    // 既存のカウントダウンが生きていれば停止
    const existingTimer = appState.getTimer('autoNext');
    if (existingTimer) {
        try { clearInterval(existingTimer); } catch (_e) {}
        appState.clearTimer('autoNext');
    }
    let remaining = 10;
    appState.autoNext.canceled = false;
    showAutoNextModal(remaining, preview, () => {
        const timer = appState.getTimer('autoNext');
        if (timer) {
            clearInterval(timer);
            appState.clearTimer('autoNext');
        }
        appState.autoNext.scheduled = true;
    });
    const modal = ensureAutoNextModal();
    const countEl = modal.querySelector('#auto_next_count');
    const timer = setInterval(() => {
        remaining -= 1;
        if (countEl) countEl.textContent = String(Math.max(0, remaining));
        if (appState.autoNext.canceled) {
            clearInterval(timer);
            appState.clearTimer('autoNext');
            hideAutoNextModal();
            return;
        }
        if (remaining <= 0) {
            clearInterval(timer);
            appState.clearTimer('autoNext');
            hideAutoNextModal();
            if (!appState.autoNext.canceled) {
                try { location.assign(nextHref); } catch (_e) {}
            }
        }
    }, 1000);
    appState.setTimer('autoNext', timer);
}

// 視聴中番組の終了監視
function startLiveStatusWatcher() {
    stopLiveStatusWatcher();
    const stopper = observeProgramEnd(async () => {
        // 多重進入抑止
        if (appState.autoNext.scheduled || appState.autoNext.selectingNext) return;
        appState.autoNext.selectingNext = true;
        try {
            await updateSidebar();
            const links = document.querySelectorAll('#liveProgramContainer .program_container .program_thumbnail a');
            const currentIdMatch = location.pathname.match(/\/watch\/(lv\d+)/);
            const currentId = currentIdMatch ? currentIdMatch[1] : '';

            let targetLink = null;
            for (const a of links) {
                try {
                    const nextPath = new URL(a.href, location.href).pathname;
                    const nextIdMatch = nextPath.match(/\/watch\/(lv\d+)/);
                    const nextId = nextIdMatch ? nextIdMatch[1] : '';
                    if (currentId && nextId && nextId !== currentId) {
                        targetLink = a;
                        break;
                    }
                } catch (_e) {}
            }

            if (targetLink && targetLink.href) {
                appState.autoNext.scheduled = true;
                // プレビュー情報抽出
                let preview = null;
                try {
                    const card = targetLink.closest('.program_container');
                    const imgEl = card ? card.querySelector('.program_thumbnail_img') : null;
                    const titleEl = card ? card.querySelector('.program_title') : null;
                    const providerEl = card ? card.querySelector('.community_name') : null;
                    preview = {
                        href: targetLink.href,
                        thumb: imgEl && imgEl.src ? imgEl.src : '',
                        title: titleEl && titleEl.textContent ? titleEl.textContent.trim() : '',
                        provider: providerEl && providerEl.textContent ? providerEl.textContent.trim() : '',
                    };
                } catch (_e) {}
                scheduleAutoNextNavigation(targetLink.href, preview);
            }
        } catch (_e) {}
        finally {
            // 次回の検出に備えて解除（autoNextScheduled が true の場合は以降で抑止される）
            appState.autoNext.selectingNext = false;
        }
    });
    appState.autoNext.liveStatusStopper = stopper;
}

function stopLiveStatusWatcher() {
    if (appState.autoNext.liveStatusStopper) {
        try { appState.autoNext.liveStatusStopper(); } catch (_e) {}
        appState.autoNext.liveStatusStopper = null;
    }
    appState.clearTimer('autoNext');
    hideAutoNextModal();
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
    const existingTimer = appState.getTimer('sidebar');
    if (existingTimer && existingTimer !== 'queue-managed') {
        clearTimeout(existingTimer);
    }
    appState.clearTimer('sidebar');
    startSidebarUpdate();
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

// API呼び出しカウンター（重複検出用）- グローバルに設定してqueue.jsからもアクセス可能に
window.apiCallCounter = {
    getLivePrograms: 0,
    fetchProgramInfo: 0,
    totalCalls: 0,
    startTime: Date.now()
};
const apiCallCounter = window.apiCallCounter;

// API呼び出し統計を定期的に表示（5分ごと、コンパクト版）
setInterval(() => {
    const elapsed = Math.floor((Date.now() - apiCallCounter.startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    
    // 過去1分間の実際の呼び出し頻度を計算
    if (!apiCallCounter.recentTimestamps) {
        apiCallCounter.recentTimestamps = [];
    }
    const now = Date.now();
    apiCallCounter.recentTimestamps = apiCallCounter.recentTimestamps.filter(t => now - t < 60000);
    const recentRate = apiCallCounter.recentTimestamps.length;
    
    // 異常な頻度の場合のみ警告（過去1分間に100回以上）
    if (recentRate > 100) {
        console.warn(`⚠️ [API統計] 過去1分間の呼び出し頻度が高い: ${recentRate}回/分 (getLivePrograms: ${apiCallCounter.getLivePrograms}, fetchProgramInfo: ${apiCallCounter.fetchProgramInfo})`);
    }
}, 300000); // 5分ごと

// コンソールから手動でAPI統計を確認できる関数
window.showApiStats = () => {
    const elapsed = ((Date.now() - apiCallCounter.startTime) / 1000).toFixed(0);
    const averageRate = (apiCallCounter.totalCalls / (elapsed / 60)).toFixed(2);
    
    // 過去1分間の実際の呼び出し頻度を計算
    if (!apiCallCounter.recentTimestamps) {
        apiCallCounter.recentTimestamps = [];
    }
    const now = Date.now();
    apiCallCounter.recentTimestamps = apiCallCounter.recentTimestamps.filter(t => now - t < 60000);
    const recentRate = apiCallCounter.recentTimestamps.length;
    
    console.log('=== API呼び出し統計 ===');
    console.log(`getLivePrograms: ${apiCallCounter.getLivePrograms}回`);
    console.log(`fetchProgramInfo: ${apiCallCounter.fetchProgramInfo}回`);
    console.log(`合計: ${apiCallCounter.totalCalls}回`);
    console.log(`経過時間: ${elapsed}秒 (${(elapsed / 60).toFixed(1)}分)`);
    console.log(`平均頻度: ${averageRate}回/分`);
    console.log(`過去1分間の実際の頻度: ${recentRate}回/分`);
    return apiCallCounter;
};

// updateSidebar呼び出し統計を確認できる関数
window.showUpdateSidebarStats = () => {
    console.group('📊 updateSidebar() 呼び出し統計');
    console.log(`総呼び出し数: ${updateSidebarCallTracker.totalCalls}`);
    console.log(`現在実行中: ${updateSidebarCallTracker.activeCalls}`);
    console.log(`拒否された呼び出し: ${updateSidebarCallTracker.rejectedCalls}`);
    
    // 呼び出し元の集計
    const callerCount = {};
    updateSidebarCallTracker.callHistory.forEach(call => {
        callerCount[call.caller] = (callerCount[call.caller] || 0) + 1;
    });
    console.log('呼び出し元の内訳（直近10件）:', callerCount);
    
    console.group('直近10件の呼び出し履歴');
    updateSidebarCallTracker.callHistory.forEach((call, index) => {
        const timeAgo = ((Date.now() - call.timestamp) / 1000).toFixed(1);
        console.log(`${index + 1}. #${call.callId} - ${call.caller} (${timeAgo}秒前)`);
    });
    console.groupEnd();
    console.groupEnd();
    return updateSidebarCallTracker;
};

async function getLivePrograms(rows = 100) {
    apiCallCounter.getLivePrograms++;
    apiCallCounter.totalCalls++;
    const callId = apiCallCounter.totalCalls;
    
    // タイムスタンプを記録（API呼び出し頻度の計算用）
    const now = Date.now();
    if (!apiCallCounter.recentTimestamps) {
        apiCallCounter.recentTimestamps = [];
    }
    apiCallCounter.recentTimestamps.push(now);
    
    // 異常検出：getLiveProgramsが1分以内に10回以上呼ばれた場合のみ警告
    if (!apiCallCounter.getLiveProgramsTimestamps) {
        apiCallCounter.getLiveProgramsTimestamps = [];
    }
    apiCallCounter.getLiveProgramsTimestamps.push(now);
    // 1分以上前のタイムスタンプを削除
    apiCallCounter.getLiveProgramsTimestamps = apiCallCounter.getLiveProgramsTimestamps.filter(t => now - t < 60000);
    
    if (apiCallCounter.getLiveProgramsTimestamps.length >= 10) {
        console.error(`🚨 [異常検出] getLivePrograms()が1分以内に${apiCallCounter.getLiveProgramsTimestamps.length}回呼ばれています！`);
    }
    
    const result = await fetchLivePrograms(rows);
    
    if (elems.apiErrorElement) {
        elems.apiErrorElement.style.display = result ? 'none' : 'block';
    }
    return result;
}

// getProgramInfo_and_saveLocalStorage は ProgramInfoQueue を使用するため削除
// キューに追加するだけの関数として置き換え

// 現在の更新セッションIDを保存（エラー時にも完了できるように）
let currentUpdateSessionId = null;
// セッション開始時刻とタイムアウトタイマー
let sessionStartTime = null;
let sessionTimeoutTimer = null;
/**
 * ローディングセッションを完了する（タイムアウトタイマーもクリア）
 */
function finishLoadingSession() {
    if (!currentUpdateSessionId) {
        return;
    }
    
    const sessionId = currentUpdateSessionId;
    const duration = sessionStartTime ? (performance.now() - sessionStartTime).toFixed(0) : 'unknown';
    
    // 異常に長いセッション（10秒以上）の場合のみ警告
    if (duration !== 'unknown' && parseFloat(duration) > 10000) {
        console.warn(`⚠️ [異常検出] ローディングセッションが${(duration / 1000).toFixed(1)}秒かかりました`, {
            sessionId
        });
    }
    
    if (sessionTimeoutTimer) {
        clearTimeout(sessionTimeoutTimer);
        sessionTimeoutTimer = null;
    }
    if (currentUpdateSessionId) {
        appState.finishUpdateSession(currentUpdateSessionId);
        currentUpdateSessionId = null;
    }
    sessionStartTime = null;
    updateLoadingState();
}

/**
 * 最低ローディング時間を確保してセッションを完了する
 * @param {number} minDuration - 最低表示時間（ミリ秒、デフォルト1000ms）
 */
async function finishLoadingSessionWithMinDuration(minDuration = 1000) {
    if (!currentUpdateSessionId || !sessionStartTime) {
        finishLoadingSession();
        return;
    }
    
    const elapsed = performance.now() - sessionStartTime;
    const remaining = minDuration - elapsed;
    
    if (remaining > 0) {
        // 最低表示時間に達していない場合は待つ
        await new Promise(resolve => setTimeout(resolve, remaining));
    }
    
    finishLoadingSession();
}

/**
 * 初回ロードを実行（ページ読み込み時のみ）
 * updateSidebar() + 番組詳細取得（全件） + サムネイル更新
 * すべて完了までローディング維持
 */
let isPerformingInitialLoad = false;
async function performInitialLoad() {
    // 重複実行を防ぐ
    if (isPerformingInitialLoad) {
        console.warn('[初回ロード] 既に実行中のため、スキップします');
        return;
    }
    
    isPerformingInitialLoad = true;
    try {
        // ソートフラグをON
        programInfoQueue.setShouldSort(true);
        
        // 番組リスト更新
        await updateSidebar();
        
        // DOM更新完了を待つ（requestAnimationFrameで次のフレームまで待機）
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        
        // 番組詳細取得（全件、キューが空になるまで）
        const initialQueueSize = programInfoQueue.size();
        
        if (initialQueueSize > 0) {
            // processNow()で全件処理（maxItems=nullで全件）
            await programInfoQueue.processNow(null).catch(error => {
                console.error('[初回ロード] キュー処理でエラーが発生しました:', error);
            });
        }
        
        // サムネイル更新（forceフラグON）
        await new Promise(resolve => {
            updateThumbnail(true, resolve);
        });
        
        // 最低1秒のローディング時間を確保して終了
        await finishLoadingSessionWithMinDuration(1000);
        
        // 定期タイマーをリセット
        if (appState.sidebar.isOpen) {
            restartSidebarUpdate();
        }
    } catch (error) {
        console.error('[初回ロード] エラーが発生しました:', error);
        // エラー時もローディングを終了
        if (currentUpdateSessionId) {
            await finishLoadingSessionWithMinDuration(1000);
        }
    } finally {
        isPerformingInitialLoad = false; // フラグをリセット
    }
}

/**
 * 手動更新を実行（サイドバーオープン、タブ切替、更新ボタン押下）
 * updateSidebar() + サムネイル更新のみ
 * 番組詳細取得はバックグラウンドで自動実行
 */
async function performManualUpdate() {
    try {
        // ソートフラグをON
        programInfoQueue.setShouldSort(true);
        
        // 番組リスト更新
        await updateSidebar();
        
        // サムネイル更新（forceフラグON）
        await new Promise(resolve => {
            updateThumbnail(true, resolve);
        });
        
        // 最低1秒のローディング時間を確保して終了
        await finishLoadingSessionWithMinDuration(1000);
        
        // 定期タイマーをリセット
        if (appState.sidebar.isOpen) {
            restartSidebarUpdate();
        }
    } catch (error) {
        console.error('[手動更新] エラーが発生しました:', error);
        // エラー時もローディングを終了
        if (currentUpdateSessionId) {
            await finishLoadingSessionWithMinDuration(1000);
        }
    }
}

/**
 * 番組リストをソート
 * @param {HTMLElement} container - 番組コンテナ
 */
function sortPrograms(container) {
    if (!container || container.children.length === 0) return;
    
    if (options.programsSort === 'active') {
        // 人気順：active-point属性でソート
        sortProgramsByActivePoint(container);
    } else {
        // 新着順：番組IDでソート（IDが大きいほど新しい）
        const programs = Array.from(container.children);
        programs.sort((a, b) => {
            const idA = parseInt(a.id, 10) || 0;
            const idB = parseInt(b.id, 10) || 0;
            return idB - idA; // 降順（新しいものが上）
        });
        programs.forEach((program) => container.appendChild(program));
    }
}

/**
 * 番組数を表示する
 * @param {number} count - 番組数
 */
function updateProgramCount(count) {
    const programCountElement = document.getElementById('program_count');
    if (programCountElement) {
        programCountElement.textContent = String(count);
    }
}

/**
 * ローディング状態を更新（更新ボタンにローディング表示を適用）
 */
function updateLoadingState() {
    const reloadBtn = document.getElementById('reload_programs');
    if (!reloadBtn) {
        return;
    }
    
    const isLoading = appState.isLoading();
    
    if (isLoading) {
        // ローディング中：更新ボタンを無効化し、ローディング表示を追加
        if (!reloadBtn.classList.contains('loading')) {
            reloadBtn.classList.add('loading');
            reloadBtn.style.pointerEvents = 'none'; // クリック無効化
        }
    } else {
        // 全ての処理が完了：ローディング表示を解除し、更新ボタンを有効化
        if (reloadBtn.classList.contains('loading')) {
            reloadBtn.classList.remove('loading');
            reloadBtn.style.pointerEvents = ''; // クリック有効化
        }
    }
}

// セッション完了の判定はupdateSidebar()のfinally内で行う
// キュー処理とサムネイル更新は別タイマーでバックグラウンド実行される

// updateSidebar呼び出し追跡用
let updateSidebarCallTracker = {
    totalCalls: 0,
    activeCalls: 0,
    rejectedCalls: 0,
    callHistory: [], // 直近10件の呼び出し履歴
    lastCallTime: 0,
    rapidCallCount: 0, // 短期間の呼び出し回数
    rapidCallWindow: 10000 // 10秒以内の呼び出しを「短期間」とみなす
};

async function updateSidebar() {
    updateSidebarCallTracker.totalCalls++;
    const callId = updateSidebarCallTracker.totalCalls;
    const now = Date.now();
    
    // 呼び出し元を特定（スタックトレースから）
    const stack = new Error().stack;
    const stackLines = stack.split('\n').slice(1, 6);
    let caller = 'unknown';
    for (const line of stackLines) {
        if (line.includes('handleSidebarOpenStateChange')) {
            caller = 'サイドバーを開いた時';
            break;
        } else if (line.includes('handleVisibilityChange')) {
            caller = 'タブがアクティブになった時';
            break;
        } else if (line.includes('updateSidebarInterval')) {
            caller = '定期更新タイマー';
            break;
        } else if (line.includes('reloadBtnHandler') || line.includes('click')) {
            caller = 'リロードボタン';
            break;
        } else if (line.includes('selectNextProgram')) {
            caller = '次番組選択';
            break;
        } else if (line.includes('startToDoListUpdate')) {
            caller = '初期化';
            break;
        } else if (line.includes('setTimeout') && line.includes('updateSidebar')) {
            caller = 'pending再実行';
            break;
        } else if (line.includes('optionForm')) {
            caller = 'オプション変更';
            break;
        }
    }
    
    // 短期間（10秒以内）の呼び出し回数をカウント
    if (now - updateSidebarCallTracker.lastCallTime < updateSidebarCallTracker.rapidCallWindow) {
        updateSidebarCallTracker.rapidCallCount++;
    } else {
        updateSidebarCallTracker.rapidCallCount = 1;
    }
    updateSidebarCallTracker.lastCallTime = now;
    
    // 呼び出し履歴に追加（最大10件）
    updateSidebarCallTracker.callHistory.push({
        callId,
        caller,
        timestamp: now,
        isUpdating: appState.update.isUpdating,
        pending: appState.update.pending
    });
    if (updateSidebarCallTracker.callHistory.length > 10) {
        updateSidebarCallTracker.callHistory.shift();
    }
    
    // 異常検出：10秒以内に5回以上呼ばれた場合のみ警告
    if (updateSidebarCallTracker.rapidCallCount >= 5) {
        console.error(`🚨 [異常検出] updateSidebar()が10秒以内に${updateSidebarCallTracker.rapidCallCount}回呼ばれています！`, {
            callId,
            caller,
            totalCalls: updateSidebarCallTracker.totalCalls,
            rejectedCalls: updateSidebarCallTracker.rejectedCalls,
            最近の呼び出し元: updateSidebarCallTracker.callHistory.slice(-5).map(h => h.caller)
        });
    }
    
    // 多重実行を抑止し、終了後に1回だけ追従実行
    if (appState.update.isUpdating) {
        updateSidebarCallTracker.rejectedCalls++;
        
        // 異常検出：拒否が連続5回以上の場合のみ警告
        if (updateSidebarCallTracker.rejectedCalls % 5 === 0) {
            console.error(`🚨 [異常検出] updateSidebar()の拒否が${updateSidebarCallTracker.rejectedCalls}回に達しました`, {
                caller,
                pending: appState.update.pending
            });
        }
        
        appState.update.pending = true;
        return;
    }
    
    updateSidebarCallTracker.activeCalls++;
    appState.update.isUpdating = true;
    appState.update.isInserting = true;
    
    // 更新セッションを開始（すべての処理を包括的に管理）
    // 既存のセッションがある場合は警告を出すが、完了はさせない（呼び出し元で制御）
    if (currentUpdateSessionId) {
        console.warn('[ローディング] 既存のセッションが存在します:', currentUpdateSessionId);
    }
    
    currentUpdateSessionId = appState.startUpdateSession();
    sessionStartTime = performance.now();
    updateLoadingState();
    
    // タイムアウトタイマーを設定（一定時間経過後に強制的にセッションを完了）
    // セッションIDをクロージャで保持して、確実に動作させる
    const sessionIdForTimeout = currentUpdateSessionId;
    if (sessionTimeoutTimer) {
        clearTimeout(sessionTimeoutTimer);
    }
    sessionTimeoutTimer = setTimeout(() => {
        // セッションIDが一致する場合のみ完了（新しいセッションが開始されている場合は無視）
        if (currentUpdateSessionId === sessionIdForTimeout) {
            console.warn('[ローディング] タイムアウト: セッションを強制完了します');
            finishLoadingSession();
        }
    }, loadingSessionTimeoutMs);
    
    try {
        // localStorageから番組情報を取得
        const programInfos = getProgramInfosFromStorage();

        const livePrograms = await getLivePrograms(100);
        // 失敗時は何も変更しない（ローディング終了は呼び出し元で制御）
        if (!livePrograms) {
            // 失敗時も既存の番組数を維持
            const container = document.getElementById('liveProgramContainer');
            if (container && container.children.length > 0) {
                updateProgramCount(container.children.length);
            }
            return;
        }
        // 空配列（0件）のときは既存DOMを維持して終了（フリッカー防止）
        if (Array.isArray(livePrograms) && livePrograms.length === 0) {
            updateProgramCount(0);
            return;
        }

        const container = document.getElementById('liveProgramContainer');
        const frag = document.createDocumentFragment();
        const existingMap = new Map();
        if (container) {
            Array.from(container.children).forEach((el) => {
                if (el && el.id) existingMap.set(el.id, el);
            });
        }

        livePrograms.forEach(function (program) {
            if (!program || !program.id) return;

            const data = programInfos.find((info) => info.id === `lv${program.id}`);
            const id = String(program.id);
            const existing = existingMap.get(id);

            if (existing) {
                // 軽い更新（属性・タイトル・リンク先）
                existing.setAttribute('active-point', String(calculateActivePoint(data || program)));
                const titleEl = existing.querySelector('.program_title');
                if (titleEl) titleEl.textContent = (data && data.title) || (program && program.title) || 'タイトル不明';
                const linkEl = existing.querySelector('.program_thumbnail a');
                if (linkEl) linkEl.href = data && data.id ? `https://live.nicovideo.jp/watch/${data.id}` : `https://live.nicovideo.jp/watch/lv${program.id}`;
                frag.appendChild(existing);
            } else {
                // DOM要素を直接作成（innerHTMLを使用しない）
                const element = data 
                    ? makeProgramElement(data, loadingImageURL) 
                    : makeProgramElement(program, loadingImageURL);
                if (element) {
                    frag.appendChild(element);
                }
            }

            // 新しいQueueクラスに追加（重複チェックとFIFO処理はQueueクラスで自動的に行われる）
            programInfoQueue.add(program.id);
        });

        // 一旦すべての番組を取り除く → 置き換え対象が無い場合は何もしない
        const liveProgramContainer = document.getElementById('liveProgramContainer');
        if (!liveProgramContainer) {
            // 早期リターン時も番組数を表示（既存の番組数を維持）
            const container = document.getElementById('liveProgramContainer');
            if (container && container.children.length > 0) {
                updateProgramCount(container.children.length);
            }
            return;
        }
        if (!frag.firstChild) {
            // 早期リターン時も番組数を表示（既存の番組数を維持）
            updateProgramCount(livePrograms.length);
            return;
        }
        
        // 挿入（置き換え）
        liveProgramContainer.replaceChildren(frag);
        // 監視対象を更新
        refreshThumbnailObservations();

        // ソート
        // 注意: この時点では番組詳細情報が未取得の場合があるため、不完全なactive-pointでソートされる可能性がある
        // ただし、キュー処理完了後にupdateActivePointsAndSort()で正しい値で再ソートされる
        const container2 = document.getElementById('liveProgramContainer');
        if (container2) sortPrograms(container2);

        setProgramContainerWidth(elems, elems.sidebar ? elems.sidebar.offsetWidth : appState.sidebar.width);

        // 番組数更新（ローディング状態は他の処理が完了するまで維持）
        updateProgramCount(livePrograms.length);

        attachThumbnailErrorHandlers();
    } catch (error) {
        console.error('[ローディング] updateSidebar() catch ブロック', error);
        // エラー発生時のローディング終了は呼び出し元で制御
        throw error;
    } finally {
        appState.update.isInserting = false;
        appState.update.isUpdating = false;
        updateSidebarCallTracker.activeCalls--;
        
        // ローディング終了は呼び出し元で制御
        // 手動更新時：キュー処理とサムネイル更新完了後に終了
        // 定期更新時：updateSidebar()完了時点で終了
        
        if (appState.update.pending) {
            appState.update.pending = false;
            setTimeout(() => { 
                updateSidebar(); 
            }, 0);
        }
    }
}

/**
 * active-point属性を更新してソートを実行
 * 番組詳細情報が取得された後に呼ばれる
 * @param {boolean} shouldSort - ソートを実行するかどうか（初回/サイドバーオープン/更新ボタン時のみtrue）
 */
function updateActivePointsAndSort(shouldSort = false) {
    const container = document.getElementById('liveProgramContainer');
    if (!container) return;

    const programInfos = getProgramInfosFromStorage();
    if (!programInfos || !Array.isArray(programInfos)) return;

    // 全ての番組要素のactive-pointを更新
    const programElements = container.querySelectorAll('.program_container');
    let hasUpdate = false;
    
    programElements.forEach((element) => {
        if (!element.id) return;
        
        const programId = `lv${element.id}`;
        const programInfo = programInfos.find((info) => info.id === programId);
        
        if (programInfo) {
            const newActivePoint = calculateActivePoint(programInfo);
            const currentActivePoint = parseFloat(element.getAttribute('active-point') || '0');
            
            // active-pointが更新される場合のみ更新
            if (Math.abs(newActivePoint - currentActivePoint) > 0.0001) {
                element.setAttribute('active-point', String(newActivePoint));
                hasUpdate = true;
            }
        }
    });

    // shouldSortがtrueで、active-pointが更新された場合のみソートを実行
    if (shouldSort && hasUpdate) {
        sortPrograms(container);
    }
}

function updateThumbnail(force, onComplete) {
    // DOM操作中は実行しない
    if (appState.update.isInserting) {
        console.warn('[サムネイル] DOM操作中のためスキップ');
        if (onComplete) onComplete();
        return;
    }

    const programInfos = getProgramInfosFromStorage();
    if (!programInfos || programInfos.length === 0) {
        console.warn('[サムネイル] 番組情報が存在しないためスキップ');
        if (onComplete) onComplete();
        return;
    }
    
    updateThumbnailsFromStorage(programInfos, { force: !!force, onComplete });
}

/**
 * オプション内容を反映
 */
const reflectOptions = () => {
    const updateCheckedState = (name, value) => {
        const elements = document.getElementsByName(name);
        if (elements.length === 0) return;
        
        elements.forEach(item => {
            item.checked = item.value === value;
        });
    };

    const saveOptions = () => {
        try {
            const autoOpenElement = document.querySelector('input[name="autoOpen"]:checked');
            const updateProgramsIntervalElement = document.querySelector('input[name="updateProgramsInterval"]:checked');
            const programsSortElement = document.querySelector('input[name="programsSort"]:checked');
            const autoNextProgramElement = document.querySelector('input[name="autoNextProgram"]:checked');

            if (!autoOpenElement || !updateProgramsIntervalElement || !programsSortElement || !autoNextProgramElement) {
                // console.warn('オプション設定が不完全です');
                return;
            }

            options.autoOpen = autoOpenElement.value;
            options.updateProgramsInterval = updateProgramsIntervalElement.value;
            options.programsSort = programsSortElement.value;
            options.autoNextProgram = autoNextProgramElement.value;

            saveOptionsToStorage(options);
        } catch (error) {
            // console.error('オプション保存エラー:', error);
        }
    };

    // 各設定を反映
    updateCheckedState('programsSort', options.programsSort);
    updateCheckedState('updateProgramsInterval', options.updateProgramsInterval);
    updateCheckedState('autoOpen', options.autoOpen);
    updateCheckedState('autoNextProgram', options.autoNextProgram);

    // フォームに変更があったら保存する
    document.getElementById('optionForm').addEventListener('change', (event) => {
        if (event.target.name === 'programsSort') {
            // ソート方式変更時は既存データでソート（APIリクエストなし、ローディングなし）
            programInfoQueue.setShouldSort(true);
            
            // オプションを先に保存（ソート順を反映）
            saveOptions();
            
            // 既存のDOMをソート（統一関数を使用）
            const container = document.getElementById('liveProgramContainer');
            if (container) {
                sortPrograms(container);
                // サムネイルのIntersectionObserver監視を更新
                refreshThumbnailObservations();
            }
            return; // saveOptions()は既に呼ばれているのでreturn
        }
        saveOptions();
    });
};
