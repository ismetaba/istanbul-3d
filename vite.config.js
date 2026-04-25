import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

// `data/` holds generated GeoJSON committed for demo determinism. We point
// Vite's publicDir at it so the contents are served at the site root in dev
// and copied into `dist/` on build. Files are addressed as `/besiktas-buildings.geojson`,
// `/districts.json`, etc.
export default defineConfig({
  plugins: [cesium()],
  publicDir: 'data',
  // Top-level await + dynamic import in main.js need a modern target.
  // All evergreen browsers (Chrome 89+, Safari 15+, Firefox 89+) support it.
  build: {
    target: 'es2022',
  },
  server: {
    host: true,
    port: 5173,
    open: true,
  },
});
