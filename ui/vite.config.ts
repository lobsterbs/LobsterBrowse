import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 4141 },
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        manualChunks(id) {
          /* M3E's theme generator is a useful standalone runtime chunk.
             Keep it separate from the app entry so the main bundle stays
             below Vite's warning threshold without changing registration. */
          if (id.includes("/@m3e/web/dist/theme.js")) return "m3e-theme";
          if (/\/@m3e\/web\/dist\/(button|button-group|icon|icon-button)\.js$/.test(id)) {
            return "m3e-controls";
          }
        },
      },
    },
  },
});
