# llmtobinary — notes for Claude

- **Debugging a user's generation session:** when the user pastes `llmtobinary debug <production|staging> <session-id>`, run `node scripts/debug-session.mjs <that line>`.
  - It fetches the private R2 archive (server side, plus the browser side if they pressed "Share for debugging") with wrangler.
  - It prints a timeline and saves JSON (and the framebuffer PNG) to `debug-sessions/<env>/<id>/`, which is gitignored.
  - Read `server.json` (`candidates` holds every draft in full; `conversation` is what the model saw) and `browser.json` (full test reports, machine state).
- Deploy: `cd apps/web && pnpm run deploy:staging` / `pnpm run deploy`. E2E: `node tests/e2e/{browser,chip,custom-prompt}-e2e.mjs <url>`.
- The box is shared and often loaded: run builds and tests with `nice`. The workerd suite (`pnpm test:worker`) can time out at pool startup under load.
- **Public program list:** published programs live at `gallery/<id>.json` in the debug R2 bucket (`apps/web/worker/gallery.ts`). Remove one with `npx wrangler r2 object delete llmtobinary-debug/gallery/<id>.json --remote` (staging: `llmtobinary-debug-staging`). E2E runs untick "publish" so tests never seed the list.
