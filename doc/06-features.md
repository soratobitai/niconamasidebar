# 06. 機能インベントリ & 設定マッピング

ユーザー向け機能ごとに「実装コードパス」と「対応する設定項目・保存キー・デフォルト値」を対応付け。
機能追加/変更時の入口。

---

## 設定の全体像

- **既定値の定義元**: `src/main.js` の `defaultOptions`。すべて `chrome.storage.local` に永続化。
- **フォームUIの生成元**: `buildSidebarShell()`（`render/sidebar.js`）内の `optionHtml`。`#optionForm` に4ラジオグループ。
- **フォームの初期反映・保存**: `handlers/optionsHandler.js`（`change` で `chrome.storage.local` へ保存。`programsSort` のみ保存＋即DOMソートの特別分岐）。
- **実行時反映**: `chrome.storage.onChanged`（`main.js`）が各キー変更を各機能へ配線。

### 設定項目 × 保存キー × 既定 × フォームvalue 早見表
| 機能 | input name | value（ラベル） | 保存キー | 既定 | UI生成 | 反映 |
|------|-----------|----------------|---------|------|--------|------|
| 表示順序 | `programsSort` | `newest`(新着順)/`active`(人気順) | `programsSort` | `'newest'` | sidebar.js | onChanged＋即DOMソート |
| 自動更新間隔 | `updateProgramsInterval` | `60`/`120`/`180`秒 | `updateProgramsInterval` | `'120'` | sidebar.js | onChanged→`restartSidebarUpdate` |
| オートオープン | `autoOpen` | `1`(ON)/`2`(OFF)/`3`(状態記憶) | `autoOpen` | `'3'` | sidebar.js | 初期判定（次回ロードで有効） |
| 自動移動 | `autoNextProgram` | `on`/`off` | `autoNextProgram` | `'off'` | sidebar.js | onChanged→watcher start/stop |
| 動くサムネ（β版） | `animatedThumbnail` | `on`/`off` | `animatedThumbnail` | `'off'` | sidebar.js | onChanged→`setAnimatedThumbnailEnabled` |
| サイドバー幅 | （フォーム外・ドラッグ） | — | `sidebarWidth` | `360` | — | onChanged |
| サイドバー開閉 | （フォーム外・ボタン） | — | `isOpenSidebar` | `false` | — | onChanged→開閉反映 |
| ライト/ダーク | （設定画面**末尾**のトグル。ON=ダーク） | `dark`/`light` | `sidebarTheme` | `'light'` | sidebar.js（`#optionForm` 末尾 `#theme_toggle`） | onChanged→`applyTheme` |
| サムネ間隔（実質固定） | （UI/保存なし） | — | `updateThumbnailInterval`（既定に無し） | 20秒（定数） | — | — |

---

## 1. サイドバー表示（DOM注入・レイアウト調整）
- 入口: `DOMContentLoaded` → `setup()`。`?popup=on` や `#root` 不在時は起動しない。
- 注入: `insertSidebar()` → `buildSidebarShell()`。`body` を `display:flex`、`#root` を `flex-grow:1` に。
- ニコ生本体の幅調整: `ui/layout.js` `adjustWatchPageChild`。カード列数: `setProgramContainerWidth`（幅で1〜8列）。
- リサイズ追従: `window.resize`(debounce30ms) / `ResizeObserver`×2 / theaterボタン click。
- 対応設定: 直接項目なし（`sidebarWidth` が列数計算に影響）。

## 2. サイドバー開閉
- 制御: `ui/sidebarControl.js` `createSidebarControl`。`#sidebar_button` click → `toggleSidebar()` → `setIsOpenSidebar()` 保存 → `handleSidebarOpenStateChange()`（タイマー起動/停止＋即時更新）。
- 対応設定: **`isOpenSidebar`**（既定 `false`）。`autoOpen` が初期開閉に影響（§7）。

## 3. サイドバー幅ドラッグリサイズ
- 実装: `enableSidebarLine()`。`#sidebar_line` の mousedown〜mousemove/mouseup。最小 `sidebarMinWidth=180`。
- 保存: `onMouseUp` → `setSidebarWidth()` → **`sidebarWidth`**（既定 `360`）。UIラジオ無し（ドラッグのみ）。

## 4. ライブサムネイル表示・遅延更新
- カード初期src: `makeProgramElement`（user=スクショ`?cache=`、channel=大サイズ）。
- 定期更新: `UpdateManager.startThumbnailUpdate`（**20秒**、`updateThumbnailInterval`）。実処理 `updateThumbnailsFromStorage`（TTL10秒・失敗バックオフ2〜60秒・プリロード成功時のみ差替・**コンテナ内の全img対象**。旧・可視限定(IntersectionObserver)は撤去）。
- ✅ **長時間非表示からの復帰（仕様変更）**: タブを `visibilityFullRefreshMs`(60秒)以上非表示にしてから戻ると、**更新ボタン相当のしっかり更新**（`forceRefetch`で全詳細再取得＋整列＋全サムネ最新化）を実行。長時間放置後に「サムネがアイコンのまま／情報が古い」問題への対策（`main.js` の `handleVisibilityChange` / `tabHiddenAt`）。60秒未満の復帰は軽量更新。
- 対応設定: **直接のUI項目なし**（フォームのヘルプに「サムネは設定と無関係に20〜60秒で自動更新」と明記）。`updateThumbnailInterval` 保存キーは既定に無く実質固定20秒。

## 5. 定期自動更新（番組リスト）
- タイマー: `UpdateManager.startSidebarUpdate`（`updateProgramsInterval` 秒ごと、**初回も120秒後**）。
- 取得→描画: `updateSidebar()`（`fetchLivePrograms` → 差分再構築 → ソート → カウント更新、各番組をキュー add）。失敗時 `#api_error`。
- 対応設定: **`updateProgramsInterval`**（既定 `'120'`、選択肢60/120/180）。変更時 `restartSidebarUpdate`。

## 6. ソート（表示順序）
- 実体: `utils/sorting.js` `sortPrograms`。`active`=`active-point`降順（人気順）、`newest`=ID降順（新着順）。
- 人気度: `calculateActivePoint` = `(viewers+1 + comments+1) / 経過分`。詳細取得後 `updateActivePointsAndSort(shouldSort)` で再計算。
- 変更時: `optionsHandler` が `programsSort` 変更を検知 → APIを叩かず即DOMソート。
- 対応設定: **`programsSort`**（既定 `'newest'`）。
- ✅ **初回ロード時のガチャつき対策（仕様変更）**: 人気順は詳細取得(4件/秒)が出揃うまで順位が確定しないため、
  従来はバッチ毎に再ソートしてカードが飛び跳ねていた。対策として:
  - **キャッシュで人気順を確定できる場合（全番組がキャッシュ済み）は、最初から人気順で表示（移動なし）**。← 変更前の挙動を維持
  - **詳細未取得の番組がある場合のみ**、確定するまで新着順で安定表示（オーバーレイ無し・クリック可）→ 出揃ったら1回だけ人気順へ [FLIP](./03-module-reference.md) で滑らかに並べ替え。
  - 進捗は更新ボタンのスピナー。制御は `AppState.update.settling` / `settlingNeedsNewest` ＋ `UpdateManager.getEffectiveSortType` / `performInitialLoad`。
  - TTLキャッシュにより2回目以降はほぼ常に「最初から人気順・移動なし」。新着順選択時は挙動不変。詳細は [04-data-flow フェーズ3](./04-data-flow.md)。

## 7. オートオープン（自動でサイドバーを開く）
- 初期判定: `setup()` の `shouldOpenAtStart = (autoOpen=='1') || (autoOpen=='3' && isOpenSidebar)`。
  - `'1'`=常にON / `'2'`=常にOFF / `'3'`=前回の `isOpenSidebar` を記憶して復元。
- 対応設定: **`autoOpen`**（既定 `'3'`）。変更は次回ロードで有効。

## 8. 番組自動移動（自動次番組）
- 管理: `AutoNextManager`。終了検知 `observeProgramEnd`（MutationObserver）→ `updateSidebar` → 現在と異なる先頭番組を選定 → `scheduleNavigation`（モーダル＋10秒カウントダウン → `location.assign`）。キャンセル可。
- 起動/停止: `setup()` で `on` なら開始、onChanged で on/off に応じて start/stop。
- 対応設定: **`autoNextProgram`**（既定 `'off'`）。
- ✅ 2026-07-11修正: 終了時の `updateSidebar` は `main.js` から注入され、**実際に最新リストを取得**してから次番組を選定する（旧: IIFEビルドで未解決だった）。→ [09-gotchas A](./09-gotchas-and-techdebt.md)

## 9. 手動更新ボタン（リロード）
- `#reload_programs` click → `isLoading()` なら無視 → **`performManualUpdate(true)`**:
  リスト更新（`notifybox` を毎回取得＝新着/終了番組を反映、人気順は再ソートを抑制のうえ即描画）→ **全番組の詳細を再取得（`forceRefetch`＝TTL無視、視聴者数等も最新化）** → **人気順なら1回だけFLIPで最新の人気順へ整える** → **サムネを強制更新**（10秒TTL・エラーバックオフをバイパス、コンテナ内全サムネ対象）→ 最低1秒ローディング→ 定期タイマー再起動。
  新着順への一時退避はしない（すでに人気順表示中のため）。
  ※明示操作なので**TTLを無視して全詳細を再取得**する（番組数が多いと詳細取得4件/秒で時間がかかる＝スピナー長め。その間もリスト/サムネは即更新済み・クリック可）。ページ開き時・自動更新はTTLを維持。
- ローディング表示: `LoadingManager` が `.loading` ＋ `pointer-events:none`（60秒タイムアウト）。
- 対応設定: なし（機能ボタン）。

## 10. 設定パネル（サイドバー内・番組リストと入替）
- `#setting_options`（歯車）click → `.sidebar_body` に `.show-settings` をトグル → **番組リスト(`#liveProgramContainer`)と設定(`#optionContainer`)を入れ替え表示**（ポップアップ廃止）。設定内の×ボタン（`#settings_close`）または Esc で番組リストへ戻る。
- 設定は `.sidebar_body` 内に配置（body直下へは移動しない＝`insertSidebar` の appendChild 廃止）。
- UI: 「設定」ヘッダー＋×、各項目は**セグメント型（`.opt-segment`：ラジオを隠しラベルをボタン化、選択は `--sb-accent`）**、テーマはトグルスイッチ。ヘルプ「?」・β版バッジは維持。
- フォーム同期・保存: `setupOptionsHandler`（ラジオは非表示だが機能は同じ）。
- 対応設定: フォーム内の5項目（テーマ/表示順序/自動更新/オートオープン/自動移動/動くサムネ）。`sidebarWidth`/`isOpenSidebar` はフォーム外。

## 11. API失敗表示（ログイン誘導）
- `#api_error`（ログインリンク付き）。`getLivePrograms` 成功で `none`、失敗で `block`。
- 対応設定: なし。

## 12. 別窓くん連携 / ポップアップ抑止
- `?popup=on` の時は `setup()` に入らず起動しない（姉妹ツール「別窓くん」のポップアップ内で二重起動しないため）。

## 15b. ライト/ダークモード（テーマ切替）
- サイドバーは既定**ライト**。**ダークモード**にも対応。
- 切替UI: **設定パネル内の「テーマ」トグルスイッチ**（`#theme_toggle`、`#optionForm` の**末尾**）。**ダーク=ON（ノブ右・青トラック）／ライト=OFF（ノブ左・グレー）**、ラベルは左「ライト」右「ダーク」。クリックで即切替。`applyTheme` はサイドバー挿入前に実行しちらつきを回避。
- 実装: CSSカスタムプロパティ（`--sb-*`）を `body`（ダーク既定）と **`body.nicosidebar-light`**（ライト）で切替。`main.js` の `applyTheme(theme)` が body クラスをトグル、`storage.js` の `setSidebarTheme` で `chrome.storage.local` に保存、`onChanged` で他タブにも反映。
- ✅ ライト時、本サイト背景が白でも境目が分かるよう、**サイドバー左端のライン/開閉ボタン(`#sidebar_line`/`#sidebar_button`)に色**（`--sb-line`=ダーク`#111`/ライト`#d5d9df`（薄め））。
- 対応設定: **`sidebarTheme`**（既定 **`'light'`**）。設定パネル内のトグルで保存。
- テーマ対象: サイドバー本体（背景/文字/ヘッダー/アイコン/サムネ枠/スピナー/左端ライン）＋設定パネル（セグメント含む）。自動移動モーダルは元から明色。

## 13. デバッグ機能
- `window.showApiStats()` で API 呼び出し統計をコンソール表示。5分ごとに異常頻度を自動警告。

## 15. 動くサムネ（実験機能・ホバー中のみ / `feature/animated-thumbnail` ブランチ）
- 目的: サムネにホバーすると、直近数枚のライブサムネを切り替えてアニメ表示する。
- 実装: `src/render/animatedThumbnail.js`（`setAnimatedThumbnailEnabled` / `teardownAnimatedThumbnails`）。
  - ライブサムネは**同一URLで内容が時間変化**するため、取得した瞬間の画像を保持する必要がある。
  - **CORS対応が確認済み**なので `crossOrigin='anonymous'` で読み込み → 16×16の**知覚ハッシュ**で前フレームと比較し、
    **変化した時だけ** blob URL のリングバッファ（N=`animatedThumbnailFrameCount`=5）に追加（重複排除。ニコ生の可変更新間隔でも「同じ画像が複数コマ」にならない）。
  - 取得対象は**サイドバーに見えているカードのみ**（20秒間隔 `animatedThumbnailCaptureIntervalMs`）。保持枚数 N=`animatedThumbnailFrameCount`=**5**。フレームは**最大幅480pxに縮小**して保存（負荷・容量削減）。
  - ⚠️ **読み込み中(更新ボタンが `.loading`＝初回ロード/更新の重い処理中)はキャプチャをスキップ**し、動画プレーヤーへのCPU/通信競合を避ける。
  - **ホバー中のカードだけ**、`.anim_thumb_overlay`（2レイヤー）を重ねて `animatedThumbnailPlayIntervalMs`(700ms) 間隔で**クロスフェード**巡回。**2枚**貯まれば開始（保持中に2枚目が来れば自動開始）。**ホバー時に即キャプチャ**して貯まり＝開始を早める。
  - blob は eviction/prune/無効化/teardown で `revokeObjectURL`。`beforeunload`/`pagehide` の cleanup で全解放。
  - ✅ **永続化(IndexedDB)**: 新フレームを `services/animFrameStore.js` で番組IDキーに保存し、**リロード/番組移動後**にそのカードへ触れた時に復元→即アニメ（サイドバーの番組はページ間で同じなので有効）。TTL `animatedThumbnailPersistTtlMs`(30分, `updatedAt`=最後に異なるフレームが出た時刻 基準)超過は復元せず、起動時に `cleanupFrames`(上限 `animatedThumbnailPersistMaxEntries`=300)で掃除。※静止しがちな番組が誤って掃除されないよう長め。IndexedDB不可環境ではメモリのみで動作継続。
- **β版・設定でON/OFF（既定OFF）**。`main.js` setup で `setAnimatedThumbnailEnabled(options.animatedThumbnail === 'on')`、`onChanged`で反映。ホバー中のみ動作。OFF時は一切動作せず（リスナ/タイマー/fetchなし）＝初回負荷ゼロ。UIは「動くサムネ<β版>」＋ヘルプ。
- ⚠️ 既存サムネ更新とは別に**可視カードを20秒毎に再取得**する（実質二重リクエスト）。非ホバー・サイドバー閉/タブ非表示時はキャプチャしない。
- 制約: フレーム蓄積はニコ生のスクショ更新間隔（数十秒）に依存＝“ゆっくりした紙芝居”（N=5満タンには数分）。追加権限/Service Workerは不要。
- 採用済み（**β版・既定OFF**。不具合や重さを感じたら設定でOFFにできる）。
- ⚠️ **他拡張との共存**: 姉妹拡張「別窓くん」はサムネホバーで別窓ボタン(`.nicolive_link_button_wrap`, `z-index:2`)を出す。
  オーバーレイの `z-index` を **1**（ボタンより下）にして覆い隠さないようにしている（main.css）。オーバーレイを作り直す際も、
  必ず「ベースサムネの上・ホバーボタンの下」を維持すること。

## 14. 番組詳細のTTLキャッシュ（内部最適化・仕様変更）
- 番組詳細は `ProgramInfoQueue` がレート制限（4件/秒）で取得し、`upsertProgramInfo` で localStorage `programInfos` に保存（保存時に `_fetchedAt` を付与）。
- ✅ **`UpdateManager.updateSidebar` は、直近 `programInfoTtlMs`(60秒) 以内に取得済みの番組はキュー追加をスキップ**し再取得しない。
  - 効果: 2回目以降の読み込み・サイドバー再オープンが高速化、API負荷も軽減。特に人気順の「整列確定」がほぼ一瞬になる。
  - 鮮度: 定期更新（120秒）は60秒超のため通常どおり再取得され、詳細が古びない。
  - **例外**: **更新ボタン（`forceRefetch`）はTTLを無視して全番組の詳細を再取得**する（明示的な「今すぐ最新に」）。TTL最適化はページ開き時・自動更新にのみ適用。
- 対応設定: なし（内部最適化）。関連: [09-gotchas E](./09-gotchas-and-techdebt.md)、[05-external-api](./05-external-api.md)。
