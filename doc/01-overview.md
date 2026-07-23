# 01. 概要（Overview）

## 1.1 このプロダクトは何か

**ニコ生サイドバー**は、ニコニコ生放送の**番組視聴ページ**にサイドバーを追加する Google Chrome 拡張機能です。

- サイドバーには、ログインユーザーが**フォロー中の「放送中」番組**が、**ライブサムネイル**（配信中の実映像スクリーンショット）付きで一覧表示されます。
- 内容は**定期的に自動更新**され、番組を視聴しながら別の番組を監視できます。
- 番組終了時に**次の番組へ自動移動**する機能もあります。
- 作者(MynicoTools / soratobitai)による姉妹ツール「別窓くん」との併用を想定した作りになっています（`?popup=on` のポップアップ時は起動しない、など）。

対象URL: `https://live.nicovideo.jp/watch/*`（`manifest.json` の `content_scripts.matches`）

## 1.2 技術スタック

| 項目 | 内容 |
|------|------|
| 種別 | Chrome拡張機能 / **Manifest V3** |
| 構成 | **content script のみ**（background/service worker・popup・options ページはなし） |
| 言語 | 素の JavaScript（ES Modules で記述、フレームワーク未使用） |
| ビルド | **Vite 5**（`rollupOptions` で **IIFE** 出力、minify なし、target es2015） |
| 出力 | `dist/main.js`（1ファイル）＋ `dist/style.css` ＋ アセット |
| 権限 | `storage` のみ |
| 永続化 | 設定 = `chrome.storage.local` / 番組詳細キャッシュ = ページの `localStorage` |
| 外部依存(実行時) | なし（npm ランタイム依存ゼロ。devDependencies に vite / glob / rimraf のみ） |

## 1.3 動作の全体像（ざっくり）

```
[ニコ生 watch ページ] に content script (main.js) が document_start で注入される
        │
        ▼
DOMContentLoaded で setup()
        │
        ├─ サイドバーDOMを body 先頭に注入（buildSidebarShell）
        ├─ 各Managerを生成（Loading / AutoNext / Update）
        ├─ リサイズ監視・ボタン・オプションポップアップ等を配線
        ├─ オプションに従い初期状態でサイドバーを開く/閉じる
        │
        ▼
サイドバーが開いている間、2系統のタイマーが回る（＋自動移動の監視）
        ├─ sidebar  : updateProgramsInterval 秒ごとに「リスト＋詳細」を再取得（既定120秒。非表示タブ時はスキップ）
        └─ thumbnail: 番組ごとの独立・自己連鎖タイマー。各カードが「自分の <img> を1件更新→画像読み込み完了を待って→updateThumbnailInterval(既定20秒)後に次サイクル」を回す。周期＝20秒＋その回の作業時間なので少しずつ自然にズレる（一斉切替を避けるドリフト）。非表示タブ中は画像更新を行わずタイマーだけ回す（可視で再開）
        │
        ▼
番組終了を検知(status.js)したら（自動移動ON時）カウントダウン後に次番組へ location.assign
```

- **データソースは2つ**（詳細は [05-external-api.md](./05-external-api.md)）:
  1. **通知ボックスAPI**（`fetchLivePrograms`）… フォロー中の放送中番組の「一覧＝並び順」のみ（軽量）
  2. **フォロー中ページのフロントJSON API**（`followPageSource` / `fetchFollowedProgramsViaPage`）… フォロー中ページ（`live.nicovideo.jp/follow?status=onair`）が「もっと見る」で叩く公開フロントAPI `GET https://live.nicovideo.jp/front/api/pages/follow/v1/programs?status=onair&offset=<0始まりページ番号>&limit=100`（`credentials: include`、応答 `{ data: { programs: [...], total: N } }`）を直接呼び、放送中フォロー番組の**全詳細**（タイトル・視聴者数・コメント数・ライブサムネURL・providerType・会員限定・開始時刻）を一括で得る。1番組は `mapApiProgramToInfo` で内部 `programInfo` 形へ変換する。
- **ページングは実装済み**: `fetchFollowedProgramsViaPage` は `offset=0,1,2,...`（`offset` は0始まりのページ番号。ページNは全体の `N*100 .. N*100+100` 件）とループしながら `programs` を（`id` で重複排除して）蓄積し、`total` に達するまで取り切る。安全上限 `MAX_PAGES=5`。通常は1リクエスト（`limit=100` で同時放送100件未満をカバー）で済み、**100件を超えるフォロー番組でも全詳細**が揃う。
- `updateSidebar` は上の2つを **`Promise.all` で並列取得** → 取得結果を `localStorage` へ upsert → その `localStorage` を読んで**詳細込みでカードを生成**し、`programsSort` で並べる。詳細がリストと同時に揃うため、**初回描画からソートが確定**する（「詳細が揃うまで新着順で待つ」整列確定機構は不要）。
- 従来の「1番組=1詳細API×N＋レート制限キュー」は**廃止**し、フロントAPIの一括取得に置換した。取得に失敗した周は詳細が古い/欠けるだけで、旧詳細APIへの**フォールバックはしない**（意図的）。

> **サムネの補完（選択的フォールバック）**: フロントAPIは `listingThumbnail` 1枠しか返さず、配信者が固定画像を設定していると（放送直後で未生成のときも）ライブスクショが取れない。ライブスクショ以外は表示しない方針（`isLiveScreenshotUrl` フィルタ）なので、そうした番組は `thumbnailUrl=''` になる。空になった番組**だけ**、`fillMissingLiveThumbnails` が番組ごと詳細API（`fetchProgramInfo`）を叩いて `liveScreenshotThumbnailUrls` を補完する。空は通常0〜少数で、1サイクルあたり `MAX_DETAIL_FALLBACK=30` 件を上限とする（旧方式の「全番組×詳細API」の重さは避けたまま穴だけ埋める）。`updateSidebar` の番組ごと try/catch と `makeProgramElement` の ID 文字列化でクラッシュはしない。

## 1.4 ディレクトリ構成

```
app/
├── manifest.json          # 拡張のマニフェスト（MV3）
├── vite.config.js         # ビルド設定（IIFE出力 + アセットコピー）
├── package.json           # scripts（dev/build/watch 等）
├── scripts/
│   └── remove-maps.js     # ビルド後に dist の *.map を削除（postbuild）
├── icons/                 # 拡張アイコン 16/48/128
├── images/                # loading.gif / reload.png / options.png（web_accessible_resources）
├── src/
│   ├── main.js            # ★エントリ／全体オーケストレータ（最大ファイル）
│   ├── config/constants.js    # 定数（APIエンドポイント・各種間隔・TTL）
│   ├── core/AppState.js       # 全状態を集約するクラス
│   ├── services/              # 外部I/O層
│   │   ├── api.js             #   API呼び出し（fetchLivePrograms＝一覧/並び順 ＋ fetchProgramInfo＝サムネ補完用の番組詳細）
│   │   ├── followPageSource.js #  フォロー中ページのフロントJSON APIをページングして全番組詳細を一括取得
│   │   ├── animFrameStore.js  #   動くサムネのフレーム永続化（IndexedDB）
│   │   ├── status.js          #   番組終了検知（MutationObserver）
│   │   └── storage.js         #   chrome.storage / localStorage ラッパ
│   ├── managers/              # 副作用の強い処理群
│   │   ├── UpdateManager.js   #   更新タイマー＆描画更新の司令塔
│   │   ├── LoadingManager.js  #   ローディング“セッション”管理
│   │   └── AutoNextManager.js #   自動移動（モーダル＆遷移）
│   ├── render/sidebar.js      # サイドバーDOM生成・サムネ更新ロジック
│   ├── ui/
│   │   ├── layout.js          #   視聴ページ本体の幅調整・カラム数計算
│   │   └── sidebarControl.js  #   開閉・幅ドラッグ制御
│   ├── handlers/optionsHandler.js  # オプションフォームの反映・保存
│   ├── utils/
│   │   ├── dom.js             #   debounce
│   │   ├── error.js           #   エラー分類・ログ（handleError）
│   │   └── sorting.js         #   ソート（新着順/人気順）
│   └── styles/main.css        # 全スタイル
└── doc/                       # ★このドキュメント
```

各モジュールの責務は [02-architecture.md](./02-architecture.md)、関数レベルの詳細は [03-module-reference.md](./03-module-reference.md) を参照。

## 1.5 用語（最小限）

| 用語 | 意味 |
|------|------|
| watch ページ | ニコ生の番組視聴ページ (`/watch/lvXXXXXXXX`)。拡張が動く唯一の場所 |
| フォロー中の番組 | ログインユーザーがフォローしているユーザー/チャンネルの放送中番組 |
| ライブサムネ | 配信中の実映像から生成されるスクリーンショット画像（時間経過で変化） |
| 番組ID(lvID) | `lv` + 数字。数字が大きいほど新しい番組（新着順ソートに利用） |
| providerType | 配信主体の種別。`user`（ユーザー生放送）/ `channel`（チャンネル生放送） |
| フォロー中ページのフロントAPI | `follow?status=onair` が「もっと見る」で叩く公開フロントAPI（`front/api/pages/follow/v1/programs`）をページングして全番組詳細を一括入手する方式（`followPageSource`） |
| ローディングセッション | 一連の更新処理をまとめて「読み込み中」表示する単位（`LoadingManager`） |

さらに詳しい用語集は [05-external-api.md](./05-external-api.md) 末尾を参照。
