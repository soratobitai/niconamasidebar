import { defineConfig } from 'vite'
import { resolve } from 'path'

/**
 * kick.com 用サイドバー（2本目のバンドル）。
 *
 * 🔴 **なぜ設定ファイルを分けているか。**
 *    出力形式が iife で、Rollup は **iife/umd で複数エントリを出せない**
 *    （"UMD and IIFE output formats are not supported for code-splitting builds"）。
 *    `vite.config.js` に入力を足すのではなく、ビルドを2回走らせる。
 *
 * ⚠️ `emptyOutDir: false` は必須。true だと1本目のビルド成果物（main.js / style.css /
 *    manifest.json / static のコピー）を消してしまう。
 */
export default defineConfig({
    build: {
        outDir: 'dist',
        emptyOutDir: false,
        rollupOptions: {
            input: { kickpage: resolve(__dirname, 'src/kickPage.js') },
            output: {
                entryFileNames: '[name].js',
                chunkFileNames: '[name].js',
                assetFileNames: 'kickpage.[ext]',
                format: 'iife',
                name: 'NiconamaSidebarKick',
            },
        },
        target: 'es2015',
        minify: false,
        sourcemap: process.env.NODE_ENV !== 'production',
        cssCodeSplit: false,
    },
    publicDir: false,
})
