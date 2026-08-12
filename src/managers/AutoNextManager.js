import { observeProgramEnd, markAutoNextHop } from '../services/status.js';
import { pickAutoNextTarget, watchTargetIdOf } from '../render/sidebar.js';
import { autoNextListWaitMaxMs, autoNextCountdownMs } from '../config/constants.js';

/**
 * 自動次番組機能の管理
 * モーダル表示、ライブステータス監視、自動遷移を担当
 */
export class AutoNextManager {
    constructor(appState) {
        this.appState = appState;
    }

    /**
     * 自動次番組モーダルを作成（存在しない場合のみ）
     */
    ensureModal() {
        let modal = document.getElementById('auto_next_modal');
        if (modal) return modal;
        
        // DOM要素を直接作成
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

        // ヒント（サムネクリックで即移動）
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = 'サムネイルをクリックすると今すぐ移動します';
        dialog.appendChild(hint);

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

    /**
     * モーダルを表示
     */
    showModal(seconds, preview, onCancel, onConfirm) {
        const modal = this.ensureModal();
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

        // サムネイルクリックで即移動（カウントダウンを待たない）。
        // モーダル(img/枠)は使い回すため addEventListener ではなく onclick で上書きし、ハンドラ重複を防ぐ。
        try {
            const thumbArea = modal.querySelector('.preview .thumb');
            if (thumbArea) {
                if (typeof onConfirm === 'function') {
                    thumbArea.classList.add('is-clickable');
                    thumbArea.title = 'クリックで今すぐこの番組へ移動';
                    thumbArea.onclick = (e) => { e.preventDefault(); onConfirm(); };
                } else {
                    thumbArea.classList.remove('is-clickable');
                    thumbArea.removeAttribute('title');
                    thumbArea.onclick = null;
                }
            }
        } catch (_e) {}

        modal.classList.add('show');
        
        const onCancelHandler = (e) => {
            e.preventDefault();
            this.hideModal();
            this.appState.autoNext.canceled = true;
            if (typeof onCancel === 'function') onCancel();
        };
        
        if (cancelBtn) {
            cancelBtn.addEventListener('click', onCancelHandler, { once: true });
        }
    }

    /**
     * モーダルを非表示
     */
    hideModal() {
        const modal = document.getElementById('auto_next_modal');
        if (modal) modal.classList.remove('show');
    }

    /**
     * autoNext カウントダウンタイマーを安全に停止（存在すれば clearInterval＋登録解除）
     */
    _clearAutoNextTimer() {
        const timer = this.appState.getTimer('autoNext');
        if (timer) {
            try { clearInterval(timer); } catch (_e) {}
            this.appState.clearTimer('autoNext');
        }
    }

    /**
     * 自動次番組への遷移をスケジュール
     * @param {string} nextHref - 遷移先URL
     * @param {Object} preview - プレビュー情報
     */
    scheduleNavigation(nextHref, preview) {
        // 既存のカウントダウンが生きていれば停止
        this._clearAutoNextTimer();

        // 🔴 **残り時間は「期限」で持つこと。1秒ずつ引き算しないこと。**
        // Chrome は5分以上隠れている無音タブのタイマーを1分に1回まで間引く。番組が終われば音も
        // 止まるので、自動移動が効いてほしい場面がちょうどその条件に当てはまる。引き算方式だと
        // 10回数えるのに最大10分かかり、戻ってきたら「3秒後に移動します」で止まって見える。
        // 期限で持てば、間引かれても次に目が覚めた1回で期限超過を検出して遷移できる（誤差は最大1分程度）。
        // ⚠️ `visibilitychange` で叩き起こす手もあるが、この拡張は**リスナーを1つも持たない**方針で
        //    （verify:loop の D6 が機械で担保している）、ここで例外を作らない。
        const deadlineAt = Date.now() + autoNextCountdownMs;
        this.appState.autoNext.canceled = false;

        // 🔴 **カウントダウン中に見ているものが変わったら、移動を取りやめること。**
        //    kick.com は SPA で、**レイド**（配信者が終了時にリスナーをまとめて別チャンネルへ
        //    送る機能）はページを破棄せずに URL だけ変える。タイマーは生き残るので、
        //    そのままだと**レイド先に着いた数秒後にこちらが別の配信へ引きはがす。**
        //    ニコ生では遷移が必ずフルロードでタイマーごと消えるため、この穴は表に出ていなかった。
        // ⚠️ 利用者の取り消し（canceled）とは別扱い。あちらは「このページではもう動かない」だが、
        //    こちらは**移動先が変わっただけ**なので、次の終了ではまた動けるようにする。
        const startedAtId = watchTargetIdOf(location.href);
        const movedAway = () => watchTargetIdOf(location.href) !== startedAtId;
        const abandon = (why) => {
            this._clearAutoNextTimer();
            this.hideModal();
            this.appState.autoNext.scheduled = false;  // 再武装する（取り消しとの違い）
            this.appState.autoNext.canceled = false;
        };
        
        // サムネクリックで即移動（カウントダウンを待たず nextHref へ）。タイマー停止→遷移。
        const goNow = () => {
            if (this.appState.autoNext.canceled) return;
            // 押した時点で既に別の配信へ移っていたら何もしない（レイド等）
            if (movedAway()) return abandon('押す前に別の配信へ移っていた');
            this._clearAutoNextTimer();
            this.appState.autoNext.scheduled = true;
            this.hideModal();
            // 🔴 **飛ぶ前に印を置く。** 飛んだ先が既に終了していた時、そこで自動移動を続けるための印。
            //    印が無いと、飛んだ先は終了ガイドが出ないので誰も気付かず止まる（doc/09 項目BI-2）。
            markAutoNextHop(watchTargetIdOf(nextHref), startedAtId);
            try { location.assign(nextHref); } catch (_e) {}
        };

        this.showModal(Math.round(autoNextCountdownMs / 1000), preview, () => {
            this._clearAutoNextTimer();
            this.appState.autoNext.scheduled = true;
        }, goNow);

        const modal = this.ensureModal();
        const countEl = modal.querySelector('#auto_next_count');

        const timer = setInterval(() => {
            // 🔴 見ているものが変わっていたら、そこで打ち切る。
            //    レイドで移された直後にこちらが引きはがすのを防ぐ唯一の関門。
            if (movedAway()) return abandon('カウントダウン中に別の配信へ移った');
            const remainingMs = deadlineAt - Date.now();
            if (countEl) countEl.textContent = String(Math.max(0, Math.ceil(remainingMs / 1000)));

            if (this.appState.autoNext.canceled) {
                this._clearAutoNextTimer();
                this.hideModal();
                return;
            }

            if (remainingMs <= 0) {
                this._clearAutoNextTimer();
                this.hideModal();
                if (!this.appState.autoNext.canceled && !movedAway()) {
                    // 飛んだ先が既に終了していても自動移動を続けるための印（goNow と同じ理由）
                    markAutoNextHop(watchTargetIdOf(nextHref), startedAtId);
                    try { location.assign(nextHref); } catch (_e) {}
                }
            }
        }, 1000);

        this.appState.setTimer('autoNext', timer);
    }

    /**
     * 視聴中番組の終了監視を開始
     * @param {Function} updateSidebarFn - サイドバー更新関数（番組終了検知時に最新リストを取得するため main.js から常に注入される）
     */
    startWatcher(updateSidebarFn = null, observeFn = observeProgramEnd) {
        this.stopWatcher();
        
        const stopper = observeFn(async (firstSinceArmed) => {
            // 多重進入抑止
            if (this.appState.autoNext.scheduled || this.appState.autoNext.selectingNext) {
                return;
            }
            this.appState.autoNext.selectingNext = true;

            try {
                // 最新の番組リストを取得（循環依存回避のため main.js から関数を注入）
                //
                // 🔴 **無制限に待たないこと。** リスト取得の fetch にタイムアウトは無く、
                // 応答が返らなければこの await は返らない。返らなければ下の finally にも到達せず、
                // `selectingNext` が true のまま残る。このフラグはコールバック先頭の多重進入ガードに
                // 使われているので、**以後そのページでは自動移動が二度と動かない**（doc/09 項目AU。
                // 項目AF の「フラグが残ると二度と動かない」と同型の欠陥）。
                //
                // 待つ目的は「より新しいリストから選ぶ」ことであって、待てないなら今DOMにある
                // カードから選べばよい。取得自体は裏で走り続けるので、次の周期で反映される。
                // 🔴 **取り直すのは「終了を検知した最初の1回」だけ**（doc/09 項目BI-3）。
                //
                // 終了ガイドが出ている間、この検知は20秒ごとに再発火する。毎回取り直すと、
                // **移動先が見つからないページで 20秒ごとの取得が止まらない**（`scheduled` が
                // 立たないため多重進入ガードにも掛からない）。実測: 通常6回/分・最悪66回/分。
                // 暴走ではない（回数は時間で決まる）が、常設ループの3倍が延々と続く。
                //
                // 2回目以降は**今DOMにあるカードから選ぶ**。リストは常設ループが更新し続けている
                // ので、待っていれば新しい番組は勝手に入ってくる。取り直す意味が無い。
                if (firstSinceArmed && typeof updateSidebarFn === 'function') {
                    await Promise.race([
                        // updateSidebar は内部で catch 済みだが、経路が増えても未処理拒否にならないようにする
                        Promise.resolve(updateSidebarFn()).catch(() => {}),
                        new Promise((resolve) => setTimeout(resolve, autoNextListWaitMaxMs)),
                    ]);
                }
                // 移動先の選び方は**両ページで共有**（render/sidebar.js の pickAutoNextTarget）。
                // ・サービスをまたいでよい（Kick のカードへも飛ぶ）
                // ・タブで分けている時は**見えているタブ**からだけ選ぶ
                // ・今いる放送が分からない時（一覧ページ・VOD 等）は選ばない
                const container = document.getElementById('liveProgramContainer');
                const { link: targetLink, id: chosen, candidates: cand, currentId } =
                    pickAutoNextTarget(container, location.href);


                if (targetLink && targetLink.href) {
                    // プレビュー情報抽出
                    let preview = null;
                    try {
                        const card = targetLink.closest('.program_container');
                        const imgEl = card ? card.querySelector('.program_thumbnail_img') : null;
                        const titleEl = card ? card.querySelector('.program_title') : null;
                        const providerEl = card ? card.querySelector('.provider_name') : null;
                        preview = {
                            href: targetLink.href,
                            thumb: imgEl && imgEl.src ? imgEl.src : '',
                            title: titleEl && titleEl.textContent ? titleEl.textContent.trim() : '',
                            provider: providerEl && providerEl.textContent ? providerEl.textContent.trim() : '',
                        };
                    } catch (_e) {}
                    
                    this.appState.autoNext.scheduled = true;
                    this.scheduleNavigation(targetLink.href, preview);
                }
            } catch (_e) {}
            finally {
                // 次回の検出に備えて解除
                this.appState.autoNext.selectingNext = false;
            }
        });
        
        this.appState.autoNext.liveStatusStopper = stopper;
    }

    /**
     * 視聴中番組の終了監視を停止
     */
    stopWatcher() {
        if (this.appState.autoNext.liveStatusStopper) {
            try { this.appState.autoNext.liveStatusStopper(); } catch (_e) {}
            this.appState.autoNext.liveStatusStopper = null;
        }
        
        this._clearAutoNextTimer();

        this.hideModal();
        this.appState.autoNext.scheduled = false;
        this.appState.autoNext.selectingNext = false;
    }
}

