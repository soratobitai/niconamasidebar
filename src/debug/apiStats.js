/**
 * API呼び出し統計（開発・デバッグ用）
 * 本番環境でもAPI過負荷の検出に使用
 */

import { apiRateWindowMs } from '../config/constants.js'

/**
 * API呼び出しカウンターを初期化
 */
export function initApiStats() {
    // グローバルに設定してqueue.jsからもアクセス可能に
    window.apiCallCounter = {
        getLivePrograms: 0,
        fetchProgramInfo: 0,
        totalCalls: 0,
        startTime: Date.now(),
        recentTimestamps: []
    };
    
    // 定期的な監視を開始
    startApiMonitoring();
    
    // コンソールから手動確認できる関数を公開
    window.showApiStats = showApiStats;
    
    return window.apiCallCounter;
}

/**
 * API呼び出し統計を定期的に監視（5分ごと）
 * 異常な頻度の場合のみ警告
 */
function startApiMonitoring() {
    setInterval(() => {
        const apiCallCounter = window.apiCallCounter;
        if (!apiCallCounter) return;
        
        const elapsed = Math.floor((Date.now() - apiCallCounter.startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        
        // 過去1分間の実際の呼び出し頻度を計算
        if (!apiCallCounter.recentTimestamps) {
            apiCallCounter.recentTimestamps = [];
        }
        const now = Date.now();
        apiCallCounter.recentTimestamps = apiCallCounter.recentTimestamps.filter(t => now - t < apiRateWindowMs);
        const recentRate = apiCallCounter.recentTimestamps.length;
        
        // 異常な頻度の場合のみ警告（レート制限: 4件/秒 = 240件/分、警告閾値: 200件/分）
        if (recentRate > 200) {
            console.warn(`🚨 [API統計] 過去1分間の呼び出し頻度が高い: ${recentRate}回/分（レート制限: 240件/分に近づいています）`);
            console.warn(`   累積統計: getLivePrograms=${apiCallCounter.getLivePrograms}回, fetchProgramInfo=${apiCallCounter.fetchProgramInfo}回`);
        }
    }, 300000); // 5分ごと
}

/**
 * API呼び出し統計を表示（コンソールから手動で呼び出し可能）
 * 使い方: window.showApiStats()
 */
function showApiStats() {
    const apiCallCounter = window.apiCallCounter;
    if (!apiCallCounter) {
        console.warn('API統計が初期化されていません');
        return null;
    }
    
    const elapsed = ((Date.now() - apiCallCounter.startTime) / 1000).toFixed(0);
    const averageRate = (apiCallCounter.totalCalls / (elapsed / 60)).toFixed(2);
    
    // 過去1分間の実際の呼び出し頻度を計算
    if (!apiCallCounter.recentTimestamps) {
        apiCallCounter.recentTimestamps = [];
    }
    const now = Date.now();
    apiCallCounter.recentTimestamps = apiCallCounter.recentTimestamps.filter(t => now - t < apiRateWindowMs);
    const recentRate = apiCallCounter.recentTimestamps.length;
    
    console.log('=== API呼び出し統計 ===');
    console.log(`getLivePrograms: ${apiCallCounter.getLivePrograms}回`);
    console.log(`fetchProgramInfo: ${apiCallCounter.fetchProgramInfo}回`);
    console.log(`合計: ${apiCallCounter.totalCalls}回`);
    console.log(`経過時間: ${elapsed}秒 (${(elapsed / 60).toFixed(1)}分)`);
    console.log(`平均頻度: ${averageRate}回/分`);
    console.log(`過去1分間の実際の頻度: ${recentRate}回/分`);
    
    return apiCallCounter;
}

