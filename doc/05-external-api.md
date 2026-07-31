# 05. 外部API・DOMセレクタ・ストレージ・用語集

ニコ生側の依存（API・DOM）と自前ストレージを一覧化。**ニコ生仕様変更で壊れやすい箇所**の把握用。

---

## 1. 外部データソース（API）

エンドポイント定数は `src/config/constants.js`。**リスト**の実装は `src/services/api.js`、**番組詳細**の実装は `src/services/followPageSource.js`（フォロー中ページの公開フロントJSON API）。

| 種別 | URL | 用途 | 定数/箇所 |
|------|-----|------|----------|
| リストAPI | `https://papi.live.nicovideo.jp/api/relive/notifybox.content.php` | フォロー中の放送中番組リスト（並び順の元） | `notifyboxAPI` |
| 詳細フロントAPI | `https://live.nicovideo.jp/front/api/pages/follow/v1/programs` | 放送中フォロー番組の**全詳細をJSONで一括取得**（`?status=onair&offset=&limit=`／ページング対応） | `followApiUrl`（`followPageSource.js` 内で定義） |
| 詳細API（補完専用） | `https://api.cas.nicovideo.jp/v1/services/live/programs` | フロントAPIがライブサムネを返さない番組（**放送直後で未生成**など）のサムネ補完だけに使う | `liveInfoAPI` |

> リスト＝notifybox、詳細＝フォロー中ページ・フロントAPIの**2ソース構成**。両者を `UpdateManager.updateSidebar` が `Promise.all` で並列取得し、フロントAPI結果を storage へ upsert してからカードを組む（→ [04-data-flow](./04-data-flow.md)）。**従来の1番組=詳細API×Nのキューは廃止**（詳細はフロントAPIのJSONで全件一括入手）。詳細API（`liveInfoAPI`）は撤去せず、**サムネが空の番組の補完専用**として残す（§1-2）。

### 1-1. フォロー中番組リスト — `fetchLivePrograms(rows=100)`（`api.js`）
- **リクエスト**: `GET ${notifyboxAPI}?rows=100`、**`credentials:'include'`（Cookie送信）**。ログイン状態でフォロー番組を取得するためCookieが必要。
- **重複排除**: `liveProgramsInFlight`(Map, key=`rows`) でin-flight共有、`finally`で削除。
- **成功判定**: `meta.status===200 && data.notifybox_content`。**戻り値は `data.notifybox_content`（配列）**。失敗時 `false`。
- **失敗時UI**: `updateSidebar` が **notifybox とフォローAPIの両方**に失敗した時だけ `#api_error` を `block`（ログイン誘導）表示。片方でも取れていれば描画するので出さない。
- **1行の実測形**: `{ id:"<lvなし数値>", title, thumbnail_url, community_name, provider_type, elapsed_time }`。
  - `community_name` / `thumbnail_url` は**レガシー名**で、中身は**配信者名**と**配信者アイコン**（user は `…/nicoaccount/usericon/<上位>/<userId>.jpg`、channel は `…/comch/channel-icon/128x128/ch<数字>.jpg`）。コミュニティ廃止後もキー名だけが残っている。
  - `mapNotifyboxRowToInfo()`（`api.js`）が内部 programInfo 形へ写像し、`_mergeSources` がフォローAPI未着の新着番組に使う。アイコンURLから配信者IDも復元する（notifybox は ID を直接返さない）。
  - ⚠️ **`thumbnail_url` を `thumbnailUrl` に入れないこと**（アイコンをライブサムネとして20秒ごとに取り直す＝doc/09 項目AA の再発）。カードの表示フォールバック専用。
  - 応答形が変わったら `fetchLivePrograms` が **1回だけ `console.warn`** する（正常時は無言。名前とアイコンが黙って消える壊れ方を検知するため）。
- **リスト要素で参照するフィールド**: `program.id`（**lvなし数値**）、`program.title`、`community_name`、`thumbnail_url`、`provider_type`。
  - 詳細はフロントAPI由来（`lv`付きで格納）を `programInfos.find(info.id==='lv'+program.id)` で突合。突合できない番組（フロントAPI取得失敗など）はリスト要素そのまま `makeProgramElement` に渡り、タイトルのみの暫定描画になる。ページングで全件取得するため、放送中フォローが100件を超えても詳細が付く（→ §1-2）。

### 1-2. 番組詳細 — `fetchFollowedProgramsViaPage()`（`followPageSource.js`）
- **リクエスト**: `GET ${followApiUrl}?status=onair&offset=<0始まりページ番号>&limit=100`、**`credentials:'include'`（Cookie送信）**。フォロー中ページ（`.../follow?status=onair`）が「もっと見る」で叩く公開フロントJSON API を直接呼ぶ。
- **応答形**: `{ data: { programs: [...], total: N } }`。`programs[]` の1要素 = 1番組（`id:"lv..."`, `title`, `listingThumbnail`, `flippedListingThumbnail`(固定画像運用の番組のみ＝ライブスクショ), `watchPageUrl`, `providerType`, `liveCycle`, `beginAt`（ミリ秒エポック）, `endAt`, `isFollowerOnly`, `isPayProgram`, `programProvider:{id,name,icon,iconSmall}`, `statistics:{watchCount,commentCount}`, `timeshift`）。
- **変換**: 各 `programs[]` を `mapApiProgramToInfo` で**従来の詳細API相当の内部 programInfo 形**に写像。`makeProgramElement` / `resolveLiveThumbnailBaseUrl` / `calculateActivePoint` がそのまま読めるshape。
- **ページング（実装済み）**: `offset` は**0始まりのページ番号**（`offset=0` が先頭 `limit` 件、`offset=1` が次の `limit` 件＝items[N*limit .. N*limit+limit)）。`offset=0,1,2,…` とループし、`id` で重複排除しながら `total` 件を取り切るまで加算取得する。安全上限 `MAX_PAGES=5`（最大500件）。通常は **1リクエスト**（`limit=100` で放送中フォロー<100件を1発カバー）。同時放送フォローが100件超でも**全番組に詳細が付く**（旧「約70件超はタイトルのみ」の制限は解消）。
- **戻り値**: 内部 programInfo 配列。失敗（未ログイン/構造変化/HTTPエラー/通信エラー）時は **`null`**（フォールバックなし＝その周は詳細が古いまま）。クラッシュはしない（`updateSidebar` の番組ごと try/catch ＋ `makeProgramElement` の `String(id)`）。
- **定数**（`followPageSource.js` 内）: `followApiUrl` / `PAGE_LIMIT=100` / `MAX_PAGES=5` / `MAX_DETAIL_FALLBACK=30`。

#### `mapApiProgramToInfo` が生成する内部 programInfo の全フィールド
フロントAPIの1番組（`data.programs[]`）→ 以下へ写像。
| フィールド | 由来（`p.*`）/型 | 用途・参照箇所 |
|-----------|-------|--------------|
| `id` | `id`（`"lv..."`、**lv付き**で格納・照合） | localStorageキー、`makeProgramElement`（`.replace('lv','')`でcontainer id化）、`programInfos.find(info.id==='lv'+program.id)` の突合 |
| `title` | `title`（既定 `'タイトル不明'`） | 番組タイトル |
| `providerType` | `providerType` を `'user'`/`'channel'` へ写像（`mapProviderType`：`channel`/`official`→channel、`community`等→user） | サムネURL・投稿者ページURL・保存可否の分岐 |
| `contentOwner.id` | `programProvider.id`（文字列化）→ 無ければ `socialGroup.id`（`ch…`） | ユーザー/チャンネルページURL生成 |
| `contentOwner.name` | `programProvider.name` → 無ければ `socialGroup.name` | 配信者名（既定 `''`） |
| `contentOwner.icon` | `programProvider.icon`／`iconSmall` → 無ければ `socialGroup.thumbnailUrl` | アイコン画像 |

> **channel は `programProvider` に id もアイコンも無い**（2026-07-31 実測・70件: community 67件は `programProvider.icon` が 67/67 埋まり `socialGroup` 無し、channel 3件は `icon` が 0/3 で `socialGroup:{id,name,thumbnailUrl}` が 3/3）。`socialGroup` を見ないと**チャンネルカードのアイコンは永久に空**になる（`fillMissingDetails` は「名前が空」でしか発火せず、名前は埋まっているので対象外）。
| `thumbnailUrl` | ライブスクショURL（`listingThumbnail` → `flippedListingThumbnail` の順に `isLiveScreenshotUrl` 通過時のみ） | サムネのベース/フォールバック（静的サムネ兼用）。空なら §後述の補完対象 |
| `liveScreenshotThumbnailUrls.middle` | ライブスクショURL（同上、`thumb` があれば） | **user配信**のライブサムネ（`?cache=<ms>` 付与） |
| `large1280x720ThumbnailUrl` | ライブスクショURL（同上） | **channel配信**のライブサムネ優先URL |
| `isMemberOnly` | `isFollowerOnly` | `computeNext` で true ならサムネ更新停止（`key:'member'`） |
| `comments` | `statistics.commentCount` | `calculateActivePoint`（人気度） |
| `viewers` | `statistics.watchCount` | `calculateActivePoint` |
| `onAirTime.beginAt` | `beginAt`（**ミリ秒エポック**）→ ISO文字列 | `calculateActivePoint` の経過分算出 |
| `status` | `liveCycle` | 番組ステータス |
| `watchPageUrl` | `watchPageUrl` | 視聴ページURL |

- **サムネURLの選定**: サムネ枠は**2つ**ある。`listingThumbnail`（配信者が固定画像を設定していればそれ）と `flippedListingThumbnail`（**そのときのライブスクショ**）。一覧ページでこの手の番組のサムネが交互に入れ替わるのがこの2枚。`isLiveScreenshotUrl`（`/screenshot/` を含む・`dlive.nicovideo.jp` 由来）で**ライブスクショ形のときだけ採用**し、`listingThumbnail` → `flippedListingThumbnail` の順に見る（→ **常にライブスクショ**というユーザー要件）。どちらも通らなければ空文字にし、次項の補完対象になる。
  - 実測（2026-07-31・70件）: user 67件中22件が固定画像運用で、**22件すべてが flipped を持っていた**。うち20件は素直なスクショURL、2件は listing-thumbnail プロキシに包まれた形（`?url=…`）。
  - 🔴 **包まれた形を拾おうとして判定を緩めないこと。** 同じホストは固定画像・チャンネルアイコンも配っており、緩めるとそれらを「ライブサムネ」として登録してしまう（→ [09 項目AA](./09-gotchas-and-techdebt.md)）。包まれた分は詳細APIの補完に回す。
  - 固定画像の番組が居るのに flipped から1件も回収できなかった時だけ **1回だけ `console.warn`**（正常時は無言。フィールドが消えても画面は何も変わらないので、ここでしか気付けない）。
- **穴の選択的補完**（`fillMissingDetails`）: `thumbnailUrl` が空の番組（**放送直後で未生成**／flipped が包まれた形だった番組）だけ、番組ごとの詳細API `fetchProgramInfo()`（`liveInfoAPI`）を叩いて `liveScreenshotThumbnailUrls` を回収する。上限 `MAX_DETAIL_FALLBACK=30`／サイクル。**この呼び出しは `fetchFollowedProgramsViaPage` の中で await される＝リスト描画がその応答を待つ**ので、件数が減ると更新そのものが速くなる（flipped の採用で実測22件→2件程度）。個別失敗は空のまま（次サイクルで再挑戦）。

### 1-3. 呼び出し制御
- **リスト＋詳細を毎サイクル同時取得**: `updateSidebar` が `Promise.all([fetchLivePrograms(100), _refreshDetailsViaScrape()])` を実行。取得結果は**和集合**にする（`_mergeSources`）。前者は notifybox（`data.notifybox_content`）、後者はフォロー中ページ・フロントAPI（`_refreshDetailsViaScrape` 内で `fetchFollowedProgramsViaPage` を呼ぶ）→ `upsertProgramInfos` で storage へ全件一括 upsert。
- **周期**: `updateProgramsInterval`（既定120秒、選択肢30/60/120/180）ごと＋手動更新（初回ロード・更新ボタン・タブ復帰・サイドバー再オープン）。⚠️ **裏タブでもスキップしない**（`visibilitychange` ハンドラは存在しない。655df9c で撤去済み）。
- **キュー廃止**: 詳細はキューを使わずフロントAPIのページングで全件取得するため、レート制限・`processInterval`・`maxRequestsPerSecond`・新番組の30秒先行スキャンは**いずれも撤去済み**。API監視デバッグ（`window.apiCallCounter` / `window.showApiStats`）も撤去。番組ごとの詳細API呼び出しは**穴の補完**（`fillMissingDetails`、上限30/サイクル）に限定して残る。

---

## 2. 生成・参照するニコ生ドメインURL（非API）

| URLパターン | 用途 | 生成箇所 |
|------------|------|---------|
| `https://live.nicovideo.jp/watch/${data.id}` | 番組カードのサムネリンク先 | `makeProgramElement` / `updateSidebar`（フォールバック `.../watch/lv${program.id}`） |
| `https://www.nicovideo.jp/user/${contentOwner.id}` | user配信の投稿者ページ / レガシー分岐（サムネURLの `/(\d+)\.jpg/` から抽出） | `makeProgramElement` |
| `https://ch.nicovideo.jp/${contentOwner.id}` | channel配信のチャンネルページ | `makeProgramElement` |
| `https://live.nicovideo.jp/follow?status=onair` | 詳細フロントAPIの元ページ（実取得は §1-2 の `front/api/pages/follow/v1/programs`）／ヘッダ「フォロー中の番組」リンクは `https://live.nicovideo.jp/follow` | `followPageSource.js` / `buildSidebarShell` |
| `https://account.nicovideo.jp/login` | API失敗時の `#api_error` 内ログインリンク | `buildSidebarShell` |

- **サムネ画像取得(GET)**: user=`liveScreenshotThumbnailUrls.middle`（`?cache=<ms>`）、channel=`large1280x720ThumbnailUrl`。いずれも**フロントAPI（or 補完詳細API）で storage に保存済みの安定URL**を、番組ごとの自己連鎖タイマー（基準 `updateThumbnailInterval`=20秒）がキャッシュバスター付きで再取得するだけ。例外として、ライブサムネ空かつ放送開始から `newProgramFastPollMs`=3分以内の若い user 番組だけ、各サイクルで詳細API(`fetchProgramInfo`)を1回追撃してライブスクショを補完する（`_fetchLiveThumbIfPendingYoung`）。TTL10秒・失敗バックオフ2〜60秒・最終フォールバック `images/loading.gif`。
- **現在番組IDの抽出**: `location.pathname.match(/\/watch\/(lv\d+)/)`（AutoNext）。遷移は `location.assign(nextHref)`。

---

## 3. ニコ生視聴ページに対して使うDOMセレクタ

ハッシュ付き動的クラスのため**部分一致セレクタ**を多用（`[class*="..."]`）。仕様変更に弱いので改修時は要注意。

### 3-1. 既存ページ要素（取得・改変）
| セレクタ | 変数/用途 |
|---------|-----------|
| `#root` | 元アプリルート。`flex-grow:1`、幅再計算（`setRootWidth`） |
| `#watchPage` | 視聴ページ本体。幅監視、`data-player-layout-mode` 参照 |
| `[class*="_player-section_"]` | プレイヤー領域。幅書き換え |
| `[class*="_leo-player_"]` | Leoプレイヤー。`height` 書き換え |
| `[class*="ga-ns-program-summary"]` | 番組サマリー。幅調整 |
| `[class*="_program-information-body-area_"]` | 番組情報ボディ。幅調整 |
| `nav[class*="_site-utility-footer_"]` | サイトフッター。幅調整 |
| `a[class*="_feedback-anchor_"]` | フィードバックアンカー。`right:0`（崩れ対策） |
| `button[class*="_fullscreen-button_"]` | フルスクリーンボタン（取得のみ） |
| `button[class*="_theater-button_"]` | シアターボタン。click で `adjustWatchPageChild` |
| `#enquete-placeholder` | アンケート枠。幅調整 |
| `[class*="_player-display_"]` | プレイヤー表示。`removeAttribute('style')` |
| `html[data-browser-fullscreen]` | フルスクリーン判定 |

### 3-2. 番組終了ガイド検出（自動移動トリガ）
`src/services/status.js`。MutationObserver を `document.body` に `{childList,subtree,attributes:['class']}` で attach し、以下のどちらかが揃った時に終了と判定する:
- 親: `[class*="program-end-guide"]`
- 子: `[class*="announcement"]` ＋ `[class*="next-action-area"]`（**視聴者が見る通常の形**。番組種別・配信者設定によらず無条件に描画される）
- または `[class*="satisfaction-level-enquete-panel"]`（**配信者本人**に満足度アンケートが出た形。この時 announcement / next-action-area は描画されない）

> 🔴 **`button[class*="broadcast-request-send-button"]` を条件に加えないこと。** ニコ生側の表示条件は
> `visualProviderTypeIsCommunity && !isBroadcaster && (!isLoggedIn || broadcasterBroadcastRequest.isEnabled)`
> （2026-07-31 に `nicolib` バンドルから確認）。**チャンネル/公式番組では常に出ず**、ユーザー生放送でも
> 配信者がリクエストを無効にしていれば出ない。旧実装はこれを必須にしていたため、自動移動が
> 「番組によっては毎回不発」という形で壊れていた（→ [09 項目AU](./09-gotchas-and-techdebt.md)）。

### 3-3. 自前挿入UIのセレクタ
`buildSidebarShell` が `body` afterbegin に注入（`#optionContainer` は body直下へ移動）。

| ID/クラス | 役割 |
|-----------|------|
| `#sidebar` / `#sidebar_container` | サイドバー外殻 |
| `#sidebar_line` / `#sidebar_button` / `#sidebar_arrow` | 開閉ボタン・ドラッグ境界線・矢印 |
| `#program_count` | 番組数表示 |
| `#reload_programs` | 更新ボタン（`.loading` トグル） |
| `#setting_options` | オプションボタン |
| `#api_error` | API失敗時のログイン誘導 |
| `#optionContainer` / `.container` / `#optionForm` | オプションポップアップ |
| `#liveProgramContainer` | 番組カード群（`replaceChildren` で全置換） |

**番組カードDOM構造**（`makeProgramElement`）:
```
div.program_container[id=<数値ID>, active-point=<数値>]
 ├ div.provider
 │   ├ a[href=user_page_url, target=_blank] > img[src=icon_url]
 │   └ div.provider_name[title]
 ├ div.program_thumbnail.program-card_
 │   └ a[href=thumbnail_link_url] > img.program_thumbnail_img[src, data-src]
 └ div.program_title[title]
```
- `img.program_thumbnail_img` の `dataset`: `key`(URL識別), `errors`(連続失敗数), `nextTryAt`(次回試行ms), `lastSuccessAt`(直近成功ms), `data-src`(フォールバックURL)。

**自動移動モーダル**（`AutoNextManager.ensureModal`, body追加）:
`#auto_next_modal` > `.backdrop` / `.dialog`（`.title` / `.message`>`#auto_next_count` / `.preview`>`#auto_next_provider`+`.thumb`>`#auto_next_thumb`+`#auto_next_title` / `.actions`>`#auto_next_cancel`）

**オプションフォームの input**（`#optionForm`）:
- `input[name="programsSort"]` = `newest`/`active`
- `input[name="updateProgramsInterval"]` = `30`/`60`/`120`/`180`（id は値ベース: `#updateProgramsInterval30` など）
- `input[name="autoOpen"]` = `1`(ON)/`2`(OFF)/`3`(状態記憶)
- `input[name="autoNextProgram"]` = `on`/`off`

---

## 4. ストレージキー一覧

### 4-1. `chrome.storage.local`（`permissions:["storage"]`）
| キー | 既定値 | 値 | 書込元 |
|------|--------|----|--------|
| `programsSort` | `'newest'` | `newest`/`active` | optionsHandler |
| `autoOpen` | `'3'` | `1`/`2`/`3` | optionsHandler |
| `updateProgramsInterval` | `'120'`（秒） | `30`/`60`/`120`/`180` | optionsHandler |
| `sidebarWidth` | `360` | 数値(px) | `setSidebarWidth`（ドラッグ確定） |
| `sidebarTheme` | `'light'` | `dark`/`light` | `setSidebarTheme`（設定パネル末尾のテーマトグル） |
| `isOpenSidebar` | `false` | boolean | `setIsOpenSidebar`（開閉トグル） |
| `autoNextProgram` | `'off'` | `on`/`off` | optionsHandler |

- 読み: `getOptions` が get→defaultマージ→**setで書き戻す副作用**あり。
- 監視: `chrome.storage.onChanged`（→ [04-data-flow §9](./04-data-flow.md)）。

### 4-2. `localStorage`
| キー | 内容 | 箇所 |
|------|------|------|
| `programInfos` | 番組詳細の配列（最大200件、`id`はlv付き、FIFOトリム、Quota超過時は半減再試行） | storage.js。起動時に無ければ `'[]'` |
| `LeoPlayer_ScreenSizeStore_kind` | **ニコ生本体**のプレイヤー画面サイズ設定。`auto` を含むかで自動サイズ判定。**読み取りのみ** | ui/layout.js |

### 4-3. `window` グローバル（デバッグ）
- `window.__testFollowScrape()`（`followPageSource.js`）: フォロー中ページ・フロントAPIの取得結果を件数＋所要ms＋`console.table` で表示（名前は歴史的経緯で `Scrape` のまま。実処理はAPI経路）。
- `window.showAnimThumbStats()`（`render/animatedThumbnail.js`）: 動くサムネの給餌/自前取得の統計表示。
- ※いずれも content script の isolated world に定義。DevToolsのコンソールで**本拡張の実行コンテキスト**を選ぶこと。
- **撤去済み**: 旧 `window.apiCallCounter` / `window.showApiStats`（API監視デバッグ `debug/apiStats.js`）は詳細APIキュー廃止に伴い削除。

---

## 5. ニコ生ドメイン用語集

| 用語 | 意味 | コード対応 |
|------|------|-----------|
| **フォロー中の番組** | フォロー済みユーザー/チャンネルの放送中生放送。**リスト=`notifyboxAPI`／詳細=`front/api/pages/follow/v1/programs` のフロントJSON API**（どちらもCookie送信・ページング対応） | `api.js` / `followPageSource.js`。ヘッダ→`/follow` |
| **視聴ページ / watch** | 生放送視聴ページ `.../watch/lvXXXX` | `content_scripts.matches`。ID=`lv\d+` |
| **番組ID / lvID** | `lv`+数値。数値が大きいほど新しい | リスト=数値 / 詳細・格納=lv付き の使い分けに注意 |
| **providerType** | 配信主体。`user`（ユーザー生）/ `channel`（チャンネル生） | サムネ・投稿者URL・保存可否の分岐 |
| **配信者名 / provider** | 配信者の表示名（user はユーザー名 / channel はチャンネル名）。⚠️ ニコ生の**コミュニティ機能は廃止済み**で、API のキー名（`community_name` / `providerType:'community'`）だけがレガシーとして残っている。表示・命名を引きずられないこと | `contentOwner.name` → `.provider_name` |
| **ライブサムネ** | 放送中の実映像サムネ。user=スクショ、channel=大サイズ画像 | user:`liveScreenshotThumbnailUrls.middle` / channel:`large1280x720ThumbnailUrl` |
| **メンバー限定(isMemberOnly)** | 会員限定番組。サムネ更新対象外 | `computeNext` で `key:'member'` |
| **人気度 / active-point** | 独自指標 `(viewers+1 + comments+1) / 経過分`。人気順ソートのキー | `calculateActivePoint`、DOM属性 `active-point` |
| **番組終了ガイド** | 番組終了時にニコ生が出す案内UI。自動移動トリガ | `program-end-guide` 配下の構成で判定（§3-2） |
| **自動移動（自動次番組）** | 終了後にサイドバー先頭の別番組へ10秒後に遷移 | `AutoNextManager` / `location.assign` |
| **シアターモード** | プレイヤー拡大表示 | `_theater-button_` click で再計算 |
| **画面サイズ 自動/固定** | プレイヤー表示サイズモード | `LeoPlayer_ScreenSizeStore_kind` |
| **追っかけ再生 / TS** | ※用語は一般的だが**本コードベースに専用実装・セレクタ・APIパラメータは無し**。本拡張は放送中番組の一覧・詳細・サムネ・自動移動のみ扱う | （該当実装なし） |

> ⚠️ 「追っかけ再生・TS」はソース中に対応処理が無い。README更新履歴 1.3.4 に「TSや追っかけ再生のシーク時…」の記述はあるが、これは**過去に存在したシーク位置ズレ対策**の名残で、現行コードには専用機能として残っていない（`window.dispatchEvent(new Event('resize'))` によるレイアウト補正が関連の可能性）。
