document.addEventListener('DOMContentLoaded', async function () {

    // デフォルト値
    let isAutoOpen = '0';
    let isSaveSidebarSize = '0';

    // 保存されている値を取得
    let options = await chrome.storage.local.get();
    if (options) {
        isAutoOpen = options.isAutoOpen || isAutoOpen;
        isSaveSidebarSize = options.isSaveSidebarSize || isSaveSidebarSize;
    } else {
        options = {
            'isAutoOpen': isAutoOpen,
            'isSaveSidebarSize': isSaveSidebarSize,
        };
    }

    /**
     * オートオープン
     */

    // オートオープン設定のInput要素の取得
    const isAutoOpens = document.getElementsByName('isAutoOpen');

    // 保存されている値を設定
    for (let i = 0; i < isAutoOpens.length; i++) {
        if (isAutoOpens[i].value === isAutoOpen) {
            isAutoOpens[i].checked = true;
            break;
        }
    }

    // 変更があれば保存
    for (let i = 0; i < isAutoOpens.length; i++) {
        isAutoOpens[i].addEventListener('change', async function () {
            saveOptions();
        });
    }

    /**
     * サイドバーサイズ
     */

    // 設定のInput要素の取得
    const isSaveSidebarSizes = document.getElementsByName('isSaveSidebarSize');

    // 保存されている値を設定
    for (let i = 0; i < isSaveSidebarSizes.length; i++) {
        if (isSaveSidebarSizes[i].value === isSaveSidebarSize) {
            isSaveSidebarSizes[i].checked = true;
            break;
        }
    }

    // 変更があれば保存
    for (let i = 0; i < isSaveSidebarSizes.length; i++) {
        isSaveSidebarSizes[i].addEventListener('change', async function () {
            saveOptions();
        });
    }

});

function saveOptions() {
    const options = {
        'isAutoOpen': document.querySelector('input[name="isAutoOpen"]:checked').value,
        'isSaveSidebarSize': document.querySelector('input[name="isSaveSidebarSize"]:checked').value,
    };
    chrome.storage.local.set(options);
}