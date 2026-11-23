import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Vite 8's default cssMinify (lightningcss with its targets) drops the
// standard backdrop-filter declarations and keeps only the
// -webkit-backdrop-filter aliases, which this app's Chromium does not
// paint (proven live, wave 120): every frosted surface lost its blur.
// cssMinify: false keeps the authored semantics; the css is authored compact.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 4141 },
  build: { outDir: "dist", cssMinify: false },
});
