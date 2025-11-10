/**
 * エラー管理ユーティリティ
 * エラーの分類、ログ記録、リトライ戦略を提供
 */

// エラータイプ
export const ErrorType = {
    API: 'API',
    NETWORK: 'NETWORK',
    DOM: 'DOM',
    STORAGE: 'STORAGE',
    VALIDATION: 'VALIDATION',
    UNKNOWN: 'UNKNOWN'
}

// エラーレベル
export const ErrorLevel = {
    INFO: 'INFO',
    WARNING: 'WARNING',
    ERROR: 'ERROR',
    CRITICAL: 'CRITICAL'
}

/**
 * エラーマネージャークラス
 */
export class ErrorManager {
    constructor(options = {}) {
        this.enableLogging = options.enableLogging !== false // デフォルトで有効
        this.enableConsole = options.enableConsole !== false // コンソール出力
        this.maxLogSize = options.maxLogSize || 100 // 最大ログ数
        this.logs = []
        
        // 開発モードの判定
        this.isDevelopment = this._detectDevelopmentMode()
    }

    /**
     * 開発モードの検出
     */
    _detectDevelopmentMode() {
        try {
            // Chrome拡張機能のコンテキストを確認
            if (typeof chrome !== 'undefined' && chrome.runtime) {
                // 開発モード判定（必要に応じて拡張）
                return true // 開発時は常にtrue
            }
            // 通常のWebページの場合
            return location.hostname === 'localhost' || location.hostname === '127.0.0.1'
        } catch {
            return false
        }
    }

    /**
     * エラーを処理
     * @param {Error|any} error - エラーオブジェクトまたはエラーメッセージ
     * @param {Object} context - エラーのコンテキスト情報
     * @returns {Object} エラー情報
     */
    handle(error, context = {}) {
        const errorInfo = this._createErrorInfo(error, context)
        
        // ログに記録
        if (this.enableLogging) {
            this._logError(errorInfo)
        }

        // コンソール出力（開発モードまたは明示的に有効な場合）
        if (this.isDevelopment || this.enableConsole) {
            this._consoleLog(errorInfo)
        }

        return errorInfo
    }

    /**
     * エラー情報を作成
     */
    _createErrorInfo(error, context) {
        const timestamp = Date.now()
        const errorType = this._classifyError(error)
        const level = this._determineLevel(error, errorType)

        return {
            timestamp,
            type: errorType,
            level,
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            context: {
                ...context,
                userAgent: navigator.userAgent,
                url: location.href
            },
            error: error instanceof Error ? error : new Error(String(error))
        }
    }

    /**
     * エラーの分類
     */
    _classifyError(error) {
        if (!error) return ErrorType.UNKNOWN

        const errorMessage = error instanceof Error ? error.message : String(error)
        const errorName = error instanceof Error ? error.name : ''

        // ネットワークエラー
        if (errorMessage.includes('fetch') || 
            errorMessage.includes('network') || 
            errorMessage.includes('Failed to fetch') ||
            errorName === 'TypeError' && errorMessage.includes('fetch')) {
            return ErrorType.NETWORK
        }

        // APIエラー（ステータスコードなど）
        if (errorMessage.includes('status') || 
            errorMessage.includes('API') ||
            errorMessage.includes('404') ||
            errorMessage.includes('500')) {
            return ErrorType.API
        }

        // DOMエラー
        if (errorMessage.includes('DOM') ||
            errorMessage.includes('element') ||
            errorMessage.includes('querySelector')) {
            return ErrorType.DOM
        }

        // ストレージエラー
        if (errorMessage.includes('storage') ||
            errorMessage.includes('localStorage') ||
            errorMessage.includes('QuotaExceeded')) {
            return ErrorType.STORAGE
        }

        return ErrorType.UNKNOWN
    }

    /**
     * エラーレベルの決定
     */
    _determineLevel(error, type) {
        // ネットワークエラーは通常は警告レベル
        if (type === ErrorType.NETWORK) {
            return ErrorLevel.WARNING
        }

        // APIエラーも警告レベル（一時的な問題の可能性）
        if (type === ErrorType.API) {
            return ErrorLevel.WARNING
        }

        // DOMエラーやストレージエラーはエラーレベル
        if (type === ErrorType.DOM || type === ErrorType.STORAGE) {
            return ErrorLevel.ERROR
        }

        return ErrorLevel.ERROR
    }

    /**
     * エラーログに記録
     */
    _logError(errorInfo) {
        this.logs.push(errorInfo)
        
        // 最大サイズを超えた場合は古いものから削除
        if (this.logs.length > this.maxLogSize) {
            this.logs.shift()
        }
    }

    /**
     * コンソールに出力
     */
    _consoleLog(errorInfo) {
        const { type, level, message, context } = errorInfo
        const prefix = `[${type}] ${level}:`

        switch (level) {
            case ErrorLevel.CRITICAL:
            case ErrorLevel.ERROR:
                console.error(prefix, message, context)
                break
            case ErrorLevel.WARNING:
                console.warn(prefix, message, context)
                break
            default:
                console.info(prefix, message, context)
        }
    }

    /**
     * ログを取得
     * @param {number} limit - 取得する最大件数
     * @returns {Array} エラーログの配列
     */
    getLogs(limit = this.maxLogSize) {
        return this.logs.slice(-limit)
    }

    /**
     * ログをクリア
     */
    clearLogs() {
        this.logs = []
    }

    /**
     * リトライ可能なエラーかどうか判定
     * @param {Object} errorInfo - エラー情報
     * @returns {boolean}
     */
    isRetryable(errorInfo) {
        return errorInfo.type === ErrorType.NETWORK || 
               errorInfo.type === ErrorType.API
    }

    /**
     * リトライ間隔を計算（指数バックオフ）
     * @param {number} attempt - 試行回数（1から開始）
     * @param {number} baseDelay - 基本遅延（ミリ秒）
     * @param {number} maxDelay - 最大遅延（ミリ秒）
     * @returns {number} 遅延時間（ミリ秒）
     */
    calculateRetryDelay(attempt, baseDelay = 1000, maxDelay = 30000) {
        const delay = baseDelay * Math.pow(2, attempt - 1)
        return Math.min(delay, maxDelay)
    }
}

// グローバルエラーマネージャーインスタンス
const errorManager = new ErrorManager({
    enableLogging: true,
    enableConsole: true
})

/**
 * エラーハンドリングヘルパー関数
 */
export function handleError(error, context = {}) {
    return errorManager.handle(error, context)
}

