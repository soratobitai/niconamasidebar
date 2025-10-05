import { defineConfig } from 'vite'
import { resolve } from 'path'
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'fs'

// カスタムプラグイン: 必要なファイルをコピー
function copyAssetsPlugin() {
  return {
    name: 'copy-assets',
    writeBundle() {
      // ファイルをコピーする関数
      function copyFile(src, dest) {
        try {
          copyFileSync(src, dest);
          console.log(`✓ Copied: ${src} -> ${dest}`);
        } catch (error) {
          console.error(`✗ Failed to copy: ${src} -> ${dest}`, error.message);
        }
      }

      // ディレクトリを再帰的にコピーする関数
      function copyDir(src, dest) {
        try {
          mkdirSync(dest, { recursive: true });
          
          const items = readdirSync(src);
          for (const item of items) {
            const srcPath = resolve(src, item);
            const destPath = resolve(dest, item);
            
            if (statSync(srcPath).isDirectory()) {
              copyDir(srcPath, destPath);
            } else {
              copyFile(srcPath, destPath);
            }
          }
        } catch (error) {
          console.error(`✗ Failed to copy directory: ${src} -> ${dest}`, error.message);
        }
      }

      console.log('📁 Copying assets to dist/...');
      
      // manifest.jsonをコピー
      copyFile('manifest.json', 'dist/manifest.json');
      
      // iconsフォルダをコピー
      copyDir('icons', 'dist/icons');
      
      // imagesフォルダをコピー
      copyDir('images', 'dist/images');
      
      console.log('✅ Assets copied successfully!');
    }
  }
}

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/main.js')
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
        format: 'iife', // IIFE形式で出力（ES6モジュールではない）
        name: 'NiconamaSidebar' // グローバル変数名
      }
    },
    target: 'es2015',
    minify: false,
    // 本番ビルドでは source map を出力しない
    sourcemap: process.env.NODE_ENV !== 'production',
    cssCodeSplit: false // CSSを別ファイルとして出力
  },
  publicDir: false, // 自動コピーを無効化
  plugins: [copyAssetsPlugin()],
  server: {
    port: 3000
  },
  // Watch設定を追加
  watch: {
    include: [
      'src/**/*',
      'manifest.json',
      'icons/**/*',
      'images/**/*'
    ],
    exclude: [
      'node_modules/**/*',
      'dist/**/*'
    ]
  }
}) 