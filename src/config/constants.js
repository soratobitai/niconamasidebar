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
// 途中で増えた新着カードに配る「初回サムネ取得」までの分散窓。
// 🔴 **新着の初回は待たせないこと。** 初回期限を基準間隔ぶん後ろへ倒していたため、notifybox 先行で
// 立った新着カード（まだライブサムネURLを持たない）は、アイコンのまま **20〜40秒** 放置されていた。
// 追撃(_fetchLiveThumbIfPendingYoung)もサムネループの順番が来て初めて走るので、URLの取得ごと遅れる。
// 後ろへ倒す理由は「読み込み直後の force 一斉更新と衝突させない」ことなので、初回の一斉配布でない
// 限り待つ理由が無い（doc/09 項目BB）。同時取得だけは避けたいので、この窓の中へ分散させる。
export const newCardFirstThumbSpreadMs = 2000; // 2秒

// 一斉取得（読み込み直後・更新ボタン・タブ復帰・サイドバーを開いた時）の同時取得本数の上限。
// 🔴 **同時に投げるほど遅くなる。** 2026-08-01 実測（18カード・利用者環境）:
//   17本を同時に投げると 4本が1.6秒で着地し、**残り13本は15秒後にまとめて着地**した。
//   一方、ループが1本ずつ取る時は1本あたり 0.0〜0.1秒。総時間は同じでも、同時に投げると
//   **1枚目が出るまで15秒**かかり、その間に立った新着カードの取得も18本の後ろで待たされる
//   （実測: ループの取得1件が「取得=15.1s」＝一斉取得の列に並ばされていた）。
//   絞れば1枚目が1秒未満で出て、あとは順に埋まる（doc/09 項目BC）。
export const thumbnailFetchMaxParallel = 4;

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
// 自動移動が「番組終了を検知してから最新リストを待つ」上限。
// リスト取得の fetch にはタイムアウトが無く、応答が返らないと await が返らない。そこで宙吊りに
// なると selectingNext が true のまま残り、**以後そのページでは自動移動が二度と動かない**
// （doc/09 項目AU）。待つのは「より新しいリストで選びたい」からであって、待てないなら
// 今DOMにあるカードから選べばよいので、待ちは打ち切ってよい。
export const autoNextListWaitMaxMs = 15000; // 15秒
// 自動移動のカウントダウン。
// ⚠️ **残り秒数はこの値と現在時刻から毎回計算すること**（1秒ずつ引き算しない）。
// Chrome は5分以上隠れている無音タブのタイマーを1分に1回まで間引くため、引き算方式だと
// 10秒が最大10分に化ける。番組が終われば音も止まるので、まさに自動移動が効いてほしい場面で起きる。
// 期限で持てば、遅れても「次に目が覚めた1回」で遷移できる（doc/09 項目AX）。
export const autoNextCountdownMs = 10000; // 10秒

// 「盛り上がり」（人気順のスコア）の平滑化時定数。
// スコアは「直近の増分レート」だが、生の差分は使い物にならない: 2026-07-31 の実測で
// **30秒ウィンドウでは平均79%の番組が増分ゼロ**（ニコ生側の統計が約60秒粒度でしか更新されない）。
// そのまま並べると1周期あたり平均14.4位も順位が動く。指数移動平均で均すと τ=3分で1.1位まで落ちる
// （τ=1分→2.3位 / 5分→0.7位 / 8分→0.5位。大きいほど落ち着くが、盛り上がりに気付くのが遅れる）。
// 更新間隔（30〜180秒）が変わっても手触りが揃うよう、係数は α = 1 - exp(-Δt/τ) で時間から計算する。
export const momentumTauMs = 180000; // 3分

// 静止サムネの表示が「動くサムネへの給餌」の完了を待つ上限。
// 🔴 **表示を②（動くサムネ）に依存させないための上限であって、性能調整ではない。**
// ②は IndexedDB を触るため、別タブとの競合などで応答が返らないことがありうる。返らないと
// applySuccess が呼ばれず、**そのカードのサムネがページ再読込まで固まる**（doc/09 項目BA）。
// 間に合わなければURL表示へ倒す。②のコマ化は裏で続くので、次の周期で追いつく。
export const animIngestWaitMaxMs = 2000; // 2秒

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

// 定期更新で順位が入れ替わった時、カードをスライドさせる時間（ミリ秒）。
// 入れ替わり自体は FLIP の有無に関わらず起きており、これは「瞬間移動を目で追える形にする」ためのもの。
// 0 にすると実質アニメ無し（flipReorder 内の transition が 0ms になる）。
export const reorderFlipDurationMs = 300;
