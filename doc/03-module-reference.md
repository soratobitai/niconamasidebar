# 03. モジュール別リファレンス

各ファイルの役割・エクスポート・主要な内部挙動・注意点。関数シグネチャは実コードに準拠。

- 表記: `★` = そのファイルの中心、`⚠️` = 改修時に注意（詳細は [09-gotchas](./09-gotchas-and-techdebt.md)）。

---

## config/constants.js

全モジュール共通の定数。**チューニングはまずここ**。

| 定数 | 値 | 意味 |
|------|----|------|
| `notifyboxAPI` | `https://papi.live.nicovideo.jp/api/relive/notifybox.content.php` | フォロー中の放送中番組リストAPI |
| `liveInfoAPI` | `https://api.cas.nicovideo.jp/v1/services/live/programs` | 番組詳細API（`/lv{id}` を付けて使用） |
| `sidebarMinWidth` | `180` | サイドバー最小幅(px) |
| `maxSaveProgramInfos` | `200` | localStorage `programInfos` の最大件数＆キュー最大長 |
| `toDolistsInterval` | `0.25`（秒） | キューの処理間隔（`main.js` で `*1000` してms化） |
| `updateThumbnailInterval` | `20`（秒） | サムネ更新の既定間隔 |
| `thumbnailTtlMs` | `10000` | サムネ成功後この時間は再取得しない（フリッカ抑制） |
| `thumbnailRetryBaseMs` | `2000` | サムネ失敗時の再試行ベース間隔（指数バックオフの基数） |
| `thumbnailRetryMaxMs` | `60000` | サムネ再試行の最大間隔 |
| `programInfoTtlMs` | `60000` | 番組詳細の再取得間引きTTL ⚠️ `import` はされるが実際には未使用（→gotchas） |
| `loadingSessionTimeoutMs` | `60000` | ローディングセッションの強制終了タイムアウト |

---

## core/AppState.js ★

アプリ全体の状態を1つに集約するクラス。`main.js` で `const appState = new AppState()` として生成。

### 状態フィールド
[02-architecture.md §2.5](./02-architecture.md) の表を参照。

### メソッド
| メソッド | 説明 |
|---------|------|
| `setTimer(name, timer)` / `getTimer(name)` | タイマー登録/取得。`name` は `timers` のキーのみ有効 |
| `clearTimer(name)` | 値が数値なら `clearTimeout`＋`clearInterval` 両方呼び null化。⚠️ `todo` に入る `'queue-managed'`（文字列）は数値でないためここでは実際のタイマーは止まらない（キュー停止は別途 `programInfoQueue.stop()`） |
| `clearAllTimers()` | 全タイマークリア |
| `setObserver/getObserver/disconnectObserver/disconnectAllObservers` | ResizeObserver 等の管理。`disconnect()` を安全に呼ぶ |
| `setHandler(name)/getHandler(name)` | イベントハンドラ参照の保持（削除は呼び出し側責任） |
| `setVisibility(bool)/isVisible()` | Page Visibility 状態 |
| `startLoading()/finishLoading()` | `loading.operations` の増減（後方互換。実運用は下記セッション方式） |
| `isLoading()` | **`loading.updateSession !== null`** を返す（＝セッション方式が真実） |
| `startUpdateSession()` | `update_{Date.now()}_{Math.random()}` のIDを発行しセット。返り値=ID |
| `finishUpdateSession(id)` | 現行IDと一致した時のみ null化（後発セッションを誤終了しない） |
| `cleanup()` | 全タイマークリア＋全オブザーバー切断＋`onResize`解除＋`autoNext.liveStatusStopper()` 実行。ページ離脱時に `main.js` の `cleanup()` から呼ばれる |

---

## services/api.js ★

ニコ生2APIの fetch。**in-flight 重複排除**（同一リクエストが飛んでいる間は同じ Promise を返す）を持つ。

| 関数 | シグネチャ | 説明 |
|------|-----------|------|
| `fetchLivePrograms` | `(rows=100) => Promise<false \| Array>` | `notifyboxAPI?rows=100` を `credentials:'include'` で取得。`meta.status===200` かつ `data.notifybox_content` があれば**その配列を返す**。失敗時 `false`。`liveProgramsInFlight`(Map) で `rows` をキーに重複排除 |
| `fetchProgramInfo` | `(liveId) => Promise<data \| undefined>` | `liveInfoAPI/lv{id}` を取得。`meta.status===200` かつ `data` があれば `data` を返す。失敗時 `undefined`。`programInfoInFlight`(Map) で `id` 重複排除。⚠️ `credentials:'include'` は付けていない |

- 失敗は全て `handleError` に記録し、例外は投げず false/undefined を返す方針。
- ✅ 未使用だった `programInfoTtlMs` import は削除済み（2026-07-11）。TTL間引き自体は未実装のまま（定数は将来用に `constants.js` に残置 → [09-gotchas E](./09-gotchas-and-techdebt.md)）。

---

## services/queue.js ★（`ProgramInfoQueue`）

番組詳細を**レート制限しながら順次取得**する待ち行列。`main.js` で1インスタンス生成。

### 構造
- `queueSet`(Set) で重複防止＋`queueArray`(Array) でFIFO順序保持、の二重管理。
- コンストラクタ options: `batchSize`(1), `processInterval`(ms), `idleTimeout`(50), `maxSize`(200),
  `maxRequestsPerSecond`(4), 各種コールバック(`onProcessStart/Complete/Error/QueueEmpty`),
  `getVisibilityState`（可視状態取得関数）。
- `shouldSort`: 初回/サイドバーオープン/更新ボタン時のみ true にして、処理完了後にソートさせるフラグ。

### 主要メソッド
| メソッド | 説明 |
|---------|------|
| `add(ids)` | 単体/配列でID追加。重複はスキップ。`maxSize` 超過は古い方から破棄。一度に50件以上追加で警告 |
| `remove(id)` / `has(id)` / `size()` / `clear()` | 基本操作 |
| `setShouldSort(bool)` | ソートフラグ設定 |
| `_checkRateLimit()` | 直近1秒のリクエスト数が `maxRequestsPerSecond` 未満か判定 |
| `_recordRequest()` | リクエスト時刻を記録 |
| `processBatch(batchSize)` ★ | 空なら`onQueueEmpty`で即return。処理中なら return。レート枠内で `actualBatchSize` 件を**逐次** `fetchAndSave` → 結果に応じ `remove`（成功も失敗もキューから除去＝無限ループ防止）→ `onProcessComplete(count, results, shouldSort)`。各リクエスト間に `1000/maxRPS` ミリ秒待つ |
| `fetchAndSave(liveId)` | `window.apiCallCounter` を加算 → `fetchProgramInfo` → `providerType==='user' && !liveScreenshotThumbnailUrls` はスキップ(false) → `upsertProgramInfo` で保存 |
| `start()` | `processLoop` を回す。**可視かつ requestIdleCallback可**ならアイドル時に処理、次回を `processInterval`（空なら×3）でスケジュール。**バックグラウンド**では通常 setTimeout かつ間隔×10（空なら更に×3） |
| `stop()` | タイマー停止 |
| `processNow(maxItems=null)` | 手動全件処理。処理中なら100ms待って再帰。進まない時は指数待機で最大5回リトライして中断（レート制限対策） |

### 番組終了/失敗の扱い
- `fetchProgramInfo` が 404 等で undefined → `fetchAndSave` false → それでも `remove`（再試行しても無駄なため）。

---

## services/status.js

watch ページ上の「**番組終了ガイド**」を検知して自動移動をトリガする。

| 関数 | 説明 |
|------|------|
| `detectProgramEndGuide()`（内部） | `[class*="program-end-guide"]` を探し、子に `announcement` / `next-action-area` / `broadcast-request-send-button` が**全て揃う**時のみ true（ハッシュ付きクラス名に部分一致、テキストは見ない） |
| `observeProgramEnd(onEnded)` ★ export | `document.body` を `MutationObserver`（childList/subtree/attributes[class]）で監視し、終了検知で `onEnded()`。即時チェックも実施。返り値は**停止関数**（`AppState.autoNext.liveStatusStopper` に保持される） |

⚠️ ニコ生のDOM/クラス名変更に弱い（部分一致で緩和はしている）。

---

## services/storage.js ★

設定と番組キャッシュの永続化。**設定=`chrome.storage.local`**、**番組=ページの`localStorage`**の2系統。

| 関数 | ストレージ | 説明 |
|------|-----------|------|
| `getOptions(defaultOptions={})` | chrome.storage.local | 全取得→ `{...defaults, ...stored}` マージ→**マージ結果を書き戻し**て返す（欠損キー補完）。失敗時は defaults を返す |
| `saveOptions(options)` | chrome.storage.local | 保存（Promise） |
| `setIsOpenSidebar(bool)` | chrome.storage.local | `isOpenSidebar` のみ保存 |
| `setSidebarWidth(width)` | chrome.storage.local | `sidebarWidth` のみ保存 |
| `getProgramInfos()` | localStorage | `programInfos` を JSON parse（失敗時 `[]`） |
| `setProgramInfos(list)` | localStorage | JSON保存。**QuotaExceeded 時は後半半分に減らして再試行** |
| `upsertProgramInfo(info)` ★ | localStorage | `id` 一致で置換、無ければ push。`maxSaveProgramInfos`(200) 超過は先頭から shift |

> ⚠️ 設定は `chrome.storage.local` に入るが、`main.js` の `chrome.storage.onChanged` リスナーは
> `changes.xxx` を直接見ており、`local` / `sync` の area 判定はしていない（このプロジェクトでは local しか使わないので実害なし）。

---

## managers/UpdateManager.js ★★（更新の司令塔）

3系統タイマーの起動/停止と、実際の描画更新を担う中核クラス。

コンストラクタ: `(appState, programInfoQueue, loadingManager, options, elems, loadingImageURL)`。
`window.apiCallCounter` を用意（デバッグ）。

| メソッド | 説明 |
|---------|------|
| `startThumbnailUpdate()` | `updateThumbnail()` を即実行→完了後 `updateThumbnailInterval` 秒で再セット（自己再帰 setTimeout）。タイマーは `appState.timers.thumbnail` |
| `startToDoListUpdate()` | `oneTimeFlag` が立っていれば `performInitialLoad()` 実行後 false 化 → `programInfoQueue.start()` → `timers.todo='queue-managed'`（番兵） |
| `startSidebarUpdate()` | 既存タイマー掃除→`updateSidebarInterval`（`updateSidebar` 実行→最低1秒のローディング確保→自己再帰）を `updateProgramsInterval` 秒間隔で回す |
| `stopAllTimers()` | thumbnail/todo/sidebar クリア＋キュー stop |
| `restartSidebarUpdate()` | sidebar タイマーを張り直す（間隔変更時など） |
| `performInitialLoad()` ★ | 初回のみ。`setShouldSort(true)`→`updateSidebar()`→（RAF×2待ち）→`processNow(null)`で**全件詳細取得**→`updateThumbnail(true)`→最低1秒ローディング→（開いていれば）`restartSidebarUpdate()`。`isPerformingInitialLoad` で多重防止 |
| `performManualUpdate()` ★ | 手動更新（オープン/タブ復帰/更新ボタン）。`updateSidebar()`→`updateThumbnail(true)`→最低1秒→`restartSidebarUpdate()` |
| `getLivePrograms(rows=100)` | `fetchLivePrograms` ラッパ。統計加算＋1分10回超で異常警告。失敗時は `#api_error` を表示（ログイン促し） |
| `updateSidebar()` ★★ | ローディングセッション開始→ `getProgramInfos()`（キャッシュ）＋ `getLivePrograms(100)`（一覧）→ 一覧を回して**既存DOMは軽量更新**（active-point/title/link）、**新規は`makeProgramElement`で生成**、各番組を**キューに add**→ `replaceChildren(frag)`→サムネ監視更新→ソート→カラム幅→番組数更新。失敗/空配列時は既存DOM維持 |
| `updateThumbnail(force, onComplete)` | 挿入中(`isInserting`)なら何もしない→ `getProgramInfos()`→ `updateThumbnailsFromStorage` に委譲 |
| `sortProgramsInContainer(container)` | `sortPrograms(container, options.programsSort)` |
| `updateProgramCount(count)` | `#program_count` の数字更新 |
| `updateActivePointsAndSort(shouldSort)` | 各カードの `active-point` を再計算し、変化があり `shouldSort` の時のみソート |

> ⚠️ `updateManager.startThumbnailUpdate` は `options.updateThumbnailInterval` を参照するが、
> このキーはデフォルトオプションにもUIにも存在しない（常に定数 `updateThumbnailInterval`=20秒が使われる）。

---

## managers/LoadingManager.js

「更新セッション」単位でローディング表示(更新ボタンのスピナー)を制御。

コンストラクタ: `(appState, loadingSessionTimeoutMs)`。

| メソッド | 説明 |
|---------|------|
| `startSession()` | `appState.startUpdateSession()` でID発行→`updateLoadingState()`→`loadingSessionTimeoutMs`(60秒)後に強制 `finishSession()` するタイムアウト設定 |
| `finishSession()` | セッション終了。10秒超は警告。タイムアウトタイマー解除→`appState.finishUpdateSession`→`updateLoadingState()` |
| `finishSessionWithMinDuration(minDuration=1000)` | 経過が `minDuration` 未満なら差分だけ待ってから `finishSession()`（スピナーが一瞬で消えないように） |
| `updateLoadingState()` | `#reload_programs` に `.loading` を付/外し（`pointer-events` も制御）。`isLoading()` = `appState.isLoading()` |
| `getCurrentSessionId()` / `isLoading()` | 現行セッション取得 / ローディング判定 |

---

## managers/AutoNextManager.js ★

番組終了時の自動移動（モーダル→10秒カウントダウン→次番組へ遷移）。

コンストラクタ: `(appState)`。

| メソッド | 説明 |
|---------|------|
| `ensureModal()` | `#auto_next_modal` を（無ければ）`createElement` で生成。backdrop/dialog/title/message(`#auto_next_count`)/preview(`#auto_next_provider`,`#auto_next_thumb`,`#auto_next_title`)/actions(`#auto_next_cancel`) 構造 |
| `showModal(seconds, preview, onCancel)` | カウント初期値・プレビュー(thumb/title/provider)設定→`.show`付与→キャンセルボタンに `{once:true}` でハンドラ（`autoNext.canceled=true`＋onCancel） |
| `hideModal()` | `.show` 除去 |
| `scheduleNavigation(nextHref, preview)` ★ | 既存カウントダウン停止→`remaining=10`→`showModal`→`setInterval(1s)`で減算表示。canceled で中断、0で `location.assign(nextHref)`。タイマーは `timers.autoNext` |
| `startWatcher(updateSidebarFn=null)` ★ | `observeProgramEnd` で終了監視開始。終了時: 多重進入抑止(`scheduled`/`selectingNext`)→**サイドバー更新**→`#liveProgramContainer` のリンクから**現在番組と異なる先頭番組**を選び、プレビュー抽出して `scheduleNavigation`。stopper を `appState.autoNext.liveStatusStopper` に保持 |
| `stopWatcher()` | 監視停止・カウントダウン停止・モーダル閉じ・フラグリセット |

> ✅ **修正済み(2026-07-11)**: `startWatcher(updateSidebarFn)` は `main.js` から注入された更新関数のみを使う。
> `main.js` の `startLiveStatusWatcher()` が `autoNextManager.startWatcher(updateSidebar)` と関数を渡すため、
> 終了検知時に最新リストを取得してから次番組を選定する。（旧: `typeof updateSidebar` のグローバル参照がIIFEで未解決だった）→ [09-gotchas A](./09-gotchas-and-techdebt.md)

---

## render/sidebar.js ★★（DOM生成・サムネ更新）

番組カードのDOM生成と、ライブサムネの賢い更新ロジック。

| エクスポート | 説明 |
|-------------|------|
| `makeProgramElement(data, loadingImageURL)` ★ | 番組データ→カードDOM（`createElement`ベース、XSS配慮）。`div.program_container#{数字ID}` に `community`(icon/community_name) + `program_thumbnail`(img: `src`=ライブサムネ, `data-src`=静的サムネ, **error時フォールバック配線済み**) + `program_title`。`providerType` で user/channel を出し分け（user=`liveScreenshotThumbnailUrls.middle?cache=`, channel=`large1280x720ThumbnailUrl`）。旧形式(lv無し)データにも対応 |
| `calculateActivePoint(data)` | 人気度スコア = `(viewers+1 + comments+1) / max(1, 経過分)`。`onAirTime.beginAt` から経過時間算出。ソート・active-point属性の元になる**現役関数**（✅ 誤った `@deprecated` JSDocは2026-07-11に修正） |
| （内部）`handleThumbnailError` | サムネ読み込み失敗時のフォールバック（`data-src`→loading.gif）。✅ 2026-07-11に `makeProgramElement` で各imgへ直接配線（旧 `attachThumbnailErrorHandlers` は未使用のため削除） |
| `updateThumbnailsFromStorage(programInfos, {force,onComplete})` ★★ | localStorageの番組情報を元に各サムネを更新。`computeNext` でURL決定（memberOnlyはスキップ）。**TTL**(`thumbnailTtlMs`)内かつ同キーは skip、失敗は**指数バックオフ**(`nextTryAt`)。`new Image()` でプリロード成功時のみ差し替え（フリッカ防止）。50件チャンク＋`requestAnimationFrame`。可視画像(IntersectionObserver)があればそれを優先対象に |
| `initThumbnailVisibilityObserver()` / `refreshThumbnailObservations()` / `teardownThumbnailVisibilityObserver()` | `#liveProgramContainer` 内の `.program_thumbnail_img` を IntersectionObserver で可視監視（`rootMargin:200px`）。可視集合 `visibleImages` を維持 |
| `sortProgramsByActivePoint(container)` | `active-point` 降順に並べ替え（人気順の実体） |
| `buildSidebarShell({reloadImageURL, optionsImageURL})` ★ | サイドバー枠HTML(`sidebarHtml`)・境界線(`sidebarLine`)・オプションフォーム(`optionHtml`)の文字列を返す。`main.js` が body に挿入。オプションフォームの全ラジオ(表示順序/自動更新/オートオープン/自動移動)はここに定義 |

> データキー: サムネURLの `key` は user=`u|{base}`, channel=`c|{base}`。ユーザー配信のみ `?cache={now}` を付与してキャッシュ回避。

---

## ui/layout.js ★

視聴ページ**本体側**の幅を、サイドバー分だけ詰めて破綻させないための調整。

| 関数 | 説明 |
|------|------|
| `adjustWatchPageChild(elems)` ★ | プレイヤー/番組情報/フッター等の子要素幅を、`watchPage` 幅と画面モードに応じて px 指定。`isScreenSizeAuto()`（自動サイズ）と `isFullScreen()` を見て分岐。フルスクリーンは100%。`data-player-layout-mode` 時は leoPlayer 高さを 16:9 で算出。ニコ生の細かいレイアウト仕様に依存したマジックナンバー多数 |
| `setProgramContainerWidth(elems, sidebarWidth)` ★ | サイドバー幅に応じて `.program_container` の列数を1〜8段階で切替（300/500/700/900/1100/1300/1500px 境界）。幅が広いほど多カラム |
| `isScreenSizeAuto()`（内部） | `localStorage.LeoPlayer_ScreenSizeStore_kind` に `auto` を含むか（ニコ生プレイヤーの設定を覗く） |
| `isFullScreen()`（内部） | `<html data-browser-fullscreen>` の有無 |

---

## ui/sidebarControl.js ★

サイドバーの開閉・幅ドラッグ・本体(root)幅追従。`createSidebarControl(elems, state)` がクロージャで各関数を返す。

`state` = `{ sidebarWidth:{value}, isOpenSidebar:{value} }`（`main.js` とのブリッジ用の参照オブジェクト）。

| 返り関数 | 説明 |
|---------|------|
| `setRootWidth()` | `#root` の幅を `innerWidth - sidebar幅 - 20` に設定（RAFで実幅確定後に） |
| `openSidebar()` | 最小幅補正の上、sidebar/container 幅を設定、矢印/カーソルクラス付与、`setRootWidth` |
| `closeSidebar()` | 幅0に、クラス除去、`setRootWidth` |
| `toggleSidebar()` | 開閉トグル→`setIsOpenSidebar`（storage保存） |
| `enableSidebarLine()` | 境界線 `#sidebar_line` のドラッグでリサイズ（`mousedown/move/up`）。ドラッグ中は transition を外す→終了で `setSidebarWidth` 保存 |

> ⚠️ `openSidebar/closeSidebar` 内で **`sidebar_arrow`**（グローバル）を id 参照している（`elems` 経由でない）。
> `#sidebar_arrow` が存在する前提のブラウザの「id→window プロパティ」挙動に依存。

---

## handlers/optionsHandler.js

オプションフォームの初期反映と変更保存。`setupOptionsHandler(options, programInfoQueue, sortPrograms)`。

- 起動時に4項目（`programsSort`/`updateProgramsInterval`/`autoOpen`/`autoNextProgram`）のラジオを現設定に合わせる。
- `#optionForm` の `change` で `saveOptions()`（`chrome.storage.local` へ）。
- **ソート変更(`programsSort`)時のみ特別扱い**: APIを叩かず、`setShouldSort(true)`＋保存＋既存DOMを即ソート＋サムネ監視更新。
- 保存自体は `chrome.storage.local` へ。変更は `main.js` の `chrome.storage.onChanged` が拾って各挙動へ反映（[04-data-flow](./04-data-flow.md) 参照）。

---

## utils/sorting.js

| 関数 | 説明 |
|------|------|
| `sortPrograms(container, sortType)` | `sortType==='active'` → `sortProgramsByActivePoint`（人気順）。それ以外(=`newest`) → **番組ID(数値)降順**（新着順。IDが大きいほど新しい前提） |

---

## utils/dom.js

| 関数 | 説明 |
|------|------|
| `debounce(fn, delay)` | 標準的なデバウンス。`main.js` のリサイズ(30ms)で使用 |

---

## utils/error.js

エラーの分類・ログ・リトライ戦略。実運用は `handleError` 一本。

| エクスポート | 説明 |
|-------------|------|
| `ErrorType` | `API/NETWORK/DOM/STORAGE/VALIDATION/UNKNOWN` |
| `ErrorLevel` | `INFO/WARNING/ERROR/CRITICAL` |
| `class ErrorManager` | `handle(error, context)` でエラー情報生成→ログ(最大100件)→コンソール出力。`_classifyError`（メッセージ文字列から種別推定）、`_determineLevel`、`getLogs`、`isRetryable`、`calculateRetryDelay`（指数バックオフ）を持つ |
| `handleError(error, context)` ★ | モジュールローカルの `errorManager` へ委譲。**全layerの失敗経路がここに集まる** |

> ⚠️ `_detectDevelopmentMode()` は「chrome.runtime があれば常に true（開発時）」＝**本番でも console 出力が有効**。
> リトライ機構(`isRetryable`/`calculateRetryDelay`)は定義のみで、現状どこからも呼ばれていない。

---

## debug/apiStats.js

API呼び出し頻度の可視化・異常検知（開発/本番共通の安全網）。

| エクスポート | 説明 |
|-------------|------|
| `initApiStats()` ★ | `window.apiCallCounter` を初期化し、5分ごとの監視(`startApiMonitoring`)を開始、`window.showApiStats` を公開。`main.js` トップレベルで即実行される |
| （内部）`startApiMonitoring()` | 5分ごと。直近1分の呼び出しが**200回超**で警告（レート上限240件/分に接近） |
| （グローバル）`window.showApiStats()` | コンソールから累計/平均/直近頻度を表示 |

---

## main.js ★★★（エントリ／オーケストレータ）

最大ファイル。**初期化順序の制御・イベント配線・各層への委譲**が仕事。詳細な起動シーケンスは [04-data-flow.md](./04-data-flow.md)。

### トップレベル
- 全モジュールを import、`appState`・`programInfoQueue`（レート制限設定つき）を生成。
- `defaultOptions`（下記）・`options`・`elems` を用意し `appState.config/elements` に接続。
- `localStorage.programInfos` 未初期化なら `[]` で初期化。
- `initApiStats()` を即実行。

### defaultOptions（既定設定）
```js
{
  programsSort: 'newest',        // 新着順
  autoOpen: '3',                 // ページを閉じる前の状態を記憶
  updateProgramsInterval: '120', // 秒（番組リスト自動更新）
  sidebarWidth: 360,
  isOpenSidebar: false,
  autoNextProgram: 'off',        // 自動移動OFF
}
```

### 主な関数（多くは Manager への委譲ラッパー）
| 関数 | 説明 |
|------|------|
| `setElems()` | ニコ生ページの各要素を `elems` に収集（`[class*="..."]` 部分一致でハッシュ付きクラスに対応） |
| `DOMContentLoaded` ハンドラ | `?popup=on` なら終了。`getOptions()`→`appState` へ反映→`setElems()`→`#root` 無ければ終了→**`setup()`（1回のみ）** |
| `setup()` ★ | サイドバー挿入→`reflectOptions()`→**3 Manager 生成**→レイアウト調整→resize/ResizeObserver/theaterボタン/更新ボタン/オプションポップアップ/サイドバーボタン/境界線ドラッグを配線→**初期開閉状態を適用**→`autoNextProgram==='on'` なら watcher 開始→`beforeunload/pagehide`で`cleanup`→**visibilitychange** 監視 |
| `cleanup()` | `appState.cleanup()`＋キュー停止/クリア＋サムネ監視破棄＋onResize解除＋モーダル閉じ |
| `stopAllTimers()` | thumbnail/todo/sidebar/autoNext をクリア＋キュー停止 |
| `handleSidebarOpenStateChange(open)` ★ | 開: サムネ可視監視init＋thumbnail/sidebarタイマー開始＋（`oneTimeFlag`なら初回ロード、else 手動更新）を RAF/フォールバックで実行。閉: 全タイマー停止＋監視破棄 |
| `startThumbnailUpdate/startToDoListUpdate/startSidebarUpdate` | UpdateManager へ委譲 |
| `ensure/show/hideAutoNextModal`, `scheduleAutoNextNavigation`, `start/stopLiveStatusWatcher` | AutoNextManager へ委譲 |
| `chrome.storage.onChanged` リスナー ★ | 設定変更を `options` に反映し、`isOpenSidebar`→開閉処理、`updateProgramsInterval`→タイマー再起動、`autoNextProgram`→watcher開始/停止 |
| `restartSidebarUpdate` | UpdateManager へ委譲 |
| `getOptions()` | `storage.getOptions(defaultOptions)` |
| `insertSidebar()` ★ | `buildSidebarShell` の結果を `body` 先頭に挿入、`#optionContainer` を body 直下へ移動、`elems.sidebar` 等を確定、body を `display:flex` に、`#root` を `flexGrow:1` に |
| `finishLoadingSession*`, `performInitialLoad`, `performManualUpdate`, `updateSidebar`, `updateThumbnail`, `updateActivePointsAndSort`, `updateProgramCount`, `updateLoadingState` | 各 Manager への委譲ラッパー |
| `sortPrograms(container)` | `sortProgramsUtil(container, options.programsSort)` |
| `reflectOptions()` | `setupOptionsHandler(options, programInfoQueue, sortPrograms)` |

### オプションポップアップ配置（setup内）
`#setting_options` クリックで `#optionContainer` を表示。`placePopup` がボタン直下に、画面外なら上側に配置。
resize/scroll/Esc/外側クリックで再配置・クローズ。

> ✅ 死んでいた `clearTimer('queueRestart')`（未宣言キー）は `stopAllTimers` から削除済み（2026-07-11）。
> ✅ `AppState.handlers` に `reloadBtn` を宣言追加したため、更新ボタンの `setHandler('reloadBtn', ...)` が実効化（2026-07-11）。
