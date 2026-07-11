# 05. 外部API・DOMセレクタ・ストレージ・用語集

ニコ生側の依存（API・DOM）と自前ストレージを一覧化。**ニコ生仕様変更で壊れやすい箇所**の把握用。

---

## 1. 外部APIエンドポイント

URLは `src/config/constants.js` にリテラル定義。実装は `src/services/api.js`。

| 定数 | URL | 用途 |
|------|-----|------|
| `notifyboxAPI` | `https://papi.live.nicovideo.jp/api/relive/notifybox.content.php` | フォロー中の放送中番組リスト |
| `liveInfoAPI` | `https://api.cas.nicovideo.jp/v1/services/live/programs` | 番組詳細（1番組） |

### 1-1. フォロー中番組リスト — `fetchLivePrograms(rows=100)`
- **リクエスト**: `GET ${notifyboxAPI}?rows=100`、**`credentials:'include'`（Cookie送信）**。2APIのうちCookie送信はこちらのみ（ログイン状態でフォロー番組を取得するため）。
- **重複排除**: `liveProgramsInFlight`(Map, key=`rows`) でin-flight共有、`finally`で削除。
- **成功判定**: `meta.status===200 && data.notifybox_content`。**戻り値は `data.notifybox_content`（配列）**。失敗時 `false`。
- **失敗時UI**: `getLivePrograms` が `#api_error` を `block`（ログイン誘導）表示。
- **リスト要素で参照するフィールド**: `program.id`（**lvなし数値**）、`program.title`。
  - ⚠️ リスト要素をそのまま `makeProgramElement` に渡すと `data.id.includes('lv')` が偽 → **レガシー分岐**に入る（詳細取得前の暫定描画）。

### 1-2. 番組詳細 — `fetchProgramInfo(liveId)`
- **リクエスト**: `GET ${liveInfoAPI}/lv${id}`（`liveId`は**lvなし**で渡しURL生成時に `lv` 付与）。**Cookie指定なし**。
- **重複排除**: `programInfoInFlight`(Map, key=`liveId`)。
- **成功判定**: `meta.status===200 && data`。**戻り値は `response.data`**。失敗時 `undefined`。

#### `data`（番組詳細）で参照される全フィールド
| フィールド | 例/型 | 用途・参照箇所 |
|-----------|-------|--------------|
| `id` | `"lv123456"`（**lv付き**で格納・照合） | localStorageキー、`makeProgramElement`（`.replace('lv','')`でcontainer id化）、`programInfos.find(info.id==='lv'+program.id)` の突合 |
| `title` | string | 番組タイトル（既定 `'タイトル不明'`） |
| `providerType` | `'user'` / `'channel'` | サムネURL・投稿者ページURL・保存可否の分岐 |
| `contentOwner.id` | string/number | ユーザー/チャンネルページURL生成 |
| `contentOwner.name` | string | コミュニティ名（既定 `'コミュニティ名不明'`） |
| `contentOwner.icon` | URL | アイコン画像 |
| `thumbnailUrl` | URL | サムネのベース/フォールバック |
| `liveScreenshotThumbnailUrls.middle` | URL | **user配信**のライブサムネ（`?cache=<ms>` 付与） |
| `large1280x720ThumbnailUrl` | URL | **channel配信**のライブサムネ優先URL |
| `isMemberOnly` | boolean | `computeNext` で true ならサムネ更新停止（`key:'member'`） |
| `comments` | number | `calculateActivePoint`（人気度） |
| `viewers` | number | `calculateActivePoint` |
| `onAirTime.beginAt` | 日時文字列 | `calculateActivePoint` の経過分算出 |

- **保存スキップ条件**（`ProgramInfoQueue.fetchAndSave`）: `providerType==='user' && !liveScreenshotThumbnailUrls` は保存せず `false`。

### 1-3. 呼び出し制御
- **詳細取得はキュー経由**（`ProgramInfoQueue`）: 1件ずつ、`processInterval=250ms`、**`maxRequestsPerSecond=4`（4件/秒）**、`maxSize=200`。フォアグラウンドは `requestIdleCallback` 併用、バックグラウンドは間隔10倍。
- **リスト取得**は `updateProgramsInterval`（既定120秒、選択肢60/120/180）ごと＋手動更新。
- **監視**: `window.apiCallCounter`（`debug/apiStats.js`）。5分ごとに直近1分200回超で `console.warn`（上限4件/秒=240件/分）。`window.showApiStats()` で手動確認。

---

## 2. 生成・参照するニコ生ドメインURL（非API）

| URLパターン | 用途 | 生成箇所 |
|------------|------|---------|
| `https://live.nicovideo.jp/watch/${data.id}` | 番組カードのサムネリンク先 | `makeProgramElement` / `updateSidebar`（フォールバック `.../watch/lv${program.id}`） |
| `https://www.nicovideo.jp/user/${contentOwner.id}` | user配信の投稿者ページ / レガシー分岐（サムネURLの `/(\d+)\.jpg/` から抽出） | `makeProgramElement` |
| `https://ch.nicovideo.jp/${contentOwner.id}` | channel配信のチャンネルページ | `makeProgramElement` |
| `https://live.nicovideo.jp/follow` | ヘッダ「フォロー中の番組」リンク | `buildSidebarShell` |
| `https://account.nicovideo.jp/login` | API失敗時の `#api_error` 内ログインリンク | `buildSidebarShell` |

- **サムネ画像取得(GET)**: user=`liveScreenshotThumbnailUrls.middle`（`?cache=<ms>`）、channel=`large1280x720ThumbnailUrl`。TTL10秒・失敗バックオフ2〜60秒・最終フォールバック `images/loading.gif`。
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
`src/services/status.js`。以下が**全て揃う**時に終了と判定（MutationObserver を `document.body` に `{childList,subtree,attributes:['class']}` で attach）:
- 親: `[class*="program-end-guide"]`
- 子: `[class*="announcement"]` ＋ `[class*="next-action-area"]` ＋ `button[class*="broadcast-request-send-button"]`

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
 ├ div.community
 │   ├ a[href=user_page_url, target=_blank] > img[src=icon_url]
 │   └ div.community_name[title]
 ├ div.program_thumbnail.program-card_
 │   └ a[href=thumbnail_link_url] > img.program_thumbnail_img[src, data-src]
 └ div.program_title[title]
```
- `img.program_thumbnail_img` の `dataset`: `key`(URL識別), `errors`(連続失敗数), `nextTryAt`(次回試行ms), `lastSuccessAt`(直近成功ms), `data-src`(フォールバックURL)。

**自動移動モーダル**（`AutoNextManager.ensureModal`, body追加）:
`#auto_next_modal` > `.backdrop` / `.dialog`（`.title` / `.message`>`#auto_next_count` / `.preview`>`#auto_next_provider`+`.thumb`>`#auto_next_thumb`+`#auto_next_title` / `.actions`>`#auto_next_cancel`）

**オプションフォームの input**（`#optionForm`）:
- `input[name="programsSort"]` = `newest`/`active`
- `input[name="updateProgramsInterval"]` = `60`/`120`/`180`
- `input[name="autoOpen"]` = `1`(ON)/`2`(OFF)/`3`(状態記憶)
- `input[name="autoNextProgram"]` = `on`/`off`

---

## 4. ストレージキー一覧

### 4-1. `chrome.storage.local`（`permissions:["storage"]`）
| キー | 既定値 | 値 | 書込元 |
|------|--------|----|--------|
| `programsSort` | `'newest'` | `newest`/`active` | optionsHandler |
| `autoOpen` | `'3'` | `1`/`2`/`3` | optionsHandler |
| `updateProgramsInterval` | `'120'`（秒） | `60`/`120`/`180` | optionsHandler |
| `sidebarWidth` | `360` | 数値(px) | `setSidebarWidth`（ドラッグ確定） |
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
- `window.apiCallCounter`（`{getLivePrograms, fetchProgramInfo, totalCalls, startTime, recentTimestamps, getLiveProgramsTimestamps}`）
- `window.showApiStats`（統計表示関数）

---

## 5. ニコ生ドメイン用語集

| 用語 | 意味 | コード対応 |
|------|------|-----------|
| **フォロー中の番組** | フォロー済みユーザー/チャンネルの放送中生放送リスト | `notifyboxAPI`（Cookie送信）。ヘッダ→`/follow` |
| **視聴ページ / watch** | 生放送視聴ページ `.../watch/lvXXXX` | `content_scripts.matches`。ID=`lv\d+` |
| **番組ID / lvID** | `lv`+数値。数値が大きいほど新しい | リスト=数値 / 詳細・格納=lv付き の使い分けに注意 |
| **providerType** | 配信主体。`user`（ユーザー生）/ `channel`（チャンネル生） | サムネ・投稿者URL・保存可否の分岐 |
| **コミュニティ名 / provider** | 配信者表示名 | `contentOwner.name` → `.community_name` |
| **ライブサムネ** | 放送中の実映像サムネ。user=スクショ、channel=大サイズ画像 | user:`liveScreenshotThumbnailUrls.middle` / channel:`large1280x720ThumbnailUrl` |
| **メンバー限定(isMemberOnly)** | 会員限定番組。サムネ更新対象外 | `computeNext` で `key:'member'` |
| **人気度 / active-point** | 独自指標 `(viewers+1 + comments+1) / 経過分`。人気順ソートのキー | `calculateActivePoint`、DOM属性 `active-point` |
| **番組終了ガイド** | 番組終了時にニコ生が出す案内UI。自動移動トリガ | `program-end-guide` 配下3要素で判定 |
| **自動移動（自動次番組）** | 終了後にサイドバー先頭の別番組へ10秒後に遷移 | `AutoNextManager` / `location.assign` |
| **シアターモード** | プレイヤー拡大表示 | `_theater-button_` click で再計算 |
| **画面サイズ 自動/固定** | プレイヤー表示サイズモード | `LeoPlayer_ScreenSizeStore_kind` |
| **追っかけ再生 / TS** | ※用語は一般的だが**本コードベースに専用実装・セレクタ・APIパラメータは無し**。本拡張は放送中番組の一覧・詳細・サムネ・自動移動のみ扱う | （該当実装なし） |

> ⚠️ 「追っかけ再生・TS」はソース中に対応処理が無い。README更新履歴 1.3.4 に「TSや追っかけ再生のシーク時…」の記述はあるが、これは**過去に存在したシーク位置ズレ対策**の名残で、現行コードには専用機能として残っていない（`window.dispatchEvent(new Event('resize'))` によるレイアウト補正が関連の可能性）。
