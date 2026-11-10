import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // The backend checks Origin, so it must list http://localhost:1420 (its default).
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.RESONA_PORT ?? 4317}`, changeOrigin: true } },
  },
}));
