import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  server: {
    port: 5178,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:4310",
      "/health": "http://localhost:4310",
      "/ws": {
        target: "ws://localhost:4310",
        ws: true
      }
    }
  },
  build: {
    outDir: path.resolve(__dirname, "../public"),
    emptyOutDir: true,
    cssMinify: "lightningcss"
  }
});
