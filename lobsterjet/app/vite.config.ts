import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [wasm()],
  build: {
    // The SW and the bootstrap must live at known absolute paths with no
    // hashed filenames: registration and HTML injection reference them.
    rollupOptions: {
      input: { main: "index.html", sw: "src/sw.ts", bootstrap: "src/bootstrap.ts" },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
