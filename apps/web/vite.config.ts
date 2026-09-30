import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

const commit = (() => {
  try {
    return execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
})();

// One build: the React client (served as Workers static assets) and the Worker (/api/*).
// The Cloudflare plugin runs the Worker and its Durable Objects in workerd during `vite dev`.
export default defineConfig({
  plugins: [react(), cloudflare()],
  define: { __BUILD_COMMIT__: JSON.stringify(commit) },
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 2000 },
});
