const notifyboxAPI = 'https://papi.live.nicovideo.jp/api/relive/notifybox.content.php';
//const notifyboxAPI = 'https://sp.live.nicovideo.jp/api/relive/notifybox.content.php';
const liveInfoAPI = 'https://api.cas.nicovideo.jp/v1/services/live/programs';

const getProgramsInterval = 60; // 秒
const maxSaveProgramInfos = 100;
const getProgramInfoInterval = 0.3; // 秒
const updateThumbnailInterval = 20; // 秒
const toDolists = [];

const rootMinWidth = (1024 + 128 + 4);
const sidebarMinWidth = 180;
let sidebarWidth = sidebarMinWidth;
let _updateThumbnailInterval = getProgramInfoInterval;
let programContainerWidth = '100%';
let scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
let windowWidth = window.innerWidth - scrollbarWidth;
let windowHeight = window.innerHeight;

let isAutoOpen = false;
let isSaveSidebarSize = false;
let isSidebar = false;
let isInserting = false;

let options = {};
let elems = {};

// 初期化（開発用）
// localStorage.setItem('programInfos', JSON.stringify([]));

// 各要素を定義
const setElems = () => {
    elems.root = document.getElementById('root');
    elems.watchPage = document.querySelector('[class*="_watch-page_"]');
    elems.playerSection = document.querySelector('[class*="_player-section_"]');
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

window.addEventListener('load', async function () {

    // 別窓くんポップアップ時は終了
    if (params.get('popup') === 'on') return;

    // オプションを取得
    options = await getOptions();

    // 各要素を定義
    setElems();

    if (!elems.root) return; // root要素が存在しない場合は終了

    // サイドバーを挿入
    insrertSidebarHTML();

    // Watchページの幅を設定
    setWatchPageWidth();

    // ウィンドウサイズの変更に伴ってページのスタイルを設定
    window.addEventListener('resize', function () {
        scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
        windowWidth = window.innerWidth - scrollbarWidth;
        windowHeight = window.innerHeight;

        setRootWidth();
        setWatchPageWidth();
    });

    // フルスクリーンモード切り替え時に実行
    for (let i = 0; i < elems.fullscreenButtons.length; i++) {
        elems.fullscreenButtons[i].addEventListener('click', function () {
            if (isSidebar) sidebar_button.click();
            setWatchPageWidth();
        });
    }

    // シアターモード切り替え時に実行
    for (let i = 0; i < elems.theaterButtons.length; i++) {
        elems.theaterButtons[i].addEventListener('click', function () {
            setWatchPageWidth();
        });
    }

    // フルスクリーン固定、自動切り替え時に実行するために画面クリックで発火
    document.addEventListener('click', function (e) {
        setWatchPageWidth();
    }, false);

    // 再読み込みボタン
    reload_programs.addEventListener('click', function () {
        getPrograms(100);
    });

    // サイドバーOPEN/CLOSEボタン
    sidebar_button.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();

        toggleSidebar();
        setWatchPageWidth();
    });

    // サイドバー境界線ドラッグ可能にする
    changeSidebarLine();

    // サイドバー　オートオープン
    if (isAutoOpen && Number(options.isSidebar)) {
        setTimeout(() => {
            sidebar_button.click();
        }, 2000);
    }




    // 番組リストを取得
    getPrograms(100);

    // 番組リストを定期取得
    setInterval(function () {
        getPrograms(100);
    }, getProgramsInterval * 1000);

    // 番組情報を取得
    setInterval(function () {
        if (toDolists.length === 0) return;

        setProgramInfo(toDolists.shift());

        if (toDolists.length === 0) {
            _updateThumbnailInterval = updateThumbnailInterval;
        } else {
            _updateThumbnailInterval = getProgramInfoInterval;
        }

    }, getProgramInfoInterval * 1000);

    // サムネイルを更新
    function runUpdateThumbnail() {
        updateThumbnail();
        setTimeout(runUpdateThumbnail, _updateThumbnailInterval * 1000);
    }
    setTimeout(runUpdateThumbnail, _updateThumbnailInterval * 1000);


    // // タブがアクティブになったら幅をセット
    // function handleVisibilityChange() {
    //     if (document.visibilityState === 'visible') {
    //         setWatchPageWidth();
    //     }
    // }

    // // タブのアクティブを監視
    // document.addEventListener('visibilitychange', handleVisibilityChange);

});

// オプションを取得
const getOptions = async () => {

    const _options = await chrome.storage.local.get();

    if (_options &&
        _options.isAutoOpen !== undefined &&
        _options.isSaveSidebarSize !== undefined
    ) {
        isAutoOpen = Number(_options.isAutoOpen);
        if (isAutoOpen === 2) {
            isAutoOpen = _options.isSidebar ? Number(_options.isSidebar) : Number(_options.isAutoOpen);
        }

        isSaveSidebarSize = Number(_options.isSaveSidebarSize);
        if (isSaveSidebarSize) {
            sidebarWidth = (_options.sidebarWidth !== undefined) ? _options.sidebarWidth : sidebarMinWidth;
        }
    }
    return _options;
};

// サイドバー要素を挿入
const insrertSidebarHTML = async () => {

    const sidebarHtml = `<div id="sidebar" class="sidebar_transition">
                            <div id="sidebar_container">
                                <div class="program_info">
                                    フォロー中の番組
                                    <div id="program_count"></div>
                                    <div id="reload_programs">
                                        <img src='${chrome.runtime.getURL('images/reload.png')}'>
                                    </div>
                                </div>
                                <div id="api_error">
                                    <a href="https://account.nicovideo.jp/login">ログイン</a>
                                </div>
                                <div id="liveProgramContainer">
                                </div>
                            </div>
                        </div>`;
    const sidebar_line_html = `<div id="sidebar_line"><div id="sidebar_button"><div id="sidebar_arrow"></div></div></div>`;
    
    document.body.insertAdjacentHTML('afterbegin', sidebarHtml + sidebar_line_html);

    // 各要素を定義
    elems.sidebar = document.getElementById('sidebar');
    elems.sidebar_line = document.getElementById('sidebar_line');
    elems.sidebar_container = document.getElementById('sidebar_container');

    // body要素にスタイルを設定
    document.body.style.position = 'relative';
    document.body.style.display = 'flex';

    // #root要素にスタイルを設定
    elems.root.style.flexGrow = '1';

};

const setWatchPageWidth = () => {

    setTimeout(() => {

        let maxWidth = 1024 + 'px';
        let minWidth = 1024 + 'px';
        let width = 1024 + 'px';
        let targetElems = [
            elems.playerSection,
            elems.programInformationBodyArea,
            elems.siteFooterUtility,
            elems.gaNsProgramSummary,
            elems.enquetePlaceholder
        ]

        if (isScreenSizeAuto()) {

            if (elems.root.clientWidth > (1152) && elems.root.clientWidth < (1500)) {
                maxWidth = (elems.root.clientWidth - 128) + 'px';
                minWidth = 1024 + 'px';
                width = ((windowHeight * 1.777778) - 3.55556) + 'px';
            }
            if (elems.root.clientWidth > (1500) && elems.root.clientWidth < (1792)) {
                maxWidth = (elems.root.clientWidth - 128) + 'px';
                minWidth = 1024 + 'px';
                width = ((windowHeight * 1.777778) - 220.44444) + 'px';
            }
            if (elems.root.clientWidth > (1792)) {
                maxWidth = 1664 + 'px';
                minWidth = 1024 + 'px';
                width = ((windowHeight * 1.777778) - 220.44444) + 'px';
            }
        }

        if (isFullScreenAttr()) {
            elems.root.style.maxWidth = '100%';
            maxWidth = '100%';
            minWidth = '100%';
            width = '100%';
        }

        // プレイヤー幅など設定
        targetElems.forEach((elem) => {
            elem.style.maxWidth = maxWidth;
            elem.style.minWidth = minWidth;
            elem.style.width = width;
        });

        // ニコ生画面　全体幅を設定
        setRootWidth();

        // メールアイコン
        if (elems.root.clientWidth > (1792)) {
            elems.feedbackAnchor.style.right = ((elems.root.clientWidth * 0.5) - 832) + 'px';
        } else {
            elems.feedbackAnchor.style.right = 64 + 'px';
        }

        // シアターモード時
        if (elems.watchPage.hasAttribute('data-player-layout-mode') && isScreenSizeAuto()) {
            elems.playerSection.style.maxWidth = 'none';
            elems.playerSection.style.width = 'auto';
        }

        try {
            // サイドバーサイズを記憶する場合
            if (isSaveSidebarSize) {
                chrome.storage.local.set({ 'sidebarWidth': sidebarWidth });
            } else {
                chrome.storage.local.set({ 'sidebarWidth': sidebarMinWidth });
            }
        } catch (error) {

        }

    }, 500);
};

// ニコ生画面　全体幅を設定
const setRootWidth = () => {
    const rootWidth = windowWidth - (elems.sidebar.clientWidth + elems.sidebar_line.clientWidth);
    elems.root.style.maxWidth = rootWidth + 'px';
    elems.root.style.minWidth = rootWidth + 'px';
    elems.root.style.width = rootWidth + 'px';
};

// サイドバーOPEN/CLOSE
const toggleSidebar = () => {

    isSidebar = !isSidebar;

    if (isSidebar) {

        if (sidebarWidth < sidebarMinWidth) sidebarWidth = sidebarMinWidth;
        elems.sidebar.style.width = sidebarWidth + 'px';
        elems.sidebar.style.minWidth = sidebarWidth + 'px';
        elems.sidebar_container.style.width = sidebarWidth + 'px';

        elems.root.style.maxWidth = windowWidth - (sidebarWidth + elems.sidebar_line.clientWidth) + 'px';
        elems.root.style.minWidth = windowWidth - (sidebarWidth + elems.sidebar_line.clientWidth) + 'px';
        elems.root.style.width = windowWidth - (sidebarWidth + elems.sidebar_line.clientWidth) + 'px';

        sidebar_arrow.classList.add('sidebar_arrow_re');

    } else {
        elems.sidebar.style.width = 0;
        elems.sidebar.style.minWidth = 0;
        elems.root.style.maxWidth = windowWidth + 'px';
        elems.root.style.minWidth = windowWidth + 'px';
        elems.root.style.width = windowWidth + 'px';

        sidebar_arrow.classList.remove('sidebar_arrow_re');
    }

    // コメント欄　スクロールボタンを押す
    setTimeout(() => {
        const indicator = elems.playerSection.querySelector('[class*="_indicator_"]');
        if (indicator) indicator.click();
    }, 1000);

    try {
        // サイドバー開閉を記憶する場合
        if (Number(options.isAutoOpen) === 2) {
            chrome.storage.local.set({ 'isSidebar': isSidebar });
        }
    } catch (error) {

    }
};

// サイドバー境界線　ドラッグ変更
const changeSidebarLine = () => {

    let startX, startWidth;

    elems.sidebar_line.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();

        elems.sidebar.classList.remove('sidebar_transition');

        startX = e.clientX;
        startWidth = parseInt(document.defaultView.getComputedStyle(elems.sidebar).width, 10);
        document.documentElement.addEventListener('mousemove', onMouseMove);
        document.documentElement.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(e) {

        if (e.target.id === 'sidebar_button') return;

        let width = startWidth + (e.clientX - startX);

        // const maxWidth = windowWidth - rootMinWidth;
        // if (width > maxWidth) {
        //     width = maxWidth;
        // }

        if (width < sidebarMinWidth) {
            width = sidebarMinWidth;
        }

        elems.sidebar.style.width = width + 'px';
        elems.sidebar.style.maxWidth = width + 'px';
        elems.sidebar.style.minWidth = width + 'px';
        elems.sidebar_container.style.width = width + 'px';
        sidebarWidth = width;

        // ニコ生画面　全体幅を設定
        setRootWidth();

        setWatchPageWidth();
        set_program_container_width();
    }

    function onMouseUp(e) {

        elems.sidebar.classList.add('sidebar_transition');

        document.documentElement.removeEventListener('mousemove', onMouseMove);
        document.documentElement.removeEventListener('mouseup', onMouseUp);
    }
};

// プレーヤーサイズが固定かどうか
function isScreenSizeAuto() {
    const value = localStorage.getItem('LeoPlayer_ScreenSizeStore_kind');
    if (!value) return false;
    return value.includes('auto');
}

// フルスクリーンがONかどうか
function isFullScreenAttr() {
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
        //program_thumbnail.style.maxHeight = element.clientWidth * (8.5 / 16) + 'px';
    });
} 

async function getPrograms(rows = 100) {

    isInserting = true;
    api_error.classList.remove('api_error_active');

    try {
        let response = await fetch(`${notifyboxAPI}?rows=${rows}`, { credentials: 'include' });
        response = await response.json();

        if (response.meta?.status !== 200) {
            if (!response.data?.notifybox_content?.length) {
                throw new Error('APIエラー');
            }
        }

        // localStorageからサムネ情報を取得
        let programInfos = JSON.parse(localStorage.getItem('programInfos'));
        if (!programInfos) {
            // 初期化
            localStorage.setItem('programInfos', JSON.stringify([]));
            programInfos = [];
        }
        // toDolists 更新
        response.data.notifybox_content.map((live) => {
            const infos = programInfos.filter((info) => info.id === `lv${live.id}`);
            if (infos.length === 0) {
                toDolists.push(live.id);
            }
        });

        // 番組挿入へ
        const res = await insertProgramContainer(response.data.notifybox_content);
        if (res) set_program_container_width();


        if (toDolists.length === 0) {
            _updateThumbnailInterval = updateThumbnailInterval;
        } else {
            _updateThumbnailInterval = getProgramInfoInterval;
        }

    } catch (error) {
        isInserting = false;
        console.log(error);
        api_error.classList.add('api_error_active');
    }

    isInserting = false;
}

async function setProgramInfo(liveId) {
    try {
        let response = await fetch(`${liveInfoAPI}/lv${liveId}`);
        response = await response.json();

        if (response.meta?.status !== 200 || !response.data) return;
        if (!response.data.large640x360ThumbnailUrl && !response.data.liveScreenshotThumbnailUrls) return;

        // localStorageからサムネ情報を取得
        let programInfos = JSON.parse(localStorage.getItem('programInfos'));

        // localStorageになければ追加
        const infos = programInfos.filter((info) => info.id === `lv${liveId}`);
        if (infos.length === 0) {
            programInfos.push(response.data);
        }

        // localStorageに保存されたprogramInfosがmaxSaveProgramInfosを超えたら削除
        while (programInfos.length > maxSaveProgramInfos) {
            programInfos.shift();
        }

        // localStorageに保存
        localStorage.setItem('programInfos', JSON.stringify(programInfos));

    } catch (error) {
        console.log(error);
    }
}


async function insertProgramContainer(programs) {
    try {
        // HTML作成
        let html = '';
        programs.forEach(function (program) {
            html += makeProgramsHtml(program);
        });

        // 一旦すべての番組を取り除く
        const liveProgramContainer = document.getElementById('liveProgramContainer');
        liveProgramContainer.innerText = '';

        // 挿入
        liveProgramContainer.insertAdjacentHTML('beforeend', html);

        // 番組数更新
        program_count.textContent = programs.length ? programs.length : 0;

    } catch (error) {
        console.log(error);
        return false;
    }
    return true;
}

function makeProgramsHtml(program) {

    let user_page_url = '';
    let thumbnail_url = program.thumbnail_url;

    // localStorageから番組情報を取得
    let programInfos = JSON.parse(localStorage.getItem('programInfos'));
    if (!programInfos) return;

    // 番組情報セット
    const infos = programInfos.filter((info) => info.id === `lv${program.id}`);
    if (infos.length !== 0 && infos[0].contentOwner) {
        user_page_url = `https://www.nicovideo.jp/user/${infos[0].contentOwner.id}`;
    }
    if (infos.length !== 0 && infos[0].large640x360ThumbnailUrl) {
        thumbnail_url = `${infos[0].large640x360ThumbnailUrl}`;
    }
    if (infos.length !== 0 && infos[0].liveScreenshotThumbnailUrls) {
        thumbnail_url = `${infos[0].liveScreenshotThumbnailUrls.middle}?cache=${Date.now()}`;
    }

    const html = `<div id="${program.id}" class="program_container">
						<div class="community">
                            <a href="${user_page_url}" target="_blank">
                                <img src="${program.thumbnail_url}">
                            </a>
                            <div class="community_name">
                                ${program.community_name}
                            </div>
                        </div>
                        <div class="program_thumbnail program-card_">
                            <a href="${program.thumbnail_link_url}">
                                <img src="${thumbnail_url}" onerror="this.src='${chrome.runtime.getURL('images/loading.gif')}'; this.removeAttribute('onerror'); this.removeAttribute('onload');" onload="this.removeAttribute('onerror'); this.removeAttribute('onload');">
                            </a>
                        </div>
                        <div class="program_title">
                            ${program.title}
                        </div>
					</div>`;
    return html;
}

function updateThumbnail() {
    if (!isSidebar) return;
    if (isInserting) return;

    // localStorageから番組情報を取得
    const programInfos = JSON.parse(localStorage.getItem('programInfos'));
    if (!programInfos) return;

    const program_thumbnails = document.querySelectorAll('.program_thumbnail');
    
    let program_thumbnail = '';
    let thumbnail_url_ = '';
    for (let i = 0; i < program_thumbnails.length; i++) {

        program_thumbnail = program_thumbnails[i];
        const thumbnail_url = program_thumbnail.querySelector('img').getAttribute('src');

        if (thumbnail_url.includes('?cache=')) {
            program_thumbnail.querySelector('img').src = `${thumbnail_url.match(/^.+?\?cache=/)[0]}${Date.now()}`;
        } else {
            // ライブサムネが取得済みなら差し替える
            const programInfo_ = programInfos.filter((info) => info.id === `lv${program_thumbnail.parentElement.id}`);
            if (programInfo_.length === 0) continue;

            let programInfo = programInfo_[0];

            // コミュ限 または チャンネル方法　はスルー
            if (programInfo.isMemberOnly || programInfo.isChannelRelatedOfficial) continue;

            if (programInfo.large640x360ThumbnailUrl) {
                thumbnail_url_ = `${programInfo.large640x360ThumbnailUrl}`;
            }
            if (programInfo.liveScreenshotThumbnailUrls) {
                thumbnail_url_ = `${programInfo.liveScreenshotThumbnailUrls.middle}?cache=${Date.now()}`;
            }
            if (thumbnail_url_) {
                program_thumbnail.querySelector('img').src = thumbnail_url_;
            }
        }
    }
}

