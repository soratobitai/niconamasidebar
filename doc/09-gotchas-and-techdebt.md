# 09. 技術的負債・潜在バグ・改修時の注意

コード精読とワークフロー横断分析で確認した「非自明な事実・落とし穴・負債」の一覧。
**改修前・バグ調査前に必読**。

> **2026-07-11 更新**: 下記 A〜E, J, L を修正済み（独立エージェントによる敵対的レビューで回帰なしを確認、`npm run build` 成功）。
> 詳細な差分は `git log`／各ファイル参照。未対応項目（設計判断・情報）は後半にまとめた。
>
> **2026-07-18 更新（データ取得のリファクタ）**: 番組**詳細**の取得を「1番組=詳細API×N＋レート制限キュー」から
> 「フォロー中ページの公開フロントJSON API(`front/api/pages/follow/v1/programs?status=onair`)を1回叩いて全件一括取得」へ置換。詳細がリストと同時に揃うため、
> **整列確定機構（settling）・独立詳細TTL・詳細キュー・新番組先行検知(`NewProgramWatcher`)・API監視(`apiStats`)を全廃**。
> それに伴い旧項目 D/E/N/S(一部)/T と項目K・O・Qの当該記述を削除／書き換えた。
> 削除ファイル: `src/services/queue.js`・`src/managers/NewProgramWatcher.js`・`src/debug/apiStats.js`。
>
> **2026-07-18 追補（フォローAPIのページング実装＋サムネ選択補完）**: 当初は SSR埋め込みデータのスクレイプ（`DOMParser`）で
> **1ページ目のみ**を読む実装だったが、その後**公開フロントJSON APIのページング**（`offset` を進めて `total` まで取り切る）を実装。
> 旧・下記 U（ページング未実装・70件超タイトルのみ）を**解決済み**へ書き換え。加えて JSON APIのサムネ枠は1つ（`listingThumbnail`）だけで
> 固定画像配信者はライブサムネが取れないため、**その番組だけ詳細API(`fetchProgramInfo`)で選択的補完**する仕組みを追加（項目 N・V を更新）。
> `fetchProgramInfo`／`constants.liveInfoAPI` はこの補完専用として復活・存置。
> 削除された関数: `extractFollowItemsFromHtml`・`mapFollowItemToProgramInfo`・`pickLiveThumbnail`・`followPageUrl`・`window.__probeFollowPaging`（SSRスクレイプ経路ごと廃止）。
>
> **2026-07-23 更新（動くサムネ 稀バグの根本原因を修正）**: 実機報告の「稀に途中停止」「稀に最新が含まれない」を
> 46エージェントのワークフロー（多角トレース→敵対的検証）で根本原因特定し修正（`npm run build` 成功）。下記 X・Y を追加。
> 多くの候補（replaceChildren時のmouseout誤発火・decodeハング・eviction例外・USER重複排除誤破棄・hydrate競合等）は
> 「replaceChildrenは同期＋ノード再利用」「animGen無効化」「playUrlAtのフォールバック」等で**不成立と確認**して除外済み。
>
> **2026-07-23 更新（サムネ更新を番組ごと自己連鎖タイマー＋自然ドリフトへ）**: 「全番組一斉更新」＋別建てA1バッチを、
> 番組ごとの独立・自己連鎖タイマー（更新完了→20秒→また更新／作業時間ぶん自然にドリフト）へ置換。A1は各サイクルへ統合し
> beginAt が若い番組だけ追撃、全件同時更新は撤去。敵対的レビュー（28→3エージェント）でゴースト連鎖・lost update 等の
> 並行バグを検出・修正（`npm run build` 成功）。下記 **Z** を追加。削除: `_retryPendingLiveThumbnails`・`THUMB_RETRY_MAX_ATTEMPTS`・`THUMB_RETRY_MAX_PER_CYCLE`。

---

# ✅ 修正済み（2026-07-11）

## ✅ A. 自動移動の `updateSidebar` がIIFEで未解決だった（🔴→修正済み）
- **旧問題**: `AutoNextManager.startWatcher()` が `typeof updateSidebar === 'function'` で `main.js` のモジュールローカル関数をグローバル参照しようとしていた。IIFEバンドルでは未解決（`typeof` は `'undefined'` を返す）で、かつ `startWatcher()` は引数なし呼び出しだったため、**番組終了時にサイドバーの再取得が一切走らず**、古い先頭番組へ遷移していた。
- **修正**: `main.js` の `startLiveStatusWatcher()` が `autoNextManager.startWatcher(updateSidebar)` と**更新関数を注入**。`AutoNextManager` 側は `typeof updateSidebarFn === 'function'` で注入関数のみを使用するよう変更。これで終了検知時に最新リストを取得してから次番組を選定するようになった。
- 対象: `src/main.js`, `src/managers/AutoNextManager.js`

## ✅ B. サムネイルの `<img>` error フォールバックが未配線だった（🔴→修正済み）
- **旧問題**: `handleThumbnailError`（data-src→loading.gif フォールバック）を配線する `attachThumbnailErrorHandlers` が**どこからも呼ばれておらず**、画像ロード失敗時の救済が発動しなかった。
- **修正**: `makeProgramElement` 内で生成する `thumbnailImg` に `addEventListener('error', handleThumbnailError)` を**直接配線**。全カードにフォールバックが効くようになった。冗長になった `attachThumbnailErrorHandlers`（未使用export）は削除。
- 対象: `src/render/sidebar.js`

## ✅ C. `setHandler('reloadBtn', ...)` が no-op だった（🟡→修正済み）
- **旧問題**: `AppState.handlers` が `{ onResize }` のみ宣言で、`setHandler` の `if (name in this.handlers)` ガードにより `'reloadBtn'` がセットされず、更新ボタンの「既存リスナ削除→追加」ロジックが機能しなかった。
- **修正**: `AppState.handlers` に `reloadBtn: null` を宣言追加。リスナ重複防止ロジックが実効化。
- 対象: `src/core/AppState.js`

## ✅ D. `clearTimer('queueRestart')` が no-op（デッドコード）だった（🟡→修正済み）
- **旧問題**: `queueRestart` は `AppState.timers` に存在しないキーで、セット箇所も無く、`stopAllTimers()` の該当行は常に no-op。
- **修正**: `stopAllTimers()` から当該行を削除。
- 対象: `src/main.js`

## ✅ E. `programInfoTtlMs`（詳細TTLキャッシュ）→ **リファクタで撤去**（🟢→撤去済み・2026-07-18）
- **経緯**: 2026-07-11 に `programInfoTtlMs`(60秒) を「直近60秒以内に取得済みの詳細はキュー追加をスキップ」するTTLキャッシュとして実装していた。
- **現状(2026-07-18)**: 詳細取得をフォローAPIの一括取得（通常1リクエスト）に置換したため、詳細キューも独立TTLも不要になり、`programInfoTtlMs` 定数・TTL判定ロジックともに**削除**。詳細は毎周期フォローAPIで全件フル上書きされる。
- 補足: `upsertProgramInfos` が付与する `_fetchedAt` は残っているが、もはや詳細の再取得スキップ判定には使われていない（保存時刻メタとして残置）。サムネ更新の `thumbnailTtlMs`・動くサムネの永続TTLは別機構で健在。
- 対象: `src/services/storage.js`, `src/managers/UpdateManager.js`, `src/config/constants.js`, `src/services/followPageSource.js`

## ✅ J. `calculateActivePoint` の誤った `@deprecated` を修正（🟢→修正済み）
- **旧問題**: JSDoc に `@deprecated` とあるが、実際はソート・active-point算出で現役使用。
- **修正**: 実態に沿った説明（人気度スコア算出の現役関数）へ書き換え。
- 対象: `src/render/sidebar.js`

## ✅ L. バージョンの二重管理を解消（🟢→修正済み）
- **旧問題**: `manifest.json`=1.7.0 に対し `package.json`=1.5.5 で乖離。
- **修正**: `package.json` を 1.7.0 に同期。以後リリース時は両者を揃える運用推奨。
- 対象: `package.json`

---

# ⏳ 未対応（設計判断・情報 / 今回は変更せず）

以下は「明確なバグ」ではなく、設計上の選択・大きめのリファクタ・情報のため、今回は据え置いた項目。改修時の参考に。

## 🟡 G. フラジャイルなニコ生DOM依存（仕様変更で壊れる筆頭）
- `setElems`/`layout.js`/`status.js` がハッシュ付きクラスを `[class*="..."]` の**部分一致**で掴む。`adjustWatchPageChild` はマジックナンバー（1024/1152/1500/1792, `innerHeight*1.777778` 等）に依存。
- ニコ生の視聴ページ改修で**レイアウト崩れ・自動移動不発**が起きやすい。UI更新時はここを最初に疑う。恒久対策はセレクタの constants 化・defensive 化。
- ✅ 2026-07-11 修正: `setProgramContainerWidth` がサムネに `programContainerWidth + 'px'`（例 `'50%px'`）という**無効値**を代入していたデッドコード（バグ）を削除。サムネ幅は CSS の `.program_thumbnail { width:100% }` でカード幅いっぱいになるため**見た目は不変**（有効値 `'50%'` にするとサムネがカードの半分に縮む回帰になるため削除を選択）。

## 🟢 H. 本番でも console 出力が有効
- `utils/error.js` `_detectDevelopmentMode()` は `chrome.runtime` があれば常に `true`。本番でも警告/エラーがコンソールに出続ける。監視目的で意図的な可能性があり、今回は変更せず。抑制したい場合は判定を厳密化。

## 🟢 I. `AppState` のデッドフィールド / レガシー
- ✅ 2026-07-11 整理で `queues.programInfo`（実キューは別クラス）・`loading.operations`＋`startLoading()/finishLoading()`（ローディング判定は `updateSession` ベースに一本化済み）・`getObserver()`（未使用）を削除。
- 残置: `observers.thumbnail`（実体は sidebar.js のモジュール変数）は未使用/レガシーだが害はないため残置。

## 🟢 K. リスナ/タイマーのライフサイクル非対称
- `#optionForm` change、各ボタン click、`document` 全体 click（resize強制）などは cleanup で明示解除されない。単一ページ寿命では問題になりにくい。SPA的な再setup対応や厳密なリーク対策をするなら要整理。
- ※ 旧記載の `apiStats` の5分 setInterval はAPI監視ごと撤去済み（2026-07-18）。

## 🟢 M. `getOptions` の副作用（get が set する）
- 取得ついでにマージ結果を書き戻す（初回に既定値を永続化する意図）。「読むだけ」で呼ぶと storage 書き込みが走る点に注意。

## 🟢 N. データ取得の credentials（リスト・フォローAPIとも `include`／詳細APIのみ Cookie なし）
- 番組リストの notifybox（`fetchLivePrograms`）も、詳細のフォロー中フロントAPI（`fetchFollowedProgramsViaPage`）も `credentials:'include'` で取得する。両方ともログイン Cookie 依存（未ログインだとリスト失敗／フォローAPIは放送中番組ゼロ）。
- 例外: サムネ補完用の**詳細API `fetchProgramInfo`**（`liveInfoAPI = api.cas.nicovideo.jp/.../lv{id}`）は `credentials` 指定なし＝**Cookie を送らない**。公開情報のライブスクショURLだけを拾う用途で、固定画像配信者などライブサムネ欠落番組の補完に**選択的にのみ**呼ばれる（項目V参照）。
- `api.js` は `fetchLivePrograms`（notifyboxリスト）と `fetchProgramInfo`（詳細・サムネ補完専用）の**両方**を export する。

## 🟢 O. 「開いた瞬間の描画」と「定期タイマー初回」は別物
- 常設ループ（`_sidebarTick`）が実際に取得するのも、開いてから `updateProgramsInterval`（既定120秒）後が最初。開いた直後の即描画は `performManualUpdate` が担う（初回ロード・更新ボタン・タブ復帰・再オープン共通）。二層構造を混同しないこと。

## 🟢 P. `options` オブジェクトの参照整合（現状はOK）
- 現状は `onChanged` が in-place 更新するため整合が取れている。**以後 `options` を再代入しないこと**（Manager 側の参照とズレる）。

## 🟢 Q. コード整理（2026-07-11 実施ぶん / 残りの候補）
- ✅ **実施済み（デッドコード削除・敵対的検証済み）**: 旧オプションポップアップ由来の未使用CSS（`#optionContainer p/ul/li/.flex/.setbox/.inputbox/label/input[type=text]/a`・`.sidebar_display_none`）、未使用CSS変数（`--sb-popup-bg/-fg/-heading`）、未使用の委譲ラッパー関数（`ensure/showAutoNextModal`・`scheduleAutoNextNavigation`・`performInitialLoad`/`updateThumbnail`/`updateProgramCount`/`updateLoadingState`/`finishLoadingSessionWithMinDuration`）、`AppState` レガシー（`queues`・`loading.operations`・`startLoading/finishLoading`・`getObserver`）、`UpdateManager.stopAllTimers`（未使用。main.js 版が実体）、未使用 export の内部化（`ErrorType/ErrorLevel/ErrorManager`・`setProgramInfos`）、未使用 import/引数/デッド変数（main.js の `saveOptionsToStorage`・`computeNext` の `parentId`・`getLivePrograms` の `callId`）、空 no-op コールバック（`onProcessStart`/`onQueueEmpty`）。
- ✅ **実施済み②（低〜中リスクのリファクタ・挙動等価を敵対的検証済み）**:
  - `watch/` 視聴ページURLを `constants.watchPageBaseUrl` に定数化（`sidebar.makeProgramElement`・`UpdateManager` の計3箇所）。
  - ライブサムネのベースURL選定を純関数 `sidebar.resolveLiveThumbnailBaseUrl(info)` に集約し `sidebar.computeNext`・`animatedThumbnail.getScreenshotUrl` で共用（`makeProgramElement` は初期src用に `?cache` 付与・`||''` フォールバック等の固有ロジックがあるため据え置き）。
  - AutoNext のカウントダウンタイマー後始末を `AutoNextManager._clearAutoNextTimer()` に集約（開始/キャンセル/interval×2/stopWatcher の5箇所）。
- ✅ **実施済み③（低リスク整理・挙動等価を敵対的検証済み）**:
  - API呼び出し頻度フィルタの窓 `60000` を `constants.apiRateWindowMs` に定数化（`apiStats`×2・`UpdateManager`×1）。
  - `setProgramContainerWidth` の8連ifを、ブレークポイント配列 `columnBreakpoints=[300,500,700,900,1100,1300,1500]` を走査するループに置換（全境界値で挙動等価を確認）。
- ⏭ **残りの整理候補（未実施。低価値/高リスクのため保留）**:
  - `layout.js` の `adjustWatchPageChild` のレイアウト定数（`1024`/`1.777778`/`220.44444` 等）ベタ書き（項目G）→ 名前付き定数化（値の意味が不透明でドメイン知識が要るため保留）。
  - `updateSidebar` 内の `getElementById('liveProgramContainer')` 複数回取得 → 1回に集約（低価値・delicateな関数のため保留）。
- ✅ **2026-07-18 のリファクタで同時に解消**: `apiCallCounter` 初期化の二系統（`apiStats`＋`UpdateManager`）は API監視ごと撤去。`performInitialLoad`／`performManualUpdate(settle=true)` の類似シーケンス問題も、settling機構ごと撤去され `performManualUpdate` 一本に統合されたため消滅。

## 🟢 R. サイドバー開閉時の列数パタつき（✅ 2026-07-11 修正）
- 症状: 開閉の一瞬、番組サムネが巨大化しレイアウトが崩れて見えた。
- 原因: `#sidebar` は幅を 0⇔実幅 に 0.5s の CSS transition でアニメする。列数計算 `setProgramContainerWidth`（幅が小さいほど列数少＝カード幅%大）が**アニメ途中の `#sidebar.offsetWidth`** で呼ばれ、序盤（幅<300）に1列＝カード100%になる一方、`#sidebar_container` は開いた瞬間に目標幅(例360px)固定なので**カードが360px＝巨大サムネ**化→完了時に多列へスナップしていた。`resizeObserver_sidebar` が `#sidebar` を監視しアニメ中毎フレーム発火するのが主な発火源。`UpdateManager.updateSidebar` のリスト再描画も同じ `offsetWidth` を使っていた。
- 修正: 列数計算の幅ソースを**「意図した幅」**に統一。`main.js` の各所（RO/onResize/トグルrAF/初期open・close）は `state.sidebarWidth.value`、`UpdateManager.updateSidebar` は `this.appState.sidebar.width` を使用。アニメ途中幅では列数を変えず、閉じていても「開き幅基準」で列を確定させておく。ドラッグ時は `onMouseMove` が `sidebarWidth.value` を即時更新するので列数のライブ追従は維持。
- 既知の残ギャップ（別件・低）: cross-tab の `sidebarWidth` 変更は `state.sidebarWidth.value`・DOM幅ともに未反映（`onChanged` が幅を再適用しない既存仕様）。単一タブ運用では問題なし。

## 🟢 S. `getLivePrograms()`／`updateSidebar` 過剰呼び出し（✅ 2026-07-11 修正・スロットル/ガードは現役）
- 症状: `updateSidebar`（=`getLivePrograms`＋フォローAPI取得）が想定（初回＋更新間隔ごと）を超えて何度も走る。※ かつては `apiStats` が「1分に10回」警告を出していたが、API監視は撤去済み（2026-07-18）。以下の**再発防止ガードは現在も有効**なので、更新が過剰に走ると感じたらここを疑う。
- 原因は3つの既存バグ（当時、直近改修とは無関係と調査で確定）:
  - **① 自動次番組の暴走ループ（最悪）**: `autoNextProgram='on'` かつ番組終了ガイド表示中、`status.js` の MutationObserver がデバウンス無しで毎変異 `onEnded→updateSidebar→getLivePrograms`。`updateSidebar` の `replaceChildren` が body に変異を撒くため自己駆動ループ（次番組リンク未発見の間 `scheduled` が立たず永久）。
  - **② 開閉の二重発火**: 開閉ボタン1クリックで `handleSidebarOpenStateChange` が2回（直接呼び＋`setIsOpenSidebar`→`chrome.storage.onChanged` が自タブでも発火）→ 開くたび getLivePrograms 2回。
  - **③ `performManualUpdate` の多重防止ガード欠如**（①②の増幅器）。
- 修正:
  - ①→ `observeProgramEnd` に**20秒スロットル＋再武装**（`PROGRAM_END_RECHECK_MIN_INTERVAL_MS`）。終了ガイド出現で即1回発火、以降は20秒間隔でのみ再チェック、ガイド消滅で再武装。次番組ジャンプの本来動作は維持。
  - ②→ `main.js` の `onChanged` `isOpenSidebar` 分岐に `appState.sidebar.isOpen !== newIsOpen` ガード（自タブは反映済みなのでスキップ、他タブ由来のみ処理）。
  - ③→ `UpdateManager.performManualUpdate` に `isPerformingManualUpdate` in-flight ガード。
- 診断: 現在は専用の頻度カウンタは無い。疑うときは `updateSidebar`/`getLivePrograms` に一時ログを仕込むか Network で notifybox・`front/api/pages/follow/v1/programs?status=onair` の発火回数を数える。放置で増える→①、開閉で+2→②、タブ往復で+1→復帰更新。

## ✅ U. フォロー中フロントAPIのページング（✅ 実装済み・70件超同時放送でも全件詳細が揃う）
- **旧問題（解決済み）**: 当初の SSR埋め込みデータ・スクレイプ実装は**1ページ目（約70件）のみ**を読み、70件超の同時放送では末尾番組の詳細（視聴者数・コメント・ライブサムネ・開始時刻）が欠落してタイトルのみ描画になっていた。
- **現状**: `followPageSource.fetchFollowedProgramsViaPage` は公開フロントJSON APIを **`offset` を進めながらループ**する。`offset` は**0始まりのページ番号**（ページ N は `total` のうち `[N*limit .. N*limit+limit)`）。`PAGE_LIMIT=100` で `offset=0,1,2,…` と取得し、`id` で重複排除しつつ `total` 件に達するまで累積する（`MAX_PAGES=5` の安全上限＝最大500件）。
  - 放送中フォローが100件未満なら**通常は1リクエスト**で完結。100件を超えても追加ページで**全件の詳細が揃う**。
- **クラッシュしない設計は健在**: `updateSidebar` の番組ごと `try/catch`（1件失敗で全体を空にしない）と、`makeProgramElement`/`updateSidebar` の `String(program.id)` 化により、万一 `MAX_PAGES` 上限（500件超）で詳細が付かないカードが出ても例外にはならない（視聴者数0・サムネ無しでソート末尾に沈むだけ）。
- 対象: `src/services/followPageSource.js`（`fetchOnePage`・`PAGE_LIMIT`・`MAX_PAGES`）。→ [06-features](./06-features.md)

## 🟡 W. 固定画像配信者はJSON APIにライブサムネ枠が無く、詳細APIで選択的補完する
- **背景**: フォローAPIの1番組はサムネフィールドを **`listingThumbnail` 1枠しか返さない**。配信者が「固定画像」を設定していると `listingThumbnail` がその固定画像になり、放送直後（ライブスクショ未生成）も同様に空扱いになる。本拡張は**ライブスクショだけを表示する方針**（`isLiveScreenshotUrl` フィルタ）なので、これらの番組は `mapApiProgramToInfo` の時点で `thumbnailUrl=''` になる。
- **選択的フォールバック**: `fillMissingLiveThumbnails` が `thumbnailUrl` 空の番組**だけ**を対象に、番組ごと詳細API `fetchProgramInfo()` を叩いて `liveScreenshotThumbnailUrls`（ライブスクショ）を補完する。空は通常0〜数件で、`MAX_DETAIL_FALLBACK=30` で1サイクルの呼び出し数を上限。**全番組には叩かない**（旧「全番組×詳細API」の重さを意図的に回避）。
- **注意**: 詳細API側にもライブスクショが無い番組（本当に固定画像運用）はそのまま空のまま＝サムネ非表示になる（正常）。個別の詳細API失敗は握り潰し（`try/catch`）、次サイクルで再挑戦する。ここを重くしたくないので、`MAX_DETAIL_FALLBACK` を安易に上げないこと。
- 対象: `src/services/followPageSource.js`（`fillMissingLiveThumbnails`・`isLiveScreenshotUrl`・`MAX_DETAIL_FALLBACK`）、`src/services/api.js`（`fetchProgramInfo`）、`src/config/constants.js`（`liveInfoAPI`）。

## 🟢 V. フォローAPI失敗時のフォールバックは無い（その周期は詳細が古い/欠落のまま）
- `_refreshDetailsViaScrape` は `fetchFollowedProgramsViaPage` が `null`（未ログイン/仕様変更/通信エラー/HTTP非200）を返したら**何もしない**（storage を上書きしない）。フォローAPI全体を別経路に**切り戻すフォールバックは存在しない**（意図的）。
- ※ 詳細API `fetchProgramInfo` は健在だが、これは**サムネ欠落番組の選択的補完専用**（項目W）であって、フォローAPIそのものの代替経路ではない。フォローAPIが丸ごと失敗した周期を肩代わりする経路は無い。
- 結果、失敗した周期は**リスト（notifybox）だけ更新され、詳細は前回のstorage値のまま**（初回から失敗し続ければ詳細欠落のまま）。次の周期でフォローAPIが復帰すれば自動で追いつく。
- 「自動/API/ページ取得」を切り替える `dataSource` 設定や `auto` フォールバックモードも撤去済み（2026-07-18）。取得経路はリスト=notifybox・詳細=フォローAPI の一本のみ。

## ✅ X. 動くサムネが稀に途中停止（🟡→修正済み・2026-07-23）
- **症状**: ホバー中の動くサムネのアニメが極稀に途中で止まり、マウスを動かすまで再開しない。
- **原因**: `animatedThumbnail.onMouseOver` がサムネ枠 `.program_thumbnail` を**厳格判定**し、同一カード内でもサムネ枠の外（`.program_title`/`.community`/アイコン/カード余白5px）へポインタが少しでも入ると `setHoverCard(null)→stopAnim()` で連鎖(`animTimer` 一本)が切れていた。停止を「コンテナ離脱時のみ」に限る `onMouseOut` と**粒度が非対称**で、サムネ枠へ入り直すまで再開しない（＝ユーザーはサムネを見ているつもりなのに止まる＝「極稀」に感じる）。
- **修正**: `onMouseOver` を「サムネ枠へ入ったらそのカードをホバー対象／サムネ枠外でも現 `hoverCard` の内側なら維持／それ以外のみ `setHoverCard(null)`」に変更。停止はカード離脱・コンテナ離脱（`onMouseOut`）へ一本化。**同一カードのタイトル等の上でも再生継続する仕様変更**を含む（`onMouseOut` が既にコンテナ全体をホバー領域とみなす設計と粒度を揃えた）。`animTimer`/`animGen`/eviction 経路には非介入。
- 対象: `src/render/animatedThumbnail.js`（`onMouseOver`）。
- **2026-07-23 追記（挙動をユーザー要望で変更）**: 上記「同一カード内なら再生継続」は、サムネ画像から外れてもカード内で動き続けるため不評。`onMouseOver` を再び `.program_thumbnail` 厳格判定へ戻し、**サムネ画像にホバー中だけ再生／外れたら停止**とした（枠外への微小ドリフトで止まる件は許容）。
- **棄却した仮説**（敵対的検証で不成立）: 並び替え`replaceChildren`時のmouseout誤発火・fragment離脱中の`showNext`・`decode()`ハング・eviction例外。いずれも単一スレッド同期実行＋ノード再利用＋`animGen`無効化＋`playUrlAt`の`getLiveStaticSrc`フォールバックで防がれている。

## ✅ Y. 動くサムネに稀に最新が含まれない（🟡→修正済み・2026-07-23）
- **症状**: 最新の（いま静止表示中の）ライブサムネが動くサムネ再生に含まれない／末尾に古い固定画像や `loading.gif` が「最新のフリ」で混ざることが極稀。
- **原因（共通根）**: 末尾スロット（最新静止サムネを必ず映す安全網）の要否を **URL文字列一致** `getStaticSrc()===b.lastSrcUrl` で決めていたのが脆い。
  - **(a) error フォールバック**: 給餌用 `pre` は成功したのに静止img自身の読込だけが失敗すると `handleThumbnailError` が `img.src` を `data-src`(固定コミュ画像) か `loading.gif` へ差替え。URLが `lastSrcUrl` と食い違い末尾スロットが**その非ライブ画像を最新として1コマ(~700ms)表示**していた。
  - **(b) CHANNEL 番組**: `computeNext` が `key='c|'` でキャッシュバスターを付けずURL不変 → `staticIsDuplicate` が**恒常true → 末尾スロットが一度も発火しない**（USERは毎回一意URLで救済されるが CHANNEL だけ構造的にすり抜ける）。
- **修正**: 末尾スロット判定を**状態ベース**へ置換。`getStaticSrc`→`getLiveStaticSrc`（静止imgが error フォールバック中なら `null` を返す。判定は ①側が `img.dataset.thumbLive` を成功時`'1'`/エラー時`'0'`で通知）、`staticIsDuplicate`→`shouldAppendStaticTail`（**静止がライブ**かつ**最新blobより先へ進んだ**時だけ末尾を足す＝URL文字列でなく「ライブか」「先へ進んだか」で判定＝providerType非依存）。挙動はライブ通常時は従来と等価、fallback中のみ末尾を抑止して最新blobを最新扱いにする。
- 対象: `src/render/animatedThumbnail.js`（`getLiveStaticSrc`・`shouldAppendStaticTail`・`playCount`・`playUrlAt`）、`src/render/sidebar.js`（`applySuccess` で `thumbLive='1'`・`handleThumbnailError` で `thumbLive='0'`）。
- **残ギャップ（別件・低）**: CHANNEL はキャッシュバスター無しで静止img自体が初回内容に凍結され得る（URL不変で `applySuccess` の `img.src!==urlForAttempt` が偽＝再取得されない）。給餌`pre`のHTTPキャッシュ次第でバッファも停滞し得る。完全対称化には CHANNEL feed のキャッシュバスターが要るが、`large1280x720ThumbnailUrl` にクエリ付与が安全か（署名URL等で403にならないか）を実機で裏取りしてから判断（安易に付けない）。上記修正は「非ライブ混入」を全 provider で塞ぐところまで。
- **棄却した仮説**（敵対的検証で不成立）: USER重複排除の閾値誤破棄・`toBlob`/hydrate競合・`currentSrc`遅延窓。捨てられるのは「中間コマ or ほぼ同一コマ」で、真の最新は blob か末尾スロットで必ず映るため最新欠落にならない。

## ✅ Z. サムネ更新を「番組ごとの独立・自己連鎖タイマー＋自然ドリフト」へ（2026-07-23）
- **背景/要望**: 旧「全番組を同時一斉更新」＋別建てA1バッチは、リストがいっぺんに切り替わる“一斉感”が気持ち悪い。各番組がバラバラのタイミングで更新され、読み込み時は一斉→以後少しずつズレてほしい（機能/軽さでなくUXの要望）。
- **新方式（`UpdateManager`）**:
  - 各番組が自前の自己連鎖タイマー（`_thumbTimers` Map: id→timeoutId）。`_runThumbCycle` が「その番組の `<img>` を1件更新 → 画像の読み込み完了を待つ → `updateThumbnailInterval`(20秒)後に次サイクル」。周期＝20秒＋作業時間（取得/デコード）で毎回わずかに違うため**自然にドリフト**。
  - ドリフトを効かせるため `updateThumbnailsFromStorage`（sidebar.js）に **`onSettled`**（全プリロード settle シグナル）を追加。`_updateOneThumbnailAndWait` が読み込み完了を待って次サイクルを張る。画像ハング対策に**2×間隔の安全ガード**（`_pendingGuards` で追跡）。
  - **読み込み時の一斉更新**は `performManualUpdate`（全件 `updateThumbnail`）が担当。**定期 `updateSidebarInterval` の全件 `updateThumbnail()` は撤去**（一斉感の除去）。新規/削除カードは `_syncThumbTimers`（`updateSidebar` 末尾で呼ぶ）が拾う。
  - **A1（空サムネ番組のライブスクショ追撃）を各サイクルへ統合**（`_fetchLiveThumbIfPendingYoung`）。`beginAt` が若い（<`newProgramFastPollMs`=3分）user・非会員・空番組だけ詳細API追撃。古い空番組＝固定画像運用とみなし追わない（スクレイプ `fillMissingDetails` 60〜180秒に委譲）。**旧「8回打ち切り」「10件/回上限」「別建てA1バッチ」は撤去**。同時実行上限は付けない（ブラウザの同一ホスト~6接続で自然に律速）。
- **ライフサイクル**: `appState.timers.thumbnail` はセンチネル(`true`)のみ。実タイマーは `_thumbTimers`。停止は `stopThumbnailUpdate`（`stopAllTimers`＝閉 と `cleanup`＝離脱 の両方から呼ぶ＝対称）。
- **敵対的レビューで検出・修正した罠（改修時に再発させない）**:
  - 🔴 **ゴースト連鎖**: stop→即再開の境界で in-flight サイクルが自分を新runへ再採用し二重タイマー化（`_scheduleThumbCycle` の Map 上書きで孤児化）。→ **世代トークン `_thumbGen`**（start/stopで++、サイクル開始時に捕捉、`gen一致かつrunning時のみ`再スケジュール・**不一致時はMap非操作**）＋ **clear-before-set**（set前に既存timerをclearTimeout）で解消。
  - 🔴 **lost update**: A1書き戻しを `upsertProgramInfos`（stale全置換）で行うと、await中にスクレイプが入れた最新の視聴者数等を巻き戻す。→ **`storage.patchProgramThumbnail`**（await後に再read→サムネ欄のみマージ）へ。
  - 中断サイクルのガードは `_pendingGuards` で追跡し、stop時は `finish()`（clear＋resolve）で**待機Promiseごと解放**（未resolveリーク防止）。
  - **背景タブ**は rAF 停止で `onSettled` が来ないため、`_runThumbCycle` は `document.hidden` 時は更新せず軽く再スケジュールのみ（ガード空回し回避、可視復帰で通常へ）。
- **🔴 初回位相の均等配置（2026-07-26 追加・これが無いとドリフトが原理的に成立しない）**: `_syncThumbTimers` が全カードに**同じ** delay を張ると初回が完全同時になる。全画像が HTTP/2 の同一接続で多重化されて帯域を分け合うため、**どの番組も「同じ時間」で完了**してしまい、作業時間が共通化＝全番組が同じ瞬間に次を張り直す。「作業時間ぶん自然にドリフトする」という前提が崩れ、一斉状態がそのまま自己維持される（実測: 16番組で作業15.1秒→周期35.1秒。20秒間隔が守れずコマを取りこぼす）。→ 初回を `cycleMs + cycleMs*(i+1)/cards.length` で周期内へ均等配置。**必ず基準間隔ぶん「後ろへ」倒してから分散させること**（前倒しすると `performManualUpdate` の force 一斉更新の最中に発火し、新規カードは `dataset.lastSuccessAt/key` 未設定で TTL ガードが素通り＝同じ `<img>` に2本目の取得が走る）。
- **実測による確認（2026-07-26 / 14番組・4分連続観測）**: 自己周期 **20.0秒**（20.0〜20.1）、位相の散らばり **18.1〜18.5秒**、1サイクルの作業時間 **0.0秒**、2×間隔ガード到達 **0/153回**、**同時に走ったサイクルは常に1本**。同一画像を fetch / crossOrigin付き`<img>` / 素の`<img>` / `fetchPriority=high` で同時取得する比較も4ラウンドとも全て 0.0秒で同着＝**`<img>` の優先度スターベーションは原因ではない**。キャッシュバスター有無の比較も 0.1秒/0.0秒（7KB・HTTP 200）で、**`?cache=` もサーバも回線も無罪**。→ 詳細は [10-verification-playbook](./10-verification-playbook.md)
- **既知の据え置き（低・別件）**:
  - 起動直後に位相リセットが2回走る（実測 0.6秒・1.6秒）のは**仕様どおり**。開いた瞬間の `resetSidebarSchedule` → `performManualUpdate` 完了後にもう一度、という設計。※この実測は世代トークン時代（`startSidebarUpdate` が2回呼ばれていた）のもの。**常設ループ化後は「期限を置き直すだけ」でタイマーの生成/破棄が起きないため、ここが二重化の入り口になることはもう無い**（項目 AB-2）。
  - A1が入れたライブスクショURLが、フォローAPIの listingThumbnail 非反映番組では各スクレイプ周期で一旦空へ戻り得る（`fillMissingDetails` が同周期で再補完するので実質一過性）。恒久化したければ upsertProgramInfos で「既存が有効ライブスクショ かつ 新規が空」なら保持マージする。
  - per-program 更新は毎サイクル localStorage 全体を `JSON.parse` する（旧一斉のN倍）。絶対コストは小（~数ms/秒）で据え置き。必要なら単一番組の高速updateパスで最適化可。
- 対象: `src/managers/UpdateManager.js`・`src/render/sidebar.js`（`updateThumbnailsFromStorage` の `onSettled`）・`src/services/storage.js`（`patchProgramThumbnail`）・`src/main.js`（`cleanup`/`stopAllTimers`）・`src/config/constants.js`（`newProgramFastPollMs`）。→ [03-module-reference](./03-module-reference.md)・[04-data-flow](./04-data-flow.md)

## ✅ AA. channel番組のサムネがアイコンURLで「ライブサムネ」登録され、毎周期100%失敗していた（🔴→修正済み・2026-07-26）
- **前提（ニコ生の仕様・利用者確認済み）**: **チャンネル番組にライブサムネは提供されない。** チャンネルが固定画像／チャンネルアイコンを出しているのが正しい姿であり、「チャンネルのサムネが動かない」のは**不具合ではない**。ここを"直そう"としないこと。
- **症状**: 動くサムネONで、Console に `listing-thumbnail.live.nicovideo.jp/?url=…comch/channel-icon/128x128/chXXXXXXX.jpg` に対する `blocked by CORS policy: No 'Access-Control-Allow-Origin'` が20秒ごとに出続ける。**画面上はサムネが正常に見える**（平文フォールバックで表示だけ確保されるため）。
- **真因**: `mapApiProgramToInfo`（`followPageSource.js`）が、user には `isLiveScreenshotUrl()` を適用しながら **channel は `listingThumbnail` を無検査**で `large1280x720ThumbnailUrl`（＝定期更新の対象フィールド）へ入れていた。項目W のフィルタ方針が channel に適用されていなかった、という取りこぼし。
- **被害**: (1) 永久に変わらない画像を20秒ごとに取り直す (2) このホストは ACAO を返さないため crossOrigin プリロードが必ず失敗し平文で読み直す＝**1周期2リクエスト** (3) `animThumbFeed.ingest` に到達せずその番組だけ動くサムネが機能しない。しかも平文フォールバックの `applySuccess()` が `dataset.thumbLive='1'` を立てるので、動くサムネ側からは「ライブサムネ表示中」に見える（項目Y の末尾スロット判定を惑わす実体はこれ）。
- **修正（2層）**:
  1. `followPageSource.js` — `mapApiProgramToInfo`・`fillMissingDetails` の channel 経路にも `isLiveScreenshotUrl()` を通し、**ライブスクショだけ**を `large1280x720ThumbnailUrl`/`liveScreenshotThumbnailUrls` に入れる。**表示用 `thumbnailUrl` は従来どおり**なのでカードの見た目は不変。
  2. `sidebar.js` — `resolveLiveThumbnailBaseUrl` の channel 分岐から `|| info.thumbnailUrl` を削除（1をすり抜けた場合の防御）。user 側の同フォールバックは放送直後の未生成窓を `_fetchLiveThumbIfPendingYoung` が埋める設計のため**残す**。
- **調査時の教訓（同種のバグで再発しやすい）**: 最初に 2 だけを直したがエラーは止まらなかった。**アイコンURLはその手前で「正規のライブサムネ」として登録済み**だったため。「どこで表示に使うか」ではなく「**どこでライブサムネとして登録されるか**」を先に見ること。
- **🔴 この修正が生んだ二次回帰（同日レビューで検出・修正済み）**: 定期更新から外すと、その `<img>` に触れる経路が**他に一切無くなる**。channel は `src` と `data-src` が同一URLなので `handleThumbnailError` の `this.src !== dataSrc` が偽になり**必ず loading.gif へ落ちる**（`sidebar.js`）。変更前は次のサムネ周期で `applySuccess` の `if (img.src !== urlForAttempt) img.src = urlForAttempt` が実URLへ戻していたが、対象外にしたことで**唯一の復旧経路が消え、一過性の失敗だけで loading.gif がページ再読込まで固定**されるようになっていた。→ `computeNext` が null を返した時に `restoreStaticThumbIfLoading(img)` を呼び、loading.gif のときだけ `data-src` へ戻す（壊れたURLを毎周期叩かないようプリロード経路と同じ dataset バックオフに乗せる）。**「更新対象から外す」変更は、その要素の復旧経路も同時に奪っていないか必ず確認すること。**
- 対象: `src/services/followPageSource.js`・`src/render/sidebar.js`。検証記録は [10-verification-playbook](./10-verification-playbook.md)

## ✅ AB. サイドバー更新チェーンの孤児化・二重化（既知欠陥#1）（🔴→修正済み・2026-07-26）
- **旧構造の問題**: チェーンを止める手段が `clearTimeout` **しか無かった**。`updateSidebarInterval` は `await this.updateSidebar()` の中に居る間タイマーが存在しないため、その瞬間は**構造的に停止不可能**。しかも await 明けに**無条件で**自分の次を張り `appState.timers.sidebar` を上書きしていた。
- **孤児化の手順**:
  1. チェーン#1 が `await this.updateSidebar()` 実行中（`timers.sidebar` は消化済み＝止める手段なし）
  2. そこへ `restartSidebarUpdate()`（更新間隔の変更・`performManualUpdate` 完了時）が来る → `clearTimeout` は空振り → **チェーン#2 誕生**、`timers.sidebar` = #2
  3. #1 の await が解決 → 無条件に次を張り `timers.sidebar` を#1のもので**上書き**
  4. → #2 のタイマーIDはどこからも参照されない＝**孤児。だが生きていて発火し続ける**
- **症状**: (A) サイドバーを閉じても更新が回り続ける（`stopAllTimers` の `clearTimer('sidebar')` は#1しか止められない）／(B) 2本並走＝リスト取得が二重化し、**ページ再読込まで戻らない**。
- **修正**: サムネ側 `_thumbGen` と**同じ世代トークン方式**を移植。
  - `_sidebarGen` を `startSidebarUpdate`／`stopSidebarUpdate` で ++。チェーン生成時に `gen` を捕捉。
  - 再スケジュールは `scheduleNext()` に集約し、**`gen !== this._sidebarGen` なら張らない＝旧チェーンはそこで自然消滅**。不一致時は `appState` のタイマーも触らない（新世代が張ったものを消さないため）。
  - コールバック先頭でも世代チェック（clearTimeout が間に合わずキュー済みだった場合の保険）。
  - **`stopSidebarUpdate()` を新設**し、`stopAllTimers`（閉）と `cleanup`（離脱）の両方から呼ぶ＝サムネ側と対称に（項目K のライフサイクル非対称の解消でもある）。`restartSidebarUpdate` は `startSidebarUpdate` へ委譲するだけでよくなった。
- **世代照合は await の「後」にも要る（同日レビューで検出・追加）**: 発火時と再スケジュール時だけ照合しても、**await を跨いだ後の副作用**は止まらない。旧チェーンが `await this.updateSidebar()` から戻ると `getCurrentSessionId()` は「今動いている別の更新」のセッションを返すため、`finishSessionWithMinDuration` が**他人のセッションを finish** してしまう（`LoadingManager` はIDを受け取らず「今のセッション」を無条件に閉じる）。結果、`performManualUpdate` の force 一斉更新（実測15秒級）の最中に `isLoading()` が false へ落ち、更新ボタンの `pointer-events` が戻って**押せるのに無反応**になる。→ await 直後にも `if (gen !== this._sidebarGen) return;` を置く。
- **閉じたタブでの再起動を塞ぐ（同日レビューで検出・修正）**: 設定は全タブ共有なので `chrome.storage.onChanged` は**サイドバーを閉じている別タブでも発火する**。`main.js` の更新間隔変更ハンドラだけが開閉を見ずに `restartSidebarUpdate()` を呼んでおり、閉じたままリスト取得が回り続けて `stopSidebarUpdate` の効果を打ち消していた（他の起動経路は全て `isOpen` を見ている）。→ `if (needsRestart && appState.sidebar.isOpen)` に。閉じている間は何もしなくてよく、次に開く時の `startSidebarUpdate` が新しい間隔で始める。
- **注意**: 「タイマーを clearTimeout すれば止まる」は **await を挟むチェーンでは成立しない**。停止フラグか世代トークンを必ず併用し、**await の前後どちらでも照合**すること。

### AB-2. 上の欠陥を「構造から」消した（常設ループ化・2026-07-29）

**世代トークンは効いていたが、増やした仕組みで元の仕組みを押さえつける形だった**（照合を1か所書き忘れれば穴が開く。実際 AB の時点で await 直後の照合が抜けていた）。そこで **start/stop/restart そのものを廃止**した。

- **新構造**: `UpdateManager` が常設ループを1本だけ持つ。`startSidebarLoop()`（init で1回）／`destroySidebarLoop()`（cleanup で1回）／`resetSidebarSchedule()`（位相リセットのみ、ループは作らない）。
  - **`_sidebarNextDueAt`（次に取得してよい時刻）が唯一の正**。タイマーは単なる目覚ましで、誰が張り直しても同じ値から遅延を計算するため**食い違いようがない**。
  - `_sidebarTick` が毎回 `isOpen` → 期限 → `isLoading()` を判定して素通りする。**「閉じたら止める」ではなく「閉じている間はやらない」**。判定に外れても `finally` で必ず次を張るので、ループが死ぬ経路は destroy だけ。
  - チェーンを作り直さないので**孤児化も二重化も構造上起こりえない**。世代トークン `_sidebarGen` は削除。
- **前提**: ページのライフサイクルは DOMContentLoaded で1回 setup → beforeunload/pagehide で1回 cleanup のみ。**SPA的な再初期化経路は存在しない**（自動移動も `location.assign` の完全遷移）。だから「ページ滞在中ずっと1本」で足りる。
- **世代トークンの2つ目の仕事は残るので別途手当てした**: 孤児化防止（＝廃止でよい）とは別に、**await を跨いだ後に他人のローディングセッションを finish しない**という仕事があった。常設ループでも `await this.updateSidebar()` は残るため、これは消えない。→ `LoadingManager.finishSession` / `finishSessionWithMinDuration` に **`expectedSessionId` を追加してIDスコープ化**し、`updateSidebar()` は開始した sessionId を返すようにした。`AppState.finishUpdateSession` は元からID照合を持っており、**`LoadingManager` 側だけが揃っていなかった**。
- 🔴 **ループのハンドルを `appState.timers` に置いてはいけない**: `stopAllTimers`（閉）と `AppState.cleanup` が外から殺してしまい、**閉じた状態で起動する既定経路でループが即死して復活不能**になる。例外もログも出ない。よって `timers` から `sidebar` キー自体を削除し、`UpdateManager` の内部フィールドで持つ。なお `AppState.setTimer/getTimer/clearTimer` は**未知のキーを無言で捨てる**ので、新キーを足しても気付けない。
- 🔴 **`stopAllTimers` から sidebar を外す時、`clearTimer('autoNext')` を巻き添えで消さないこと**: 「サイドバーを閉じると自動移動のカウントダウンも止まる」は既存の挙動。消すと**閉じたのにページが勝手に遷移する**。
- **リファクタ時に自分で作り込んだ回帰（多観点レビューで検出・修正済み）**:
  1. **周期が `interval + 作業時間` → `interval ちょうど` に詰まっていた**。取得の「前」に期限を進めたため。旧は取得完了後に初めて `setTimeout(interval)` を張る自己連鎖で、実周期は interval ＋（取得時間と最低表示1秒の合成）だった。→ 期限は `finally` で「この回が終わった時点」から数え直す。ただし await 中に `resetSidebarSchedule` が先へ置き直していたら尊重して上書きしない。
  2. **自動移動が開くセッションの回収役が消えていた**。`main.js` の `updateSidebar()` ラッパー（`AutoNextManager` へ注入）は `startSession` するが finish しない。旧は定期チェーンの**無条件 finish が偶然の回収役**になっていた（ただし届くのは「tick の await 中に発生した場合」だけ）。IDスコープ化でその偶然が消え、最大60秒スピナー固着＋定期取得停止になっていた。→ ラッパー自身が自分のセッションを閉じるよう根本を修正。
  3. **`destroySidebarLoop` を完全な片道にすると復旧経路を奪う**。`beforeunload`/`pagehide` は**ページが生き残る場合がある**（bfcache 復帰、遷移キャンセル）。旧は停止が可逆で開き直せば復活した。→ `resetSidebarSchedule` から再武装できるようにした。
  4. `startSidebarLoop` の冪等ガードを `_sidebarLoopTimer !== null` で判定すると、**tick 実行中は null なのですり抜ける**。→ 専用フラグ `_sidebarLoopRunning` で判定。
- **意図的に変えた点（挙動差として承知）**: 取得中に「閉じる／間隔変更」が割り込んだ場合、旧は世代不一致で await 明けに打ち切っていたため**そのセッションが宙吊りになり、更新ボタンが最大60秒スピナー固着＋タイムアウト警告**が出ていた。新は自分のセッションを必ず閉じるのでどちらも起きない。**旧側の欠陥の解消**。
- **裏タブ判定は入れていない**: 「サイドバーが開いている間は可視/非表示に関わらず走らせる」は 655df9c の意図的決定（`main.js` に明文あり）。`document.hidden` を見るのは**サムネ側だけ**。ここを混同しないこと（doc/10 の B5 が検証しているのもサムネ側）。
- 対象: `src/managers/UpdateManager.js`（`startSidebarLoop`・`destroySidebarLoop`・`resetSidebarSchedule`・`_sidebarTick`）、`src/managers/LoadingManager.js`（IDスコープ）、`src/main.js`（`stopAllTimers`・`cleanup`・`updateSidebar` ラッパー）、`src/core/AppState.js`（`timers` から sidebar 削除）。
- **検証は自動化済み**: `npm run verify:loop`（`scripts/verify-sidebar-loop.mjs`）。実コードをそのまま Node で動かすので実機・ログイン不要。手作業が残るのは doc/10 の D6・D7 だけ。

## ✅ AC. 常設ループ化の調査中に見つけた既存バグ（同日中に修正済み・2026-07-29）

AB-2 の事前調査で**このリファクタとは無関係の既存バグ**が見つかった。切り分けを濁らせないため一度は据え置いたが、常設ループ化を push して切り分けが済んだ後、同日中に AC-1／AC-2 を修正した。**回帰テストは `npm run verify:loop` に入れてある。**

1. ✅ **裏タブで `performManualUpdate` が無期限にハングする** → **修正済み**
   `await new Promise(resolve => this.updateThumbnail(true, resolve))`（`UpdateManager.js`）は `updateThumbnailsFromStorage` の **rAF 駆動**（`render/sidebar.js` の `requestAnimationFrame(tick)` → `checkComplete` → `onComplete`）に完全依存している。裏タブでは rAF が来ないので `onComplete` が永久に呼ばれない。
   到達経路は実在する: (a) バックグラウンドで watch ページを開いた時（`main.js` の起動300ms後）、(b) 他タブがサイドバーを開いて `storage.onChanged` 経由で `handleSidebarOpenStateChange(true)` が走った時。どちらも `main.js` の「rAFが実行されない場合のフォールバック」コメントが明示的に想定しているケース。
   結果 `isPerformingManualUpdate` が立ちっぱなしになり、ローディングは60秒タイムアウトで閉じられて**更新ボタンだけ有効化される＝押せるのに無反応**。可視復帰の契機は 655df9c で撤去済みなので、そのタブを見に行くまで解けない。

2. ✅ **設定を1つ変えるだけで「サイドバーの開閉状態」が全タブへ伝播する** → **修正済み**
   `optionsHandler.saveOptions` → `storage.js` の `chrome.storage.local.set(options)` が **options 全キー**を書く。`options` には `isOpenSidebar` が含まれる（`main.js` の開閉時に代入される）。`getOptions` も merged 全キーを set する。
   害: 自動オープンのタブでテーマや並び順を変えると `isOpenSidebar` が false→true に変わり、`storage.onChanged` が全タブで発火。**サイドバーを閉じている別タブが「開いた」と誤認**して幅0のまま取得を始める。「閉じたタブでは取得しない」という不変条件が、更新間隔以外の設定変更で破れる。

3. 🟡 **`isSidebarLoading()` が死にコード**（`render/animatedThumbnail.js`）。定義だけで呼び出し0件。`.loading` クラスの消費者は CSS だけで、「動くサムネのキャプチャ抑制」という挙動は**存在しない**。改修時に「実在しない挙動」を保存対象と誤認しやすいので注意。

4. ✅ **自動移動が作る孤児ローディングセッション** → AB-2 で**修正済み**。`main.js` の `updateSidebar` ラッパーが `startSession` するのに finish していなかった。旧実装では定期チェーンの無条件 finish が偶然の回収役になっていたが、それは「tick の await 中に発生した場合」しか届かない。ラッパー自身が閉じるようにして根本解決。

**AC-1 の修正（2層）**
1. `updateThumbnail` の入口で `document.hidden` なら即 `onComplete`/`onSettled` を呼んで返す。背景では rAF が来ない＝実行しても1枚も更新できないので、待たせる意味がない。`_runThumbCycle` が同じ判定で見送るのと揃えた。**この判定は `getProgramInfos`（localStorage 依存）より手前に置くこと**（順序を入れ替えると検証が例外で落ちるようにしてある）。
2. それだけでは「待っている最中に背景へ回る」経路を塞げない（rAF が途中で止まる）。`performManualUpdate` のサムネ待ちに上限 `manualThumbWaitMaxMs`(30秒) を設けた。実測の force 一斉更新は15秒級なので十分上回り、`loadingSessionTimeoutMs`(60秒) より手前で切れる。検証用に `_manualThumbWaitMs` で短縮できる。

**AC-2 の修正**: `saveOptions` が `isOpenSidebar`／`sidebarWidth` を書かないようにした（`UI_STATE_KEYS` で除外）。この2つは「設定」ではなく各タブのUI状態で、`setIsOpenSidebar`／`setSidebarWidth` が持ち主。呼び出し側（`optionsHandler`）は `getOptions` のマージ結果をそのまま渡してくるため、storage 層で弾くのが確実。

> **据え置いた AC-3（`isSidebarLoading()` の死にコード）は未着手のまま。** 実害が無く、消すこと自体が「実在しない挙動を保存対象と誤認する」注意喚起として役立っているため。

## ✅ AD. リスト取得を「notifybox ＋ フォローAPI の和集合」へ（R-3・2026-07-29）

**旧実装は notifybox を「絞り込み」に使っていた。それを「和集合」に変えた。**

旧構成は「リスト＝notifybox／詳細＝フォローAPI」を並列取得し、**notifybox に載った番組だけ**カード化していた。
notifybox は `rows=100` でページングが無いため、**放送中が100件を超えると101件目以降が表示されない**
（詳細は500件まで取得していたのでその通信は完全な無駄）。項目 U の「70件頭打ちは解消」は詳細取得の話で、
表示側は100件のままだった。

### 一度は notifybox を撤去したが、実測で差し戻した

フォローAPI だけで足りるか検証したところ、**集合も並びも完全一致**したので一度は撤去した。
しかし新着検知の速さを40分計測すると**傾向が逆転**した。

| 番組種別 | 件数 | 速い方 |
|---|---|---|
| **user（community）** | 6件 | **全件 notifybox が 20〜101秒 速い** |
| channel | 3件 | フォローAPI 2件（うち1件はフォローAPIにのみ出現）／notifybox 1件 |

サイドバーに並ぶ大半は user 番組なので、**実運用では notifybox の方が速い**。
拡張の取得間隔は既定120秒なので、新着に気づくまでの平均は 約60秒 → 約100秒 に悪化する（体感で分かる差）。

> ⚠️ **教訓**: 最初の2件だけを見て「フォローAPIが速い」と結論したが、**その2件はたまたま両方チャンネル番組**だった。
> 9件まで集めると逆転した。少数サンプルで断定しないこと。

### 採用した形：和集合

```
notifybox   → 「誰がいるか」を早く知る担当（返すのは実質 id と title だけ）
フォローAPI → 詳細・並び順(beginAt)・100件を超える番組の担当

両方を並列に叩き、どちらかに出ていれば表示する
```

詳細の優先順位は **フォローAPIの実データ ＞ storage の前回値 ＞ notifybox の最小情報**（`_mergeSources`）。
notifybox にしか無い番組＝フォローAPIがまだ拾えていない**新着**なので、詳細が届くまでの1周期だけ
タイトルだけのカードを出す（次の周期で本来の姿になる）。

### 並び順は beginAt 降順

notifybox の返却順に頼るのをやめ、**`beginAt`（放送開始時刻）の降順**で並べる（`_orderByBeginAtDesc`）。
同時刻は **lv番号の降順**で決定的にする（安定ソート＝毎周期で順序が揺れない）。

> notifybox の並びに依存していた本来の理由は「**lv番号は予約/作成順で採番されるため放送開始順とズレる**」
> だった（項目 R）。これは正しい指摘だが、解決策としてAPIの並び順に頼る必要はなく、**`beginAt` を直接使えば済む**。
> 実測でも `beginAt` 降順は notifybox の並びと完全一致した（13件・食い違い0・欠落0）。

notifybox にしか無い番組は `beginAt` が不明なので「**今この瞬間に始まった**」扱いにして先頭へ置く。
notifybox の返却順も保つため、複数あっても順序が崩れない。

### 障害耐性が上がった

| 状況 | 挙動 |
|---|---|
| notifybox だけ失敗 | フォローAPIだけで描画 |
| フォローAPIだけ失敗 | notifybox ＋ storage の前回値で描画（**古くても出す**） |
| 両方失敗 | ログイン誘導を表示・既存DOMを維持 |

**片方が落ちても表示が消えない。** ログイン誘導（`#api_error`）は「両方失敗」の時だけ出す。

### 効果

| | 旧 | 新 |
|---|---|---|
| 表示できる番組数 | 100件 | **500件**（フォローAPIの上限） |
| 新着検知 | 速い | **速いまま**（notifybox を残したため） |
| 片方失敗時 | 描画できない場合がある | **描画できる** |
| リクエスト数 | 2本 | 2本（変わらず） |

### 実装メモ

- `_refreshDetailsViaScrape()` は取得結果を返す（失敗時 `null`）。`fetchLivePrograms` は失敗時 `false`
- `_mergeSources(notifyList, fetched)` が和集合を作る
- `data-api-index` の意味が「notifybox の返却位置」から「**beginAt 降順での位置**」に変わった。
  `sorting.js` の `newest` はこの属性を読むだけなので実装は不変

> ⚠️ **カードのDOM id は「lv を外した数値」の規約を維持している。** サムネ更新側が `` infoMap.get(`lv${card.id}`) `` で引き直す前提になっているため、ここを変えるとサムネ更新が全滅する。

> **退行検出**: `npm run verify:loop` に `_mergeSources` / `_orderByBeginAtDesc` の単体検証、`npm run verify:e2e` に「両方のAPIを叩いている」チェックを入れてある。

## ✅ AE. サムネ更新も常設ループ1本へ（R-1・2026-07-29）

**項目 AB-2 でサイドバー側からは消した欠陥構造が、サムネ側にそっくり残っていた。** しかもサムネ側は**番組数ぶんのN本**で、サイドバー側の1本より影響範囲が大きい。世代トークン `_thumbGen` で「ゴースト連鎖」（項目Z）を押さえていたが、押さえるのをやめて発生源ごと消した。

| | 旧 | 新 |
|---|---|---|
| タイマー | 番組数ぶん（`_thumbTimers` Map） | **常に1本** |
| 世代トークン | `_thumbGen` が必要 | **不要**（削除） |
| 停止 | `stopThumbnailUpdate`（サイドバー閉・離脱） | `destroyThumbnailLoop`（**離脱のみ**） |
| 閉じた時 | タイマーを全破棄 | **ループは生かし、tick が `isOpen` で素通り** |
| ドリフト | 各タイマーが「完了後20秒」を自己連鎖 | **`_thumbDueAt` Map が番組ごとの期限を持つ** |

### ドリフトはタイマーの本数と無関係

一見「番組ごとにタイミングをずらすには番組ごとのタイマーが要る」と思えるが、**ドリフトは「次に更新してよい時刻」の持ち方で表現される**ので、1本のループでも保たれる。tick は期限が来た番組を処理し、**完了した時点＋20秒**を次の期限にする。

> **実測（検証スクリプト）**: 4カード・間隔2秒・作業0.2秒で、同一番組の周期 2.20〜2.22秒（＝間隔＋作業時間）、初回位相の散らばり1.50秒（1周期2秒）。

### 1 tick = 1番組にした理由

期限切れが複数あってもまとめて処理しない。**1番組の画像がハング（最大2×間隔のガード）した時に他を巻き添えにしない**ため。期限切れが複数あれば次の tick が遅延0で連続して回るので総処理量は変わらない。

### 🔴 実装中に踏んだ再入バグ（検証が検出）

`_syncThumbDueAt`（期限表の更新）の末尾でタイマーを張っていたところ、**tick の中から呼ばれるため、その tick が `await` している間に発火して二重実行**になった。同じ番組を秒間十数回更新する暴走になり、周期テストが検出した。

対策は2つ:
1. **`_syncThumbDueAt` はタイマーを張らない**（純粋な状態更新にする）。張り直しは tick の `finally` か、ループ外の呼び出し元用 `_refreshThumbSchedule` だけが行う
2. tick に**再入ガード** `_thumbTickBusy` を置く。先行の tick が `await` 中なら重ねない（先行側が `finally` で必ず張り直す）

> ⚠️ **ガードの順序に注意**: `_thumbLoopStopped` の判定を `_thumbTickBusy = true` より**前**に置くこと。逆にすると停止時に busy が立ちっぱなしになり、ループが二度と動かなくなる（これも実装中に踏んだ）。

### 🔴 R-1 が作り込んだ暴走バグ（R-7 の棚卸しが検出・修正済み）

**サイドバーを閉じている間、CPU を焼き続けていた。**

```
閉じる → tick が isOpen を見て素通り
       → しかし _thumbDueAt の期限は過去のまま残っている
       → 次の起床を「いちばん早い期限まで」で計算すると 0ms
       → 即座にまた tick → 素通り → また 0ms → 無限ループ
```

実測で **2秒間に180回**（正常は2回）。背景タブでも同じ。**サイドバーを閉じるという
最も普通の操作で発生する**。

#### なぜ既存のテストが見逃したか

R-1 の時点で「閉じている間はサムネを更新しない」という検証を書き、**合格していた**。

| | |
|---|---|
| 更新回数 | 0回 ← テストはこれを見て合格にした |
| tick の発火回数 | 180回/2秒 ← **誰も見ていなかった** |

**更新は0回のまま暴走する**ので、「何回更新したか」を数えるテストでは原理的に検出できない。
「やらなかったこと」は確認できても「**無駄に動いていないこと**」を確認していなかった。
→ tick の発火回数そのものを数える検証を追加した（`verify:loop` の R-1 追加項目）。

#### なぜサイドバー側は無事だったか

同じ設計なのにサイドバー側では起きない。`_sidebarDelayToNextMs` は期限切れ時に**1周期を返す**
実装だったのに対し、サムネ側を書く時に **0 を返す**ように変えたため。
0 が必要なのは「期限切れが複数あるとき連続で捌く」ためだが、**素通りした回と処理した回を
区別していなかった**。→ `idled` を導入し、素通り時は必ず1周期空ける。

> ⚠️ **「1本のループが複数の期限を捌く」設計では、素通りの回と処理した回で再スケジュールを分けること。**
> 期限が過去のまま残る状況（閉じている・背景タブ・コンテナ消失）が必ずあるため。

#### 併せて修正: 到達すると復旧不能になる停止判定

`_thumbTickBusy` = true の**後**に `_thumbLoopStopped` の判定が残っていた（先頭の判定と重複）。
ここで return すると **busy が立ちっぱなしになりループが二度と動かない**。削除した。

### 付随変更

- `AppState.timers` から `thumbnail` キーを削除。更新ループ2本はどちらも `UpdateManager` が内部で持つ（外部から殺されないため。理由は項目 AB-2 と同じ）
- `stopAllTimers`（サイドバー閉）は `autoNext` のクリアだけになった
- `main.js` の `startThumbnailUpdate` ラッパーと二重開始ガード `!getTimer('thumbnail')` を削除

---

## 改修時チェックリスト
- [ ] ニコ生DOMに触る変更 → `setElems`/`layout.js`/`status.js` のセレクタを確認（項目G）
- [ ] 状態を足す → まず `AppState` に。グローバル変数やモジュール間グローバル参照を作らない（教訓: 旧項目A）
- [ ] タイマー/リスナを足す → `AppState` 管理下に置き `cleanup()` で解放（項目K）
- [ ] ビルドは IIFE。モジュール間で「グローバル関数」を当てにしない（教訓: 旧項目A）
- [ ] リリース → `manifest.json` と `package.json` のバージョンを揃える、`dist/style.css` 生成確認（[07](./07-build-and-deploy.md)）
- [ ] `npm run build` 後、実ページ（要ログイン）で動作確認（[07 §7.5](./07-build-and-deploy.md)）

## ✅ AF. 状態の置き場所の原則を実態に合わせて書き直した（R-7・2026-07-29）

`doc/02` の設計原則①は「**状態は `AppState` に集約する**」だったが、棚卸しの結果**実装の約1/3にしか当てはまっていなかった**。しかも 2026-07-29 の改修で更新ループ2本を**意図的に `AppState` の外へ出した**ため、原則と実装が逆を向いていた。原則の方を書き直した（詳細は `doc/02` 設計原則①）。

### 棚卸しの結果（6エージェントによる全モジュール走査）

| | 件数 |
|---|---|
| 宣言だけで読み手ゼロの状態 | **14件** |
| 同じ事実を2箇所以上に持つ重複 | **8件** |
| `cleanup` で解放されない状態 | **11件** |

### 決定：(c) 条件付きにする

「1箱に集めること自体は目的ではない」とし、**寿命と読み手の広さ**で3分類した。

- **`AppState`**: モジュールをまたいで読まれる **かつ** 離脱時に確実に解放したいもの
- **Manager が自前で持つ**: 所有者しか読まないもの、**外部から一括破棄されると復旧できないループ制御**
- **DOM / dataset**: カード1枚ごとに紐づき、カードと寿命を共にするもの

**「集約し直す」を却下した理由**: `AppState` の一括API（`clearAllTimers` / `disconnectAllObservers` / `cleanup`）は**名前を舐めて無条件に殺す意味論しか持たない**。寿命の違う状態を入れると殺されて困るものまで殺される。集約を強めるほど「一部だけ殺される」破綻が増える。

**「原則を捨てる」も却下した理由**: 解放されない11件のうち、`AppState` 経由できちんと解放されているものが4件ある。`cleanup` の唯一の入口という役割まで捨てると後始末の所在が霧散する。代わりに **Manager 側に `destroy()` の公開を義務づけ、`cleanup` から明示的に呼ばせる**ことにした。

### 🔴 発見した実害バグ：閉じると自動移動が二度と動かなくなる

```
カウントダウン中にサイドバーを閉じる
  → stopAllTimers が appState.timers.autoNext だけを clearTimer
  → カウントダウンは止まるが autoNext.scheduled は true のまま残る
  → observeProgramEnd のコールバック先頭で多重進入を弾く条件に使われているため、
     以後そのページで自動移動が二度と動かない（モーダルも出しっぱなし）
```

`scheduled` をリセットするのは `stopWatcher` だけで、**閉パスからは呼ばれない**。新しい原則が警告している「**同じ事象に属する状態は全部載せるか全部載せないか**」の実例そのもの。

**修正**: `AutoNextManager.cancelScheduledNavigation()` を新設し、**タイマー・フラグ・モーダルの3点セット**で戻す。`stopAllTimers` はこれを呼ぶ。

### 併せて修正

- **サムネループに再武装の入口が無かった**（サイドバー側の `resetSidebarSchedule` には有った）。`_refreshThumbSchedule` から復帰できるようにし、開くパスで呼ぶ。`beforeunload` / `pagehide` はページが生き残る場合があるため、破棄を片道にしてはならない
- **読み手ゼロのフィールド6件を削除**: `update.isUpdating` / `update.pending` / `observers.thumbnail` / `config.options` / `config.defaultOptions` / `elements`。3件は `main.js` から書かれてはいたが**読み手が1つも無かった**

### 原則を風化させないための検証

`npm run verify:loop` に8項目を追加した。`AppState.timers` に更新ループが載っていないか／宣言だけの死にフィールドが無いか／破棄が `cleanup` から呼ばれるか／**破棄が片道になっていないか**／自動移動をタイマーだけ殺していないか、など。

> ⚠️ **検証を書く時の注意**: `AppState` のフィールドは (1) 外からドット (2) 外から文字列キー（`setObserver('resizeSidebar', ...)`） (3) `AppState.js` 内のメソッド経由のみ（`loading.updateSession`）の3通りで触られる。ドットアクセスだけを数えると誤検出する（実際に2回間違えた）。判定は「**宣言行を除いて1回も現れないか**」にすること。

## ✅ AG. ローディングセッションを「奪えない」構造にした（R-4・2026-07-29）

**旧 `startSession()` は動いているセッションを finish せずに黙って上書きしていた。** これが本日のバグ2件の共通の発生源だった。

```
持ち主 A がセッション S_A を持って実行中
  → B が startSession() → S_B が S_A を上書き（A は奪われたことを知らない）
  → B が S_B を閉じる → isLoading() が false へ
  → **A はまだ実行中なのにロックが解ける**
     → 更新ボタンの pointer-events が戻り、押せるのに無反応
     → 定期取得の isLoading ガードも開き、二重に走る
```

対策として **finish 側のIDスコープ化**（項目AB-2）と **呼び出し側の相乗り判定**（項目AC の修正3）を後付けしていたが、どちらも「奪われた後」の後始末である。**奪える構造がある限り同種の問題は出続ける**ため、奪えなくした。

### 変更

```js
startSession() {
    if (this.currentUpdateSessionId) return null; // 持ち主がいる。奪わない
    ...
}
```

呼び出し側は「`null` が返ったら自分は持ち主ではない＝finish してはいけない」と解釈する。
`updateSidebar` の相乗り判定（`getCurrentSessionId()` を見て分岐）は不要になり、`startSession()` を素直に呼ぶだけになった。`performManualUpdate` も自分のIDでのみ finish するよう揃えた。

### 🔴 検証が API の危険を暴いた

実装直後、次のテストが落ちた。

```
相乗り側が finish しても施錠は解けない → NG（解けてしまった）
```

`finishSessionWithMinDuration(ms, null)` の `null` が「**無条件に閉じる**」と解釈される仕様が残っていたため。呼び出し側は全て `if (sessionId)` で守っていたので**実害は無かった**が、**書き忘れたら事故になる API** だった。

→ `null` は「自分は持ち主ではない」の意味に確定させ、**何もしない**ようにした。無条件に閉じたいのはタイムアウト回収だけなので、内部専用の `_finishNow()` に分離した。

> ⚠️ **呼び出し側の作法に依存する設計は、いずれ誰かが破る。** 危険な引数の解釈は API 側で安全側に倒すこと。

### 併せて削除

`main.js` の `finishLoadingSession()`（Manager 委譲ラッパー）は**呼び出し0件**の死にコードだったため削除した。

## ✅ AH. 実行可否ポリシーを1つの表に集約した（R-5・2026-07-29）

「今この処理をしてよいか」の判定が4箇所に散らばり、**同じ判定に見えて意図的に違う**ため取り違えやすかった。実際に**説明を誤った**（リスト更新も裏タブで止まると誤って伝えた）。

### 当初の方針を変えた

「判定を1つの関数に集約する」つもりだったが、調べると**集約は間違い**だった。

```
リスト更新 : 背景タブを見ない  ← 655df9c の意図的決定
サムネ更新 : 背景タブを見る    ← rAF が止まって完了通知が来ないため
```

同じに見えて**違わなければいけない**判定である。1つにまとめると意図的な差異を消してしまう。
→ 集約するのは**判定そのものではなく「どこが何を見るかの表」**にした。

### 採用した形

`UpdateManager` の冒頭にポリシー表を置き、生の値を直書きせず名前のついた述語を通す。

| 判定 | リスト更新 | サムネ更新 | サムネ反映 | 手動更新 |
|---|---|---|---|---|
| 破棄済み | ○ | ○ | − | − |
| サイドバーが閉 | ○ 取得しない | ○ 更新しない | − | − |
| **背景タブ** | **見ない** | ○ 更新しない | ○ 即完了 | （反映側で判定） |
| 別の更新が実行中 | ○ 見送る | − | − | ○ 多重防止 |
| DOM差し替え中 | − | − | ○ 即完了 | − |

述語は `_isSidebarOpen()` / `_isBackgroundTab()` / `_isUpdateInFlight()` の3つ。
**生の `document.hidden` / `appState.sidebar.isOpen` / `appState.isLoading()` を各所に直書きしない**（どこが何を見ているか grep で追えるようにするため）。

### 表を機械で守らせる

`verify:loop` に12項目を追加した。特に強いのは次の2つ。

- **リスト更新が背景タブを見ていないこと**（見るようになったら仕様変更＝退行として検出）
- **ポリシー表そのものがコードに残っていること**（消えると「なぜ違うのか」が失われ、また取り違える）

> ⚠️ **検証を書く時の自己矛盾に注意**: 「`document.hidden` の直書きは1箇所だけ」を素朴に数えると、
> **ポリシー表自身が「直書きするな」と書いている**ため表の記述を違反として数えてしまう（実際に踏んだ）。
> コメント行を除いて数えること。
