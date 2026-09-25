import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** The Fastify orchestrator (api/) in development. */
const apiTarget = process.env.API_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Obvious preview URLs (*.e2b.app) serve this dev server from outside;
    // vite's host check would otherwise block them.
    allowedHosts: [".e2b.app"],
    proxy: {
      "/system": apiTarget,
      "/corpus": apiTarget,
      "/validate": apiTarget,
      "/derive": apiTarget,
      "/crack": apiTarget,
      "/runs": apiTarget,
      // WebSocket: the live run feed.
      "/ws": { target: apiTarget, ws: true },
    },
  },
});
