import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

// トークンの流出先を構造的に塞ぐ。dev サーバーの HMR を妨げないようビルド時だけ埋め込む
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self' https://api.github.com https://raw.githubusercontent.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'self'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

function csp(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  // GitHub Pages のプロジェクトサイト（/<repo>/）でもルートでも動くよう相対パスにする
  base: './',
  plugins: [
    svelte(),
    csp(),
    VitePWA({
      strategies: 'generateSW',
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'mds — Markdown メモ',
        short_name: 'mds',
        description: 'GitHub のプライベートリポジトリに保存する Markdown メモ',
        display: 'standalone',
        start_url: './',
        scope: './',
        theme_color: '#1f6feb',
        background_color: '#ffffff',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: 'index.html',
        // api.github.com はキャッシュしない。同期エンジンが IndexedDB で面倒を見る
        runtimeCaching: [],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  build: {
    // CodeMirror と言語定義を含むため。コードブロック用の言語は遅延読み込みされる
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
});
