# ニコ生サイドバー — 開発ドキュメント

このフォルダは、Chrome拡張機能「**ニコ生サイドバー**」(`niconamasidebar`) のコードベースを、
今後の改修時に**開発者とAI（Claude）双方**が参照できるようにまとめた技術ドキュメントです。

> 対象バージョン: **1.9.0**（`manifest.json` / `package.json` とも 1.9.0 に同期済み）
> 最終ドキュメント化・更新: 2026-07-11（動くサムネ β版・既定OFF を追加して 1.9.0 にバンプ）

---

## このドキュメントの読み方

| # | ファイル | 内容 | こんな時に読む |
|---|---------|------|--------------|
| — | [README.md](./README.md)（本ファイル） | 目次・全体像の入口 | まず最初に |
| 01 | [01-overview.md](./01-overview.md) | 拡張が何をするか・技術スタック・全体像 | プロジェクトを初めて触る時 |
| 02 | [02-architecture.md](./02-architecture.md) | モジュール構成・依存関係・責務分担 | どこに何があるか掴む時 |
| 03 | [03-module-reference.md](./03-module-reference.md) | ファイル別・関数別の詳細リファレンス | 特定のコードを直す時 |
| 04 | [04-data-flow.md](./04-data-flow.md) | 起動〜取得〜描画〜更新〜自動移動のライフサイクル | 「いつ何が動くか」を追う時 |
| 05 | [05-external-api.md](./05-external-api.md) | ニコ生API・DOMセレクタ・storageキー・用語集 | 外部依存を確認する時 |
| 06 | [06-features.md](./06-features.md) | 機能一覧と設定項目の対応表 | 機能を追加/変更する時 |
| 07 | [07-build-and-deploy.md](./07-build-and-deploy.md) | Viteビルド・manifest・dist構成・開発手順 | ビルド/配布する時 |
| 08 | [08-styles.md](./08-styles.md) | CSSクラス/IDインベントリ | 見た目を直す時 |
| 09 | [09-gotchas-and-techdebt.md](./09-gotchas-and-techdebt.md) | 技術的負債・潜在バグ・改修時の注意 | バグ調査・リファクタ前に |

---

## 30秒サマリー

- **正体**: ニコニコ生放送の**番組視聴ページ**(`https://live.nicovideo.jp/watch/*`)に、
  **フォロー中の放送中番組**をライブサムネイル付きで一覧表示する**サイドバー**を注入する Chrome拡張（Manifest V3, content script のみ）。
- **バックグラウンド/Service Worker なし**。すべて視聴ページ上で動く1本のコンテンツスクリプト(`main.js`)。
- **ビルド**: Vite で `src/main.js` を **IIFE 1ファイル**(`dist/main.js`)にバンドル。CSSは `dist/style.css`。
- **データ源**: ニコニコの2つの公開API（通知ボックス＝フォロー番組リスト / 番組詳細）。
- **永続化**: 設定は `chrome.storage.local`、番組詳細キャッシュは `localStorage`。
- **主要機能**: サイドバー開閉・幅ドラッグ / 定期自動更新 / ライブサムネ自動更新 / 新着順・人気順ソート /
  番組終了時の自動移動 / オプション設定ポップアップ。

詳しくは [01-overview.md](./01-overview.md) へ。

---

## 改修時のヒント（AI・人間共通）

1. **エントリは `src/main.js`**。ここが全モジュールを結線するオーケストレータ。まずここを読む。
2. **状態は `src/core/AppState.js` に集約**。タイマー・オブザーバー・可視状態・ローディングセッション等を一元管理。
   グローバル変数を増やす前にここを見る。
3. **副作用の強い処理は Manager に分離**（`UpdateManager` / `LoadingManager` / `AutoNextManager`）。
   `main.js` の同名ラッパー関数は基本これらへの委譲。
4. **ビルドは IIFE**（ES Modules ではない）。`import`/`export` はソース上の話で、出力は1つの即時関数。
   モジュール間で「グローバル関数を参照する」書き方は動かない（教訓: → [09-gotchas A](./09-gotchas-and-techdebt.md) の旧 `updateSidebar` 問題。修正済みだが同種のミスに注意）。
5. 変更後は `npm run build` → `dist/` を Chrome の「パッケージ化されていない拡張機能」で読み込んで確認。
