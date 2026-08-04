import { saveOptions as saveOptionsToStorage } from '../services/storage.js';

/**
 * オプション設定の反映とイベントハンドリング
 */
export function setupOptionsHandler(options, sortPrograms) {
    /**
     * チェックボックスの状態を更新
     */
    const updateCheckedState = (name, value) => {
        const elements = document.getElementsByName(name);
        if (elements.length === 0) return;

        elements.forEach(item => {
            item.checked = item.value === value;
        });
    };

    /**
     * オプションを保存
     */
    const saveOptions = () => {
        try {
            const autoOpenElement = document.querySelector('input[name="autoOpen"]:checked');
            const updateProgramsIntervalElement = document.querySelector('input[name="updateProgramsInterval"]:checked');
            const programsSortElement = document.querySelector('input[name="programsSort"]:checked');
            const autoNextProgramElement = document.querySelector('input[name="autoNextProgram"]:checked');
            const animatedThumbnailElement = document.querySelector('input[name="animatedThumbnail"]:checked');
            const sidebarThemeElement = document.querySelector('input[name="sidebarTheme"]:checked');
            const kickDisplayModeElement = document.querySelector('input[name="kickDisplayMode"]:checked');
            const dwellMinutesElement = document.querySelector('input[name="dwellMinutes"]:checked');

            if (!autoOpenElement || !updateProgramsIntervalElement || !programsSortElement || !autoNextProgramElement) {
                return;
            }

            options.autoOpen = autoOpenElement.value;
            options.updateProgramsInterval = updateProgramsIntervalElement.value;
            options.programsSort = programsSortElement.value;
            options.autoNextProgram = autoNextProgramElement.value;
            // 動くサムネ（β版・後方互換のためガード対象外・存在すれば反映）
            if (animatedThumbnailElement) options.animatedThumbnail = animatedThumbnailElement.value;
            // テーマ（存在すれば反映。body への適用は main.js の storage.onChanged が担う）
            if (sidebarThemeElement) options.sidebarTheme = sidebarThemeElement.value;
            // Kick の表示方法とバランス。**「Kick を有効にするか」はここに無い**
            // （権限が唯一の真実で、拡張のオプションページでしか変えられない）。
            if (kickDisplayModeElement) options.kickDisplayMode = kickDisplayModeElement.value;
            // 数値で保存する（オプションページ側と型を揃える）。
            if (dwellMinutesElement) options.dwellMinutes = Number(dwellMinutesElement.value);

            saveOptionsToStorage(options);
        } catch (error) {
            // エラーは静かに無視
        }
    };

    // 各設定を反映
    updateCheckedState('programsSort', options.programsSort);
    updateCheckedState('updateProgramsInterval', options.updateProgramsInterval);
    updateCheckedState('autoOpen', options.autoOpen);
    updateCheckedState('autoNextProgram', options.autoNextProgram);
    updateCheckedState('animatedThumbnail', options.animatedThumbnail);
    updateCheckedState('sidebarTheme', options.sidebarTheme);
    updateCheckedState('kickDisplayMode', options.kickDisplayMode);
    updateCheckedState('dwellMinutes', String(options.dwellMinutes));

    // フォームに変更があったら保存する
    const optionForm = document.getElementById('optionForm');
    if (optionForm) {
        optionForm.addEventListener('change', (event) => {
            if (event.target.name === 'programsSort') {
                // ソート方式変更時は既存データでソート（APIリクエストなし、ローディングなし）
                saveOptions();

                // 既存のDOMをソート（統一関数を使用）
                const container = document.getElementById('liveProgramContainer');
                if (container) {
                    sortPrograms(container);
                }
                return; // saveOptions()は既に呼ばれているのでreturn
            }
            saveOptions();
        });
    }

    setupKickLink();
}

/**
 * Kick 連携の導線。
 *
 * ここでは ON/OFF しない。`chrome.permissions.request()` はコンテンツスクリプトから呼べず、
 * この設定 UI はニコ生ページに描画された DOM だから。拡張のオプションページを開くだけ。
 *
 * ⚠️ 拡張が無効化・更新された後もコンテンツスクリプトは動き続ける。その状態で
 *    `chrome.runtime.sendMessage` を呼ぶと例外になるので、必ず握り潰す。
 */
function setupKickLink() {
    const button = document.getElementById('open_kick_settings');
    const status = document.getElementById('kick_status');

    // Kick が有効な時だけ出す設定（表示方法・バランス）。無効なら意味が無いので隠す。
    const kickOnlySections = document.querySelectorAll('.opt-kick-only');
    const setKickSectionsVisible = (visible) => {
        for (const el of kickOnlySections) el.hidden = !visible;
    };

    const refreshStatus = () => {
        try {
            chrome.runtime.sendMessage({ type: 'kick:status' }, (res) => {
                // 応答が無い＝SW が居ない/権限判定不能。空表示にして黙る。
                if (chrome.runtime.lastError) {
                    if (status) { status.textContent = ''; status.classList.remove('is-on'); }
                    setKickSectionsVisible(false);
                    return;
                }
                const granted = !!(res && res.granted);
                if (status) {
                    status.textContent = granted ? '有効' : '無効';
                    status.classList.toggle('is-on', granted);
                }
                setKickSectionsVisible(granted);
            });
        } catch (e) {
            if (status) { status.textContent = ''; status.classList.remove('is-on'); }
            setKickSectionsVisible(false);
        }
    };

    if (button) {
        button.addEventListener('click', () => {
            try {
                chrome.runtime.sendMessage({ type: 'kick:openOptions' }, () => {
                    // lastError を読まないと「応答が無い」警告がコンソールに出る。
                    void chrome.runtime.lastError;
                });
            } catch (e) {
                // 拡張が無効化されている。ページを再読み込みしない限り復帰しない。
            }
        });
    }

    // オプションページは別タブで開く。戻ってきた時に表示を実態へ合わせる。
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshStatus();
    });

    // 権限が増減したら SW が知らせてくる。設定表示の追従と、
    // 無効化された時のカード撤去をその場で行う（次の更新周期を待たない）。
    try {
        chrome.runtime.onMessage.addListener((msg) => {
            if (!msg || msg.type !== 'kick:stateChanged') return;
            refreshStatus();
            if (!msg.granted) removeKickCards();
        });
    } catch (e) { /* 拡張が無効化されている */ }

    refreshStatus();
}

/**
 * Kick のカードを DOM から取り除く。権限を外した直後に呼ぶ。
 *
 * 次の定期更新でも消えるが、それだと最大 `updateProgramsInterval` 秒（既定120）残る。
 * 「無効にしたのに消えない」は不具合に見えるので、その場で消す。
 */
function removeKickCards() {
    const container = document.getElementById('liveProgramContainer');
    if (!container) return;
    for (const el of Array.from(container.children)) {
        if (el.getAttribute('data-service') === 'kick') el.remove();
    }
    // タブ分離モードだった場合、Kick のカードが無くなればタブも引っ込める。
    const tabs = document.getElementById('serviceTabs');
    if (tabs) tabs.hidden = true;
    container.removeAttribute('data-service-tab');
}
