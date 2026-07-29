# 04. データフロー & ライフサイクル

コンテンツスクリプト注入 → 初期化 → 番組リスト取得（notifybox）＋番組詳細取得（フォロー中ページの公開フロントJSON API）→ 描画 → 定期更新 → 自動移動 までを
実コードに基づいて番号付きでトレース。行番号は現時点のもの（`src/main.js` 等）。

> このドキュメントは「**いつ・何が・どの順で**動くか」を追うための地図です。関数の中身は [03-module-reference.md](./03-module-reference.md)、外部I/Oは [05-external-api.md](./05-external-api.md) を併読。
>
> **データ取得の役割分担（現行）**: **リスト（並び順の元）= notifybox API**（`fetchLivePrograms`）／**番組詳細（視聴者数・コメント・ライブサムネURL・配信者・会員限定・開始時刻）= フォロー中ページの公開フロントJSON API をページングして全件取得**（`fetchFollowedProgramsViaPage`）。詳細は `updateSidebar` 内でリストと**並列取得**して `localStorage` へ一括 upsert され、カード生成時点で人気度（active-point）が確定している。→ 「1番組=詳細API×N＋レート制限キュー」だった旧方式（`ProgramInfoQueue`）と、詳細が揃うまで新着順で待つ**整列確定（settling）機構**は撤去済み。詳細API(`liveInfoAPI`)自体は**空サムネ番組の補完のためだけに残存**（下記フェーズ4）。

---

## フェーズ0: 注入タイミングと前提

- `manifest.json`: `run_at:"document_start"` で `main.js`（ビルド後 `dist/main.js`）と `style.css` を `watch/*` に注入。
- したがって `main.js` は **DOM未構築の非常に早い段階**で評価され、実処理は `DOMContentLoaded` を待つ。
- 中核状態は `AppState` インスタンス `appState`、永続化は `chrome.storage.local`（設定）＋ `localStorage.programInfos`（番組キャッシュ）。

## フェーズ1: モジュール即時実行（`main.js` load 時）

`main.js` トップレベルで即時に:
1. `appState = new AppState()`（全状態を初期値生成。`updateSession=null`, `sidebar.width=360`, `isOpen=false`）
2. `defaultOptions` 定義、`appState.config`/`elements` に参照接続。
3. `localStorage.programInfos` が無ければ `'[]'` 初期化。
4. 画像URLを `chrome.runtime.getURL` で解決。
5. `followPageSource.js` を副作用インポート（`window.__testFollowScrape()` を実ページのConsoleから叩けるよう登録。中身はJSON API経路を実行して件数＋表を出す）。
6. `DOMContentLoaded` リスナ登録／`chrome.storage.onChanged` リスナ登録。

> この段階では**定期処理は一切動かない**（初期化系はすべて `DOMContentLoaded`→`setup` 経路で起動する）。番組リスト/サムネのタイマーも未起動。

## フェーズ2: 初期化（`DOMContentLoaded` → `setup()`）

7. `?popup=on` なら**即 return**（別窓くん対応）。ここで抜けると以降の初期化・タイマーは一切走らない（＝別窓では常時コストゼロ）。
8. `options = await getOptions()` … `chrome.storage.local.get` → defaults とマージ → **書き戻し** → `appState.sidebar.width/isOpen` に反映。
9. `setElems()` でニコ生既存DOMを収集 → `#root` 不在なら return。
10. `isSetupCompleted` で二重防止。
11. **`setup()`**（以降 `isSetupCompleted=true`）。

### setup() の配線（順序が重要）
12. `applyTheme(options.sidebarTheme)` … サイドバー挿入前にテーマ（ダーク/ライト）を body クラスへ適用（初回ちらつき回避）。
13. `await insertSidebar()` … `buildSidebarShell` の結果を `body` 先頭に注入、`#optionContainer`（設定）を `.sidebar_body` 内へ配置、`body{position:relative;display:flex}`・`#root{flex-grow:1}` を破壊的設定。
14. `reflectOptions()` → `setupOptionsHandler`（ラジオ初期反映＋`#optionForm` change リスナ登録）。
15. **Manager 3種を生成**（`LoadingManager`, `AutoNextManager`, `UpdateManager`）。← insertSidebar の後でないとDOM参照が取れない。
16. `adjustWatchPageChild(elems)` でニコ生本体の幅調整。
17. resize系配線: `window.resize`(debounce30ms) / `ResizeObserver`×2（watchPage幅・sidebar幅）/ theaterボタン click。
18. `#reload_programs` click → `isLoading()` なら無視、else `performManualUpdate()`。
19. `#theme_toggle` click → テーマ切替（`applyTheme`＋`setSidebarTheme` で保存）。
20. `#setting_options`（サイドバー内で番組リスト⇄設定を入れ替え表示）open/close/Escリスナ群。
21. `#sidebar_button` click → `toggleSidebar()` → `handleSidebarOpenStateChange()` → rAF2段でレイアウト再計算。`enableSidebarLine()` でドラッグ有効化。

### 初期開閉の分岐（心臓部）
22. `shouldOpenAtStart = (autoOpen=='1') || (autoOpen=='3' && isOpenSidebar)`
    - **開く**: UIを即 `openSidebar()` → rAF2段でレイアウト → **`setTimeout(()=>handleSidebarOpenStateChange(true), 300)`**（データ取得は300ms遅延＝初期ページ描画を妨げない）。← **初回データ取得の実質トリガ**
    - **閉じる**: `closeSidebar()` → `handleSidebarOpenStateChange(false)` → `stopAllTimers()`（**閉じている間はタイマーもデータ取得も走らない**）。
23. `autoNextProgram==='on'` なら `startLiveStatusWatcher()`（→ フェーズ7）。
24. 動くサムネ②の給餌配線（`setAnimThumbnailFeed`）＋ON/OFF反映（`setAnimatedThumbnailEnabled`）。
25. `beforeunload`/`pagehide` → `cleanup`、`visibilitychange` → `handleVisibilityChange`（→ フェーズ6）。

## フェーズ3: 初回データ取得（サイドバーが開いている時のみ）

26. **`handleSidebarOpenStateChange(true)`**:
    1. なければ `startThumbnailUpdate()`（フェーズ5.1／番組ごとの自己連鎖タイマーを起動）
    2. `resetSidebarSchedule()` で次回取得の期限を「今から1周期後」に置き直す（常設ループは起動時から回っている／フェーズ5.2）
    3. rAF内で `await performManualUpdate()`（初回・手動・再オープン・可視復帰いずれも同じ経路。専用の初回ロード関数は無い）
    4. rAF不発（非アクティブタブ等）に備え `setTimeout(100ms)` フォールバックでも `performManualUpdate()`。
27. **`performManualUpdate()`**（→ フェーズ8と同一実装）:
    1. 多重防止フラグ `isPerformingManualUpdate` で二重取得を抑止。
    2. `await updateSidebar()`（フェーズ4）… リスト＝notifybox と 詳細＝フォローAPI（ページング）を**並列取得**し、詳細を storage へ upsert してからカードを組む。**詳細が揃った状態で描画・ソートするので、初回の1回目の描画から `programsSort`（人気順/新着順）で正しく並ぶ**。
    3. `await updateThumbnail(true)`（サムネ強制反映。保存済みURL＋キャッシュバスター）
    4. `finishSessionWithMinDuration(1000)`（最低1秒ローディング表示＝更新ボタンのスピナー）
    5. 開いていれば `resetSidebarSchedule()`

> ✅ **人気順のガチャつき（settling）機構は撤去**: 旧方式は詳細を後追いキューで取るため「詳細が揃うまで新着順で表示 → 確定後に人気順へFLIPで並べ替え」という整列確定処理（`settling`/`performInitialLoad`/`flipReorder`）が必要だった。現行は詳細がリストと**同時に**storage へ載るので、**最初から `programsSort` で確定描画**でき、退避表示も再ソートも不要。
> ⚠️ 初回ロード専用の分岐（`oneTimeFlag`/`startToDoListUpdate`）は無くなり、開/手動/再オープン/可視復帰はすべて `performManualUpdate` に一本化された。

## フェーズ4: 番組リスト取得 & 描画（`updateSidebar()`）

初回・手動・定期・自動移動の**全経路から呼ばれる中核**。
28. `loadingManager.startSession()`（`.loading`表示＋60秒タイムアウト設定）
29. **`Promise.all` でリストと詳細を並列取得**:
    - `getLivePrograms(100)` … `fetchLivePrograms`（notifybox／`credentials:'include'`／in-flight重複排除）。返り値は `notifybox_content` 配列（`{id: bare番号, title}` 等）＝**並び順の元**。取得成否で `#api_error` を `none`/`block`（ログイン誘導）。
    - `_refreshDetailsViaScrape()`（メソッド名は据え置き。実体はスクレイプではなくJSON API取得）… `fetchFollowedProgramsViaPage()` が **フォロー中ページの公開フロントJSON API**（`GET .../front/api/pages/follow/v1/programs?status=onair&offset=<0始まりページ番号>&limit=100`、`credentials:'include'`、応答 `{ data: { programs, total } }`）を **`offset=0,1,2,…` とページングループ**して放送中フォロー番組の**全詳細**を得て `upsertProgramInfos()` で `localStorage.programInfos` へ一括 upsert（`_fetchedAt` 付与）。各番組は `mapApiProgramToInfo()` で内部 programInfo 形へ写像（`beginAt`(ms)→`onAirTime.beginAt` ISO ／ `watchCount`→viewers ／ `commentCount`→comments ／ providerType `community`→`'user'`）。失敗時（未ログイン/仕様変更/通信エラー）は何もしない＝その周は詳細が古いまま（**フォールバックしない**）。
30. **失敗系は既存DOM維持**: `livePrograms` が `false`（notifybox失敗）も `length===0`（空）も再構築せずカウントだけ更新して return。`#api_error` 表示は `false` の時のみ。
31. **詳細 upsert 後の storage を読む**（`getProgramInfos()`）→ リスト各番組を `lv{id}` で突き合わせ。
    - 既存カードは**軽量更新**（active-point/`data-api-index`/title/link）、新規は `makeProgramElement`（詳細が有れば `data`、無ければ notifybox の `program` で生成）。
    - **1番組ごとに try/catch**: 詳細が取得結果に無い番組（`MAX_PAGES=5`＝最大500件の安全上限超過や、フォローAPI取得失敗）で不正データを踏んでも、その番組だけスキップしてリスト全体は描画する（`makeProgramElement` の `String(id)` 強制と併せ、サイドバー全体が空/クラッシュしない防御）。
    - キュー投入（旧 `programInfoQueue.add`）やTTLスキップは**無い**（詳細はフォローAPIで毎周まとめて更新される）。
32. `isInserting=true` → `replaceChildren(frag)`
33. `sortProgramsInContainer(container)` → `sortPrograms(container, programsSort)`（active=人気順 / newest=API順＝notifyboxの放送開始が新しい順）。**詳細が揃っているので最初から確定ソートできる**。
34. `setProgramContainerWidth`（幅は「意図した幅」`appState.sidebar.width` で決定）→ `updateProgramCount` → `isInserting=false`

> ✅ **ページングは実装済み**: `fetchFollowedProgramsViaPage()` は `offset=0,1,2,…`（`offset` は0始まりのページ番号。ページNは全体の `[N*limit .. N*limit+limit)`）とループし、`total` に達するまで番組を id で重複排除しつつ蓄積する。安全上限 `MAX_PAGES=5`（＝最大500件）。通常は `limit=100` で1リクエストで足りる（同時放送中フォローが100件未満）が、**100件を超えるユーザーでも全番組の詳細が揃う**（旧「約70件超はタイトルのみ・末尾落ち」の制限は解消）。`MAX_PAGES` 超過分のみ詳細無しになり得るが、その場合も上記の番組ごと try/catch と `String(id)` 強制でクラッシュしない。
>
> 🖼️ **空サムネの詳細API補完（選択的フォールバック）**: フォローAPIはサムネを `listingThumbnail` の1枠しか返さない。配信者が固定画像を設定していると `listingThumbnail` はその固定画像であり、当拡張は**ライブスクショのみ表示**する方針（`isLiveScreenshotUrl` フィルタ）なのでそれらは `thumbnailUrl=''` になる。ライブサムネが空の番組（固定画像配信者／放送直後で未生成）だけ、`fillMissingLiveThumbnails()` が**番組ごとの詳細API** `fetchProgramInfo()`（`liveInfoAPI = https://api.cas.nicovideo.jp/v1/services/live/programs/lv{id}`）を叩いて `liveScreenshotThumbnailUrls` を補完する。**空の少数（通常0〜数件）だけ**・1サイクル上限 `MAX_DETAIL_FALLBACK=30`。旧方式の「全番組×詳細API」の重さは意図的に避けたまま、穴だけ埋める。

## フェーズ5: 2系統の定期タイマー

`handleSidebarOpenStateChange(true)` で起動、`stopAllTimers()`（閉/cleanup）で停止。詳細取得キュー（旧 `todo`）は撤去され、タイマーは `thumbnail` と `sidebar` の2系統になった。

### 5.1 thumbnail（番組ごとの独立・自己連鎖タイマー。基準20秒＋作業時間）
35. `startThumbnailUpdate()` … 番組ごとの独立・自己連鎖タイマー方式を起動する。`appState.timers.thumbnail` にはセンチネル `true` だけを立て（二重開始ガード/停止フック用。実タイマーは `_thumbTimers` Map: id→timeoutId）、`_syncThumbTimers()` が各カードにサイクルを配る。
    - **1サイクル `_runThumbCycle(id)`**: 空＆若い番組なら詳細API追撃（`_fetchLiveThumbIfPendingYoung`。A1統合）→ その番組の `<img>` を1件更新し画像の読み込み完了を待つ（`_updateOneThumbnailAndWait`。`updateThumbnailsFromStorage` の **`onSettled`** シグナルで検知）→ `updateThumbnailInterval`(20秒)後に次サイクルを張る自己連鎖。**周期＝20秒＋その回の作業時間**なので、読み込み時に一斉に始まっても少しずつ自然にズレる（ドリフト＝一斉切替を避けるUX要望）。
    - `updateThumbnail` は `isInserting` 中スキップ → `getProgramInfos()` → `updateThumbnailsFromStorage`。**保存済みの安定したライブサムネURL＋キャッシュバスターで `<img>` を差し替えるだけ**（`onlyIds` でその番組だけ）。定期の全件 `updateThumbnail()` 呼び出しは撤去（一斉感を無くすため。読み込み時の一斉更新は `performManualUpdate` が担う）。
    - TTL10秒・失敗時指数バックオフ（2s〜60s）、`new Image()` プリロード成功時のみ差し替え（フリッカ防止）。動くサムネ②もここでプリロードした画像から給餌される。画像がハングしても基準間隔の2倍で安全にタイムアウトして前進。
    - **A1（空サムネのライブサムネ追撃）は各サイクルに統合**（`_fetchLiveThumbIfPendingYoung`）。user・非会員・ライブサムネ空かつ `onAirTime.beginAt` が `newProgramFastPollMs`=3分以内の若い番組だけ、そのサイクル内で詳細API(`fetchProgramInfo`)を1回追撃し、取れたら `patchProgramThumbnail` でサムネ欄だけをマージ更新。3分超の空番組は追撃せずスクレイプ `fillMissingDetails`（60〜180秒）に委譲。旧「別建てA1バッチ `_retryPendingLiveThumbnails`／8回打ち切り／10件/回上限（`THUMB_RETRY_MAX_ATTEMPTS`/`THUMB_RETRY_MAX_PER_CYCLE`）」は撤去済み。同時実行の自前上限は無し（ブラウザの同一ホスト同時接続~6本で自然に律速）。
    - 新規/削除カードは `_syncThumbTimers`（`updateSidebar` 末尾で呼ぶ）が各番組タイマーを生成/破棄して追従。停止は `stopThumbnailUpdate()`（`stopAllTimers`＝サイドバー閉／`cleanup`＝ページ離脱の両方から）。
    - タブが非表示（`document.hidden`）の間は**画像更新を行わずタイマーだけ軽く回す**（rAF が止まり `onSettled` が来ないため）。可視復帰後は通常サイクルへ戻り、一斉更新は `performManualUpdate` が担う（フェーズ6）。

### 5.2 sidebar（既定 `updateProgramsInterval`＝120秒・自己再帰 setTimeout。設定で60/120/180秒）
36. `startSidebarLoop()` / `_sidebarTick()` … setup で1回だけ開始する**常設ループ**。**最初の実行も1周期後**（即時ではない）。毎回 `isOpen`→期限→`isLoading()` を判定して素通りし、通れば `updateSidebar()`（notifybox＋フォローAPI）→ 最低1秒ローディング。次回期限は**この回が終わった時点＋1周期**（＝実周期は interval＋作業時間）。停止は `destroySidebarLoop()`（ページ離脱時）のみで、**閉じても止めない**（閉じている間は tick が素通りする）。**サムネ<img>の全件同時更新は撤去**（一斉感を無くすため）。サムネ反映は各番組の自己連鎖サイクルに任せ、新規/削除カードは `updateSidebar` 末尾の `_syncThumbTimers` が拾う。
    - **タブが非表示の周期は更新をスキップ**（`isVisible()` false なら再スケジュールのみ）。背景でのフォローAPI/リスト取得を避け、可視復帰時に `handleVisibilityChange` が即 `performManualUpdate` で取り直す。
    - **別更新が進行中(`isLoading()`)の周期もスキップ**して次回へ（手動更新との二重取得・セッション上書き防止）。
37. `resetSidebarSchedule()` … オプション（`updateProgramsInterval`）変更時／サイドバーを開いた時／手動ロード末尾で、**次回取得の期限だけ**を置き直す（ループは作り直さない）。

> ⚠️ **開いた瞬間の描画は sidebar タイマーではなく**、フェーズ3の `performManualUpdate` が担う。sidebar タイマーの初回も1周期（既定120秒）後である点に注意。

## フェーズ6: タブ可視状態変化（Page Visibility）

38. `handleVisibilityChange`（`appState.setVisibility` で可視状態を記録。`appState.sidebar.isOpen` 時のみ以下）:
    - **背景移行(hidden)**: `thumbnail` の各番組サイクルは `document.hidden` の間、**画像更新を行わずタイマーだけ軽く回す**（rAF が止まり `onSettled` が来ないため。タイマー自体は破棄しない）。sidebar タイマーは継続するが、非表示中の周期はフェーズ5.2で更新をスキップするので実質 notifybox/フォローAPIは走らない。アクティブなローディングセッションが残っていれば500ms後に `finishLoadingSession()`（セッション残留対策）。
    - **復帰(visible)**: thumbnail は次サイクルから通常更新へ戻り、sidebar タイマーを再起動し、rAF内で `performManualUpdate()`（リスト＋詳細（フォローAPI）＋サムネ全件を即取り直す＝復帰時の一斉更新はここが担う）。詳細は毎回フォローAPIで全件更新されるため、旧方式の「長時間非表示なら `forceRefetch` でしっかり更新／短ければ軽量更新」という `thorough` 分岐は不要（常に同じ更新）。

## フェーズ7: 番組自動移動（AutoNext）

`autoNextProgram==='on'` の時のみ。
39. `startWatcher(updateSidebar)` → `observeProgramEnd()` が `document.body` に `MutationObserver`（class監視）を張る。
40. 終了検知（`program-end-guide` 内に announcement＋next-action-area＋broadcast-request-send-button が揃う）で:
    1. 多重進入抑止（`scheduled`/`selectingNext`）
    2. `updateSidebar()`（✅ 2026-07-11修正: `main.js` から注入された関数で**実際に最新リストを取得**してから選定する。旧実装はIIFEで未解決だった → [09-gotchas A](./09-gotchas-and-techdebt.md)）
    3. `#liveProgramContainer` のリンクから**現在番組と異なる先頭番組**を選定＋プレビュー抽出
    4. `scheduleNavigation(href, preview)` → モーダル＋`setInterval(1000ms×10)` → 0で **`location.assign(nextHref)`**（キャンセル可）

## フェーズ8: 手動更新

41. `#reload_programs` click → `isLoading()` なら無視 → **`performManualUpdate()`**: `updateSidebar()`（notifybox＝新着/終了反映 と フォローAPIの詳細（ページング）を並列取得し、詳細が揃った状態で `programsSort` の確定描画）→ `updateThumbnail(true)`（サムネ強制反映）→ 最低1秒ローディング → 開いていれば `resetSidebarSchedule()`。
    - `isPerformingManualUpdate` フラグで多重防止（開閉/タブ復帰/自動移動が重なった時の二重取得を防ぐ）。
    - **初回ロード・タブ復帰・サイドバー再オープンもすべてこの同じ実装**。詳細は毎回フォローAPIで全件更新されるため、旧方式の settle（`processNow`/`flipReorder`）や `forceRefetch`／TTLの「軽量↔しっかり」の区別は無い。

## フェーズ9: オプション変更の伝播（`chrome.storage.onChanged`）

42. `updateProgramsInterval` 変更 → 開いていれば `resetSidebarSchedule()`
    `isOpenSidebar` 変更 → 未反映（他タブ由来）の時だけ `handleSidebarOpenStateChange()`（自タブのトグルは同期反映済みなので二重発火を防ぐ）
    `autoNextProgram` 変更 → watcher start/stop
    `sidebarTheme` 変更 → `applyTheme`
    `animatedThumbnail` 変更 → `setAnimatedThumbnailEnabled`
    `programsSort`/`autoOpen`/`sidebarWidth` → `options`/`appState` に反映

## フェーズ10: ローディングセッション（横断）

43. 1つの `updateSession` ID が更新1サイクルを包括。`updateSidebar` 先頭で `startSession`（`.loading`表示＋60秒タイムアウト）、各経路末尾で `finishSessionWithMinDuration(1000)`。`isLoading()` = `updateSession!==null` が更新ボタン無効化と多重更新防止の判定源。

## フェーズ11: クリーンアップ

44. `cleanup()`（`beforeunload`/`pagehide`）… `teardownAnimatedThumbnails()`（動くサムネ停止＋blob解放）＋ `appState.cleanup()`（全タイマー/オブザーバー解放＋autoNext停止）＋onResize解除＋`hideAutoNextModal()`。

---

## タイマー/再実行 早見表

| タイマー | 起動 | 間隔 | 再実行 | 停止 |
|---------|------|------|--------|------|
| thumbnail | 開/可視復帰 | 番組ごとに独立（基準20秒＋その回の作業時間＝自然ドリフト。保存済みURLでその番組のサムネ<img>を1件更新） | 番組ごとの自己連鎖 setTimeout（`_thumbTimers` Map。`onSettled` 待ち→次サイクル） | 閉/cleanup（`stopThumbnailUpdate`）。背景中はタイマー継続＝画像更新のみスキップ |
| sidebar | 開/可視復帰 | `updateProgramsInterval`（既定120秒。**初回も1周期後**）。1周期＝notifybox＋フォローAPI（通常1リクエスト・ページング時は複数）＋空サムネ補完 | 自己再帰 setTimeout | 閉/cleanup、restartで再設定 |
| loadingタイムアウト | `startSession()` | 60秒 | 単発 | `finishSession()` |
| autoNextカウントダウン | `scheduleNavigation()` | 1秒×10 | setInterval | キャンセル/完了/stopWatcher |

## AppState 読み書きマップ（要点）

| 状態 | 主な書き込み | 主な読み取り |
|------|------------|------------|
| `sidebar.isOpen` | 初期化 / 開閉ボタン / onChanged | `_sidebarTick` の取得可否判定・`resetSidebarSchedule` を呼ぶかの判定 |
| `visibility.isVisible` | `handleVisibilityChange` / 初期化 | sidebar 周期の更新スキップ判定（`isVisible()`） |
| `update.isInserting` | `updateSidebar` 前後 | `updateThumbnail`（挿入中スキップ） |
| `loading.updateSession` | Loading系 start/finish | `isLoading()`・更新ボタン・可視処理・sidebar周期スキップ |
| `timers.*`（thumbnail/sidebar/autoNext の3種） | 各 start/stop | `getTimer` による二重起動防止（`timers.thumbnail` はセンチネル `true`＝実タイマーは `UpdateManager._thumbTimers` Map） |
| `autoNext.*` | AutoNextManager 各所 | 多重進入抑止・カウントダウン・cleanup |
