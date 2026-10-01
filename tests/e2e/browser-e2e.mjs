// Real-browser end-to-end checks against a deployed llmtobinary site (headless Chromium).
//   node tests/e2e/browser-e2e.mjs <base-url> [--live]    (--live runs one real OpenAI generation)
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit } from "playwright-core";

// Use CHROMIUM_PATH, else any cached Playwright headless shell (avoids a large download).
function executablePath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = join(homedir(), ".cache/ms-playwright");
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
  for (const d of dirs) {
    const p = join(cache, d, "chrome-linux/headless_shell");
    if (existsSync(p)) return p;
  }
  return undefined;
}

const base = process.argv[2]?.replace(/\/$/, "");
const live = process.argv.includes("--live");
if (!base) {
  console.error("usage: node tests/e2e/browser-e2e.mjs <base-url> [--live]");
  process.exit(2);
}
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};

// TEST-ONLY encoder for a runaway loop: fn0() -> u64 { i = 0; loop { i = i + 1 } }
function runawayHex() {
  const recs = [[1, 0, 0, 1], [2, 0, 0, 1], [0x10, 0, 0, 0], [0x40, 1, 1, 0], [0x44, 0, 0, 0], [2, 1, 1, 3], [3, 0, 1, 0], [0x10, 1, 1, 0], [0x20, 2, 0, 1], [0x40, 1, 1, 0], [0x44, 2, 0, 0], [4, 0, 0, 0]];
  const b = Buffer.alloc(32 + recs.length * 16);
  b.write("ANMA", 0, "latin1");
  [1, 0, recs.length, 0, 0, 0, 0].forEach((w, i) => b.writeUInt32LE(w, 4 + 4 * i));
  recs.forEach((r, i) => r.forEach((w, j) => b.writeUInt32LE(w >>> 0, 32 + 16 * i + 4 * j)));
  return b.toString("hex");
}

const which = process.env.BROWSER ?? "chromium";
const exe = which === "chromium" ? executablePath() : undefined;
const browser = await ({ chromium, firefox, webkit }[which]).launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
console.log(`browser: ${which} ${browser.version()}`);
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(() => {
  // These suites exercise the full instrument: start in expert view with the explainer dismissed.
  localStorage.setItem("llmtobinary.settings.v1.expert", "true");
  localStorage.setItem("llmtobinary.settings.v1.introSeen", "true");
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const statusIs = (s, timeout = 30_000) => page.getByText(new RegExp(`state: ${s}`)).first().waitFor({ timeout });

await page.goto(base, { waitUntil: "networkidle" });
ok((await page.title()) === "llmtobinary", "page title");
ok(await page.getByText("OpenAI generation · TypeScript virtual-machine execution in your browser.").isVisible(), "execution-location disclosure visible");
await page.getByText(/spec ANMA-1\/prd-3\.2/).waitFor({ timeout: 15_000 });

// Fixture: square-plus-two at F=16 then F=1 (same bytes, fresh machine)
await page.getByLabel("Bundled fixture").selectOption("square-plus-two.anma");
  await page.getByRole("button", { name: "Load", exact: true }).click();
await page.getByText("d3f7f9e0446680bd1f5d20534d2a413df893e891f7e78f26f37cbe75b48405c1").waitFor();
ok(true, "fixture loaded; inspector shows the exact SHA-256");
await page.getByText(/✓ task-passed/).waitFor({ timeout: 60_000 });
ok(true, "fixture passes its task tests in the machine worker");
await page.getByRole("button", { name: "▶ Run" }).click();
await statusIs("halted");
ok((await page.getByLabel("Terminal output").textContent()) === "146", "terminal prints 146 for n = 12");
await page.locator('label:has-text("fast slots F") select').selectOption("1");
await statusIs("halted");
ok((await page.getByLabel("Terminal output").textContent()) === "146", "F = 1 reruns the same bytes with the same output");
await page.getByRole("button", { name: /Compare across F/ }).click();
await page.getByText(/✓ identical return value, terminal bytes, effects, and framebuffer at every completed F/).waitFor({ timeout: 60_000 });
ok(true, "same-binary comparison across F = 1/4/8/16/32/64 agrees");

// T3 in the browser: cross-origin isolation + chunked z3 prove the task contract
ok(await page.evaluate(() => self.crossOriginIsolated), "page is cross-origin isolated (COOP + COEP)");
await page.getByText(/Formal verification \(T3/).click();
await page.getByRole("button", { name: "Verify with z3" }).click();
await page.locator("details.verify").getByText(/proved to meet|refuted|unproven|unavailable/).first().waitFor({ timeout: 240_000 });
ok((await page.locator("details.verify").textContent()).includes("✓ proved to meet the task specification for all inputs (partial correctness)"), "T3 proves square-plus-two against its task contract in the browser");

// Capstone: real backing traffic at F = 4
await page.getByLabel("Bundled fixture").selectOption("upstream-capstone-40.anma");
  await page.getByRole("button", { name: "Load", exact: true }).click();
await page.getByText("d6e710f149bac62226ad57f9d3a2f4e4bf958cebbf3727994f0ec5477013e88a").waitFor();
await page.getByText(/✓ task-passed/).waitFor({ timeout: 60_000 });
await page.locator('label:has-text("fast slots F") select').selectOption("4");
await page.getByRole("button", { name: "▶ Run" }).click();
await page.getByText(/state: halted · return 13514254791259192080/).waitFor({ timeout: 30_000 });
const backingWrites = await page.locator("tr", { hasText: "backing writes" }).locator("td.num").textContent();
ok(Number(backingWrites.replace(/,/g, "")) > 0, `capstone at F = 4 shows backing writes (${backingWrites})`);
ok(await page.getByText("13514254791259192080").first().isVisible(), "capstone returns the upstream reference value");

// Runaway program: imported bytes start stopped; Stop works mid-run
await page.locator('input[type="file"]').setInputFiles({ name: "runaway.hex", mimeType: "text/plain", buffer: Buffer.from(runawayHex()) });
await page.getByText(/Imported executable loaded \(stopped\)/).waitFor();
ok(true, "imported executable starts stopped");
await page.getByRole("button", { name: "▶ Run" }).click();
await page.getByRole("button", { name: "❚❚ Pause" }).click({ timeout: 2000 }).catch(() => undefined);
await page.locator("p.status", { hasText: /state: (paused|trapped)/ }).waitFor({ timeout: 5000 }).catch(() => undefined); // the worker confirms asynchronously
const afterPause = await page.locator("p.status").last().textContent();
ok(/state: (paused|trapped)/.test(afterPause), `Pause works mid-run (${afterPause.slice(0, 60)})`);
await page.getByRole("button", { name: "▶ Continue" }).click().catch(() => undefined);
await page.getByRole("button", { name: "■ Stop execution" }).click({ timeout: 2000 }).catch(() => undefined);
await page.getByText(/state: (cancelled|trapped)/).waitFor({ timeout: 20_000 });
const stopped = await page.locator("p.status").last().textContent();
ok(/cancelled|FUEL_EXHAUSTED/.test(stopped), `a runaway program ends by Stop or by its fuel limit, never hangs (${stopped.slice(0, 80)})`);

// Interactive: ball/paddle with keys; ticks are recorded for replay
await page.getByLabel("Bundled fixture").selectOption("ball-paddle.anma");
  await page.getByRole("button", { name: "Load", exact: true }).click();
await page.getByText(/✓ task-passed|✕ task-failed/).first().waitFor({ timeout: 60_000 });
await page.getByRole("button", { name: "▶ Run" }).click();
await page.getByText(/state: (running|waiting-input)/).waitFor({ timeout: 10_000 });
await page.locator("canvas.fb").click();
for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
await page.waitForTimeout(800);
await page.getByRole("button", { name: "■ Stop execution" }).click();
const replay = await page.getByRole("button", { name: /Replay ticks \((\d+)\)/ }).textContent();
ok(Number(/\((\d+)\)/.exec(replay)[1]) > 0, `interactive ticks recorded (${replay})`);

// Narrow layout: tabs, sticky stop, no horizontal scroll
await page.setViewportSize({ width: 390, height: 800 });
ok(await page.getByRole("tab", { name: "machine" }).isVisible(), "narrow screens use tabs");
ok(await page.getByRole("button", { name: "■ Stop", exact: true }).isVisible(), "Stop stays reachable on narrow screens");
ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal page scroll at 390 px");
await page.setViewportSize({ width: 1600, height: 1000 });

if (live) {
  await page.getByRole("tab", { name: "program" }).click().catch(() => undefined);
  await page.getByLabel(/I understand my task text/).check();
  await page.getByRole("button", { name: "Generate" }).click();
  const t0 = Date.now();
  await page.getByText(/✓ passed — validated and every task test passed in your browser|■ stopped|✕ infrastructure error/).first().waitFor({ timeout: 600_000 });
  const passed = await page.getByText(/✓ passed — validated/).count();
  ok(passed > 0, `live OpenAI generation through the deployed Worker ended passed (${Math.round((Date.now() - t0) / 1000)} s)`);
  if (passed) {
    await page.getByText(/OpenAI generation \(literal bytes/).first().waitFor({ timeout: 30_000 });
    await page.locator('label:has-text("fast slots F") select').selectOption("4");
    await statusIs("halted").catch(async () => {
      await page.getByRole("button", { name: "▶ Run" }).click();
      await statusIs("halted");
    });
    const term = await page.getByLabel("Terminal output").textContent();
    ok(term === "146", `the generated bytes execute locally in the browser (terminal ${JSON.stringify(term)})`);
    const sha = await page.locator("code.hash").first().textContent();
    console.log(`  generated artifact sha256 ${sha}`);
  }
}

ok(errors.length === 0, `no page or console errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);
await browser.close();
console.log(failures ? `\n${failures} browser check(s) failed` : "\nall browser checks passed");
process.exit(failures ? 1 : 0);
