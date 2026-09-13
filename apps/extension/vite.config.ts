import { defineConfig } from 'vite';
import { resolve } from 'path';
import fs from 'fs';

export default defineConfig({
  plugins: [
    {
      name: 'copy-assets',
      closeBundle() {
        const outDir = resolve(__dirname, 'dist');
        
        // Copy manifest.json
        fs.copyFileSync(resolve(__dirname, 'manifest.json'), resolve(outDir, 'manifest.json'));
        
        // Copy block files
        fs.copyFileSync(resolve(__dirname, 'block.html'), resolve(outDir, 'block.html'));
        fs.copyFileSync(resolve(__dirname, 'block.js'), resolve(outDir, 'block.js'));
        
        // Vite natively handles copying the public/ directory to the root of dist/
        // We do not need to duplicate them into dist/public/
        
        console.log('✅ Assets copied to dist/');
      }
    }
  ],
  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        background: resolve(__dirname, 'background.js'),
      },
      output: {
        entryFileNames: `[name].js`,
        chunkFileNames: `assets/[name].js`,
        assetFileNames: `assets/[name].[ext]`,
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'esbuild',
  },
});
