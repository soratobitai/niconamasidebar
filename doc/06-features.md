# 06. 機能インベントリ & 設定マッピング

ユーザー向け機能ごとに「実装コードパス」と「対応する設定項目・保存キー・デフォルト値」を対応付け。
機能追加/変更時の入口。

---

## 設定の全体像

- **既定値の定義元**: `src/main.js` の `defaultOptions`。すべて `chrome.storage.local` に永続化。
- **フォームUIの生成元**: `buildSidebarShell()`（`render/sidebar.js`）内の `optionHtml`。`#optionForm` に5ラジオグループ（表示順序/自動更新/オートオープン/自動移動/動くサムネ）＋末尾にテーマトグル。
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
| サムネ基準間隔（実質固定） | （UI/保存なし） | — | `updateThumbnailInterval`（既定に無し） | 20秒（定数。番組ごと自己連鎖の基準間隔） | — | — |

---

## 1. サイドバー表示（DOM注入・レイアウト調整）
- 入口: `DOMContentLoaded` → `setup()`。`?popup=on` や `#root` 不在時は起動しない。
- 注入: `insertSidebar()` → `buildSidebarShell()`。`body` を `display:flex`、`#root` を `flex-grow:1` に。
- ニコ生本体の幅調整: `ui/layout.js` `adjustWatchPageChild`。カード列数: `setProgramContainerWidth`（幅で1〜8列）。
- リサイズ追従: `window.resize`(debounce30ms) / `ResizeObserver`×2 / theaterボタン click。
- 対応設定: 直接項目なし（`sidebarWidth` が列数計算に影響）。

## 2. サイドバー開閉
- 制御: `ui/sidebarControl.js` `createSidebarControl`。`#sidebar_button` click → `toggleSidebar()` → `setIsOpenSidebar()` 保存 → `handleSidebarOpenStateChange()`（タイマー起動/停止＋即時更新）。
- ✅ 2026-07-11修正（二重発火）: 開閉ボタンは直接 `handleSidebarOpenStateChange` を呼ぶが、`setIsOpenSidebar` の書込みで `chrome.storage.onChanged` が**自タブでも**発火して二度目が走り、開くたび `getLivePrograms` が2回になっていた。onChanged の `isOpenSidebar` 分岐に「自タブ（既に反映済み）ならスキップ」ガードを追加（他タブ同期は維持）。→ [09-gotchas S](./09-gotchas-and-techdebt.md)
- 対応設定: **`isOpenSidebar`**（既定 `false`）。`autoOpen` が初期開閉に影響（§7）。

## 3. サイドバー幅ドラッグリサイズ
- 実装: `enableSidebarLine()`。`#sidebar_line` の mousedown〜mousemove/mouseup。最小 `sidebarMinWidth=180`。
- 保存: `onMouseUp` → `setSidebarWidth()` → **`sidebarWidth`**（既定 `360`）。UIラジオ無し（ドラッグのみ）。

## 4. ライブサムネイル表示・遅延更新
- カード初期src: `makeProgramElement`（user=スクショ`?cache=`、channel=大サイズ）。
- 定期更新: `UpdateManager.startThumbnailUpdate`（**番組ごとの独立・自己連鎖タイマー方式**）。各カードが自前のタイマー（`_thumbTimers` Map: id→timeoutId）を持ち、`_runThumbCycle` が「その番組の `<img>` を1件更新→画像の読み込み完了(`updateThumbnailsFromStorage` の **`onSettled`**)を待って→`updateThumbnailInterval`(**20秒**)後に次サイクル」を回す。周期＝20秒＋その回の作業時間なので、読み込み時に一斉に始まっても少しずつ自然にズレる（**ドリフト**＝「リストが一斉に切り替わるのが気持ち悪い」というUX要望に沿ったもの）。実処理 `updateThumbnailsFromStorage`（TTL10秒・失敗バックオフ2〜60秒・プリロード成功時のみ差替・**コンテナ内の全img対象**。旧・可視限定(IntersectionObserver)は撤去）。新規/削除カードは `_syncThumbTimers`（`updateSidebar` 末尾）が各番組タイマーを生成/破棄して追従。読み込み時の一斉更新は `performManualUpdate` が担う（定期 `updateSidebarInterval` の全件 `updateThumbnail()` 呼び出しは撤去）。
- **ネットワーク詳細取得は最小限**: このループは storage に保存済みの**安定したライブサムネURL＋キャッシュバスター**で `<img>` を更新するだけ。例外として、ライブサムネ空かつ放送開始から `newProgramFastPollMs`=3分以内の若い user 番組だけ各サイクルで詳細API(`fetchProgramInfo`)を1回追撃する（`_fetchLiveThumbIfPendingYoung`。旧A1の別建てバッチ `_retryPendingLiveThumbnails`／`THUMB_RETRY_MAX_ATTEMPTS`/`PER_CYCLE` は撤去し各サイクルに統合）。3分超の空番組はスクレイプ `fillMissingDetails`（60〜180秒）に委譲。プリロード成功画像は動くサムネ②へも給餌される（§15）。
- **背景（非表示）タブ**: `_runThumbCycle` は `document.hidden` の間は画像更新を行わず軽く次サイクルだけ張る（rAF が止まり `onSettled` が来ないため）。可視復帰後は通常サイクルへ戻り、一斉更新は `performManualUpdate` が担う。停止は `stopThumbnailUpdate`（`stopAllTimers`＝サイドバー閉／`cleanup`＝ページ離脱の両方から）。旧・60秒しきい値（`visibilityFullRefreshMs`）による「軽量/しっかり更新」の区別は廃止（詳細は毎回フロントAPIで全件更新されるため）。
- 対応設定: **直接のUI項目なし**（フォームのヘルプに「サムネは設定と無関係に20〜60秒で自動更新」と明記）。`updateThumbnailInterval` 保存キーは既定に無く実質固定20秒。

## 5. 定期自動更新（番組リスト＋詳細）
- タイマー: `UpdateManager.startSidebarUpdate`（`updateProgramsInterval` 秒ごと。setTimeout方式なので**初回も1周期後**）。タブ非表示中はスキップ（次周期へ）。
- 取得→描画: `updateSidebar()`。**リスト（notifybox）と 詳細（フォロー中ページのフロントAPI）を `Promise.all` で並列取得**し、
  詳細を先に storage へ upsert（`fetchFollowedProgramsViaPage` → `upsertProgramInfos`）してから、
  リストと突き合わせてカードを組み、`programsSort` でソート → カウント更新。詳細がカード生成時点で揃っているので**初回描画から人気度が確定**する。失敗時 `#api_error`。
- **詳細取得はフロントAPIに一本化**: 従来の「1番組=詳細API×N」＋レート制限キューは廃止（`queue.js` / `ProgramInfoQueue` 削除）。フロントAPIを通常1リクエスト（100件超はページングで数リクエスト）叩いて全放送中フォロー番組の詳細を取得する。→ [04-data-flow](./04-data-flow.md) / [05-external-api](./05-external-api.md)
- 対応設定: **`updateProgramsInterval`**（既定 `'120'`、選択肢60/120/180）。変更時 `restartSidebarUpdate`。

## 6. ソート（表示順序）
- 実体: `utils/sorting.js` `sortPrograms`。`active`=`active-point`降順（人気順）、`newest`=**notifybox API の並び順を保持**（新着順）。
- ✅ 2026-07-11修正: notifybox API は既に**放送開始が新しい順**で番組を返す（実機確認済み）。旧実装は lv番号(ID)降順でソートしていたが、**lv番号は予約/作成順で放送開始順とズレる**（予約枠など）ため新着順が崩れていた。→ `updateSidebar` が各カードに `data-api-index`（API配列の位置）を付与し、`newest` はそれを昇順に並べて**API順をそのまま保つ**（詳細取得に非依存・全番組に付与されるのでフォールバック沈みも無し）。同時刻/欠落時のみ lv番号降順フォールバック。
- 人気度: `calculateActivePoint` = `(viewers+1 + comments+1) / 経過分`。カード生成時に `active-point` 属性へ書き込み、`sortPrograms` の `active` がそれを降順に並べる。
- 変更時: `optionsHandler` が `programsSort` 変更を検知 → APIを叩かず即DOMソート。
- 対応設定: **`programsSort`**（既定 `'newest'`）。
- ✅ **初回描画から順位確定（整列確定機構は不要に）**: 詳細（視聴者数/コメント）が**リストと同時にフロントAPIで storage へ載る**ため、
  カード生成時点で人気度が確定している。よって**最初のペイントから正しい順序で表示**され、
  「詳細が揃うまで新着順で待って出揃ったら人気順へ並べ替える」settling／FLIP 機構は撤去した
  （旧 `AppState.update.settling` / `settlingNeedsNewest` / `getEffectiveSortType` / `performInitialLoad` などは全て廃止）。
  新着順は notifybox のAPI順（`data-api-index` 昇順）を保つため、こちらも並べ替えは起きない。詳細は [04-data-flow](./04-data-flow.md)。

## 7. オートオープン（自動でサイドバーを開く）
- 初期判定: `setup()` の `shouldOpenAtStart = (autoOpen=='1') || (autoOpen=='3' && isOpenSidebar)`。
  - `'1'`=常にON / `'2'`=常にOFF / `'3'`=前回の `isOpenSidebar` を記憶して復元。
- 対応設定: **`autoOpen`**（既定 `'3'`）。変更は次回ロードで有効。

## 8. 番組自動移動（自動次番組）
- 管理: `AutoNextManager`。終了検知 `observeProgramEnd`（MutationObserver）→ `updateSidebar` → 現在と異なる先頭番組を選定 → `scheduleNavigation`（モーダル＋10秒カウントダウン → `location.assign`）。キャンセル可。
- ✅ **サムネクリックで即移動（2026-07-13）**: モーダルのプレビューサムネ枠(`.preview .thumb`)クリックでカウントダウンを待たず即 `location.assign(nextHref)`。`scheduleNavigation` が `showModal(..., onConfirm=goNow)` を渡し、`goNow` がタイマー停止→遷移。枠は使い回すため `onclick` 上書き（重複防止）。`.is-clickable` でカーソル/ホバー枠、`.hint` で「サムネイルをクリックすると今すぐ移動します」を表示。
- 起動/停止: `setup()` で `on` なら開始、onChanged で on/off に応じて start/stop。
- 対応設定: **`autoNextProgram`**（既定 `'off'`）。
- ✅ 2026-07-11修正: 終了時の `updateSidebar` は `main.js` から注入され、**実際に最新リストを取得**してから次番組を選定する（旧: IIFEビルドで未解決だった）。→ [09-gotchas A](./09-gotchas-and-techdebt.md)
- ✅ 2026-07-11修正（暴走ループ）: `observeProgramEnd` の MutationObserver がデバウンス無しで毎変異 `onEnded`→`updateSidebar` を叩き、`replaceChildren` の変異で自己駆動ループ化して `getLivePrograms` が暴走していた。終了ガイド表示中は**20秒スロットル**で再発火を制限（`status.js`）。→ [09-gotchas S](./09-gotchas-and-techdebt.md)

## 9. 手動更新ボタン（リロード）
- `#reload_programs` click → `isLoading()` なら無視 → **`performManualUpdate()`**（初回ロード・タブ復帰・サイドバー再オープンと共通の入口）:
  `updateSidebar()`（リスト＝notifybox＋詳細＝フロントAPIを並列取得して再描画・ソート）→ **サムネを強制更新**（`updateThumbnail(true)`＝10秒TTL・エラーバックオフをバイパス、コンテナ内全サムネ対象）→ 最低1秒ローディング → 定期タイマー再起動。
  詳細は毎回フロントAPIで**全件更新**されるため、TTL無視の `forceRefetch` や「新着順への一時退避」「人気順へのFLIP整列」は不要になった（撤去済み）。
- ローディング表示: `LoadingManager` が `.loading` ＋ `pointer-events:none`（60秒タイムアウト）。
- 対応設定: なし（機能ボタン）。

## 10. 設定パネル（サイドバー内・番組リストと入替）
- `#setting_options`（歯車）click → `.sidebar_body` に `.show-settings` をトグル → **番組リスト(`#liveProgramContainer`)と設定(`#optionContainer`)を入れ替え表示**（ポップアップ廃止）。設定内の×ボタン（`#settings_close`）または Esc で番組リストへ戻る。
- 設定は `.sidebar_body` 内に配置（body直下へは移動しない＝`insertSidebar` の appendChild 廃止）。
- UI: 「設定」ヘッダー＋×、各項目は**セグメント型（`.opt-segment`：ラジオを隠しラベルをボタン化、選択は `--sb-accent`）**、テーマはトグルスイッチ。ヘルプ「?」・β版バッジは維持。
- フォーム同期・保存: `setupOptionsHandler`（ラジオは非表示だが機能は同じ）。
- 対応設定: フォーム内の6項目（表示順序/自動更新/オートオープン/自動移動/動くサムネ/テーマ）。`sidebarWidth`/`isOpenSidebar` はフォーム外。データ取得方式トグル（旧・実験：API/ページ取得/自動）は撤去済み（詳細取得はフロントAPIに一本化＝§14）。

## 11. API失敗表示（ログイン誘導）
- `#api_error`（ログインリンク付き）。`getLivePrograms` 成功で `none`、失敗で `block`。
- 対応設定: なし。

## 12. 別窓くん連携 / ポップアップ抑止
- `?popup=on` の時は `DOMContentLoaded` の先頭で即 `return` し、`setup()` にも入らず**一切起動しない**（姉妹ツール「別窓くん」のポップアップ内で二重起動しないため）。判定は `new URL(location.href).searchParams.get('popup') === 'on'`（`main.js`）。
- モジュール直下で走るのは無害な一度きりの処理のみ（`localStorage.programInfos` の初期化と、`followPageSource.js` の副作用インポートによる `window.__testFollowScrape` デバッグ関数の登録＝いずれもタイマー未起動。関数名は据え置きだが実体はフロントAPI取得を叩く＝§13）。定期監視の `setInterval` は張られない（旧 `apiStats` は撤去済み・§13）。

## 15b. ライト/ダークモード（テーマ切替）
- サイドバーは既定**ライト**。**ダークモード**にも対応。
- 切替UI: **設定パネル内の「テーマ」トグルスイッチ**（`#theme_toggle`、`#optionForm` の**末尾**）。**ダーク=ON（ノブ右・青トラック）／ライト=OFF（ノブ左・グレー）**、ラベルは左「ライト」右「ダーク」。クリックで即切替。`applyTheme` はサイドバー挿入前に実行しちらつきを回避。
- 実装: CSSカスタムプロパティ（`--sb-*`）を `body`（ダーク既定）と **`body.nicosidebar-light`**（ライト）で切替。`main.js` の `applyTheme(theme)` が body クラスをトグル、`storage.js` の `setSidebarTheme` で `chrome.storage.local` に保存、`onChanged` で他タブにも反映。
- ✅ ライト時、本サイト背景が白でも境目が分かるよう、**サイドバー左端のライン/開閉ボタン(`#sidebar_line`/`#sidebar_button`)に色**（`--sb-line`=ダーク`#111`/ライト`#d5d9df`（薄め））。
- 対応設定: **`sidebarTheme`**（既定 **`'light'`**）。設定パネル内のトグルで保存。
- テーマ対象: サイドバー本体（背景/文字/ヘッダー/アイコン/サムネ枠/スピナー/左端ライン）＋設定パネル（セグメント含む）。自動移動モーダルは元から明色。

## 13. デバッグ機能
- `window.__testFollowScrape()` で、フォロー中ページ・フロントAPI方式の取得結果を件数＋所要ms＋表でコンソール表示（`followPageSource.js` が副作用インポートで登録）。**関数名はスクレイプ時代のまま据え置き**だが、実体は現行のフロントAPI取得（`fetchFollowedProgramsViaPage`＝ページング込み）を叩く。詳細取得（視聴者数/コメント/サムネURL/配信者/会員限定/開始時刻）が正しく拾えているかの確認用。
  - ※旧 `window.showApiStats()`（API呼び出し統計・5分ごとの異常頻度警告）は**撤去済み**（`src/debug/apiStats.js` 削除）。詳細APIをN回叩くキュー自体が無くなったため。
- `window.showAnimThumbStats()`（モジュール読込時に無条件公開。content scriptのisolated worldに定義されるためコンソールは拡張コンテキストを選ぶ）で②の統計を表示: **①給餌数(ingested)**・②自前取得(fetches＝主にホバー)・解析/新規保存/重複破棄・CORS汚染(taintStops)。給餌方式(§15)の効き目確認用で、**ingestedが主・fetchesがホバーのみ・taintStops=0が正常**。`setAnimatedThumbnailEnabled(true)` のたびにリセット。
- 定期の自動ログは**リリース向けに廃止**（計測で一本化を検証済みのため。2026-07-13）。統計は `window.showAnimThumbStats()` の手動呼び出しで確認する。
- **CORS汚染時のみ警告**: 万一 crossOrigin 画像が canvas を汚染して解析不可になった場合、`computeSignature` で**1回だけ** `console.warn`（`⚠️ 動くサムネ: CORS汚染で…`）を出し、以降①は平文取得へ自動フォールバック。`console.warn` はコンソールのコンテキスト選択に関係なく `top` にも表示されるため、実機テスト中もこの重要シグナルは見逃さない。

## 15. 動くサムネ（実験機能・ホバー中のみ / `feature/animated-thumbnail` ブランチ）
- 目的: サムネにホバーすると、直近数枚のライブサムネを切り替えてアニメ表示する。
- 実装: `src/render/animatedThumbnail.js`（`setAnimatedThumbnailEnabled` / `teardownAnimatedThumbnails`）。
  - ライブサムネは**同一URLで内容が時間変化**するため、取得した瞬間の画像を保持する必要がある。
  - **CORS対応が確認済み**なので `crossOrigin='anonymous'` で読み込み → 16×16の**知覚ハッシュ**で前フレームと比較し、
    **変化した時だけ** blob URL のリングバッファ（N=`animatedThumbnailFrameCount`=5）に追加（重複排除。ニコ生の可変更新間隔でも「同じ画像が複数コマ」にならない）。
  - 取得方式（**給餌方式・2026-07-13**）: 最新サムネの取得は①(通常サムネ更新 `updateThumbnailsFromStorage`)へ**一本化**。②ON時、①はプリロードを `crossOrigin='anonymous'` で読み、成功画像を `ingestAnimatedThumbnailFrame(cardId, img)` へ渡す（**再取得なし**）。②は定期の自前取得をせず、**ホバー即時取得のみ**自前で行う。対象は①が更新する**サイドバー内の全カード（可視/画面外を問わず）**。保持枚数 N=`animatedThumbnailFrameCount`=**5**、最大幅480pxに縮小保存。
    - ✅ 2026-07-13(a): 旧 `isCardVisible` の可視ゲートを撤去し全カード対象に（画面下の番組もフレームが貯まるよう均一化、`isCardVisible`削除）。
    - ✅ 2026-07-13(b): ①②が同一サムネを別々に取得する**二重通信を解消**。②の定期自前取得(`captureVisibleFrames`)を廃止し①からの給餌に一本化（②は `storeFrameFromImage` を共通化、`ingestAnimatedThumbnailFrame`/`isAnimatedThumbnailEnabled` を追加。②の定期処理は `pruneAbsentBuffers`＝消えた番組のバッファ解放のみ）。①のcrossOrigin配線は `main.js` の `setAnimThumbnailFeed({ isEnabled, ingest })`。①側は `sidebar.js` に `setAnimThumbnailFeed` フック＋プリロードの `feeding` 分岐（成功で `ingest`、CORS失敗は平文フォールバック）。
  - ⚠️ **読み込み中(更新ボタンが `.loading`＝初回ロード/更新の重い処理中)はキャプチャをスキップ**し、動画プレーヤーへのCPU/通信競合を避ける。
  - **ホバー中のカードだけ**、`.anim_thumb_overlay`（2レイヤー）を重ねて `animatedThumbnailPlayIntervalMs`(700ms) 間隔で**クロスフェード**巡回。**2枚**貯まれば開始（保持中に2枚目が来れば自動開始）。**ホバー時に即キャプチャ**して貯まり＝開始を早める。
  - blob は eviction/prune/無効化/teardown で `revokeObjectURL`。`beforeunload`/`pagehide` の cleanup で全解放。
  - ✅ **永続化(IndexedDB)**: 新フレームを `services/animFrameStore.js` で番組IDキーに保存し、**リロード/番組移動後**にそのカードへ触れた時に復元→即アニメ（サイドバーの番組はページ間で同じなので有効）。TTL `animatedThumbnailPersistTtlMs`(30分, `updatedAt`=最後に異なるフレームが出た時刻 基準)超過は復元せず、起動時に `cleanupFrames`(上限 `animatedThumbnailPersistMaxEntries`=300)で掃除。※静止しがちな番組が誤って掃除されないよう長め。IndexedDB不可環境ではメモリのみで動作継続。
- **β版・設定でON/OFF（既定OFF）**。`main.js` setup で `setAnimatedThumbnailEnabled(options.animatedThumbnail === 'on')`、`onChanged`で反映。ホバー中のみ動作。OFF時は一切動作せず（リスナ/タイマー/fetchなし）＝初回負荷ゼロ。UIは「動くサムネ<β版>」＋ヘルプ。
- ✅ **二重取得は解消済み（給餌方式）**: 最新サムネは①のみが取得し②へ給餌。②が自前でネットに出すのは**ホバー即時のみ**。①の `crossOrigin` が失敗する環境では①が**平文で表示だけ確保**し（表示は無傷）②へは渡さない（アニメのみ休止）＝コア表示は無リスク。サイドバー閉/タブ非表示/読み込み中は給餌もスキップ（`ingest` 側に同ガード）。
- 🔎 **一本化の記録（2026-07-13・実装済み）**: 検討時は A案（①を常時crossOrigin化＝全ユーザーにCORSリスク・非推奨）/ B案（②が唯一fetchで表示も駆動＝①のTTL/バックオフ再実装が必要）/ C案（キャッシュトークン共有＝crossOriginと平文でキャッシュキーが別のため無効）を比較。実測(`showAnimThumbStats`)で **crossOrigin取得の失敗率0%**（72回中0）を確認しリスク小と判断。最終的に**「①を取得役のまま残し、②ON時だけ①がcrossOriginで読んで②へ給餌／CORS失敗は平文フォールバック」**を採用（①の枯れたTTL/バックオフ/フル更新を再実装せず活かせるA/B折衷）。※ニコ生サムネの実更新は時間帯変動で最速20秒のため**取得間隔は延ばさない**（重複DLは想定内）→ [[nicolive-thumbnail-update-cadence]]。計測の見方は§13。
- 制約: フレーム蓄積はニコ生のスクショ更新間隔（数十秒）に依存＝“ゆっくりした紙芝居”（N=5満タンには数分）。追加権限/Service Workerは不要。
- 採用済み（**β版・既定OFF**。不具合や重さを感じたら設定でOFFにできる）。
- ⚠️ **他拡張との共存**: 姉妹拡張「別窓くん」はサムネホバーで別窓ボタン(`.nicolive_link_button_wrap`, `z-index:2`)を出す。
  オーバーレイの `z-index` を **1**（ボタンより下）にして覆い隠さないようにしている（main.css）。オーバーレイを作り直す際も、
  必ず「ベースサムネの上・ホバーボタンの下」を維持すること。

## 14. 番組詳細の取得（フロントAPI一括・ページング対応）
- 番組詳細（視聴者数/コメント/ライブサムネURL/配信者/providerType/会員限定/開始時刻）は、**フォロー中ページが「もっと見る」で叩く公開フロントAPI**を直接呼んで全放送中フォロー番組ぶんを一括取得し、`upsertProgramInfos` で localStorage `programInfos` に保存（`_fetchedAt` 付与）。実装は `src/services/followPageSource.js`。SSR埋め込みデータ（`embedded-data`）のスクレイプは廃止した。
  - エンドポイント: `GET https://live.nicovideo.jp/front/api/pages/follow/v1/programs?status=onair&offset=<0始まりページ番号>&limit=100`（`credentials: include`）。応答は `{ data: { programs: [...], total: N } }`。詳細は [05-external-api](./05-external-api.md)。
- 各 `programs[]` 要素を `mapApiProgramToInfo()` が内部 programInfo 形へ変換（`beginAt`（msエポック）→`onAirTime.beginAt` ISO、`watchCount`→viewers、`commentCount`→comments、`providerType` `community`→`'user'` など）。従来の詳細APIと同じshapeなので `makeProgramElement` / `resolveLiveThumbnailBaseUrl` / `calculateActivePoint` がそのまま読める。
- ✅ **ページング対応済み**: `fetchFollowedProgramsViaPage()` が `offset`=0,1,2,… とページ番号を進め（ページNは `items[N*100 .. N*100+100)`）、id重複を除きつつ `total` 件に達するまで取得する（安全上限 `MAX_PAGES=5`＝最大500件）。`limit=100` なので同時放送中フォローが100件未満なら通常**1リクエスト**で完了し、100件超でも全番組の詳細が揃う（旧・約70件で頭打ちの制約は解消）。
- 常に**ライブスクショ**（時間変化する実サムネ）を優先し、配信者設定の固定画像は使わない。フロントAPIは `listingThumbnail` の1枠しか返さず、固定画像配信者ではそこに固定画像が入るため、`isLiveScreenshotUrl` でライブスクショ形のときだけ採用し、それ以外は `thumbnailUrl=''`（表示しない）。
- ✅ **固定画像配信者のサムネ補完（選択的フォールバック）**: ライブサムネが空の番組（固定画像配信者／放送直後で未生成）だけ、`fillMissingLiveThumbnails()` が番組ごと詳細API（`fetchProgramInfo`）を叩いて `liveScreenshotThumbnailUrls` を補完する。**空の番組だけ**が対象（通常0〜数件）で上限 `MAX_DETAIL_FALLBACK=30`／サイクル。旧方式の「全番組×詳細API」の重さは避けたまま穴だけ埋める。
- ✅ **旧・詳細APIキュー方式は撤去**: 「1番組=詳細API×N＋4件/秒レート制限キュー（`ProgramInfoQueue`）＋直近60秒スキップの独立TTL（`programInfoTtlMs`）」は全廃。詳細は毎周期フロントAPIで**全件フルレコード**が書き戻されるため、番組ごとの再取得判定（TTL）も `forceRefetch` も不要。詳細API（`fetchProgramInfo` / `liveInfoAPI`）は上記のサムネ補完でのみ限定利用する。
- **フォールバックなし**: フロントAPI取得が失敗した周期は、その周のみ詳細が古い/欠落する（意図的）。旧・全件を詳細APIで取り直す方式には戻さない。番組ごとの `updateSidebar` try/catch と `makeProgramElement` の `String(id)` 変換でクラッシュは防御。
- 対応設定: なし（内部の取得方式）。関連: [04-data-flow](./04-data-flow.md)、[05-external-api](./05-external-api.md)。
