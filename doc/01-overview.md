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
サイドバーが開いている間、3系統のタイマーが回る
        ├─ sidebar  : updateProgramsInterval 秒ごとに番組リストを再取得（既定120秒）
        ├─ thumbnail: updateThumbnailInterval 秒ごとにライブサムネを更新（既定20秒）
        └─ todo     : 番組詳細取得キュー(ProgramInfoQueue)をレート制限付きで処理
        │
        ▼
番組終了を検知(status.js)したら（自動移動ON時）カウントダウン後に次番組へ location.assign
```

- **2種類のAPI**を使う（詳細は [05-external-api.md](./05-external-api.md)）:
  1. **通知ボックスAPI** … フォロー中の放送中番組の「一覧」（軽量）
  2. **番組詳細API** … 番組1件ごとの詳細（ライブサムネURL・配信者情報など、重いのでキュー＋レート制限）
- 一覧APIで得た番組を即描画 → 各番組の詳細をキューで順次取得してサムネ・配信者名等を肉付け、という2段構え。

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
│   │   ├── api.js             #   ニコ生API呼び出し（fetch）
│   │   ├── queue.js           #   番組詳細取得キュー（レート制限）
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
│   ├── debug/apiStats.js      # API呼び出し統計（window.showApiStats）
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
| toDolists / キュー | 番組詳細を順次取得するための待ち行列（`ProgramInfoQueue`） |
| ローディングセッション | 一連の更新処理をまとめて「読み込み中」表示する単位（`LoadingManager`） |

さらに詳しい用語集は [05-external-api.md](./05-external-api.md) 末尾を参照。
