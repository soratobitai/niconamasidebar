document.addEventListener('DOMContentLoaded', async function () {

    // デフォルト値
    let autoOpen = '3';
    let updateThumbnailInterval = '60';

    // オプション取得
    let options = await chrome.storage.local.get();

    if (options) {
        if (options.autoOpen === undefined) options.autoOpen = autoOpen;
        if (options.updateThumbnailInterval === undefined) options.updateThumbnailInterval = updateThumbnailInterval;
    }

    /**
     * オプション内容を反映
     */

    // オートオープン
    document.getElementsByName('autoOpen').forEach(item => {
        if (item.value === options.autoOpen) {
            item.checked = true;
        } else {
            item.checked = false;
        }
    });

    // サムネ更新間隔
    document.getElementsByName('updateThumbnailInterval').forEach(item => {
        if (item.value === options.updateThumbnailInterval) {
            item.checked = true;
        } else {
            item.checked = false;
        }
    });

    // フォームに変更があったら保存する
    document.getElementById('optionForm').addEventListener('change', function (event) {
        saveOptions();
    });

    async function saveOptions() {
        options.autoOpen = document.querySelector('input[name="autoOpen"]:checked').value;
        options.updateThumbnailInterval = document.querySelector('input[name="updateThumbnailInterval"]:checked').value;

        await chrome.storage.local.set(options);
    }
});

