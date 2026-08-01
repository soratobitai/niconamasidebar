export const notifyboxAPI = 'https://papi.live.nicovideo.jp/api/relive/notifybox.content.php';
// 番組詳細API。フォローAPIがライブサムネを返さない番組（配信者が固定画像を設定）だけに使い、
// liveScreenshotThumbnailUrls（ライブスクショ）を補完する。全番組には叩かない（＝旧方式の重さを避ける）。
export const liveInfoAPI = 'https://api.cas.nicovideo.jp/v1/services/live/programs';
export const watchPageBaseUrl = 'https://live.nicovideo.jp/watch/'; // ニコ生視聴ページのベースURL（末尾に lv 番号 or 数値ID）

// notifybox に一度に要求する件数（ページングは無い）。
//
// 🔴 **notifybox の本当の上限は分かっていない。** `rows` はこちらが投げるパラメータで、
//    初回コミットからずっと 100 が入っていたが、その根拠はどこにも記録されていない。
//    「100件を超える放送中」を作れないので実測もできない（doc/09 項目BF）。
//    そこで **上限を知らないまま両方に備える**: 要求は大きく出し、判定は下の2本立てで守る。
export const notifyboxRows = 500;
// 実績のある件数＝旧実装がずっと使っていた値。**ちょうどこの件数の応答は「頭打ち」を疑う。**
// サーバ側が 100 で頭打ちなら、あふれた時の応答は必ずちょうど 100 件になるため。
// ⚠️ **`>= notifyboxKnownCap` にしないこと。** 上限が本当に 500 だった場合、150件の応答が
//    150 >= 100 で引っかかり、**終了検知が常に止まる**。「ちょうど一致」で見ること。
//    （上限が 500 で、たまたま放送中がちょうど 100 件だった時だけ1周期空振りするが、実害は無い）
export const notifyboxKnownCap = 100;
// notifybox の取得に失敗したら、以後は実績のある件数に落として使い続ける。
// `rows=500` を受け付けないAPIだった場合、落とさないと notifybox が永久に死んで
// **新着検知が 20〜101秒 遅くなり、終了検知も効かなくなる**（しかもエラーは1回出るだけ）。
export const notifyboxRowsFallback = 100;

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

// 弾幕（少人数が大量に投稿していて、実際には盛り上がっていない番組）への補正。
//
// 🔴 **「弾幕かどうか」を判定して下げる方式にはしないこと。** 判定は必ず境界を持ち、
//    境界の両側で挙動が跳ぶ。ここでやるのは**全番組に同じ1本の式を通す**ことだけで、
//    弾幕でない番組は重みがほぼ 1 になるので式の上では何も起きない（doc/09 項目BE）。
//
//   r = コメント累計 / (来場者累計 + commentWeightViewerFloor)   … 1人あたり何コメントか
//   w = 1 / (1 + (r / commentWeightHalfRatio) ^ commentWeightSharpness)
//   勢い = Δ来場者 + w × Δコメント
//
// 減衰の引き金は**Δコメントの大きさではなく r（1人あたり）**である。だから来場者が多くて
// コメントも多い本物の人気番組は r が小さいままで、重みはほとんど減らない。
// w は 0 に漸近するだけで**ゼロにはならない**（コメントが完全に無視されることはない）。
//
// ⚠️ 下の3つは**実測前の暫定値**（2026-08-01）。弾幕番組が手元に無く分布を測れなかったため、
//    「普通の番組をなるべく触らない」側に倒してある。実機で数日使って調整すること。
//    調整の目安（r0=10 / γ=1.5 のときの w）:
//      r=1 → 0.96 ／ r=2 → 0.92 ／ r=4 → 0.80 ／ r=10 → 0.50 ／ r=30 → 0.16 ／ r=100 → 0.03
//    - 弾幕がまだ高すぎる → commentWeightHalfRatio を下げる（効き始めが早くなる）
//    - 普通の番組まで沈んだ → commentWeightHalfRatio を上げる、または Sharpness を上げる
//      （Sharpness を上げると「普通の範囲は触らず、極端なものだけ強く落とす」に寄る）
export const commentWeightHalfRatio = 10;   // r がこの値でコメントの重みが 0.5 になる
export const commentWeightSharpness = 1.5;  // 大きいほど「普通は素通し・極端だけ強く落とす」
// 若い番組・小さい番組は r が数件のコメントで暴れる（来場者3人・コメント15件で r=5 など）。
// 分母に下駄を履かせて、**データが少ないうちは自動的に「補正なし」側へ寄せる**（疑わしきは罰せず）。
export const commentWeightViewerFloor = 20;

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
