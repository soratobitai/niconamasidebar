import { saveOptions as saveOptionsToStorage } from '../services/storage.js';
import { clearWatchHistory, watchHistorySize } from '../services/watchHistory.js';

/**
 * オプション設定の反映とイベントハンドリング
 */
/**
 * @param {object} options
 * @param {(container: HTMLElement) => void} sortPrograms
 * @param {() => void} [onKickGranted] Kick 連携が有効になった直後に呼ばれる。
 *   **リストの再取得に使う。**これが無いと、有効にしても次の定期更新（既定120秒）まで
 *   Kick の番組もタブも出てこない。
 *
 * ⚠️ 第4引数 `onDwellChanged`（「人気順の基準」が動いた時）は 2026-08-12 に廃止した
 *    （doc/09 項目CU）。W は固定値になり、利用者が動かす経路は無い。
 */
export function setupOptionsHandler(options, sortPrograms, onKickGranted) {
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
            const cardSizeElement = document.querySelector('input[name="cardSize"]:checked');
            const sidebarPlacementElement = document.querySelector('input[name="sidebarPlacement"]:checked');
            const showViewerCountElement = document.querySelector('input[name="showViewerCount"]:checked');
            const showElapsedTimeElement = document.querySelector('input[name="showElapsedTime"]:checked');

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
            // カードの大きさ。**必須ガードに入れない**（後から足した設定なので、古い DOM でも保存を止めない）。
            if (cardSizeElement) options.cardSize = cardSizeElement.value;
            if (sidebarPlacementElement) options.sidebarPlacement = sidebarPlacementElement.value;
            // 同時視聴者数（β版）。**必須ガードに入れない**（後から足した設定なので、古い DOM でも保存を止めない）。
            // 画面への反映は各ページの storage.onChanged が applyShowViewerCount で行う。
            if (showViewerCountElement) options.showViewerCount = showViewerCountElement.value;
            // 経過時間。**必須ガードに入れない**（後から足した設定なので、古い DOM でも保存を止めない）。
            if (showElapsedTimeElement) options.showElapsedTime = showElapsedTimeElement.value;
            // （「人気順の基準」は 2026-08-12 に廃止した。doc/09 項目CU）
            // ⚠️ かつてここに書いてあった注記: スライダーなので
            //    専用の input リスナーが options に入れている（フォームの change では拾えない）。

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
    updateCheckedState('cardSize', options.cardSize);
    updateCheckedState('sidebarPlacement', options.sidebarPlacement);
    updateCheckedState('showViewerCount', options.showViewerCount);
    updateCheckedState('showElapsedTime', options.showElapsedTime);

    /**
     * 「よく見る順」を選んでいる時だけ出す部分（履歴のリセット）。
     * ⚠️ **人気順では出さない。** 履歴は人気順の並びに一切効かないので、出すと関係が誤解される
     *    （旧「人気順の基準」は人気順にも効いたので `active || recommend` だった。ここは違う）。
     */
    const syncRecommendOnlySections = () => {
        const on = options.programsSort === 'recommend';
        for (const el of document.querySelectorAll('.opt-recommend-only')) el.hidden = !on;
    };

    // フォームに変更があったら保存する
    const optionForm = document.getElementById('optionForm');
    if (optionForm) {
        optionForm.addEventListener('change', (event) => {
            if (event.target.name === 'programsSort') {
                // ソート方式変更時は既存データでソート（APIリクエストなし、ローディングなし）
                saveOptions();
                // 🔴 保存だけして表示を放置しないこと。切り替えても出たままになる。
                syncRecommendOnlySections();
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

    syncRecommendOnlySections();
    setupKickLink(onKickGranted);
    setupWatchPointsReset();
}

/**
 * 「よく見る順の履歴」のリセット（doc/09 項目CW）。
 *
 * 🔴 **2段階にすること。** 取り消せない操作で、押し間違いの救済が無い。
 *    1回目は文言を確認へ変えるだけ。何もせず放っておくと戻る。
 *
 * 🔴 **消した後の並べ替えをここから呼ばないこと。** `clearWatchHistory` が storage を消すと
 *    `storage.onChanged` が**自分のタブでも**起き、`startWatchHistorySync` が受けて
 *    メモリを空にし、並べ替え直しまでやる（別タブと同じ道）。ここで別に呼ぶと2回走るうえ、
 *    「同じことをする道が2本」になって片方だけ直す事故が起きる。
 *
 * ⚠️ **設定ではなく操作。** `optionKeys` にも `saveOptions` にも関わらない。
 */
const RESET_CONFIRM_MS = 6000;
function setupWatchPointsReset() {
    const btn = document.getElementById('reset_watch_points');
    if (!btn) return;

    // 状態は**ボタン自身の文言**で出す（小さく目立たなく置くため、別枠を持たない）。
    const IDLE = '履歴をリセット';
    let armed = false;
    let revertTimer = null;
    const setLabel = (text, isArmed) => {
        btn.textContent = text;
        // 確認中だけ目立たせる。小さく置いている以上、押し間違いにその場で気付ける手がかりが要る。
        if (btn.classList) btn.classList.toggle('is-armed', !!isArmed);
    };
    const disarm = () => {
        armed = false;
        if (revertTimer) { clearTimeout(revertTimer); revertTimer = null; }
        setLabel(IDLE, false);
    };
    const revertLater = () => {
        if (revertTimer) clearTimeout(revertTimer);
        revertTimer = setTimeout(disarm, RESET_CONFIRM_MS);
    };

    btn.addEventListener('click', async () => {
        if (!armed) {
            // 何人ぶん消えるかを出す。0件なら押す意味が無いので、そう伝えて終わる。
            const n = watchHistorySize();
            if (n === 0) {
                setLabel('履歴はまだありません', false);
                revertLater();
                return;
            }
            armed = true;
            setLabel(`本当に消す（${n}人ぶん）`, true);
            revertLater();
            return;
        }
        armed = false;
        try {
            await clearWatchHistory();
            setLabel('消しました', false);
        } catch (_e) {
            setLabel('消せませんでした', false);
        }
        revertLater();
    });
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
function setupKickLink(onKickGranted) {
    const button = document.getElementById('open_kick_settings');
    const status = document.getElementById('kick_status');

    // 差し込み直しの後も**最新の**コールバックを呼べるようにしておく。
    if (typeof onKickGranted === 'function') onKickGrantedRef = onKickGranted;

    // 🔴 **document / chrome.runtime へのリスナーは1回だけ張ること。**
    //    `setupOptionsHandler` はサイドバーを差し込むたびに呼ばれる。kick.com は SPA なので
    //    差し込み直しが起こりうる。毎回張ると visibilitychange と onMessage が積み上がり、
    //    1回の変化で同じ処理が何度も走る（ページ滞在中ずっと増え続ける）。
    if (!setupKickLink._globalWired) {
        setupKickLink._globalWired = true;

        // オプションページは別タブで開く。戻ってきた時に表示を実態へ合わせる。
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) refreshKickStatusRef();
        });

        // 権限が増減したら SW が知らせてくる。設定表示の追従と、
        // 無効化された時のカード撤去をその場で行う（次の更新周期を待たない）。
        try {
            chrome.runtime.onMessage.addListener((msg) => {
                if (!msg || msg.type !== 'kick:stateChanged') return;
                refreshKickStatusRef();
                if (msg.granted) {
                    // 🔴 **有効にした直後は取り直すこと。** これが無いと次の定期更新
                    //    （既定120秒）まで Kick の番組もタブも出てこず、
                    //    「有効にしたのに何も起きない」に見える。
                    onKickGrantedRef();
                } else {
                    removeKickCards();
                }
            });
        } catch (e) { /* 拡張が無効化されている */ }
    }

    // Kick が有効な時だけ出す設定（表示方法）。無効なら意味が無いので隠す。
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

    // 上の1回きりのリスナーが、差し込み直し後も**最新の**refreshStatus を呼べるようにする。
    refreshKickStatusRef = refreshStatus;

    refreshStatus();
}

// 1回だけ張るリスナーから呼ぶ、最新の関数への参照。
let refreshKickStatusRef = () => {};
let onKickGrantedRef = () => {};

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
    // 件数も合わせる。放置すると Kick を含んだ数のまま残る。
    const count = document.getElementById('program_count');
    if (count) count.textContent = String(container.children.length);
}
