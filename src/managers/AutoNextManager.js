import { observeProgramEnd } from '../services/status.js';

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
     * 進行中のカウントダウンを取り消して、次の番組終了をまた検知できる状態へ戻す。
     *
     * ⚠️ **タイマーだけを止めてはいけない**（doc/09 項目AF）。
     * `appState.timers.autoNext` を外から `clearTimer` するだけだと、カウントダウンは止まるが
     * `autoNext.scheduled` が true のまま残り、モーダルも出しっぱなしになる。
     * `scheduled` は `observeProgramEnd` のコールバック先頭で多重進入を弾く条件に使われているため、
     * **以後そのページでは自動移動が二度と動かない**（リセットするのは stopWatcher だけで、
     * 閉パスからは呼ばれない）。タイマー・フラグ・モーダルは必ず3点セットで戻すこと。
     */
    cancelScheduledNavigation() {
        this._clearAutoNextTimer();
        this.hideModal();
        this.appState.autoNext.scheduled = false;
        this.appState.autoNext.selectingNext = false;
        this.appState.autoNext.canceled = false;
    }

    /**
     * 自動次番組への遷移をスケジュール
     * @param {string} nextHref - 遷移先URL
     * @param {Object} preview - プレビュー情報
     */
    scheduleNavigation(nextHref, preview) {
        // 既存のカウントダウンが生きていれば停止
        this._clearAutoNextTimer();
        
        let remaining = 10;
        this.appState.autoNext.canceled = false;
        
        // サムネクリックで即移動（カウントダウンを待たず nextHref へ）。タイマー停止→遷移。
        const goNow = () => {
            if (this.appState.autoNext.canceled) return;
            this._clearAutoNextTimer();
            this.appState.autoNext.scheduled = true;
            this.hideModal();
            try { location.assign(nextHref); } catch (_e) {}
        };

        this.showModal(remaining, preview, () => {
            this._clearAutoNextTimer();
            this.appState.autoNext.scheduled = true;
        }, goNow);
        
        const modal = this.ensureModal();
        const countEl = modal.querySelector('#auto_next_count');
        
        const timer = setInterval(() => {
            remaining -= 1;
            if (countEl) countEl.textContent = String(Math.max(0, remaining));
            
            if (this.appState.autoNext.canceled) {
                this._clearAutoNextTimer();
                this.hideModal();
                return;
            }
            
            if (remaining <= 0) {
                this._clearAutoNextTimer();
                this.hideModal();
                if (!this.appState.autoNext.canceled) {
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
    startWatcher(updateSidebarFn = null) {
        this.stopWatcher();
        
        const stopper = observeProgramEnd(async () => {
            // 多重進入抑止
            if (this.appState.autoNext.scheduled || this.appState.autoNext.selectingNext) return;
            this.appState.autoNext.selectingNext = true;
            
            try {
                // 最新の番組リストを取得（循環依存回避のため main.js から関数を注入）
                if (typeof updateSidebarFn === 'function') {
                    await updateSidebarFn();
                }
                const links = document.querySelectorAll('#liveProgramContainer .program_container .program_thumbnail a');
                const currentIdMatch = location.pathname.match(/\/watch\/(lv\d+)/);
                const currentId = currentIdMatch ? currentIdMatch[1] : '';

                let targetLink = null;
                for (const a of links) {
                    try {
                        const nextPath = new URL(a.href, location.href).pathname;
                        const nextIdMatch = nextPath.match(/\/watch\/(lv\d+)/);
                        const nextId = nextIdMatch ? nextIdMatch[1] : '';
                        if (currentId && nextId && nextId !== currentId) {
                            targetLink = a;
                            break;
                        }
                    } catch (_e) {}
                }

                if (targetLink && targetLink.href) {
                    // プレビュー情報抽出
                    let preview = null;
                    try {
                        const card = targetLink.closest('.program_container');
                        const imgEl = card ? card.querySelector('.program_thumbnail_img') : null;
                        const titleEl = card ? card.querySelector('.program_title') : null;
                        const providerEl = card ? card.querySelector('.community_name') : null;
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

