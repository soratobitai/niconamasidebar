# 07. ビルドと配布（Build & Deploy）

## 7.1 npm スクリプト（`package.json`）

| コマンド | 実体 | 用途 |
|---------|------|------|
| `npm run dev` | `vite` | 開発サーバ（このプロジェクトでは主に watch/build を使う） |
| `npm run build` | `vite build` | **本番ビルド**。`dist/` を生成 |
| `postbuild`（自動） | `node scripts/remove-maps.js` | build 後に `dist/**/*.map` を削除 |
| `npm run watch` | `vite build --watch` | ソース変更を監視して都度ビルド（拡張開発向き） |
| `npm run preview` | `vite preview` | ビルド結果のプレビュー |
| `npm run clean` | `rimraf dist` | `dist/` 削除 |
| `npm run clean:maps` | `node scripts/remove-maps.js` | map ファイルのみ削除 |
| `npm run verify:loop` | `node scripts/verify-sidebar-loop.mjs` | **論理検証＋ソース検査＋描画経路検証**（約1分）。ログイン不要・実サーバ不要 |
| `npm run verify:e2e` | `node scripts/verify-e2e.mjs` | **実ブラウザ検証**（約5分）。本物の Chrome に `dist/` を CDP で読ませる |

- devDependencies: `vite@^5`, `glob@^11`, `rimraf@^5`, `playwright-core@^1.49`（e2e検証用）。**実行時ランタイム依存なし**。

> 🔴 **`dist/` は .gitignore。** pull 後も `npm run build` しないと「直したのに直っていない」状態になる。
> **さらに build だけでは足りない。** Chrome は `dist/` を書き換えても自動では読み直さない。`chrome://extensions` の再読み込み → ページを F5 まで必要。
> これを忘れて「修正が効いていない」と誤診した実績がある。

## 7.2 Vite 設定（`vite.config.js`）

ポイントは「**ES Modules ではなく IIFE 1ファイルに固める**」こと。content script はモジュール解決を持たないため。

```js
build: {
  outDir: 'dist',
  rollupOptions: {
    input: { main: 'src/main.js' },        // 単一エントリ
    output: {
      entryFileNames: '[name].js',          // dist/main.js
      chunkFileNames: '[name].js',
      assetFileNames: '[name].[ext]',        // CSS → dist/style.css（後述）
      format: 'iife',                        // ★即時実行関数（分割なし）
      name: 'NiconamaSidebar',               // グローバル名
    },
  },
  target: 'es2015',
  minify: false,                             // 難読化なし（審査/デバッグしやすい）
  sourcemap: process.env.NODE_ENV !== 'production',  // 本番はmap無し
  cssCodeSplit: false,                       // CSSを1ファイルに
},
publicDir: false,                            // 自動コピー無効（下のプラグインで手動コピー）
plugins: [copyAssetsPlugin()],
```

### `copyAssetsPlugin`（自作）
`writeBundle` フックで以下を `dist/` にコピーする:
- `manifest.json` → `dist/manifest.json`
- `icons/` → `dist/icons/`（再帰）
- `images/` → `dist/images/`（再帰）

### CSS の出力名について
- `src/main.js` が先頭で `import './styles/main.css'` している。
- `cssCodeSplit:false` により全CSSが1ファイルに結合され、Vite の既定挙動で **`dist/style.css`** として出力される
  （実際に現在の `dist/` に `style.css` が生成済みであることを確認済み）。
- **`manifest.json` は `"css": ["style.css"]` を参照**しており、出力名と一致している。問題なし。
- ⚠️ ただし `src/styles/main.css` を別名にリネームしたり CSS 分割設定を変えると出力名が変わりうるので、
  その際は manifest の `css` 参照と揃っているか確認すること。

## 7.3 `scripts/remove-maps.js`
`glob('dist/**/*.map')` で map を集め `unlink` で削除。無ければ何もしない。postbuild で自動実行。

## 7.4 ビルド生成物（`dist/`）の想定構成

```
dist/
├── main.js         # IIFEにバンドルされた全JS（content_scripts.js が参照）
├── style.css       # 全CSS（content_scripts.css が参照）※7.2の注意点参照
├── manifest.json   # コピーされたマニフェスト
├── icons/          # 16/48/128
└── images/         # loading.gif / reload.png / options.png
```

`manifest.json` の該当箇所:
```json
"content_scripts": [{
  "matches": ["https://live.nicovideo.jp/watch/*"],
  "js": ["main.js"],
  "css": ["style.css"],
  "run_at": "document_start"
}],
"web_accessible_resources": [{
  "resources": ["images/*.gif", "images/*.png"],
  "matches": ["https://*/*"]
}],
"permissions": ["storage"]
```

- `run_at: document_start` … ページ描画前に注入。実処理は `DOMContentLoaded` を待つ。
- `web_accessible_resources` … `chrome.runtime.getURL('images/...')` でページ内 `<img>` から画像を使うため。

## 7.5 開発〜動作確認の手順

1. `npm install`（初回のみ）
2. `npm run build`（または開発中は `npm run watch`）
3. Chrome の `chrome://extensions` → デベロッパーモードON → **「パッケージ化されていない拡張機能を読み込む」** で `dist/` を選択
4. `https://live.nicovideo.jp/watch/lvXXXXXXXX` を開く（要ニコニコログイン）
5. 右端にサイドバーが出る。出ない場合:
   - コンソールに `[警告]`/`🚨` 等が出ていないか
   - `#root` が存在するか（`main.js` は `#root` 無しだと `setup` しない）
   - `?popup=on` が付いていないか（別窓くんポップアップ時は起動しない仕様）
   - `#api_error`（ログイン導線）が表示されていないか＝一覧API失敗（未ログイン等）

## 7.6 バージョン管理・リリース手順
- 表示・審査上のバージョンは **`manifest.json`**。**`package.json` と必ず揃える**（版が書いてあるのはこの2つだけ）。
  ⚠️ ここに現在の版を書かない（**書くと必ず腐る**。`1.10.8` のまま10版ぶん放置されていた）。
- 🔴 **実機で確認してもらう時は先に版を上げること。** 据え置くと `chrome://extensions` で
  ストア版と開発版の区別が付かず、**古いビルドが動いているのに気付けない**（7.x の落とし穴に実績あり）。
- コミットメッセージのバージョン付与規約: `<version>　<説明>`（バージョンと説明の間は**全角スペース U+3000**）。feature/fix はブランチで作業し `--no-ff` でマージ、マージコミットにバージョンを付ける（feature側コミットはプレーンな説明）。

### リリース手順
1. `master` が clean、`manifest.json`＝`package.json` のバージョン一致を確認。
2. `npm run clean && NODE_ENV=production npm run build`（sourcemap 無しの本番ビルド。`postbuild` で `dist/**/*.map` を削除）。
3. `dist/` の構成を確認（`main.js`/`style.css`/`manifest.json`/`icons/`/`images/`、`.map` が無いこと）。
4. **Chrome ウェブストア用に zip 化**：`manifest.json` が **zip のルート**に来るよう `dist/` 直下の内容をまとめる。本リポジトリでは `release/niconamasidebar-<version>.zip` に出力する（`release/` は gitignore 済み）。
   - PowerShell 例: `Compress-Archive -Path dist\* -DestinationPath release\niconamasidebar-<version>.zip -Force`
5. Chrome ウェブストア デベロッパーダッシュボードへ zip をアップロード → 審査提出。
6. （任意）リリース時点に `git tag v<version>` を付けておくと履歴を追いやすい。
