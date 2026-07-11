# 02. アーキテクチャ（Architecture）

## 2.1 設計思想

このコードベースは、もともと1枚の大きなコンテンツスクリプトだったものを、
**責務ごとにモジュール分割**し、**状態を1クラス(`AppState`)に集約**し、
**副作用の強い処理を Manager に切り出した**構成になっています（README/コミット履歴の「処理の効率化」参照）。

キーとなる設計上の約束事:

1. **状態は `AppState` に集約する** — タイマー・オブザーバー・可視状態・ローディング・自動移動状態・
   設定・DOM参照をすべて1インスタンスで持ち、`cleanup()` 一発で後始末できる。
2. **`main.js` は結線役に徹する** — イベント配線と初期化順序の制御が主。
   実処理は Manager / services / render / ui に委譲し、`main.js` 内の関数の多くは「委譲ラッパー」。
3. **I/O は services 層に閉じ込める** — fetch は `services/api.js`、永続化は `services/storage.js`、
   DOM監視(終了検知)は `services/status.js`。
4. **描画は render/ui 層** — DOM生成は `innerHTML` を避け `createElement` ベース（XSS配慮）。
5. **エラーは握りつぶさず `handleError` に集約**（`utils/error.js`）。

## 2.2 レイヤー構成

```
┌──────────────────────────────────────────────────────────────┐
│  entry:  src/main.js                                          │
│  （初期化・イベント配線・各層への委譲。UI状態のブリッジ）        │
└───────────────┬──────────────────────────────────────────────┘
                │ uses
   ┌────────────┼───────────────┬───────────────┬───────────────┐
   ▼            ▼               ▼               ▼               ▼
┌───────┐  ┌──────────┐   ┌──────────┐    ┌──────────┐    ┌──────────┐
│ core  │  │ managers │   │ render   │    │   ui     │    │ handlers │
│AppState│ │Update /  │   │ sidebar  │    │ layout / │    │ options  │
│(状態) │  │Loading / │   │(DOM生成・│    │ sidebar  │    │ Handler  │
│       │  │AutoNext  │   │ サムネ)  │    │ Control  │    │          │
└───────┘  └────┬─────┘   └────┬─────┘    └──────────┘    └──────────┘
                │ uses          │ uses
        ┌───────┴──────────┬────┘
        ▼                  ▼
   ┌──────────┐      ┌──────────┐
   │ services │      │  utils   │
   │ api /    │      │ dom /    │
   │ queue /  │      │ error /  │
   │ status / │      │ sorting  │
   │ storage  │      └──────────┘
   └────┬─────┘
        ▼
  ┌──────────┐
  │  config  │  constants.js（全モジュールが参照する定数・エンドポイント）
  └──────────┘
```

- **debug/apiStats.js** は横断的（`window.apiCallCounter` をグローバルに置き、queue/UpdateManager から書かれる）。

## 2.3 モジュール責務一覧

| モジュール | 責務 | 主なエクスポート |
|-----------|------|----------------|
| `main.js` | エントリ。初期化・イベント配線・各層への委譲・UI状態ブリッジ | （エントリのため export なし） |
| `config/constants.js` | エンドポイントURL・各種間隔/TTL/上限などの定数 | `notifyboxAPI`, `liveInfoAPI`, `sidebarMinWidth`, `maxSaveProgramInfos`, `toDolistsInterval`, `updateThumbnailInterval`, `thumbnail*`, `programInfoTtlMs`, `loadingSessionTimeoutMs` |
| `core/AppState.js` | 全グローバル状態の集約と一括クリーンアップ | `class AppState` |
| `services/api.js` | ニコ生2API の fetch（in-flight 重複排除つき） | `fetchLivePrograms`, `fetchProgramInfo` |
| `services/queue.js` | 番組詳細取得キュー。レート制限・逐次処理・可視状態連動 | `class ProgramInfoQueue` |
| `services/status.js` | watch ページの「番組終了ガイド」検知 | `observeProgramEnd` |
| `services/storage.js` | `chrome.storage.local`（設定）と `localStorage`（番組キャッシュ）の読み書き | `getOptions`, `saveOptions`, `setIsOpenSidebar`, `setSidebarWidth`, `setSidebarTheme`, `getProgramInfos`, `upsertProgramInfo`（`setProgramInfos` は内部専用・未export） |
| `managers/UpdateManager.js` | 更新タイマー3系統＋描画更新の司令塔（サイドバー/サムネ/番組詳細） | `class UpdateManager` |
| `managers/LoadingManager.js` | 更新セッション単位のローディング表示制御（最低表示時間・タイムアウト） | `class LoadingManager` |
| `managers/AutoNextManager.js` | 番組終了時の自動移動（モーダル・カウントダウン・遷移） | `class AutoNextManager` |
| `render/sidebar.js` | 番組カードDOM生成・サムネ更新（コンテナ内全img対象）・サイドバー枠HTML・並べ替えFLIP | `makeProgramElement`, `calculateActivePoint`, `updateThumbnailsFromStorage`, `sortProgramsByActivePoint`, `flipReorder`, `buildSidebarShell`（※`handleThumbnailError` は内部関数、`makeProgramElement` から配線。旧 IntersectionObserver 可視限定は撤去済み） |
| `ui/layout.js` | 視聴ページ本体側の幅調整・サイドバー幅→カラム数計算 | `adjustWatchPageChild`, `setProgramContainerWidth` |
| `ui/sidebarControl.js` | サイドバー開閉・幅ドラッグ・root幅追従 | `createSidebarControl` |
| `handlers/optionsHandler.js` | オプションフォームの初期反映・変更保存・ソート即時反映 | `setupOptionsHandler` |
| `render/animatedThumbnail.js` 🧪 | 動くサムネ（実験・ホバー中のみ）。CORS＋canvas知覚ハッシュで重複排除しblobリングバッファに保持、ホバーで巡回表示 | `setAnimatedThumbnailEnabled`, `teardownAnimatedThumbnails` |
| `services/animFrameStore.js` 🧪 | 動くサムネのフレーム永続化（IndexedDB, blob保存, TTL/件数掃除）。リロード/番組移動をまたいで復元 | `saveFrames`, `loadFrames`, `cleanupFrames` |
| `utils/dom.js` | `debounce` | `debounce` |
| `utils/error.js` | エラー分類・ログ・リトライ戦略 | `handleError`（`ErrorManager`/`ErrorType`/`ErrorLevel` は内部専用・未export） |
| `utils/sorting.js` | 番組リストのソート（新着順=ID降順 / 人気順=active-point） | `sortPrograms` |
| `debug/apiStats.js` | API呼び出し統計（異常頻度の警告・手動確認関数） | `initApiStats`（＋ `window.showApiStats`） |

## 2.4 依存関係グラフ（import 方向）

矢印は「A が B を import する」。

```
main.js
 ├─> config/constants.js
 ├─> utils/dom.js               (debounce)
 ├─> services/storage.js        (getOptions/saveOptions)
 ├─> render/sidebar.js          (buildSidebarShell)
 ├─> ui/sidebarControl.js       (createSidebarControl)
 ├─> ui/layout.js               (adjustWatchPageChild, setProgramContainerWidth)
 ├─> core/AppState.js           (AppState)
 ├─> services/queue.js          (ProgramInfoQueue)
 ├─> managers/LoadingManager.js
 ├─> managers/AutoNextManager.js
 ├─> managers/UpdateManager.js
 ├─> utils/sorting.js           (sortPrograms)
 ├─> debug/apiStats.js          (initApiStats)
 └─> handlers/optionsHandler.js (setupOptionsHandler)

UpdateManager.js
 ├─> services/api.js            (fetchLivePrograms)
 ├─> services/storage.js        (getProgramInfos)
 ├─> render/sidebar.js          (makeProgramElement, calculateActivePoint, updateThumbnailsFromStorage, flipReorder)
 ├─> ui/layout.js               (setProgramContainerWidth)
 ├─> utils/sorting.js           (sortPrograms)
 └─> config/constants.js        (updateThumbnailInterval)

AutoNextManager.js  ─> services/status.js (observeProgramEnd)
queue.js            ─> services/api.js (fetchProgramInfo), services/storage.js (upsertProgramInfo), utils/error.js
api.js              ─> config/constants.js, utils/error.js
storage.js          ─> config/constants.js (maxSaveProgramInfos), utils/error.js
status.js           ─> （import なし。DOM のみ）
sidebar.js          ─> config/constants.js (thumbnail* TTL)
ui/layout.js        ─> （import なし。DOM/localStorage のみ）
ui/sidebarControl.js─> config/constants.js (sidebarMinWidth), services/storage.js (setIsOpenSidebar/setSidebarWidth)
handlers/optionsHandler.js ─> services/storage.js (saveOptions)
utils/sorting.js    ─> render/sidebar.js (sortProgramsByActivePoint)
LoadingManager.js   ─> （import なし。AppState はコンストラクタ注入）
```

> **循環回避のポイント**: Manager 群は `AppState` などを**コンストラクタ経由で注入**され、`main.js` から import する形。
> `AutoNextManager` はサイドバー更新のため `updateSidebar` を呼びたいが、循環依存を避けるため
> **`main.js` が `startWatcher(updateSidebar)` と関数を注入**する方式に統一（✅ 2026-07-11修正。
> 旧実装は `typeof updateSidebar` のグローバル参照でIIFEビルドでは未解決だった → [09-gotchas A](./09-gotchas-and-techdebt.md)）。

## 2.5 主要な状態（AppState）

`AppState` が持つフィールド（詳細は [03-module-reference.md](./03-module-reference.md#coreappstatejs)）:

| グループ | フィールド | 用途 |
|---------|-----------|------|
| `timers` | `thumbnail` / `todo` / `sidebar` / `autoNext` | 各更新タイマーのID（`todo` は文字列 `'queue-managed'` を入れる番兵運用あり） |
| `observers` | `resizeWatchPage` / `resizeSidebar` / `thumbnail` | ResizeObserver 等（thumbnail は sidebar.js が実体を持ち参照のみ） |
| `sidebar` | `width` / `isOpen` | サイドバー幅・開閉状態（UIの真実） |
| `visibility` | `isVisible` | Page Visibility API 由来のタブ可視状態 |
| `update` | `isUpdating` / `pending` / `isInserting` / `oneTimeFlag` / **`settling`** / **`settlingNeedsNewest`** / **`settleAllowNewest`** / **`forceRefetch`** | 更新中・DOM挿入中・初回フラグ。`settling`=整列確定中。`settlingNeedsNewest`=詳細未取得があり新着順で待つ必要があるか。`settleAllowNewest`=新着順への一時退避を許可するか（初回=true/更新ボタン=false）。`forceRefetch`=TTL無視で全詳細を再取得するか（更新ボタン=true） |
| `loading` | `updateSession` | ローディングセッションID（`isLoading()` は `updateSession !== null`。旧 `operations` カウンタは 2026-07-11 整理で削除） |
| `autoNext` | `scheduled` / `canceled` / `selectingNext` / `liveStatusStopper` | 自動移動の進行状態と終了監視の停止関数 |
| `handlers` | `onResize`（＋ 実行時に `reloadBtn` 等が動的追加される） | イベントハンドラ参照 |
| `config` | `options` / `defaultOptions` | 設定（参照保持） |
| `elements` | （動的） | DOM要素参照 |

## 2.6 3つのタイマー系統（心臓部）

サイドバーが開いている間に走る、独立した3つの定期処理。`UpdateManager` が起動・停止する。

| タイマー | 間隔 | 何をするか | 実装 |
|---------|------|-----------|------|
| **sidebar** | `updateProgramsInterval` 秒（既定120） | 通知ボックスAPIで放送中番組リストを再取得し、DOMを差分更新＋ソート | `UpdateManager.startSidebarUpdate` → `updateSidebar` |
| **thumbnail** | `updateThumbnailInterval` 秒（既定20） | localStorageの番組詳細を元にライブサムネを更新（TTL/バックオフ付き） | `UpdateManager.startThumbnailUpdate` → `updateThumbnail` |
| **todo（キュー）** | `processInterval`（0.25秒）＋レート制限4件/秒 | 一覧に載った番組の「詳細」を1件ずつ取得し localStorage に upsert | `ProgramInfoQueue.start` |

- これらは **`handleSidebarOpenStateChange(open)`** で一括起動/停止される。
- **タブがバックグラウンド**になると `thumbnail` は停止、`todo` は間隔10倍で延命（`queue.js`）。
- 詳細な起動〜停止のシーケンスは [04-data-flow.md](./04-data-flow.md)。

## 2.7 データの2段構え

```
① 通知ボックスAPI (fetchLivePrograms)         ② 番組詳細API (fetchProgramInfo)
   └ 放送中番組の「一覧」（id, title, 概要）      └ 番組1件の詳細（providerType, contentOwner,
        │                                              liveScreenshotThumbnailUrls 等）
        ▼                                                    ▲
  即座に番組カードを描画（暫定情報）                キューで1件ずつ取得（レート制限）
        │                                                    │
        └──────────── localStorage(programInfos) にキャッシュ ─┘
                              │
                              ▼
              サムネ更新／active-point再計算／ソートの元データになる
```

- **一覧API**は軽量なので毎回全件取得。**詳細API**は重いのでキュー＋レート制限＋TTL(`programInfoTtlMs`)＋in-flight重複排除。
- localStorage の `programInfos` は最大 `maxSaveProgramInfos`(200) 件で FIFO トリム。

次は各ファイルの詳細 → [03-module-reference.md](./03-module-reference.md)
