const notifyboxAPI = 'https://papi.live.nicovideo.jp/api/relive/notifybox.content.php';
//const notifyboxAPI = 'https://sp.live.nicovideo.jp/api/relive/notifybox.content.php';
const liveInfoAPI = 'https://api.cas.nicovideo.jp/v1/services/live/programs';

const toDolists = [];
const sidebarMinWidth = 180;
const maxSaveProgramInfos = 200;
const updateThumbnailInterval = 20; // 秒
const toDolistsInterval = 0.3; // 秒

let programContainerWidth = '100%';
let scrollbarWidth = 0;
let windowWidth = 0;
let windowHeight = 0;
let sidebarWidth = sidebarMinWidth;
let sidebarWidth_cache = 0;
let isOpenSidebar = false;
let isInserting = false;
let oneTimeFlag = true;

let defaultOptions = {
    programsSort: 'newest',
    autoOpen: '3',
    updateProgramsInterval: '120', // 秒
    sidebarWidth: 360,
    isOpenSidebar: isOpenSidebar,
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
    elems.playerScreenSizeSelectMenu = document.querySelector('[class*="_player-screen-size-select-menu_"]');
};

const url = new URL(window.location.href);
const params = url.searchParams;

const loadingImageURL = chrome.runtime.getURL('images/loading.gif');
const reloadImageURL = chrome.runtime.getURL('images/reload.png');
const optionsImageURL = chrome.runtime.getURL('images/options.png');

window.addEventListener('load', async function () {
    
    // 別窓くんポップアップ時は終了
    if (params.get('popup') === 'on') return;

    // オプションを取得
    options = await getOptions();
    sidebarWidth = options.sidebarWidth;

    // 各要素を定義
    setElems();
    if (!elems.root) return; // root要素が存在しない場合は終了

    // ウィンドウサイズを取得
    getWindowSize();

    // サイドバーを挿入
    await insertSidebar();

    // Watchページの幅を設定
    adjust_WatchPage_child();

    // ウィンドウサイズの変更時
    window.addEventListener('resize', function () {
        getWindowSize();
        adjust_WatchPage_child();
        // adjustHtmlWidth();
    });

    // watchPageサイズ変更時（幅のみ監視）
    let watchPageWidth = elems.watchPage.clientWidth;
    const resizeObserver_watchPage = new ResizeObserver((entries) => {
        entries.forEach(function (entry) {
            if (entry.contentRect.width !== watchPageWidth) {
                adjust_WatchPage_child();
                watchPageWidth = entry.contentRect.width;
            }
        });
    });
    resizeObserver_watchPage.observe(elems.watchPage);

    // サイドバーのサイズ変更時
    const resizeObserver_sidebar = new ResizeObserver((e) => {
        set_program_container_width();
        // adjustHtmlWidth();

        // ウィンドウリサイズイベントを発行（シークポジションのズレ対策）
        window.dispatchEvent(new Event('resize'));
    });
    resizeObserver_sidebar.observe(elems.sidebar);

    // コメント欄　スクロールボタンを押す
    setTimeout(() => {
        const indicator = elems.playerSection.querySelector('[class*="_indicator_"]');
        if (indicator) indicator.click();
    }, 1000);

    // シアターモード切り替え時に実行
    for (let i = 0; i < elems.theaterButtons.length; i++) {
        elems.theaterButtons[i].addEventListener('click', function () {
            adjust_WatchPage_child();
        });
    }

    // 再読み込みボタン
    reload_programs.addEventListener('click', function () {
        updateSidebar();
    });

    // オプションボタン
    setting_options.addEventListener('click', () => {
        const currentHeight = getComputedStyle(optionContainer).height;
        if (currentHeight === '0px') {
            optionContainer.style.height = 'auto';
        } else {
            optionContainer.style.height = '0';
        }
    });
    
    // 画面サイズ（固定・自動）切替時（変更時サイズが変更されないため強制する）
    document.addEventListener('click', function () {
        window.dispatchEvent(new Event('resize'));
    });

    // サイドバーOPEN/CLOSEボタン
    sidebar_button.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();

        toggleSidebar();
    });

    // サイドバー境界線ドラッグ可能にする
    enableSidebarLine();

    // サイドバー　オートオープン
    if (options.autoOpen == '1' || (options.autoOpen == '3' && options.isOpenSidebar)) {
        sidebar_button.click();
    }



    // 番組リストを取得
    await updateSidebar();

    // サムネイル定期更新を開始
    function runUpdateThumbnail() {
        updateThumbnail();
        setTimeout(runUpdateThumbnail, updateThumbnailInterval * 1000);
    }
    setTimeout(runUpdateThumbnail, updateThumbnailInterval * 1000);

    // todoリストを実行
    setInterval(function () {
        if (toDolists.length === 0) {
            if (oneTimeFlag) {
                updateSidebar();
                oneTimeFlag = false;
            }
        } else {
            getProgramInfo_and_saveLocalStorage(toDolists.shift());
        }
        
    }, toDolistsInterval * 1000);

    // 番組リストを取得（定期実行）
    function updateSidebarInterval() {
        updateSidebar();
        setTimeout(updateSidebarInterval, Number(options.updateProgramsInterval) * 1000);
    }
    updateSidebarInterval();


    // レイアウト崩れ対策用
    const feedbackAnchor = document.querySelector('[class*="_feedback-anchor_"]');
    if (feedbackAnchor) {
        feedbackAnchor.style.right = 0;
    }
});

// データが変更されたときのイベントリスナー
chrome.storage.onChanged.addListener(function (changes) {
    if (changes.autoOpen) options.autoOpen = changes.autoOpen.newValue;
    if (changes.updateProgramsInterval) options.updateProgramsInterval = changes.updateProgramsInterval.newValue;
    if (changes.programsSort) options.programsSort = changes.programsSort.newValue;
});

// サムネ取得エラー時
function onThumbnailError() {
    document.querySelectorAll('.program_thumbnail_img').forEach(function (element) {
        element.addEventListener('error', function () {
            const dataSrc = this.getAttribute("data-src");
            if (dataSrc && this.src !== dataSrc) {
                this.src = dataSrc;
            } else {
                this.src = loadingImageURL;
            }
        });
    });
}

// ウィンドウサイズを取得
const getWindowSize = () => {
    scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    windowWidth = window.innerWidth;
    windowHeight = window.innerHeight;
};

// オプションを取得
const getOptions = async () => {
    const options = await new Promise((resolve, reject) => {
        chrome.storage.local.get((result) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(result);
            }
        });
    });

    // デフォルトオプションを補完
    if (options.autoOpen === undefined) options.autoOpen = defaultOptions.autoOpen;
    if (options.programsSort === undefined) options.programsSort = defaultOptions.programsSort;
    if (options.updateProgramsInterval === undefined) options.updateProgramsInterval = defaultOptions.updateProgramsInterval;
    if (options.sidebarWidth === undefined) options.sidebarWidth = defaultOptions.sidebarWidth;
    if (options.isOpenSidebar === undefined) options.isOpenSidebar = defaultOptions.isOpenSidebar;

    // 補完後のオプションを保存
    await new Promise((resolve, reject) => {
        chrome.storage.local.set(options, () => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve();
            }
        });
    });

    return options;
};

// サイドバー要素を挿入
const insertSidebar = () => {
    const sidebarHtml = `<div id="sidebar" class="sidebar_transition">
                            <div id="sidebar_container">
                                <div class="sidebar_header">
                                    <div class="sidebar_header_item">
                                        <a href="https://live.nicovideo.jp/follow" title="フォロー中の番組ページへ">
                                            フォロー中の番組
                                            <div id="program_count"></div>
                                        </a>
                                    </div>
                                    <div class="sidebar_header_item">
                                        <div class="sidebar_header_item_col" id="reload_programs" title="更新">
                                            <img src='${reloadImageURL}' alt="更新">
                                        </div>
                                        <div class="sidebar_header_item_col" id="setting_options" title="オプション">
                                            <img src='${optionsImageURL}' alt="オプション">
                                        </div>
                                    </div>
                                </div>
                                <div class="sidebar_body">
                                    <div id="api_error">
                                        <a href="https://account.nicovideo.jp/login">ログイン</a>
                                    </div>
                                    <div id="optionContainer">
                                    </div>
                                    <div id="liveProgramContainer">
                                    </div>
                                </div>
                            </div>
                        </div>`;
    
    const sidebar_line_html = `<div id="sidebar_line"><div id="sidebar_button"><div id="sidebar_arrow"></div></div></div>`;

    const optionHtml = `<div class="container">
                            <h1>オプション</h1>
                            <form id="optionForm">
                                <h2>表示順序</h2>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="programsSort1" name="programsSort" value="newest">
                                        <label for="programsSort1">新着順</label>
                                    </div>
                                </div>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="programsSort2" name="programsSort" value="active" checked>
                                        <label for="programsSort2">人気順</label>
                                    </div>
                                </div>
                                <h2>自動更新</h2>
                                <p>
                                    番組リストを指定秒数で自動更新します。（サイドバー内の更新ボタンで手動で更新することもできます）<br>
                                    サムネイル画像はこの設定とは関係なく自動更新されます。（20~60秒）
                                </p>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="updateProgramsInterval1" name="updateProgramsInterval" value="60">
                                        <label for="updateProgramsInterval1">60秒</label>
                                    </div>
                                </div>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="updateProgramsInterval2" name="updateProgramsInterval" value="120" checked>
                                        <label for="updateProgramsInterval2">120秒</label>
                                    </div>
                                </div>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="updateProgramsInterval3" name="updateProgramsInterval" value="180">
                                        <label for="updateProgramsInterval3">180秒</label>
                                    </div>
                                </div>
                                <h2>オートオープン</h2>
                                <p>
                                    サイドバーを自動で開くかどうかを設定します。
                                </p>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="autoOpen1" name="autoOpen" value="1">
                                        <label for="autoOpen1">ON</label>
                                    </div>
                                </div>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="autoOpen2" name="autoOpen" value="2">
                                        <label for="autoOpen2">OFF</label>
                                    </div>
                                </div>
                                <div class="setbox flex">
                                    <div class="inputbox flex">
                                        <input type="radio" id="autoOpen3" name="autoOpen" value="3" checked>
                                        <label for="autoOpen3">ページを閉じる前の状態を記憶</label>
                                    </div>
                                </div>
                            </form>
                        </div>`;
    
    document.body.insertAdjacentHTML('afterbegin', sidebarHtml + sidebar_line_html);

    optionContainer.insertAdjacentHTML('beforeend', optionHtml);
    reflectOptions();

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

const adjust_WatchPage_child = () => {

    let maxWidth = 1024 + 'px';
    let minWidth = 1024 + 'px';
    let width = 1024 + 'px';
    let watchPage_child = [
        elems.playerSection,
        elems.programInformationBodyArea,
        elems.siteFooterUtility,
        elems.gaNsProgramSummary,
        elems.enquetePlaceholder
    ]

    const watchPageWidth = elems.watchPage.clientWidth;

    if (isScreenSizeAuto()) {

        if (watchPageWidth > (1152) && watchPageWidth < (1500)) {
            maxWidth = (watchPageWidth - 128) + 'px';
            minWidth = 1024 + 'px';
            width = ((windowHeight * 1.777778) - 3.55556) + 'px';
        }
        if (watchPageWidth > (1500) && watchPageWidth < (1792)) {
            maxWidth = (watchPageWidth - 128) + 'px';
            minWidth = 1024 + 'px';
            width = ((windowHeight * 1.777778) - 220.44444) + 'px';
        }
        if (watchPageWidth > (1792)) {
            maxWidth = 1664 + 'px';
            minWidth = 1024 + 'px';
            width = ((windowHeight * 1.777778) - 220.44444) + 'px';
        }
    }

    if (isFullScreen()) {
        maxWidth = '100%';
        minWidth = '100%';
        width = '100%';
    }

    // プレイヤー幅など設定
    watchPage_child.forEach((elem) => {
        elem.style.maxWidth = maxWidth;
        elem.style.minWidth = minWidth;
        elem.style.width = width;
    });

    // シアターモード時
    if (elems.watchPage.hasAttribute('data-player-layout-mode') && isScreenSizeAuto()) {
        elems.playerSection.style.maxWidth = 'none';
        elems.playerSection.style.width = 'auto';
        elems.leoPlayer.style.height = ((elems.root.clientWidth * 0.5625) - 164) + 'px';
    } else {
        elems.leoPlayer.style.height = 'auto';
    }

    // 他ツール対策
    const playerDisplay = document.querySelector('[class*="_player-display_"]');
    if (playerDisplay) {
        playerDisplay.removeAttribute('style');
    }
};

// サイドバーOPEN/CLOSE
const toggleSidebar = () => {

    isOpenSidebar = !isOpenSidebar;

    if (isOpenSidebar) {
        openSidebar();
    } else {
        closeSidebar();
    }

    // サイドバー開閉を記憶
    chrome.storage.local.set({ 'isOpenSidebar': isOpenSidebar });
};

// サイドバーOPEN
const openSidebar = () => {
    if (sidebarWidth < sidebarMinWidth) sidebarWidth = sidebarMinWidth;
    elems.sidebar.style.width = sidebarWidth + 'px';
    elems.sidebar.style.maxWidth = sidebarWidth + 'px';
    elems.sidebar.style.minWidth = sidebarWidth + 'px';
    elems.sidebar_container.style.width = sidebarWidth + 'px';

    sidebar_arrow.classList.add('sidebar_arrow_re');
    elems.sidebar_line.classList.add('col_resize');
};
// サイドバーCLOSE
const closeSidebar = () => {
    elems.sidebar.style.width = 0 + 'px';
    elems.sidebar.style.maxWidth = 0 + 'px';
    elems.sidebar.style.minWidth = 0 + 'px';

    sidebar_arrow.classList.remove('sidebar_arrow_re');
    elems.sidebar_line.classList.remove('col_resize');
};

// サイドバー境界線　ドラッグ変更
const enableSidebarLine = () => {

    let startX, startWidth;

    elems.sidebar_line.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();

        if (!isOpenSidebar) return;
        if (e.target.id === 'sidebar_button' || e.target.id === 'sidebar_arrow') return;

        elems.sidebar.classList.remove('sidebar_transition');

        startX = e.clientX;
        startWidth = parseInt(document.defaultView.getComputedStyle(elems.sidebar).width, 10);
        document.documentElement.addEventListener('mousemove', onMouseMove);
        document.documentElement.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(e) {
        
        let width = startWidth + (e.clientX - startX);
        if (width < sidebarMinWidth) {
            width = sidebarMinWidth;
        }

        elems.sidebar.style.width = width + 'px';
        elems.sidebar.style.maxWidth = width + 'px';
        elems.sidebar.style.minWidth = width + 'px';
        elems.sidebar_container.style.width = width + 'px';
        sidebarWidth = width;
    }

    function onMouseUp(e) {
        elems.sidebar.classList.add('sidebar_transition');
        document.documentElement.removeEventListener('mousemove', onMouseMove);
        document.documentElement.removeEventListener('mouseup', onMouseUp);
        chrome.storage.local.set({ 'sidebarWidth': sidebarWidth });
    }
};

// プレーヤーサイズが固定かどうか
function isScreenSizeAuto() {
    const value = localStorage.getItem('LeoPlayer_ScreenSizeStore_kind');
    if (!value) return true;
    return value.includes('auto');
}

// フルスクリーンがONかどうか
function isFullScreen() {
    const htmlTag = document.getElementsByTagName('html')[0];
    return htmlTag.hasAttribute('data-browser-fullscreen');
}

function set_program_container_width() {

    if (sidebarWidth < 300) programContainerWidth = 100 + '%';
    if (sidebarWidth > 300) programContainerWidth = 100 / 2 + '%';
    if (sidebarWidth > 500) programContainerWidth = 100 / 3 + '%';
    if (sidebarWidth > 700) programContainerWidth = 100 / 4 + '%';
    if (sidebarWidth > 900) programContainerWidth = 100 / 5 + '%';
    if (sidebarWidth > 1100) programContainerWidth = 100 / 6 + '%';
    if (sidebarWidth > 1300) programContainerWidth = 100 / 7 + '%';
    if (sidebarWidth > 1500) programContainerWidth = 100 / 8 + '%';

    document.querySelectorAll('.program_container').forEach(element => {
        element.style.width = programContainerWidth;

        const program_thumbnail = element.querySelector('.program_thumbnail');
        program_thumbnail.style.width = programContainerWidth + 'px';
    });
} 

async function getLivePrograms(rows = 100) {
    try {
        let response = await fetch(`${notifyboxAPI}?rows=${rows}`, { credentials: 'include' });
        response = await response.json();

        if (response.meta?.status !== 200 || !response.data) throw new Error('APIエラー');
        if (!response.data.notifybox_content) throw new Error('APIエラー');

        elems.apiErrorElement.style.display = 'none';

        return response.data.notifybox_content;

    } catch (error) {
        console.log(error);
        elems.apiErrorElement.style.display = 'block';
        return false;
    }
}

async function getProgramInfo_and_saveLocalStorage(liveId) {
    try {
        let response = await fetch(`${liveInfoAPI}/lv${liveId}`);
        response = await response.json();
        if (response.meta?.status !== 200 || !response.data) return;

        // サムネがセットされていない場合はスルー
        if (response.data.providerType === 'user' &&
            !response.data.liveScreenshotThumbnailUrls) return;

        // localStorageからサムネ情報を取得
        let programInfos = JSON.parse(localStorage.getItem('programInfos')) || [];

        // 既存のデータに同じ id がある場合は入れ替え
        const existingIndex = programInfos.findIndex((info) => info.id === `lv${liveId}`);
        if (existingIndex !== -1) {
            programInfos[existingIndex] = response.data; // 上書き
        } else {
            programInfos.push(response.data); // 新規追加
        }

        // localStorageに保存されたprogramInfosがmaxSaveProgramInfosを超えたら削除
        while (programInfos.length > maxSaveProgramInfos) {
            programInfos.shift();
        }

        // localStorageに保存
        localStorage.setItem('programInfos', JSON.stringify(programInfos));

        updateThumbnail();

    } catch (error) {
        console.log(error);
    }
}

async function updateSidebar() {

    isInserting = true;

    // localStorageから番組情報を取得
    const programInfos = JSON.parse(localStorage.getItem('programInfos'));

    const livePrograms = await getLivePrograms(100);
    if (!livePrograms) return;

    let html = '';
    livePrograms.forEach(function (program) {
        const data = programInfos.find((info) => info.id === `lv${program.id}`);

        // HTML作成
        if (data) {
            html += makeProgramsHtml(data);
        } else {
            html += makeProgramsHtml(program);
        }

        // todoリストを更新
        if (!toDolists.includes(program.id)) toDolists.push(program.id);
    });

    // 一旦すべての番組を取り除く
    const liveProgramContainer = document.getElementById('liveProgramContainer');
    liveProgramContainer.innerText = '';

    // 挿入
    liveProgramContainer.insertAdjacentHTML('beforeend', html);

    // ソート
    if (options.programsSort === 'active') sortProgramsByActivePoint();

    set_program_container_width();
    isInserting = false;

    // 番組数更新
    program_count.textContent = livePrograms.length ? livePrograms.length : 0;

    onThumbnailError();
}

function makeProgramsHtml(data) {

    const id = data.id.replace('lv', '');
    let user_page_url = '';
    let community_name = '';
    let thumbnail_link_url = '';
    let thumbnail_url = '';
    let icon_url = '';
    let live_thumbnail_url = '';
    
    if (data.id.includes('lv')) {
        user_page_url = `https://www.nicovideo.jp/user/${data.contentOwner.id}`;
        community_name = data.contentOwner.name;
        thumbnail_link_url = `https://live.nicovideo.jp/watch/${data.id}`;
        thumbnail_url = data.thumbnailUrl;
        icon_url = data.contentOwner.icon;

        if (data.providerType === 'user') {
            live_thumbnail_url = data.thumbnailUrl;
            if (data.liveScreenshotThumbnailUrls) {
                live_thumbnail_url = `${data.liveScreenshotThumbnailUrls.middle}?cache=${Date.now()}`;
            }
        }
        if (data.providerType === 'channel') {
            user_page_url = `https://ch.nicovideo.jp/${data.contentOwner.id}`;
            live_thumbnail_url = data.thumbnailUrl;
            if (data.large1280x720ThumbnailUrl) live_thumbnail_url = data.large1280x720ThumbnailUrl;
        }
    } else {
        community_name = data.community_name;
        thumbnail_link_url = data.thumbnail_link_url;
        thumbnail_url = data.thumbnail_url;
        icon_url = data.thumbnail_url;
        live_thumbnail_url = data.thumbnail_url;

        // ユーザーページのURLを取得
        const match = thumbnail_url.match(/\/(\d+)\.jpg/i);
        if (match) user_page_url = `https://www.nicovideo.jp/user/${match[1]}`;
    }

    let userIconHtml = ``;
    if (user_page_url) {
        userIconHtml = `<a href="${user_page_url}" target="_blank"><img src="${icon_url}"></a>`;
    } else {
        userIconHtml = `<img src="${icon_url}">`;
    }

    // アクティブポイントを算出
    const activePoint = calculateActivePoint(data);

    return `<div id="${id}" class="program_container" active-point="${activePoint}">
                <div class="community">
                    ${userIconHtml}
                    <div class="community_name" title="${escapeHtml(community_name)}">
                        ${escapeHtml(community_name)}
                    </div>
                </div>
                <div class="program_thumbnail program-card_">
                    <a href="${thumbnail_link_url}">
                        <img class="program_thumbnail_img" src="${live_thumbnail_url}" data-src="${thumbnail_url}">
                    </a>
                </div>
                <div class="program_title" title="${escapeHtml(data.title)}">
                    ${escapeHtml(data.title)}
                </div>
            </div>`;
}

function updateThumbnail() {
    if (isInserting) return;

    // localStorageから番組情報を取得
    const programInfos = JSON.parse(localStorage.getItem('programInfos'));
    if (!programInfos) return;

    document.querySelectorAll('.program_thumbnail').forEach((el) => {

        const thumbnail = el.querySelector('img');
        const thumbnail_url = thumbnail.getAttribute('src');

        if (thumbnail_url.includes('?cache=')) {
            thumbnail.src = `${thumbnail_url.match(/^.+?\?cache=/)[0]}${Date.now()}`;
        } else {
            // 番組情報を取得
            const programInfo = programInfos.find(info => info.id === `lv${el.parentElement.id}`);
            if (!programInfo) return;
            
            // コミュ限はスルー
            if (programInfo.isMemberOnly) return;

            if (programInfo.providerType === 'user') {
                if (programInfo.liveScreenshotThumbnailUrls &&
                    programInfo.liveScreenshotThumbnailUrls.middle
                ) {
                    thumbnail.src = `${programInfo.liveScreenshotThumbnailUrls.middle}?cache=${Date.now()}`;
                }
            }
            if (programInfo.providerType === 'channel') {
                thumbnail.src = programInfo.thumbnailUrl;
                if (programInfo.large1280x720ThumbnailUrl) {
                    thumbnail.src = programInfo.large1280x720ThumbnailUrl;
                }
            }
        }
    });
}

/**
 * オプション内容を反映
 */
const reflectOptions = () => {
    const updateCheckedState = (name, value) => {
        document.getElementsByName(name).forEach(item => {
            item.checked = item.value === value;
        });
    };

    const saveOptions = () => {
        options.autoOpen = document.querySelector('input[name="autoOpen"]:checked').value;
        options.updateProgramsInterval = document.querySelector('input[name="updateProgramsInterval"]:checked').value;
        options.programsSort = document.querySelector('input[name="programsSort"]:checked').value;

        chrome.storage.local.set(options);
    };

    // 各設定を反映
    updateCheckedState('programsSort', options.programsSort);
    updateCheckedState('updateProgramsInterval', options.updateProgramsInterval);
    updateCheckedState('autoOpen', options.autoOpen);

    // フォームに変更があったら保存する
    document.getElementById('optionForm').addEventListener('change', (event) => {
        if (event.target.name === 'programsSort') updateSidebar();
        saveOptions();
    });
};

function sortProgramsByActivePoint() {

    const container = document.getElementById('liveProgramContainer')
    const programs = Array.from(container.getElementsByClassName('program_container'))

    // active-pointに基づいてソート
    programs.sort((a, b) => {
        const activeA = parseFloat(a.getAttribute('active-point'), 10)
        const activeB = parseFloat(b.getAttribute('active-point'), 10)
        return activeB - activeA // 降順
    })

    // ソート後の要素をコンテナに再追加
    programs.forEach(program => container.appendChild(program))
}

function calculateActivePoint(data) {

    const comments = (data.comments || 0) + 1;
    const viewers = (data.viewers || 0) + 1;
    const elapsedTimeAdjustment = 1; // 調整係数

    function calculateElapsedTime(data) {
        if (!data?.onAirTime?.beginAt) return 1;

        const startTime = new Date(data.onAirTime.beginAt)
        const now = new Date()
        const elapsedMinutes = Math.floor((now - startTime) / (1000 * 60))

        return elapsedMinutes
    }

    const elapsedTime = calculateElapsedTime(data) || 1;
    const activePoint = (viewers + comments) / Math.pow(elapsedTime, elapsedTimeAdjustment);

    return activePoint;
}

// HTMLエスケープ
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, function (m) { return map[m]; });
}