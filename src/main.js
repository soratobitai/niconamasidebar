// CSSファイルをインポート（ViteでCSSファイルを出力するため）
import './styles/main.css'
import { sidebarMinWidth, maxSaveProgramInfos, updateThumbnailInterval, toDolistsInterval } from './config/constants.js'
import { liveStatusPollInterval } from './config/constants.js'
import { debounce } from './utils/dom.js'
import { getOptions as getOptionsFromStorage, saveOptions as saveOptionsToStorage, getProgramInfos as getProgramInfosFromStorage, upsertProgramInfo as upsertProgramInfoFromStorage } from './services/storage.js'
import { fetchLivePrograms, fetchProgramInfo } from './services/api.js'
import { makeProgramsHtml, calculateActivePoint, attachThumbnailErrorHandlers, updateThumbnailsFromStorage, sortProgramsByActivePoint, buildSidebarShell, initThumbnailVisibilityObserver, refreshThumbnailObservations, teardownThumbnailVisibilityObserver } from './render/sidebar.js'
import { createSidebarControl } from './ui/sidebarControl.js'
import { adjustWatchPageChild, setProgramContainerWidth } from './ui/layout.js'
import { checkLiveStatus } from './services/status.js'

const toDolists = [];

// タイマー管理用変数
let thumbnailUpdateTimer = null;
let toDoListTimer = null;
let sidebarUpdateTimer = null;
let resizeObserver_watchPage = null;
let resizeObserver_sidebar = null;

let sidebarWidth = sidebarMinWidth;
let isOpenSidebar = false;
let isInserting = false;
let oneTimeFlag = true;
let onResizeHandler = null;
let liveStatusTimer = null;
let autoNextCountdownTimer = null;
let autoNextScheduled = false;

let defaultOptions = {
    programsSort: 'newest',
    autoOpen: '3',
    updateProgramsInterval: '120', // 秒
    sidebarWidth: 360,
    isOpenSidebar: isOpenSidebar,
    autoNextProgram: 'off',
};
let options = {};
let elems = {};

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

document.addEventListener('DOMContentLoaded', async () => {
    
    // 別窓くんポップアップ時は終了
    if (params.get('popup') === 'on') return;

    // オプションを取得
    options = await getOptions();
    sidebarWidth = options.sidebarWidth;
    isOpenSidebar = !!options.isOpenSidebar;

    // 各要素を定義
    setElems();
    if (!elems.root) return; // root要素が存在しない場合は終了

    setup();
});

const setup = async () => {
    // サイドバーを挿入
    await insertSidebar();

    // オプション設定を反映（insertSidebar後に実行）
    reflectOptions();

    // Watchページの幅を設定
    adjustWatchPageChild(elems);

    // ウィンドウサイズの変更時
    onResizeHandler = debounce(() => {
        adjustWatchPageChild(elems);
        sidebarControl.setRootWidth();
        setProgramContainerWidth(elems, elems.sidebar ? elems.sidebar.offsetWidth : sidebarWidth);
    }, 150);
    window.addEventListener('resize', onResizeHandler);

    // watchPageサイズ変更時（幅のみ監視）
    let watchPageWidth = elems.watchPage ? elems.watchPage.clientWidth : 0;
    resizeObserver_watchPage = new ResizeObserver((entries) => {
        entries.forEach(function (entry) {
            if (entry.contentRect.width !== watchPageWidth) {
                adjustWatchPageChild(elems);
                watchPageWidth = entry.contentRect.width;
            }
        });
    });
    if (elems.watchPage) {
    if (elems.watchPage) {
        resizeObserver_watchPage.observe(elems.watchPage);
    }
    }

    // サイドバーのサイズ変更時
    resizeObserver_sidebar = new ResizeObserver((e) => {
        const width = elems.sidebar ? elems.sidebar.offsetWidth : sidebarWidth;
        setProgramContainerWidth(elems, width);

        // ウィンドウリサイズイベントを発行（シークポジションのズレ対策）
        window.dispatchEvent(new Event('resize'));
    });
    if (elems.sidebar) {
        resizeObserver_sidebar.observe(elems.sidebar);
    }

    // コメント欄　スクロールボタンを押す
    setTimeout(() => {
        const indicator = elems.playerSection ? elems.playerSection.querySelector('[class*="_indicator_"]') : null;
        if (indicator) indicator.click();
    }, 1000);

    // シアターモード切り替え時に実行
    for (let i = 0; i < elems.theaterButtons.length; i++) {
        elems.theaterButtons[i].addEventListener('click', function () {
            adjustWatchPageChild(elems);
        });
    }

    // 再読み込みボタン
    const reloadBtn = document.getElementById('reload_programs');
    if (reloadBtn) {
        reloadBtn.addEventListener('click', function () {
            updateSidebar();
        });
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
        sidebarWidth: { value: sidebarWidth },
        isOpenSidebar: { value: isOpenSidebar },
    };
    const sidebarControl = createSidebarControl(elems, state);
    const sidebarBtn = document.getElementById('sidebar_button');
    if (sidebarBtn) {
        sidebarBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();

            sidebarControl.toggleSidebar();
            setProgramContainerWidth(elems, elems.sidebar ? elems.sidebar.offsetWidth : sidebarWidth);
        });
    }

    // サイドバー境界線ドラッグ可能にする
    sidebarControl.enableSidebarLine();

    // 初期開閉状態の適用（直接open/close）
    const shouldOpenAtStart = (options.autoOpen == '1') || (options.autoOpen == '3' && !!options.isOpenSidebar);
    if (shouldOpenAtStart) {
        state.isOpenSidebar.value = true;
        isOpenSidebar = true;
        options.isOpenSidebar = true;
        sidebarControl.openSidebar();
        setProgramContainerWidth(elems, elems.sidebar ? elems.sidebar.offsetWidth : sidebarWidth);
        await handleSidebarOpenStateChange(true);
    } else {
        state.isOpenSidebar.value = false;
        isOpenSidebar = false;
        options.isOpenSidebar = false;
        sidebarControl.closeSidebar();
        setProgramContainerWidth(elems, 0);
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
}

// クリーンアップ関数
const cleanup = () => {
    // タイマーをクリア
    if (thumbnailUpdateTimer) {
        clearTimeout(thumbnailUpdateTimer);
        thumbnailUpdateTimer = null;
    }
    if (toDoListTimer) {
        clearInterval(toDoListTimer);
        toDoListTimer = null;
    }
    if (sidebarUpdateTimer) {
        clearTimeout(sidebarUpdateTimer);
        sidebarUpdateTimer = null;
    }
    if (liveStatusTimer) {
        clearInterval(liveStatusTimer);
        liveStatusTimer = null;
    }
    if (autoNextCountdownTimer) {
        clearInterval(autoNextCountdownTimer);
        autoNextCountdownTimer = null;
    }

    // ResizeObserverを切断
    if (resizeObserver_watchPage) {
        resizeObserver_watchPage.disconnect();
        resizeObserver_watchPage = null;
    }
    if (resizeObserver_sidebar) {
        resizeObserver_sidebar.disconnect();
        resizeObserver_sidebar = null;
    }
    teardownThumbnailVisibilityObserver();
    if (onResizeHandler) {
        window.removeEventListener('resize', onResizeHandler);
        onResizeHandler = null;
    }
    hideAutoNextModal();
}

// すべての更新タイマーを停止
function stopAllTimers() {
    if (thumbnailUpdateTimer) {
        clearTimeout(thumbnailUpdateTimer);
        thumbnailUpdateTimer = null;
    }
    if (toDoListTimer) {
        clearInterval(toDoListTimer);
        toDoListTimer = null;
    }
    if (sidebarUpdateTimer) {
        clearTimeout(sidebarUpdateTimer);
        sidebarUpdateTimer = null;
    }
}

// 開いたときに即時更新しつつ、各タイマーを開始
async function handleSidebarOpenStateChange(open) {
    if (open) {
        // すばやく最新化
        await updateSidebar();
        updateThumbnail();
        initThumbnailVisibilityObserver();
        if (!thumbnailUpdateTimer) startThumbnailUpdate();
        if (!toDoListTimer) startToDoListUpdate();
        if (!sidebarUpdateTimer) startSidebarUpdate();
    } else {
        stopAllTimers();
        teardownThumbnailVisibilityObserver();
    }
}

// サムネイル更新開始
const startThumbnailUpdate = () => {
    function runUpdateThumbnail() {
        updateThumbnail();
        thumbnailUpdateTimer = setTimeout(runUpdateThumbnail, updateThumbnailInterval * 1000);
    }
    thumbnailUpdateTimer = setTimeout(runUpdateThumbnail, updateThumbnailInterval * 1000);
}

// ToDoリスト更新開始
const startToDoListUpdate = () => {
    toDoListTimer = setInterval(function () {
        if (toDolists.length === 0) {
            if (oneTimeFlag) {
                updateSidebar();
                oneTimeFlag = false;
            }
        } else {
            getProgramInfo_and_saveLocalStorage(toDolists.shift());
        }
    }, toDolistsInterval * 1000);
}

// サイドバー更新開始
const startSidebarUpdate = () => {
    function updateSidebarInterval() {
        updateSidebar();
        sidebarUpdateTimer = setTimeout(updateSidebarInterval, Number(options.updateProgramsInterval) * 1000);
    }
    sidebarUpdateTimer = setTimeout(updateSidebarInterval, Number(options.updateProgramsInterval) * 1000);
}

// 自動次番組モーダル生成と表示/非表示
function ensureAutoNextModal() {
    let modal = document.getElementById('auto_next_modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'auto_next_modal';
    modal.innerHTML = `
<div class="backdrop"></div>
<div class="dialog">
  <div class="title">ニコ生サイドバーによる自動移動</div>
  <div class="message"><span id="auto_next_count">10</span>秒後に次の番組へ移動します。</div>
  <div class="preview">
    <div id="auto_next_provider" class="preview-provider"></div>
    <div class="thumb"><img id="auto_next_thumb" alt=""></div>
    <div id="auto_next_title" class="preview-title"></div>
  </div>
  <div class="actions">
    <button id="auto_next_cancel">キャンセル</button>
  </div>
</div>`;
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
    let remaining = 10;
    showAutoNextModal(remaining, preview, () => {
        if (autoNextCountdownTimer) {
            clearInterval(autoNextCountdownTimer);
            autoNextCountdownTimer = null;
        }
        autoNextScheduled = true;
    });
    const modal = ensureAutoNextModal();
    const countEl = modal.querySelector('#auto_next_count');
    autoNextCountdownTimer = setInterval(() => {
        remaining -= 1;
        if (countEl) countEl.textContent = String(Math.max(0, remaining));
        if (remaining <= 0) {
            clearInterval(autoNextCountdownTimer);
            autoNextCountdownTimer = null;
            hideAutoNextModal();
            try { location.assign(nextHref); } catch (_e) {}
        }
    }, 1000);
}

// 視聴中番組の終了監視
function startLiveStatusWatcher() {
    stopLiveStatusWatcher();
    liveStatusTimer = setInterval(async () => {
        try {
            const status = await checkLiveStatus();
            if (status === 'ON_AIR') {
                autoNextScheduled = false;
                return;
            }
            if (!status || status === 'ERROR') return;
            if (autoNextScheduled) return;

            await updateSidebar();
            const firstLink = document.querySelector('#liveProgramContainer .program_container .program_thumbnail a');
            if (firstLink && firstLink.href && location.href !== firstLink.href) {
                autoNextScheduled = true;
                // プレビュー情報抽出
                let preview = null;
                try {
                    const card = firstLink.closest('.program_container');
                    const imgEl = card ? card.querySelector('.program_thumbnail_img') : null;
                    const titleEl = card ? card.querySelector('.program_title') : null;
                    const providerEl = card ? card.querySelector('.community_name') : null;
                    preview = {
                        href: firstLink.href,
                        thumb: imgEl && imgEl.src ? imgEl.src : '',
                        title: titleEl && titleEl.textContent ? titleEl.textContent.trim() : '',
                        provider: providerEl && providerEl.textContent ? providerEl.textContent.trim() : '',
                    };
                } catch (_e) {}
                scheduleAutoNextNavigation(firstLink.href, preview);
            }
        } catch (_e) {}
    }, liveStatusPollInterval * 1000);
}

function stopLiveStatusWatcher() {
    if (liveStatusTimer) {
        clearInterval(liveStatusTimer);
        liveStatusTimer = null;
    }
    if (autoNextCountdownTimer) {
        clearInterval(autoNextCountdownTimer);
        autoNextCountdownTimer = null;
    }
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
        isOpenSidebar = changes.isOpenSidebar.newValue;
        // 開閉に応じて停止/再開・即時更新
        handleSidebarOpenStateChange(isOpenSidebar);
    }
    if (changes.sidebarWidth) {
        options.sidebarWidth = changes.sidebarWidth.newValue;
        sidebarWidth = changes.sidebarWidth.newValue;
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
    if (sidebarUpdateTimer) {
        clearTimeout(sidebarUpdateTimer);
        sidebarUpdateTimer = null;
    }
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

async function getLivePrograms(rows = 100) {
    const result = await fetchLivePrograms(rows);
    if (elems.apiErrorElement) {
        elems.apiErrorElement.style.display = result ? 'none' : 'block';
    }
    return result;
}

async function getProgramInfo_and_saveLocalStorage(liveId) {
    try {
        const data = await fetchProgramInfo(liveId);
        if (!data) return;
        if (data.providerType === 'user' && !data.liveScreenshotThumbnailUrls) return;
        upsertProgramInfoFromStorage(data);
        updateThumbnail();
    } catch (_e) {
        // no-op
    }
}

async function updateSidebar() {

    isInserting = true;

    // localStorageから番組情報を取得
    const programInfos = getProgramInfosFromStorage();

    const livePrograms = await getLivePrograms(100);
    if (!livePrograms) return;

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
            const html = data ? makeProgramsHtml(data, loadingImageURL) : makeProgramsHtml(program, loadingImageURL);
            const temp = document.createElement('div');
            temp.innerHTML = html;
            if (temp.firstElementChild) frag.appendChild(temp.firstElementChild);
        }

        if (!toDolists.includes(program.id)) {
            toDolists.push(program.id);
            if (toDolists.length > maxSaveProgramInfos) {
                toDolists.shift();
            }
        }
    });

    // 一旦すべての番組を取り除く
    const liveProgramContainer = document.getElementById('liveProgramContainer');
    if (!liveProgramContainer) {
        // console.error('liveProgramContainer not found');
        isInserting = false;
        return;
    }
    
    // 挿入（置き換え）
    liveProgramContainer.replaceChildren(frag);
    // 監視対象を更新
    refreshThumbnailObservations();

    // ソート
    if (options.programsSort === 'active') {
        const container = document.getElementById('liveProgramContainer');
        if (container) sortProgramsByActivePoint(container);
    }

    setProgramContainerWidth(elems, elems.sidebar ? elems.sidebar.offsetWidth : sidebarWidth);
    isInserting = false;

    // 番組数更新
    const programCountElement = document.getElementById('program_count');
    if (programCountElement) {
        programCountElement.textContent = livePrograms.length ? livePrograms.length : 0;
    }

    attachThumbnailErrorHandlers();
}

function updateThumbnail() {
    if (isInserting) return;

    const programInfos = getProgramInfosFromStorage();
    if (!programInfos) return;
    updateThumbnailsFromStorage(programInfos);
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
        if (event.target.name === 'programsSort') updateSidebar();
        saveOptions();
    });
};
