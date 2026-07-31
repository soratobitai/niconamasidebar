# 03. モジュール別リファレンス

各ファイルの役割・エクスポート・主要な内部挙動・注意点。関数シグネチャは実コードに準拠。

- 表記: `★` = そのファイルの中心、`⚠️` = 改修時に注意（詳細は [09-gotchas](./09-gotchas-and-techdebt.md)）。

---

## config/constants.js

全モジュール共通の定数。**チューニングはまずここ**。

| 定数 | 値 | 意味 |
|------|----|------|
| `notifyboxAPI` | `https://papi.live.nicovideo.jp/api/relive/notifybox.content.php` | フォロー中の放送中番組リストAPI。**新着検知の速さ担当**（user番組はフォローAPIより20〜101秒速い）。⚠️ 並び順の元では**ない**（並びは `beginAt` 降順） |
| `liveInfoAPI` | `https://api.cas.nicovideo.jp/v1/services/live/programs` | 番組**詳細**API（末尾に `/lv{id}`）。フォローAPIがライブサムネを返さない番組（配信者が固定画像を設定／放送直後で未生成）だけに叩く**選択的フォールバック専用**。全番組には使わない（旧方式の重さ回避） |
| `watchPageBaseUrl` | `https://live.nicovideo.jp/watch/` | 視聴ページのベースURL（末尾に lv 番号 or 数値ID） |
| `sidebarMinWidth` | `180` | サイドバー最小幅(px) |
| `maxSaveProgramInfos` | `200` | localStorage `programInfos` の最大件数 |
| `updateThumbnailInterval` | `20`（秒） | サムネ更新の基準間隔（常設ループが、更新完了後にこの時間だけ先へ期限を置き直す。**延ばさない方針**＝ニコ生側の実更新が最速20秒のため） |
| `newProgramFastPollMs` | `180000`（3分） | 空サムネ番組のライブサムネ追撃（詳細API）を「放送開始からこの時間内の若い番組」だけに限定するゲート。過ぎたら追撃せずスクレイプ `fillMissingDetails`（60〜180秒）に委譲。旧A1「8回打ち切り」の代替 |
| `thumbnailTtlMs` | `10000` | サムネ成功後この時間は再取得しない（フリッカ抑制） |
| `thumbnailRetryBaseMs` | `2000` | サムネ失敗時の再試行ベース間隔（指数バックオフの基数） |
| `thumbnailRetryMaxMs` | `60000` | サムネ再試行の最大間隔 |
| `loadingSessionTimeoutMs` | `60000` | ローディングセッションの強制終了タイムアウト |
| `manualThumbWaitMaxMs` | `30000` | 手動更新がサムネ反映の完了通知を待つ上限（背景タブへ回ると rAF が止まり通知が永久に来ないため。doc/09 AC-1） |
| `autoNextListWaitMaxMs` | `15000` | 自動移動が番組終了検知後に最新リストを待つ上限。無制限だと `selectingNext` が立ったまま残り、以後そのページで自動移動が二度と動かない（doc/09 項目AU） |
| `autoNextCountdownMs` | `10000` | 自動移動のカウントダウン。⚠️ 残り秒数は**この値と現在時刻から毎回計算**する（1秒ずつ引かない）。裏タブのタイマー間引きで10秒が最大10分に化けるため（doc/09 項目AX） |
| `reorderFlipDurationMs` | `300` | 並べ替え FLIP アニメの時間(ms)。**0 にすれば実質無効** |
| `newCardFirstThumbSpreadMs` | `2000` | 途中で増えた新着カードに配る初回サムネ取得までの分散窓。🔴 これが無いと新着は**アイコンのまま20〜40秒**放置される（初回期限を1周期ぶん後ろへ倒していたため）。初回の一斉配布中と手動更新中は従来どおり後ろへ倒す（doc/09 項目BB） |
| `animIngestWaitMaxMs` | `2000` | 静止サムネの表示が「動くサムネへの給餌」を待つ上限。🔴 性能調整ではなく**依存を切るための上限**。給餌は IndexedDB を触るので応答が返らないことがあり、待ち続けると**そのカードのサムネがページ再読込まで固まる**（doc/09 項目BA） |
| `animatedThumbnailFrameCount` | `5` | 🧪実験(branch)。動くサムネのリングバッファ保持枚数 |
| `animatedThumbnailCaptureIntervalMs` | `20000` | 🧪実験。⚠️ **フレーム取得の間隔ではない**（取得は①からの給餌に一本化済み）。消えた番組のバッファを解放する**定期メンテ**の周期 |
| `animatedThumbnailPlayIntervalMs` | `700` | 🧪実験。ホバー時の1コマ表示時間(ms) |
| `animatedThumbnailPersistTtlMs` | `1800000` | 🧪実験。保存フレームの復元TTL(30分, updatedAt基準)。超過は復元せず削除。静止番組が誤削除されないよう長め |
| `animatedThumbnailPersistMaxEntries` | `300` | 🧪実験。保存する番組レコード数の上限（古い順に掃除） |

---

## core/AppState.js ★

アプリ全体の状態を1つに集約するクラス。`main.js` で `const appState = new AppState()` として生成。

### 状態フィールド
[02-architecture.md §2.5](./02-architecture.md) の表を参照。

### メソッド
| メソッド | 説明 |
|---------|------|
| `setTimer(name, timer)` / `getTimer(name)` | タイマー登録/取得。`name` は `timers` のキー（現在は **`autoNext` のみ**）。更新ループ2本は `UpdateManager` が内部で持ち、ここには載せない（外部から殺されないため） |
| `clearTimer(name)` | 値が数値なら `clearTimeout`＋`clearInterval` 両方呼び null化 |
| `clearAllTimers()` | 全タイマークリア |
| `setObserver/disconnectObserver/disconnectAllObservers` | ResizeObserver 等の管理。`disconnect()` を安全に呼ぶ |
| `setHandler(name)/getHandler(name)` | イベントハンドラ参照の保持（削除は呼び出し側責任） |
| `isLoading()` | **`loading.updateSession !== null`** を返す（＝セッション方式が真実） |
| `startUpdateSession()` | `update_{Date.now()}_{Math.random()}` のIDを発行しセット。返り値=ID |
| `finishUpdateSession(id)` | 現行IDと一致した時のみ null化（後発セッションを誤終了しない） |
| `cleanup()` | 全タイマークリア＋全オブザーバー切断＋`onResize`解除＋`autoNext.liveStatusStopper()` 実行。ページ離脱時に `main.js` の `cleanup()` から呼ばれる |

---

## services/api.js ★

ニコ生 notifybox API（リスト）＋番組詳細API（**選択的フォールバック専用**）の fetch。**in-flight 重複排除**（同一リクエストが飛んでいる間は同じ Promise を返す）を持つ。

| 関数 | シグネチャ | 説明 |
|------|-----------|------|
| `fetchLivePrograms` | `(rows=100) => Promise<false \| Array>` | `notifyboxAPI?rows=100` を `credentials:'include'` で取得。`meta.status===200` かつ `data.notifybox_content` があれば**その配列を返す**。失敗時 `false`。`liveProgramsInFlight`(Map) で `rows` をキーに重複排除 |
| `fetchProgramInfo` | `(liveId) => Promise<any \| undefined>` | 1番組の**詳細**を `liveInfoAPI/lv{liveId}`（`lv` 無しのID）で取得。`meta.status===200` かつ `data` があれば `data` を返す。失敗時 `undefined`。`programInfoInFlight`(Map) で `liveId` をキーに重複排除。⚠️ **用途限定**：フォローAPIがライブサムネを返さない番組の補完（[followPageSource.js](#servicesfollowpagesourcejs-) の `fillMissingDetails`）だけが呼ぶ。全番組には叩かない |
| `mapNotifyboxRowToInfo` | `(row, beginAtIso) => object \| null` | notifybox の1行を内部 programInfo 形へ写像（`_mergeSources` が新着番組に使う）。**notifybox は id と title だけではない**: `community_name`（＝配信者名）と `thumbnail_url`（＝配信者アイコン）と `provider_type` を持つ。⚠️ アイコンは `contentOwner.icon` に入れ、**`thumbnailUrl` には入れない**（ライブサムネ誤登録＝項目AA の再発）。配信者IDはアイコンURL（`…/usericon/…/<id>.jpg` / `…/channel-icon/…/ch<id>.jpg`）から復元する |
| （内部）`warnIfNotifyboxShapeChanged` | — | notifybox の応答から `community_name`/`thumbnail_url` が消えていたら**1回だけ** `console.warn`（鳴る罠）。正常時は無言。名前とアイコンが黙って消える壊れ方はエラーが出ないので、ここでしか気付けない |

- 失敗は `handleError` に記録し、例外は投げず false / undefined を返す方針。
- 番組**詳細を一括取得**する経路（並びと突き合わせる本流）はフロントAPI方式（[followPageSource.js](#servicesfollowpagesourcejs-)）。`fetchProgramInfo` はそこから漏れた「ライブサムネが空の番組」だけを埋める補助であり、旧「全番組×詳細API」ではない。

---

## services/followPageSource.js ★

番組**詳細を一括取得**するデータソース。旧「1番組=詳細API×N＋レート制限キュー」を、フォロー中ページが
「もっと見る」で叩く**公開フロントJSON API**への直接呼び出しに置換したもの（＝旧SSR HTMLスクレイプ／DOMParserも置換済み）。

フォロー中の放送中番組ページが使う公開フロントAPI（`followApiUrl`）を直接呼ぶ:
`GET https://live.nicovideo.jp/front/api/pages/follow/v1/programs?status=onair&offset=<0始まりページ番号>&limit=100`
を `credentials:'include'`（Cookie）で取得。応答は `{ data: { programs: [...], total: N } }`。各 program は
`{ id:"lv...", title, listingThumbnail, flippedListingThumbnail?, watchPageUrl, providerType:"community"|"channel"|"official",
liveCycle, beginAt(ミリ秒エポック), endAt, isFollowerOnly, isPayProgram, programProvider:{id,name,icon,iconSmall},
socialGroup?:{id,name,thumbnailUrl}, statistics:{watchCount,commentCount}, timeshift }`。watchページと同一オリジンなので content script から取得できる。
`socialGroup` は **channel のみ**（チャンネルID・チャンネル名・チャンネルアイコン）。`programProvider` は channel だと id とアイコンが空なので、`contentOwner` はこの2つを合成して作る。
⚠️ リストは notifybox と**和集合**にする。並び順は notifybox 由来ではなく、ここが返す `beginAt` の降順で決める。

| エクスポート | 説明 |
|-------------|------|
| `fetchFollowedProgramsViaPage()` ★ | 放送中フォロー番組の詳細を**ページングして全件**取得し、内部 programInfo 形の**配列**で返す。`fetchOnePage(offset)` を offset=0,1,2… と回し、`id` で重複排除しつつ `total` に達するまで蓄積（安全上限 `MAX_PAGES`）。集めた各番組を `mapApiProgramToInfo` で変換 → 穴のある番組を `fillMissingDetails` で補完 → 返す。失敗（未ログイン/仕様変更/通信エラー、`res.ok` 偽含む）時は `null`。`UpdateManager._refreshDetailsViaScrape` が結果を `upsertProgramInfos` で storage へ一括投入する |
| `mapApiProgramToInfo(p)` | フロントAPIの1番組を、詳細API相当の内部 programInfo 形（`id="lv..."`, `title`, `providerType`, `contentOwner`, `viewers`(watchCount), `comments`(commentCount), `isMemberOnly`(isFollowerOnly), `onAirTime.beginAt`(beginAt(ms)→ISO), サムネURL群, `status`, `watchPageUrl`, `_source:'followApi'`）へ変換。`makeProgramElement`/`resolveLiveThumbnailBaseUrl`/`calculateActivePoint` がそのまま読めるshape。`p.id` が無ければ `null` |
| `fetchOnePage(offset)`（内部） | 1ページ取得。`?status=onair&offset=<0始まりページ番号>&limit=PAGE_LIMIT` を `credentials:'include'` で fetch し、`{ programs, total }` を返す。`res.ok` が偽なら throw（→ `fetchFollowedProgramsViaPage` の catch で `null`） |
| `fillMissingDetails(programs)`（内部） | **選択的フォールバック**。①`thumbnailUrl` が空の **user** 番組（放送直後で未生成／flipped が包まれた形）→ライブサムネを補完 ②配信者名が空のまま（想定外の応答）→`contentOwner` を補完。`fetchProgramInfo`（詳細API）を叩いて**破壊的に補完**。空の少数だけ・上限 `MAX_DETAIL_FALLBACK` 件まで。全番組には叩かない（＝旧「全番組×詳細API」の重さを避けたまま穴だけ埋める）。個別失敗は空のまま（次サイクル再挑戦）。⚠️ channel のアイコンはここではなく `socialGroup.thumbnailUrl` から拾う（この条件は名前が埋まっていると発火しない） |
| `isLiveScreenshotUrl(u)`（内部） | ライブスクショURLかどうか（配信者設定の**固定画像**と区別）。`/screenshot/` を含む or `dlive.nicovideo.jp` 形なら true。`mapApiProgramToInfo`（listingThumbnail / flippedListingThumbnail の採否）と `fillMissingDetails`（補完候補の採否）で使う |
| （内部）`warnIfFlippedThumbMissing` | 固定画像の番組が居るのに `flippedListingThumbnail` から1件も回収できなかった時だけ**1回だけ** `console.warn`（鳴る罠）。回収できていれば無言。フィールドが消えても**詳細APIでの補完が静かに復活するだけで画面は何も変わらない**ので、ここでしか気付けない |
| `followApiUrl` | `https://live.nicovideo.jp/front/api/pages/follow/v1/programs` |
| （グローバル）`window.__testFollowScrape()` | 実ページのConsoleから取得結果を件数＋表(`console.table`)で確認するデバッグ用（`debugTestFollowScrape`。現在はAPI経路を叩く） |

- **定数（モジュール内）**：`PAGE_LIMIT=100`（1リクエストあたり件数。notifybox の rows=100 に対応）、`MAX_PAGES=5`（ページング安全上限＝最大500件）、`MAX_DETAIL_FALLBACK=30`（1サイクルで詳細APIを呼ぶ上限）。
- **ページング実装済み**：`offset` は「0始まりのページ番号」（ページNは items[N×limit .. N×limit+limit)）。通常は1リクエストで済む（limit=100 が放送中フォロー100件未満をカバー）。同時放送中のフォローが**100件を超えても**offsetを進めて全件の詳細を取得する。
- サムネ枠は**2つ**（`listingThumbnail` と `flippedListingThumbnail`）。ライブスクショ形のときだけ、この順で採用する（`isLiveScreenshotUrl` フィルタ）。**固定画像運用の番組はライブスクショが flipped 側に入っている**ので、ここで拾えば詳細APIの補完がほぼ不要になる（2026-07-31 実測: user 67件中22件が固定画像運用、22件すべてが flipped を持つ）。どちらも通らない番組だけ上記 `fillMissingDetails` へ回す。⚠️ 包まれた形（listing-thumbnail プロキシ経由）を拾おうとして判定を緩めないこと（→ [09 項目AA/AW](./09-gotchas-and-techdebt.md)）。
- 失敗時は `handleError` に記録して `null` を返すのみ。**本流の一括取得に失敗した周は詳細が古い/欠けるだけ**（意図的。全体フォールバックは無い）。

---

## services/status.js

watch ページ上の「**番組終了ガイド**」を検知して自動移動をトリガする。

| 関数 | 説明 |
|------|------|
| `detectProgramEndGuide()`（内部） | `[class*="program-end-guide"]` を探し、その中に **`announcement` ＋ `next-action-area` が揃う**（視聴者が見る通常の形）か、**満足度アンケートパネル**（配信者本人にだけ出る形）があれば true。ハッシュ付きクラス名に部分一致、テキストは見ない。🔴 **`broadcast-request-send-button` を条件に戻さないこと**（チャンネル/公式番組や、放送リクエストを無効にしている配信者では出ないため、自動移動が番組によって毎回不発になる。→ [09 項目AU](./09-gotchas-and-techdebt.md)） |
| `observeProgramEnd(onEnded)` ★ export | `document.body` を `MutationObserver`（childList/subtree/attributes[class]）で監視し、終了ガイド表示中に `onEnded()`。即時チェックも実施。✅ **スロットル(2026-07-11)**：`onEnded`→`updateSidebar` の `replaceChildren` が変異を撒き「変異→onEnded→更新→変異」の自己駆動ループ（getLivePrograms 暴走）になるのを防ぐため、ガイド表示中は最小 `PROGRAM_END_RECHECK_MIN_INTERVAL_MS`(20秒) 間隔でのみ再発火し、ガイド消滅で再武装（次番組ジャンプの初回1発は保証）。返り値は**停止関数**（`AppState.autoNext.liveStatusStopper` に保持される） |

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
| `setSidebarTheme(theme)` ✅新規 | chrome.storage.local | `sidebarTheme`（`'dark'`/`'light'`）のみ保存 |
| `getProgramInfos()` | localStorage | `programInfos` を JSON parse（失敗時 `[]`） |
| `setProgramInfos(list)`（内部専用・未export） | localStorage | JSON保存。**QuotaExceeded 時は後半半分に減らして再試行**。`upsertProgramInfo` から内部利用 |
| `upsertProgramInfo(info)` ★ | localStorage | `id` 一致で置換、無ければ push。`maxSaveProgramInfos`(200) 超過は先頭から shift。**保存時に `_fetchedAt`(取得時刻) を付与**（引数は汚さず浅いコピーを保存） |
| `upsertProgramInfos(list)` ★ | localStorage | **一括版**。スクレイプは毎サイクル全番組を書き戻すため、`upsertProgramInfo` を件数分呼ぶ O(N²) を1回の read/merge/write に畳む。`Map(id→info)` で既存idは delete→再setして**更新レコードを末尾（=最新）へ移動**（上限トリムの先頭shiftが今回更新されなかった古い＝放送終了済みレコードから落ちるように）。各レコードに `_fetchedAt` 付与。`UpdateManager._refreshDetailsViaScrape` から使用 |
| `patchProgramThumbnail(id, fields)` ★ | localStorage | 1番組の**ライブサムネ関連フィールドだけ**を、最新レコードに再read→マージして書き込む。A1追撃（`_fetchLiveThumbIfPendingYoung`）の書き戻し用。フルレコード置換だと詳細API await を跨いだ古いスナップショットで最新の視聴者数等を巻き戻す(lost update)ため、サムネ欄だけ上書きする。対象id無しなら `false` |

> ⚠️ 設定は `chrome.storage.local` に入るが、`main.js` の `chrome.storage.onChanged` リスナーは
> `changes.xxx` を直接見ており、`local` / `sync` の area 判定はしていない（このプロジェクトでは local しか使わないので実害なし）。

---

## managers/UpdateManager.js ★★（更新の司令塔）

2系統タイマー（`thumbnail`/`sidebar`）の起動/停止と、実際の描画更新を担う中核クラス。

コンストラクタ: `(appState, loadingManager, options, elems, loadingImageURL)`。

**データ取得の役割分担**:
- リスト: notifybox（`fetchLivePrograms`）とフォローAPIの**和集合**（`_mergeSources`）。notifybox は新着検知が速く、フォローAPIは詳細・並び順・100件超を担う
- 並び順: `_orderByBeginAtDesc` が **`beginAt` 降順**で決める（`data-api-index` はその位置）
- 詳細（視聴者数/コメント/ライブサムネURL/配信者/会員限定/開始時刻）: フォロー中ページのフロントJSON API **1回**（`_refreshDetailsViaScrape`）で全番組ぶんを storage へ一括 upsert
- サムネ画像の再取得: **常設ループ1本**（`startThumbnailLoop`→`_thumbTick`）＋番組ごとの期限表（`_thumbDueAt`）が、各カードの `<img>` を保存済みURL＋キャッシュバスターで更新

詳細はリストと**同時**（`updateSidebar` 内で `Promise.all` 並列）に storage へ載るため、カード生成時点で人気度（active-point）が確定している。よって旧「詳細が揃うまで新着順で待つ」整列確定機構（settling 等）は**不要**になり撤去された。

| メソッド | 説明 |
|---------|------|
| `startThumbnailLoop()` | サムネ更新の**常設ループ**を開始（setup から1回だけ）。以後**作り直さない**ので孤児化・二重化が構造上起こらない。冪等（`_thumbLoopRunning` で判定。`_thumbLoopTimer` は tick 実行中 null になるため使わない） |
| `destroyThumbnailLoop()` | 常設ループを止める（`cleanup` ＝ページ離脱時のみ）。**「閉じたら止める」には使わない**（閉じている間は `_thumbTick` が素通りする）。`_refreshThumbSchedule` から再武装できる |
| `_syncThumbDueAt()`（内部） | 現在のカードと期限表 `_thumbDueAt` を突き合わせ、新規カードに初回期限を配り、消えたカードの期限を捨てる。**初回位相を周期内へ均等配置**する（同時起動だとドリフトが原理的に成立しないため）。⚠️ **この関数はタイマーを張らない**（tick から呼ばれるので張ると二重実行になる） |
| `_refreshThumbSchedule()`（内部） | `_syncThumbDueAt()` ＋ 目覚ましの張り直し。ループの**外**からの呼び出し用（`updateSidebar` 末尾・サイドバーを開いた時） |
| `_thumbTick()`（内部） | ループ1回ぶん。`isOpen` → **背景タブ** → 期限の来た最古の1件、の順で判定。空＆若い番組なら詳細API追撃（`_fetchLiveThumbIfPendingYoung`）→ `<img>` を1件更新して読み込み完了を待つ（`_updateOneThumbnailAndWait`）→ **完了してから** `now + 20秒` へ期限を置き直す＝周期20秒＋作業時間で自然ドリフト。`finally` で必ず次を張る。⚠️ 素通りした周は基準間隔ぶん待つこと（期限が過去のままだと0ms再帰で**2秒間に180回**回る。項目AE） |
| `_updateOneThumbnailAndWait(id)`（内部） | その番組の `<img>` を1件更新し、画像の読み込み（全プリロード）が settle するまで待つ Promise。`updateThumbnailsFromStorage` の `onSettled` で検知。画像がハングしても基準間隔の2倍で安全にタイムアウトして前進 |
| `_fetchLiveThumbIfPendingYoung(id)`（内部）★A1統合 | 「user・非会員・ライブサムネ空」かつ `onAirTime.beginAt` が `newProgramFastPollMs`(3分)以内の若い番組だけ、詳細API `fetchProgramInfo` で1回追撃し、取れたら `patchProgramThumbnail` でサムネ欄だけをマージ更新（await 跨ぎの lost update 回避）。3分超の空番組は追撃せずスクレイプ `fillMissingDetails` に委譲。旧「別建てA1バッチ `_retryPendingLiveThumbnails`／8回打ち切り／10件/回上限」は撤去済み |
| `startSidebarLoop()` | 常設ループを開始（`main.js` の setup から1回だけ）。以後**作り直さない**ので孤児化・二重化が構造上起こらない。冪等（`_sidebarLoopRunning` で判定。`_sidebarLoopTimer` は tick 実行中 null になるため使わない） |
| `destroySidebarLoop()` | 常設ループを止める（`cleanup` ＝ページ離脱時のみ）。**「閉じたら止める」には使わない**。完全な片道にはせず `resetSidebarSchedule` から再武装できる（bfcache 復帰・遷移キャンセルでページが生き残る場合があるため） |
| `resetSidebarSchedule()` | 次回取得の期限を「今から1周期後」に置き直すだけ（旧 `restartSidebarUpdate` 相当）。ループは作らない。呼ばれるのは**サイドバーを開いた時／手動更新の完了後／更新間隔の変更時**の3箇所で、いずれも `isOpen` ガード付き |
| `_sidebarTick()` | ループ1回ぶん。毎回 `isOpen` → 期限（`_sidebarNextDueAt`） → `isLoading()` の順で判定して素通りする。**裏タブ判定は無い**（655df9c の意図的決定。`document.hidden` を見るのはサムネ側だけ）。取得したら**自分が始めたセッションだけ**を `finishSessionWithMinDuration(1000, sessionId)` で閉じる。`finally` で必ず次を張るのでループが死ぬ経路は destroy だけ。周期は「この回が終わった時点＋1周期」＝旧の自己再帰と同じく **interval＋作業時間**。**サムネの全件同時更新は呼ばない**（一斉感を無くすため。反映は各番組の自己連鎖サイクル任せ。新規/削除カードは `updateSidebar` 末尾の `_refreshThumbSchedule` が拾う） |
| `performManualUpdate()` ★ | 手動更新（初回ロード・更新ボタン・タブ復帰・再オープン**共通**）。`updateSidebar()`→`updateThumbnail(true)`→最低1秒ローディング→（開いていれば）`resetSidebarSchedule()`。詳細は毎回スクレイプで全件更新されるためTTLや「軽量/しっかり」の区別は無い。**多重防止**：冒頭 `isPerformingManualUpdate` in-flight ガードで、開閉/タブ復帰/自動移動が重なった時の二重取得を直列化 |
| `updateSidebar()` | リスト＋詳細を取得して描画。**開始したローディングセッションIDを返す**（呼び出し元が自分のぶんだけ閉じられるように）。既に別のセッションが動いている時は**新しく立てず相乗りし `null` を返す** — `startSession` は前セッションを finish せず上書きするため、素直に立てると持ち主からロックを奪い、それを閉じると持ち主がまだ走っているのに `isLoading()` が false へ落ちる |
| `_refreshDetailsViaScrape()` | `fetchFollowedProgramsViaPage()`（メソッド名は据え置き。実体はスクレイプではなくJSON API）→ 成功時のみ `upsertProgramInfos` で storage へ全件書き戻し。失敗時は何もしない＝その周は詳細が古いまま（**フォールバック無し**） |
| `updateSidebar()` ★★ | ①セッション開始（動いていれば相乗り）②**描画世代を採番**（`++_renderGen`）③`Promise.all([fetchLivePrograms(100), _refreshDetailsViaScrape()])` ④**世代チェック** — 後発の取得が既に描画済みなら**ここで降りる**（項目AP）⑤`_mergeSources` で和集合 → `_orderByBeginAtDesc` で `beginAt` 降順 ⑥既存カードは**その場更新**（`applyProgramInfoToCard`＝タイトル/リンク/配信者名/アイコン/`data-src`＋`active-point`/`data-api-index`）、新規は `makeProgramElement` ⑦**構造が変わった時だけ**（追加・削除・`_sortOrderChanged`）`flipReorder` のコールバック内でフラグメントを組んで `replaceChildren` →ソート ⑧カラム幅→番組数→`_refreshThumbSchedule()`。番組ごとに try/catch で1件失敗しても全体は描画。**両方**失敗時と和集合が空の時は既存DOM維持 |
| `updateThumbnail(force, onComplete, onlyIds, onSettled)` | 挿入中(`isInserting`)なら**1回だけ警告を出して**即完了扱い（🔴 現状**到達不能**。差し替え区間は同期なので観測できない。到達したら描画が非同期化された印＝項目AL）→ `getProgramInfos()`→ `updateThumbnailsFromStorage` に委譲。`onlyIds` 指定時はその番組だけ更新（常設ループの1件更新）、未指定なら全件（読み込み時の一斉更新）。`onSettled` は画像の読み込み完了(settle)で発火し、各番組サイクルが「作業完了後に次の20秒を張る」ために使う |
| `sortProgramsInContainer(container)` | `sortPrograms(container, options.programsSort)`（詳細が揃っているので設定どおりのソートを最初から適用） |
| `_sortOrderChanged(container)`（内部） | 今のDOM順が、あるべき順と食い違うか（＝並べ替えが要るか）を**DOMを触らずに**判定。比較器は `utils/programOrder.js` の `orderComparator` を使う。🔴 **ここに比較器を書き直さないこと**（実際の並べ替えと食い違うと、全カードが毎周期スライドするか、必要な並べ替えが永久にスキップされる） |
| `_mergeSources(notifyList, fetched)`（内部） | 2つの取得元の**和集合**。フォローAPIの結果を優先し、notifybox にしか無い番組は storage のキャッシュ、無ければ最小限の仮データでカード化する |
| `_orderByBeginAtDesc(programs)`（内部） | `beginAt` 降順（同時刻は lv番号降順）。この位置が `data-api-index` になる |
| `updateProgramCount(count)` | `#program_count` の数字更新 |
| `_currentUpdateIntervalMs()`（内部） | `Number(options.updateProgramsInterval) * 1000`。リスト＋詳細サイクルの周期 |

> ⚠️ サイクル間隔（`_currentThumbCycleMs`）は `options.updateThumbnailInterval` を参照するが、
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
| `makeProgramElement(data, loadingImageURL)` ★ | 番組データ→カードDOM（`createElement`ベース、XSS配慮）。`div.program_container#{数字ID}` に `provider`(icon/provider_name) + `program_thumbnail`(img: `src`=ライブサムネ, `data-src`=静的サムネ, **error時フォールバック配線済み**) + `program_title`。`providerType` で user/channel を出し分け（user=`liveScreenshotThumbnailUrls.middle?cache=`, channel=`large1280x720ThumbnailUrl`）。**サムネが無い間の繋ぎは配信者アイコン**（→ 無ければ `loading.gif`）で、その時は `dataset.thumbLive='0'` を立てる |
| `calculateActivePoint(data)` | **盛り上がり**（＝人気順のスコア）を返す。実体は `data.momentum`（直近の増分レートのEMA。計算は `utils/momentum.js`、更新は `storage.upsertProgramInfos`）。未計算なら `initialMomentum`（開始からの平均レート）で代用。⚠️ 旧式 `(viewers+1 + comments+1) / 経過分` に戻さないこと（doc/09 項目AY）。旧 `onAirTime.beginAt` から経過時間算出。ソート・active-point属性の元になる**現役関数**（✅ 誤った `@deprecated` JSDocは2026-07-11に修正） |
| （内部）`handleThumbnailError` | サムネ読み込み失敗時のフォールバック（`data-src`→loading.gif）。✅ 2026-07-11に `makeProgramElement` で各imgへ直接配線（旧 `attachThumbnailErrorHandlers` は未使用のため削除） |
| `updateThumbnailsFromStorage(programInfos, {force,onComplete,onlyIds,onSettled})` ★★ | ⚠️ ライブサムネを持たない番組（チャンネル等）では `syncStaticThumb` が**唯一の表示経路**（`applyProgramInfoToCard` は `img.src` を触らないため）。「loading.gif の時だけ戻す」にすると絵が永久に出なくなる（項目AZ）。 localStorageの番組情報を元に各サムネを更新。既定は**コンテナ内の全 `.program_thumbnail_img`**（✅ 可視限定は撤去）。`onlyIds` 指定時はその id 集合の番組だけ更新（番組ごと自己連鎖サイクルで使う）。`computeNext` でURL決定（memberOnlyはスキップ）。**TTL**(`thumbnailTtlMs`)内かつ同キーは skip、失敗は**指数バックオフ**(`nextTryAt`)。`new Image()` でプリロード成功時のみ差し替え（フリッカ防止）。50件チャンク＋`requestAnimationFrame`。**`onSettled`** は全プリロードが settle したら1回だけ発火し、`_updateOneThumbnailAndWait` がこれを待って次サイクルを張る（＝作業時間ぶん自然にドリフトする） |
| `sortProgramsByActivePoint(container)` | `active-point` 降順に並べ替え（人気順の実体）。比較器は `utils/programOrder.js` の `compareByActivePoint` |
| `resolveLiveThumbnailBaseUrl(info)` | ライブサムネのベースURLを provider 別に選ぶ純関数（user=`liveScreenshotThumbnailUrls.middle` / channel=`large1280x720ThumbnailUrl`） |
| `deriveCardFields(data)` | 番組データ→カードに書く値一式（id/リンク/配信者名/サムネURL/アイコン/タイトル）を導出する純関数。`makeProgramElement` と `applyProgramInfoToCard` の**共通の土台**。`data.id` は `lv` 有無どちらでも受ける（カードDOM id は数値・視聴URLは `lv` 付き、という規約の唯一の生成点） |
| `applyProgramInfoToCard(card, data)` ★ | **既存カードを作り直さずにその場で更新**（タイトル/リンク先/配信者名/アイコン/`data-src`）。⚠️ `img.src` は**触らない**（サムネ更新ループの担当。触ると動くサムネの状態が壊れる）。項目AK の修正本体 |
| `setAnimThumbnailFeed(feed)` | 動くサムネ(②)への給餌フックを注入。①が `crossOrigin` で読んだ画像を②へ渡し、**②が返したコマをそのまま静止サムネにも表示する**（同じ1枚を共有＝「静止サムネ＝最新コマ」が構造的に成立。項目AV） |
| （内部）`showThumbnail(img, url, frame)` | 静止サムネの表示を確定。②のコマがあればそれを出して `dataset.thumbSeq` を記録、無ければ取得URLを出して記録を消す。blob URL の所有者はこちらで、**1世代遅れで** revoke する（表示中のものを消さないため） |
| `releaseThumbnailBlobs(card)` | リストから外れるカードが抱えている blob URL を解放（`updateSidebar` の差し替え直前に呼ぶ）。外れた要素はDOMから辿れなくなるため、ここで手放さないとページ滞在中ずっと残る |
| `flipReorder(container, reorderFn, duration=300)` | FLIPアニメで並べ替えを滑らかに見せる。First(位置記録)→`reorderFn()`で同期並べ替え→Invert(旧位置へtransform)→Play(rAFでtransition付きで新位置へ)→後始末(setTimeout)。移動量0はスキップ。**`UpdateManager.updateSidebar` から現役で呼ばれている**（定期更新の並べ替えアニメ本体）。🔴 `reorderFn` の中でフラグメントを組むこと。外で組むと既存カードが親から外れた状態で First を測ることになり、**毎回空振りする**（項目AM） |
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

オプションフォームの初期反映と変更保存。`setupOptionsHandler(options, sortPrograms)`。

- 起動時にラジオを現設定に合わせる（`programsSort`/`updateProgramsInterval`/`autoOpen`/`autoNextProgram`、および存在すれば `animatedThumbnail`）。
- `#optionForm` の `change` で `saveOptions()`（`chrome.storage.local` へ）。
- **ソート変更(`programsSort`)時のみ特別扱い**: 取得を伴わず、保存＋既存DOMを `sortPrograms(container)` で即ソート。
- 保存自体は `chrome.storage.local` へ。変更は `main.js` の `chrome.storage.onChanged` が拾って各挙動へ反映（[04-data-flow](./04-data-flow.md) 参照）。

---

## utils/momentum.js ★

**「盛り上がり」（人気順のスコア）の唯一の定義**（2026-07-31 新設）。

| 関数 | 説明 |
|------|------|
| `totalEngagement(info)` | 来場者＋コメントの累計。差分の元であり、同点時の第2キー（`data-total`）にも使う。⚠️ `viewers` は**累計の来場者数**で、同時視聴者数ではない（2026-07-31 に70件×6分で実測: 増26/減0） |
| `initialMomentum(info, now)` | 前回値が無い時の初期値＝**開始からの平均レート**。若い番組ではこれが実質そのまま直近レートになる。長時間放送では平均から始まるので、直近値へ寄るまで実時間で数分かかる（EMA の暖機） |
| `nextMomentum(prev, next, now)` | 新しい取得値で更新。`instant = max(0, 累計の増分) / 経過分` を `α = 1 - exp(-Δt/τ)` で混ぜる。⚠️ **減少はクリップ**（負の勢いを作らない）、**Δt<1秒は据え置き**（極小の分母で爆発させない） |

- 呼ぶのは **`storage.upsertProgramInfos` だけ**（前回値と新値が出会う唯一の場所）。`calculateActivePoint` は結果を読むだけ。
- 🔴 **α を固定値にしないこと。** 更新間隔は 30〜180秒で可変なので、時間から計算しないと間隔を変えた瞬間に手触りが変わる。検証で「30秒×6回 と 180秒×1回 が一致すること」を固定している。
- 🔴 **生の差分をそのまま順位に使わないこと。** 30秒ウィンドウでは平均79%の番組が増分ゼロ（ニコ生の統計が約60秒粒度）。平滑化なしでは1周期あたり平均14.4位動く（τ=3分で1.1位）。→ [09 項目AY](./09-gotchas-and-techdebt.md)

---

## utils/providerType.js

**配信主体の種別（`'user'`/`'channel'`）への写像の唯一の定義**（2026-07-31 新設）。

| 関数 | 説明 |
|------|------|
| `mapProviderType(pt)` | `'channel'`/`'official'`→`'channel'`、それ以外（`'community'`/`'user'`/未知）→`'user'` |

取得元が3つ（フォローAPI `providerType` / notifybox `provider_type` / 詳細API `providerType`）あっても
語彙は共通なので写像は1つに集約する。`'community'` は**旧コミュニティ時代の名残**で、実体はユーザー生放送。

---

## utils/programOrder.js ★

**並び順の比較器の唯一の定義**（2026-07-30 新設）。

| 関数 | 説明 |
|------|------|
| `compareByActivePoint(a, b)` | 人気順（`active-point` 降順 → 同点は `data-total` 降順）。静かな番組は勢い0で並ぶため第2キーが要る（2026-07-31）。旧: tie-break 無し＝同点は現状順を保つ（`parseFloat` の NaN との比較が常に false になることと `sort` の安定性による） |
| `compareByApiIndex(a, b)` | 新着順（`data-api-index` 昇順＝放送開始が新しい順）。第2キーは lv番号降順だが、`data-api-index` はカード間で常に一意なので**実際には効いていない**（属性欠けの保険） |
| `orderComparator(sortType)` | 設定値から比較器を選ぶ。`'active'` なら人気順、それ以外は新着順 |

> 🔴 **比較器をここ以外に書かないこと。** 従来は3箇所（`sorting.js`／`sortProgramsByActivePoint`／`UpdateManager._sortOrderChanged`）に重複しており、
> 「実際に並べ替える処理」と「並べ替えが要るかの判定」が食い違うと、**毎周期 `replaceChildren` が走って全カードが毎回スライドする**か、
> 逆に**必要な並べ替えが永久にスキップされる**。詳細は [09 項目AR](./09-gotchas-and-techdebt.md)。

> ⚠️ tie-break を「改善」しないこと。見た目が変わる。

---

## utils/sorting.js

| 関数 | 説明 |
|------|------|
| `sortPrograms(container, sortType)` | `sortType==='active'` → `sortProgramsByActivePoint`（人気順）。それ以外(=`newest`) → `compareByApiIndex`（`utils/programOrder.js`）で `data-api-index` 昇順に並べる。この属性は `updateSidebar` が **`beginAt` 降順**で並べた位置を書き込んだもの（lv番号は予約/作成順で放送開始順とズレるため主キーには不採用） |

---

## utils/dom.js

| 関数 | 説明 |
|------|------|
| `debounce(fn, delay)` | 標準的なデバウンス。`main.js` のリサイズ(30ms)で使用 |

---

## utils/error.js

エラーの分類・ログ・リトライ戦略。実運用は `handleError` 一本。

| シンボル | 説明 |
|-------------|------|
| `ErrorType`（内部専用・未export） | `API/NETWORK/DOM/STORAGE/VALIDATION/UNKNOWN` |
| `ErrorLevel`（内部専用・未export） | `INFO/WARNING/ERROR/CRITICAL` |
| `class ErrorManager`（内部専用・未export） | `handle(error, context)` でエラー情報生成→ログ(最大100件)→コンソール出力。`_classifyError`（メッセージ文字列から種別推定）、`_determineLevel`、`getLogs`、`isRetryable`、`calculateRetryDelay`（指数バックオフ）を持つ |
| `handleError(error, context)` ★ **唯一のexport** | モジュールローカルの `errorManager` へ委譲。**全layerの失敗経路がここに集まる** |

> ⚠️ `_detectDevelopmentMode()` は「chrome.runtime があれば常に true（開発時）」＝**本番でも console 出力が有効**。
> リトライ機構(`isRetryable`/`calculateRetryDelay`)は定義のみで、現状どこからも呼ばれていない。

---

## render/animatedThumbnail.js 🧪（実験機能 / `feature/animated-thumbnail`）

「動くサムネ」（ホバー中のみ）。**β版・設定でON/OFF（既定OFF）**（`main.js` setup で `setAnimatedThumbnailEnabled(options.animatedThumbnail === 'on')`、onChangedで反映）。詳細は [06-features §15](./06-features.md)。

| エクスポート | 説明 |
|-------------|------|
| `setAnimatedThumbnailEnabled(on)` | 有効/無効の切替（冪等）。有効時: 委譲hoverリスナ付与＋20秒間隔の `pruneAbsentBuffers`（バッファ掃除）開始＋計測リセット。無効時: タイマー/リスナ停止＋全blob解放 |
| `teardownAnimatedThumbnails()` | `setAnimatedThumbnailEnabled(false)` に委譲（cleanupから呼ぶ） |
| `ingestAnimatedThumbnailFrame(id, img)` | **①(通常サムネ更新)からの給餌口**。①がcrossOriginで読んだ画像を受け取り再取得せずフレーム化（`storeFrameFromImage`）。**戻り値は `Promise<{url,seq}\|null>`＝①が静止サムネに出すべき画像**（null ならURL表示）。ガード: `!enabled / captureUnsupported / !id / !img` |
| `isAnimatedThumbnailEnabled()` | ①が「crossOriginで読んで給餌するか」を判断するフラグ。`enabled && !captureUnsupported`（taint後はfalse→①はURL表示へ自動フォールバック） |

内部の要点:
- **取得は①へ一本化（給餌方式）**: ②は自前取得しない。①(`sidebar.js updateThumbnailsFromStorage`)がプリロード成功画像を `ingestAnimatedThumbnailFrame` へ渡し、**返ってきたコマをそのまま静止サムネにも表示する**。配線は `main.js` の `setAnimThumbnailFeed`（②→①ではなく、①が②のフックを呼ぶ形＝循環import無し）。
  - 🔴 これにより「静止サムネ＝最新コマ」が**構造的に**成立する。以前は①が同じURLをもう1回ダウンロードして表示しており、2回の取得が食い違うと最新がアニメに含まれなかった（→ [09 項目AV](./09-gotchas-and-techdebt.md)）。②ON時のライブサムネ取得も1周期2回→1回になった。
- `storeFrameFromImage(id,img,b)`: 16×16知覚ハッシュ(`computeSignature`)→`signatureDiffers` で**変化時のみ** `canvas.toBlob`→`createObjectURL` をリングバッファ(N=5)に追加、超過分は `revokeObjectURL`（アニメ表示中カードは遅延revoke）。追加前に `ensureHydrated`→追加→`persistBuffer`。**戻り値は表示用ハンドル**（`displayHandleOf`＝最新コマの blob から**新しい object URL** を作る。リングバッファ側のURLを貸すと eviction や機能OFFの revoke で表示中の画像を消してしまう）。重複で保存しなかった時も**既存の最新コマ**を返す（見た目が同一なので不変条件は保てる）。
- `frameSeq`（モジュールスコープ）: フレームの通し番号。**バッファをまたいで単調増加・再利用しない**（IndexedDBからの復元分も採番し直す）。静止サムネ側の `dataset.thumbSeq` と突き合わせて末尾スロットの要否を決める。
- `pruneAbsentBuffers`: 20秒周期。フレーム取得はせず、リストから消えた番組を `releaseBuffer` でpruneするのみ（メモリ保持）。
- ホバー: `setHoverCard`/`tryStartAnim`/`stopAnim`。`.anim_thumb_overlay` 内の**2レイヤーを opacity でクロスフェード**巡回（開始は**2枚**から）。DOM再構築・枚数不足・非enabled時は停止（`document.contains`ガード）。
- 計測: `window.showAnimThumbStats()`（無条件公開）。ingested(①給餌)/loaded/stored/dupDiscarded/taintStops。enableごとリセット。※自前取得の計数(fetches/periodic/hover/errors)は、②の自前取得経路の撤去に伴い**常に0を表示するだけ**になっていたため削除した。
- 防御: taint検出時 `captureUnsupported=true`（`isAnimatedThumbnailEnabled()`→false で①をURL表示へ戻す）。①のcrossOrigin失敗時は①が平文で表示だけ確保し②へは渡さない。IndexedDB不可でも try/catch でメモリのみ継続。

### services/animFrameStore.js 🧪（動くサムネのフレーム永続化）
IndexedDB(`niconamasidebar`/`animFrames`, keyPath:`id`) に blob をそのまま保存。エラー時は静かに no-op/null（グレースフル）。

| エクスポート | 説明 |
|-------------|------|
| `saveFrames(id, {frames:[{blob,sig}], lastSig, updatedAt})` | put で置換保存 |
| `loadFrames(id)` | レコード取得（無ければ null） |
| `cleanupFrames(ttlMs, maxEntries)` | TTL失効を削除＋上限超過を古い順に削除 |

## main.js ★★★（エントリ／オーケストレータ）

最大ファイル。**初期化順序の制御・イベント配線・各層への委譲**が仕事。詳細な起動シーケンスは [04-data-flow.md](./04-data-flow.md)。

### トップレベル
- 全モジュールを import、`appState` を生成。
- `defaultOptions`（下記）・`options`・`elems` を用意し `appState.config/elements` に接続。
- `localStorage.programInfos` 未初期化なら `[]` で初期化。

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
| `setup()` ★ | サイドバー挿入→`reflectOptions()`→**3 Manager（Loading/AutoNext/Update）生成**→レイアウト調整→resize/ResizeObserver/theaterボタン/更新ボタン/オプションポップアップ/サイドバーボタン/境界線ドラッグを配線→**初期開閉状態を適用**→`autoNextProgram==='on'` なら watcher 開始→`beforeunload/pagehide`で`cleanup`（⚠️ `visibilitychange` の監視は**していない**＝655df9c で撤去） |
| `cleanup()` | `appState.cleanup()`＋`UpdateManager.destroyThumbnailLoop()`＋`destroySidebarLoop()`（更新ループ2本を停止）＋onResize解除＋モーダル閉じ |
| `handleSidebarOpenStateChange(open)` ★ | 開: `resetSidebarSchedule()` → `_refreshThumbSchedule()` → `performManualUpdate()` を RAF/フォールバックで実行。**ループの起動はしない**（setup で起動済み）。**閉: 何もしない**（2026-07-31。閉じて止まるのは2つの取得だけで、それは各 tick が `isOpen` を見て素通りする形に一本化。⚠️ ここに `clearTimer('autoNext')` を書き戻すと `scheduled` が残って自動移動が二度と動かなくなる＝項目AF。verify:loop が機械で見ている） |
| `updateSidebar`（ラッパー） | AutoNextManager へ注入される番組終了時のリスト更新。`updateManager.updateSidebar()` の戻り値が非 null の時だけ、**自分が始めたセッションを自分で閉じる**（旧実装では誰も閉じず、定期チェーンの無条件 finish が偶然の回収役になっていた） |
| `hideAutoNextModal`, `start/stopLiveStatusWatcher` | AutoNextManager へ委譲（`ensure/showModal`・`scheduleNavigation` は AutoNextManager が内部で直接呼ぶため main.js ラッパーは 2026-07-11 整理で削除） |
| `chrome.storage.onChanged` リスナー ★ | 設定変更を `options` に反映し、`isOpenSidebar`→開閉処理、`updateProgramsInterval`→タイマー再起動、`autoNextProgram`→watcher開始/停止 |
| `resetSidebarSchedule` | UpdateManager へ委譲（次回取得の期限を置き直すだけ。ループは作らない） |
| `getOptions()` | `storage.getOptions(defaultOptions)` |
| `insertSidebar()` ★ | `buildSidebarShell` の結果を `body` 先頭に挿入、`#optionContainer` に設定HTMLを挿入（**body直下へは移動しない＝サイドバー内に保持**）、`elems.sidebar` 等を確定、body を `display:flex` に、`#root` を `flexGrow:1` に |
| `applyTheme(theme)` ✅新規 | `document.body` に `nicosidebar-light` クラスをトグル（`theme==='light'`）。CSS変数(`--sb-*`)が切り替わる。setup時＋onChangedで適用。`input[name="sidebarTheme"]` のラジオで `dark`⇄`light`、`setSidebarTheme` で保存 |
| `finishLoadingSession`, `performManualUpdate`, `updateSidebar` | 各 Manager への委譲ラッパー（実処理は各 Manager のメソッドが担う） |
| `sortPrograms(container)` | `sortProgramsUtil(container, options.programsSort)` |
| `reflectOptions()` | `setupOptionsHandler(options, sortPrograms)` |

### 設定パネルの表示（setup内）
`#setting_options`（歯車）クリックで `.sidebar_body` に `.show-settings` をトグル → **番組リストと設定を入れ替え**（CSSで `#liveProgramContainer`/`#api_error` を隠し `#optionContainer` を表示）。設定内の `#settings_close`（×）または Esc で番組リストへ戻る。ポップアップの `placePopup`/`onDocClick` 等は廃止。

> ✅ 死んでいた `clearTimer('queueRestart')`（未宣言キー）は `stopAllTimers` から削除済み（2026-07-11）。その `stopAllTimers` 自体も、閉じた時に止めるものが無くなったため撤去した（2026-07-31・項目AX）。
> ✅ `AppState.handlers` に `reloadBtn` を宣言追加したため、更新ボタンの `setHandler('reloadBtn', ...)` が実効化（2026-07-11）。
