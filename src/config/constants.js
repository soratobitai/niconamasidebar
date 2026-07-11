export const notifyboxAPI = 'https://papi.live.nicovideo.jp/api/relive/notifybox.content.php';
export const liveInfoAPI = 'https://api.cas.nicovideo.jp/v1/services/live/programs';

export const sidebarMinWidth = 180;
export const maxSaveProgramInfos = 200;
export const toDolistsInterval = 0.25; // 秒
export const updateThumbnailInterval = 20; // 秒

// サムネイル更新の安定化用
export const thumbnailTtlMs = 10000; // 成功後この時間は再取得しない（フリッカー抑制）
export const thumbnailRetryBaseMs = 2000; // エラー時の再試行ベース間隔
export const thumbnailRetryMaxMs = 60000; // エラー時の再試行最大間隔

// 番組詳細の再取得を間引くためのTTL（ミリ秒）
export const programInfoTtlMs = 60000;

// ローディングセッションのタイムアウト（ミリ秒）
export const loadingSessionTimeoutMs = 60000; // 60秒

// 長時間の非表示から復帰した時に「しっかり更新」（更新ボタン相当＝全詳細を再取得して整列）を
// 行う閾値（ミリ秒）。これより短い非表示からの復帰は軽量更新のまま。
export const visibilityFullRefreshMs = 60000; // 60秒

// 動くサムネ（ホバー中のみ）関連
export const animatedThumbnailFrameCount = 5;            // 保持する直近フレーム数（リングバッファ）
export const animatedThumbnailCaptureIntervalMs = 20000; // フレーム取得（重複排除）間隔（可視カードのみ）
export const animatedThumbnailPlayIntervalMs = 700;      // ホバー時の1コマ表示時間（ミリ秒）
// 動くサムネの永続化（IndexedDB）: リロード/番組移動をまたいでフレームを復元
// TTLは「最後に“異なる”フレームが出た時刻(updatedAt)」からの経過で判定。静止しがちな番組は
// フレームが更新されず updatedAt が古くなるため、短すぎると復元対象から外れてしまう。
// 静止番組の古フレームは現在と同一なので、長めに設定して復元を効かせる（30分）。
export const animatedThumbnailPersistTtlMs = 1800000;    // これより古い保存フレームは復元せず削除（30分）
export const animatedThumbnailPersistMaxEntries = 300;   // 保存する番組レコード数の上限（古い順に掃除）


