export const notifyboxAPI = 'https://papi.live.nicovideo.jp/api/relive/notifybox.content.php';
export const liveInfoAPI = 'https://api.cas.nicovideo.jp/v1/services/live/programs';

export const sidebarMinWidth = 180;
export const maxSaveProgramInfos = 200;
export const updateThumbnailInterval = 20; // 秒
export const toDolistsInterval = 0.3; // 秒
export const liveStatusPollInterval = 5; // 秒

// サムネイル更新の安定化用
export const thumbnailTtlMs = 10000; // 成功後この時間は再取得しない（フリッカー抑制）
export const thumbnailRetryBaseMs = 2000; // エラー時の再試行ベース間隔
export const thumbnailRetryMaxMs = 60000; // エラー時の再試行最大間隔

// 番組詳細の再取得を間引くためのTTL（ミリ秒）
export const programInfoTtlMs = 60000;


