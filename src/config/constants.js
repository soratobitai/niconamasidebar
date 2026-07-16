export const notifyboxAPI = 'https://papi.live.nicovideo.jp/api/relive/notifybox.content.php';
export const liveInfoAPI = 'https://api.cas.nicovideo.jp/v1/services/live/programs';
export const watchPageBaseUrl = 'https://live.nicovideo.jp/watch/'; // ニコ生視聴ページのベースURL（末尾に lv 番号 or 数値ID）

export const sidebarMinWidth = 180;
export const maxSaveProgramInfos = 200;
export const toDolistsInterval = 0.25; // 秒
export const updateThumbnailInterval = 20; // 秒

// 新番組先行検知（新しく始まった番組を、通常のリスト更新 updateProgramsInterval[既定120秒] を
// 待たずに早く列へ載せる）。開いている×可視のときのみ稼働。
export const newProgramScanIntervalMs = 30000; // 先行検知スキャン周期（notifybox軽量ポーリング）
// ライブサムネURL未生成（放送開始直後は liveScreenshotThumbnailUrls がまだ空のことがある）対応。
// その番組は fetchAndSave が「保存せず false」を返すため詳細が localStorage に載らない。
// partial は保存しない（保存すると _fetchedAt が付き TTL[programInfoTtlMs] で再取得が止まる）まま、
// 番組ごとにバックオフで「詳細だけ」再取得し、用意でき次第すぐ描画する。
export const newProgramNotReadyBaseMs = 3000;      // 未生成リトライの初期遅延
export const newProgramNotReadyMaxDelayMs = 30000; // バックオフ上限（×2で増加。3→6→12→24→30…）
export const newProgramNotReadyMaxAttempts = 6;    // 諦め回数（超えたら通常120秒サイクルへ委譲）
export const newProgramNotReadyMaxTotalMs = 90000; // 諦め総経過（firstSeenAtから。回数と併用）

// 【実験】フォロー中ページ・スクレイプ方式の取得間隔（followPage時のサイドバー更新ループ周期）。
// 1リクエスト(~160ms)で リスト＋視聴者数/コメント＋ライブサムネURL＋新番組検知 を全部兼ねるため、
// この1本のループが notifybox(120s)＋NewProgramWatcher(30s)＋詳細API×N＋サムネ20秒ループ を置換する。
// 20秒はニコ生サムネ更新の下限（[[nicolive-thumbnail-update-cadence]] / doc09）に一致。延ばさないこと
// （リスト鮮度・視聴者数・サムネ・動くサムネ②のフレーム蓄積 の4役を同時に担う“動かせない”間隔）。
export const scrapeIntervalMs = 20000;

// サムネイル更新の安定化用
export const thumbnailTtlMs = 10000; // 成功後この時間は再取得しない（フリッカー抑制）
export const thumbnailRetryBaseMs = 2000; // エラー時の再試行ベース間隔
export const thumbnailRetryMaxMs = 60000; // エラー時の再試行最大間隔

// 番組詳細の再取得を間引くためのTTL（ミリ秒）
export const programInfoTtlMs = 60000;

// ローディングセッションのタイムアウト（ミリ秒）
export const loadingSessionTimeoutMs = 60000; // 60秒

// API呼び出し頻度の集計窓（ミリ秒）。直近この時間内の呼び出し回数で過負荷を検出する
export const apiRateWindowMs = 60000; // 直近1分

// 長時間の非表示から復帰した時に「しっかり更新」（更新ボタン相当＝全詳細を再取得して整列）を
// 行う閾値（ミリ秒）。これより短い非表示からの復帰は軽量更新のまま。
export const visibilityFullRefreshMs = 60000; // 60秒

// 動くサムネ（ホバー中のみ）関連
export const animatedThumbnailFrameCount = 5;            // 保持する直近フレーム数（リングバッファ）
export const animatedThumbnailCaptureIntervalMs = 20000; // 定期メンテ(消えた番組のバッファ解放)周期。フレーム取得は①給餌へ一本化済み
export const animatedThumbnailPlayIntervalMs = 700;      // ホバー時の1コマ表示時間（ミリ秒）
// 動くサムネの永続化（IndexedDB）: リロード/番組移動をまたいでフレームを復元
// TTLは「最後に“異なる”フレームが出た時刻(updatedAt)」からの経過で判定。静止しがちな番組は
// フレームが更新されず updatedAt が古くなるため、短すぎると復元対象から外れてしまう。
// 静止番組の古フレームは現在と同一なので、長めに設定して復元を効かせる（30分）。
export const animatedThumbnailPersistTtlMs = 1800000;    // これより古い保存フレームは復元せず削除（30分）
export const animatedThumbnailPersistMaxEntries = 300;   // 保存する番組レコード数の上限（古い順に掃除）


