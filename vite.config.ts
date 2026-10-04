import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { fileURLToPath } from 'node:url';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: fromRoot('./source'),
  base: './',
  publicDir: false,
  plugins: [react()],
  resolve: { alias: { '@': fromRoot('./source') } },
  css: { postcss: { plugins: [tailwindcss()] } },
  build: {
    outDir: fromRoot('./.build'),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/portfolio.js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (asset) => asset.names.some(name => name.endsWith('.css'))
          ? 'assets/portfolio.css'
          : 'assets/[name][extname]',
      },
    },
  },
});
