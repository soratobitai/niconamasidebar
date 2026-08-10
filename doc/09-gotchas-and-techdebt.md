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
- ~~残置: `observers.thumbnail`~~ → **項目AF で削除済み**（読み手ゼロのフィールド6件の1つ）。現在の `observers` は `{ resizeWatchPage, resizeSidebar }` のみ。

## 🟢 K. リスナ/タイマーのライフサイクル非対称
- `#optionForm` change、各ボタン click、`document` 全体 click（resize強制）などは cleanup で明示解除されない。単一ページ寿命では問題になりにくい。SPA的な再setup対応や厳密なリーク対策をするなら要整理。
- ※ 旧記載の `apiStats` の5分 setInterval はAPI監視ごと撤去済み（2026-07-18）。

## 🟢 M. `getOptions` の副作用（get が set する）
- 取得ついでにマージ結果を書き戻す（初回に既定値を永続化する意図）。「読むだけ」で呼ぶと storage 書き込みが走る点に注意。

## 🟢 N. データ取得の credentials（リスト・フォローAPIとも `include`／詳細APIのみ Cookie なし）
- 番組リストの notifybox（`fetchLivePrograms`）も、詳細のフォロー中フロントAPI（`fetchFollowedProgramsViaPage`）も `credentials:'include'` で取得する。両方ともログイン Cookie 依存（未ログインだとリスト失敗／フォローAPIは放送中番組ゼロ）。
- 例外: サムネ補完用の**詳細API `fetchProgramInfo`**（`liveInfoAPI = api.cas.nicovideo.jp/.../lv{id}`）は `credentials` 指定なし＝**Cookie を送らない**。公開情報だけを拾う用途で、**選択的にのみ**呼ばれる（項目V参照）。補完する内容は2つ: ①user のライブサムネ欠落（固定画像配信者・放送直後）②**channel/official の配信者名・アイコン（`contentOwner`）** — フォローAPIは `programProvider` を返さないため（項目AK）。
- `api.js` は `fetchLivePrograms`（notifyboxリスト）と `fetchProgramInfo`（詳細・サムネ補完専用）の**両方**を export する。

## 🟢 O. 「開いた瞬間の描画」と「定期タイマー初回」は別物
- 常設ループ（`_sidebarTick`）が実際に取得するのも、開いてから `updateProgramsInterval`（既定120秒）後が最初。開いた直後の即描画は `performManualUpdate` が担う（初回ロード・更新ボタン・タブ復帰・再オープン共通）。二層構造を混同しないこと。

## 🟢 P. `options` オブジェクトの参照整合（現状はOK）
- 現状は `onChanged` が in-place 更新するため整合が取れている。**以後 `options` を再代入しないこと**（Manager 側の参照とズレる）。

## 🟢 Q. コード整理（2026-07-11 実施ぶん / 残りの候補）
- ✅ **実施済み（デッドコード削除・敵対的検証済み）**: 旧オプションポップアップ由来の未使用CSS（`#optionContainer p/ul/li/.flex/.setbox/.inputbox/label/input[type=text]/a`・`.sidebar_display_none`）、未使用CSS変数（`--sb-popup-bg/-fg/-heading`）、未使用の委譲ラッパー関数（`ensure/showAutoNextModal`・`scheduleAutoNextNavigation`・`performInitialLoad`/`updateThumbnail`/`updateProgramCount`/`updateLoadingState`/`finishLoadingSessionWithMinDuration`）、`AppState` レガシー（`queues`・`loading.operations`・`startLoading/finishLoading`・`getObserver`）、`UpdateManager.stopAllTimers`（未使用。main.js 版が実体）、未使用 export の内部化（`ErrorType/ErrorLevel/ErrorManager`・`setProgramInfos`）、未使用 import/引数/デッド変数（main.js の `saveOptionsToStorage`・`computeNext` の `parentId`・`getLivePrograms` の `callId`）、空 no-op コールバック（`onProcessStart`/`onQueueEmpty`）。
- ✅ **実施済み②（低〜中リスクのリファクタ・挙動等価を敵対的検証済み）**:
  - `watch/` 視聴ページURLを `constants.watchPageBaseUrl` に定数化（`sidebar.makeProgramElement`・`UpdateManager` の計3箇所）。
  - ライブサムネのベースURL選定を純関数 `sidebar.resolveLiveThumbnailBaseUrl(info)` に集約し `sidebar.computeNext` で使用（※当時共用していた `animatedThumbnail` 側の自前取得経路は、①からの給餌方式に一本化された際に撤去済み）（`makeProgramElement` は初期src用に `?cache` 付与・`||''` フォールバック等の固有ロジックがあるため据え置き）。
  - AutoNext のカウントダウンタイマー後始末を `AutoNextManager._clearAutoNextTimer()` に集約（開始/キャンセル/interval×2/stopWatcher の5箇所）。
- ✅ **実施済み③（低リスク整理・挙動等価を敵対的検証済み）**:
  - ~~API呼び出し頻度フィルタの窓 `60000` を `constants.apiRateWindowMs` に定数化~~ → **API監視（`apiStats`）ごと撤去済み。`apiRateWindowMs` は現存しない。**
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
- **背景**: フォローAPIの1番組はサムネフィールドを **`listingThumbnail` 1枠しか返さない**。配信者が「固定画像」を設定していると `listingThumbnail` がその固定画像になり、放送直後（ライブスクショ未生成）も同様に空扱いになる。**user 番組**は固定画像を表示しない方針（`isLiveScreenshotUrl` フィルタ）なので、これらは `mapApiProgramToInfo` の時点で `thumbnailUrl=''` になる。⚠️ **channel/official は別**で、`listingThumbnail` をそのまま表示用 `thumbnailUrl` に入れる（固定画像形でもイベントの正規サムネなので出す）。空になるのは user だけ（項目AA）。
- **選択的フォールバック**: `fillMissingDetails` が `thumbnailUrl` 空の user 番組と、名前/アイコンが空の channel 番組**だけ**を対象に、番組ごと詳細API `fetchProgramInfo()` を叩いて `liveScreenshotThumbnailUrls`（ライブスクショ）を補完する。空は通常0〜数件で、`MAX_DETAIL_FALLBACK=30` で1サイクルの呼び出し数を上限。**全番組には叩かない**（旧「全番組×詳細API」の重さを意図的に回避）。
- **注意**: 詳細API側にもライブスクショが無い番組（本当に固定画像運用）はそのまま空のまま＝サムネ非表示になる（正常）。個別の詳細API失敗は握り潰し（`try/catch`）、次サイクルで再挑戦する。ここを重くしたくないので、`MAX_DETAIL_FALLBACK` を安易に上げないこと。
- 対象: `src/services/followPageSource.js`（`fillMissingDetails`・`isLiveScreenshotUrl`・`MAX_DETAIL_FALLBACK`）、`src/services/api.js`（`fetchProgramInfo`）、`src/config/constants.js`（`liveInfoAPI`）。

## 🟢 V. フォローAPI失敗時のフォールバックは無い（その周期は詳細が古い/欠落のまま）
- `_refreshDetailsViaScrape` は `fetchFollowedProgramsViaPage` が `null`（未ログイン/仕様変更/通信エラー/HTTP非200）を返したら**何もしない**（storage を上書きしない）。フォローAPI全体を別経路に**切り戻すフォールバックは存在しない**（意図的）。
- ※ 詳細API `fetchProgramInfo` は健在だが、これは**サムネ欠落番組の選択的補完専用**（項目W）であって、フォローAPIそのものの代替経路ではない。フォローAPIが丸ごと失敗した周期を肩代わりする経路は無い。
- 結果、失敗した周期は**リスト（notifybox）だけ更新され、詳細は前回のstorage値のまま**（初回から失敗し続ければ詳細欠落のまま）。次の周期でフォローAPIが復帰すれば自動で追いつく。
- 「自動/API/ページ取得」を切り替える `dataSource` 設定や `auto` フォールバックモードも撤去済み（2026-07-18）。取得経路はリスト=notifybox・詳細=フォローAPI の一本のみ。

## ✅ X. 動くサムネが稀に途中停止（🟡→修正済み・2026-07-23）
- **症状**: ホバー中の動くサムネのアニメが極稀に途中で止まり、マウスを動かすまで再開しない。
- **原因**: `animatedThumbnail.onMouseOver` がサムネ枠 `.program_thumbnail` を**厳格判定**し、同一カード内でもサムネ枠の外（`.program_title`/`.provider`（当時の名称は `.community`）/アイコン/カード余白5px）へポインタが少しでも入ると `setHoverCard(null)→stopAnim()` で連鎖(`animTimer` 一本)が切れていた。停止を「コンテナ離脱時のみ」に限る `onMouseOut` と**粒度が非対称**で、サムネ枠へ入り直すまで再開しない（＝ユーザーはサムネを見ているつもりなのに止まる＝「極稀」に感じる）。
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

> 🔴 **この節の実装はもう存在しない。現行方式は項目AE（常設ループ1本＋期限表）。**
> 以下に出る `_thumbTimers` / `_runThumbCycle` / `_scheduleThumbCycle` / `_thumbGen` / `_syncThumbTimers` / `stopThumbnailUpdate` は**すべて撤去済み**で、grep しても当たらない。
> 残してあるのは**ドリフトという設計思想の出自**（一斉更新を嫌うUX要望）を伝えるため。実装の参照先としては使わないこと。
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
1. `updateThumbnail` の入口で `document.hidden` なら即 `onComplete`/`onSettled` を呼んで返す。背景では rAF が来ない＝実行しても1枚も更新できないので、待たせる意味がない。`_thumbTick`（当時は `_runThumbCycle`）が同じ判定で見送るのと揃えた。**この判定は `getProgramInfos`（localStorage 依存）より手前に置くこと**（順序を入れ替えると検証が例外で落ちるようにしてある）。
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
- `stopAllTimers`（サイドバー閉）は `autoNext` の取り消しだけになった（※その後 項目AF で `clearTimer` から `cancelScheduledNavigation()` に変更。タイマーだけ止めるとフラグが残って自動移動が二度と動かなくなるため）
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

## ✅ AI. 定期更新の並べ替えに FLIP を配線した（2026-07-29）

`flipReorder`（First/Last/Invert/Play）は実装済みだったが、整列確定機構の撤去とともに**呼び出し元が0件**になっていた（`export` のみ残置）。定期更新で順位が入れ替わる場面へ配線した。

### なぜ入れるか

**入れ替わり自体は FLIP の有無に関係なく起きている。** FLIP は動きを足すのではなく、既に起きている**瞬間移動を目で追える形にする**だけである。ユーザーが何もしていないのにカードが飛ぶのは「一斉に切り替わるのが気持ち悪い」（サムネのドリフト設計の起点）と**同じ種類の不快さ**で、この拡張の既存の思想に沿う。

| 場面 | FLIP |
|---|---|
| 定期更新で順位が入れ替わった | **通す**（ユーザーは何もしていないのにカードが動く） |
| 設定で並び順を変えた | **通さない**（自分で起こした変化なので瞬時でよい） |
| 初回描画 | 自動的にアニメ無し（既存カードが無く First が取れないため `moved` が空） |

アニメ時間は `reorderFlipDurationMs`（既定300ms）。**0 にすれば実質無効**にできる。

### 🔴 R-2（メモリモデル導入）との関係

**FLIP は R-2 の最大の失敗を可視化するカナリアになる。**

R-2 の禁止事項の筆頭は「`_sortOrderChanged` をモデル同士の比較にすると**毎周期 `replaceChildren` が走る**」だった。この失敗を踏んでも、**FLIP が無ければ症状はほぼ見えない**（レイアウト再計算が余分に走る程度）。FLIP があれば**全カードが毎周期スライドする**ので、誰でも即座に気づく。

同じく「描画を非同期化するな」という禁止事項も、FLIP が **First/Last の実測のために同期実行を要求する**ため、破った瞬間にアニメが壊れて見える。

> ⚠️ **当初ここに「FLIP を入れれば R-2 に実利の裏付けが付く」と書いていたが、これは誤読だった。**
> 好転したのは「**R-2 をやった場合の失敗が即バレするようになった**」ことであって、**R-2 に価値が生まれたわけではない**。
> R-2 は最終的に「モデル化する対象が存在しない」として却下している（項目AO）。

> なお上の「カナリアになる」という指摘自体は生きている。**FLIP は並び順まわりの不変条件が壊れたことを目視で知らせる**ので、
> 比較器の三重定義を解消した（項目AR）今も、そこが再び食い違えば全カードが毎周期スライドして即わかる。

### 実装上の注意

- **`replaceChildren` と `sortProgramsInContainer` は `flipReorder` の中で同期的に**完了させること。外に出すと First/Last の実測が噛み合わない
- コールバックに `await` / `rAF` / `setTimeout` を挟まないこと。**デッドコードだった `appState.update.isInserting` が生き返り**、`updateThumbnail` が即 `onComplete` を返して**サムネが「更新0回・エラー0件」で止まる**
- 動くサムネのオーバーレイは `.program_thumbnail` の子孫なのでカードごと `transform` で動く。ホバー判定も座標ではなく `closest()` なので**干渉しない**

## ✅ AJ. 他タブで並び順を変えてもこのタブが追随しなかった（2026-07-29）

`chrome.storage.onChanged` の `programsSort` 分岐が **`options` の値を入れるだけで並べ替えを呼んでいなかった**。

```js
if (changes.programsSort) options.programsSort = changes.programsSort.newValue;  // ← 旧: これだけ
```

自タブで変えた時は `optionsHandler` の change リスナが即ソートするが、**そのリスナは変更したタブでしか発火しない**。`onChanged` は他タブ由来の変更を受け取る唯一の経路なので、ここで並べ替えないと「他タブで並び順を変えたのに、このタブは古い順序のまま」になる。

「次の定期更新で直る」とも限らない。構造変化が無い周期は `_sortOrderChanged` が「今のDOM順」と「あるべき順」を比べて初めて直るので、**最大1周期ぶん食い違う**。

> **設定の伝播は3系統ある**（値の反映 / 副作用の実行 / 表示の更新）。`onChanged` に分岐を足す時は、
> **「値を入れるだけで足りるのか」を毎回確認すること**。`updateProgramsInterval` は `resetSidebarSchedule`、
> `sidebarTheme` は `applyTheme`、`animatedThumbnail` は `setAnimatedThumbnailEnabled` を呼んでいる。
> 値の代入だけで済んでいるのは `autoOpen`（次回ロードで効く）だけである。

`verify:loop` に3項目（並び順・更新間隔・テーマの追随）を追加した。

## ✅ AK. 既存カードのその場更新が「後から埋まる情報」を反映していなかった（2026-07-29）

`updateSidebar` のその場更新が **active-point / data-api-index / タイトル / リンク先の4つしか**反映していなかった。カードは作り直さない設計（要素の再利用が TTL・エラーリスナ・動くサムネのオーバーレイ・ホバー状態を同時に生かしている）なので、**ここで反映しない情報は生成時のまま固定される**。

### 実害1: 配信者名・アイコンが「配信者名不明」で固定される

生成時に配信者名/アイコンが空だった番組（当時は channel と、notifybox 先行の新着）は、`fillMissingDetails` や次周期のフォローAPIが**後から**埋めても、その場更新が見ていないためカードに出ない。

**アイコンは生成時に空だと要素そのものが作られない**（`makeProgramElement` は `if (icon_url)` で分岐）ので、後から**挿入**する必要がある。

### 実害2: 一度 loading.gif に落ちるとページ再読込まで戻らない

`img[data-src]`（静止サムネの戻り先）は `makeProgramElement` が生成時に1回書くだけ。生成時に `thumbnailUrl` が空だと空文字で固定され、`restoreStaticThumbIfLoading` の

```js
const dataSrc = img.getAttribute('data-src')
if (!dataSrc) return          // ← ここで塞がる
```

で復帰経路が閉じる。後から `fillMissingDetails` が `thumbnailUrl` を埋めても届かない。

### 修正

導出ロジックを **`deriveCardFields(data)` に集約**し、生成（`makeProgramElement`）とその場更新（`applyProgramInfoToCard`）の**両方から呼ぶ**。

> ⚠️ **2箇所に同じ導出を書かないこと**（doc/02 設計原則 1-b）。片方だけ直して食い違う。
> 検証で「`配信者名不明` のコード中の出現が1箇所（`deriveCardFields`）だけ」を担保している
> （2026-07-31 に旧 notifybox 生行用の分岐を削除したため 2箇所→1箇所。→ 項目AT）。

`applyProgramInfoToCard` が更新するのは タイトル / リンク先 / 配信者名 / アイコン（無ければ挿入）/ `data-src` の5つ。

> ⚠️ **`img.src`（今表示している画像）は触らない。** 差し替えはサムネ更新ループの仕事であり、
> ここで書くと TTL・バックオフ・`thumbLive` の状態と食い違う。

### 副作用（意図したもの）

`data-src` が更新されるようになったことで、これまで `if (!dataSrc) return` で走らなかった **`restoreStaticThumbIfLoading` のバックオフ経路が走り始める**。これは修正の目的そのもの（一度落ちた静止サムネが復帰できるようになる）。

## ✅ AL. `isInserting` は到達不能だが、削除せず「鳴る罠」にした（2026-07-29）

`appState.update.isInserting` は `updateSidebar` の DOM差し替え区間で `true` → `false` になるが、**その区間に `await` が1つも無い**。単一スレッドである以上、別のコールバックが途中で `true` を観測することはできず、`updateThumbnail` の早期returnは**到達不能**である。

### 削除しなかった理由

この分岐は入ると **`onComplete`/`onSettled` を呼んで「完了した」と嘘をつく**。

```
描画が非同期化される
  → isInserting が観測可能になる
  → updateThumbnail が「完了」と報告して即 return
  → _thumbTick は成功扱いで次の期限を +20秒 進める
  → **サムネが「更新0回・エラー0件」のまま静かに止まる**
```

原因に辿り着けない類の壊れ方である。削除すれば保護も消え、残せば黙って壊れる。
→ **入ったら1回だけ `console.warn` を出す**ようにした（毎サイクル出すと埋もれるので1回）。

### そもそも入らないよう機械で守る

`verify:loop` に、差し替え区間（`isInserting = true` 〜 `false`）に **`await` / `rAF` / `setTimeout` / `.then` が無いこと**の検証を入れた。FLIP を配線した今、この不変条件は前より重要になっている（FLIP も同期実行を要求する）。

> `flipReorder` の**内部**で `rAF`/`setTimeout` を使うのは可。`reorderFn`（DOM構造の変更）は同期で完了する。
> 禁止しているのは**差し替え区間に直接書くこと**。

### ⚠️ 検証を書く時の罠（4回踏んだ）

**固定幅でコードを切ってはいけない。**

```js
body('updateThumbnail(...)', 1400)   // ❌ コメントを足すと判定対象が窓から押し出される
body('updateThumbnail(...)', '終端の実際の文字列')  // ✅ 内容で指定する
```

本項目の実装でコメントを追加したところ、R-5 の検証が「実装は正しいのにNG」を出した。**テストが実装より脆いと、直すたびに嘘のNGが出る。** 検証内の全スライスを終端アンカー方式へ変更した。

---

## ❌ R-2（メモリモデル導入）は却下 → 項目AO を見ること

2026-07-29 の夜は「判断待ち」でここに置いていたが、翌日の調査で**モデル化する対象が存在しない**と結論した。

**結論と根拠は項目AO に集約してある。** この節は、当時の経緯を探して戻ってくる人のための道標として残す。

| 当時の懸念 | その後 |
|---|---|
| 「検証が届かない領域なので危険」 | **解消**。モックDOMで本物の `updateSidebar` を走らせる土台ができた（項目AM）。ただしそれで見えたのは R-2 の価値ではなく、**既存バグ3件**だった |
| 「FLIP がカナリアになるので評価が好転した」 | **半分は誤読**。好転したのは「R-2 をやった場合の失敗が即バレするようになった」であって、**R-2 に価値が生まれたわけではない** |

調査の副産物として出た実バグ: 項目AM（FLIP が一度も動いていなかった）／項目AP（古い取得が新番組を消す）／項目AR（比較器の三重定義）。
**R-2 の最大の価値は「やらなくてよいと確かめる過程で、それまで一度も動かしていなかった描画処理を初めて実行したこと」だった。**

## 🔴 AM. FLIP は配線した翌日まで**一度も動いていなかった**（2026-07-30 修正）

`flipReorder` を呼ぶ**前**にフラグメントを組んでいた。

```js
const frag = document.createDocumentFragment();
for (const id of orderedIds) { ...; frag.appendChild(el); }   // ← 既存カードが container から抜ける
flipReorder(container, () => { container.replaceChildren(frag); ... });
```

`frag.appendChild(既存カード)` は DOM 仕様上そのカードを**現在の親から取り外す**（pre-insert → adopt → 旧親から remove）。
結果、`flipReorder` が First を測る時点で **container は空**。`firstRects` が空 → Invert で全要素が `firstRects.get(el) === undefined` → `moved` が空 → `if (moved.length === 0) return`。

**例外もログも出ない。** 「アニメが出ない」を目視で疑うしかない壊れ方だった。実際、利用者に「FLIP の感触を見てほしい」と依頼し、「確認しました」という返答まで受け取っている。**動いていないものを一緒に見ていた。**

### 直し方

フラグメントの組み立てを `reorderFn` の**中**へ移す。同期のまま（FLIP の要求を満たす）。

### なぜ気付けたか — 検証の穴が塞がった瞬間に落ちた

`verify:loop` は `updateSidebar` を**丸ごとスタブ**に差し替えていた。周期・セッション・二重実行はそれで足りるが、**描画経路そのもの**（差分更新・構造変化判定・削除検知・並べ替え・FLIP）は一度も自動検証されていなかった。

`scripts/mock-dom.mjs` ＋ `scripts/render-harness.mjs` を入れて**本物の `updateSidebar` を走らせた初回**にこれが落ちた。

> 教訓: **「静的にコードを読んで正しそう」は、実行して確かめたことにはならない。**
> FLIP の配線は昨日レビューも通っている。読んだだけでは `appendChild` が親から外す挙動まで追えなかった。

### モックDOMの方針

jsdom を入れていない。依存が増えるうえ、中身の読めない箱を挟むと「モックが悪いのか実装が悪いのか」の切り分けができなくなる。必要なAPIだけを**中身が見える形で**用意している。
`getBoundingClientRect` は「カードを縦に1枚100pxで積む」固定モデルで、**親の中での現在位置から計算する**。だから並べ替えれば戻り値が変わり、FLIP の差分がちゃんと出る（＝FLIP経路が実際に走る）。

---

## ⚠️ AN. 「放送中0件」のとき、件数表示とカード数が食い違う

`updateSidebar` は取得が成功して放送中0件だったとき、**カードは消さずに件数表示だけ 0 にする**。

```js
if (merged.length === 0) {
    this.updateProgramCount(0);   // ヘッダは「0」
    return sessionId;             // カードはそのまま画面に残る
}
```

画面には番組が並んでいるのにヘッダが 0 という状態になる。カードを消さないのは「一時的な空応答で全消しされるのを避ける」防御として妥当だが、**件数だけ先に 0 になるのは筋が通らない**。

また件数は `livePrograms.length`（＝**取得できた数**）で、実際に描画できた数ではない。カード生成が失敗した番組があると件数が実際より多く出る（生成失敗は番組ごとの try/catch で握られる）。

現状は**そのまま**にしてある（見た目の変更になるため）。`verify:loop` の描画テストで現挙動を固定しているので、変えれば検出される。

---

## ✅ AO. 「DOM を唯一の真実にしておいてよい」根拠を機械で守る

R-2（描画モデル導入）を検討した結論として、**モデルは持たない**ことにした（判断の経緯は下記）。
ただし「持たなくてよい」には前提がある。前提が黙って崩れないよう `verify:loop` で固定した。

| 根拠 | 崩れると何が起きるか | 検証項目 |
|---|---|---|
| DOM を読んでから差し替えるまでが**同期**（間に `await` が無い） | 読んだ内容が差し替え時点で古くなりうる＝作り直しが正しくなくなる | AO-1 |
| カードの増減が **`container.replaceChildren` の1箇所だけ** | 「どこかで勝手に増減している」経路ができ、DOM を読む側が信用できなくなる | AO-2 |

読み取り区間は `const existingMap = new Map();` 〜 `isInserting = false;` の **5178文字**。
項目AL は `isInserting = true` 以降しか見ておらず、**`existingMap` を組む所から差し替え直前までが無防備**だった。

> 🔴 **AO を「だから updateSidebar は安全」と読んではいけない。**
> AO が守るのは「DOM から毎周期作り直す方式の正しさ」**だけ**。
> 実際、項目AP のバグで古かったのは DOM の読み取りではなく**取得結果**（`await Promise.all` より前に確定）で、
> AO の区間の**外側**だった。範囲を取り違えると、守れていない所を守れていると誤認する。

### R-2 をやらないと決めた理由

独立に3案を設計させ、3人の審査員に採点させ、敵対的に潰した結果、**「モデル化する対象が存在しない」**という結論で一致した。

モデル化しうる候補は `updateSidebar` 内の `existingMap` / `orderedIds` / `newElements` / 削除判定 / 件数の5つだけ。
そしてこれらは**すべて1回の呼び出し内で完結するローカル変数**であり、しかも上記のとおり同期区間にある。

> 同期区間の中では DOM が背後で変わりようがない。
> だから毎周期 DOM から作り直すのは**ゼロコストで常に正しく、かつ self-healing**（食い違っても次の周期で自動的に直る）。

インスタンスフィールドへ昇格させると、得るものが無いまま**未更新パスが4種**増える:
早期return 3本 ／ 番組ごとの try/catch ／ 全体 try/catch の例外経路 ／ UpdateManager を通らない並べ替え（`main.js:451`・`optionsHandler.js:69`）。
しかも「`_sortOrderChanged` をモデル同士の比較にしない」を守る限り、**モデル側から食い違いを検知する手段が無い**。

審査で見つかった具体的な破綻の例（狭い範囲でやる案）:
`existingMap` の構築（その場更新の**前**）と `_sortOrderChanged`（その場更新の**後**）を1つのスナップショットで置き換えると、
`existingMap` 構築時点の `active-point` / `data-api-index` は**前周期の値**で、DOM順はすでにその値で整列済み。
→ `_sortOrderChanged` が常に false を返し、**並べ替えが永久にスキップされる**。

**「同期化されていて、変更点が1箇所」は、モデルを置く動機ではなく、置く必要が無いことの証明だった。**

---

## 🔴 AP. 遅れて着地した古い取得が、新番組のカードを消していた（2026-07-30 修正）

`updateSidebar` は3経路から呼ばれるが、**AutoNext 経路（`main.js`）だけ `_isUpdateInFlight()` ガードが無い**（定期tick `_sidebarTick` は `_isUpdateInFlight()` で、手動更新は `isPerformingManualUpdate` で弾いている）。よって2本が重なる。

そして `livePrograms` は**取得を始めた時刻のスナップショット**であって、着地時点の現実ではない。
フォローAPIは1ページずつ `await` で回す逐次ページングなので、フォローが多い日は数秒かかる。

```
t=0     定期tick A が取得開始（この時点で lv400 は存在しない）
t=0.5s  新番組 lv400 が始まる
t=1.0s  視聴中番組が終了 → AutoNext が updateSidebar B を開始
t=1.8s  B 着地 → [400,100,200]   ← 新番組が出る
t=2.5s  A 着地 → [100,200]       ← **削除検知が lv400 を「終わった番組」と誤判定して消す**
```

復活は次の周期なので、設定によっては**最大180秒ぶん表示されない**。
`notifybox` とフォローAPIの和集合まで用意して「新番組を速く拾う」ことに投資している（項目AD）のに、その成果をここで捨てていた。

### 🔴 セッションの相乗りは描画の排他ではない

これを見落とした原因がここ。`startSession()` が `null` を返すのは「スピナーの持ち主は別にいる」という意味**だけ**で、取得も描画も普通に進む。項目AG（セッションは奪えない）を「だから二重に走らない」と読むのは誤り。

### 直し方 — 世代トークン（ただし昨日消したものとは別物）

入口で `++this._renderGen` を採番し、取得の `await` 明けに自分が最新か確認する。古ければ描画せず降りる。

> 昨日 AB-2 で**世代トークンを廃止**したのは「タイマーの同一性」を照合していたやつで、常設ループにしたら不要になったもの。
> こちらは「**取得結果の鮮度**」の照合で、別の問題。同じ名前でも役割が違う。混同して「また世代管理を入れるのか」と読まないこと。

判定は `await` の直後・描画に触る前に置くこと。後ろに置くと `apiErrorElement` や `updateProgramCount` を古い結果で上書きする。
セッションは呼び出し元に閉じさせる必要があるので `sessionId` は返す。

### ⚠️ 項目AO を「だから安全」と読んではいけない

AO は「DOM を**読んで**から差し替えるまでが同期」を守っている。だが本件で古かったのは **DOM の読み取りではなく取得結果**で、それは `await Promise.all([fetchLivePrograms, _refreshDetailsViaScrape])` より**前**に確定している。AO の区間外である。

**AO が守るのは「DOM から作り直す方式の正しさ」だけ。「updateSidebar 全体が安全」ではない。**
この区別を反証担当が指摘するまで、私は AO を後者の意味で書きかけていた。

---

## ⚠️ AQ. 調査用サブエージェントを同じ作業ツリーで走らせない

R-2 の設計調査で8体のサブエージェントを並列に走らせた。読み取り専用のつもりだったが、1体が反証実験のため `git checkout -- src/managers/UpdateManager.js` を実行した。それが私の `git add -A` の**直前**に当たり、**FLIP 修正の本体がコミットから丸ごと抜けた**（`575ad14` は doc と scripts だけ）。

コミットメッセージには「検証: verify:loop 全項目合格」と書いてある。**履歴が嘘をついた状態**で push まで済んでいた。

発覚したのは**その反証担当エージェント自身が報告したから**。気付かなければ「修正した」と言いながら FLIP は動かないままだった。

**対策**: 調査系エージェントには `isolation: 'worktree'` を使う。使わないなら、プロンプトで書き込み・git 操作を明示的に禁じる。
そして**コミット後に `git show --stat` で意図したファイルが入っているか確認する**（`git status` が「クリーン」でも、入れたいものが入っているとは限らない）。

---

## ✅ AR. 並び順の比較器を1箇所に統一した（`utils/programOrder.js`）

同じルールが**3箇所**に別々に書かれていた。

| 場所 | 役割 |
|---|---|
| `utils/sorting.js` | 新着順で**実際に並べ替える** |
| `render/sidebar.js` `sortProgramsByActivePoint` | 人気順で**実際に並べ替える** |
| `UpdateManager._sortOrderChanged` | 上の**両方を再実装**して「並べ替えが要るか」を判定する |

3つ目が上2つと食い違うと壊れ方が2通りある。

- 判定だけが厳しい方へずれる → 「並べ替えが要る」と言い続けるのに、並べ替えてもその順序にならない
  → **毎周期 `replaceChildren` が走る**。FLIP が本当に動くようになった今、これは
  **ユーザーが何もしていないのに全カードが毎回スライドする**という形で表に出る。
- 逆向きにずれる → 必要な並べ替えが**永久にスキップ**される。

比較器を `utils/programOrder.js` に集約し、3箇所とも import して使う形にした。
`grep "getAttribute('active-point')\|dataset.apiIndex"` が `programOrder.js` 以外で0件であることを確認済み。

### 移すときに変えなかったこと

**tie-break を「改善」しないこと。** 見た目が変わる。

- 人気順に tie-break は無い。`parseFloat` が NaN を返す経路もある（属性が無いカード）。NaN との比較は常に false なので、`Array.prototype.sort` の安定性で現状順が保たれている。ここに tie-break を足すと同点番組の並びが変わる。
- 新着順の第2キー（lv番号の降順）は**実際には効いていない**。`data-api-index` は `livePrograms.forEach` の添字なのでカード間で常に一意だから。属性が欠けたカードが混ざった時の保険として残してある。

### ⚠️ 「同一テキストであること」を静的検査で守ろうとしないこと

一度その案が出たが、**書いた瞬間に赤になる**。3箇所は元々インデントも変数名も違っていて、空白除去や識別子正規化で無理に通すと「仕様ではなく整形を見ているだけの検査」になる。
守るべきは**呼び出し先が1つであること**なので、上の grep のほうが目的に合う。

---

## ✅ AS. FLIP の発火条件（ソート設定で頻度が全く違う）

FLIP は `structuralChange` が立った時だけ走る。立つ条件は**3つ**あり、うち1つは「増減が無くても順位が入れ替わった」＝`_sortOrderChanged`。

| ソート設定 | 定期更新で順位が動くか | FLIP が出る場面 |
|---|---|---|
| **人気順**（`active`） | **数字が伸びた時だけ動く**（2026-07-31〜）。旧スコアは経過分で割っており、**データが変わらなくても**分母の増え方の違いだけで動いていた（実測: 2分経過で70件中58件） | 番組が伸び縮みした時 |
| **新着順**（`newest`・既定） | **動かない**。`data-api-index` は `beginAt` 降順の位置で、同じ番組集合なら常に同じ | 番組が**増減した時だけ** |

新着順で視聴者数が激変しても並びは1ミリも動かない（＝アニメも出ない）。これは正しい挙動。
新着順で FLIP が出るのは「新番組が始まって先頭に入り、下が押し下げられる」「番組が終わって下が繰り上がる」の2場面で、**まさにそれを目で追えるようにするのが目的**。

R-2 とは無関係に成立する（FLIP は描画された DOM の実測だけで動く）。
`verify:loop` の `flipOnReorder` 群で両モードを固定してある。

## ✅ AT. 新着カードが「配信者名不明・アイコンなし・ローディング画像」で立っていた（2026-07-31 修正）

利用者からの指摘:「**昔はサムネが生成されるまでユーザーアイコンが出ていた。今はローディング画像**。名前も出ないしアイコンも出ない」。
3つの症状は別々のバグではなく、**`_mergeSources` が notifybox の行を `id` と `title` だけに削っていた**という1点から出ていた。

### notifybox は id と title だけではない（実測）

```json
{ "id": "341121933", "title": "…",
  "thumbnail_url": "https://secure-dcdn.cdn.nimg.jp/nicoaccount/usericon/5255/52553742.jpg?…",
  "community_name": "配信者の表示名", "provider_type": "community", "elapsed_time": 137 }
```

`community_name` / `thumbnail_url` は**コミュニティ廃止後もキー名だけ残っているレガシー名**で、中身は
**配信者名**と**配信者アイコン**である。旧実装（v1.x）はこの行をそのままカード化していたので、
アイコンが名前欄にもサムネ枠にも出ていた。それが「昔は出ていた」の正体。

`_mergeSources` は notifybox 由来の番組に対し `contentOwner:{id:'',name:'',icon:''}` / `thumbnailUrl:''` の
**空レコードを合成**していた。フォローAPIが同じ番組を拾うのは **20〜101秒後**、カードに反映されるのは
さらに次の周期（60〜180秒）なので、**新着カードは最悪で数分間、名前もアイコンもサムネも無い**状態だった。

> `deriveCardFields` には notifybox の生行を読む分岐（`data.community_name` / `data.thumbnail_url`）が
> 残っていたが、合成レコードは常に `lv` 付き id を持つため**到達しない死にコード**になっていた。
> 「昔の挙動」がそこに書かれたまま動かない状態が、原因の特定を遅らせた。今回削除。

### サムネ枠がローディング画像になっていた理由（2段構え）

1. notifybox のアイコンを捨てていた（上記）。
2. 詳細APIの `thumbnailUrl` は昔**コミュニティアイコン**（`comch/community-icon/128x128/co6015020.jpg`）で、
   これが繋ぎ画像だった。コミュニティ廃止後は **`…/community-icon/128x128/404.jpg`（汎用404画像）** に変わり、
   現行実装ではそもそも採用しない（ライブスクショのみ）。

→ 繋ぎの優先順位を **ライブサムネ → 静止サムネ → 配信者アイコン → `loading.gif`** に変更。

> ⚠️ **アイコンは表示のフォールバックにだけ使うこと。** `programInfo.thumbnailUrl` に入れると
> `resolveLiveThumbnailBaseUrl` がライブサムネとして拾い、**アイコンを20秒ごとに取り直す**
> （項目AA の再発）。加えて `_fetchLiveThumbIfPendingYoung` の `if (hasLive || info.thumbnailUrl) return`
> に引っかかり、**本物のスクショの追撃が止まる**。検証で固定してある。
>
> 繋ぎ画像を出した `<img>` には `dataset.thumbLive='0'` を立てる。動くサムネの末尾スロットが
> 非ライブ画像を「最新コマ」として混ぜないため（成功時に `applySuccess` が `'1'` へ戻す）。

### channel のアイコンは永久に空だった（同時修正）

フォローAPIの `programProvider` は **channel だと id もアイコンも空**で、代わりに
`socialGroup:{id:'ch…', name, thumbnailUrl}` にチャンネル名とチャンネルアイコンが入る
（2026-07-31 実測・70件: community 67件は `programProvider.icon` が 67/67、`socialGroup` は 0/67。
channel 3件は `icon` 0/3、`socialGroup` 3/3）。

`fillMissingDetails` の対象条件は「**名前が空**または サムネが空」なので、**名前は埋まっている channel は
永久に対象外**＝アイコンが出ないまま固定されていた。`socialGroup` から拾うようにして解決（詳細APIは不要）。

> doc/09・doc/03・doc/05 にあった「フォローAPIは channel の `programProvider` を返さない」は**誤り**。
> 返るが id とアイコンだけが空、が正しい。今回すべて訂正した。

### 「コミュニティ」表記の一掃

ニコ生のコミュニティ機能は廃止済みなので、**カードのその欄に出るのは配信者名**（user はユーザー名 /
channel はチャンネル名）。DOMクラス `.community`/`.community_name` → **`.provider`/`.provider_name`**、
内部名 `community_name` → `provider_name`、フォールバック文言「コミュニティ名不明」→「配信者名不明」へ改名。
API 側の語彙（`providerType:'community'` / `community_name` キー）はニコ生の仕様なのでそのまま受け取り、
`mapProviderType`（`utils/providerType.js` に集約）と `mapNotifyboxRowToInfo` が境界で内部語彙へ変換する。

### 鳴る罠

notifybox の応答から `community_name`/`thumbnail_url` が消えたら、`fetchLivePrograms` が**1回だけ**
`console.warn` する。名前とアイコンが黙って消える壊れ方はエラーが出ず、まさに今回のように
「気づいたら出なくなっていた」になるため（項目AL と同じ考え方）。

### 検証

`verify:loop` に `AT` 系14項目を追加（`_mergeSources` の写像・アイコンURLからのID復元・
`thumbnailUrl` に入れないこと・実描画経路で名前/アイコン/繋ぎ画像/`thumbLive` が出ること・
channel の `socialGroup` アイコン）。`render-harness` の `apiProgram()` は channel を実測どおり
（`programProvider` にアイコン無し＋`socialGroup` あり）に修正した。**両方入っている形で作ると、
実際には出ないアイコンをテストが通してしまう。**

### やり残し（意図的）

notifybox の `elapsed_time`（放送開始からの経過秒）は使っていない。新着順の基準は従来どおり
「notifybox の返却順を保つ擬似 beginAt」のまま。使えば実際の開始時刻で並べられるが、
並び順と `_fetchLiveThumbIfPendingYoung` の若さ判定の挙動が変わるため、別件として保留した。

## ✅ AU. 自動移動が「番組によっては毎回不発」だった（2026-07-31 修正）

利用者からの指摘:「自動枠移動が機能しなかったことがある。毎回ではない」。

### 原因: 終了判定が「出ないことがあるボタン」を必須にしていた

旧 `detectProgramEndGuide()` は3つを **AND** で要求していた。

```js
hasAnnouncement && hasNextActionArea && hasRequestButton   // ← 3つ目
```

ニコ生の `ProgramEndGuide` コンポーネント（2026-07-31 に `nicolib` / `pc-watch` バンドルから復元）:

```jsx
<div class="…program-end-guide…">
  {enquete && <UserCommunicationSatisfactionLevelEnquetePanel/>}   // これが出る時は下は出ない
  {!enquete && <>
    <div class="…announcement…"/>                                  // 「この番組は終了しました」＝無条件
    <div class="…next-action-area…">                               // 無条件
      {(l||c) && <div class="menu-area">
        {c && <BroadcastRequestEnlightenmentSection/>}             // ← リクエストボタンはこの中だけ
      </div>}
    </div>
  </>}
</div>
```

そのリクエスト欄の表示条件（同バンドル）:

```js
get shouldShow() {
  return !!stores.program.visualProviderTypeIsCommunity      // ① ユーザー生放送のみ
      && !stores.user.state.isBroadcaster                    // ② 自分が配信者でない
      && (!stores.user.state.isLoggedIn
          || !!stores.broadcasterBroadcastRequest.isEnabled) // ③ 配信者がリクエストを有効にしている
}
```

つまり **チャンネル/公式番組では常に出ず**（①）、ユーザー生放送でも **配信者がリクエストを無効に
していれば出ない**（③。ログイン済み視聴者はこの分岐）。「毎回ではない」の正体はこれで、
**番組の種類と配信者の設定で決まる**ため、同じ配信者では毎回失敗し別の配信者では毎回成功する、
という出方をしていた。エラーもログも出ないので気付けない。

### 修正

判定を「**`announcement` ＋ `next-action-area`（視聴者が見る形）**」または
「**満足度アンケートパネル**（配信者本人の形）」に変更。前2つは番組種別・配信者設定によらず
無条件に描画されるので、これで種別に依存しなくなる。

> 🔴 **リクエストボタンを条件に戻さないこと。** 逆に「ガイド枠があるだけで true」にもしないこと
> （中身が組み上がる前の一瞬で誤爆する）。誤爆防止の負のテストを検証に入れてある。

### 併せて修正: 待ちがハングすると自動移動が二度と動かなくなる欠陥

`startWatcher` のコールバックは `selectingNext = true` にしてから `await updateSidebarFn()` する。
リスト取得の `fetch` にタイムアウトは無いので、応答が返らなければこの await は返らず、
**`finally` に到達せずフラグが立ったまま残る**。このフラグはコールバック先頭の多重進入ガードなので、
以後そのページでは自動移動が二度と動かない（項目AF と同型）。
`Promise.race` で `autoNextListWaitMaxMs`(15秒) を上限にし、打ち切ったら今DOMにあるカードから選ぶ。

### 検証（実ブラウザ・番組終了を待たずに再現できる）

`verify:e2e` に4項目を追加。実測のクラス名そのままで終了ガイドをDOMへ流し込み、モーダルが出るかを見る。

| ケース | 期待 |
|---|---|
| リクエストボタン**無し**（＝チャンネル番組・リクエスト無効の配信者） | 出る |
| リクエストボタン**有り**（従来通り） | 出る |
| 満足度アンケートのみ（配信者本人） | 出る |
| `announcement` だけ（組み上がる前の一瞬） | **出ない** |

**旧実装に戻して実行し、1番目と3番目が NG になることを確認済み**（テストが本当に噛むことの確認）。
この4ケースは番組の終了を待つ必要がないので、以後の改修でも常に回せる。

### 未着手だった2件 → **2026-07-31 に両方とも解消**（項目AX）

1. **裏タブでカウントダウンが伸びる**: `setInterval(…,1000)` で10回数える方式のため、5分以上隠れて
   無音のタブでは Chrome のタイマー間引き（1分に1回）で10秒が最大10分に化ける。
   `Date.now()` の期限で持てば遅延は最大1分程度に縮む。
2. **別タブでサイドバーを閉じるとカウントダウンが取り消される**: `chrome.storage.onChanged` の
   `isOpenSidebar` → `handleSidebarOpenStateChange(false)` → `stopAllTimers()` →
   `cancelScheduledNavigation()`。視聴中のタブは何も操作していないのに中止される。
   「閉じたら止まる」という既存の約束（SPECIFICATION F-12）を崩すかどうかの判断が要る。

## ✅ AV. 動くサムネに「今表示している絵」が入らないことがあった（2026-07-31 修正）

利用者からの再指摘:「動くサムネのコマに最新のコマ（ホバーしていない時の画像）が含まれていないことがたまにある」。
項目Yで直したはずの症状の再発だが、**別の経路**だった。

### 原因: 同じ絵を2回ダウンロードしていた

②ON時、1周期でライブサムネを**2回**取りに行っていた。

```js
const pre = new Image()
if (feeding) pre.crossOrigin = 'anonymous'   // ① 給餌用（この絵がアニメのコマになる）
pre.onload = () => { applySuccess(); animThumbFeed.ingest(card.id, pre) }
// applySuccess の中: img.src = urlForAttempt // ② 静止サムネ用（crossOrigin なし＝別リクエスト）
```

実測（harness のリクエストログ。`cache-control: max-age=60` でも2回とも飛ぶ）:

```
3:preload 4:static  5:preload 6:static  7:preload 8:static  9:preload 10:static
```

そして**この2つは同じURL**なので、末尾スロットの発火条件

```js
return live !== b.lastSrcUrl   // 静止が最新blobより「先へ進んだ」か
```

が**常に偽**になり、安全網が一度も働けない。よって②が①と違う絵を受け取った瞬間
（2回の取得の間にスクショが1枚進んだ／エッジの状態が違った）、
**静止サムネが映している絵はアニメのどのコマにも存在しない**状態になる。

実ブラウザで再現（2回目の取得に別の色を返す差し替えを用意）:

```
静止サムネの色番号: 12
アニメのコマ列:     3 → 7 → 11 → 13 → …   ← 偶数（static側）が1つも入っていない
```

「たまに」なのは、2回の取得が違う絵を返す確率が低いから（スクショ更新は約20秒に1回、
2リクエストの間隔は数十ms）。普段は一致するので表に出ない。

> 項目Yで末尾スロットを「状態ベース」に変えたが、**「先へ進んだか」の部分だけURL文字列比較のまま
> 残っていた**。当時の「真の最新は blob か末尾スロットで必ず映る」という結論は、この経路で破れる。

### 修正: 同じ1枚を共有する（判定を不要にする）

`ingest` が**コマ化した画像そのもの**（blobから作った object URL と通し番号 seq）を返し、
①はそれを静止サムネの表示にも使う。「静止サムネ＝最新コマ」が**構造的な不変条件**になるので、
URL比較も時刻比較も要らない。副次的に**②ON時のライブサムネ取得が1周期2回→1回**になった
（実測: 同じ観測時間で 20回 → 10回）。

- 末尾スロットの判定は **seq の一致**へ（`dataset.thumbSeq` と最新コマの seq）。一致しなければ安全側に倒して足す。
  URL文字列を見なくなったので、**channel のURL不変で末尾スロットが恒常無効**という項目Yの残ギャップも消えた。
- seq は**バッファをまたいで単調増加・再利用しない**（IndexedDBからの復元分も採番し直す）。
  バッファごとの連番だと、復元したフレームが過去の `thumbSeq` と偶然一致して「同じ絵」と誤判定しうる。
- blob URL の所有者は①（カード）。**リングバッファ側のURLを貸さない**（eviction や機能OFFの
  revoke で表示中の画像が消える）。差し替えは**1世代遅れで** revoke し、リストから外れるカードは
  `releaseThumbnailBlobs` で解放する（外れた要素はDOMから辿れなくなるため）。
- 給餌できない時（CORS汚染・機能OFF・`toBlob` 失敗）は従来どおりURL表示にフォールバックし、
  `thumbSeq` を消す＝末尾スロットが働く側に倒れる。

### 検証（実ブラウザ・目視不要）

`verify:e2e` に AV 系5項目を追加。取得ごとに違う単色PNGを返し、**同じURLの2回目にはさらに別の色**を返す
意地悪な差し替えのまま、①静止サムネの画素の色が②アニメのコマ列に含まれるか、を機械判定する。

| 検証 | 見ているもの |
|---|---|
| 1URLあたりの取得が1回 | 二重ダウンロードの再発 |
| 静止サムネが blob＋`thumbSeq` を持つ | 「同じ1枚を共有」が効いているか |
| アニメが2コマ以上めくれる | そもそも再生できているか |
| 静止の色がコマ列に含まれる | **本症状の回帰テスト** |

**修正前のコードに戻して実行し、上記のうち3項目が NG になることを確認済み**（テストが本当に噛むことの確認）。

> ⚠️ この節は前提が2つある。**サイドバーが開いていること**（閉じているとサムネ更新ループが素通り）と、
> **タブが可視であること**（サムネ更新は `document.hidden` を見る）。どちらも前提チェックを入れてある。
> 入れる前は「取得0回」で4項目が落ち、原因が分からなかった。
> また `#sidebar` が現れた直後は幅が入っておらず、そこで開閉判定すると**開いているサイドバーを
> テストが閉じてしまう**。落ち着くまで待ってから判定すること。

### ついでに削除した死にコード

- `isSidebarLoading()`（②の自前取得を撤去した時点で呼び出し元が消えていた）
- `HOVER_CAPTURE_THROTTLE_MS`（ホバー即時取得の名残）
- `stats.fetches / periodic / hover / errors / recent`（どこからも加算されず、常に0を表示していた）
- `buffer.lastSrcUrl`（URL比較をやめたので不要）

## ✅ AW. 固定画像の番組のライブスクショは、最初の応答に既に入っていた（2026-07-31）

配信者が**固定画像**を設定している番組は `listingThumbnail` が固定画像になる。この拡張は
「サムネは常に配信画面」という方針なので、そういう番組だけ `fillMissingDetails` が
**番組ごとに詳細APIを叩き直して**ライブスクショを回収していた。

実測（2026-07-31・公開の recent 版70件）: **user 67件中22件が固定画像運用（約1/3）**。
つまり毎サイクル、その件数ぶんの追加リクエストが走り、**リスト描画はそれが返るまで待っていた**
（`fillMissingDetails` は `fetchFollowedProgramsViaPage` の中で await される）。

### 見落としていたもの

同じ応答に `flippedListingThumbnail` というもう1枠があり、**そこにライブスクショが入っていた**。
（一覧ページでこの手の番組のサムネが固定画像とスクショで交互に入れ替わるのは、この2枚のこと。）
固定画像だった22件は **22件すべて** flipped を持っていた。

```
listingThumbnail        : 配信者が設定した固定画像
flippedListingThumbnail : 配信画面のスクショ  ← 読んでいなかった
```

### 修正

`mapApiProgramToInfo` で、`listingThumbnail` がライブスクショ形でなければ
`flippedListingThumbnail` を見る。効果は「追加リクエストが消える」ことに加えて
**リスト更新が補完待ちで遅れなくなる**こと（更新ボタンのスピナーが消えるのも早くなる）。
30秒間隔を選べるようにした直後なので、効き目はそのぶん大きい。

> 🔴 **採用は `isLiveScreenshotUrl` を通る素直な形だけにすること。** 22件中2件は
> listing-thumbnail プロキシに包まれた形（`?url=<エンコードしたスクショURL>`）で来ており、判定を通らない。
> ここをホスト名などで緩めると、**同じホストが配る固定画像・チャンネルアイコンまで
> 「ライブサムネ」として登録**してしまう（項目AA の事故そのもの）。包まれた分は従来どおり
> 詳細APIの補完に回す。「全部拾う」より「間違って拾わない」を優先する。

### 鳴る罠

固定画像の番組が居るのに flipped から1件も回収できなかった時だけ、`fetchFollowedProgramsViaPage` が
**1回だけ** `console.warn` する。回収できていれば完全に無言。
フィールドが消えたり形が変わったりしても、**詳細APIでの補完が静かに復活するだけで画面は何も変わらない**
ため、気付ける場所がここしかない。

> 実測は公開の recent 版で行った（フォローAPIは要ログインで直接叩けない）。応答の作りは同じだが、
> **フォローAPI本体での確認はこの警告が出ないことをもって代える**。

### 検証

`verify:loop` に AW 系8項目（写像の単体4件＋実描画経路2件＋既存の「詳細APIを呼ばない」）。
修正前のコードに戻すと5項目が NG になることを確認済み。

## ✅ AX. 自動移動の残り2件（裏タブの間引き／閉じると中止）を解消（2026-07-31）

項目AU で「未着手」として残していた2件。利用者の判断で両方やった。

### 1. 裏タブでカウントダウンが伸びる

`remaining -= 1` で10回数える方式だった。Chrome は**5分以上隠れている無音タブ**のタイマーを
**1分に1回**まで間引く（intensive throttling）。番組が終われば音も止まるので、
**自動移動が効いてほしい場面がちょうどその条件に当てはまる**。10秒が最大10分に化け、
戻ってきたら「3秒後に移動します」で止まって見える。

→ **期限（`deadlineAt = Date.now() + autoNextCountdownMs`）で持ち、残り秒数は毎回計算する。**
間引かれても「次に目が覚めた1回」で期限超過を検出して遷移できるので、遅れは最大1分程度に収まる。

> ⚠️ `visibilitychange` で叩き起こせばもっと速いが、**採らなかった**。この拡張は
> 「`visibilitychange` のリスナーを1つも持たない」方針で、`verify:loop` の D6 が機械で担保している
> （リスト更新が裏タブを見ない設計＝項目AB-2 と対になっている）。例外を1つ作ると、その担保が崩れる。

### 2. サイドバーを閉じるとカウントダウンが中止される

`handleSidebarOpenStateChange(false)` → `stopAllTimers()` → `cancelScheduledNavigation()`。
モーダルは **body 直下＝サイドバーの外**にあるので、閉じてもカウントダウンは見えている。
それが黙って中止されるうえ、`chrome.storage.onChanged` の `isOpenSidebar` 経由で
**別タブでの開閉でも中止**されていた（視聴中のタブは何も操作していないのに止まる）。

→ **閉じても止めない**（利用者判断で「閉じたら止まる」を崩してよいと確認）。
`stopAllTimers()` は中身が無くなったので関数ごと撤去し、閉パスは**何もしない**ようにした。

これで「サイドバーを閉じて止まるもの」はリスト取得とサムネ更新の2つだけになった。
どちらも**止めているのではなく**、常設ループの各 tick が `isOpen` を見て素通りしているだけである。

> 🔴 **閉パスに自動移動を止める処理を戻さないこと。** 戻すなら `clearTimer('autoNext')` だけでは
> いけない（`scheduled` が残って以後そのページで自動移動が二度と動かない＝項目AF）。
> `verify:loop` が「閉パスが autoNext に触っていないこと」と「閉パスの中身が空であること」を
> 機械で見ている（**負の検証だけにしない**＝空スライスでも通ってしまうため、同じスライスに
> 「中身が空である」という正の検証を対で置いてある）。

### 検証

`verify:loop` の R-7 群を差し替え（4項目）。
- 閉パスが `clearTimer('autoNext')` / `cancelScheduledNavigation` に触っていない
- 閉パスの中身が空（＝上の負の検証が空スライスで素通りしていないことの担保）
- 停止経路（`stopWatcher`）はタイマー・フラグ・モーダルの3点を戻す
- カウントダウンが `deadlineAt` と `Date.now()` で計算され、`remaining -= 1` が無い

> 裏タブそのものは自動検証できない（CDPで操作しているページを Chrome は常に visible 扱いにする。
> doc/10 の D6 と同じ制約）。**「期限で計算しているか」というソース検査で代替**している。

## ✅ AY. 人気順を「開始からの平均」から「直近の勢い」へ（2026-07-31）

利用者の要望:「盛り上がっている順にしたい。始まったばかりの番組と長時間の番組でも、どちらもちゃんと盛り上がりを数値化したい」。

### 旧スコアが測っていたもの

```js
point = (来場者+1 + コメント+1) / 経過分   // Math.pow(経過分, 1) と書かれていたが指数1で無意味
```

単位としては筋が通っていた（分子が両方とも**累計**＝減らない量なので、割れば「平均レート」になる）。
`watchCount` が同時視聴者数ではなく**累計の来場者数**であることは実測で確認した
（2026-07-31・70件を6分あけて比較: 増えた26件・減った0件）。

問題は「**開始からの平均**」であることだった。放送中70件の実データで測ると:

| 症状 | 実測 |
|---|---|
| 経過分が切り上がるたびスコアが階段状に落ちる | 1分→2分で **−50%**、3分→4分で −25% |
| そのため**データが変わらなくても順位が動く** | 2分経過しただけで **70件中58件**（上位10件でも6件）が入れ替わる |
| `+1` と「最低1分」で空の新番組に下駄 | 来場0・コメ0の新番組が **2.0**。これを下回る実番組が **70件中50件**（1時間で118人未満は全部下） |
| 長時間放送が構造的に不利 | 3時間放送は1時間放送の**3倍の総数**がないと同点にならない |

### 新スコア

```
盛り上がり = 直近の「1分あたり（来場者の増分 ＋ コメントの増分）」の指数移動平均（τ=3分）
```

- 差分は **前回保存したレコード**（`programInfos` の `_fetchedAt` 付き）と突き合わせて取る。**新しい通信は不要**。
- 重み 来場者:コメント = **1:1**、同点（静かな番組は0で並ぶ）は**累計の多い順**を第2キーに（いずれも利用者決定）。
- 初回だけ「開始からの平均レート」で立ち上げる。若い番組ではそれが実質そのまま直近レートなので、新番組が不当に沈まない。

### 🔴 生の差分をそのまま順位に使わないこと

30秒刻みで6回サンプリングした実測:

```
30秒ウィンドウで増分ゼロの番組数: 67, 31, 67, 59, 40 （全67件中）→ 平均 79%
```

ゼロと非ゼロが交互に出る。**ニコ生側の統計が約60秒粒度でしか更新されない**ためで、30秒間隔だと半分の周期は全滅する。
平滑化なしで並べると **1周期あたり平均14.4位** も動く。時定数ごとの実測は下表（利用者が τ=3分 を選択）。

| τ | 1周期の平均順位変動 | 盛り上がりに気付くまで |
|---|---|---|
| 1分 | 2.3位 | 1分 |
| **3分** | **1.1位** | **3分** |
| 5分 | 0.7位 | 5分 |
| 8分 | 0.5位 | 8分 |

> 🔴 **α を固定値にしないこと。** 更新間隔は 30〜180秒で可変。`α = 1 - exp(-Δt/τ)` と時間から計算すれば、
> 「30秒×6回」と「180秒×1回」が**厳密に一致**する（検証で固定済み）。固定 α にすると、間隔を変えた瞬間に手触りが変わる。

### 🔴 計算地点は1つだけ（upsert）。しかも呼び出し側の配列に書き戻すこと

差分は「前回値と新値が出会う場所」でしか計算できず、それは `storage.upsertProgramInfos` である。
ただし upsert は**保存用に新しいオブジェクトを作る**ので、そこにだけ書くと
**描画が使う配列は `momentum` を知らないまま**になり、計算しても順位に一切反映されない。
渡された配列の要素にも破壊的に書き戻している（例外もログも出ない空振りなので、検証で押さえた）。

### 暖機（既知の性質・許容）

長時間放送が**初めてリストに現れた時**だけ、スコアは「その番組の生涯平均」から始まり、実時間で数分かけて
直近値へ寄る（τ=3分の EMA なので 3τ≈9分でほぼ収束）。`momentum` は localStorage に載るので
**ページ遷移をまたいで保持され**、番組移動のたびに暖機し直すことはない。

### 検証

`verify:loop` に AY 系16項目（単体12＋実描画経路4）。

- 単体: 初回の立ち上げ／EMA／**減少のクリップ**／Δt<1秒の据え置き／**30秒×6=180秒×1**／第2キー
- 実描画: **3時間放送(累計30000・今は静か) より 10分の番組(累計400・今伸びている) が上に来る**／
  スコアが直近側へ寄る／`data-total` が両方のカードに入る／**数字が変わらなければ順位も動かない**

旧スコアに戻すと上記2項目が NG になることを確認済み（3時間番組が 164 で1位のまま）。

> ⚠️ **検証の手順そのものに罠がある。** 盛り上がりは「前回取得からの増分 ÷ 経過時間」なので、
> ①基準値で取得 → ②時間を進める → ③伸びた値で取得、の順でないと増分が計上されない。
> 「値を変えてから時間を進める」と変化が Δt<1秒の回に飲まれて何も起きず、**実装は正しいのに落ちる**。
> 実際にこれで誤診した。検証環境は実時間が進まないので、`harness.ageStorage(ms)` で明示的に時間を進める。
> あわせて `buildRenderHarness` は `programInfos` を空にしてから始める（テスト間で持ち越すと前ブロックの
> 勢いから始まって結果が変わる。これも実際に踏んだ）。

## ✅ AZ. 新番組のサムネイル: 表示経路を塞いだ回帰と、取得の先行化（2026-07-31）

利用者報告:「ニコ生側にサムネがあるのに出ない。**更新ボタンでも出ない。リロードすると出る**」。

### 実測（新番組が出てからサムネが表示されるまで・更新間隔は最短）

| 番組の種類 | 項目AT の改修**前** | 改修**後**（＝報告時） | 本項目の修正後 |
|---|---|---|---|
| user（ライブスクショ） | 59秒 | 37秒 | 37秒 |
| **channel（絵はあるがライブスクショではない）** | **58秒** | **出ない** | **37秒** |
| user（フォローAPIが返さない・notifybox だけ） | 出ない | 出ない | **37秒** |

### 原因① 唯一の表示経路を塞いでいた（今日入れた回帰）

3つが重なっていた。

1. `applyProgramInfoToCard` は仕様として `img.src` を触らない（差し替えはサムネ更新ループの仕事）
2. サムネ更新ループは**ライブサムネを持つ番組しか更新しない**（`computeNext` が null を返す。
   チャンネル番組にライブサムネは提供されない＝項目AA の前提）
3. その隙間を埋める `restoreStaticThumbIfLoading` が「**いま loading.gif を表示している時だけ**」動いていた

項目AT で繋ぎ画像を loading.gif から配信者アイコンへ変えた瞬間、3 の条件が成立しなくなり、
**チャンネル番組の絵がページ再読込まで永久に出なくなった**。更新ボタンが効かないのは、
ボタンは「強制的に取り直す」だけで、そもそも更新対象外の番組には何もしないから。
リロードで出るのは、カードを作り直す時だけ `data-src` の絵を直接入れているから。

**修正**: `syncStaticThumb` に改名し、「**出すべき絵（data-src）と違えば出す**」へ。
「今なにを表示しているか」で判断しない。バックオフは維持しつつ、**data-src が別URLに変わった時は
失敗回数を仕切り直す**（前のURLの失敗を引き継がない）。

> 🔴 教訓: **「繋ぎ画像を変える」は表示ロジックの変更である。** 復旧経路が
> 「特定の画像を表示中か」で条件分岐していないか、必ず確認すること。

### 原因② notifybox 先行の新番組は追撃が始まらなかった（利用者の指摘）

ライブサムネの追撃 `_fetchLiveThumbIfPendingYoung` は **storage のレコードを見て動く**。
notifybox 由来の番組は storage に居ないので追撃が始まらず、フォローAPIがその番組を返すまで
（実測 20〜101秒）取りに行けなかった。

**修正**: `_seedNewProgramsToStorage` で、`_source==='notifybox'` の最小レコードを storage にも蒔く。
これでカードのサムネ周期（20秒）が来た時点で詳細APIを叩ける。

> ⚠️ 種は 来場者0・コメント0 なので、**盛り上がりの計算で「前回値」に使わないこと**。
> 0→実数の差分が「急増」に化けて、出てきたばかりの番組が不当に1位へ飛ぶ。
> `nextMomentum` が `prev._source === 'notifybox'` を見て初期値扱いに落としている（項目AY）。

### 検証

`verify:loop` に AZ 系9項目＋AY に1項目。
- ①: notifybox だけの状態→フォローAPIが静止サムネを返す→**サムネ更新ループが表示する**／`thumbLive=0`
- ②: 種が storage に載る／詳細APIを1回叩いてライブサムネを回収する
- AY: notifybox の種を前回値に使わない

旧挙動に戻すと5項目が NG になることを確認済み。

> このためにモックDOMへ `closest()` を足した（サムネ更新ループを高速検証で回すのは初めてだった）。
> **e2e でしか触れていない経路は、壊しても気付けない。** 触る前に土台を足すこと。

## ✅ BA. 静止サムネの表示が「動くサムネへの給餌」に依存していた（2026-07-31 修正）

利用者報告:「**ユーザー放送**で、拡張の更新ボタンでは出ないサムネが、ページのリロードで出る」。
項目AZ（チャンネル番組）とは別経路である。

### 原因: 表示が②（動くサムネ）の完了待ちになっていた

項目AV で「静止サムネにも給餌したコマそのものを出す」ようにした際、こう書いた。

```js
Promise.resolve(animThumbFeed.ingest(card.id, pre))
    .then((frame) => applySuccess(frame))
    .catch(() => applySuccess(null))
```

`applySuccess`（＝`img.src` の差し替え・成功記録）が **`ingest` の解決に完全に依存**している。
`ingest` は `ensureHydrated` → `loadFrames` で **IndexedDB** を触るので、応答が返らないと
`applySuccess` は永久に呼ばれない。しかも `buf.hydrating` は同じ Promise を返し続けるため、
**その番組だけサムネがページ再読込まで固まる**。更新ボタン（`force`）はTTLとバックオフを飛ばすだけで、
この待ちは飛ばせないので効かない。リロードで直るのは、カード生成時は `img.src` を直接入れるから。

IndexedDB が返らなくなる具体的な穴も2つあった（どちらも**ハンドラの取りこぼし**）。

| 場所 | 穴 |
|---|---|
| `openDB` | `onblocked` 未処理。別タブがバージョンを上げようとすると `onsuccess`/`onerror` の**どちらも呼ばれない** |
| `loadFrames` | トランザクション中断（`onabort`/`onerror`）未処理。req のハンドラは呼ばれないので Promise が未解決のまま |

利用者は視聴ページを複数タブ開くので、タブ間の競合は現実に起きうる。

### 修正

1. **表示を②に依存させない**（構造）。`animIngestWaitMaxMs`(2秒) で打ち切り、間に合わなければ
   URL表示へ倒す。②のコマ化は裏で続くので次の周期で追いつく。
   打ち切った時は**1回だけ** `console.warn`（鳴る罠。表示は無事だが②が詰まっているサイン）。
2. `openDB` に `onblocked` と `onversionchange`（別タブがバージョンを上げたら接続を手放す）を追加。
3. `loadFrames` のトランザクションに `onabort`/`onerror` を追加。

> 🔴 **任意機能（動くサムネ）の完了を、コア表示の前提にしないこと。** ②は β版で既定OFFの実験機能である。
> それが詰まった時にサムネが出なくなるのは、依存の向きが間違っている。

### 検証

`verify:loop` に AZ③ を追加: **給餌フックが永久に返らない状態**（`ingest: () => new Promise(() => {})`）で
`updateThumbnail(force)` を回し、`img.src` が取得URLになることを見る。上限を外すと NG になることを確認済み。

> このためにモックDOMへ `Image`（プリロード）のモックを足した。これが無いと**プリロード成功→表示**の
> 経路を高速検証で一度も通せない（項目AZ の `closest()` 追加と同じ話で、e2e でしか触れない領域は
> 壊しても気付けない）。`globalThis.__mockImageFail(url)` で失敗側にも倒せる。

---

## BB. 表示経路が1本しかなかった（更新ボタンでは出ず、ページ再読込では出る）／新着の初回サムネが20〜40秒待たされていた

**症状（利用者報告・3回目）**: 拡張の更新ボタンを押しても出ないサムネが、ページを再読込すると出る。
チャンネル番組（項目AZ）→ ユーザー番組（項目BA）と塞いだのに、また同じ見え方で再発した。

### 真因は個別の穴ではなく構造

同じ絵を出すのに、2つの経路の作りが違っていた。

| | ページ再読込 | 更新ボタン／定期のその場更新 |
|---|---|---|
| カード | 作り直す（`makeProgramElement`） | 作り直さない（`applyProgramInfoToCard`） |
| `img.src` | storage のURLを**直接代入** | **触らない**（「差し替えはループの仕事」という設計だった） |
| 通る仕掛け | なし | プリロード / `crossOrigin` / ②給餌 / TTL / バックオフ / 期限表 |

つまりその場更新では、**表示を変えられるのがサムネ更新ループのプリロード経路ただ1本**だった。
その1本に上記が直列に載っているので、**どこか1箇所でも滑れば必ず「更新ボタンは無反応・再読込では出る」**
になる。項目AZ も BA もこの1本の中の別々の穴であり、塞いでも構造が残る限り別の理由で再発する。

> 🔴 **利用者に見える機能の経路は1本にしないこと。** 特に「壊れやすい要素（外部通信・CORS・IndexedDB・
> 時限ガード）が直列に載っている経路」を唯一の経路にしてはならない。

### 本来の目的は「何も押さずに早く出ること」

更新ボタンで出るかどうかは症状の切り分け手段にすぎない。自動経路の遅延を測ると、
**新着カードの初回サムネ取得が「1周期後＋分散」＝20〜40秒後ろに倒されていた**。
notifybox 先行で立った新着（まだライブサムネURLを持たない）は、その間アイコンのまま放置される。
追撃 `_fetchLiveThumbIfPendingYoung` もこのループの順番が来て初めて走るので、
**URLを取りにいくこと自体がその時間ぶん遅れていた**。

後ろへ倒していた理由は「読み込み直後の force 一斉更新と衝突させない」ことだけであり
（同じ `<img>` に2本目の取得が走るのを避ける）、その一斉更新が無い場面まで待つ理由は無い。

### 実測: サムネURLの取得は遅くない（2026-07-31 / n=21）

開始直後の user 番組を20秒ごとに5分追跡し、リストAPI（フォローAPIと同一スキーマの公開 recent）と
詳細API のどちらが先にライブスクショURLを持つかを測った。

```
リストが先 0 / 詳細が先 1 / 同時 20 / どちらも取れず 0
```

「同時」20件は**初観測の時点で既に両方が持っていた**という意味（初観測26秒→両方26秒 など）。
例外は開始16秒で見つけた1件のみで、そこは詳細16秒 / リスト77秒＝**61秒の先行**だった。

- notifybox は**サムネURLを持たない**（`thumbnail_url` は配信者アイコン）。速いのは存在検知だけ。
- 結論: **URLはリストに載った時点でほぼ手元にある。遅いのは表示側だった。**
  開始60秒未満のごく初期だけ詳細APIが先行しうるので、`_fetchLiveThumbIfPendingYoung` の方向は正しい。

### 修正

1. **表示経路を2本にする**。`applyProgramInfoToCard` に直接表示を足した。触ってよい条件を狭く固定する:
   - `thumbLive !== '1'`（まだ一度もライブサムネを出せていないカード）だけ。既にライブサムネを
     出しているカードには触らない → **「表示中の絵＝②のコマ」（項目AV）を壊さない**。
   - ⚠️ 条件を `!== 1` にしないこと。**`thumbLive` 未設定は「storage のライブサムネを表示中」を意味する**
     （`makeProgramElement` は `if (!isLiveSrc)` の時だけ `0` を書く）。`!== 1` だと、ページ再読込直後の
     正常なカード全部が毎リスト周期で再代入対象になり、②が `1` を立てるまで**カードの数だけ無駄な再取得**が走る。
     自分の変更を敵対的に読み直して見つけた（最初の実装は `!== 1` だった）。BB⑤ で固定。
   - `?cache=` は付けない。同一URLなら再代入されず、無駄な再取得も起きない。
     「同じURLで中身が変わる」ライブサムネの更新は従来どおりループの仕事。
2. **新着カードの初回サムネを前倒しする**（`newCardFirstThumbSpreadMs` = 2秒の窓へ分散）。
   ただし **①初回の一斉配布（期限表が空）** と **②手動更新の一斉取得中** は従来どおり後ろへ倒す。
   前者の判定は `_thumbDueAt.size === 0` を**ループに入る前に**取ること（1件配ると裏返る）。

### 検証

`verify:loop` に BB① 〜 ④ を追加。**4項目とも両方向で噛みつくことを確認済み**
（直接表示を無効化→①がNG／`thumbLive` ガードを外す→②がNG／前倒しを撤回→③がNG／常に前倒し→④がNG）。

> ⚠️ 最初に書いた BB① の下位2項目（「`?cache=` を付けない」「`thumbLive=0`」）は、
> **機能を消してアイコンのままでも合格する空振り検査**だった。「直接表示が起きたこと」を条件に
> 入れて直した。**否定形の検査は、機能を消した状態でも成立しないか必ず確かめること。**

> ⚠️ 項目AK の「表示中の画像(src)は触らない」という検査はこの改修で**意図的に反転**させた。
> 旧仕様を守る検査が残っていると、経路の二重化そのものが回帰扱いになる。

### 診断コードは撤去済み（2026-08-01）

調査のために入れていた診断（`_dumpThumbDiagnostics` / `_probeLoop` / `getThumbProbeStats` /
`setLoopStats` / `img.dataset` の bornAt・firstShownAt・firstShownBy・iconStart・tickAt・chase）は
**すべて撤去した**。原因は項目BD で特定・修正済み。

> 💡 この診断が最終的に効いたのは「**カードごとの出来事を時系列で残す**」形にしてからだった。
> 状態のスナップショット（今どうなっているか）では「まだ読み込み中」と「止まっている」が
> 区別できず、2回誤診した。次に同種の調査をする時は最初から出来事を記録すること。

---

## BC. 一斉取得は同時に投げるほど「1枚目」が遅くなる（実測15秒）

**利用者の本命の要望は「何も押さずに、できるだけ早くサムネが出ること」**（項目BB）。その観点で
実環境（18カード）を計測したところ、**取得の総量ではなく同時性が効いていた**。

### 実測（2026-08-01・利用者環境・18カード）

診断のカウンタとループ記録から:

```
押した3秒後   : 開始17 成功4      ← 4本だけ着地、13本が飛行中
（次の押下）3秒後: 開始34 成功17     ← 前の13本が「まとめて」ここで着地（0.6秒前）
押した40秒後  : -18.9s fire
                -3.8s done id=… 追撃=0.0s 取得=15.1s   ← ループの取得1件が15.1秒
                -3.8s done id=… 追撃=0.0s 取得=0.0s    ← 以降16件は0.3秒で完走
```

- 17本を同時に投げると **4本が1.6秒・残り13本が15秒後にまとめて着地**する。
- 1本ずつ取る時は **1本あたり 0.0〜0.1秒**。
- その15秒の間、**ループ自身の取得も列の後ろに並ばされる**（`取得=15.1s` の正体）。

つまり総時間は変わらないが、**1枚目が出るまでが15秒**になり、その間に立った新着カードの取得も
待たされる。「早く出る」という要望に対しては、ここが最大の損失だった。

> ⚠️ **この15秒を「ループが壊れている」と誤診しかけた。** スナップショットだけでは
> 「一斉取得が捌けきる途中」と「ループが止まっている」が区別できない。`取得`/`所要`/`次` を
> 分けて記録して初めて切り分けられた。**状態ではなく出来事を記録すること。**

### 修正

- `thumbnailFetchMaxParallel`(4) を追加し、`updateThumbnailsFromStorage` は取得を待機列へ積んで
  上限本数ずつ流す。1本終わるたびに次を流す（`pumpFetches` / `releaseFetchSlot`）。
- crossOrigin 失敗→平文で読み直す経路では、**枠は平文側の決着まで返さない**
  （同じ1枚のための2回目の通信なので、ここで返すと上限を超える）。
- ②への給餌（IndexedDB）は通信ではないので、枠は `onload` の時点で返す。

### 同時に直したもの: 直接表示がバックオフを無視していた

項目BB で足した直接表示は、ループのバックオフ状態を見ていなかった。読み込みに失敗したURLは
`handleThumbnailError` が繋ぎ画像へ落とすため **`img.src !== best` が毎周期成立してしまう**。
その結果、**壊れたURLをリスト更新のたびに叩き直し、指数的な再試行間隔が意味を失っていた**
（実測: チャンネル1件の静止サムネが失敗し、err が 1→2 と増えていた）。`nextTryAt` を見て控える。

> ⚠️ 当初は「直接表示と `syncStaticThumb` が別々のURLを入れて奪い合っている」と考えたが、**誤り**だった。
> `syncStaticThumb` が走るのは `resolveLiveThumbnailBaseUrl` が空の時だけで、その時 `best` は必ず
> `data-src` と同値になる。**構造上、両者が違うURLを入れることはありえない。**
> そのつもりで書いた検査は「ガードを外しても合格する」空振り検査になり、それで気付いた。
> **否定形の検査は、機能を消した状態でも成立しないか必ず確かめること**（項目BB でも同じ罠を踏んだ）。

### 検証

`verify:loop` に BB⑥⑦ を追加。両方向で噛みつくことを確認済み
（上限を外す→⑦がNG／バックオフガードを外す→⑥がNG）。

### まだ分かっていないこと

**「サムネが出ない」の再現には至っていない。** 2026-08-01 の計測では18件すべて表示済みで
（`アイコンのまま0件`）、症状が出ていなかった。項目AZ・BA・BB のいずれかで塞がった可能性はあるが、
断定はできない。**その後、項目BD で真因（ループが1件の完了を待っていた）を特定・修正し、
新着カードの表示は 62秒 → 15秒 になった。** 残る15秒はニコ生がサムネを生成する時間で、
利用者確認のうえ許容範囲とした（拡張側で削れる時間は残っていない）。診断コードは撤去済み。

---

## BD. 1件の完了を待っていたので、番組数が増えると更新間隔が黙って伸びていた

**利用者のご指示は一貫して「各番組がそれぞれ20秒ごとに更新される」**（バラバラに更新されてほしい）。
旧実装（番組数ぶんのタイマー）はそのとおりだった。常設ループ化（項目AE）で構造を置き換えた時、
**その約束が静かに壊れていた。**

### 何が起きていたか

`_thumbTick` は1番組を処理するのに `await this._updateOneThumbnailAndWait(target)` で
**画像が届くまでループごと止まっていた**。その結果:

```
一周の時間 ＝ 番組数 × 1件あたりの所要時間
これが20秒以内なら  → 約束どおり各番組20秒ごと
これを超えると      → 各番組の間隔が「一周の時間」まで伸びる（黙って）
```

18番組なら **1件1.1秒以内**でないと収まらない。実測（2026-08-01・利用者環境）では一周60秒以上。

さらに、ループが選ぶのは「期限がいちばん**古い**」番組なので、**新着カードは行列の最後尾**に並ぶ
（新着の期限は「今」＝いちばん新しい）。実測: 新着カードが **62秒** アイコンのまま
（`tick=未着手` ＝ 62秒のあいだ一度も選ばれていない）。項目BB で初回期限を2秒に前倒ししたが、
**選ぶ順が「古い順」なので前倒しはむしろ逆効果**で、まったく効いていなかった。

### なぜ見逃したか（🔴 ここが本質）

項目AE で「**ドリフトはタイマーの本数と無関係**」と判断した。その検証は
**4カード・作業0.2秒**（一周0.8秒＝間隔2秒に余裕で収まる）でしか行っていない。
**「収まらない件数」を一度も試していなかった。**条件付きの主張を無条件の主張として書き、
その条件を検証しなかった。

> ⚠️ **「AをBに置き換えても同じ」と判断したら、"同じでなくなる条件" を探して検証に入れること。**
> 収まっている範囲だけ試すと、置き換えは常に成功して見える。

### 誤診も2つ重ねた

- **「回線を分け合うから遅い」**（誤り）。サムネは1枚20〜30KB、18枚で500KB程度。光回線なら
  0.1秒もかからない。実際の重さは**ニコ生側が1件の要求に返事をするまでの時間**であり、
  それは**重ねれば隠せる**種類の待ちだった。この誤診に基づいて入れた同時取得の上限（4本）は撤去した。
- **「一斉更新は避けるべき」**（部分的に誤り）。利用者が避けたかったのは**表示が一斉に切り替わること**
  であって、取得が重なること自体ではない。取得は重ねてよい。

### 修正（利用者判断・2026-08-01）

1. **完了を待たない**。取得は開始したら次へ進む。各番組の期限は**その番組の取得が終わった時点＋20秒**
   で置き直す（完了ハンドラの仕事）。`_thumbInFlight` で同じ番組の二重取得だけ防ぐ。
2. **機械的な位相分散をやめる**。初回は全員同じ期限（＝まとめて取りにいく）。ズレは
   「取得完了＋20秒」で自然に生まれる。
3. **一斉更新（更新ボタン・読み込み・タブ復帰・サイドバーを開いた時）は本数を絞らずまとめて**。
   一度そろっても、その後は各番組の取得時間の差でバラけていく。
4. `thumbnailFetchMaxParallel` と `newCardFirstThumbSpreadMs` は撤去。

> 🔴 **`_thumbNextDelayMs` から取得中の番組を必ず除くこと。** 期限切れなのに選べない番組が残ると
> 「0ms で起きる → 選べない → また 0ms」の無限ループになる（項目AE で一度踏んだ形）。

### 検証

`verify:loop` に **BD** を追加。**10番組・基準間隔2秒・1件の取得0.6秒**（直列なら一周6秒＝間隔2秒を
大きく超える）という「収まらない」状況を作り、各番組の最悪の間隔を見る。
**`await` を戻すと NG になることを確認済み。**これが項目AE の時に無かった検証である。

---

## BD-2. 追記: 残り15秒はニコ生側のサムネ生成時間（利用者確認済み・打ち止め）

項目BD の修正後、新着カードの表示は **62秒 → 15秒**。内訳は実測で

```
tick=0.0秒       ループが即座にそのカードを選んだ
追撃=取得(0.0s)  詳細APIでURLも即座に取れた
15.3秒           表示まで
```

**拡張側の段取りはゼロ**で、残りはニコ生がそのスクショを用意する時間である。
**利用者確認のうえ、これは許容範囲として打ち止めとした（2026-08-01）。**

> 🔴 **ここを更に縮めようとしないこと。** 拡張側で削れる時間は残っていない。

### この15秒について、私が2度誤った実測をした

どちらも「測ったつもりで、測るべきものを測っていなかった」失敗である。

1. **「`?cache=` を付けるからニコ生が作り直して遅い」** → 実測: 素のURL 17ms / cache付き 15ms、
   差なし（n=12・画像は3〜20KB）。**そもそも取得は15ミリ秒で、15秒の説明になっていなかった。**
2. **「放送直後は画像の実体がまだ無くて失敗する」→ 実測で否定** としたが、**この実測が誤り**。
   若い番組を狙ったつもりで、実際には**すでにURLが出そろった番組（開始41〜89秒）**ばかり拾っており、
   「URLが出た瞬間に絵があるか」を一度も測っていなかった。仮説を殺せる測定ではなかった。

> ⚠️ **「測った」と言う前に、その測定が仮説を否定しうるものか確かめること。**
> 対象の選び方が仮説の成立条件を外していると、何件測っても結論は出ない。
> 同じ失敗を、この件だけで**3回**している（既表示カードを数えて「再現せず」と報告した件を含む）。

---

## BE. 弾幕番組が「盛り上がっている」ことになっていた（2026-08-01 修正）

少人数が大量にコメントを投げる番組（弾幕）が人気順の上位に来る。実際には盛り上がっていない。
スコアは `Δ来場者 + Δコメント` の 1:1 で、**コメントの増分だけで上位に届いてしまう**ためである。

### やってはいけない直し方（利用者指定）

- ❌ **コメントの重みを一律に下げる** → コメントが多くて本当に盛り上がっている番組まで沈む
- ❌ **「弾幕である」と判定してその番組のスコアを下げる** → 判定は必ず境界を持つ。境界の
  両側で挙動が跳び、「なぜこの番組だけ下がったのか」が説明できなくなる

### 直し方: 判定を置かず、連続関数を1本通す

```
r = コメント累計 / (来場者累計 + 20)          … 1人あたり何コメントか
w = 1 / (1 + (r / 10) ^ 1.5)                  … 0 < w ≤ 1
勢い = Δ来場者 + w × Δコメント
```

| `r` | 0 | 1 | 2 | 4 | 10 | 30 | 100 |
|---|---|---|---|---|---|---|---|
| `w` | 1.00 | 0.96 | 0.92 | 0.80 | 0.50 | 0.16 | 0.03 |

🔴 **これは「弾幕の検出」ではない。全番組が同じ式を通る。** `r` が小さい番組では `w ≈ 1` に
なるので、式があってもなくても結果が変わらない。**分岐も閾値も無いので、境界の両側で挙動が
跳ぶことがない。** 「弾幕を見つけて罰する」ではなく「1人あたりの投稿密度が上がるほど、
コメントが1件あたりの説得力を失っていく」という連続的な性質として書いてある。

**なぜ本物の人気番組が沈まないのか** — 減衰の引き金が **Δコメントの大きさではなく `r`** だから。

| | 来場者累計 | コメント累計 | `r` | `w` |
|---|---|---|---|---|
| 本物（大規模配信） | 10,000 | 20,000 | 2.0 | 0.92 |
| 弾幕 | 150 | 30,000 | 176 | 0.013 |

**なぜ「Δコメント / Δ来場者」ではなく累計比なのか** — ニコ生の統計は約60秒粒度でしか動かず、
30秒ウィンドウでは**平均79%の番組が増分ゼロ**（項目AY の実測）。分母が頻繁に 0 になって比が
発散する。累計比なら分母が大きく、値もゆっくりしか動かないので、**重みの変動で順位が跳ねない**
（EMA を入れたのと同じ理由）。

**放送時間で不利にならないか** — ならない。来場者が毎分 λ 人増え、同時視聴 A 人が毎分 q 件
書くなら `C/V = A·q/λ` で時間 `t` が消える。**項目AY で消した「長時間放送が構造的に不利」を
持ち込まない形**を選んである。

**`+20` の下駄** — 来場者3人・コメント15件のような若い番組は `r` が数件で暴れる（下駄が無ければ
`r=5`）。分母に足して、**データが少ないうちは自動的に「補正なし」側へ寄せる**（疑わしきは罰せず）。

### 旧実装と一致しなくなる条件（🔴 口約束にしない）

コメントに重みを掛ける以上、`max(0, Δ合計)` を `max(0, Δ来場者) + w × max(0, Δコメント)` へ
分けるしかない。**`w=1` でも、片方だけが減った周期では旧と一致しない。**

| 周期 | 旧 | 新 |
|---|---|---|
| Δ来場者 +60 / Δコメント 0 | 60 | 60（一致） |
| Δ来場者 −5 / Δコメント +10 | 5 | 10（**不一致**） |

**分けたほうが正しい。** 来場者側の取得揺れが、実在するコメントを食い潰す理由が無い。
`verify:loop` にこの不一致そのものを固定してある（一致してしまったら NG）。

### ついでに直した構造: 順位属性を書く場所が2箇所に散っていた

`active-point` と `data-total` は「カード生成時」と「その場更新時」の2箇所で個別に書かれており、
**「片方だけ書くと同点時の並びが古い値で決まる」を⚠️コメントで守っていた**。属性が4つに増える
ので、`sidebar.applyRankAttributes()` へ集約した。**思い出して守るガードは、書く場所が増えた時に
破れる**（この方針は項目AB-2 以降と同じ）。

### 検証（`npm run verify:loop`）

固定したのは**値ではなく性質**。定数は実機で詰める前提の暫定値なので、**定数を動かしても
落ちない検証**でなければ意味が無い（項目AY の教訓と同じ）。

- 単調に減る／連続でなだらか（`r` を4000分割して掃き、最大の落差 < 0.01）＝**閾値方式ならここで落ちる**
- ゼロにならない（`r`=5000万でも `w > 0`）
- 普通の番組を触らない（来場者1万・コメント2万 → `w > 0.85`／若い番組 → `w > 0.9`）
- 実描画経路で、**増分の合計では弾幕が勝つ数字（800 対 1002）でも本物が上に来る**
  ＝ **旧実装(1:1)ではこの検証は必ず落ちる**

### 🔴 定数は実測前の暫定値（2026-08-01 時点）

**弾幕番組が手元に無く、`r` の分布を測れないまま実装した。** 当初プランでは公開APIで数百番組の
分布を測って `r` が弾幕と本物を実際に分離するか確かめる段取りだったが、**利用者判断で測定を飛ばし、
実機で数日使って判断する方針にした。** 定数は「普通の番組をなるべく触らない」側へ倒してある。

- 調整方法とパラメータの意味 → `src/config/constants.js` の `commentWeightHalfRatio` 付近
- 実効値の覗き窓 → カードの `data-comment-ratio` / `data-comment-weight` 属性（DevTools で見る）。
  **順位計算には使っていない。定数が固まったらこの2属性は消してよい。**

> ⚠️ **前提はまだ検証されていない**: 「`r` が弾幕と本物を実際に分離する」。ここが崩れたら
> 定数をどう動かしても解決しない。その時は式の形ではなく**指標そのもの**を見直すこと。

---

## BF-2. 番組終了は「推測」ではなく「確認」する（2026-08-02 に BF を作り直し）

フォローAPI（`?status=onair`）は終了した番組をしばらく返す。リストの削除判定は「和集合に居ない
番組を消す」なので、フォローAPIが手放すまでカードが残る。**notifybox のほうが反映が早い**ので、
BF（2026-08-01）は notifybox の不在を終了の合図に使っていた。

🔴 **その形は捨てた。不在から終了を導くのをやめ、番組詳細API に直接聞いて確かめる。**

```
notifybox から消えた  →  「終わったかもしれない」（疑い）
                      →  その番組だけ詳細API に問い合わせる
                      →  liveCycle が 'ended' なら消す / 'on_air' なら残す
                      →  答えが得られなければ消さない
```

実装は `UpdateManager._dropEndedPrograms()`。

### なぜ捨てたか: 件数や範囲で守ろうとして3回失敗した

| 守り方 | 何が起きたか |
|---|---|
| 「要求数ぴったり／実績値ちょうどの応答は疑う」 | **5件の応答が素通り**して事故が起きた（下記） |
| 「フォローAPIより件数が少なければ怪しい」 | notifybox が先に落とすのが前提なので**常に止まる**。検証 BF② が落ちて気付いた |
| 「notifybox が返した範囲より古い番組は触らない」（条件4） | **いちばん古い番組が永久に消えない**（下記） |

🔴 **条件4がなぜ壊れていたか。** 基準は「notifybox が返した中でいちばん古い番組」だった。
いちばん古い番組が終了して notifybox から消えると、**基準はそれより新しい番組へ繰り上がる**。
すると終了した番組は自動的に「基準より古い＝範囲の外」になり、触れなくなる。
時間が経っても直らない（その番組が古いという事実は変わらないため）。
**長時間放送している番組ほど当たる** ＝ 利用者がいちばん目にする番組で外れていた。

2026-08-02 に実コードで再現（真ん中の番組・いちばん新しい番組は消えるが、いちばん古い番組は
3周期経っても消えない）。**真ん中の番組で試すと通ってしまうので、検証は必ず端で試すこと。**

### 実測（2026-08-02・ログイン不要の公開APIで確認）

| 取得元 | 終了の見分け方 | 反映 | 1回 | 応答 |
|---|---|---|---|---|
| **詳細API**（採用） `api.cas.nicovideo.jp/v1/services/live/programs/lv…` | `data.liveCycle` = `ended` / `on_air` | 終了の **0.5〜1.0秒後** | 約2KB | 約31ms |
| 番組ページ `live.nicovideo.jp/watch/lv…` | HTML内 `embedded-data` の `program.status` | 詳細APIより1〜2秒速い | 約50KB | 約245ms |

速さが実用上同じで、**軽さ（25分の1）と壊れにくさ（公開APIの契約を読むだけ）**で詳細APIを採用。
番組ページはHTMLに埋まったJSONを抜き出す必要があり、ニコ生の内部構造に依存する。
詳細APIは `fetchProgramInfo` として**既に使っている**ので、新しく増やすものは無い。
CORS も通っている（`access-control-allow-origin: https://live.nicovideo.jp`）。存在しない番組は 404。

⚠️ **測れたのは「予定時刻どおりに終わった番組」だけ**（4件）。配信者が途中で切った場合は捕まえ
られていない。予定終了と途中終了でニコ生側の処理が違えば、遅れも違う可能性がある。

### 守っていること

| 守り | 外すと何が起きるか |
|---|---|
| notifybox の取得が失敗した周期は**新たな疑いを立てない** | **通信断で全番組が消える**。一番やってはいけない壊れ方 |
| ただし**確認済みの番組は消したまま**にする | notifybox が不安定な間、終わった番組が出たり消えたりを繰り返す |
| 詳細APIが答えない時（通信断・404・想定外）は**消さない** | 判断材料が無いのに消す。BF の失敗を再現することになる |
| 1周期の問い合わせは `endCheckMaxPerCycle`(20) 件まで | notifybox が壊れた時に問い合わせが暴走する。あぶれた分は次の周期（＝消えるのが遅れるだけ） |
| 確認済みの印は、フォローAPIが手放すまで残す | 毎周期同じ番組に問い合わせ直すことになる |

### 🔴 notifybox の件数は、もう終了判定の正しさに影響しない

2026-08-01 の事故（`rows=500` を要求したら **rows が無視されて既定の5件**が返り、`meta.status` は
200 のまま。放送中21件のうち16件が「終了した」と誤判定されてカードが消えた）は、この形なら
起きない。**16件すべてに問い合わせが飛び、すべて `on_air` が返り、1件も消えない。**

`notifyboxRows` が効くのは**新着検知の速さ**だけになった（notifybox はフォローAPIより 20〜101秒
速く新番組を拾う）。とはいえ **実測せずに rows を上げないこと。**

### 鳴る罠

終了と**確認して**消した番組が notifybox に戻ってきたら、1回だけ `console.warn` する。
詳細APIが `ended` と答えた番組しか消さないので、**ここが鳴るなら詳細APIと notifybox が
食い違っている**＝前提の作り直しが要る。症状が「生きている番組が黙って消える」でエラーが
一切出ない種類の壊れ方なので、気付ける形を残してある。

### 検証（`verify:loop` の `programEndConfirmation`）

失敗の方向が非対称（消しすぎ ≫ 消し足りない）なので、**「消えてはいけない時に消えないこと」**を
厚く固定してある。特に次の2つは、過去に実際に壊れた形そのもの:

- **BF-2⑥** いちばん古い番組が終了しても消えること（条件4のバグの再発防止）
- **BF-2⑦** notifybox が5件しか返さなくても放送中の番組が1件も消えないこと。かつ、その状態でも
  本当に終了した番組は消えること（＝守りが広すぎて機能を殺していないこと）

⚠️ **`_dropEndedPrograms` は詳細APIを叩くので `await` が増えた。** `updateSidebar` は取得直後に
「自分がまだ最新の描画か」を確かめている（項目AP）が、**この await の後にも同じ確認が要る**。
await を足したら世代の確認も足すこと。

#### 壊して落ちることを確認済み（2026-08-02）

| わざと戻した壊れ方 | 結果 |
|---|---|
| 旧・条件4（notifybox が返した範囲より古い番組は触らない） | **BF-2⑥ と ⑦ が落ちた**（狙いどおり） |
| 確認をやめて「不在＝終了」にする（旧BFの推測方式） | BF-2③ が落ちた（下記の注意あり） |

🔴 **「不在＝終了」に戻すと、検証スイートは BF-2 に到達する前に別のテスト（AZ）で
`TypeError` を吐いて止まる。** 消えてはいけない番組が消え、後続のテストが null を掴むため。
落ちること自体は分かるが、**どの項目が守っているのかは分からない**ので、
その形は単体（`scripts/` 外の使い捨てスクリプト）で BF-2③ が落ちることを確かめた。
旧BF でも同型の問題があり「条件3 の空振り確認は未了」と書かれていた。**この suite は
「消してはいけない番組を消す」壊れ方に対して、途中でクラッシュしやすい**と承知して読むこと。

---

## BG. 新着番組が人気順の初回で上に来すぎていた（2026-08-01 修正）

初回スコアは `initialMomentum`＝**「開始からの平均レート」**で、分母の下限が1分だった。
**放送開始直後の入室ラッシュが、そのまま「1分あたりの勢い」に化けていた。**

シミュレーション（番組21件・実物の `momentum.js` を使用）:

| カードが立った時点 | 累計来場者 | 初回スコア | 初回の順位 | 落ち着き先 |
|---|---|---|---|---|
| 開始60秒 | 365人 | 365/分 | **1位** | 3位 |
| 開始60秒 | 73人 | 73/分 | 5位 | 9位 |

### 直し方: 分母の下限を 1分 → 2分（`initialMomentumMinWindowMin`）

🔴 **効くのは初回の1点だけ。** 以後は EMA が実データで動くので `initialMomentum` は使われない。
落ち着いた後の順位は一切変わらない。カードが立つのが遅れた番組（放送開始から2分以上）にも影響しない。

| 下限 | 落ち着き先9位の番組 | 落ち着き先3位の番組 |
|---|---|---|
| 1分（旧） | 5位 | **1位** |
| **2分（新）** | **7位** | **2位** |
| 3分 | 9位（＝落ち着き先。降りてこない） | 3位（同左） |

2分にしたのは「**落ち着き先より1〜2つ上から入って、降りてくる**」を狙ったため。

### 🔴 「新着を下から登らせる」補正にはしないこと（利用者判断）

最初に提案したのは経過時間による信頼度の重み `t/(t+t0)` で、これは**下から登ってくる**動きになる。
利用者の好みは**上から入って落ち着く**動きであり、却下された。

> 「新着番組が比較的上位に来ること自体は良いです。比較的下からよりも上からの方がしっくりきます。
> ただし今は初回が上すぎるということです」（2026-08-01）

この向きは `verify:loop` に固定してある（開始1分・累計200人の番組が、定常20/分より上から入ること）。
**信頼度方式に書き換えるとこの項目が落ちる。**

### ⚠️ 検証の期待値を定数から作らないこと（またやった）

最初こう書いた:

```js
const W = initialMomentumMinWindowMin
check('...', near(initialMomentum(prog(120, 0, 0), NOW), 120 / W))   // ← 空振り
```

**定数そのものと比較しているので、W を何に変えても通る。** 下限を1分へ戻す実験をして
「NGが出ない」ことで気付いた。今は「1分で割った生の値の半分以下」という**定数から独立した
絶対値**で見ている（下限を1分に戻すと落ちることを確認済み）。

> **この罠を踏んだのはこれで5回目。** 検証は必ず「壊したら落ちるか」を実際に試すこと。
> 特に**期待値の中に実装側の定数が出てきたら、その時点で疑う**。

---

## BH. サイドバーを開いた時の更新が2回走りうる／正常系で警告が出ていた（2026-08-01 修正）

サイドバーを開くと、更新を `requestAnimationFrame` で次フレームへ回し、裏タブ用に
100ms の `setTimeout` フォールバックも張っていた。

```js
let rafExecuted = false;
requestAnimationFrame(async () => { rafExecuted = true; await performManualUpdate(); });
setTimeout(() => {
    if (!rafExecuted) {
        console.warn('⚠️ requestAnimationFrameが実行されなかったため、fallbackで更新を呼び出し');
        performManualUpdate();
    }
}, 100);
```

### 問題1: 掛け金が片方向しかない

🔴 **裏タブで止まっていた rAF は、タブを表に戻した時に遅れて実行される**（破棄されない）。
フォローバックは「rAF がまだなら撃つ」を見るだけで、**逆向き（フォールバックが撃ったら rAF を止める）が無い**。

`performManualUpdate` の `isPerformingManualUpdate` は**「同時」しか防げない**。
フォールバックは実測15〜30秒級なので、それが完走した後にタブを表へ戻すと**フル更新がもう1回走る**。

直し方は掛け金を1つにするだけ。両経路が同じ関数を呼び、最初の1回だけ通す。

### 問題2: 正常系で警告を出していた

裏タブで rAF が止まるのは**正常**。しかも `chrome.storage.onChanged` 経由で
**別タブのサイドバー開閉でも裏タブ側でこのパスに入る**ので、普通に使っていると出る。

⚠️ **利用者から「このエラーは問題ないですか」と質問が来た。** 異常だと誤解させていた。
正常系なので警告は削除した。**鳴る罠は「黙って壊れる」時のためのもので、正常系に置かない。**

### 検証（`d6Static` 内の BH 群）

- `performManualUpdate` の呼び出しが**開くパスに1箇所だけ**であること（2箇所なら掛け金が外れている）
- `console.warn/error` が開くパスに無いこと
- rAF と setTimeout の**両方から撃つ構造は維持**されていること（フォールバックごと消していないか）

旧コードに戻して**2項目が落ちることを確認済み**。

⚠️ 開くパスの切り出しは**関数名でアンカー**している。固定幅で切るとコメントを足しただけで
判定対象が窓から押し出される（この罠は通算5回踏んでいる）。

---

## BE-2. 弾幕補正の効きが薄かった／来場者に重みを付けた（2026-08-01 実機報告を受けて調整）

項目BE を実機で使った利用者の報告:

> **来場が少なくコメントが3〜4倍程度の番組が、来場が数倍でコメントも多い番組よりも上になりました。**
> 3倍とかでも弾幕の可能性があります。（中略）来場とコメント数では重みが1:1だったと思いますが、
> これを変えます。来場に重みを付けたい。

### なぜ効かなかったか

半減点が **10**（＝1人あたり10コメントで半分）だった。3〜4倍の領域はほぼ素通しである。

| | 来場 | コメント | r | 旧の重み |
|---|---|---|---|---|
| 弾幕疑い | 200 | 700 | 3.2 | 0.85 |
| 本物 | 1,000 | 1,500 | 1.5 | 0.95 |

**差が1割しかなく、順位はほぼ動かない。** 「補正を入れた」つもりで実質何もしていなかった。

### 直し方: 役割の違う定数を2つにする

```
w = commentBaseWeight / (1 + (r / commentWeightHalfRatio) ^ commentWeightSharpness)
    └─ 基礎重み 0.5 ─┘   └────────── 形 ──────────┘
```

🔴 **2つは別の仕事をする。片方では要望を満たせない。**

| 定数 | 仕事 | これだけでは |
|---|---|---|
| `commentBaseWeight` = 0.5 | 弾幕かどうかに**関係なく**来場者を重く見る | 全番組に一律なので弾幕と本物の差がつかない |
| `commentWeightHalfRatio` = 10→**3** | **弾幕っぽさに応じて差をつける** | 「来場者を重く」にはならない |

新旧の比較（重み）:

| r | 1 | 2 | 3 | 4 | 6 | 10 | 30 |
|---|---|---|---|---|---|---|---|
| 旧（半減点10・基礎1.0） | 0.96 | 0.92 | 0.85 | 0.80 | 0.68 | 0.50 | 0.16 |
| **新（半減点3・基礎0.5）** | 0.42 | 0.32 | 0.25 | 0.20 | 0.13 | 0.07 | 0.02 |

### 承知のうえの副作用

**大型の人気番組もコメントが3割程度しか効かなくなる。** 来場1万・コメント2万で 0.92 → 0.32。
「来場に重みを付けたい」という要望どおりだが、**コメントが多いことの価値はかなり下がる**。
やりすぎなら `commentBaseWeight` を 0.7 へ戻す方向で加減する。

### 検証を「旧方針そのもの」から書き換えた

`BE 本物はほぼ素通し（重み>0.85）` は**旧方針の条文**だったので、新方針の条文へ差し替えた。

- `BE-2 弾幕でない番組でもコメントは来場者より軽い` … 基礎重みを 1.0 に戻すと落ちる
- `BE-2 1人あたり3倍の番組は1.5倍の番組より3割以上軽い` … 半減点を 10 に戻すと落ちる

**両方とも、その定数を旧値へ戻して実際に落ちることを確認済み。**

また `AY 初回にコメントも足される` は上限だけで見ていたので、**両側から挟む**形に直した。
上限だけだと「コメントを完全に捨てても合格」、下限だけだと「1:1 に戻しても合格」になる。

> ⚠️ **方針が変わった時、古い検証は「壊れた」のではなく「古い方針を主張している」。**
> 通すために緩めるのではなく、**新しい方針の条文に書き換える**こと。

---

## BI【診断中・原因特定後に全部消す】放送中の番組のカードが消える

**症状**（2026-08-01 利用者報告）: ずっと放送中の番組のカードが消えた。更新ボタンでは戻らず、
ページ再読み込みで戻った。ちょうど別ブラウザで新しいユーザーをフォローした時で、
消えた番組と入れ替わるように新しい番組のカードができていた。

**分かっていること**
- 消えた番組は notifybox の応答に入っている（利用者確認）。放送中は12件程度・notifybox の上限は100件。
- console に `[updateSidebar] カード生成に失敗` は出ていない（利用者確認）。
- 実コードをモックDOMで走らせた再現の試みは**すべて失敗**。番組の増減・APIの遅延と失敗・
  更新の重なりを40通り×60周期試したが、notifybox に載っている番組のカードは必ず残った。

つまり **notifybox 不在による終了判定でも、カード更新中の例外でもない。** 原因は未特定。

## 【原因確定】notifybox は rows が大きすぎると、rows を無視して既定の5件を返す

2026-08-01 の実測（`diagProbeNotifybox`・放送中21件）:

| rows | 返った件数 |
|---|---|
| 指定なし | 5件 |
| 20 | 20件 |
| 50 | **21件（全部）** |
| 100 | **21件（全部）** |
| 200 | 5件 |
| 500 | 5件 |

🔴 **200以上を指定すると `rows` が無視され、既定の5件になる。しかも `meta.status` は 200 のまま。**
エラーにならないので `downgradeRows` も働かない。**黙って壊れる。**

`notifyboxRows` は 100 に戻した。**上限は推測せず、`diagProbeNotifybox` の実測で決めること。**

### 再発防止（条件4）: notifybox が返した中でいちばん古い番組より古い番組は触らない

notifybox は放送開始が新しい順に返す。返ってきた中でいちばん古い番組より古い番組は、
そもそも返る範囲の外にいる＝**居ないことに意味が無い**。件数がいくつであろうと正しく動く。

🔴 **件数で守ろうとして2回失敗した。**
- 「要求数ぴったり / 実績値ちょうど」… 5件はどちらにも一致せず素通りした（今回の事故）
- 「フォローAPIより件数が少なければ怪しい」… notifybox が先に番組を落とすのが項目BF の前提
  そのものなので、正常時も notifybox のほうが少ない。**終了検知が常に止まる。**
  検証の BF② が落ちて気付いた。実装前に思い付かなかった。

区別できるのは「返ってきた**範囲**の外か」だけである。件数ではない。

⚠️ この条件の検証を書く時、**notifybox の行だけを大量に作らないこと。** フォローAPI側に無い行は
「たった今始まった番組」として扱われるため、範囲の基準が「たった今」になり、実装が正しくても
検証が落ちる。実際の応答は両方に載っているので、両方に置くのが正しい再現（BF⑧・BF⑥(c)）。

**2026-08-01 追記: 診断で notifybox が5件しか返していないことが分かった。**
放送中21件に対して5件。`rows=500` を要求していた（前日 e3a3340 で 100→500 に変更）。
返らなかった7件を終了判定が「終わった」とみなしていた。notifybox は新しい順に返すので、
落ちるのは古い番組＝**ずっと放送中の番組**。症状と一致する。

🔴 **`rows` を大きくすれば多く返る、という前提が間違っていた。** 実測せずに 500 にしたのが原因。

対応: `notifyboxRows` を 100 に戻した。加えて `diagProbeNotifybox` で rows ごとの実際の件数を
1回だけ測る（rows指定なし/20/50/100/200/500）。**上限は推測せず、この実測で決めること。**

**リスト側の診断は 2026-08-01 に全て撤去した**（原因確定・解決済みのため）。
`src/utils/diag.js` は残っているが、中身は**自動移動の調査専用**に作り直してある。

**2026-08-01 追記: 自動移動（項目AU/AF）の経路も記録するようにした。**
症状は「気付いたら終了画面のままで、移動モーダルも出ていない」。移動しなかったのか、
終了済みの番組へ飛んだ先だったのかが**利用者にも分からない**（自動移動はページを移るので、
その場を見ていないと追えない）。記録は localStorage に積むので移動先でも読める。
残すのは、監視開始／終了検知／候補の並びと選んだ先／移動先なし／モーダル表示／取り消し／実際の移動。

⚠️ **自動移動は今いる番組を明示的に飛ばしている**（`nextId !== currentId`）ので、
「今いる番組へ移動してしまう」は起こらない。**ただし移動先がまだ放送中かは確認していない。**
終了した番組はしばらくリストに残り、人気順ではスコアがすぐ下がらないので上位に居座る。

---

## BI-2. 🔴 終了済みの番組へ飛ぶと、そこで自動移動が止まる（2026-08-02 修正）

**「そこへ飛んでも、その先でまた終了ガイドが出るから大丈夫」は誤りだった。**

2026-08-02 に本物のChromeで実測（拡張なし・ニコ生が何を描くかだけを見た）:

```
lv…492  program.status=ENDED  program-end-guide: なし  画面「タイムシフト非公開番組です」
lv…451  program.status=ENDED  program-end-guide: なし  画面「タイムシフト公開中です」
放送中   program.status=ON_AIR program-end-guide: なし（＝終わった瞬間に初めて出る）
```

🔴 **終了ガイドは「見ている番組が終わった瞬間」にしか出ない。**
最初から終わっている番組を開くと、ニコ生はタイムシフトの案内画面を出す。
サーバが返すHTMLにも `program-end-guide` は入っていない（ニコ生のJSが後から描くもの）。

`services/status.js` はその枠だけを見ていたので、**飛んだ先が既に終了していると誰も気付かず、
終了画面のまま止まる。モーダルも出ない。** これが「気づいたら終了画面のままだった」の正体。

### 直し方: ページのHTMLに最初から入っている `program.status` を見る

`<div id="embedded-data" data-props="…">` の中に `program.status` が `ENDED` / `ON_AIR` で
入っている。**サーバが返す時点で確定していて、JSの描画を待つ必要がない。**

⚠️ **自動移動で飛んできた時だけ有効にすること。** タイムシフトを見ようとして**自分で開いた**番組
まで「終了している」と判断すると、**見始めた瞬間に別の番組へ連れて行かれる。**
そこで、移動する側（`AutoNextManager`）が飛ぶ直前に `sessionStorage` へ印を置き
（`markAutoNextHop`）、飛んだ先でその印を確認できた時だけこの判定を使う。

- 印は**1回で使い切る**（消さないと、後から自分で開いたタイムシフトにまで効く）
- 判定結果は**ページが生きている間ずっと保持する**（消費してしまうと、その時たまたま
  サイドバーが未完成だった場合に二度と拾えない）
- 印には時刻を入れて3分で失効させる（移動は10秒後なので十分長い）

**この直しにより「終了した番組へ飛んでも、また次へ移動する」が成立する**（利用者の希望）。
飛び先が放送中かを事前に確認する処理は**入れない**（利用者判断。飛んでから次へ進めばよい）。

---

## BI-3. 終了の再検知でリストを取り直し続けない（2026-08-02 修正）

**API を叩き続ける事故が起きないかを実測した結果、1つ止まらない経路が見つかった。**

### 実測（DOM変異を45秒で900回発火させて数えた）

| 状況 | リスト取得 |
|---|---|
| 終了ガイドあり・移動先が見つかる（正常系） | **1回**（モーダルが出て `scheduled` が立ち、以後止まる） |
| 終了ガイドあり・**移動先が見つからない** | **3回**（20秒ごと。ページを開いている限り止まらない） |
| 最初から終了しているページ（項目BI-2 の経路） | 3回（同上） |

変異900回に対して3回なので、**変異に引きずられる暴走ループではない**（回数は時間で決まる）。
`PROGRAM_END_RECHECK_MIN_INTERVAL_MS`(20秒) のスロットルが効いている。

問題は**止まらないこと**のほう。移動先が決まらないと `scheduled` が立たないため、
コールバック先頭の多重進入ガードにも掛からず、20秒ごとの取得が延々と続く。

1回あたりの通信回数（実測）:

| | notifybox | フォローAPI | 詳細API | 合計 |
|---|---|---|---|---|
| 正常（60番組が両方に載っている） | 1 | 1 | 0 | **2回** |
| notifybox が空（60件すべてが疑い） | 1 | 1 | 20 | **22回**（`endCheckMaxPerCycle` で頭打ち） |

→ 最悪 **66回/分が止まらない**。項目BF-2 で詳細APIの問い合わせが乗ったぶん重くなっていた。

### 直し方: 強制的な取り直しは「最初の検知」だけにする

`observeProgramEnd` が **再武装してから最初の検知か**（`firstSinceArmed`）をコールバックへ渡し、
`AutoNextManager` はその時だけ `updateSidebar` を呼ぶ。2回目以降は**今DOMにあるカードから選ぶ**。

リストは常設ループが更新し続けているので、待っていれば新しい番組は勝手に入ってくる。
**取り直す意味が無い。** 実測で 66回/分 → 常設ループのぶんだけになった。

ガイドが消えて再び出た時は再武装され、また1回だけ取り直す。

### 検証（`verify:loop` の `endedRecheckDoesNotRefetch`）

実物の `observeProgramEnd` と `AutoNextManager` を動かす。
⚠️ **スロットルの窓（20秒）を実時間で待つと1項目に20秒かかる**ので、`Date.now` を差し替えて
時計を進めている。この項目専用の DOM スタブも同居しており、**終わったら必ず元に戻すこと**
（`finally` で復元している。ここを壊すと後続の項目が巻き添えで落ちる）。

**消し方**（原因が分かったら）
1. `src/utils/diag.js` を削除
2. `UpdateManager.js` / `main.js` / `api.js` / `AutoNextManager.js` の `diag` の import と
   `diagEvent` / `diagStatus` / `diagProbeNotifybox` の呼び出しを削除
3. `status.js` の `wasLoadedAlreadyEnded` から `diagEvent` の行だけ消す（**判定そのものは残す**。
   これは診断ではなく項目BI-2 の機能である）
4. `npm run verify:loop` が全項目合格のままであることを確認する

⚠️ **リスト側（項目BF）の診断は 2026-08-01 に撤去済み。** `_dropEndedByNotifybox` は
2026-08-02 に `_dropEndedPrograms` へ作り直したので、この手順に出てくる旧記述は残っていない。

⚠️ 診断コードは `.replaceChildren` などの**子要素の付け外しを使わないこと**。項目AO の
「カードの増減点は1箇所だけ」の検査に引っかかる。表示は `textContent` の入れ替えで行う。

## BJ. ライブサムネの差し替えをクロスフェードにした（2026-08-02 / 利用者要望）

「サムネが新しくなる時にふわっと変わってほしい」。不具合ではなく見た目の要望だが、
**サムネの表示経路に手を入れる**ので、壊れ方だけは設計で縛った。

### やっていること

`.program_thumbnail` に覆い用の `<img class="thumb_fade_layer">` を1枚足し、

1. 覆いに**古い絵**を載せて不透明にする（下はまだ古い絵＝見た目は変わらない）
2. 同じ処理の中で `img.src = next`（覆っている裏で切り替わる）
3. `img.decode()` が返ったら覆いを Web Animations で 1→0（`thumbnailCrossfadeMs`=500ms）
4. 終わったら覆いの `src` を手放す

### 縛った3点（作り替える時はここを外さない）

| | 理由 |
|---|---|
| **向き**: 古い絵を上でフェードアウト（新しい絵は最初から base） | 逆向き（新しい絵を上でフェードイン→base へ確定）にすると、確定処理が走らなかった時に**古い絵が残る＝更新が止まって見える**。この向きなら base には常に最新が入っているので、フェードがどう失敗しても最悪「従来どおり瞬時に切り替わる」までしか壊れない |
| **覆いと差し替えは同期で続ける** | 間に `await`/`setTimeout` を挟むと描画が入りうる＝覆う前に新しい絵が出てフェードが無意味になる。同期で並んでいる限り**2行の前後関係自体はどちらでもよい**（次の描画まで画面に出ない） |
| **`decode()` を待ってからフェード開始・ただしタイマーで必ず蹴り出す** | 待たないと新しい絵より先に覆いが薄れて途中で絵がボンと入れ替わる。一方**非表示タブでは decode が返らないことがある**ので、待ちっぱなしは覆いの固着＝更新停止に直結する |

細かいが効くもの:
- `pointer-events: none` 必須。ベースサムネは `<a>` の中なので、**透明でも**ヒットテストに残って番組リンクを吸う。
- `z-index` を付けない。「位置指定あり・`z-index:auto`」ならベースサムネの上・`.anim_thumb_overlay`(z-index:1) の下に必ず入る（DOM順に依存しない＝オーバーレイが後から挿入されても順序が壊れない）。
- 覆いは `alt=""`。フェード後に `src` を手放すので、次の差し替えでは「まだ何も読めていない img」を不透明にする瞬間がある。`alt` が空ならそこは**何も描かれない**＝下のベースサムネがそのまま見える。`alt` があると壊れた画像アイコンが全面に一瞬出る。
- 連続差し替えでは前のアニメを `cancel()` してから覆い直す。**アニメーションは `style.opacity` より強い**ので、走ったままだと覆えない。

### 検証（実測）

`verify:e2e` の項目BJ。ページ側に rAF の観測を置き、`getComputedStyle(layer).opacity`
（＝Web Animations が実際に合成へ渡している値）を毎フレーム記録して後から判定する。
45秒で **フェード8回 / 10808フレーム**、長さは **516〜517ms**（500ms設定＋decode待ち）。

**壊して鳴るか確認済み**（2箇所を意図的に壊して1回ずつ走らせた）:

| 壊した内容 | 落ちた項目 |
|---|---|
| 覆いに古い絵でなく**新しい絵**を載せる | 「上に載っているのは古い絵で、下はもう新しい絵」だけがNG（他8項目はOKのまま） |
| CSSから `pointer-events: none` を削除 | 「🔴 覆いが番組リンクのクリックを奪っていない」だけがNG |

`verify:loop` の **BJ-static** に同じ2点＋α のソース検査を置いてある（e2e は約8分かかるので、
一番痛い1点は1分で落とせるようにした）。こちらも上記2つの破壊で 2/2 落ちることを確認済み。

## BK. コンソールに出ていた3件を実測で切り分けた（2026-08-02 / 利用者報告）

利用者から3つ挙がった。**古いコードのものかもしれない**という前置きだったので、
まず「今のコードで出るのか」「原因は何か」を実測で確定させてから直した。
結果は **1件が誤報・2件が実在**。推測で潰しにいかなかったのが正解だった経路がある（下記②）。

### ① `[サムネ] 動くサムネへの給餌が 2000ms 以内に返りませんでした` → **再現せず。IndexedDB 説は否定**

実拡張・動くサムネON・正常運転90秒で **0回**。そのうえで構造的な原因候補を2つとも潰した。

| 仮説 | 実測 | 判定 |
|---|---|---|
| 起動時の `cleanupFrames` が readwrite でストアを握り、後続の read を待たせる | 600件（上限300の2倍）で走査 **189ms**／裏で投げた get **188ms** | ✕ |
| `persistBuffer` の書き込み量（1レコード＝5コマ約150KB）が read を待たせる | 35本/秒（現実の10倍・5.25MB/秒）でも get は **6〜15ms** | ✕ |

**IndexedDB はボトルネックではない。** 参考: 掃除も書き込みも無い時の get は 0ms。

🔴 **警告文を「IndexedDB を疑ってください」に戻さないこと。** 旧文面がそう書いていたが、
上のとおり外れである。1回きりの警告（`ingestStallWarned` で打ち止め）で表示も無事なので、
**単発の重い瞬間を拾っただけ**と読むのが実測と整合する。文面もそう書き換えた。
毎回出るようになった時だけ調べる価値がある。

### ② `[followApi] 固定画像の番組 1件からライブスクショを回収できませんでした` → **誤報だった**

公開の recent 版（同一スキーマ・ログイン不要）で当日の実データ user 70件を数えた:

| | 件数 |
|---|---|
| `flippedListingThumbnail` キーを持つ | **17 / 70**（任意フィールド。持たないのが普通） |
| 固定画像運用（listingThumbnail がスクショ形でない） | 19 |
| うち flipped を持つ | 17 → **17/17 回収できていた** |
| 回収できなかった | **2** |

回収できなかった2件のキー構成が、**利用者のログと完全に一致**していた。
この2件は `listingThumbnail` 自体が**プロキシに包まれたスクショ**
(`listing-thumbnail…/?url=<エンコードした dlive URL>`) で、**その形の時 API は flipped を返さない**。
包まれた形は項目AA の事故を避けるため**こちらが意図的に弾いている**＝仕様どおり詳細APIへ回るだけ。

つまりスキーマは変わっておらず、回収機構も動いていた。旧条件が
「固定画像番組のうち**回収できた数が0**なら鳴らす」だったため、
**リストにこの形が1件しか無い回に必ず鳴っていた**。

🔴 **`flipped` を持っていない番組を母数に入れないこと。** 直した後の条件は2つ:
- **フィールド消失**: 固定画像番組が `FLIPPED_TRAP_MIN_SAMPLE`(8) 件以上あるのに誰も flipped を持たない
- **形の変化**: flipped は来ているのに1件も採用できる形でない

**どちらの分岐にも母数の下限を置く**（フィールド消失＝固定画像8件以上／形の変化＝flipped保持3件以上）。
実測で flipped を持たない番組は約1割、包まれた flipped も 22件中2件（2026-07-31）出た実績があるので、
母数が1〜2の回はどちらも偶然と区別できない。本当に壊れたなら母数は十分大きくなる（実測の carriers は17件）。
**誤報より見逃しを選ぶ**——見逃した時の実害は詳細APIの通信量だけで、表示は変わらない。

> 💡 未着手の改善余地: 包まれた形は `?url=` をデコードすれば中の dlive URL が取れる。
> **ホストで緩めるのではなく中身を取り出す**ので項目AA の事故にはならず、実測11%（19件中2件）が
> 詳細API送りにならずに済む。ただし要件が増えるので今回はやっていない。

### ③ `Uncaught Error: Extension context invalidated.` → **実在。しかも取得が止まっていなかった**

拡張をアンインストールして実測。**発生元はスタックで確定**（推測ではない）:

```
at HTMLImageElement.handleThumbnailError   sidebar.js（imgのerrorリスナ）
at syncStaticThumb → tick → requestAnimationFrame   ← rAF の中なので Uncaught になる
```

どちらも `chrome.runtime.getURL('images/loading.gif')`。**ライブサムネを持たない番組が
リストに居る回だけ**通る経路で、切り分けでも裏が取れた（その番組が無い構成では**0件**、
1件足すと**2件**）。

**より重いのはこちら: 取り残された content script が取得を続けていた。**
無効化後60秒で **サムネ +9回**、別の回で **follow +1 / notifybox +1**。
`cleanup` は `beforeunload`/`pagehide` でしか走らないので、誰も止めていなかった。
開発中の再読み込みだけでなく、**Chrome の自動更新でタブが開いていた場合にも起きる**。

直し方:
- `utils/extensionAlive.js` を新設。`chrome.runtime.id` が消えたら無効化とみなす。
- 検知は **各ループの tick の先頭**（`_thumbTick` / `_sidebarTick`）。専用タイマーを増やさずに済み、
  止めたい対象そのものが検知点になる。
- 🔴 **`_sidebarTick` では try に入る前に return すること。** try の中で返すと
  `finally` が次の目覚ましを張り、**止めたつもりでループが生き残る**（取得は0回なので
  「動いていない」ように見えて気付けない。検証 BK③ はこれを見るためにある）。
- `handleThumbnailError` / `syncStaticThumb` の getURL は `safeRuntimeUrl` に置き換え、
  検知が走るまでの隙間（最大1周期）でも uncaught を出さない。

🔴 **無効化での後始末で `cleanup()` をそのまま呼ばないこと。** cleanup 冒頭の関門4診断は
「後始末が走ったのにページが生き残っている＝異常」を見るものだが、**無効化ではページが
生き残るのが正常**なので必ず誤検知する。`cleanup('invalidated')` で診断だけ飛ばす。
ここを素通しにすると、利用者がためている自動移動の診断記録が嘘で埋まる。

実測（同じ probe・同じ構成で前後比較）: **サムネ +9回/uncaught 2件 → どちらも 0**。

### 検証

- `verify:loop` の **BK**（約12秒）: 無効化でループが止まるか＋**目覚ましを張り直していないか**、
  後始末フックが1回だけか、固定画像の罠が誤報しないか／壊れた時は鳴るか。
- 🔴 **`verify:loop` の chrome スタブに `runtime.id` を入れておくこと。** 無いと全ループが
  「無効化された」と判断して即死し、周期・描画の項目が14件まとめて落ちる（実際に落ちた）。

**壊して鳴るか確認済み**:

| 壊した内容 | 落ちた項目 |
|---|---|
| 無効化チェックを `try` の**中**へ移す | 「次の目覚ましを張り直していない」だけがNG（取得0回は**通ってしまう**＝この検査が無いと見逃す） |
| 罠の母数を旧条件（flipped 無しも含む）へ戻す | 誤報側2件がNG・「鳴るべき」2件はOKのまま |

---

## BL. Kick 連携で構成が変わった（2026-08-04）

「content script のみ・background なし」という構成上の特徴が**無くなった**。README・01・02 の記述は修正済み。

| 追加したもの | 理由 |
|---|---|
| `static/sw.js`（Service Worker） | `chrome.cookies` はコンテンツスクリプトから呼べない。Kick の認証は cookie の**値**を読んで Bearer に載せる必要がある |
| `static/options.html`（オプションページ） | `chrome.permissions.request()` はコンテンツスクリプトから呼べない。サイドバー内の設定 UI はニコ生ページの DOM なので要求できない |
| `src/kickPage.js`（2本目のエントリ） | kick.com 用。ビルドが単一 IIFE で Rollup は複数エントリを iife で出せないため、`vite.kickpage.config.js` で2回目のビルドを回す |

🔴 **Kick 関連の権限はすべて optional にしてある。** 必須にすると
**既存ユーザーの拡張が更新時に Chrome に無効化され、再承認するまで動かなくなる**。
新規インストール時の警告文が増えるより、こちらの方が離脱が大きい。

🔴 **`static/` はバンドルされない。** `icons/` `images/` と同じく dist へそのままコピーされる。
`import` が書けないので、権限定義・API URL・cookie 名が本体と**二重管理**になっている。
`sw.js` と `options.js` の `KICK_PERMISSIONS` は**必ず一致させること**。片方だけに足すと
「有効にしたのに動かない」「チェックが勝手に外れる」という形で出る。

⚠️ kick.com へのコンテンツスクリプトは **`chrome.scripting.registerContentScripts` で動的登録**している。
静的に `content_scripts` で宣言すると kick.com が必須のホスト権限になる。

---

## BL-2. 🔴 kick.com でサイドバーがプレイヤーに被る（3回外した・2026-08-04 解決）

**結論から**: Kick のレイアウトは **`w-xvw`（＝100vw）などビューポート単位**で組まれている。
ページ本体を細くしても中身は 100vw を主張し続けるので、はみ出して左端に居座る。

正解は**2つで1組**。片方だけでは効かない。

1. `body` にインラインで `margin-left: W` と `width: calc(100vw - W)`（`kickPage.js` の `applyShift`）
2. **`w-xvw` / `w-screen`（と min-/max- 派生）を `calc(100vw - W)` に `!important` で読み替える**（`kickPage.css`）

対象は Kick 固有名ではなく**汎用のユーティリティ名**なので、向こうの実装変更には比較的強い。

### 外した3回（同じ轍を踏まないために残す）

| # | やったこと | なぜ駄目だったか |
|---|---|---|
| 1 | `<html>` に `margin-right` | Kick の `position: fixed` 要素が viewport 基準のままで動かない、と考えた |
| 2 | `body` に `transform` | 「transform は子孫の `position: fixed` の包含ブロックになる」を当てにした。**実機では body に transform が効いているのに子孫が x=0 に居た。** そもそも Kick のレイアウト要素は fixed ではなく static / relative で（fixed は不可視の計測用 iframe だけ）、transform を使う理由自体が無かった |
| 3 | MutationObserver で書き戻し | 下の BL-3 |

⚠️ **推測で3回打った結果、遠回りした。** 最終的に「注入と同時に250ms×32回サンプリングして
自動でコンソールへ出す診断コード」を仕込んで初めて原因が見えた。
**症状が読み込み直後に起きる場合、コンソールに手で貼る方式では間に合わない。**
拡張側に仕込んで自動で記録すること。

---

## BL-3. 🔴 kick.com で MutationObserver を使ったらブラウザが固まった（2026-08-04）

`body` の属性変化を監視して、寄せが打ち消されたら書き戻す実装にしたところ、
**kick.com を開いた瞬間にブラウザごと操作不能**になった。

MutationObserver のコールバックは**マイクロタスク**で走る。こちらの書き戻しと相手の書き換えが
噛み合うと、**1フレームも返さないまま延々と往復する**。
「値が同じ時は書かない」ガードを入れても、**相手が書き換え続ける限り止まらない。**

🔴 **kick.com 側には MutationObserver を置かない。**
変化に反応するのをやめ、**500ms ごとに現状を突き合わせて直すだけ**にした（`startReconciler`）。
SPA でサイドバーが消えた場合の差し込み直しも、この1本に集約してある。
取りこぼしても次の周期で直る。最悪でも 0.5 秒遅れるだけで、固まらない。

---

## BL-4. CSS のテーマ変数が body 定義だったため、Kick 側で開閉ボタンが消えた（2026-08-04）

`--sb-*` は `body` に定義されている。kick.com のサイドバーは**body の外**（`<html>` 直下）に置いてある
（ページを寄せる方式の都合。当時は body へ transform を掛けていた）。
カスタムプロパティは継承なので、**body の外の要素には届かない**。

結果、`--sb-line`（開閉ボタンの背景）も `--sb-arrow`（矢印）も透明になり、
**ボタンが存在するのに見えない**状態になった。「スタイルが崩れている」という報告の実体もこれ。

`main.css` の変数定義のセレクタに `#niconamasidebar-kick-root` を追加して解決。
⚠️ テーマのクラス名は **`nicosidebar-light`**（ダークが既定、ライトの時だけ付ける）。
付ける先は body ではなく**サイドバーのルート**。

⚠️ あわせて、**`setProgramContainerWidth` を描画のたびに呼ぶこと**。
Kick 側で呼び忘れており、カードが幅いっぱいに広がって常に1列になっていた。

---

## BL-5. 人気順が「勢い」から「推定同時視聴者数」に変わった（2026-08-04）

**項目 AY・BE・BE-2・BG で積み上げた調整は、順位計算の経路から外れた。**
`momentum` も `commentWeight` も残ってはいるが、**順位には使っていない**
（`data-total` / `data-comment-weight` は実機観察用の覗き窓として属性に残してある）。

### なぜ変えたか

人気順の**本来の目的は「同時視聴者数で並べること」**だった。ニコ生が同接を公表していないので
勢いスコアという代替指標を作っていた。Kick 対応で同接が実測で手に入るようになったため、
本来の目的に戻した（利用者判断）。弾幕による誤判定が消えるのは副次的な利点。

```
ニコ生: 推定同接 = EMA(Δ来場者/分) × min(W, 放送開始からの経過分)
Kick:   viewer_count（実測。生値が飛ぶので軽く平滑化）
```

- `momentum.js` に `initialViewerRate` / `nextViewerRate` / `estimateConcurrentViewers` を追加
- **来場者だけの EMA** を新設した。`momentum` はコメントを含むので人数の推定には使えない
- 人気順の第2キーを `data-total` から **`data-begin-at`** へ差し替えた。
  累計エンゲージメントはコメントを含むため **Kick では常に 0 になり、混在時に Kick が必ず沈む**

### 🔴 W の効き方を取り違えないこと

設計時に「W はニコ生内部の順位を変えない（両サービスの釣り合いだけ）」と説明したが**誤り**だった。
検証で反例が出た。正しくは:

- 経過が W を**超えた**番組どうし → 一律に W を掛けるだけなので順位は変わらない
- 経過が W **未満**の若い番組が混ざると → 係数が W ではなく「経過分」になるため、
  **W を大きくすると続いている番組が若い番組より上に来る**
- 反例: 若5分/毎分30人 と 古60分/毎分10人 は W=10 なら若が上、W=20 なら古が上

つまり W は「ニコ生と Kick の釣り合い」と「新しい番組 vs 続いている番組の釣り合い」を同時に動かす。

---

## ✅ BM. 既存カードの引き当てが毎周期外れ、リスト全体がチラついていた（kick.com）

### 症状

kick.com のサイドバーで、定期更新のたびに**リスト全体が一瞬チラつく**。
起きる時と起きない時があり、目視では法則が掴めなかった。

### 誤った読み（3回外した）

1. 玉突きで順位がずれている → 順位は変わっていなかった
2. 見えていないカードの並び替え → 無関係。撤回した
3. `replaceChildren` で全カードが DOM から外れ、画像が再デコードされている
   → **測って外れた。**同期処理は 11.6ms、直後のフレームは 2 / 8 / 11 / 17ms で
   どこも詰まっていない。描画コストの問題ではなかった

### 実際の原因

観測用に仕込んだログの**「新規23枚 / 35枚」**が決め手だった。
毎周期、35枚中23枚が「新しく作られたカード」になっていた。

```js
// src/kickPage.js（当時）
const id = String(data.id)        // 'lv123456789'
const el = existingMap.get(id)    // カードの DOM id は '123456789'
```

カードの DOM id は `deriveCardFields` が `lv` を外した数値。生の `data.id` で引くと
**ニコ生の番組だけ必ず引き当てに失敗し、毎周期カードを作り直していた**。
Kick の id は `k120598162` で `lv` が付かないため一致し、そちらは正常だった。
23 はニコ生の全件。

要素を作り直すと `<img>` も作り直されるので画像が読み直され、リストがチラつく。
**例外もログも出ず、表示自体は正しい**ので目視では気付けない。

### なぜ起きたか

`.replace(/^lv/, '')` が3箇所に手書きで散っていた（sidebar.js / UpdateManager.js / kickPage.js）。
kickPage.js を書いた時に1箇所だけ抜けた。

### 対処

`cardIdOf()` を `render/sidebar.js` に置き、**唯一の定義**にした。引き当てる側は必ずこれを通す。

### 巻き込みで見つかったもの

kick.com 側にはリストから外れたカードの blob URL を解放する処理が**抜けていた**
（ニコ生側にはある）。毎周期23枚が捨てられていた間、動くサムネのコマが漏れ続けていた。

### 検証（項目 BM）

- **実挙動**: 同じ番組で2周させ、カードが**同一オブジェクトのまま**か
- **静的**: `cardIdOf` が1つだけか / 両ページの引き当てがそれを通るか

🔴 **件数で数えないこと。** 作り直しても件数は変わらないので素通りする。この事故がまさにそれだった。

わざとバグへ戻して、ニコ生側は実挙動＋静的の両方が、kick.com 側は静的が落ちることを確認済み。
実挙動の検査は kick.com では鳴らない（kickPage を動かすハーネスが無い）ので、そこは静的が受け持つ。

### 教訓

**観測点を作ってから読むこと。**3回とも「もっともらしい理屈」で外した。
決め手になったのは推論ではなく `新規23枚` という数字ひとつだった。

---

## ✅ BN. kick.com ページにだけ無かった機能（サイドバーの中身を両ページで同一にする）

サイドバーの中身は両ページで同一仕様、というのが利用者の要求（2026-08-04）。
`kickPage.js` を書いた時に、ニコ生ページ側の以下が抜けていた。

| 抜けていたもの | 症状 |
|---|---|
| 更新ボタンのローディング表示 | 定期更新でも手動でもスピナーが回らない |
| 境界線ドラッグでの幅変更 | kick.com 上では幅を変えられない |
| 開いた時の矢印の向き | 開いても矢印が「開く向き」のまま |
| 境界線のリサイズカーソル | 掴めることに気付けない |
| 「自動で開く = ON（常に開く）」 | `isOpenSidebar` 直読みで、常に「記憶」の動きだった |
| Esc で設定を閉じる | 効かない |
| 取得できない時の案内（`#api_error`） | 黙って何も出ない |

### 併せて直した取得失敗の扱い

`fetchNicoPrograms` が失敗時も 0 件時も `[]` を返していた。片方の API が一瞬落ちただけで
**そのサービスのカードが全部消え、次の周期で戻る＝点滅する**。
`{ok, programs}` に変え、取れなかったサービスは前回の結果を据え置くようにした。

⚠️ 据え置いた値で `upsertProgramInfos` を上書きしないこと。同じ値で上書きすると差分が 0 になり、
盛り上がりの推定が実際より低く出る。

### 再発防止

同じことを2箇所に書かない。共有できるものは `render/sidebar.js` に出した。

- `setReloadButtonLoading()` … ローディング表示。**class を触るのはここだけ**
- `shouldOpenSidebarAtStart()` … 「自動で開く」の解釈
- `minLoadingDurationMs` … スピナーの最低表示時間（両ページ共通の定数）

🔴 **スピナーの消灯は `finally` に置くこと。** 途中で throw すると点きっぱなしになり、
多重防止のフラグも下りず、そのページでは更新が二度と通らなくなる（ニコ生側で過去に踏んだ形）。

⚠️ kick.com は SPA でサイドバーごと差し込み直す。root の中に張ったリスナーは一緒に消えるが、
**`document` へ張ったものは残って積み上がる**（Esc のリスナーは `escKeyWired` で1度だけにしてある）。

---

## ✅ BO. 🔴 kick.com で開閉するとサイドバーの中身と境目ラインが分離する（2026-08-07 解決）

### 症状

kick.com でサイドバーを開閉すると、**中身（`#sidebar`）と境目ライン（`#sidebar_line`）が
離れて見える**ことがある。**毎回ではなく、まれに**。

### 原因

**2つを別々のプロパティでアニメーションさせていた。**

| 要素 | 動かしていたもの | 進むスレッド |
|---|---|---|
| `#sidebar` | `transform: translateX(-100%)` → `translateX(0)` | **コンポジタ** |
| `#sidebar_line` | `left: 0` → `left: var(--nns-kick-width)` | **メインスレッド** |

`transform` はコンポジタで進むのでメインスレッドが詰まっても止まらない。
`left` はレイアウトを伴うのでメインスレッドのフレームでしか進まない。
**詰まったぶんだけラインが取り残される。**

しかも詰まる要因は、この開閉自身が2つとも作っている。

1. `body { transition: margin-left .18s, width .18s }` … `margin` / `width` のアニメは
   毎フレーム全ページのレイアウトを起こす。ラインが `left` を進めたい 180ms と同じ区間
2. `setOpen()` の末尾で `refreshPrograms()` … 応答が返るとカードを最大35枚組み立て、FLIP が
   同期でレイアウトを読む

ブロックが 180ms を越えると、**コンポジタは中身を最後まで開ききるのに、ラインは動かないまま
残り、解けた瞬間に飛んで追いつく。** 配信の再生状況などでページの重さが変わるので、
「まれに」に見えていた。

### なぜ「時間の問題」と言い切れたか

2つは同じ root の兄弟で、位置は同じ `--nns-kick-width` 1本から決まり、
`position: fixed` の基準（包含ブロック）も同じ。**幅の値でも DOM の構造でも食い違えない。
残る自由度は時間だけ。**

### 直し方

**動く要素を1つに減らす。** root だけを動かし、中身とラインはその箱に貼り付ける。

```css
#niconamasidebar-kick-root {
    position: fixed; top: 0; left: 0;
    width: var(--nns-kick-width); height: 100vh;
    transform: translateX(-100%);
    transition: transform .18s ease;
    overflow: visible;   /* 🔴 閉じている時、ラインは箱の外に居る。切ってはいけない */
}
#niconamasidebar-kick-root.is-open { transform: translateX(0); }

#niconamasidebar-kick-root #sidebar      { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
#niconamasidebar-kick-root #sidebar_line { position: absolute; top: 0; left: 100%; height: 100%; }
```

閉じている時、root の箱は `[-W, 0]`、`left: 100%` のラインは `[0, 5]` に来る。
**閉じていてもラインは画面左端に見える**（これが唯一の開く手段なので必須）。

🔴 **中身とラインには `transition` を付けないこと。** `#sidebar` には main.css の
`.sidebar_transition`（= `all 0.5s`）が付いている。打ち消さないと幅の変更が 0.5s かけて
追従し、root と食い違う。

**幅を変えた時の分離も同時に消える。**旧実装では、他ページから幅が同期されると
中身の `width` は即座に・ラインの `left` は 180ms かけて動いていた（同じ形のバグ）。
今は箱が変わるだけなので、中身もラインも即座に追従する。

### 一緒に直したもの: 掴んだポインタの取りこぼし

`enableSidebarLineDrag` が `mousemove` / `mouseup` を `documentElement` に張っていた。
**ウィンドウの外へポインタを出して離すと `mouseup` が来ない。**リスナーが残り、以降は
ボタンを押していなくてもカーソルを動かすだけで幅が変わり続ける（`nns-kick-dragging` も
付いたまま＝開閉のアニメが死んだまま）。

`pointerdown` + `setPointerCapture` に変えた。枠外で離しても `pointerup` はこの要素に届き、
OS にポインタを取り上げられた場合は `pointercancel` になる。どちらも `lostpointercapture` に集まる。
取りこぼした時の保険として、定期の突き合わせが `isDraggingLine` を見て印を剥がす。

### 検査（項目 BO）

守るのは **kickPage.css の中でアニメーションする要素が root と body だけ**という一点。
期待値はべた書き（実装から作ると、実装が変わった時に一緒に動いて何も検査しなくなる）。

わざと旧実装へ戻して 11 項目が落ちることを確認済み。
`lostpointercapture` の検査は最初 **語の有無**で見ており、配線を消しても
`removeEventListener` 側の語で通ってしまった（空振り）。`addEventListener('...` を要求する形に直した。

---

## ✅ BO-2. ラインと Kick のコンテンツの間に余白が無かった（2026-08-07）

### 症状

境目ラインのすぐ右に Kick のコンテンツ（フォローリスト等）があり、**少し被る**。

### 原因

`applyShift()` が寄せていた量が**サイドバー幅 W ちょうど**だった。実際に画面を占めるのは:

| 要素 | 位置 |
|---|---|
| サイドバー | `[0, W]` |
| 境目ライン（5px） | `[W, W+5]` |
| 開閉ボタン（20px・高さ70px） | `[W, W+20]` |

W だけ寄せると、ラインとボタンがコンテンツの上に乗る。
**ボタンのほうが太い**ので、ライン幅の 5px を足すだけでは足りない。

### 直し方

`config/constants.js` に `kickContentGap = 24` を置き、寄せ幅を `W + gap` にした。
ラインから 19px、ボタンから 4px 離れる。

🔴 **寄せ幅（JS）と読み替え幅（CSS）は必ず同じ式にすること。**

```js
// kickPage.js
const w = currentWidth() + kickContentGap
body.style.marginLeft = `${w}px`
body.style.width = `calc(100vw - ${w}px)`
```
```css
/* kickPage.css・w-xvw / w-screen の読み替え */
width:     calc(100vw - var(--nns-kick-width) - var(--nns-kick-gap)) !important;
max-width: calc(100vw - var(--nns-kick-width) - var(--nns-kick-gap)) !important;
```

片方だけ直すと、中身が body の内容領域より広く／狭くなって**右端がはみ出すか隙間が空く**。
定数は `kickContentGap` の1つだけ。CSS 変数 `--nns-kick-gap` は `applyWidth()` が流し込む
（kickPage.css の `:root` にある値は既定値の写しで、直しても効かない）。

⚠️ ドラッグの上限（`innerWidth - 240`）からも余白を引くこと。忘れるとページ側に残る幅が 240px を切る。

### 閉じている時も空ける（同日に追加）

閉じてもサイドバーが画面外へ出るだけで、**開閉ハンドルは残る**（ラインが `[0, 5]`、
ボタンが `[0, 20]`）。閉じた時の寄せを 0 にすると同じ被りが戻る。

```js
function reservedWidth() {
    if (!isActive) return 0
    return (isOpen ? currentWidth() : 0) + kickContentGap   // 🔴 余白は三項の「外」
}
```

⚠️ **`isOpen` ではなく `isActive` で寄せを外すこと。**閉じただけで外すと、
その瞬間にページが 100vw へ戻ってハンドルの下へ潜り込む。
寄せを外してよいのは連携を切った時（teardown）だけ。

### 🔴 CSS 側で寄せ幅を計算し直さない

閉じた状態を足した時点で式が2通り（開＝幅＋余白 / 閉＝余白だけ）になり、
**JS と CSS で同じ計算を手で揃える約束は保てなくなった。**
`reservedWidth()` が出した数値を `--nns-kick-reserved` 1本で渡し、CSS は引くだけにする。

```css
width:     calc(100vw - var(--nns-kick-reserved)) !important;
max-width: calc(100vw - var(--nns-kick-reserved)) !important;
```

⚠️ 読み替えと保護は **`nns-kick-active`**（連携が有効な間ずっと）で当てる。
`nns-kick-open` は廃止した。開いている間だけ当てると、閉じた瞬間に中身が 100vw へ戻る。

### 検査（項目 BO・39項目）

わざと壊して落ちることを確認済み。以下の4つがそれぞれ NG になる。

1. 余白を三項の中へ入れる（閉じた時に 0 になる）
2. `isOpen` で寄せを外す
3. CSS 側で寄せ幅を計算し直す
4. `nns-kick-open`（開いている間だけ）で当てる

### 空いた部分の色

`body` に `margin-left` を当てているので、空いた帯は **body の背景がキャンバスへ伝播したもの**が
見える＝ページ自身の地の色になり、テーマに自動で追従する。
⚠️ **Kick が背景色を body/html ではなく内側の div に塗っていた場合は、ここが白い帯になる。**
その時は「ラインを 24px の帯にして `--sb-line` で塗る」に切り替える（色をこちらで持てる）。

---

## ✅ BO-3. ダークで境目ラインと開閉ボタンが見えなかった（2026-08-07）

`--sb-line`（ラインと開閉ボタンの背景色）が `--sb-bg` と同じ `#111` だった。
**ボタンは存在するのに背景に溶けていた**（矢印だけが浮いて見える状態）。

ライトは白背景に対して 1段落とした色（`#fff` → `#d5d9df` ≒ 40/255）を当てていたので、
ダークにも**同じ幅の段差**を当てた（`#111` → `#3a3a3a` ≒ 40/255）。

検査（項目 BO）: 各テーマ定義で `--sb-bg` と `--sb-line` が**異なる値**であることを見る。
同じ値に戻すと落ちることを確認済み。

⚠️ この変数は両ページ共有。ニコ生ページのダークにも同じく効く（サイドバーの中身は両ページで同一）。

---

## ✅ BP. 設定パネルの ON/OFF の並びが揃っていなかった（2026-08-07）

オートオープンだけ `ON / OFF / 記憶` で、他のトグル（自動移動・動くサムネ）は `OFF / ON` だった。
隣の設定と同じ位置を押したつもりで逆の値を選んでしまう。`OFF / ON / 記憶` に揃えた。

🔴 **入れ替えたのは表示順だけ。** `autoOpen1='1'=ON` / `autoOpen2='2'=OFF` の対応は動かしていない。
値を振り直すと、**既存利用者の保存値の意味が反転する**（ON にしていた人が OFF になる）。

⚠️ 色付けは `input:checked + label`（隣接セレクタ）なので、input と label は必ず対で動かすこと。
⚠️ この HTML はテンプレートリテラルの中。**コメントにもバックティックを書かないこと**
（書いて実際にビルドが落ちた。数行上に同じ注意書きがある）。

検査（項目 BP）: ラベルに ON と OFF の両方を持つ設定は、**OFF が先に出る**こと。
順序を戻すと落ちることを確認済み。

---

## ✅ BQ. 自動更新の「180秒」を廃止して「OFF」にした（2026-08-07）

120 と 180 は 1.5 倍しか違わず選ぶ意味が薄い。一方「通信を止めたい」はどの選択肢でも
満たせなかった。`30 / 60 / 120 / OFF` に置き換えた。

### OFF で止まるもの・止まらないもの

| | OFF の時 |
|---|---|
| 番組リストの取得 | **止まる** |
| 終了した番組の除去 | **止まる**（更新サイクルの中で走るため、終わった番組が残る） |
| 人気順の推定同接 | **固まる**（周期ごとの差分で出しているため） |
| サムネ更新 | 動く（別ループ） |
| 自動移動 | 動く（`startLiveStatusWatcher` が視聴中の番組を直接見ており、更新ループとは独立） |

「終了した番組が残る」は不具合に見えるので、ヘルプ文に明記してある。

### 🔴 無言で壊れる3つ

**1. OFF が 120秒として動く**

```js
Math.max(30, Number(options.updateProgramsInterval) || 120)   // ❌ Number('off') = NaN → 120
```

**2. NaN が 0ms のループになる**

```js
setTimeout(fn, Number('off') * 1000)   // ❌ NaN は 0 扱い。API を叩き続ける
```

判定は `autoUpdateIntervalMs()`（`render/sidebar.js`）に集約した。**OFF なら `null`**、
壊れた値・未設定なら既定へ寄せる。**NaN も 0 も Infinity も外へ出さない**
（Infinity も `setTimeout` に渡すと 0 に丸められる）。

⚠️ 保存値は文字列 `'off'`。`'0'` にしないこと。`Number('0') || 120` は 0 が falsy なので
**120 に化ける**。

弾く場所は1箇所に集めた。ニコ生は `_scheduleSidebarTick`（開始・位相リセット・張り直しの
3経路が全部ここを通る）、kick.com は `startTimer` のリスト側だけ（サムネ側は素通り）。

**3. 廃止した選択肢を選んでいた人が、設定を一切保存できなくなる**

保存値 `'180'` に対応するラジオが無いと `updateCheckedState` は**どれも選ばない**状態にし、
`saveOptions` は「1つも選ばれていない」で早期 return する。
その利用者はテーマも並び順も保存できなくなる。**例外もログも出ない。**

🔴 **選択肢を消す時は `storage.js` の `migrateOptions` へ寄せ先を足すこと。**
`getOptions` が保存値を読む唯一の入口で、寄せた値はそのまま書き戻されて永続化される。
`'180'` → `'120'` に寄せた（OFF ではなく。黙って取得が止まるほうが驚きが大きい）。

### 検査（項目 BQ・19項目）

正規表現だけでなく**実際に関数を呼んで**確かめている（OFF は null / 60→60000 /
壊れた値でも有限 / 0 と負値を採用しない）。期待値はべた書き。

静的側では「保存値を直接 `Number()` している場所が無い」ことと、
**移行元が選択肢から消えていること・移行先が選択肢に実在すること**、
**両ページの既定値が選択肢に実在すること**を見ている。

上の3つの失敗形をそれぞれ再現して、落ちることを確認済み。

---

## ✅ BR. サービスタブに「統合」を足した / 設定名を「番組表示方法」にした（2026-08-07）

タブ分離モードのタブを **統合 / ニコ生 / Kick**（統合が一番左）にした。
「統合」の見え方は設定の「統合表示」と同じ＝全件出す。設定名は「表示方法」→「番組表示方法」。

### 定義が3箇所に散る

| 場所 | 何を持つ |
|---|---|
| `SERVICE_TABS`（sidebar.js） | 使ってよいタブ名の一覧。**唯一の定義** |
| `buildSidebarShell` の HTML | `data-service-tab` を持つボタン。並び順もここ |
| main.css | どのタブで何を隠すか |

ずれると **カードが1枚も見えない**（知らない値が属性に入る）か
**絞ったはずのカードが残る**という形で出る。検査（項目 BR）で3箇所の一致を見ている。

### 🔴 「統合」で踏みやすい3つ

**1. 出し分けの CSS に mixed を書いてしまう**
統合は**何も隠さない**のが正しい。書くと統合タブなのにカードが消える。

**2. バッジの一括指定**

```css
#liveProgramContainer[data-service-tab] .service_badge { display: none }   /* ❌ 統合でも消える */
```

片方だけのタブは**タブ自体がラベル**なのでバッジは要らないが、統合は両方が混ざるので
**どちらのカードか分からなくなる**。タブ名を名指しして隠すこと。

**3. 件数を絞り込みの式に混ぜる**
`countVisibleByTab` で mixed を早期 return しないと `svc !== 'kick'` 側に落ち、
**見えているのに Kick のぶんだけ件数が足りない**。

⚠️ 保存値が壊れていた時に備え、`SERVICE_TABS.includes()` を通らない値は採用しない。
知らない値をそのまま `data-service-tab` に入れると、どの CSS とも一致せず全部消える。

### 🔴 余白は margin ではなく padding で組む

「見出し→タブ→リスト」の間隔を調整した（タブを 12px 上げ、タブ下を 8px 広げた）。

```
.sidebar_body        padding-top:  8px   ← 見出しとの間
.service_tabs        margin:  0 8px 2px
#liveProgramContainer padding-top: 12px   ← カードの上
```

タブ無し: 8＋12＝**20px**（従来と同じ）／タブ有り: 上 8px・下 2＋12＝**14px**。

**margin で組むと足し算にならない。** 兄弟どうしの margin は**相殺**して大きいほうだけが残り、
さらに `.sidebar_body` に padding が無いと中の子の margin が親をすり抜けて見出しの margin と
相殺する。padding は相殺されないので、上の足し算がそのまま効く。
`.sidebar_header { margin-bottom: 0 }` にしてあるのはそのため。

⚠️ 設定パネルはタブの都合で動かさない（`.sidebar_body.show-settings { padding-top: 20px }`）。
⚠️ `#api_error` の上マージンを 20px→12px にしてある（body の 8px と足して従来と同じ位置）。

### 検査で自分が踏んだこと

余白の検査で `margin-bottom:\s*(-?\d+)px` と書き、**単位なしの `0` を拾えず**
「見つからない＝null」で意図と逆の結果を出した。**CSS の長さを読む正規表現は `0` を単位なしで
書けることを前提にする。** margin ショートハンドも同じ理由で分解して読む。

上の5つ（JS/HTML 不一致・mixed を隠す・バッジ一括指定・件数・margin へ戻す）を
それぞれ再現して落ちることを確認済み。

---

## ✅ BS. 番組カードの大きさを設定できるようにした（2026-08-07）

「カードの大きさ」小 / 中 / 大 を追加（自動更新の上）。**既定の「中」は従来と完全に同じ。**

### カード幅は「サイドバー幅 ÷ 列数」しか取れない

列数は整数なので、幅360pxなら **360 / 180 / 120px の3通りだけ**。
段数を増やしても狭い時は効かない（5段にしても360pxでは3通りしか出ない）。
だから3段にし、細かく調節したい時はサイドバー幅のドラッグと組み合わせてもらう。

設定が動かすのは2つ。

| | 何が変わるか | 小 / 中 / 大 |
|---|---|---|
| `columnFactor` | 列を増やすしきい値の倍率。**大きいほど列が増えにくい＝1枚が広い** | 0.7 / 1 / 1.45 |
| `contentScale` | アイコンと文字の倍率（CSS 変数 `--nns-card-scale`） | 0.85 / 1 / 1.15 |

幅360px → 小3列(120px) / 中2列(180px) / 大1列(360px)
幅600px → 小4列(150px) / 中3列(200px) / 大2列(300px)

⚠️ 列数の上限は8のまま（しきい値が7個）。幅1500px超では小と中が同じになる。従来からの仕様。

### 🔴 「中」は 1 / 1 から動かさない

既定値なので、ここがずれると**誰も設定を触っていないのにレイアウトが変わる**。
検査は幅8点で旧実装の列数（1/1/2/2/3/4/5/8）と突き合わせている。期待値はべた書き。

### 引数ではなく setCardSize で流し込む

`setProgramContainerWidth` の呼び出しは10箇所ある。引数を足すと、片方のページで
1つ渡し忘れた時に**そこだけ既定に戻る**という無言の壊れ方をする（`setDwellMinutes` と同じ形）。
両ページが起動時と設定変更時の**2箇所**で呼ぶことを検査で縛っている。

⚠️ ニコ生ページの `storage.onChanged` は**モジュール直下**にある。`setup()` 内のローカル
`state` は見えないので、幅は `appState.sidebar.width` から取ること（参照すると実行時に落ちる）。

⚠️ アイコンは枠(`a`)と画像(`img`)の両方を同じ式で拡縮すること。片方だけだと枠から画像がはみ出す。

### 🔴 モックの要素に style.setProperty が無くて13件落ちた

`setProgramContainerWidth` が CSS 変数を書くようにした瞬間、描画系の検査が13件 NG になった。
原因は実装ではなく**モックの要素の `style` が素の `{}` だった**こと。
本物の要素は必ず `setProperty` を持つ。`scripts/mock-dom.mjs` と
`verify-sidebar-loop.mjs` の要素モック（3箇所）に持たせて解決。

**dataset で踏んだのと同じ話（項目AR）。** モックに足りないものがあると、
実装の正否と無関係な NG が大量に出て、実装側を疑って時間を溶かす。

### 検査で自分が踏んだこと（2件とも空振り）

1. `setCardSize` の有無だけを見ていた。起動時の呼び出しを消しても
   **onChanged 側の同じ語**が引っかかって通った。→ 件数と、変更ブロック内にあるかの両方を見る
2. 「幅が NaN でも列数1以上」を守るガードを置いていたが、**外しても結果が変わらなかった**。
   `columns` は 1 から始めて増やすだけで、NaN との比較は全部 false になるため。
   死んだコードだったので削除した（検査は残す。構造として成り立つ不変条件なので）

上の5つ（既定をずらす／kick が反映しない／CSS 変数の既定を消す／img だけ拡縮を戻す／
起動時の呼び出しを消す）を再現して落ちることを確認済み。

---

## ✅ BT/BU. 自動移動を Kick に対応させた（2026-08-07）

### まず見つかったこと: ニコ生ページでも Kick へは移動していなかった

移動先の判定が `/watch/(lv\d+)` に一致するリンクだけを見ており、
**Kick のカードは黙って候補から外れていた。** エラーも出ない。

### 移動先の選び方（項目BT・共有）

`render/sidebar.js` の `pickAutoNextTarget(container, currentUrl)` に集約した。
利用者の指定で**サービスをまたぐ**／**見えているタブから**選ぶ（2026-08-07）。

1. 今のタブで見えているカードから選ぶ
2. DOM 順の先頭から
3. 今いる放送と同じものは飛ばす
4. 🔴 **今いる放送が分からない時は選ばない**

4 が要。Kick は `kick.com/<slug>` がチャンネルページだが、`/browse` や `/video/xxx` も
同じ形をしている。緩くすると**一覧ページや VOD を見ているだけで飛ばされる**。
識別子は `watchTargetIdOf(url)` が唯一の定義（`nico:lv123` / `kick:slug` / `''`）。
予約パスの一覧もここだけに置く（診断コード側に写していたのを検査に見つけられて消した）。

⚠️ タブの見え方の規則（`isCardVisibleInTab`）は**件数表示と共有**すること。
別々に書くと**見えていないカードへ自動移動する**形で食い違う。CSS との一致も検査で見ている。

### Kick の終了検知（項目BU）

**採れなかった手が2つある。**

| 手 | なぜ駄目か |
|---|---|
| Kick の DOM を見る | 「kick.com の DOM 構造・クラス名に一切依存しない」方針を崩す。向こうの実装変更で無言で壊れる |
| フォロー中一覧から消えた＝終了 | **不在からの推測**。doc/09 項目BF-2 でニコ生側が事故を起こしてやめた形。そもそもフォローしていないチャンネルは最初から一覧に居ない |

採ったのは**本人に直接聞く**形（ニコ生が番組詳細API に `liveCycle` を聞いているのと同じ位置）。
公開API `/api/v2/channels/<slug>`。認証不要で、アイコン補完でも使っている。

**2026-08-07 に実機で両方の状態を確認済み**（こちらからは Cloudflare に 403 で弾かれるので、
ブラウザからしか確かめられない。診断コードを入れて利用者に見てもらった）:

```
配信中   sinzi_jimny  livestream = {id, slug, ..., is_live, viewer_count, ...}
配信なし usane        livestream = null
```

応答は **64ms 〜 1117ms** とばらつく。15秒間隔で聞き、**重ねて投げない**（`inFlight`）。

### 🔴 動いてよい場面は2つだけ

```
1. 配信中を一度見たあとに配信なしへ変わった   … 目の前で終わった
2. 自動移動で飛んできた先が配信していなかった … 続けて次を探す
```

**「開いた時点で配信していない」だけでは動かない。** 動かすと、自分で開いたチャンネルが
配信前／配信後だった時に**見始めた瞬間に連れて行かれる**（ニコ生のタイムシフトと同じ話・項目BI-2）。

**答えが得られなければ動かない。** HTTP エラー・通信エラー・JSON 破損・`livestream` キーが
無い（＝仕様変更）は、すべて `KICK_UNKNOWN` にして何もしない。
ここを「配信なし」に倒すと、**回線が不安定なだけで勝手にページを移る**。

### 🔴 sessionStorage はオリジンをまたげない

「自動移動で飛んできた」印は sessionStorage に置いていたが、**ニコ生 ⇄ kick.com では読めない**。
`chrome.storage.local` にも**飛び先の識別子つき**で置くようにした
（`markAutoNextHop(targetId)` / `consumeAutoNextHopMark(currentId)`）。

⚠️ **識別子で照合すること。** 照合しないと、読まれずに残った印が
「あとから自分で開いたページ」に効いてしまう。印は1回で使い切る。

⚠️ **印を読み切ってから監視を始めること。** 監視は開いた直後に1回聞きに行くので、
順序が逆だと「飛んできた先か」が未確定のまま最初の判定が走る。

### 共有したもの

モーダル・カウントダウン・移動先選びは `AutoNextManager` のまま両ページで共有。
**違うのは終了の見張り方だけ**なので、`startWatcher(updateSidebarFn, observeFn)` の
第2引数で差し替える（既定はニコ生の DOM 監視）。

### 検査（BT 32項目 / BU 26項目）

作り物の DOM と `fetch` の差し替えで**実際に動かして**確かめている。
BT は5つ、BU は5つの壊し方を再現して落ちることを確認済み。

**検査で自分が踏んだこと（また空振り2件）:**
1. `chrome.storage.local.set` の近くで `autoNextHop` を探していた。キー名は**定数の宣言側にしか
   出ない**ので、書いてあっても見つからない。定数名で見るように直した
2. `inFlight` の**語の有無**で見ていた。門番の `if` を消しても代入が残るので通ってしまう。
   `if (stopped || inFlight) return` を要求する形に直した

---

## ✅ BV. 🔴 Kick のレイドと自動移動が干渉する（2026-08-07）

**レイド** = 配信者が放送を終える時にリスナーをまとめて別チャンネルへ送る Kick の機能。
向こうも**モーダルとカウントダウンを出す**。利用者からの指摘で調べ、3つの問題が見つかった。

### 1. 🔴 カウントダウン中にページが移っても止まらない（素の不具合）

`scheduleNavigation` は `nextHref` を握ったまま、満了時に無条件で `location.assign` していた。
**kick.com は SPA なので、レイドの移動ではページが破棄されずタイマーが生き残る。**
結果、**レイド先に着いた数秒後にこちらが別の配信へ引きはがす。**

ニコ生では遷移が必ずフルロードでタイマーごと消えるため、この穴は表に出ていなかった。
**SPA のページに載せた時点で、「ページが生きたまま URL が変わる」を前提にし直す必要がある。**

関門を3箇所に置いた（`movedAway()` = 開始時の識別子と今の `location.href` を比べる）。

| 場所 | 理由 |
|---|---|
| 毎秒の見張り | レイドで移された瞬間に気付く |
| 満了時 | 見張りの隙（最大1秒）に移された場合の保険 |
| サムネクリック | 押した時には既に移っていた場合 |

⚠️ **利用者の取り消しとは別扱い。** あちらは「このページではもう動かない」（`scheduled = true`）だが、
移動先が変わっただけなら**次の終了ではまた動けるようにする**（`scheduled = false` で再武装）。

### 2. こちらが先に決着するとレイド先を奪う

配信終了 → こちらが最大15秒後に検知 → 10秒カウントダウン、の間にレイドが挟まる。
先に決着すると**配信者が決めた移動先が無視される。**

「目の前で終わった」時だけ `kickRaidGraceMs`（15秒）の猶予を置いて先を譲るようにした。
レイドが起きれば、その後の周期で「別のチャンネルが配信中」に変わるので、こちらは黙る。

⚠️ **飛んできた先が最初から配信なしの時は待たない。** レイドが飛んでくる余地が無いので、
待つと終わったチャンネルを延々と見せることになる。
⚠️ 待つのは**時間であって回数ではない**。`offlineSince` を立てた回で必ず return する書き方だと、
猶予 0 でも1周期ぶん待つ（定数の意味と食い違う）。

### 3. モーダルが重なる

こちらは `z-index: 10001`。Kick のレイドモーダルを覆う可能性がある。
2 の猶予により、こちらのモーダルが出るのはレイドが決着した後になるので、実用上は重ならない。
**残るとしたらレイドのカウントダウンが15秒を超える場合**なので、実機で確認する。

### 検査で自分が踏んだこと

🔴 **検査スクリプトが例外で落ちていたのに「NG 0」と報告した。**
落ちるとそこで出力が止まるので `grep -c 'NG '` は 0 になる。8項目が一度も走っていなかった
（`runObserver` を `try` の外から参照していた）。
**検査の結果は「NG件数」ではなく終了コードで見ること。**

---

## ✅ BW. Kick のモーダルがサイドバーの下へ潜り込む（2026-08-07）

> 🔴 **この後、同じ根っこで小窓（番組視聴中のミニプレイヤー）が隠れていることが分かった。**
> クラス名ごとに CSS を足す方式はここで打ち止めにして、**項目BY で実測して押す方式**を入れた。
> ここの CSS 2本はそのまま残してある（競合しない）。

### 原因

**`position: fixed` はビューポート基準**なので、body を `margin-left` で寄せても動かない。
`w-xvw` の読み替えは**幅**のルールで、固定配置の**位置**には効かない。

⚠️ doc/09 項目BL-2 に「Kick のレイアウト要素は fixed ではなく static / relative
（fixed は不可視の計測用 iframe だけ）」と書いてあるが、**あれはチャンネルページの実測で
モーダルを見ていない。** 断定が狭すぎた。

### 実測した形（Radix 系。`z-index: 601`）

```
暗幕  class="z-dialog fixed inset-0 bg-black/75 …"
      left=0 width=1920（画面いっぱい）

本体  class="… z-dialog fixed … w-xvw … lg:left-[50%] lg:translate-x-[-50%] lg:max-w-lg …"
      left=349 width=1223   ※画面幅1920・サイドバー幅673（reserved=697）
```

**本体は幅が既に正しかった。** class に `w-xvw` があるので、既存の読み替えが
`calc(100vw - reserved)` = 1223 にしている。狂っていたのは**中央寄せだけ**。

```
lg:left-[50%] → 960 、 translate-x-[-50%] → 960 - 1223/2 = 348.5 ≒ 実測349
可視領域は [697, 1920] なので中心は 1308。差の 348 = reserved/2 がそのまま左のはみ出し量
```

### 直し方

```css
/* 暗幕。right:0 はそのままなので、これだけで可視領域と同じ箱になる */
html.nns-kick-active [class~="fixed"][class~="inset-0"] {
    left: var(--nns-kick-reserved) !important;
}
/* 中央寄せの本体。translate-x-[-50%] はそのまま効く */
html.nns-kick-active [class~="fixed"][class*="left-[50%]"] {
    left: calc(50% + var(--nns-kick-reserved) / 2) !important;
}
```

⚠️ `fixed` は token 一致（`~=`）、`left-[50%]` は `lg:` 接頭辞が付くので部分一致（`*=`）。
⚠️ Kick 固有名ではなく**汎用のユーティリティ名**で当てる（`w-xvw` の読み替えと同じ方針）。

### 別案（採らなかった）

こちらの `z-index` は 2147483000、Kick のダイアログは 601。**下げればモーダルが上に来る**ので
1行で済むが、Kick の他の要素が 600台に居るとサイドバーが覆われる。位置を直すほうが安全。

### 下調べで踏んだこと

最初は「画面幅いっぱいの固定要素」だけを拾っており、**暗幕しか取れなかった**。
隠れて困っているのは本体なのに、その位置が分からず1往復むだにした。
→ 「**サイドバーの下へ潜り込んでいる固定要素**」も拾うようにして解決。
**探すものは「大きいもの」ではなく「困っている条件に当てはまるもの」で書くこと。**

---

## ✅ BX. Kick の番組が終わってもカードが残るのは、Kick 側の仕様（2026-08-07・調査のみ）

**こちらの不具合ではなかった。** 利用者の実測:

> 終了した番組は即座に終わらず、映像は止まるが**しばらくコメントが打てる状態が続く**。
> この間 API はまだ終了扱いしていない。1分ほど後にコメントも止まり、終了画面になる。
> **この状態で更新すると、カードはすぐ消えた。**

診断（`[Kick一覧の鮮度]`）でも、一覧14件すべてを `/api/v2/channels/<slug>` と突き合わせて
**食い違い0件**。一覧APIは正確で、遅れているのは **Kick が「終了」と決めるタイミング**そのもの。

つまり **notifybox に当たる速い一覧は Kick にも在る**（`/api/v1/user/livestreams`）。
「一覧に居ても本人に聞いて確かめる」形を足す必要は**無い**。

### 自動移動への影響

終了検知（`livestream: null`）も同じ信号なので、**Kick では映像が止まってから約1分遅れて**動く。
これは仕様として受け入れる。速くするには Kick の realtime 層（WebSocket）に乗るしかなく、
「DOM に依存しない」と同じ理由で採らない。

⚠️ **レイドはこの1分の間に起きる。** だから `kickRaidGraceMs` の猶予（項目BV）が効く。

---

## ✅ BY. 固定要素のはみ出しを「その都度 CSS」から「実測して押す」へ（2026-08-07）

### きっかけ

利用者の指摘。**番組視聴中にフォローページを開くと出る小窓**（映像が小さくなって
番組が途切れずに見られるもの）が、サイドバーの下に隠れて見えない。音声だけ聞こえる。
サイドバーを閉じると出てくる。

項目BW と**同じ根っこ**。`position: fixed` はビューポート基準なので、
`body` を寄せても届かない。BW ではクラス名ごとに CSS を1本ずつ足したが、
**新しい固定要素が出るたびに増える。** 利用者からも「その都度対応するしかないのか」と質問があった。

### 採らなかった方法: 包含ブロックを作る

`body` に `transform` か `contain` を1行入れると、子孫の `position: fixed` が
ビューポートではなく `body` を基準にするようになる。**1行で全部直る。**

🔴 **採れない。固定要素がページと一緒にスクロールするようになるため。**
包含ブロックが `body`（＝文書の高さぶんある箱）になるので、`inset-0` の要素は
「ビューポートに貼り付く」のをやめて「body の上端に貼り付く」。
スクロールした先でモーダルを開くと、画面の**外**に描かれる。
フォローページは縦に長いので必ず踏む。

⚠️ 項目BL-2 に「`transform` を掛けたのに子孫が x=0 に居た」という 2026-08-04 の
計測が残っているが、**それが正しかったかどうかは関係ない。** 仮に動いていても上の理由で不採用。
（あの時点で見えていた fixed は不可視の計測用 iframe だけで、モーダルを見ていない。）

### 採った方法: 実測して `margin-left` で押す

`services/fixedOverlayNudge.js`。500ms の突き合わせ（`startReconciler`）に相乗りして、
**確保した帯に食い込んでいる固定要素を測り、足りないぶんだけ右へ押す。**
クラス名を知らなくてよいので、小窓の正体が分からないまま直せる。今後出るものも自動で拾う。

🔴 **`left` ではなく `margin-left` を使うのが要。** どの寄せ方でも「右へ N ずらす」になる。

| 相手の寄せ方 | `margin-left: N` の効果 |
|---|---|
| `left:0; right:0`（引き伸ばし） | 幅が N 縮んで左端が N。望みどおり |
| `left:0; width:固定` | そのまま N 右へ |
| `left:auto; right:0`（右寄せ） | auto の left が吸収して**変化なし**（触る必要が無い） |
| `left:50%; translate-x:-50%` | N 右へ（幅が可視領域ぶんなら結果的に中央） |

**既存の CSS 2本（BW）とは競合しない。** あちらで直っているモーダルは帯に食い込まないので、
そもそも対象にならない。片方を消す必要は無い。

### 触ってはいけない相手（これを外すと壊す）

| | なぜ |
|---|---|
| **動いている最中のもの**（前の周期から左端が変わった） | 掴んで移動中の小窓・位置を計算し直しているポップオーバー。押すとカーソルから飛ぶ／押し合いになる |
| **ボタンを押している間**（`pointerActive`） | 同上。掴んでいる可能性がある間は測らない |
| 左端が -8px より左 | 画面外で待機している引き出し。押すと**引きずり出してしまう** |
| 全画面表示中 | 全画面の要素は最前面レイヤーでビューポート基準が正しい。押すと画面が右にずれて欠ける |
| 幅60px・高さ24px 未満 | 計測用の不可視要素・ヘアライン |
| サイドバー自身とその中身 | 言うまでもなく |
| 自分で押していない相手の `margin-left` | Kick が当てた値を奪わない |

### 収集の仕方（2通り。片方では足りない）

1. **`body` 直下2階層** — これが主。React（Next.js）の portal はここへ差し込む
2. **帯のあたりの当たり判定**（`elementsFromPoint`）— 深い場所に差し込まれた時の保険

🔴 **`elementFromPoint`（単数）では駄目。** 帯の上にはサイドバー自身が乗っているので、
単数版はサイドバーしか返さない。**隠れている当人が取れない。** 複数版なら下敷きまで届く。

🔴 **列の間隔は拾う下限の幅（60px）より狭くすること。** 端2本だけだと、
左に 16px の余白を置いた小窓（`left:16`）を `x=4` が外す。
🔴 **帯の右外（`reserved + 4`）にも1本置くこと。** 押し終えた要素は左端が `reserved` に来るので、
帯の中だけ見ていると次の周期で見失って押し戻し、**500ms ごとに往復する。**

### 剥がされた時に二重に押さない

React の再描画で指定が消えることがある。押した量は属性 `data-nns-nudge` にも書いてあるので、
**属性の値と実際に効いている値が食い違ったら「剥がされた」とみなして 0 から測り直す。**
🔴 **剥がし方は「空にする」だけではない。** `margin-left: 0px` で上書きされる形もある。
空文字だけを見ていると、`natural` を負に見積もって「画面外に退避している」と誤判定し、
**押し直さないまま隠れ続ける。**

### 呼ぶ場所

- 500ms の突き合わせ（`startReconciler`）
- 開閉のたび（`setOpen`）。次の周期を待たせると一拍置いて動いて見える
- 🔴 **`applyHostStyles` の中では呼ばない。** 境界線のドラッグ中に pointermove のたびに走る
- 連携を切る時（`teardown`）に `clearAllNudges()`。**`applyShift` だけでは戻らない**
- 裏タブ（`document.hidden`）では測らない。⚠️ **戻しはしない**（戻すと表に返った瞬間に潜り込んで見える）

### 残っている限界

⚠️ **`pointer-events: none` の固定要素は当たり判定で拾えない。** body 直下なら①で拾える。
⚠️ **幅60px 未満の固定要素は対象外。** 小さなバッジ類が隠れたら個別に CSS を足す。
⚠️ 動きが止まってから押すので、**掴んで裏へ置いた小窓は離してから出てくる**（体感は即時。下の BY-2）。
⚠️ **入れ子の固定要素で親が包含ブロックを作っている場合**、同じ周期で親子とも押すと子が二重に動く。
毎周期その場で測り直すので**次の周期で戻る**（1周期だけ跳ねる）。見分ける処理は割に合わないので入れていない。

### 検証

`verify:loop` の項目BY（31件）。**偽 DOM は「その点を覆っている要素だけ返す」幾何モデルにしてある。**
🔴 **全部返す作りにすると、採取点の置き方を一切検証できない**（実際、最初にそれで作って
「下の角の小窓に届かない」という本物のバグを見逃しかけた）。

変異検査を11通り実施し、10通りで落ちることを確認済み。
⚠️ **所有の判定は守りが2枚あって冗長。**「呼び出し側の絞り込み」と「印の有無」の
**片方だけを潰しても検証は通る**（両方潰して初めて落ちる）。どちらかを外す時は手で確かめること。

---

## ✅ BY-2. 小窓は掴んで移動できる。裏へ置かれると二度と出てこなかった（2026-08-07）

### 症状

BY で小窓は正しく押し出せるようになった。**が、この小窓は掴んで動かせる。**
掴んでサイドバーの裏へ運ぶと、そのまま隠れて出てこない。
🔴 **裏に居る間は掴むこともできないので、利用者が自力で戻す手段が無い＝行き止まり。**

### 原因

BY の `isNudgeCandidate` に **「インラインの `transform` / `left` を持つものは触らない」** を入れていた。
掴んだ瞬間に Kick がインラインの座標を書くので、**その時点でこちらが管理を手放していた。**

あの除外の意図は「Floating UI・Radix のポップオーバーと喧嘩しない」だったが、
**その役目は「食い込んでいるかどうか」の実測が既に果たしていた。**
呼び出し元は可視領域に居るので、そこから計算されたポップオーバーは帯に食い込まない＝対象にならない。
食い込むのは向こうが可視領域の外へはみ出させた時だけで、**その時は押すのが正しい**
（少しずれても、隠れて操作できないよりよい）。

🔴 **「安全のために対象から外す」を書く時は、外した相手の復旧経路も奪っていないか見ること。**
ここでは「押さない」だけのつもりが「**二度と戻せない**」になっていた。

### 直し方

インラインの除外をやめ、代わりに**動いている間は触らない**で身を守る。

| | なぜ |
|---|---|
| 前の周期から左端が変わっていたら触らない | 掴んで移動中／他所が計算し直している最中。押すとカーソルから 360px 飛ぶ |
| ボタンを押している間は触らない | 同上。`pointerdown` / `pointerup` を document に capture で張る |
| **初めて見た相手は「止まっている」扱い** | そうしないと最初の1周期（最悪500ms）小窓が隠れたままになる |

🔴 **裏を返すと「初めて帯に入ってきた相手が移動中か」は判別できない。**
採取は帯の近くしか見ていないので、遠くから運ばれてきた相手には前回の位置が無い。
**掴んで運ぶ場合を守っているのは `pointerActive` のほう。移動中の判定だけに頼らないこと。**
（検証でこれに気付いた。テストの相手を採取点の外に置いていて、「触らない」ではなく
**「見ていない」で通っていた**。空振り検査を足して初めて見えた。）
| 離した瞬間にその場で押し直す | 次の周期を待たせると、裏へ置いた小窓が最悪 500ms 見えない |

⚠️ **ウィンドウ外で離すと `pointerup` が来ない。** `pointercancel` と `blur` でも拾う
（境界線のドラッグで同じ穴を踏んでいる。項目BO）。取りこぼすと `pointerActive` が立ちっぱなしになり、
**押す処理が丸ごと止まる。**

### 検証

`verify:loop` の項目BY／BY-2（合計42件）。変異検査は14通りで、**全部落ちることを確認済み。**
「掴んでいる間は押さない」と「動いている間は押さない」は**別々に潰しても落ちる**ようにしてある。

⚠️ **BY の「触らない相手だけなら1件も抱え込まない」は数字を 0 → 2 に直した。**
インライン座標の2つが押す側へ回ったため。0 のままだと BY-2 を入れた瞬間に落ちて、退行と読み違える。

---

## ✅ BZ. カードの列数が減らず、カードだけ痩せる（2026-08-08）

### 症状

利用者の指摘。kick.com のフォローページで**番組カードが通常より小さい。**
サイドバーぶん幅が狭くなったのに**列数が減らず**、1枚あたりが痩せていた。

### 原因

🔴 **これは3種類目の問題。** これまでの2つでは届かない。

| | 効く相手 |
|---|---|
| `w-xvw` の読み替え（項目BL） | **幅**を主張する要素 |
| 実測して押す（項目BY） | `position: fixed` の**位置** |
| **BZ** | **メディアクエリ**。ビューポート幅で効くので body を狭めても変わらない |

実測（/following・画面幅1920・サイドバー702・使える幅1218）:

```
器 <section> 幅1078 / 7列 × 140.28px（gap 16）
class="… lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-5 3xl:grid-cols-6
        group-data-[sidebar=false]/main:xl:grid-cols-5
        group-data-[sidebar=false]/main:2xl:grid-cols-6
        group-data-[sidebar=false]/main:3xl:grid-cols-7"   ← これが効いていた
```

拡張が無ければ器は 1780px。7列で 1枚 240px。今は器 1078px に**7列のまま**で 1枚 140px。

### 🔴 クラス名を自分で解釈してはいけない

最初「Tailwind 既定の折り返し点で読み直す」つもりだった。**実測で外れた。**

- Kick は **`3xl` という独自の折り返し点**を持っている（既定の表に無い）
- **`group-data-[sidebar=false]/main:`** という、こちらが解釈できない条件が付いている
- 既定表での予測は **5列**。実際は **7列**。当てていたら間違えていた

⚠️ さらに、予測ロジックを単体で回した時点で「1920 も 1560 も同じ6列」という結果が出ており、
**方式そのものが成立しないように見えていた。** 実測して初めて、
利用者のサイドバーが 702px と広く、使える幅が 1218px まで落ちていることが分かった。
**手元の計算だけで方式を捨てなくて正解だった。**

### 直し方（`services/gridColumnFix.js`）

**Kick の CSS そのものから読む。** `document.styleSheets` を辿り、
`grid-template-columns` を設定していて **`el.matches(セレクタ)` が真**の規則を集め、
それを囲む `@media (min-width: …)` を紐づける。

🔴 `el.matches()` に任せるので、**`group-data-[sidebar=false]/main:` も `3xl` も
ブラウザと Kick の定義がそのまま効く。** こちらの推測が一切入らない。

```
集めた表 → 画面幅1920 で引く → 7列   ← 実際と一致するか答え合わせ
          → 使える幅1218 で引く → 4列 ← これを当てる（1枚 258px。拡張なしの 241px に近い）
```

🔴 **答え合わせに落ちたら何もしない。** 予測と実際が食い違う＝この要素の決まり方を
理解できていない。触らずに放置するほうが安全。

### 踏んだ穴

| | |
|---|---|
| 当て直す前に**自分の指定を外す** | 外さないと「自分が当てた4列」を Kick 本来の値と思い込み、答え合わせに落ちて手放す |
| Kick と同じ答えなら**指定ごと外す** | 同じ値を当て続けると列数を固定し、向こうの CSS が変わっても追従しない |
| 別オリジンの CSS は `cssRules` が例外 | `try` で飛ばす。読める分だけ使い、触らない側へ倒れる |
| `repeat(N, …)` 以外は読まない | px の並びを列数に読み替えると意味が変わる。`auto-fill` は本来こちらの出番が無い |
| **毎周期は走らせない** | CSS 規則の走査が入る。`画面幅｜使える幅` が変わった時だけ |

### 検証

`verify:loop` の項目CA（29件）。**実機ログの数字をそのまま期待値にしてある**
（1920 / 702 / 1218 / 7列 / 1078px / gap16）。変異検査は14通りで全部落ちることを確認済み。

🔴 **検証で3つ、検査自体の欠陥が出た。**
1. 偽 DOM が `getComputedStyle` で `repeat(…)` を返していた。**本物は px の並び**（実機ログどおり）。
   列を数える処理が 3 と読み、当てる判断まで届いていなかった。
2. 「他人の指定を奪わない」を**当てる道**で試していた。どちらにせよ上書きするので
   差が出ない。**当てない判断をした時**で試して初めて意味を持つ。
3. 変異検査が「NG の数」だけを見ており、**実装が例外で停止すると「空振り」と誤判定**していた。

### 分かっている限界

⚠️ Kick が JS で列数を決めるようになったら CSS からは読めない（実測の推定へ回る。BZ-2）。
⚠️ `repeat(auto-fill, …)` に変わったら触らない。その場合は本来こちらの出番が無い。

---

## ✅ BZ-2. CSS を読めなかった。実測から推定する道を足した（2026-08-08）

### 何が起きたか

BZ を実機で試したら **`触らない / 理由: CSS から列数の指定を読めない`**。
`document.styleSheets` から規則を1つも拾えていなかった。

🔴 **設計の前提が実機で崩れた。** 「Kick の CSS から読む」は正確さでは最善だが、
**読めるとは限らない**（別オリジン配信・`adoptedStyleSheets`・その他）。
正確な道だけを用意して、読めない場合を用意していなかった。

### 足したもの

**① 詰まった場所を測る。** 診断が「シート何枚・読めた何枚・規則何件・列指定何件・一致何件」を出す。
どこで 0 になるかで原因が決まる。

**② `adoptedStyleSheets` も見る。** `styleSheets` には入らないので、見ないと丸ごと落とす。

**③ CSS が読めなくても直せる道**（`planFromMeasurement`）。CSS を一切使わない。

```
今の器 1078px に Kick 自身が 7列を選んでいる（＝1枚 140px）
拡張が無ければ器は 1078 + 702 = 1780px → 同じ7列なら 1枚 240.6px が「本来の大きさ」
その大きさで今の器に何枚入るか → 4枚 → 4列（1枚 258px）
```

CSS から読めた場合と**同じ答え**になる。読めた時はそちらを優先し、
読めない／読み違えた時だけ推定へ回る。

🔴 **「変える必要が無い」だけは推定へ回さない。** あれは正しく読めた上での結論なので、
推定で上書きすると触らなくてよい相手を動かす。

🔴 **わずかな痩せでは列を落とさない**（本来の 90% 以上あれば触らない）。
割り算だけで決めると数px 狭いだけで1列減り、**カードが本来より大きくなる**
（そちらのほうが見た目が変わる）。サイドバー幅を動かした時に列数がガタつく原因にもなる。

⚠️ **器が「使える幅いっぱいに広がる」前提。** `max-width` で頭打ちだと `+ reserved` が過大になる。
実測では `maxWidth=none` だった。

### 死んだコードを1つ消した

`Math.min(observed, fit)` で「列を増やさない」を守ったつもりだったが、**到達しない。**
`器 + gap = 列数 ×(1枚 + gap)` がちょうど成り立つので、`reserved > 0` なら必ず `fit < observed`。
変異検査で「外しても落ちない」と出て気付いた。
🔴 **壊して落ちない検査を見つけたら、検査ではなく実装が余計な可能性も疑う。**
消した代わりに、960通りの総当たりで「列が増えない」性質そのものを検証している。

### 検証

`verify:loop` の項目CA／CA-2（41件）。変異検査は19通りで全部落ちることを確認済み。

---

## ✅ BZ-3. 別のページから来ると列数が直らない（2026-08-08）

利用者の指摘。**フォローページを直接開けば直るのに、別のページから移動してくると小さいまま。**
サイドバーの幅を動かすと直る。

### 原因

走らせる条件を「画面幅｜使える幅 が変わった時」だけにしていた。
🔴 **Kick は SPA。** 別のページから来るとカードの器は React に作り直されて**別物**になるが、
幅は変わらないので走らない。「幅を動かすと直る」がそのまま証拠になっていた。

### 直し方

見張るものを3つにした: 画面幅・使える幅・**今のページ（`location.pathname`）と器そのもの**。
器は `querySelector`（最初の1件で止まる）で取って、**同じ要素かどうかを見る。**
`querySelectorAll` で数えるのは重いうえ、件数が同じだと入れ替わりを見逃す。

⚠️ サイドバーを差し込み直した時（`startReconciler` の SPA 対策）にも覚え書きを両方捨てる。

🔴 **「幅が変わった時だけ走らせる」は、SPA では足りない。** 同じ形の間引きを書く時は
**「対象そのものが入れ替わる経路」があるかを必ず考えること。**

---

## ✅ CB. 部分一致のセレクタが関係ないクラスまで巻き込んでいた（2026-08-08）

### 症状

利用者の指摘＋スクリーンショット。サイドバーを広げて Kick がモバイル用スタイルに切り替わると、
**映像が右へはみ出し、番組情報欄が左で切れ、「メッセージを送」の入力欄が1文字ずつ縦に折り返す**
ほど潰れていた。

🔴 **切り分け済み。** 拡張を切って窓を同じ幅まで狭めると**崩れない。** つまり Kick 側ではない。

### 原因

ビューポート単位の読み替え（項目BL）を**部分一致**で書いていた。

```css
[class*="w-screen"]   ←  "max-w-screen-lg" も "w-screen" を含む
```

`max-w-screen-lg` は Tailwind の**固定値**（最大1024px）。ビューポート基準ではないので、
そもそも読み替えの対象ではない。そこへ `width: calc(100vw - 帯) !important` を当てると
**全幅まで膨らみ、隣の要素が押し潰される。** 入力欄が1文字幅になっていたのはその結果。

### 直し方

```css
[class~="w-screen"]   /* 単語そのもの。max-w-screen-lg は別の単語なので当たらない */
[class*=":w-screen"]  /* 変種の接頭辞つき（lg:w-screen / 3xl:w-xvw） */
```

⚠️ 後者が `max-w-screen-lg` を拾わないのは **`:` の直後が `m` だから。**
🔴 **`:max-w-screen` を足すと `lg:max-w-screen-md` を拾って元の木阿弥。**

あわせて、下限・上限は**その性質だけ**当てるよう3つの規則に分けた
（`min-w-*` に `width` まで固定すると、縮んでよい要素が縮めなくなる）。

### 一般則

🔴 **ユーティリティ名を CSS で狙う時、`*=` は原則使わない。**
Tailwind のクラス名は**接頭辞と接尾辞で意味が変わる**（`w-screen` / `max-w-screen-lg`）ので、
部分一致は必ず別物を巻き込む。`~=`（単語一致）＋ `*=":名前"`（変種の接頭辞つき）の2本で書く。

### 検証

`verify:loop` の項目CB（24件）。**CSS ファイルから実物のセレクタを取り出し、
`[class~=]` / `[class*=]` をブラウザと同じ意味で評価して**当たり外れを見る
（期待するセレクタを検証側に書き写すと、実装と一緒に書き換えて意味が無くなる）。
変異検査は7通りで全部落ちることを確認済み。

### この回に踏んだ、検査側の失敗3つ

1. **CSS のコメントまで走査していた。** ここには「こう書いてはいけない」の例が書いてあるので、
   剥がさずに見ると自分の説明文を実物と読み違えて必ず落ちる。**通算3回目。**
2. **変異がコメント側に当たっていた。** `String.replace` は1件目だけを置換する。
   `[class~="w-screen"]` を狙ったつもりが**説明コメントの方**を書き換え、実装は無傷のまま
   「1件も落ちない＝空振り」に見えていた。**セレクタの行ごと狙うこと。**
3. 🔴 **変異検査がタイムアウトで停止し、復元が走らなかった。**
   次に動かした検査が**壊れた状態を「元」として読み込み、そのまま保存**。
   `[class~="w-xvw"]` が `[class~="nope-xvw"]` のまま残っていた。
   → 変異検査は**開始前に手つかずの版を退避し、復元後に突き合わせる**ようにした。
   加えて、変異で使う書き換えパターンを全ファイルから探す掃除役を用意した。

---

## ⛔ CC. サイドバーを広げると Kick 側のレイアウトが崩れる（2026-08-08・直さない）

### 症状

利用者の指摘＋スクリーンショット。サイドバーを広げると、視聴ページで
**コメント入力欄が1文字ずつ縦に折り返し、映像の下に大きな空白ができる。**
左ナビも 56px まで縮んだまま文字を出している。

### 🔴 こちらの CSS ではない（A/B で確定）

診断で `nns-kick-active` を一瞬だけ外して同じ要素を測り直した。

```
潰れ: こちらのCSS入り 4件 → 切ると 4件
```

**読み替えを止めても潰れは変わらない。** 項目CB（部分一致の誤爆）を疑って半分外したが、
それとは別だった。A/B を入れて初めて分かった。

### 原因

**Kick はレイアウトを「ウィンドウ幅」で決めていて、こちらが空けた幅を見ていない。**

| | 窓を 1200px に狭めた時 | サイドバーで使える幅が 1200px の時 |
|---|---|---|
| Kick が見る幅 | 1200 | **1920** |
| Kick が選ぶ形 | `lg` 用（収まる） | **`3xl` 用**（収まらない） |

`3xl` 用の作りを 1200px に押し込むので、flex が縮めて潰れる。実測:

```
親4 幅758（中身866）/ きょうだいの幅: 100, 758
  → 758 の要素が場所を全部取り、入力欄が 100 まで潰されて
    「メッセージを送信する」が1文字ずつ縦に並ぶ
```

**利用者が「拡張を切って窓を同じ幅まで狭めても崩れない」と切り分けてくれたのが決め手。**
窓を狭めれば Kick は収まる形を選ぶ。こちらが幅を奪っても選び直してくれない。

### 項目BZ と同じ根っこ。ただし今回は直せない

| | 直せたか |
|---|---|
| BZ（カードの列数） | ✅ **列数という1つの数**なので、CSS から読んで計算し直せた |
| CC（ページ全体の作り） | ⛔ 1つの数ではない。作り直す対象が無い |

🔴 **メディアクエリの評価幅を content script から変える手段は無い。**
iframe に入れる以外に方法が無く、それは論外。

### 直さない（利用者判断・2026-08-08）

起きるのは**サイドバーがウィンドウのかなりの割合を占めた時だけ**
（実測は 717px = 37% と 1098px = 57%）。

⚠️ 上限を設ける案も出したが、**使える幅 1203px（サイドバー 717px）でも既に崩れていた。**
完全に防ぐには上限を画面の2割程度まで厳しくする必要があり、実用性を損なう。

⚠️ 「狭くなったら知らせる」案もあるが、直らないものを知らせても操作が増えるだけ。

**次に誰かがこれを見つけても、原因はここに書いてある。作り直そうとしないこと。**

### 撤去した診断

役目が済んだので消した（この節が記録）:
- `probeKickGrid` … カードの列数の決まり方（BZ で実装に落ちた）
- `probeKickSqueeze` … 潰れの A/B（原因判明・直さない方針）

🔴 **A/B は効いた。** 「こちらの CSS を一瞬だけ外して測り直す」は、
**外部サイトを触る変更で「こちらが原因か」を1回で決める型として残す価値がある。**
推測で半日溶かす代わりに、1回の実機ログで確定した。

---

## ✅ CD. 放送直後の Kick カードがローディング画像のまま（2026-08-08）

### 症状

利用者の指摘。Kick の番組が始まってカードが追加された時、サムネがまだ無いと
**ローディング画像**が出る。ニコ生では配信者アイコンが繋ぎに出るので、Kick でも同じにしたい。

**仕様ではなかった。** 「サムネが無い間は配信者アイコンを出す」は元からの設計
（`makeProgramElement` にそう書いてある）。効いていなかった。

### 原因は2つ。どちらも「片方だけ欠けている」型

**① 繋ぎ画像の決まりが `makeProgramElement` にしか無かった。**

```js
// makeProgramElement（生成時）
if (!thumbnail_url) thumbnail_url = icon_url || loadingImageURL   // アイコンを繋ぎに使う

// applyProgramInfoToCard（後から埋める側）
if (img && f.thumbnail_url && …) img.setAttribute('data-src', f.thumbnail_url)
//        ^^^^^^^^^^^^^^^^ 生の thumbnailUrl。アイコンを知らない
```

放送直後の Kick は**サムネもアイコンも空**で来ることがある。その時に作られたカードは
`data-src` が loading.gif で固定される。次の周期でアイコンが埋まっても
`f.thumbnail_url` は空のままなので**ここが素通りし、ローディングが残り続けた。**

🔴 **同じ決まりが2箇所にあって片方だけ欠けている**、doc/09 で何度も出ている型。
`wantDataSrc = f.thumbnail_url || f.icon_url` に揃え、
**今ローディングを出しているならその場で繋ぎ画像へ替える**ようにした。

⚠️ `syncStaticThumb`（もう1つの表示経路）は**ライブサムネを持たない番組にしか回らない**。
Kick は `providerType:'user'`＝ライブサムネあり扱いなので、あちらでは救われない。

⚠️ **表示中の絵がローディングでない時は触らないこと。** 無条件に替えると、
出ているサムネをアイコンで踏み潰す。

**② アイコン取得の失敗を永久に覚えていた。**

```js
} catch (e) {
    iconCache.set(slug, '')   // ← 「取れなかった」を空文字で記録
}
…
if (iconCache.has(slug)) { … continue }   // ← has() が真なので二度と取りに行かない
```

🔴 **通信が一瞬途切れただけで、その配信者のカードは永久にローディング画像**になる。
`chrome.storage` に保存までしていたので、ブラウザを再起動しても直らない。

失敗は `iconRetryAfter`（メモリのみ・`kickIconRetryMs`＝10分）に期限つきで覚え、
**時間が経てばまた試す**ようにした。キャッシュに入れるのは**取れたものだけ**。
⚠️ 空で返ってきた時も覚えない。アイコン未設定の配信者と区別が付かないうえ、
覚えると「後で設定した」に一生追従できない。
⚠️ 以前の版が保存した空文字は、読み込み時に捨てて取り直させる（移行）。

### 検証

`verify:loop` の項目CD（12件）。モックDOMで**実際にカードを組み立てて** src / data-src を見る。
変異検査は9通りで全部落ちることを確認済み。

⚠️ **1つ空振りした。**「置き換えた絵をライブ扱いにしない」の検査は、
生成時から既に `thumbLive=0` なので実装から外しても落ちなかった。
**その行が守る状態（`thumbLive=1` のまま繋ぎ画像に落ちる）をテスト側で作って**初めて意味を持つ。

---

## ✅ CD-2. それでも直っていなかった（2026-08-10・利用者報告）

「放送開始直後の Kick カードが、配信者アイコンではなくローディングのまま」。**CD と同じ症状**。

### CD は起きていない方の場合を直していた

CD が想定したのは「**サムネURLが空で来る**」場合。実際に起きていたのは
「**URLは来るが、その画像がまだ生成されていない**」場合だった。検証も前者しか書いていない。

```js
// deriveCardFields: Kick は providerType:'user' なので、ライブサムネも静止サムネも同じURL
live_thumbnail_url = thumbnail_url        // どちらも data.thumbnailUrl

// makeProgramElement: URL があるので繋ぎ画像の分岐に入らない
if (!thumbnail_url) thumbnail_url = icon_url || loadingImageURL   // ← 通らない
img.src = THUMB ; img.setAttribute('data-src', THUMB)             // 同じURLが両方に入る

// handleThumbnailError: 画像が無くて error → data-src は同じURL
if (dataSrc && this.src !== dataSrc) { … }   // ← 偽。アイコンを飛び越して
else this.src = loading.gif                  //    最後の砦へ直行していた
```

🔴 **繋ぎ先が自分自身を指していた。** `data-src`（戻り先の静止サムネ）と繋ぎ画像を
兼用していたのが原因。Kick とニコ生の user 番組では**両者が同じURLになる**。

🔴 **「決まりは2箇所」ではなく3箇所だった**（CD で書いた教訓の更新）。
生成時・後埋めに加えて、**失敗した時**にも同じ決まりが要る。

### 直した3点

1. **繋ぎ画像を `data-fallback-src` に分けて持つ**（`setFallbackThumbSrc` が唯一の書き手）。
2. **`handleThumbnailError` を3段の落ち方にする**: `data-src` → `data-fallback-src` → loading.gif。
3. **ローディングからの復帰を `data-src` の更新条件から外す**。

⚠️ **2 は必ず「下りだけ」に進めること。** 今どこまで落ちているかを `chain.indexOf(this.src)`
で見て、それより後ろだけを試す。上へ戻れるようにすると、アイコンも読めない時に
**サムネURL↔アイコンで error が無限に往復する**（旧実装は2段しか無く、loading.gif が
ローカルで必ず読めるのでたまたま止まっていた）。

⚠️ **3 の替える先はアイコンが最優先。** ローディングが出ている＝そのサムネURLは
読めなかったということなので、同じURLをここで入れ直してもまた失敗する（読み直しは
バックオフを持っているサムネ更新ループの仕事）。

⚠️ **アイコンが無い番組をここで拾わなくてよい。** 「アイコンを持たない配信者のカードから
即時復帰を奪ったのでは」と疑って `wantDataSrc` も見る形に一度書き換えたが、
**空振り検査で外れと分かった**（狭めても1件も落ちない）。**すぐ下の直接表示
（`thumbLive === '0'`）が同じ呼び出しの中で拾っている。** 元に戻した。
🔴 **「後退させたかも」も読みでしかない。壊して確かめる。**
2箇所で見るようにしていたら、**同じ仕事の書き手が2人**になっていた
（しかもこちらはバックオフを見ないので、失敗中のURLを叩き直す側に回る）。

⚠️ 旧実装がこの入れ替えを `data-src` 更新の `if` の中に置いていたのが 3 の原因。
**Kick のサムネURLは放送開始から最後まで変わらない**ので、`data-src` は初回から同じ値のまま＝
一度ローディングに落ちたカードが二度と戻らなかった。

### 検証

`verify:loop` の項目CD-2（10件）。**モックDOMで img の `error` を実際に鳴らして**通す。

🔴 **`handleThumbnailError` は今まで一度も検証を通っていなかった。**
偽DOMの `fire()` がリスナを `fn(ev)` で呼んでおり、`this` が undefined になるため
**鳴らした瞬間に実装と無関係に落ちる**状態だった。本物と同じ `fn.call(el, ev)` に直した。

空振り検査は3通り。**壊して実際に鳴ることを確認済み**（括弧内は落ちた件数）。

| 壊し方 | 鳴った項目 |
|---|---|
| ① 落とし方から `data-fallback-src` を外す（旧実装） | 「アイコンへ落ちる」（1件） |
| ② 復帰を「`data-src` が変わった時だけ」に戻す（旧実装） | 「data-src が変わらなくても戻す」（1件） |
| ③ `chain.indexOf(this.src)` を `-1` 固定にする | 「上へ戻らない」＋「最後の砦」（2件・同じ欠陥） |
| ④ 直接表示（`thumbLive === '0'` の再代入）を止める | 「アイコンが無くても届いたサムネで復帰」（＋巻き添え） |

⚠️ **②は最初 `&& false` で丸ごと殺して3件落ちた。** CD 側の項目まで巻き添えになり
切り分けにならない。**旧実装の条件をそのまま復元する**形に書き直して1件に絞れた。
🔴 **「落ちたか」ではなく「狙った所だけ落ちたか」を見ること。**

---

## ✅ CE. サイドバーの置き方を選べるようにした（2026-08-08・利用者要望）

「ページを右へ押しやらず、上に重ねる」選択肢がほしい、という要望。
設定「**サイドバーの置き方**」に **寄せる / 重ねる** を追加。既定は**寄せる**（今までの動き）。

### 2ページで仕組みがまるで違う

| | 寄せる（既定） | 重ねる |
|---|---|---|
| ニコ生 | body の flex に並べ、`#root` の幅を縮める | `#sidebar` と `#sidebar_line` を `fixed` にし、**`#root` の幅を触らない** |
| kick.com | body に `margin-left` と `width` を当てる | **寄せ幅を 0 にするだけ** |

🔴 **判定と印は1箇所にまとめた**（`ui/placement.js`）。仕組みが違っても
「重ねるかどうか」の判断を2箇所に書かない（doc/09 項目BN で何度も出ている写し漏れの型）。
印は `<html>` の `nns-overlay`。⚠️ **body ではない**。kick.com のサイドバーは
`<html>` 直下に居るので、body に付けた印は届かない。

⚠️ **知らない値は「寄せる」に倒すこと。** 設定が壊れていた時に画面を覆い隠さないため。

### kick.com: 寄せ幅 0 だけで全部止まる

`reservedWidth()` が 0 を返すと、以下が**すべて自動的に降りる**（どれも 0 で何もしない作り）:
body の寄せ・ビューポート単位の読み替え・固定要素の押し出し（BY）・カードの列数の決め直し（BZ）。
🔴 **置き方ごとの分岐を増やさないこと。** 分岐を足すと、機能が増えるたびに両方へ書く羽目になる。

⚠️ **寄せ幅 0 の時は body の指定ごと外す。** `margin-left: 0px` と `width: calc(100vw - 0px)` を
書いても見た目は同じに見えるが、**body に元から付いていた幅の指定を上書きしてしまう。**

⚠️ **読み替えの規則も `:not(.nns-overlay)` で外す。** `calc(100vw - 0px)` は 100vw だが、
`!important` で当てると Kick 自身の `lg:w-full` などを上書きする（doc/09 項目CB と同じ害）。

### ニコ生: 中身とラインの両方を流れから外す

🔴 **片方だけ外すと、残ったほうが body の flex で場所を取り続ける**（＝重ねているのに寄っている）。

ラインの左位置は `--nns-sb-w`（中身の実測幅）で決める。幅は JS がインラインで入れているので
CSS からは見えない。`setRootWidth()` が毎回この変数を更新する
（幅が変わる経路＝開閉・ドラッグ・他ページからの同期・ウィンドウ変形はすべてここを通る）。
⚠️ **CSS 側で幅を計算し直さないこと**（2箇所で同じ計算をする、いつもの破れ方）。

⚠️ **ニコ生用の規則は `body >` で限定する。** kick.com のサイドバーにも `#sidebar` が居るため。
今は id 2つ分の詳細度で kick 側が勝っているが、**偶然に頼らない。**

⚠️ **切り替え時は `#root` の幅を空文字で消すこと。** 前に入れた値が残ると、
重ねるへ切り替えてもページが縮んだままになる。

### 検証

`verify:loop` の項目CE（32件）。変異検査は14通りで全部落ちることを確認済み。

### 既存の検証を2件、意図ベースへ直した

**書き方（字面）で縛っていたので、条件を足しただけで落ちた。**

| | 直した内容 |
|---|---|
| BO | `const want = isActive` という**字面**で見ていた → 「条件が `isOpen` を見ないこと」で見る |
| BU | セレクタの**先頭一致**で見ていた → 絞り込み（`:not(...)`）が増えても通るように |

🔴 **検証は「どう書いてあるか」ではなく「何を守りたいか」で書く。**

### 検証側で1つ空振り

「読み替えの規則はすべて重ねる時に効かない」を**カンマ区切りのまとまり**で見ていた。
4本のうち1本だけ元に戻しても、他の行に文字列が残っているので通ってしまう。
**セレクタは1本ずつ取り出して見ること。**

---

## ✅ CE-2. 重ねる時、ラインとボタンだけ遅れて付いてくる（2026-08-08）

利用者の指摘。ニコ生で「重ねる」にしてサイドバーの幅を変えると、
**中身は即座に動くのに、境目ラインと開閉ボタンだけ遅れて追ってくる。**

### 原因は2つ

**① 幅を書く場所と、変数を更新する場所が分かれていた。**

重ねる時、ラインは `left: var(--nns-sb-w)` で位置が決まる。ところが変数を更新していたのは
`setRootWidth()` の `requestAnimationFrame` の中だけ。**ドラッグ中の `onMouseMove` は
幅しか書いていなかった。** 変数は ResizeObserver 経由で1〜数フレーム遅れて追いつく。

→ `applySidebarWidth(px)` に集約し、**幅と変数を同じ場所で同期に書く。**
開閉・ドラッグ・すべてここを通る。⚠️ **rAF に入れないこと**（1フレーム遅れる）。

**② 開閉のアニメが中身にしか掛かっていなかった。**

`.sidebar_transition`（`all 0.5s`）は `#sidebar` にだけ付いており、ラインには無かった。
寄せる時はラインが flex の隣にいるので中身の幅変化にそのまま従うが、
**重ねる時はラインが `left` で独立に動く**ので、中身が 0.5秒かけて動く間にラインだけ先に飛ぶ。

→ ラインにも**同じクラス**を付ける（初期 HTML＋ドラッグ中の掛け外し）。
🔴 **別々に `transition` を書かないこと。** 片方の時間を変えた時に食い違う。

### これは3回目の「動かすものが2つに分かれてズレる」

| | |
|---|---|
| BO | kick で中身が `transform`・ラインが `left` → メインスレッドが詰まると分離 |
| CE-2 | ニコ生で中身が `width`・ラインが `left`（しかも変数の更新が別経路） |

🔴 **2つの要素が必ずくっついて見えるべきなら、次のどちらかにする。**
1. **動かす箱を1つに減らす**（kick はこちら。root 1枚を動かす）
2. **同じ場所・同じ指定で動かす**（今回はこちら。DOM を組み替えられないため）

**「同じ変数から2箇所を計算する」は、経路が違えば必ず時間軸でズレる。**

### 検証

`verify:loop` の項目CE-2（8件）。
🔴 **「幅を書く場所が1箇所だけか」を数えて縛っている**（`elems.sidebar.style.*width` の出現が3つ＝
1つの関数に収まっている）。散らばった瞬間に落ちる。
変異検査は CE と合わせて20通りで全部落ちることを確認済み。

---

## ✅ CF. 診断コードを全部撤去した（2026-08-08・利用者指示）

**拡張に診断コードは1つも残っていない。**

| 消したもの | 何を見ていたか |
|---|---|
| `src/utils/_flickerProbe.js`（ファイルごと） | チラつき・開閉のズレ・Kick の終了検知／一覧の鮮度／固定要素／列数／潰れ |
| `src/utils/diag.js`（ファイルごと） | 自動移動がどの関門で止まるか（項目BI） |
| `main.js` の `startThumbSrcWatch` | サムネの差し替え合戦。**一度も呼ばれていなかった** |

あわせて消えたもの: `structuralReason`（チラつき診断専用の変数・2ページぶん）、
`kickPage.js` の `fetchKickChannelState` の import（診断でしか使っていなかった）、
`cleanup(reason)` の引数（`invalidated` と `unload` の区別は診断のためだけにあった）。

### 撤去で踏んだこと

🔴 **`String.replace` は1件目しか置換しない。** 同じ形の呼び出しが2箇所あり、
1つだけ消えて残りに気付かなかった（`onNudge: probeNudged`）。**消した後に必ず全文検索する。**

🔴 **診断を包んでいた `if` の開き行だけが残って構文エラーになった。**
`if (reason !== invalidated) { …診断… }` の中身と閉じ括弧を消して、開き行を残していた。
**ブロックごと消すこと。**

⚠️ 診断のコメントだけが残るパターンも1件あった。**コメントも一緒に消す。**

### また入れる時に

効いた型は **doc/10（実機での検証）の「診断コードを入れる時の型」**に残してある。
特に **「こちらの CSS を一瞬だけ外して前後を測る」**（項目CC）は、外部サイトを触る変更で
「こちらが原因か」を1回で決められる。作り直す価値がある。

⚠️ 利用者の環境には localStorage の記録が残る
（`nicosidebar_probe_overlays` / `nicosidebar_diag_autonext`）。数KB で実害は無い。
消し方も doc/10 に書いてある。

🔴 **doc/11 は記録の置き場ではない。** あそこは「今ターミナルへ貼るコマンド」だけを置く
ホワイトボードで、毎回まるごと書き換える。**撤去手順や型を書き溜めないこと**（一度やって直した）。

---

## ✅ CG. Kick からログアウトしても何も分からない（2026-08-10・利用者からの質問が発端）

「Kick 連携をした状態で Kick からログアウトしたらどうなるか」を追ったところ、
**壊れはしないが、利用者には何も伝わらない**状態だった。

### ログアウト後に起きること

cookie（`session_token`）が消えるので、SW の取得は `no-session`、
cookie が残って失効している場合は 401 で `unauthorized` を返す。その後は:

| | |
|---|---|
| タブを開いたまま | **Kick のカードが固まる。**視聴者数も並び順も止まり、**終了した配信も残り続ける** |
| 開き直した後 | Kick のカードが1枚も出ない。カード0件だとタブも隠れるので**連携OFFと見分けが付かない** |
| サムネイル | 更新され続ける（画像の取得は認証不要のため） |
| 自動移動 | **動く。** 終了検知は公開APIで認証不要 |
| 案内 | **どこにも出ない** |

固まるのは意図した動作（取れなかった周期は前回結果を据え置く＝doc/09 項目BF-2 と同じ方針）。
問題は、それが**利用者から見て「ログインが切れている」と読めない**こと。

### `#api_error` に相乗りさせなかった理由

`#api_error` の中身は**ニコ生のログインリンク固定**で、出す条件は「ニコ生の2経路が
**両方**失敗した時」。ここに Kick を混ぜると2方向に壊れる。

- **混ぜる** → kick.com で Kick だけ切れた時に、**ニコ生のログインを勧める**
- **条件を「片方でも失敗」へ緩める** → ニコ生を使わない利用者の kick.com に
  **永久にニコ生のログイン誘導が出る**（`bothFailed` はこれを避けるための条件で、正しい）

そこで `#kick_notice` を別に立て、`#api_error` の直後（サイドバー上部）に置いた。
両方失敗した時は2つ並ぶので、Kick が原因であることが読める。

### 出す条件を絞る

判定は `isKickSessionLost()`（`services/kickSource.js`）**1箇所だけ**に書く。

🔴 **`no-permission` を含めないこと。** Kick 連携は optional permission で、
許可していないのが既定。含めると**連携していない全利用者に誤報**が出る。
🔴 **一時的な失敗（`network` / `http` / `rate-limited` / `parse`）を含めないこと。**
取得のたびに案内が点いたり消えたりする。
🔴 **`unavailable`（拡張が無効化された）も違う。** ログインし直しても直らない。

⚠️ **毎周期 true/false を渡し切ること。** `if (切れていたら) setKickNotice(true)` と
片方向にすると、**ログインし直しても案内が消えない**。検証で片方向を弾いている。

### 出し入れは hidden 属性で行う

🔴 **CSS の `#kick_notice` に `display` を書かないこと。** 書くと UA の `[hidden]` を
上書きして、**ログインしていても出っぱなし**になる。
`#api_error` がインライン style と `!important` を必要としているのは、そちらが逆の作りだから。
⚠️ 設定パネルを開いている間に隠す規則は**別に要る**（`#api_error` と同じ）。忘れると設定の上に浮く。

### 踏んだ罠

🔴 **HTML コメントの中でバックティックを使ってビルドを落とした。**
この HTML はテンプレートリテラルの中。**「api_error と混ぜるな」という注意書き自身**で
id をコード引用しようとして文字列がそこで終わった。同じ注意が既に3箇所に書いてある場所で踏んでいる。
**注意書き自体も文字列の一部**であることを忘れないこと。

### 残した判断

⚠️ **ニコ生のログインリンクは `target` 無し**（＝同じタブで移動する）。視聴ページで押すと
再生が止まるが、ヘッダーの「フォロー中の番組」も同じ作りなので**あえて揃えたまま**にしてある。
Kick 側の案内は別タブ（`target="_blank"`）。**揃えるかは利用者の判断待ち。**

### 検証

`verify:loop` の項目CG。判定表（どの `reason` で出す／出さない）・置き場所・
`hidden` の既定・CSS が `display` を書いていないこと・両ページが渡し切っていること・
モックDOMでの出し入れ。`api_error` と混ぜていないことも固定した。
写し漏れ検査（項目BN）にも `setKickNotice` を追加してある。

空振り検査7通り、**全部鳴った**（括弧内は落ちた件数）。

| 壊し方 | 鳴った項目 |
|---|---|
| no-permission を「ログイン切れ」に含める | 連携していない時は出さない（1） |
| 一時的な失敗も含める | network など（6・同じ欠陥） |
| markup の hidden を外す | 既定は隠れている（1） |
| CSS に display を書く | display を書かない（1） |
| 設定パネル用の規則を消す | 開いている間は隠す（1） |
| kick.com の呼び出しを消す | 写し漏れ検査（1） |
| 呼び出しを条件の下へぶら下げる | 条件の中で呼んでいない（1） |

⚠️ 最後の1つは、最初 `if (…) setKickNotice(true)` を正規表現で狙っていて**壊しても鳴らなかった**。
条件の中に関数呼び出しが入ると括弧が入れ子になり `[^)]*` では当たらない。
**行単位で「条件の下にぶら下がっていないか」を見る**形に変えて鳴るようになった。

---

## ✅ CH. メンテナンス中に「ログイン」と案内していた（2026-08-10・利用者からの質問が発端）

「ニコ生がメンテナンス中だったらどうなるか」を追って見つけた。**判定が存在しなかった。**

```js
notifybox    meta.status !== 200 / 例外       → false
フォローAPI  HTTPエラー / JSONでない / 例外   → null
bothFailed = !fetched && !notifyList   // ← 未ログインもメンテも通信断も全部これ
```

`#api_error` の中身は**ニコ生のログインリンク固定**だったので、
**メンテナンス中に「ログイン」を勧める**＝落ちている可能性が高いログインページへ誘導していた。

### 実測（2026-08-10・未ログインで叩いた）

| | |
|---|---|
| フォローAPI | **HTTP 401** ＋ `{"meta":{"statusCode":401,"errorCode":"UNAUTHORIZED"}}` |
| notifybox | **HTTP 404 の HTML**（JSON ですらない） |

🔴 **認証の判定に使えるのはフォローAPIの状態コードだけ。** notifybox は未ログインでも
404 の HTML を返すので、メンテナンスと区別が付かない。
⚠️ `meta.status` ではなく **`meta.statusCode`**（notifybox とキー名が違う）。ここは見ずに
HTTP の状態コードで判定している。

### 直した3点

1. **理由を返す。** `fetchFollowedProgramsViaPage` を `null` から
   `{ok:false, reason}` へ。判定は `classifyFollowFailure` **1箇所だけ**。
   🔴 **`fetchOnePage` で状態コードを捨てないこと**（`e.status` に載せる）。捨てると
   全部 `network` に落ちて、**常に「接続できません」**になる。
   ⚠️ 呼び出し側は包みを即座に開いて従来の `配列 or null` に戻す。`[]`（放送中0件）は
   真のままにしておかないと、0件の周期が「取得失敗」に化ける。
2. **案内を出し分ける。** `unauthorized` の時だけ「ログイン」、それ以外は
   「ニコ生に接続できません。メンテナンス中かもしれません。」。表示は `setNicoNotice` の1箇所。
   ⚠️ **どちらも出さない時は枠ごと隠すこと。** 中身だけ隠して枠を出すと空の余白が残る。
   ⚠️ 知らない値は「出さない」に倒す。
3. **Kick を巻き添えにしない。** `bothFailed` の無条件 return をやめた。

### 3 が危ないところ

**そのまま素通しにしてはいけない。** 描画は「新リストに無いカードを消す」ので、
ニコ生ぶんが空のまま描画すると**ニコ生のカードが全部消える**。

前回の取得結果（`this._nicoPrograms`）を据え置いて埋める。kick.com 側が
`lastNicoPrograms` でやっているのと同じ形で、**ページ間で考え方が揃った**。

🔴 **据え置いた値を storage へ書き戻さないこと。** 同じ値で上書きすると差分が 0 になり、
盛り上がりの推定が実際より低く出る（kick.com 側に同じ注意書きがある）。
`_seedNewProgramsToStorage` と `_nicoPrograms` の更新は**成功した周期だけ**。

⚠️ **据え置く元がまだ無いのに DOM にニコ生のカードがある**時だけ、従来どおり何も描かずに帰る。
復元できないのに描画すると消えてしまうため。通常の起動では取得が成功するまでカードが無いので
ここには来ないが、UpdateManager が作り直された場合に備えて残してある。

### 踏んだこと

🔴 **空振り検査を走らせたまま同じファイルを編集した。** あれは「壊す→検査→戻す」を
繰り返すので、**編集中のファイルを自分のスナップショットで上書きする**。
検査を止めた時に復元が走らず、`UpdateManager.js` に壊した1行が残った。
掃除して確認済み（残っていたのはその1行だけ）。
**変異検査を回している間はソースを触らないこと。** doc/09 CB で「復元漏れ」を踏んでいるが、
今回はその逆向き（復元が**自分の編集を消す**側）で、同じ根から出ている。

🔴 **写し漏れ検査が実装より先に古くなった。** 項目BN が `api_error` という語で
kick.com 側の配線を見ていたので、共有関数 `setNicoNotice` に寄せた瞬間に
**実装は正しいのに落ちた。** 語ではなく**共有関数の名前**で見るよう直した。

### 検証

`verify:loop` の項目CH。理由分けの表（401/403・5xx・その他HTTP・通信断・JSONでない）、
状態コードを捨てていないこと、出し分けが両ページに入っていること、
無条件 return に戻っていないこと、据え置きを storage へ書かないこと、
モックDOMでの3状態の出し分け。空振り検査6通り、**全部鳴った**。

🔴 **「無条件 return が無いこと」を昔の形の消失で見ないこと。** 最初そう書いていたが、
**別の書き方で足された無条件 return は素通り**する。**その区間に return がいくつ在ってよいか**
（許されるのは「据え置く元が無い時」と「世代が変わった時」の2つだけ）で見る形に変え、
実際にその壊し方で鳴ることを確かめた。

---

## ✅ CI. Kick のモーダルが全幅に伸びていた（2026-08-10・利用者報告・実機で修正確認）

「モーダルの幅がサイドバーを除く幅いっぱいに伸びる。元々は全幅ではないはず」。
利用者が見たのは **Kick のログイン認証コードのモーダル**。

### 原因: 幅の読み替えが「上限」まで奪っていた

```css
/* ① 幅そのもの（改修前） */
html.nns-kick-active:not(.nns-overlay) [class~="w-xvw"], … {
    width:     calc(100vw - var(--nns-kick-reserved)) !important;
    max-width: calc(100vw - var(--nns-kick-reserved)) !important;  /* ← これ */
}
```

Kick のモーダルは `w-xvw max-w-[…]`、つまり
**「モバイルは全幅・広い画面では上限つき」**という普通の書き方だった。
そこへ `max-width` を `!important` で上書きしたので、**上限が消えて可視領域いっぱいに伸びた。**

🔴 **読み替えの目的は「100vw を主張する要素を可視領域に収める」こと。`width` だけで足りる。**
相手の上限のほうが小さければ、そちらが勝つのが正しい。
🔴 ビューポート基準の上限（`max-w-xvw`）は別の規則③が持っている。**①の max-width は重複でもあった。**
⚠️ `min-width: 0` は残す。flex/grid の子は既定が `auto`（＝中身の最小幅）なので、
これが無いと計算した幅まで縮まない。

実測記録（項目BW）に「本体 width=1223 ← 幅は上の読み替えで既に可視領域ぶんになっている」と
書いてあるが、**あれは伸びていた状態を正しいと読み違えていた。**

### 検証

`verify:loop` の項目CI。`w-xvw max-w-[500px]` 等4通りで
**`width` は当たるが `max-width` は当たらない**ことを見る。
「上限を書く規則は1つだけ（①と③で二重に持たない）」も固定した。

### 🔴 検査が実装より脆かった（このセッションで3回目）

この1行を消しただけで、**実装は正しいのに検査が2件落ちた。**

| 落ちた検査 | 何を写していたか | 直し方 |
|---|---|---|
| BO 読み替えは JS が出した幅を引くだけ | 「`width` と `max-width` の**2つがある**」 | `100vw` を使う宣言を**全部**取り出し、1つ残らず同じ式か |
| CB 引くのは変数ただ1つ | `calc()` の出現数 `>= 4` | 空振り防止に要るのは「0件でない」だけ＝`>= 3` |

同じセッションで踏んだ他の2つ: 項目BN が `api_error` という**語**で配線を見ていた／
項目CH の「無条件 return が無いこと」を**昔の形の消失**で見ていた。

🔴 **共通点は「性質ではなく、今の書き方の形を写していた」こと。**
検査を書く時は「実装をこう変えたら、正しいのに落ちないか」を必ず自問する。

---

## ✅ CJ. ライブサムネが出ず配信者アイコンのまま（2026-08-10・利用者報告・再現済み）

「新しく始まって10分以上経つのにユーザーアイコンのまま。更新ボタンでも変わらず、
ページをリロードしたらライブサムネになった」。**縦型配信**の番組だった。

### 実測: 一覧APIは縦型のスクショを「包んで」返す

2026-08-10・公開の recent 版（フォローAPIと同一スキーマ）で user 67件:

| listingThumbnail の形 | 件数 | ライブ判定 |
|---|---|---|
| `thumbnail-352x198`（横） | 51 | 通る |
| 固定画像プロキシ | 15 | 通らない |
| **`thumbnail-360x640`（縦）** | 1 | **通らない** |

縦型の実物:
```
一覧 listingThumbnail = https://listing-thumbnail.live.nicovideo.jp/?url=https%3A%2F%2Fasset2...
                        ＝ プロキシに包まれたスクショ。**意図的に弾いている形**（項目AA）
詳細 liveScreenshotThumbnailUrls.middle = https://asset2.dlive.nicovideo.jp/.../thumbnail-360x640/screenshot.jpg
                        ＝ 補完できる
```

🔴 **縦型配信は必ず「詳細APIでの補完」に頼る。** ここが弱いと直撃する。

### 原因: 保存が丸ごと置き換えで、1回の失敗で巻き戻る

```js
// upsertProgramInfos（改修前）
byId.set(info.id, { ...info, _fetchedAt: now })   // 前のレコードは丸ごと消える
```

**本物の updateSidebar を回した再現**（`scripts/verify-sidebar-loop.mjs` の項目CJ）:

```
周期2  補完に成功         → 保存 thumbnailUrl = …/screenshot/1.jpg  ライブサムネ表示
周期3  詳細APIが一瞬落ちた → 保存 thumbnailUrl = （無し）   🔴 前回の成果が消えた
                          → data-src = アイコン            🔴 表示も戻される
```

一度こうなると、次に補完が成功するまでアイコンのまま。更新ボタンで直らなかったのは、
その回の補完も成功しなかったから。**リロードで直るのは、その回がたまたま成功したから。**

🔴 開始3分以内の追撃（`patchProgramThumbnail`）はわざわざ「サムネ欄だけをマージ」して
lost update を避けているのに、**リスト更新側がそれを毎回上書きしていた。**

### 直し方

`upsertProgramInfos` で**サムネのURLを空で上書きしない**。

⚠️ **ライブサムネは「同じURLで中身が変わる」**（項目AA）。URLを覚えておいても古い絵は残らない。
番組が終わればレコードごと消える。
⚠️ **据え置きが新しいURLを邪魔しないこと。** 「空の時だけ前回値」に限る。逆向きに壊すと
新しいURLが永久に入らなくなる（空振り検査②で確認）。
🔴 **渡された `info` 自身にも書き戻す（破壊的）。** 呼び出し元は upsert に渡した配列を
そのまま描画へ回すので、保存用のコピーにだけ書くと**保存は直るのに画面はアイコンのまま**になる。
momentum と viewerRate が同じ理由で破壊的に書いている。

### 検証

`verify:loop` の項目CJ（10件）。**本物の `updateSidebar` を4周期まわす**再現をそのまま検査にした。
一覧の包まれたURLを採用していないこと（空振り防止）・補完で切り替わること・
1回失敗しても巻き戻らないこと・2回続いても保たれること・据え置きが上書きを邪魔しないこと。

空振り検査は2通り鳴った（空でも上書きする／据え置きを優先しすぎる）。
⚠️ 3通り目に用意した「保存だけ直って画面が直らない」は**壊し方が成立しなかった**。
今の作りは保存レコードを `{ ...info }` から作るので、**保存と画面が同じオブジェクトに繋がっている**
＝その状態を単独の変更では作れない。将来分離された時に鳴るよう、
`upsertProgramInfos` に渡した側が書き換わるかを直接見る杭（⑥）を1本打ってある。
