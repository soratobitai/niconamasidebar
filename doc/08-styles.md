# 08. スタイル（CSS）インベントリ

`src/styles/main.css`（652行）の全セレクタと役割。DOM構造は `render/sidebar.js`・`AutoNextManager.js` が生成する。

- テーマ: 既定**ライト**／**ダーク**対応。**CSSカスタムプロパティ `--sb-*`** を `body`（ダーク既定値）と **`body.nicosidebar-light`**（ライト）で切替。主要ルールは `var(--sb-bg/-fg/-header-fg/-arrow/-spinner/-spinner-track/-thumb-bg/-icon-filter/-icon-filter-hover/-popup-border/-accent/-segment-bg/-switch-*)` を使用（未使用だった `--sb-popup-bg/-fg/-heading/-input-border` は 2026-07-11 整理で削除）。JSは `applyTheme` が body クラスをトグル。
- テーマ切替: **オプション設定内・`#optionForm` 末尾**のセグメント（`input[name="sidebarTheme"]`＝`#sidebarThemeLight` / `#sidebarThemeDark`）。他の設定項目と同じ `.opt-segment` 形式。左端ライン/開閉ボタンは `--sb-line`（ライトで着色）。既定テーマは**ライト**（`main.js` の `defaultOptions.sidebarTheme:'light'`、`applyTheme` はサイドバー挿入前に実行しちらつき回避）。
- サイドバーは `position: sticky; top:0; height:100vh`。開閉は**幅(width)を 0 ⇔ 実幅** に変え、`transition: all .5s` でアニメ。

## 8.1 サイドバー枠・開閉

| セレクタ | 役割 |
|---------|------|
| `#sidebar` | サイドバー本体。sticky・全高・ダーク・スクロールバー非表示（`scrollbar-width:none` ＋ `::-webkit-scrollbar{display:none}`） |
| `.sidebar_transition` | 幅変化のトランジション（ドラッグ中は一時的に外す） |
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
| `.program_container` | 1番組カード。`id`=番組数値ID、属性 `active-point`（盛り上がり＝人気順の第1キー）と `data-total`（累計＝同点時の第2キー） |
| `.program_thumbnail .anim_thumb_overlay` / `.anim_thumb_layer` / `.show` | 🧪実験。動くサムネのホバー用オーバーレイ（div, `inset:0`, `pointer-events:none`, **`z-index:1`**）。内部に2枚の `.anim_thumb_layer`(img) を重ね、`opacity`(0.4s)でクロスフェード。生成/制御は `render/animatedThumbnail.js`。⚠️ **`z-index` は必ずベースサムネの上・ホバーボタンの下**（「別窓くん」の `.nicolive_link_button_wrap` は `z-index:2`）。div自身が stacking context になり内部レイヤーの z-index は外に漏れない |
| `.program_container .provider` | 配信者行（アイコン＋名前）。⚠️ 旧 `.community`（ニコ生のコミュニティ廃止に伴い 2026-07-31 改名） |
| `.provider a` / `.provider img` | 丸い配信者アイコン（40px, `border-radius:50%`） |
| `.provider .provider_name` | 配信者名（1行省略 `text-overflow:ellipsis`）。旧 `.community_name` |
| `.program_thumbnail` | サムネ枠（`aspect-ratio:16/9`, 角丸, 黒背景） |
| `.program_thumbnail a` / `img` | サムネ画像（`object-fit:contain`）。`img.src`=ライブサムネ, `data-src`=静的サムネ |
| `.program_title` | 番組タイトル（2行クランプ `-webkit-line-clamp:2`, `min-height:2.8em`） |
| `#liveProgramContainer` | カードのラッパ（`display:flex; flex-wrap:wrap`＝多カラム対応） |
| `#api_error` / `#api_error a` | 一覧API失敗時のログイン導線（既定 `display:none`。失敗時に `block`） |

## 8.4 設定パネル（`#optionContainer`・サイドバー内）

生成元: `buildSidebarShell` の `optionHtml`。**ポップアップではなくサイドバー内（`.sidebar_body`）に配置**し、番組リストと入れ替え表示（`.sidebar_body.show-settings` で `#liveProgramContainer`/`#api_error` を隠し `#optionContainer` を表示）。各項目は**セグメント型 `.opt-segment`**（ラジオ非表示＋ラベルボタン、選択は `--sb-accent`）、ヘッダー `.settings_header`＋`.settings_close`、テーマも同じセグメント形式（`name="sidebarTheme"`）。

| セレクタ | 役割 |
|---------|------|
| `#optionContainer` | サイドバー本文内に配置。既定 `display:none`、`.sidebar_body.show-settings` 時のみ表示 |
| `.sidebar_body.show-settings` | 設定表示状態。`#liveProgramContainer`/`#api_error` を隠し（`!important`＝`#api_error` のインラインstyleに勝つため）`#optionContainer` を表示 |
| `#optionContainer .container` | 設定本体ラッパ（**全幅**）。ヘッダー（設定/×）を左右いっぱいに広げるため上限なし、`color:var(--sb-fg)` |
| `#optionContainer #optionForm` | 設定フォーム本体。**`max-width:440px` ＋ `margin:0 auto`** で幅を頭打ち＆**左右中央**（サイドバーが右へ無制限に広がってもフォームは中央の読みやすい幅、ヘッダーだけ全幅） |
| `.settings_header` / `.settings_close` | 「設定」見出し行＋閉じる `×` ボタン（× or Esc で番組リストへ戻る） |
| `.opt-section` / `.opt-label` | 設定1項目のブロックと見出し |
| `.opt-segment` / `.opt-segment input[type=radio]` / `.opt-segment label` | **セグメント型選択**（`display:flex`）。ラジオは `display:none`、隣接ラベルをボタン化、`input:checked + label` を `--sb-accent` で反転（name/value は従来どおりで保存ロジック無改修） |
| `.opt-segment-4`（自動更新間隔の4択のみ） | 4つ横並びは狭いサイドバー幅に入らないため、この1つだけ **grid**（`repeat(auto-fit, minmax(56px,1fr))`）にする。flex のまま折り返すと**最終行の1個だけが全幅に伸びる**（実測: 幅180pxで 43/43/43/140px）。grid ならあふれた分も同じ幅で次行へ落ちる。実測の列数: サイドバー幅 180px→2列 / 260px→3列 / 300px以上→4列（既定幅360pxは1行） |
| `.opt-title-with-help` / `.help-wrap` / `.help-icon` / `.help-tooltip` | 「?」ヘルプ（hover/focus 表示）。ツールチップは**見出し行(`position:relative`)基準・`width:100%`** でサイドバー幅内に収める（`.help-wrap` に position を付けない） |
| `.opt-beta-badge` | 🧪 見出し横の「β版」バッジ（動くサムネ設定用の黄色い小バッジ） |
| `input[name="sidebarTheme"]`（`.opt-segment`） | テーマ切替セグメント（`#optionForm` **末尾**） |
| `#optionContainer input[type="radio"]` | ラジオの余白/カーソル（実際は `.opt-segment` 側で `display:none`） |

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
- カード列数のブレークポイントは CSS ではなく **`ui/layout.js` の `setProgramContainerWidth`** の配列 `columnBreakpoints=[300,500,700,900,1100,1300,1500]` で決まる（各値を超えるごとに列+1、最大8列）。列数を変えたい時はそちらを編集。
- `.program_thumbnail` の `aspect-ratio:16/9` を変えると `AutoNextManager` プレビューやレイアウト計算(`adjustWatchPageChild` の 0.5625=9/16)と齟齬が出うる。
