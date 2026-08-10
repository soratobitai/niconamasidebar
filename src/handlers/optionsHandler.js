import { saveOptions as saveOptionsToStorage } from '../services/storage.js';
import { dwellMinutesScale, defaultDwellMinutes } from '../config/constants.js';

/**
 * オプション設定の反映とイベントハンドリング
 */
/**
 * @param {object} options
 * @param {(container: HTMLElement) => void} sortPrograms
 * @param {() => void} [onKickGranted] Kick 連携が有効になった直後に呼ばれる。
 *   **リストの再取得に使う。**これが無いと、有効にしても次の定期更新（既定120秒）まで
 *   Kick の番組もタブも出てこない。
 * @param {(minutes: number) => void} [onDwellChanged] 「人気順の基準」が動いた時に呼ばれる。
 *   **取得はせず、その場で順位属性を計算し直して並べ替えること。**
 *   取得すると、スライダーを動かすたびに数秒かかって使い物にならない。
 */
export function setupOptionsHandler(options, sortPrograms, onKickGranted, onDwellChanged) {
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
            // ⚠️ 人気順の基準（dwellMinutes）はここで読まない。スライダーなので
            //    専用の input リスナーが options に入れている（フォームの change では拾えない）。

            saveOptionsToStorage(options);
        } catch (error) {
            // エラーは静かに無視
        }
    };

    /**
     * 「人気順の基準」は人気順を選んでいる時だけ出す。
     * 新着順は `data-api-index` で並ぶので `active-point` を見ず、この設定は何も変えない。
     */
    const syncActiveOnlySections = () => {
        // おすすめ順も同点は人気順で並ぶので、この設定が効く（2026-08-10）。
        const on = options.programsSort === 'active' || options.programsSort === 'recommend';
        for (const el of document.querySelectorAll('.opt-active-only')) el.hidden = !on;
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
    setupDwellSlider(options, sortPrograms, onDwellChanged);

    // フォームに変更があったら保存する
    const optionForm = document.getElementById('optionForm');
    if (optionForm) {
        optionForm.addEventListener('change', (event) => {
            if (event.target.name === 'programsSort') {
                // ソート方式変更時は既存データでソート（APIリクエストなし、ローディングなし）
                saveOptions();
                // 人気順の基準は人気順の時だけ出す。保存だけして表示を放置すると、
                // 新着順に切り替えても効かない設定が残って見える。
                syncActiveOnlySections();

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

    syncActiveOnlySections();
    setupKickLink(onKickGranted);
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
    // ⚠️ **人気順の基準（dwellMinutes）はここに含めない。**Kick 連携の有無に関わらず
    //    ニコ生の順位に効くので、常時表示の独立した設定にしてある（doc/09 項目BL-5）。
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

/**
 * 「人気順の基準」のスライダー。**数値は出さない。**
 *
 * スライダーが持つのは目盛りの添字で、実際の分は `dwellMinutesScale` から引く。
 * 目盛りが等間隔でないのは、W の効き方が対数的だから（constants.js を参照）。
 *
 * 🔴 **`input` で反映し、保存は遅らせること。**
 *    ドラッグ中は1ピクセルごとに発火する。毎回保存すると `storage.onChanged` が連射され、
 *    受け取った側がそのたびに処理を始める。反映（並べ替え）は即時、保存は指を離した頃で十分。
 */
function setupDwellSlider(options, sortPrograms, onDwellChanged) {
    const slider = document.getElementById('dwellMinutes');
    if (!slider) return;

    const scale = dwellMinutesScale;
    const toIndex = (minutes) => {
        const m = Number(minutes) || defaultDwellMinutes;
        let best = 0;
        for (let i = 1; i < scale.length; i++) {
            if (Math.abs(scale[i] - m) < Math.abs(scale[best] - m)) best = i;
        }
        return best;
    };

    slider.min = '0';
    slider.max = String(scale.length - 1);
    slider.step = '1';
    slider.value = String(toIndex(options.dwellMinutes));

    let saveTimer = null;
    slider.addEventListener('input', () => {
        const minutes = scale[Number(slider.value)] || defaultDwellMinutes;
        options.dwellMinutes = minutes;

        // 反映は即時。取得はしない。
        if (typeof onDwellChanged === 'function') onDwellChanged(minutes);
        const container = document.getElementById('liveProgramContainer');
        if (container) sortPrograms(container);

        // 保存だけ遅らせる。
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            saveOptionsToStorage(options);
        }, 400);
    });
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
