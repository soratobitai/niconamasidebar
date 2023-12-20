const notifyboxAPI = 'https://papi.live.nicovideo.jp/api/relive/notifybox.content.php';
//const notifyboxAPI = 'https://sp.live.nicovideo.jp/api/relive/notifybox.content.php';
const liveInfoAPI = 'https://api.cas.nicovideo.jp/v1/services/live/programs';

const getProgramsInterval = 60; // 秒
const maxSaveProgramInfos = 100;
const zappingMinWidth = 180;
const rootMinWidth = (1024 + 128 + 4);
const toDolists = [];
const getProgramInfoInterval = 0.3; // 秒
const updateThumbnailInterval = 20; // 秒
let _updateThumbnailInterval = getProgramInfoInterval;
let programContainerWidth = '100%';
let zappingWidth = zappingMinWidth;
let isAutoOpen = false;
let isSaveSidebarSize = false;
let isZapping = false;
let isInserting = false;
let isBetumadokun = false;
let isWatchPage = true;

// 初期化（開発用）
// localStorage.setItem('programInfos', JSON.stringify([]));

window.addEventListener('load', async function () {

    // 設定を取得
    const options = await chrome.storage.local.get();
    if (options &&
        options.isAutoOpen !== undefined &&
        options.isSaveSidebarSize !== undefined
    ) {
        isAutoOpen = Number(options.isAutoOpen);
        if (isAutoOpen === 2) {
            isAutoOpen = options.isZapping ? Number(options.isZapping) : Number(options.isAutoOpen);
        }
        
        isSaveSidebarSize = Number(options.isSaveSidebarSize);
        if (isSaveSidebarSize) {
            zappingWidth = (options.zappingWidth !== undefined) ? options.zappingWidth : zappingMinWidth;
        }
    }

    // 別窓くん（別窓ポップアップかどうか）
    // クエリを取得
    const url = new URL(window.location.href);
    const params = url.searchParams;
    isBetumadokun = (params.get('popup') === 'on');


    const zapping_line_html = `<div id="zapping_line"><div id="zapping_button"><div id="zapping_arrow"></div></div></div>`;
    document.body.insertAdjacentHTML('afterbegin', zapping_line_html);

    const zappingHtml = `<div id="zapping" class="zapping_transition">
                            <div id="zapping_container">
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
    document.body.insertAdjacentHTML('afterbegin', zappingHtml);
    
    const zapping = document.getElementById('zapping');
    const zapping_line = document.getElementById('zapping_line');
    const zapping_container = document.getElementById('zapping_container');
    const root = document.getElementById('root');

    if (!root) {
        isWatchPage = false;
        document.querySelector('header').style.display = 'none';
    }

    /* const watchPage = document.querySelector('[class*="_watch-page_"]');
    const playerSection = document.querySelector('[class*="_player-section_"]');
    const gaNsProgramSummary = document.querySelector('[class*="ga-ns-program-summary"]');
    const programInformationBodyArea = document.querySelector('[class*="_program-information-body-area_"]');
    const siteFooterUtility = document.querySelector('nav[class*="_site-footer-utility_"]');
    const feedbackAnchor = document.querySelector('a[class*="_feedback-anchor_"]');
    const fullscreenButton = document.querySelectorAll('button[class*="_fullscreen-button_"]');
    const theaterButton = document.querySelectorAll('button[class*="_theater-button_"]'); */

    const watchPage = document.evaluate(
        '//div[contains(@class, \'_watch-page_\')]',
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
    ).snapshotItem(0);

    const playerSection = document.evaluate(
        '//div[contains(@class, \'_player-section_\')]',
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
    ).snapshotItem(0);

    const gaNsProgramSummary = document.evaluate(
        '//div[contains(@class, \'ga-ns-program-summary\')]',
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
    ).snapshotItem(0);
    
    const programInformationBodyArea = document.evaluate(
        '//div[contains(@class, \'_program-information-body-area_\')]',
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
    ).snapshotItem(0);

    const siteFooterUtility = document.evaluate(
        '//nav[contains(@class, \'_site-utility-footer_\')]',
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
    ).snapshotItem(0);

    const feedbackAnchor = document.evaluate(
        '//a[contains(@class, \'_feedback-anchor_\')]',
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
    ).snapshotItem(0);

    const fullscreenButton = document.evaluate(
        '//button[contains(@class, \'_fullscreen-button_\')]',
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
    );

    const theaterButton = document.evaluate(
        '//button[contains(@class, \'_theater-button_\')]',
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
    );

    /**
     * ウィンドウサイズを常に監視、取得
     */
    let scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    let windowWidth = window.innerWidth - scrollbarWidth;
    let windowHeight = window.innerHeight;

    window.addEventListener('resize', function () {
        scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
        windowWidth = window.innerWidth - scrollbarWidth;
        windowHeight = window.innerHeight;
        setRootWidth();
        setWatchPageWidth();
    });

    // フルスクリーンモード切り替え時に実行
    for (let i = 0; i < fullscreenButton.snapshotLength; i++) {
        fullscreenButton.snapshotItem(i).addEventListener('click', function () {
            if (isZapping) zapping_button.click();
            setWatchPageWidth();
        });
    }

    // シアターモード切り替え時に実行
    for (let i = 0; i < theaterButton.snapshotLength; i++) {
        theaterButton.snapshotItem(i).addEventListener('click', function () {
            setWatchPageWidth();
        });
    }

    // フルスクリーン固定、自動切り替え時に実行するためにクリックで発火
    document.addEventListener('click', function (e) {
        setWatchPageWidth();
    }, false);

    // 再読み込みボタン
    reload_programs.addEventListener('click', function () {
        getPrograms(100);
    });

    // ウィンドウサイズの変更に伴ってページのスタイルを設定
    function setWatchPageWidth() {

        if (!isWatchPage) return;

        setTimeout(() => {
            
            let maxWidth = 1024 + 'px';
            let minWidth = 1024 + 'px';
            let width = 1024 + 'px';

            if (isScreenSizeAuto()) {

                if (root.clientWidth > (1152) && root.clientWidth < (1500)) {
                    maxWidth = (root.clientWidth - 128) + 'px';
                    minWidth = 1024 + 'px';
                    width = ((windowHeight * 1.777778) - 3.55556) + 'px';
                }
                if (root.clientWidth > (1500) && root.clientWidth < (1792)) {
                    maxWidth = (root.clientWidth - 128) + 'px';
                    minWidth = 1024 + 'px';
                    width = ((windowHeight * 1.777778) - 220.44444) + 'px';
                }
                if (root.clientWidth > (1792)) {
                    maxWidth = 1664 + 'px';
                    minWidth = 1024 + 'px';
                    width = ((windowHeight * 1.777778) - 220.44444) + 'px';
                }
            }

            if (isFullScreenAttr()) {
                root.style.maxWidth = '100%';
                maxWidth = '100%';
                minWidth = '100%';
                width = '100%';
            }

            // プレイヤー幅など設定
            playerSection.style.maxWidth = maxWidth;
            playerSection.style.minWidth = minWidth;
            playerSection.style.width = width;
            programInformationBodyArea.style.maxWidth = maxWidth;
            programInformationBodyArea.style.minWidth = minWidth;
            programInformationBodyArea.style.width = width;
            siteFooterUtility.style.maxWidth = maxWidth;
            siteFooterUtility.style.minWidth = minWidth;
            siteFooterUtility.style.width = width;
            gaNsProgramSummary.style.maxWidth = maxWidth;
            gaNsProgramSummary.style.minWidth = minWidth;
            gaNsProgramSummary.style.width = width;
            document.getElementById('enquete-placeholder').style.maxWidth = maxWidth;
            document.getElementById('enquete-placeholder').style.minWidth = minWidth;
            document.getElementById('enquete-placeholder').style.width = width;

            // ニコ生画面　全体幅を設定
            setRootWidth();

            // メールアイコン
            if (root.clientWidth > (1792)) {
                feedbackAnchor.style.right = ((root.clientWidth * 0.5) - 832) + 'px';
            } else {
                feedbackAnchor.style.right = 64 + 'px';
            }

            // シアターモード時
            if (watchPage.hasAttribute('data-player-layout-mode') && isScreenSizeAuto()) {
                playerSection.style.maxWidth = 'none';
                playerSection.style.width = 'auto';
            }

            try {
                // サイドバーサイズを記憶する場合
                if (isSaveSidebarSize) {
                    chrome.storage.local.set({ 'zappingWidth': zappingWidth });
                } else {
                    chrome.storage.local.set({ 'zappingWidth': zappingMinWidth });
                }
            } catch (error) {
                
            }
            
        }, 500);
    }

     // ニコ生画面　全体幅を設定
    function setRootWidth() {
        const rootWidth = windowWidth - (zapping.clientWidth + zapping_line.clientWidth);
        root.style.maxWidth = rootWidth + 'px';
        root.style.minWidth = rootWidth + 'px';
        root.style.width = rootWidth + 'px';
    }

    // ザッピングボタン ON OFF
    zapping_button.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();

        isZapping = !isZapping;
        
        if (isZapping) {
            getPrograms(100);

            if (zappingWidth < zappingMinWidth) zappingWidth = zappingMinWidth;
            zapping.style.width = zappingWidth + 'px';
            zapping.style.minWidth = zappingWidth + 'px';
            zapping_container.style.width = zappingWidth + 'px';

            if (isWatchPage) {
                root.style.maxWidth = windowWidth - (zappingWidth + zapping_line.clientWidth) + 'px';
                root.style.minWidth = windowWidth - (zappingWidth + zapping_line.clientWidth) + 'px';
                root.style.width = windowWidth - (zappingWidth + zapping_line.clientWidth) + 'px';

                // コメント欄　スクロールボタンを押す
                setTimeout(() => {
                    const indicator = playerSection.querySelector('[class*="_indicator_"]');
                    if (indicator) indicator.click();
                }, 1000);
            }

            zapping_arrow.classList.add('zapping_arrow_re');

            
        } else {
            zapping.style.width = 0;
            zapping.style.minWidth = 0;

            if (isWatchPage) {
                root.style.maxWidth = windowWidth + 'px';
                root.style.minWidth = windowWidth + 'px';
                root.style.width = windowWidth + 'px';
            }

            zapping_arrow.classList.remove('zapping_arrow_re');
        }

        try {
            // サイドバー開閉を記憶する場合
            if (Number(options.isAutoOpen) === 2) {
                chrome.storage.local.set({ 'isZapping': isZapping });
            }
        } catch (error) {

        }

        setWatchPageWidth();

    }, false);

    /**
     * ザッピングLINE　ドラッグ変更
     */
    var startX, startWidth;

    zapping_line.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();

        zapping.classList.remove('zapping_transition');

        startX = e.clientX;
        startWidth = parseInt(document.defaultView.getComputedStyle(zapping).width, 10);
        document.documentElement.addEventListener('mousemove', onMouseMove);
        document.documentElement.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(e) {

        if (e.target.id === 'zapping_button') return;

        let width = startWidth + (e.clientX - startX);

        // const maxWidth = windowWidth - rootMinWidth;
        // if (width > maxWidth) {
        //     width = maxWidth;
        // }

        if (width < zappingMinWidth) {
            width = zappingMinWidth;
        }

        zapping.style.width = width + 'px';
        zapping.style.maxWidth = width + 'px';
        zapping.style.minWidth = width + 'px';
        zapping_container.style.width = width + 'px';
        zappingWidth = width;

        // ニコ生画面　全体幅を設定
        setRootWidth();
        
        setWatchPageWidth();
        set_program_container_width();
    }

    function onMouseUp(e) {

        zapping.classList.add('zapping_transition');

        document.documentElement.removeEventListener('mousemove', onMouseMove);
        document.documentElement.removeEventListener('mouseup', onMouseUp);
    }


    // オートオープン
    if (isAutoOpen && Number(options.isZapping) && !isBetumadokun) {
        setTimeout(() => {
            zapping_button.click();
        }, 2000);
    } else {
        getPrograms(100);
    }

    // 番組リストを定期取得
    setInterval(function () {
        // if (!isZapping) return;
        getPrograms(100);
    }, getProgramsInterval * 1000);

    // 番組情報を取得
    setInterval(function () {
        // if (!isZapping) return;
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

    if (zappingWidth < 300) programContainerWidth = 100 + '%';
    if (zappingWidth > 300) programContainerWidth = 100 / 2 + '%';
    if (zappingWidth > 500) programContainerWidth = 100 / 3 + '%';
    if (zappingWidth > 700) programContainerWidth = 100 / 4 + '%';
    if (zappingWidth > 900) programContainerWidth = 100 / 5 + '%';
    if (zappingWidth > 1100) programContainerWidth = 100 / 6 + '%';
    if (zappingWidth > 1300) programContainerWidth = 100 / 7 + '%';
    if (zappingWidth > 1500) programContainerWidth = 100 / 8 + '%';

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
    if (!isZapping) return;
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

