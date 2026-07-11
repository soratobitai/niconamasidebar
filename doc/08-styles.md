# 08. スタイル（CSS）インベントリ

`src/styles/main.css`（542行）の全セレクタと役割。DOM構造は `render/sidebar.js`・`AutoNextManager.js` が生成する。

- テーマ: **ダーク**（サイドバー本体 `#111` 背景 / `#ccc` 文字）。オプションと自動移動モーダルは別配色。
- サイドバーは `position: sticky; top:0; height:100vh`。開閉は**幅(width)を 0 ⇔ 実幅** に変え、`transition: all .5s` でアニメ。

## 8.1 サイドバー枠・開閉

| セレクタ | 役割 |
|---------|------|
| `#sidebar` | サイドバー本体。sticky・全高・ダーク・スクロールバー非表示（`scrollbar-width:none` ＋ `::-webkit-scrollbar{display:none}`） |
| `.sidebar_transition` | 幅変化のトランジション（ドラッグ中は一時的に外す） |
| `.sidebar_display_none` | 非表示ユーティリティ（`display:none`） |
| `#sidebar_container` | 内側コンテナ。`padding:10px 8px 80px` |
| `#sidebar_line` | サイドバー左の境界線（幅5px、ドラッグでリサイズ、`z-index:999`） |
| `.col_resize` | ドラッグ可能時のカーソル（`col-resize`） |
| `#sidebar_button` | 境界線上の開閉ボタン（丸みのあるタブ、縦中央付近 top:44%） |
| `#sidebar_arrow` | ボタン内の矢印（45度回転の枠線） |
| `.sidebar_arrow_re` | 開状態で矢印を反転（`rotate(-135deg)`） |

## 8.2 ヘッダー（タイトル・更新・オプション）

| セレクタ | 役割 |
|---------|------|
| `.sidebar_header` / `.sidebar_header_item` / `.sidebar_header_item a` | ヘッダー行レイアウト。「フォロー中の番組」リンク＋アイコン群 |
| `.sidebar_header_item_col` / `... img` / `...:hover img` | 更新/オプションアイコン。`filter` でグレー着色、hover で色変化 |
| `#program_count` | 番組数バッジ（赤丸）。レイアウトシフト防止で高さ固定 |
| `#program_count.loading` / `::before` | ローディング中はグレー＋スピナー（テキスト透明化） |
| `#reload_programs.loading` / `... img` / `::before` | 更新ボタンのローディング。画像を隠して回転スピナー表示、クリック無効化 |
| `@keyframes loading-spin` | スピナー回転アニメ（両ローディング共通） |
| `.sidebar_body` | 本文ラッパ（`position:relative`。ポップアップ/エラーの基準） |

## 8.3 番組カード（`.program_container`）

生成元: `makeProgramElement`（`render/sidebar.js`）。列数は `setProgramContainerWidth`（`ui/layout.js`）が幅で切替。

| セレクタ | 役割 |
|---------|------|
| `.program_container` | 1番組カード。`id`=番組数値ID、属性 `active-point`（人気順ソートのキー） |
| `.program_thumbnail .anim_thumb_overlay` / `.anim_thumb_layer` / `.show` | 🧪実験。動くサムネのホバー用オーバーレイ（div, `inset:0`, `pointer-events:none`, **`z-index:1`**）。内部に2枚の `.anim_thumb_layer`(img) を重ね、`opacity`(0.4s)でクロスフェード。生成/制御は `render/animatedThumbnail.js`。⚠️ **`z-index` は必ずベースサムネの上・ホバーボタンの下**（「別窓くん」の `.nicolive_link_button_wrap` は `z-index:2`）。div自身が stacking context になり内部レイヤーの z-index は外に漏れない |
| `.program_container .community` | 配信者行（アイコン＋名前） |
| `.community a` / `.community img` | 丸いユーザーアイコン（40px, `border-radius:50%`） |
| `.community .community_name` | 配信者名（1行省略 `text-overflow:ellipsis`） |
| `.program_thumbnail` | サムネ枠（`aspect-ratio:16/9`, 角丸, 黒背景） |
| `.program_thumbnail a` / `img` | サムネ画像（`object-fit:contain`）。`img.src`=ライブサムネ, `data-src`=静的サムネ |
| `.program_title` | 番組タイトル（2行クランプ `-webkit-line-clamp:2`, `min-height:2.8em`） |
| `#liveProgramContainer` | カードのラッパ（`display:flex; flex-wrap:wrap`＝多カラム対応） |
| `#api_error` / `#api_error a` | 一覧API失敗時のログイン導線（既定 `display:none`。失敗時に `block`） |

## 8.4 オプションポップアップ（`#optionContainer`）

生成元: `buildSidebarShell` の `optionHtml`。表示制御は `main.js` の `openPopup/placePopup`。

| セレクタ | 役割 |
|---------|------|
| `#optionContainer` | `position:fixed`。既定は画面外(-9999px)＋`display:none` |
| `#optionContainer.show` | 表示（`main.js` が座標を計算して配置） |
| `#optionContainer .container` | ポップアップ本体（幅360px, 角丸, ダーク, シャドウ, `max-height:70vh` スクロール） |
| `h1` / `h2` | 見出し（`h2` は青い左ボーダー `#2a6fd8`） |
| `.opt-title-with-help` / `.help-wrap` / `.help-icon` / `.help-tooltip` | 「?」ヘルプアイコンとツールチップ（hover/focus で表示）。自動更新・オートオープン・自動移動の説明文 |
| `.opt-beta-badge` | 🧪 見出し横の「β版」バッジ（動くサムネ設定用の黄色い小バッジ） |
| `.flex` / `.setbox` / `.inputbox` / `label` | ラジオ項目のレイアウト |
| `input[type="radio"]` / `input[type="text"]` | フォーム入力（text は現状未使用） |
| `#optionContainer a` / `a:hover` | リンク色 |

## 8.5 自動移動モーダル（`#auto_next_modal`）

生成元: `AutoNextManager.ensureModal`。**ライト配色**（白背景）で目立たせる。

| セレクタ | 役割 |
|---------|------|
| `#auto_next_modal` | 画面中央のオーバーレイ（既定 `display:none`, `z-index:10001`） |
| `#auto_next_modal.show` | 表示（`display:flex`） |
| `.backdrop` | 半透明の暗幕 |
| `.dialog` | 白いダイアログ（最大350px） |
| `.title` | 「ニコ生サイドバーによる自動移動」 |
| `.message` | 「`#auto_next_count` 秒後に次の番組へ移動します。」 |
| `.preview` / `.thumb` / `.thumb img` | 次番組のプレビュー（16:9サムネ） |
| `.preview-provider` / `.preview-title` | 配信者名・番組タイトル |
| `.actions` / `button` / `button:hover` | 「キャンセル」ボタン |

## 8.6 スタイル改修時の注意
- クラス/ID名は JS（`render/sidebar.js`, `AutoNextManager.js`, `main.js`, `layout.js`）と密結合。
  **リネームは JS 側と同時に**行う。
- カード列数のブレークポイントは CSS ではなく **`ui/layout.js` の `setProgramContainerWidth`** にハードコードされている（300/500/.../1500px）。列数を変えたい時はそちらを編集。
- `.program_thumbnail` の `aspect-ratio:16/9` を変えると `AutoNextManager` プレビューやレイアウト計算(`adjustWatchPageChild` の 0.5625=9/16)と齟齬が出うる。
