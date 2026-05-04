import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig(() => ({
  // Set base to '/' for root domain, or '/foldername/' for subfolder deployment
  base: "/",
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
      port: 8081,
    },
    allowedHosts: true as const,
  },
  preview: {
    allowedHosts: true as const,
  },
  build: {
    target: "esnext",
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
}));