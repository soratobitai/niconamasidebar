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
   ┌──────────────────┐   ┌──────────┐
   │ services         │   │  utils   │
   │ api /            │   │ dom /    │
   │ followPageSource │   │ error /  │
   │ status / storage │   │ sorting  │
   └────┬─────────────┘   └──────────┘
        ▼
  ┌──────────┐
  │  config  │  constants.js（全モジュールが参照する定数・エンドポイント）
  └──────────┘
```

- **リスト（並び順）は notifybox API（`services/api.js`）、番組詳細はフォロー中ページの公開フロントJSON API（`services/followPageSource.js`）** という2系統でデータを取得する（§2.7）。

## 2.3 モジュール責務一覧

| モジュール | 責務 | 主なエクスポート |
|-----------|------|----------------|
| `main.js` | エントリ。初期化・イベント配線・各層への委譲・UI状態ブリッジ | （エントリのため export なし） |
| `config/constants.js` | エンドポイントURL・各種間隔/上限などの定数 | `notifyboxAPI`, `liveInfoAPI`（サムネ補完専用）, `watchPageBaseUrl`, `sidebarMinWidth`, `maxSaveProgramInfos`, `updateThumbnailInterval`, `thumbnail*`, `animatedThumbnail*`, `loadingSessionTimeoutMs` |
| `core/AppState.js` | 全グローバル状態の集約と一括クリーンアップ | `class AppState` |
| `services/api.js` | notifybox API の fetch（放送中番組リスト）＋番組詳細API の fetch（サムネ補完専用。ともに in-flight 重複排除つき） | `fetchLivePrograms`, `fetchProgramInfo` |
| `services/followPageSource.js` | フォロー中ページの公開フロントJSON API（`follow/v1/programs?status=onair`）をページングして全件取得し、放送中フォロー番組の詳細を内部 programInfo 形の配列で返す。ライブサムネが空の番組だけ詳細APIで選択的補完 | `fetchFollowedProgramsViaPage`, `mapApiProgramToInfo`（デバッグ用に `window.__testFollowScrape` を配線） |
| `services/status.js` | watch ページの「番組終了ガイド」検知 | `observeProgramEnd` |
| `services/storage.js` | `chrome.storage.local`（設定）と `localStorage`（番組キャッシュ）の読み書き | `getOptions`, `saveOptions`, `setIsOpenSidebar`, `setSidebarWidth`, `setSidebarTheme`, `getProgramInfos`, `upsertProgramInfo`, `upsertProgramInfos`（詳細API取得の全件を一括書き戻し。`setProgramInfos` は内部専用・未export） |
| `managers/UpdateManager.js` | 更新タイマー2系統（サイドバー/サムネ）＋描画更新の司令塔。リスト＝notifybox・詳細＝フロントJSON APIを並列取得して描画 | `class UpdateManager` |
| `managers/LoadingManager.js` | 更新セッション単位のローディング表示制御（最低表示時間・タイムアウト） | `class LoadingManager` |
| `managers/AutoNextManager.js` | 番組終了時の自動移動（モーダル・カウントダウン・遷移） | `class AutoNextManager` |
| `render/sidebar.js` | 番組カードDOM生成・サムネ更新（コンテナ内全img対象）・サイドバー枠HTML・並べ替えFLIP | `makeProgramElement`, `calculateActivePoint`, `updateThumbnailsFromStorage`, `sortProgramsByActivePoint`, `flipReorder`, `buildSidebarShell`, `resolveLiveThumbnailBaseUrl`（provider別のライブサムネURL選定＝`computeNext`/`animatedThumbnail` 共用の純関数。※`handleThumbnailError` は内部関数、`makeProgramElement` から配線。旧 IntersectionObserver 可視限定は撤去済み） |
| `ui/layout.js` | 視聴ページ本体側の幅調整・サイドバー幅→カラム数計算 | `adjustWatchPageChild`, `setProgramContainerWidth` |
| `ui/sidebarControl.js` | サイドバー開閉・幅ドラッグ・root幅追従 | `createSidebarControl` |
| `handlers/optionsHandler.js` | オプションフォームの初期反映・変更保存・ソート即時反映 | `setupOptionsHandler` |
| `render/animatedThumbnail.js` 🧪 | 動くサムネ（実験・ホバー中のみ）。CORS＋canvas知覚ハッシュで重複排除しblobリングバッファに保持、ホバーで巡回表示 | `setAnimatedThumbnailEnabled`, `teardownAnimatedThumbnails` |
| `services/animFrameStore.js` 🧪 | 動くサムネのフレーム永続化（IndexedDB, blob保存, TTL/件数掃除）。リロード/番組移動をまたいで復元 | `saveFrames`, `loadFrames`, `cleanupFrames` |
| `utils/dom.js` | `debounce` | `debounce` |
| `utils/error.js` | エラー分類・ログ・リトライ戦略 | `handleError`（`ErrorManager`/`ErrorType`/`ErrorLevel` は内部専用・未export） |
| `utils/sorting.js` | 番組リストのソート（新着順=notifybox APIの並び順(=放送開始が新しい順)を保持 / 人気順=active-point） | `sortPrograms` |

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
 ├─> managers/LoadingManager.js
 ├─> managers/AutoNextManager.js
 ├─> managers/UpdateManager.js
 ├─> utils/sorting.js           (sortPrograms)
 ├─> services/followPageSource.js (副作用importのみ＝window.__testFollowScrape 配線)
 └─> handlers/optionsHandler.js (setupOptionsHandler)

UpdateManager.js
 ├─> services/api.js              (fetchLivePrograms)
 ├─> services/followPageSource.js (fetchFollowedProgramsViaPage)
 ├─> services/storage.js          (getProgramInfos, upsertProgramInfos)
 ├─> render/sidebar.js            (makeProgramElement, calculateActivePoint, updateThumbnailsFromStorage)
 ├─> ui/layout.js                 (setProgramContainerWidth)
 ├─> utils/sorting.js             (sortPrograms)
 └─> config/constants.js          (updateThumbnailInterval, watchPageBaseUrl)

AutoNextManager.js    ─> services/status.js (observeProgramEnd)
followPageSource.js   ─> utils/error.js (handleError), services/api.js (fetchProgramInfo＝サムネ補完)
api.js                ─> config/constants.js (notifyboxAPI, liveInfoAPI), utils/error.js
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
| `timers` | `thumbnail` / `sidebar` / `autoNext` | 各更新タイマーのID |
| `observers` | `resizeWatchPage` / `resizeSidebar` / `thumbnail` | ResizeObserver 等（thumbnail は sidebar.js が実体を持ち参照のみ） |
| `sidebar` | `width` / `isOpen` | サイドバー幅・開閉状態（UIの真実） |
| `visibility` | `isVisible` | Page Visibility API 由来のタブ可視状態 |
| `update` | `isUpdating` / `pending` / `isInserting` | 更新中・DOM挿入中フラグ。詳細がリストと同時（フロントJSON APIで一括）に届くため、「詳細が揃うまで新着順で待つ」整列確定機構（旧 `settling`/`forceRefetch` 等）は不要になり削除済み |
| `loading` | `updateSession` | ローディングセッションID（`isLoading()` は `updateSession !== null`。旧 `operations` カウンタは 2026-07-11 整理で削除） |
| `autoNext` | `scheduled` / `canceled` / `selectingNext` / `liveStatusStopper` | 自動移動の進行状態と終了監視の停止関数 |
| `handlers` | `onResize`（＋ 実行時に `reloadBtn` 等が動的追加される） | イベントハンドラ参照 |
| `config` | `options` / `defaultOptions` | 設定（参照保持） |
| `elements` | （動的） | DOM要素参照 |

## 2.6 2つの更新ループ＋自動移動（心臓部）

サイドバーが開いている間に走る、独立した定期処理。`UpdateManager` が sidebar/thumbnail の
2ループを、`AutoNextManager` が自動移動の終了監視を起動・停止する。

| タイマー | 間隔 | 何をするか | 実装 |
|---------|------|-----------|------|
| **sidebar** | `updateProgramsInterval` 秒（既定120／設定60・120・180） | notifybox（リスト）とフォロー中ページの公開フロントJSON API（詳細）を**並列取得**し、詳細を storage へ upsert してから DOM を差分更新＋ソート | `UpdateManager.startSidebarUpdate` → `updateSidebar` |
| **thumbnail** | `updateThumbnailInterval` 秒（既定20） | 保存済みの安定ライブサムネURL＋キャッシュバスターで各 `<img>` を更新する（**番組ごとのネットワーク詳細取得はしない**）。動くサムネ②もここでプリロードした画像から給餌 | `UpdateManager.startThumbnailUpdate` → `updateThumbnail` |
| **autoNext**（自動移動） | イベント駆動 | 視聴中番組の終了を DOM 監視し、条件を満たせばモーダル→カウントダウン→次番組へ遷移。変更なし | `AutoNextManager.startWatcher` → `observeProgramEnd` |

- sidebar/thumbnail は **`handleSidebarOpenStateChange(open)`** で一括起動され、閉じると `stopAllTimers()` で停止する。
- **タブがバックグラウンド**になると sidebar ループはその周期をスキップ（`isVisible()` ガード）し、可視復帰時に `visibilitychange` ハンドラが `performManualUpdate` で取り直す。thumbnail もタブ非表示時は動かない。
- 旧「番組詳細取得キュー（todo）」「新番組の早期検知スキャン（newProgramScan）」は撤去済み。詳細はリストと同時にフロントJSON APIで（通常1リクエストで）揃うため、逐次キューや早期検知ポーリングは不要になった。
- 詳細な起動〜停止のシーケンスは [04-data-flow.md](./04-data-flow.md)。

## 2.7 データの2系統（リスト＝notifybox API／詳細＝フロントJSON API）

```
① notifybox API (fetchLivePrograms)            ② フォロー中ページの公開フロントJSON API
   └ 放送中番組の「一覧」＝並び順               (fetchFollowedProgramsViaPage)
        │  （id, title）                          └ 放送中フォロー番組の詳細をページングして全件
        │                                            （視聴者数/コメント/ライブサムネURL/
        │                                              providerType/会員限定/開始時刻）
        │                                                    │
        │                                     ライブサムネが空の番組だけ詳細APIで選択的補完
        │                                        (fillMissingLiveThumbnails)
        │                                                    │
        │                              upsertProgramInfos で localStorage(programInfos) へ全件書き戻し
        │                                                    │
        └──────────────┬─────────────────────────────────────┘
                        ▼  （updateSidebar 内で Promise.all の並列取得）
       upsert 後の storage を読み、詳細込みでカードを生成 → programsSort でソート
                        │  （初回描画から人気度＝active-point が確定。整列確定＝settling 不要）
                        ▼
              サムネ更新／active-point計算／ソートの元データになる
```

- **リスト**は notifybox（軽量）で毎周期全件取得。**詳細**はフォロー中ページが「もっと見る」で叩く公開フロントJSON API `GET follow/v1/programs?status=onair&offset=<0始まりページ番号>&limit=100`（`credentials: include`／応答 `{ data: { programs: [...], total: N } }`）を呼び、`mapApiProgramToInfo` で内部 programInfo 形へ写像して全番組ぶんを入手。従来「1番組=詳細API×N＋レート制限キュー」だったものを JSON API 呼び出しに置換した。SSR HTML／`embedded-data` の DOMParser パースは廃止済み。
- **ページング実装済み**: `fetchFollowedProgramsViaPage` は `offset=0,1,2,…`（`offset` は0始まりのページ番号。ページ N は `items[N*limit .. N*limit+limit)`）とページを進め、id で重複排除しつつ `total` まで蓄積する（安全上限 `MAX_PAGES=5`）。通常は `limit=100` で放送中フォロー（<100件）を1リクエストで賄い、**同時放送中が100件を超えても全番組の詳細が揃う**（タイトルのみカードで最下部に落ちる、という旧制限は解消）。
- **サムネ＋詳細APIによる選択的フォールバック**: フロントJSON APIは `listingThumbnail` 1枠のみを返す。配信者が固定画像を設定していると `listingThumbnail` はその固定画像で、当拡張はライブスクショだけ表示する（`isLiveScreenshotUrl` フィルタ）ため、そうした番組は `thumbnailUrl=''` になる。ライブサムネが空の番組（固定画像配信者、または放送直後で未生成）だけ `fillMissingLiveThumbnails` が番組詳細API `fetchProgramInfo` を叩いて `liveScreenshotThumbnailUrls` を補完する。空の少数（通常0〜数件）にのみ・1サイクル `MAX_DETAIL_FALLBACK=30` 件を上限に走らせ、旧方式の「全番組×詳細API」の重さは意図的に避ける。
- **フォールバックなし（リスト詳細本体）**: フロントJSON APIの取得が失敗した周期は、その周だけ詳細が古い/欠けるだけで、旧「全番組×詳細API」へは戻さない（意図的）。ただし `updateSidebar` の番組ごと try/catch と `makeProgramElement` 内の `String(id)` 強制で**クラッシュはしない**。
- localStorage の `programInfos` は最大 `maxSaveProgramInfos`(200) 件で FIFO トリム。

次は各ファイルの詳細 → [03-module-reference.md](./03-module-reference.md)
