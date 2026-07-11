# 04. データフロー & ライフサイクル

コンテンツスクリプト注入 → 初期化 → 番組リスト取得 → キュー/API → 描画 → 定期更新 → 自動移動 までを
実コードに基づいて番号付きでトレース。行番号は現時点のもの（`src/main.js` 等）。

> このドキュメントは「**いつ・何が・どの順で**動くか」を追うための地図です。関数の中身は [03-module-reference.md](./03-module-reference.md)、外部I/Oは [05-external-api.md](./05-external-api.md) を併読。

---

## フェーズ0: 注入タイミングと前提

- `manifest.json`: `run_at:"document_start"` で `main.js`（ビルド後 `dist/main.js`）と `style.css` を `watch/*` に注入。
- したがって `main.js` は **DOM未構築の非常に早い段階**で評価され、実処理は `DOMContentLoaded` を待つ。
- 中核状態は `AppState` インスタンス `appState`、永続化は `chrome.storage.local`（設定）＋ `localStorage.programInfos`（番組キャッシュ）。

## フェーズ1: モジュール即時実行（`main.js` load 時）

`main.js` トップレベルで即時に:
1. `appState = new AppState()`（全状態を初期値生成。`oneTimeFlag=true`, `updateSession=null`, `sidebar.width=360`, `isOpen=false`）
2. `programInfoQueue = new ProgramInfoQueue({...})`（`batchSize:1`, `processInterval:250ms`, `maxSize:200`, `maxRequestsPerSecond:4`, `getVisibilityState:()=>appState.isVisible()`）。**この時点でキュータイマーは未起動**。
3. `defaultOptions` 定義、`appState.config`/`elements` に参照接続。
4. `localStorage.programInfos` が無ければ `'[]'` 初期化。
5. 画像URLを `chrome.runtime.getURL` で解決。
6. `DOMContentLoaded` リスナ登録／`chrome.storage.onChanged` リスナ登録。
7. **`initApiStats()` 実行** → `window.apiCallCounter` 初期化＋**5分ごとの `setInterval` 監視を恒久起動**＋`window.showApiStats` 公開。

> この段階で動く定期処理は **apiStats の5分 setInterval のみ**。番組/サムネ/キューのタイマーは未起動。

## フェーズ2: 初期化（`DOMContentLoaded` → `setup()`）

8. `?popup=on` なら**即 return**（別窓くん対応）。
9. `options = await getOptions()` … `chrome.storage.local.get` → defaults とマージ → **書き戻し** → `appState.sidebar.width/isOpen` に反映。
10. `setElems()` でニコ生既存DOMを収集 → `#root` 不在なら return。
11. `isSetupCompleted` で二重防止 → **`setup()`**（以降 true）。

### setup() の配線（順序が重要）
12. `await insertSidebar()` … `buildSidebarShell` の結果を `body` 先頭に注入、`#optionContainer` を body直下へ移動、`body{position:relative;display:flex}`・`#root{flex-grow:1}` を破壊的設定。
13. `reflectOptions()` → `setupOptionsHandler`（ラジオ初期反映＋`#optionForm` change リスナ登録）。
14. **Manager 3種を生成**（`LoadingManager`, `AutoNextManager`, `UpdateManager`）。← insertSidebar の後でないとDOM参照が取れない。
15. `adjustWatchPageChild(elems)` でニコ生本体の幅調整。
16. resize系配線: `window.resize`(debounce30ms) / `ResizeObserver`×2（watchPage幅・sidebar幅）/ theaterボタン click。
17. `#reload_programs` click → `isLoading()` なら無視、else `performManualUpdate()`。
18. `#setting_options`（オプションポップアップ）open/close/配置リスナ群。
19. `#sidebar_button` click → `toggleSidebar()` → `handleSidebarOpenStateChange()` → rAF2段でレイアウト再計算。`enableSidebarLine()` でドラッグ有効化。

### 初期開閉の分岐（心臓部）
20. `shouldOpenAtStart = (autoOpen=='1') || (autoOpen=='3' && isOpenSidebar)`
    - **開く**: UIを即 `openSidebar()` → rAF2段でレイアウト → **`setTimeout(()=>handleSidebarOpenStateChange(true), 300)`**（データ取得は300ms遅延＝初期ページ描画を妨げない）。← **初回データ取得の実質トリガ**
    - **閉じる**: `closeSidebar()` → `handleSidebarOpenStateChange(false)` → `stopAllTimers()` ＋監視破棄（**閉じている間はタイマーもデータ取得も走らない**）。
21. `autoNextProgram==='on'` なら `startLiveStatusWatcher()`（→ フェーズ7）。
22. `beforeunload`/`pagehide` → `cleanup`、`visibilitychange` → `handleVisibilityChange`（→ フェーズ6）。

## フェーズ3: 初回データ取得（サイドバーが開いている時のみ）

23. **`handleSidebarOpenStateChange(true)`**:
    1. `initThumbnailVisibilityObserver()`（IntersectionObserver生成）
    2. なければ `startThumbnailUpdate()`（フェーズ5.1）
    3. なければ `startSidebarUpdate()`（フェーズ5.3）
    4. rAF内で分岐: `oneTimeFlag===true`（初回）→ `startToDoListUpdate()` / それ以外 → `performManualUpdate()`
    5. rAF不発（非アクティブタブ等）に備え `setTimeout(100ms)` フォールバック。
24. **`startToDoListUpdate()`（初回）** → `oneTimeFlag` が true なら **`performInitialLoad()`** 実行後 false化 → `programInfoQueue.start()` → `timers.todo='queue-managed'`。
25. **`performInitialLoad()`**（人気順のガチャつき対策を含む）:
    1. **`appState.update.settling = true`**（整列確定中フラグ）
    2. `setShouldSort(true)`
    3. `await updateSidebar()`（フェーズ4）← **キャッシュに詳細が無い番組があれば新着順、全て揃っていれば人気順で描画**（`getEffectiveSortType` / `settlingNeedsNewest`）
    4. rAF×2でDOM反映待ち
    5. キューがあれば **`processNow(null)`（全件即時取得）** ← この間、active-point属性は更新されるが**並べ替えはしない**
    6. **`settling = false` → 人気順(active)なら `flipReorder` で1回だけ最終ソート（FLIPで滑らかにスライド）**
    7. `updateThumbnail(true)`（強制）
    8. `finishSessionWithMinDuration(1000)`（最低1秒ローディング表示＝更新ボタンのスピナーが整列完了まで回る）
    9. 開いていれば `restartSidebarUpdate()`
    - `finally` で `settling=false` を保証（例外時も詰まらない）

> ✅ **人気順のガチャつき対策（仕様変更）**: 人気順の初回ロードは、**キャッシュで人気順を確定できる場合は最初から人気順で表示（移動なし）**。詳細未取得の番組がある場合のみ「新着順で即表示・操作可 → 確定後に1回だけ人気順へFLIPで並べ替え」。連続再ソートを排除。新着順選択時は挙動不変。
> （TTLキャッシュにより2回目以降＝キャッシュ完備は、ほぼ常に「最初から人気順・移動なし」になる。）
> ⚠️ **初回ロードは `oneTimeFlag` で1度きり**。以降の再オープンや可視復帰は `performManualUpdate` 経路になり、`processNow(全件)`・settling処理は走らない（通常のキュータイマーに委ねる）。

## フェーズ4: 番組リスト取得 & 描画（`updateSidebar()`）

初回・手動・定期・自動移動の**全経路から呼ばれる中核**。
26. `loadingManager.startSession()`（`.loading`表示＋60秒タイムアウト設定）
27. `getProgramInfos()`（localStorage読み） ＋ `getLivePrograms(100)`（`fetchLivePrograms`／`credentials:'include'`／in-flight重複排除）
    - 取得成否で `#api_error` を `none`/`block`（ログイン誘導）
28. **失敗系は既存DOM維持**: `false`（API失敗）も `length===0`（空）も再構築せずカウントだけ更新して return。`#api_error` 表示は `false` の時のみ。
29. 差分再構築: 既存カードは**軽量更新**（active-point/title/link）、新規は `makeProgramElement`。各番組を `programInfoQueue.add(program.id)`。
    - ✅ **TTLキャッシュ（仕様変更）**: `data._fetchedAt` が直近 `programInfoTtlMs`(60秒) 以内なら**キュー追加をスキップ**（再取得しない）。2回目以降の読み込みが高速化。120秒周期の定期更新では60秒超のため通常どおり再取得され、詳細は古びない。
30. `isInserting=true` → `replaceChildren(frag)` → `refreshThumbnailObservations()`
31. `sortPrograms(container, programsSort)`（active=人気順 / newest=ID降順）
32. `setProgramContainerWidth` → `updateProgramCount` → `isInserting=false`

## フェーズ5: 3系統の定期タイマー

`handleSidebarOpenStateChange(true)` で起動、`stopAllTimers()`（閉/cleanup）で停止。

### 5.1 thumbnail（既定20秒・自己再帰 setTimeout）
33. `startThumbnailUpdate()` … `updateThumbnail()` を**即時実行**し、完了後 `setTimeout(20s)` で再帰。
    - `updateThumbnail` は `isInserting` 中スキップ → `getProgramInfos()` → `updateThumbnailsFromStorage`。
    - TTL10秒・失敗時指数バックオフ（2s〜60s）、`new Image()` プリロード成功時のみ差し替え（フリッカ防止）。可視画像優先。

### 5.2 todo（キュー、ProgramInfoQueue 内部タイマー）
34. `programInfoQueue.start()` … `processLoop` を250ms間隔で回す。可視かつ `requestIdleCallback` 可ならアイドル処理、**バックグラウンドは間隔10倍**、空なら×3。
35. `processBatch()` … レート制限（直近1秒4件未満）下でFIFO逐次 `fetchAndSave` → `fetchProgramInfo(lv{id})` → `upsertProgramInfo`（localStorage、200超shift）。**成功/失敗問わず remove**（再試行不可のため）。完了で `onProcessComplete` → `updateActivePointsAndSort(shouldSort)`。
36. `processNow()` … 初回ロード/可視復帰で全件即時処理（進捗0が続けば最大5回リトライ）。

### 5.3 sidebar（既定120秒・自己再帰 setTimeout）
37. `startSidebarUpdate()` … **最初の実行も120秒後**（即時ではない）。`updateSidebar()` → 最低1秒ローディング → 自己再帰。**別更新が進行中(`isLoading()`)の周期はスキップして次回へ**（手動settleの `processNow` への割り込み・セッション上書き防止）。
38. `restartSidebarUpdate()` … オプション変更時/初回・手動ロード末尾で張り直し。

> ⚠️ **開いた瞬間の描画は sidebar タイマーではなく**、フェーズ3の `performInitialLoad`/`performManualUpdate` が担う。sidebar タイマーの初回も120秒後である点に注意。

## フェーズ6: タブ可視状態変化（Page Visibility）

39. `handleVisibilityChange`（`appState.sidebar.isOpen` が true の時のみ処理）:
    - **復帰(visible)**: 停止中の thumbnail/todo/sidebar を再起動＋キューあれば `processNow()`＋rAFで `performManualUpdate()`（即時更新）。
    - **背景移行(hidden)**: `thumbnail` タイマー停止（sidebar/todo はキュー側で間隔延長）。アクティブセッション残＆キュー空なら500ms後に `finishLoadingSession()`（セッション残留対策）。

## フェーズ7: 番組自動移動（AutoNext）

`autoNextProgram==='on'` の時のみ。
40. `startWatcher()` → `observeProgramEnd()` が `document.body` に `MutationObserver`（class監視）を張る。
41. 終了検知（`program-end-guide` 内に announcement＋next-action-area＋broadcast-request-send-button が揃う）で:
    1. 多重進入抑止（`scheduled`/`selectingNext`）
    2. `updateSidebar()`（✅ 2026-07-11修正: `main.js` から注入された関数で**実際に最新リストを取得**してから選定する。旧実装はIIFEで未解決だった → [09-gotchas A](./09-gotchas-and-techdebt.md)）
    3. `#liveProgramContainer` のリンクから**現在番組と異なる先頭番組**を選定＋プレビュー抽出
    4. `scheduleNavigation(href, preview)` → モーダル＋`setInterval(1000ms×10)` → 0で **`location.assign(nextHref)`**（キャンセル可）

## フェーズ8: 手動更新

42. `#reload_programs` click → `isLoading()` なら無視 → **`performManualUpdate(true)`（settle）**: `updateSidebar`（`notifybox` を毎回取得＝新着/終了反映、人気順で即描画・新着順退避なし、**`forceRefetch`でTTL無視して全番組をキュー投入**）→ `processNow(null)` で**全詳細を再取得**（間は再ソート抑制）→ **人気順なら1回だけ `flipReorder`** → `updateThumbnail(true)`（サムネ強制）→ 最低1秒 → `restartSidebarUpdate()`。タブ復帰/再オープンは `performManualUpdate()`（settle無し・TTL維持の軽量更新）。

## フェーズ9: オプション変更の伝播（`chrome.storage.onChanged`）

43. `updateProgramsInterval` 変更 → `restartSidebarUpdate()`
    `isOpenSidebar` 変更 → `handleSidebarOpenStateChange()`
    `autoNextProgram` 変更 → watcher start/stop
    `programsSort`/`autoOpen`/`sidebarWidth` → `options`/`appState` に反映

## フェーズ10: ローディングセッション（横断）

44. 1つの `updateSession` ID が更新1サイクルを包括。`updateSidebar` 先頭で `startSession`（`.loading`表示＋60秒タイムアウト）、各経路末尾で `finishSessionWithMinDuration(1000)`。`isLoading()` = `updateSession!==null` が更新ボタン無効化と多重更新防止の判定源。

## フェーズ11: クリーンアップ

45. `cleanup()`（`beforeunload`/`pagehide`）… `appState.cleanup()`（全タイマー/オブザーバー解放＋autoNext停止）＋キュー stop/clear＋サムネ監視破棄＋onResize解除＋モーダル閉じ。

---

## タイマー/再実行 早見表

| タイマー | 起動 | 間隔 | 再実行 | 停止 |
|---------|------|------|--------|------|
| apiStats監視 | モジュールload | 5分 | `setInterval`（clearされない） | なし |
| thumbnail | 開/可視復帰 | 20秒（即時＋以降） | 自己再帰 setTimeout | 閉/背景/cleanup |
| todo（キュー） | `queue.start()` | 250ms（空×3/背景×10） | processLoop連鎖 | `queue.stop()` |
| sidebar | 開 | 120秒（**初回も120秒後**） | 自己再帰 setTimeout | 閉/cleanup、restartで再設定 |
| loadingタイムアウト | `startSession()` | 60秒 | 単発 | `finishSession()` |
| autoNextカウントダウン | `scheduleNavigation()` | 1秒×10 | setInterval | キャンセル/完了/stopWatcher |

## AppState 読み書きマップ（要点）

| 状態 | 主な書き込み | 主な読み取り |
|------|------------|------------|
| `sidebar.isOpen` | 初期化 / 開閉ボタン / onChanged | visibility処理・末尾の `restartSidebarUpdate` 判定 |
| `visibility.isVisible` | `handleVisibilityChange` / 初期化 | キューの `getVisibilityState`（processLoop） |
| `update.oneTimeFlag` | 初期true / `startToDoListUpdate` で false | `handleSidebarOpenStateChange` の分岐 |
| `update.isInserting` | `updateSidebar` 前後 | `updateThumbnail`（挿入中スキップ） |
| `loading.updateSession` | Loading系 start/finish | `isLoading()`・更新ボタン・可視処理 |
| `timers.*` | 各 start/stop | `getTimer` による二重起動防止 |
| `autoNext.*` | AutoNextManager 各所 | 多重進入抑止・カウントダウン・cleanup |
