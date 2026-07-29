export const notifyboxAPI = 'https://papi.live.nicovideo.jp/api/relive/notifybox.content.php';
// 番組詳細API。フォローAPIがライブサムネを返さない番組（配信者が固定画像を設定）だけに使い、
// liveScreenshotThumbnailUrls（ライブスクショ）を補完する。全番組には叩かない（＝旧方式の重さを避ける）。
export const liveInfoAPI = 'https://api.cas.nicovideo.jp/v1/services/live/programs';
export const watchPageBaseUrl = 'https://live.nicovideo.jp/watch/'; // ニコ生視聴ページのベースURL（末尾に lv 番号 or 数値ID）

export const sidebarMinWidth = 180;
export const maxSaveProgramInfos = 200;
export const updateThumbnailInterval = 20; // 秒（サムネ<img>更新の基準間隔。番組ごと自己連鎖タイマーで更新完了後にこの時間を張る）
// 新番組のライブサムネ追撃(詳細API)を「放送開始からこの時間内の若い番組」だけに限定するゲート。
// これを過ぎても空＝ほぼ固定画像運用とみなし、各番組サイクルからの追撃は止める
// （以降はリスト更新スクレイプ fillMissingDetails の60〜180秒に委譲）。旧A1「8回打ち切り」の代替。
export const newProgramFastPollMs = 180000; // 3分

// サムネイル更新の安定化用
export const thumbnailTtlMs = 10000; // 成功後この時間は再取得しない（フリッカー抑制）
export const thumbnailRetryBaseMs = 2000; // エラー時の再試行ベース間隔
export const thumbnailRetryMaxMs = 60000; // エラー時の再試行最大間隔

// ローディングセッションのタイムアウト（ミリ秒）
export const loadingSessionTimeoutMs = 60000; // 60秒
// 手動更新が「サムネ反映の完了通知」を待つ上限。
// 反映は requestAnimationFrame 駆動なので、待っている間にタブが背景へ回ると tick が止まり
// onComplete が永久に来ない。上限が無いと isPerformingManualUpdate が立ちっぱなしになり、
// そのタブでは手動更新が二度と通らなくなる（doc/09 項目AC-1）。
// 実測の force 一斉更新は15秒級なので、それを十分に上回りつつ
// loadingSessionTimeoutMs(60秒)より手前で打ち切れる値にする。
export const manualThumbWaitMaxMs = 30000; // 30秒

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
