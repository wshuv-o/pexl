// Builds the server-side export runtime (src/server/export-cli.ts) into
// dist-server/export-workbook.mjs. npm dependencies stay external and load
// from the repo's node_modules, the same packages the browser bundle uses.
//   npm run build:export
import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  // xlsx-js-style is CommonJS; Node cannot expose it as the namespace
  // import excel-export.ts uses, so it is bundled instead of loaded.
  ssr: { noExternal: ["xlsx-js-style"] },
  build: {
    ssr: "src/server/export-cli.ts",
    outDir: "dist-server",
    emptyOutDir: true,
    target: "node18",
    rollupOptions: {
      output: { entryFileNames: "export-workbook.mjs", format: "es" },
    },
  },
});
