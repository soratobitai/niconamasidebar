import { fetchLivePrograms } from '../services/api.js';
import { getProgramInfos as getProgramInfosFromStorage } from '../services/storage.js';
import { makeProgramElement, calculateActivePoint, updateThumbnailsFromStorage, refreshThumbnailObservations } from '../render/sidebar.js';
import { setProgramContainerWidth } from '../ui/layout.js';
import { sortPrograms } from '../utils/sorting.js';
import { updateThumbnailInterval } from '../config/constants.js';

/**
 * 更新処理とタイマーの管理
 * サイドバー更新、サムネイル更新、番組詳細取得のタイマー管理と実行を担当
 */
export class UpdateManager {
    constructor(appState, programInfoQueue, loadingManager, options, elems, loadingImageURL) {
        this.appState = appState;
        this.programInfoQueue = programInfoQueue;
        this.loadingManager = loadingManager;
        this.options = options;
        this.elems = elems;
        this.loadingImageURL = loadingImageURL;
        
        // API呼び出しトラッカー（デバッグ用、global）
        this.apiCallCounter = window.apiCallCounter || {
            getLivePrograms: 0,
            fetchProgramInfo: 0,
            recentTimestamps: []
        };
        window.apiCallCounter = this.apiCallCounter;
        
        // 重複実行防止フラグ
        this.isPerformingInitialLoad = false;
    }

    /**
     * サムネイル更新タイマーを開始
     */
    startThumbnailUpdate() {
        const runUpdateThumbnail = () => {
            this.updateThumbnail();
            // 完了後にタイマーを再セット（定期実行）
            const interval = this.options.updateThumbnailInterval || updateThumbnailInterval;
            const timer = setTimeout(runUpdateThumbnail, interval * 1000);
            this.appState.setTimer('thumbnail', timer);
        };
        
        runUpdateThumbnail(); // 即座に実行
    }

    /**
     * ToDoリスト（番組詳細取得）更新を開始
     */
    async startToDoListUpdate() {
        // oneTimeFlagの処理（ページ読み込み時の初回更新）
        if (this.appState.update.oneTimeFlag) {
            await this.performInitialLoad();
            this.appState.update.oneTimeFlag = false;
        }
        
        // キュー処理を開始
        this.programInfoQueue.start();
        
        // タイマーIDを保存（停止用）
        this.appState.setTimer('todo', 'queue-managed');
    }

    /**
     * サイドバー更新タイマーを開始
     */
    startSidebarUpdate() {
        // 既存のタイマーがある場合は確実にクリア
        const existingTimer = this.appState.getTimer('sidebar');
        if (existingTimer && existingTimer !== 'queue-managed') {
            clearTimeout(existingTimer);
        }
        
        const updateSidebarInterval = async () => {
            await this.updateSidebar();
            // 定期更新時：最低1秒のローディング時間を確保して終了
            if (this.loadingManager.getCurrentSessionId()) {
                await this.loadingManager.finishSessionWithMinDuration(1000);
            }
            // 完了後にタイマーをセット
            const timer = setTimeout(updateSidebarInterval, Number(this.options.updateProgramsInterval) * 1000);
            this.appState.setTimer('sidebar', timer);
        };
        
        const timer = setTimeout(updateSidebarInterval, Number(this.options.updateProgramsInterval) * 1000);
        this.appState.setTimer('sidebar', timer);
    }

    /**
     * すべてのタイマーを停止
     */
    stopAllTimers() {
        this.appState.clearTimer('thumbnail');
        this.appState.clearTimer('todo');
        this.appState.clearTimer('sidebar');
        this.programInfoQueue.stop();
    }

    /**
     * サイドバー更新タイマーを再開
     */
    restartSidebarUpdate() {
        const existingTimer = this.appState.getTimer('sidebar');
        if (existingTimer && existingTimer !== 'queue-managed') {
            clearTimeout(existingTimer);
            this.appState.clearTimer('sidebar');
        }
        this.startSidebarUpdate();
    }

    /**
     * 初回ロードを実行（ページ読み込み時のみ）
     */
    async performInitialLoad() {
        // 重複実行を防ぐ
        if (this.isPerformingInitialLoad) {
            return;
        }
        
        this.isPerformingInitialLoad = true;
        try {
            // ソートフラグをON
            this.programInfoQueue.setShouldSort(true);
            
            // 番組リスト更新
            await this.updateSidebar();
            
            // DOM更新完了を待つ
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            
            // 番組詳細取得（全件）
            const initialQueueSize = this.programInfoQueue.size();
            
            if (initialQueueSize > 0) {
                await this.programInfoQueue.processNow(null).catch(error => {
                    console.error('[初回ロード] キュー処理でエラーが発生しました:', error);
                });
            }
            
            // サムネイル更新
            await new Promise(resolve => {
                this.updateThumbnail(true, resolve);
            });
            
            // 最低1秒のローディング時間を確保して終了
            await this.loadingManager.finishSessionWithMinDuration(1000);
            
            // 定期タイマーをリセット
            if (this.appState.sidebar.isOpen) {
                this.restartSidebarUpdate();
            }
        } catch (error) {
            console.error('[初回ロード] エラーが発生しました:', error);
            if (this.loadingManager.getCurrentSessionId()) {
                await this.loadingManager.finishSessionWithMinDuration(1000);
            }
        } finally {
            this.isPerformingInitialLoad = false;
        }
    }

    /**
     * 手動更新を実行（サイドバーオープン、タブ切替、更新ボタン押下）
     */
    async performManualUpdate() {
        try {
            // 番組リスト更新
            await this.updateSidebar();
            
            // サムネイル更新
            await new Promise(resolve => {
                this.updateThumbnail(true, resolve);
            });
            
            // 最低1秒のローディング時間を確保して終了
            await this.loadingManager.finishSessionWithMinDuration(1000);
            
            // 定期タイマーをリセット
            if (this.appState.sidebar.isOpen) {
                this.restartSidebarUpdate();
            }
        } catch (error) {
            console.error('[手動更新] エラーが発生しました:', error);
            if (this.loadingManager.getCurrentSessionId()) {
                await this.loadingManager.finishSessionWithMinDuration(1000);
            }
        }
    }

    /**
     * ライブ番組リストを取得
     */
    async getLivePrograms(rows = 100) {
        this.apiCallCounter.getLivePrograms++;
        this.apiCallCounter.totalCalls++;
        const callId = this.apiCallCounter.totalCalls;
        
        // タイムスタンプを記録（API呼び出し頻度の計算用）
        const now = Date.now();
        if (!this.apiCallCounter.recentTimestamps) {
            this.apiCallCounter.recentTimestamps = [];
        }
        this.apiCallCounter.recentTimestamps.push(now);
        
        // 異常検出：getLiveProgramsが1分以内に10回以上呼ばれた場合のみ警告
        if (!this.apiCallCounter.getLiveProgramsTimestamps) {
            this.apiCallCounter.getLiveProgramsTimestamps = [];
        }
        this.apiCallCounter.getLiveProgramsTimestamps.push(now);
        // 1分以上前のタイムスタンプを削除
        this.apiCallCounter.getLiveProgramsTimestamps = this.apiCallCounter.getLiveProgramsTimestamps.filter(t => now - t < 60000);
        
        if (this.apiCallCounter.getLiveProgramsTimestamps.length >= 10) {
            console.error(`🚨 [異常検出] getLivePrograms()が1分以内に${this.apiCallCounter.getLiveProgramsTimestamps.length}回呼ばれています！`);
        }
        
        const result = await fetchLivePrograms(rows);
        
        if (this.elems.apiErrorElement) {
            this.elems.apiErrorElement.style.display = result ? 'none' : 'block';
        }
        return result;
    }

    /**
     * サイドバーを更新
     */
    async updateSidebar() {
        // ローディングセッション開始
        this.loadingManager.startSession();
        
        try {
            // localStorageから番組情報を取得
            const programInfos = getProgramInfosFromStorage();

            const livePrograms = await this.getLivePrograms(100);
            if (!livePrograms) {
                // 失敗時は既存の番組数を維持
                const container = document.getElementById('liveProgramContainer');
                if (container && container.children.length > 0) {
                    this.updateProgramCount(container.children.length);
                }
                return;
            }
            
            // 空配列のときは既存DOMを維持
            if (Array.isArray(livePrograms) && livePrograms.length === 0) {
                this.updateProgramCount(0);
                return;
            }

            const container = document.getElementById('liveProgramContainer');
            const frag = document.createDocumentFragment();
            const existingMap = new Map();
            if (container) {
                Array.from(container.children).forEach((el) => {
                    if (el && el.id) existingMap.set(el.id, el);
                });
            }

            livePrograms.forEach((program) => {
                if (!program || !program.id) return;

                const data = programInfos.find((info) => info.id === `lv${program.id}`);
                const id = String(program.id);
                const existing = existingMap.get(id);

                if (existing) {
                    // 軽い更新（属性・タイトル・リンク先）
                    existing.setAttribute('active-point', String(calculateActivePoint(data || program)));
                    const titleEl = existing.querySelector('.program_title');
                    if (titleEl) titleEl.textContent = (data && data.title) || (program && program.title) || 'タイトル不明';
                    const linkEl = existing.querySelector('.program_thumbnail a');
                    if (linkEl) linkEl.href = data && data.id ? `https://live.nicovideo.jp/watch/${data.id}` : `https://live.nicovideo.jp/watch/lv${program.id}`;
                    frag.appendChild(existing);
                } else {
                    // DOM要素を直接作成
                    const element = data 
                        ? makeProgramElement(data, this.loadingImageURL) 
                        : makeProgramElement(program, this.loadingImageURL);
                    if (element) {
                        frag.appendChild(element);
                    }
                }

                // キューに追加（最新の放送中番組リスト）
                // updateSidebar()が120秒ごとに最新リストを取得するため、
                // 自動的に最新の番組がキューに追加される
                this.programInfoQueue.add(program.id);
            });

            const liveProgramContainer = document.getElementById('liveProgramContainer');
            if (!liveProgramContainer) {
                return;
            }

            // DOM更新
            this.appState.update.isInserting = true;
            liveProgramContainer.replaceChildren(frag);
            refreshThumbnailObservations();

            // ソート
            const container2 = document.getElementById('liveProgramContainer');
            if (container2) this.sortProgramsInContainer(container2);

            setProgramContainerWidth(this.elems, this.elems.sidebar ? this.elems.sidebar.offsetWidth : this.appState.sidebar.width);

            // 番組数更新
            this.updateProgramCount(livePrograms.length);
            
            this.appState.update.isInserting = false;
        } catch (error) {
            console.error('[updateSidebar] エラーが発生しました:', error);
            this.appState.update.isInserting = false;
        }
    }

    /**
     * サムネイルを更新
     */
    updateThumbnail(force, onComplete) {
        // DOM操作中は実行しない
        if (this.appState.update.isInserting) {
            if (onComplete) onComplete();
            return;
        }
        
        const programInfos = getProgramInfosFromStorage();
        if (!programInfos || programInfos.length === 0) {
            if (onComplete) onComplete();
            return;
        }
        
        updateThumbnailsFromStorage(programInfos, { force: !!force, onComplete });
    }

    /**
     * 番組リストをソート（統一関数を使用）
     */
    sortProgramsInContainer(container) {
        sortPrograms(container, this.options.programsSort);
    }

    /**
     * 番組数を表示
     */
    updateProgramCount(count) {
        const programCountElement = document.getElementById('program_count');
        if (programCountElement) {
            programCountElement.textContent = String(count);
        }
    }

    /**
     * active-point属性を更新してソートを実行
     * 番組詳細情報が取得された後に呼ばれる
     * @param {boolean} shouldSort - ソートを実行するかどうか（初回/サイドバーオープン/更新ボタン時のみtrue）
     */
    updateActivePointsAndSort(shouldSort = false) {
        const container = document.getElementById('liveProgramContainer');
        if (!container) return;

        const programInfos = getProgramInfosFromStorage();
        if (!programInfos || !Array.isArray(programInfos)) return;

        // 全ての番組要素のactive-pointを更新
        const programElements = container.querySelectorAll('.program_container');
        let hasUpdate = false;
        
        programElements.forEach((element) => {
            if (!element.id) return;
            
            const programId = `lv${element.id}`;
            const programInfo = programInfos.find((info) => info.id === programId);
            
            if (programInfo) {
                const newActivePoint = calculateActivePoint(programInfo);
                const currentActivePoint = parseFloat(element.getAttribute('active-point') || '0');
                
                // active-pointが更新される場合のみ更新
                if (Math.abs(newActivePoint - currentActivePoint) > 0.0001) {
                    element.setAttribute('active-point', String(newActivePoint));
                    hasUpdate = true;
                }
            }
        });

        // shouldSortがtrueで、active-pointが更新された場合のみソートを実行
        if (shouldSort && hasUpdate) {
            this.sortProgramsInContainer(container);
        }
    }
}

