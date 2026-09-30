// Real-browser checks for the fast engine (ANMA-1 translated to WebAssembly), the chip-time
// readout, and remembered settings.
//   node tests/e2e/engine-e2e.mjs <base-url>
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

function executablePath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = join(homedir(), ".cache/ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const d of readdirSync(cache).filter((x) => x.startsWith("chromium_headless_shell-")).sort().reverse()) {
    const p = join(cache, d, "chrome-linux/headless_shell");
    if (existsSync(p)) return p;
  }
  return undefined;
}

const base = process.argv[2]?.replace(/\/$/, "");
if (!base) {
  console.error("usage: node tests/e2e/engine-e2e.mjs <base-url>");
  process.exit(2);
}
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};

const exe = executablePath();
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.addInitScript(() => {
  // These suites exercise the full instrument: start in expert view with the explainer dismissed.
  localStorage.setItem("llmtobinary.settings.v1.expert", "true");
  localStorage.setItem("llmtobinary.settings.v1.introSeen", "true");
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(base, { waitUntil: "networkidle" });
await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("llmtobinary.settings")).forEach((k) => localStorage.removeItem(k)));
await page.reload({ waitUntil: "networkidle" });

const engine = (name) => page.getByRole("radio", { name, exact: true });
const manifest = JSON.parse(readFileSync(new URL("../../fixtures/manifest.json", import.meta.url), "utf8"));
/** Load a bundled fixture and wait until THAT program is selected and tested (not a stale badge). */
async function loadFixture(file) {
  const sha = manifest.fixtures.find((f) => f.file === file).sha256;
  await page.getByRole("button", { name: file, exact: true }).first().click();
  await page.getByText(sha).waitFor({ timeout: 30_000 });
  await page.getByText(/✓ task-passed|✕ task-failed/).first().waitFor({ timeout: 60_000 });
}
const statusIs = (re) => page.locator("p.status", { hasText: re }).first().waitFor({ timeout: 60_000 });

// 1. Same program, both engines, same output.
await loadFixture("square-plus-two.anma");
for (const name of ["Exact", "Fast"]) {
  await engine(name).click();
  await page.getByRole("button", { name: "▶ Run" }).click();
  await statusIs(/state: halted/);
  ok((await page.getByLabel("Terminal output").textContent()) === "146", `${name} engine prints 146`);
}
ok(await page.locator(".engine-note").isVisible(), "fast engine explains what it does and does not simulate");
ok(await page.getByRole("button", { name: "↦ Step" }).isDisabled(), "Step needs the exact engine");
ok(await page.getByText(/On an ANMA chip/).isVisible(), "chip-time readout is shown");
ok(/for this run so far|per frame/.test((await page.locator(".chip-time-big").textContent()) ?? ""), "chip time is reported");

// 2. Pong on the fast engine with live keys.
await loadFixture("ball-paddle.anma");
await page.getByRole("button", { name: "▶ Run" }).click();
await statusIs(/state: (running|waiting-input)/);
await page.locator("section.livechip canvas.fb").click();
await page.keyboard.down("ArrowRight");
await page.waitForTimeout(2000);
await page.keyboard.up("ArrowRight");
const ticks = async () => Number(/\((\d+)\)/.exec((await page.getByRole("button", { name: /Replay ticks/ }).textContent()) ?? "")?.[1] ?? 0);
ok((await ticks()) > 20, `pong runs on the fast engine (${await ticks()} ticks in ~2 s)`);
ok(await page.locator("section.livechip input[type=checkbox]").first().isDisabled(), "lights are off on the fast engine");
ok(/per frame/.test((await page.locator(".chip-time-big").textContent()) ?? ""), `chip time per frame: ${(await page.locator(".chip-time-big").textContent())?.trim()}`);
await page.getByRole("button", { name: "■ Stop execution" }).click();

// 3. The model-generated Mario on the fast engine: real frames per second in this browser.
const mario = readFileSync(new URL("../../packages/runtime/test/generated/mario-platformer-b.anma", import.meta.url));
await page.locator('input[type="file"]').setInputFiles({ name: "mario.anma", mimeType: "application/octet-stream", buffer: mario });
await page.getByText(/Imported executable loaded/).waitFor({ timeout: 20_000 });
await page.getByRole("button", { name: "▶ Run" }).click();
await statusIs(/state: (running|waiting-input)/);
await page.waitForTimeout(1500);
const t0 = await ticks();
await page.waitForTimeout(4000);
const fps = ((await ticks()) - t0) / 4;
console.log(`  Mario on the fast engine: ${fps.toFixed(1)} frames per second in headless Chromium`);
ok(fps >= 5, `Mario runs at a playable rate on the fast engine (${fps.toFixed(1)} fps)`);
await page.getByRole("button", { name: "■ Stop execution" }).click();

// 4. Settings are remembered across visits.
await engine("Exact").click();
await page.locator('label:has-text("fast slots F") select').selectOption("4");
await loadFixture("ball-paddle.anma");
await page.locator('label:has-text("ticks per second") select').selectOption("60");
await page.getByRole("button", { name: "▶ Run" }).click();
await statusIs(/state: (running|waiting-input|paused)/);
await page.getByRole("combobox", { name: "Chip clock" }).selectOption("100");
await page.locator("section.livechip").getByRole("combobox", { name: "Speed" }).selectOption({ label: "10 instr/s" });
await page.locator("section.livechip label:has-text('Lights') input").uncheck();
await page.getByRole("button", { name: "■ Stop execution" }).click();
await engine("Fast").click();
await page.reload({ waitUntil: "networkidle" });
await loadFixture("ball-paddle.anma");
ok((await engine("Fast").getAttribute("aria-checked")) === "true", "engine choice remembered");
ok((await page.locator('label:has-text("fast slots F") select').inputValue()) === "4", "F remembered");
ok((await page.locator('label:has-text("ticks per second") select').inputValue()) === "60", "tick rate remembered");
await engine("Exact").click();
await page.getByRole("button", { name: "▶ Run" }).click();
await statusIs(/state: (running|waiting-input|paused)/);
ok((await page.getByRole("combobox", { name: "Chip clock" }).inputValue()) === "100", "chip clock remembered");
ok((await page.locator("section.livechip").getByRole("combobox", { name: "Speed" }).inputValue()) === "3", "chip speed remembered");
ok(!(await page.locator("section.livechip label:has-text('Lights') input").isChecked()), "lights setting remembered");
await page.getByRole("button", { name: "■ Stop execution" }).click();

ok(errors.length === 0, `no page errors (${errors.join(" | ")})`);
await browser.close();
console.log(failures ? `${failures} failure(s)` : "all engine checks passed");
process.exit(failures ? 1 : 0);
