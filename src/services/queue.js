import { fetchProgramInfo } from './api.js'
import { upsertProgramInfo as upsertProgramInfoFromStorage } from './storage.js'
import { handleError } from '../utils/error.js'

/**
 * 番組詳細情報取得キューを管理するクラス
 * バッチ処理とエラーハンドリングを提供
 */
export class ProgramInfoQueue {
    constructor(options = {}) {
        // キュー（Setを使用して重複を防止しつつ、配列で順序を保持）
        this.queueSet = new Set() // 重複チェック用
        this.queueArray = [] // FIFO順序保持用
        
        // 処理中かどうか
        this.isProcessing = false
        
        // 設定
        this.batchSize = options.batchSize || 3 // 一度に処理する件数（API負荷を考慮して3件に変更）
        this.processInterval = options.processInterval || 300 // 処理間隔（ミリ秒）
        this.idleTimeout = options.idleTimeout || 50 // requestIdleCallbackのタイムアウト
        this.maxSize = options.maxSize || 200 // 最大キューサイズ
        
        // レートリミッティング設定（APIへの配慮）
        // 1秒あたりの最大リクエスト数（元の実装: 0.3秒/件 = 約3.3件/秒を基準に）
        this.maxRequestsPerSecond = options.maxRequestsPerSecond || 4 // 安全マージンを含めて4件/秒
        this.requestTimestamps = [] // リクエスト実行時刻の記録（レートリミット計算用）
        
        // コールバック
        this.onProcessStart = options.onProcessStart || null
        this.onProcessComplete = options.onProcessComplete || null
        this.onProcessError = options.onProcessError || null
        this.onQueueEmpty = options.onQueueEmpty || null // キューが空になった時に呼ばれるコールバック
        
        // タイマー
        this.timer = null
        
        // ページの可視状態を取得する関数（オプション）
        this.getVisibilityState = options.getVisibilityState || null
    }

    /**
     * キューに追加
     * @param {number|string|Array<number|string>} ids - 番組ID（lvプレフィックスなし）
     */
    add(ids) {
        const idArray = Array.isArray(ids) ? ids : [ids]
        let addedCount = 0;
        let duplicateCount = 0;
        
        idArray.forEach(id => {
            const idStr = String(id)
            if (id != null && !this.queueSet.has(idStr)) {
                this.queueSet.add(idStr)
                this.queueArray.push(idStr)
                addedCount++;
                
                // 最大サイズを超えた場合、古いものから削除
                while (this.queueArray.length > this.maxSize) {
                    const oldest = this.queueArray.shift()
                    this.queueSet.delete(oldest)
                }
            } else {
                duplicateCount++;
            }
        })
        
        // 異常検出：一度に50件以上追加された場合のみ警告
        if (addedCount >= 50) {
            console.warn(`⚠️ [キュー] 一度に${addedCount}件追加されました (キューサイズ: ${this.queueArray.length})`);
        }
    }

    /**
     * キューから削除
     * @param {number|string} id - 番組ID
     */
    remove(id) {
        const idStr = String(id)
        if (this.queueSet.has(idStr)) {
            this.queueSet.delete(idStr)
            const index = this.queueArray.indexOf(idStr)
            if (index !== -1) {
                this.queueArray.splice(index, 1)
            }
        }
    }

    /**
     * キューのサイズ
     * @returns {number}
     */
    size() {
        return this.queueArray.length
    }

    /**
     * キューをクリア
     */
    clear() {
        this.queueSet.clear()
        this.queueArray = []
    }

    /**
     * キューに含まれているか
     * @param {number|string} id - 番組ID
     * @returns {boolean}
     */
    has(id) {
        return this.queueSet.has(String(id))
    }

    /**
     * レートリミットチェック
     * @returns {boolean} リクエストを実行してよいかどうか
     */
    _checkRateLimit() {
        const now = Date.now()
        const oneSecondAgo = now - 1000
        
        // 1秒以上前の記録を削除
        this.requestTimestamps = this.requestTimestamps.filter(ts => ts > oneSecondAgo)
        
        // 1秒以内のリクエスト数が上限を超えている場合は待機
        return this.requestTimestamps.length < this.maxRequestsPerSecond
    }

    /**
     * リクエスト実行時刻を記録
     */
    _recordRequest() {
        const now = Date.now()
        this.requestTimestamps.push(now)
    }

    /**
     * バッチ処理を実行（レートリミットを考慮）
     * @param {number} batchSize - 処理する件数
     * @returns {Promise<void>}
     */
    async processBatch(batchSize = this.batchSize) {
        // キューが空の場合のコールバック実行（早期リターン前にチェック）
        if (this.queueArray.length === 0) {
            if (this.onQueueEmpty) {
                this.onQueueEmpty()
            }
            return
        }
        
        if (this.isProcessing) {
            return
        }

        // レートリミットチェック
        if (!this._checkRateLimit()) {
            // リクエスト頻度が上限に達している場合は次回に延期
            // この時点でキューが空の可能性があるが、次回のprocessBatch呼び出し時にチェックされる
            return
        }

        this.isProcessing = true
        
        // ローディング追跡（外部から関数が提供されている場合のみ）
        // 初期表示時や手動更新時など、updateSidebar()が呼ばれた直後にキュー処理が開始される場合を追跡
        if (this.onProcessStart) {
            this.onProcessStart()
        }

        try {
            // レートリミットを考慮して、実際に処理する件数を決定
            const remainingQuota = this.maxRequestsPerSecond - this.requestTimestamps.length
            const actualBatchSize = Math.min(batchSize, remainingQuota, this.queueArray.length)

            if (actualBatchSize === 0) {
                this.isProcessing = false
                // キューが空の場合のコールバック実行
                if (this.queueArray.length === 0 && this.onQueueEmpty) {
                    this.onQueueEmpty()
                }
                return
            }

            // キューから指定件数取り出す（FIFO順）
            const idsToProcess = this.queueArray.slice(0, actualBatchSize)

            // レートリミットを考慮した逐次処理（並列ではなく順次実行）
            // これにより、1秒あたりのリクエスト数を確実に制御
            const results = []
            const processedIds = [] // 実際に処理したIDを記録
            
            for (const id of idsToProcess) {
                // 次のリクエストを実行する前にレートリミットをチェック
                if (!this._checkRateLimit()) {
                    // レートリミットに達した場合、残りを次回に延期
                    break
                }

                this._recordRequest()
                processedIds.push(id)
                const result = await this.fetchAndSave(id).then(
                    value => ({ status: 'fulfilled', value }),
                    reason => ({ status: 'rejected', reason })
                )
                results.push(result)

                // 各リクエストの間に小さな間隔を入れる（API負荷軽減）
                // 1秒間にmaxRequestsPerSecond件なので、間隔は 1000/maxRequestsPerSecond
                const delayBetweenRequests = 1000 / this.maxRequestsPerSecond
                const currentIndex = processedIds.length - 1
                if (currentIndex < idsToProcess.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, delayBetweenRequests))
                }
            }

            // 処理結果に応じてキューから削除
            results.forEach((result, index) => {
                const id = processedIds[index]
                if (result.status === 'fulfilled') {
                    // 成功した場合も失敗した場合もキューから削除
                    // 失敗の理由：404エラー（番組が見つからない）、ユーザー配信でスクリーンショットURLがない、など
                    // これらは再試行しても成功しないため、キューから削除して次に進む
                    this.remove(id)
                } else if (result.status === 'rejected') {
                    // ネットワークエラーなどの予期しないエラーもキューから削除
                    // 無限ループを防ぐため、エラーログだけ記録してキューから削除
                    handleError(result.reason, { function: 'processBatch', queueId: id })
                    if (this.onProcessError) {
                        this.onProcessError(id, result.reason)
                    }
                    this.remove(id)
                }
            })

            // コールバック実行
            if (this.onProcessComplete) {
                this.onProcessComplete(processedIds.length, results)
            }
            
            // キューが空になった場合のコールバック実行
            if (this.queueArray.length === 0 && this.onQueueEmpty) {
                this.onQueueEmpty()
            }

        } catch (error) {
            // 予期しないエラー
            handleError(error, { function: 'processBatch', unexpected: true })
            if (this.onProcessError) {
                this.onProcessError(null, error)
            }
        } finally {
            this.isProcessing = false
            // エラーが発生した場合でも、キューが空になった場合はコールバックを実行
            if (this.queueArray.length === 0 && this.onQueueEmpty) {
                this.onQueueEmpty()
            }
        }
    }

    /**
     * 番組情報を取得して保存
     * @param {string} liveId - 番組ID
     * @returns {Promise<boolean>} 成功したかどうか
     */
    async fetchAndSave(liveId) {
        // API呼び出しカウンターをインクリメント（グローバルに追跡）
        if (typeof window !== 'undefined' && window.apiCallCounter) {
            window.apiCallCounter.fetchProgramInfo = (window.apiCallCounter.fetchProgramInfo || 0) + 1;
            window.apiCallCounter.totalCalls++;
        }
        
        try {
            const data = await fetchProgramInfo(liveId)
            
            if (!data) return false

            // ユーザー配信でスクリーンショットURLがない場合はスキップ
            if (data.providerType === 'user' && !data.liveScreenshotThumbnailUrls) {
                return false
            }

            upsertProgramInfoFromStorage(data)
            return true
        } catch (error) {
            handleError(error, { function: 'fetchAndSave', liveId })
            return false
        }
    }

    /**
     * 定期的な処理を開始
     */
    start() {
        this.stop() // 既存のタイマーを停止

        const processLoop = () => {
            // バックグラウンドタブではrequestIdleCallbackを使用しない
            // Chromeの最近の更新により、バックグラウンドタブではrequestIdleCallbackが実行されないため
            const isVisible = this.getVisibilityState ? this.getVisibilityState() : (!document.hidden)
            
            if (isVisible && typeof requestIdleCallback !== 'undefined') {
                // フォアグラウンドタブの場合のみrequestIdleCallbackを使用
                requestIdleCallback(
                        () => {
                            this.processBatch().then(() => {
                                // 次の処理をスケジュール
                                if (this.queueArray.length > 0) {
                                    this.timer = setTimeout(processLoop, this.processInterval)
                                } else {
                                    // キューが空になったら少し長めの間隔でチェック
                                    this.timer = setTimeout(processLoop, this.processInterval * 3)
                                }
                            })
                        },
                    { timeout: this.idleTimeout }
                )
            } else {
                // バックグラウンドタブまたはrequestIdleCallbackが使えない場合は通常のsetTimeout
                // バックグラウンドタブでは間隔を延長してリソース消費を抑える
                const interval = isVisible ? this.processInterval : this.processInterval * 10
                this.processBatch().then(() => {
                    if (this.queueArray.length > 0) {
                        this.timer = setTimeout(processLoop, interval)
                    } else {
                        // キューが空になったらさらに長めの間隔でチェック
                        this.timer = setTimeout(processLoop, interval * 3)
                    }
                })
            }
        }

        // 最初の処理を開始
        this.timer = setTimeout(processLoop, this.processInterval)
    }

    /**
     * 定期的な処理を停止
     */
    stop() {
        if (this.timer) {
            clearTimeout(this.timer)
            this.timer = null
        }
    }

    /**
     * 即座に処理を実行（手動実行用）
     */
    async processNow() {
        await this.processBatch(this.batchSize)
    }
}

