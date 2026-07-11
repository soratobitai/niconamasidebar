# 09. 技術的負債・潜在バグ・改修時の注意

コード精読とワークフロー横断分析で確認した「非自明な事実・落とし穴・負債」の一覧。
**改修前・バグ調査前に必読**。

> **2026-07-11 更新**: 下記 A〜E, J, L を修正済み（独立エージェントによる敵対的レビューで回帰なしを確認、`npm run build` 成功）。
> 詳細な差分は `git log`／各ファイル参照。未対応項目（設計判断・情報）は後半にまとめた。

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

## ✅ E. `programInfoTtlMs` の未使用 import を削除 → **その後TTLキャッシュとして実装**（🟢→対応済み）
- **旧問題**: `api.js` が `programInfoTtlMs` を import するが未使用（TTL間引き未実装）。
- **一次対応(2026-07-11)**: `api.js` の未使用 import を除去。
- **本実装(仕様変更)**: `programInfoTtlMs`(60秒) を**TTLキャッシュ**として実装。`upsertProgramInfo` が保存時に `_fetchedAt` を付与し、`UpdateManager.updateSidebar` が「直近60秒以内に取得済みの番組詳細はキュー追加をスキップ」するようになった。2回目以降の読み込みが高速化＆API負荷軽減。
- 対象: `src/services/storage.js`, `src/managers/UpdateManager.js`, `src/config/constants.js`

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
- `#optionForm` change、各ボタン click、`document` 全体 click（resize強制）、`apiStats` の5分 setInterval などは cleanup で明示解除されない。単一ページ寿命では問題になりにくい。SPA的な再setup対応や厳密なリーク対策をするなら要整理。

## 🟢 M. `getOptions` の副作用（get が set する）
- 取得ついでにマージ結果を書き戻す（初回に既定値を永続化する意図）。「読むだけ」で呼ぶと storage 書き込みが走る点に注意。

## 🟢 N. `fetchProgramInfo` は Cookie を送らない
- リストAPIは `credentials:'include'` だが詳細APIは付けていない。現状は足りているが、ログイン依存の詳細が必要になったら見直す（意図的か要確認のため今回は変更せず）。

## 🟢 O. 「開いた瞬間の描画」と「定期タイマー初回」は別物
- `startSidebarUpdate` の初回実行も `updateProgramsInterval`（既定120秒）後。開いた直後の即描画は `performInitialLoad`/`performManualUpdate` が担う。二層構造を混同しないこと。

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
  - `apiCallCounter` 初期化の二系統（`apiStats.initApiStats` と `UpdateManager` コンストラクタ）→ 一元化（デバッグ用・低価値）。
  - `layout.js` の `adjustWatchPageChild` のレイアウト定数（`1024`/`1.777778`/`220.44444` 等）ベタ書き（項目G）→ 名前付き定数化（値の意味が不透明でドメイン知識が要るため保留）。
  - `performInitialLoad` と `performManualUpdate(settle=true)` の類似シーケンス → 共通内部メソッド化（並べ替え等価性の検証必須・**リスク高め**）。
  - `updateSidebar` 内の `getElementById('liveProgramContainer')` 4回取得 → 1回に集約（低価値・delicateな関数のため保留）。

## 🟢 R. サイドバー開閉時の列数パタつき（✅ 2026-07-11 修正）
- 症状: 開閉の一瞬、番組サムネが巨大化しレイアウトが崩れて見えた。
- 原因: `#sidebar` は幅を 0⇔実幅 に 0.5s の CSS transition でアニメする。列数計算 `setProgramContainerWidth`（幅が小さいほど列数少＝カード幅%大）が**アニメ途中の `#sidebar.offsetWidth`** で呼ばれ、序盤（幅<300）に1列＝カード100%になる一方、`#sidebar_container` は開いた瞬間に目標幅(例360px)固定なので**カードが360px＝巨大サムネ**化→完了時に多列へスナップしていた。`resizeObserver_sidebar` が `#sidebar` を監視しアニメ中毎フレーム発火するのが主な発火源。`UpdateManager.updateSidebar` のリスト再描画も同じ `offsetWidth` を使っていた。
- 修正: 列数計算の幅ソースを**「意図した幅」**に統一。`main.js` の各所（RO/onResize/トグルrAF/初期open・close）は `state.sidebarWidth.value`、`UpdateManager.updateSidebar` は `this.appState.sidebar.width` を使用。アニメ途中幅では列数を変えず、閉じていても「開き幅基準」で列を確定させておく。ドラッグ時は `onMouseMove` が `sidebarWidth.value` を即時更新するので列数のライブ追従は維持。
- 既知の残ギャップ（別件・低）: cross-tab の `sidebarWidth` 変更は `state.sidebarWidth.value`・DOM幅ともに未反映（`onChanged` が幅を再適用しない既存仕様）。単一タブ運用では問題なし。

---

## 改修時チェックリスト
- [ ] ニコ生DOMに触る変更 → `setElems`/`layout.js`/`status.js` のセレクタを確認（項目G）
- [ ] 状態を足す → まず `AppState` に。グローバル変数やモジュール間グローバル参照を作らない（教訓: 旧項目A）
- [ ] タイマー/リスナを足す → `AppState` 管理下に置き `cleanup()` で解放（項目K）
- [ ] ビルドは IIFE。モジュール間で「グローバル関数」を当てにしない（教訓: 旧項目A）
- [ ] リリース → `manifest.json` と `package.json` のバージョンを揃える、`dist/style.css` 生成確認（[07](./07-build-and-deploy.md)）
- [ ] `npm run build` 後、実ページ（要ログイン）で動作確認（[07 §7.5](./07-build-and-deploy.md)）
