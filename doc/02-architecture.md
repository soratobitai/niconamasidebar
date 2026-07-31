# 02. アーキテクチャ（Architecture）

## 2.1 設計思想

このコードベースは、もともと1枚の大きなコンテンツスクリプトだったものを、
**責務ごとにモジュール分割**し、**状態を1クラス(`AppState`)に集約**し、
**副作用の強い処理を Manager に切り出した**構成になっています（README/コミット履歴の「処理の効率化」参照）。

キーとなる設計上の約束事:

1. **状態は「寿命」と「読み手の広さ」で置き場所を決める**（2026-07-29 改訂）

   > 旧原則は「状態は `AppState` に集約する」だった。しかし**実測すると実装の約1/3にしか当てはまっておらず**、
   > 2026-07-29 の改修では更新ループ2本を**意図的に `AppState` の外へ出した**（下記の理由）。
   > 原則と実装が逆を向いた状態は、読む人に誤った判断をさせるため書き直した。

   **1箱に集めること自体は目的ではない。** 次の3分類に従うこと。

   | 置き場所 | 条件 |
   |---|---|
   | **`AppState`** | モジュールをまたいで読まれる **かつ** ページ離脱時に確実に解放したいもの |
   | **Manager / モジュールが自前で持つ** | その所有者しか読まないもの、および**外部から一括破棄されると復旧できないループ制御** |
   | **DOM / dataset** | カード1枚ごとに紐づき、カードと寿命を共にするもの |

   **`AppState` に置く場合**（例: `sidebar.isOpen`・`loading.updateSession`・`timers.autoNext`・
   `observers.resize*`・`handlers.onResize`・`autoNext.liveStatusStopper`）

   `AppState` の一括API（`clearAllTimers` / `disconnectAllObservers` / `cleanup`）は
   **「名前を舐めて無条件に殺す」意味論しか持たない**。載せてよいのは
   **外部から一方的に殺されても壊れないもの**だけである。

   > 🔴 **同じ事象に属する状態は、全部載せるか全部載せないかのどちらかにする。**
   > 一部だけ載せると「タイマーだけ殺されてフラグとDOMが取り残される」破綻になる。
   > 実例: 閉じた時の `stopAllTimers` が `timers.autoNext` だけを殺し、`autoNext.scheduled` と
   > 自動移動モーダルが残って**そのページで自動移動が二度と動かなくなっていた**（doc/09 項目AF）。

   **Manager が自前で持つ場合**（例: `UpdateManager._sidebarLoop*` / `_thumbLoop*` /
   `_thumbDueAt` / `_sidebarNextDueAt`、`LoadingManager.sessionTimeoutTimer`、
   `animatedThumbnail` の `buffers` / `enabled`）

   更新ループ2本を `AppState.timers` に載せると `cleanup` から外部に殺され、
   **閉じた瞬間に復活不能**になる。だから外に出した。その代わり所有者には義務がある。

   - **`destroy()` 相当を公開し、`main.js` の `cleanup()` から明示的に呼ぶ**
     （「`AppState` に無いから解放されない」を許さないための対価）
   - **破棄を片道にしない。** `beforeunload` / `pagehide` は**ページが生き残る場合がある**
     （bfcache 復帰・遷移キャンセル）。再武装できる入口を必ず1つ用意する
   - **「停止中」は期限やカウンタごと止める。** 素通りさせるだけだと期限が過去のまま残り、
     遅延0の再スケジュールが連鎖する（実例: 閉じている間 `_thumbTick` が素通り →
     `_thumbNextDelayMs()` が 0 を返し続け、**実測 2秒で180回**の暴走。doc/09 項目AE）

   **DOM / dataset に置く場合**（例: `active-point`・`data-api-index`・
   `img.dataset.key / lastSuccessAt / errors / nextTryAt / thumbLive`）

   **同じ事実を JS 側にも持たないこと。** 二重管理になった瞬間、カードの作り直しで片方だけ失われる。

1-b. **同じ事実を2箇所に置かない。置くなら「正」を1つ明示する。**

   現状 `sidebarWidth` は3箇所、開閉状態は3箇所、更新セッションは3箇所
   （`AppState` / `LoadingManager` / 更新ボタンの `loading` クラス）に複製されている。
   新たに複製を増やすなら、**正がどれで、他はどの経路でいつ追従するのか**をここに書くこと。
   書けないなら複製してはならない。

1-c. **`AppState` に「とりあえず置く」を禁止する。読み手が現れるまでフィールドを作らない。**

   `update.isUpdating` / `update.pending` / `observers.thumbnail` / `config.*` / `elements` は
   **読み手ゼロのまま残り**、「更新中フラグはどこにあるのか」を探す時間を恒常的に奪っていた
   （2026-07-29 に削除）。
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
   │ status / storage │   │ sorting /│
   │                  │   │programOrder│
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
| `utils/programOrder.js` | **並び順の比較器の唯一の定義**。実際に並べ替える処理と「並べ替えが要るか」の判定が同じ比較器を使う（食い違うと全カードが毎周期スライドする／doc/09 AR） | `compareByActivePoint`, `compareByApiIndex`, `orderComparator` |
| `utils/sorting.js` | 番組リストのソート（新着順=`beginAt` 降順＝`data-api-index` 昇順 / 人気順=active-point）。比較器は `programOrder.js` から取る | `sortPrograms` |

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
 ├─> services/storage.js          (getProgramInfos, upsertProgramInfos, patchProgramThumbnail)
 ├─> render/sidebar.js            (makeProgramElement, calculateActivePoint, updateThumbnailsFromStorage)
 ├─> ui/layout.js                 (setProgramContainerWidth)
 ├─> utils/sorting.js             (sortPrograms)
 └─> config/constants.js          (updateThumbnailInterval, watchPageBaseUrl, newProgramFastPollMs)

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
| `timers` | `autoNext` **のみ** | 自動移動のカウントダウンID。**更新ループ2本は入っていない**（どちらも UpdateManager が内部で持つ。ここに置くと stopAllTimers/cleanup が外から殺す／doc/09 AB-2） |
| `observers` | `resizeWatchPage` / `resizeSidebar` | ResizeObserver 等（`thumbnail` は読み手ゼロだったため 2026-07-29 に削除） |
| `sidebar` | `width` / `isOpen` | サイドバー幅・開閉状態（UIの真実） |
| `update` | `isInserting` **のみ** | DOM差し替え中フラグ（`isUpdating` / `pending` は読み手ゼロだったため 2026-07-29 に削除）。詳細がリストと同時（フロントJSON APIで一括）に届くため、「詳細が揃うまで新着順で待つ」整列確定機構（旧 `settling`/`forceRefetch` 等）は不要になり削除済み |
| `loading` | `updateSession` | ローディングセッションID（`isLoading()` は `updateSession !== null`。旧 `operations` カウンタは 2026-07-11 整理で削除） |
| `autoNext` | `scheduled` / `canceled` / `selectingNext` / `liveStatusStopper` | 自動移動の進行状態と終了監視の停止関数 |
| `handlers` | `onResize`（＋ 実行時に `reloadBtn` 等が動的追加される） | イベントハンドラ参照 |


## 2.6 2つの更新ループ＋自動移動（心臓部）

サイドバーが開いている間に走る、独立した定期処理。`UpdateManager` が sidebar/thumbnail の
2ループを、`AutoNextManager` が自動移動の終了監視を起動・停止する。

| タイマー | 間隔 | 何をするか | 実装 |
|---------|------|-----------|------|
| **sidebar** | `updateProgramsInterval` 秒（既定120／設定30・60・120・180） | notifybox（リスト）とフォロー中ページの公開フロントJSON API（詳細）を**並列取得**し、詳細を storage へ upsert してから DOM を差分更新＋ソート | `UpdateManager._sidebarTick`（常設ループ） → `updateSidebar` |
| **thumbnail** | 番組ごとに独立（基準 `updateThumbnailInterval` 秒＝既定20＋その回の作業時間） | **常設ループ1本**（`_thumbLoopTimer`）＋番組ごとの期限表（`_thumbDueAt` Map: id→次に更新してよい時刻）。`_thumbTick` が期限の来た1件を更新し、**完了してから** 20秒先へ期限を置き直す＝周期20秒＋作業時間で自然ドリフト。起動は setup で1回（`startThumbnailLoop`）、停止はページ離脱のみ（`destroyThumbnailLoop`）。**サイドバーを閉じても止まらず、tick が素通りする**。空＆若い（放送開始から `newProgramFastPollMs`=3分以内）user番組だけ各サイクルで詳細APIを1回追撃（`_fetchLiveThumbIfPendingYoung`）。動くサムネ②もここでプリロードした画像から給餌 | `UpdateManager.startThumbnailLoop` → `_refreshThumbSchedule` → `_thumbTick` |
| **autoNext**（自動移動） | イベント駆動 | 視聴中番組の終了を DOM 監視し、条件を満たせばモーダル→カウントダウン→次番組へ遷移。変更なし | `AutoNextManager.startWatcher` → `observeProgramEnd` |

- **2ループとも開閉で起動/停止しない。** どちらも setup で1回だけ開始する常設ループで、閉じている間は tick が `isOpen` を見て素通りする（doc/09 AB-2・AE）。停止するのはページ離脱時（`cleanup` → `destroySidebarLoop` / `destroyThumbnailLoop`）だけ。`stopAllTimers()`（サイドバー閉）が触るのは**自動移動のキャンセルだけ**。
- **タブの可視/非表示によるガードは無い**（655df9c で `visibilitychange` ハンドラ・可視ゲート・AppState の visibility 状態をすべて撤去）。サイドバーが開いている間、**sidebar ループは裏タブでもリスト取得を続ける**。thumbnail だけは非表示中は画像更新を行わず次の期限だけ置き直す（`document.hidden` 中は rAF が止まり `onSettled` が来ないため。可視復帰後は通常サイクルへ戻り、一斉更新は `performManualUpdate` が担う）。
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
        │                                        (fillMissingDetails)
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
- **サムネ＋詳細APIによる選択的フォールバック**: フロントJSON APIは `listingThumbnail` 1枠のみを返す。配信者が固定画像を設定していると `listingThumbnail` はその固定画像で、当拡張はライブスクショだけ表示する（`isLiveScreenshotUrl` フィルタ）ため、そうした番組は `thumbnailUrl=''` になる。ライブサムネが空の番組（固定画像配信者、または放送直後で未生成）だけ `fillMissingDetails` が番組詳細API `fetchProgramInfo` を叩いて `liveScreenshotThumbnailUrls` を補完する。空の少数（通常0〜数件）にのみ・1サイクル `MAX_DETAIL_FALLBACK=30` 件を上限に走らせ、旧方式の「全番組×詳細API」の重さは意図的に避ける。
- **フォールバックなし（リスト詳細本体）**: フロントJSON APIの取得が失敗した周期は、その周だけ詳細が古い/欠けるだけで、旧「全番組×詳細API」へは戻さない（意図的）。ただし `updateSidebar` の番組ごと try/catch と `makeProgramElement` 内の `String(id)` 強制で**クラッシュはしない**。
- localStorage の `programInfos` は最大 `maxSaveProgramInfos`(200) 件で FIFO トリム。

次は各ファイルの詳細 → [03-module-reference.md](./03-module-reference.md)
