// Real-browser checks for the chip view (/chip) against a deployed site.
//   node tests/e2e/chip-e2e.mjs <base-url> [screenshot-dir]
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit } from "playwright-core";

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
const shots = process.argv[3] ?? null;
if (!base) {
  console.error("usage: node tests/e2e/chip-e2e.mjs <base-url> [screenshot-dir]");
  process.exit(2);
}
if (shots) mkdirSync(shots, { recursive: true });
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};

const which = process.env.BROWSER ?? "chromium";
const exe = which === "chromium" ? executablePath() : undefined;
const browser = await ({ chromium, firefox, webkit }[which]).launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
console.log(`browser: ${which} ${browser.version()}`);

async function open(viewport, path, opts = {}) {
  const ctx = await browser.newContext({ viewport, reducedMotion: opts.reducedMotion ? "reduce" : "no-preference" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Play" }).waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector("button.is-primary")?.hasAttribute("disabled"), null, { timeout: 20_000 });
  return { ctx, page, errors };
}
const shot = async (page, name) => shots && page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
const counter = (page, label) => page.locator(".rail-counters dt", { hasText: label }).first().locator("xpath=following-sibling::dd[1]").textContent();
const num = (s) => Number(String(s).replace(/[^0-9]/g, ""));

// 1. Capstone at F=8: step, play, and the honesty line.
{
  const { ctx, page, errors } = await open({ width: 1600, height: 1000 }, "/chip?fixture=upstream-capstone-40.anma&F=8&x=7");
  ok(await page.getByText(/not measured cycles/).isVisible(), "honesty line visible");
  ok(await page.locator(".die-svg").count() === 1, "one die rendered");
  await shot(page, "01-loaded");
  await page.getByRole("button", { name: "Step instruction" }).click();
  await page.waitForTimeout(1500);
  const i1 = num(await counter(page, "Instructions"));
  ok(i1 >= 1, `step instruction executes (${i1} instructions)`);
  const t1 = num(await counter(page, "Modeled ticks"));
  ok(t1 > 0, `modeled ticks advance (${t1})`);
  await page.keyboard.press("Space");
  await page.waitForTimeout(2500);
  await shot(page, "02-playing");
  const i2 = num(await counter(page, "Instructions"));
  ok(i2 > i1, `play advances (${i1} → ${i2})`);
  ok((await page.locator(".die-svg .unit-glow").count()) > 0, "units glow while running");
  ok((await page.locator(".analyzer canvas").count()) === 1, "logic analyzer present");
  // Heat mode to the end.
  await page.getByRole("combobox", { name: "Clock" }).selectOption({ label: "Heat · 50k instr/s" });
  await page.getByText(/returned|trapped/).first().waitFor({ timeout: 30_000 });
  await shot(page, "03-heat-finished");
  const res = await page.locator(".rail-result").first().textContent();
  ok(/returned \d+/.test(res ?? ""), `capstone returns a value (${res})`);
  await page.getByRole("combobox", { name: "Clock" }).selectOption({ label: "12 ticks/s" });
  await page.waitForTimeout(500);
  ok(/returned/.test((await page.locator(".rail-result").first().textContent()) ?? ""), "result stays after leaving heat mode");
  ok(errors.length === 0, `no page errors (${errors.join(" | ")})`);
  await ctx.close();
}

// 2. Compare ANMA F=8 vs ANMR R=8 on one clock.
{
  const { ctx, page, errors } = await open({ width: 1920, height: 1080 }, "/chip?fixture=upstream-capstone-40.anma&F=8&compare=1&R=8&x=7");
  ok((await page.locator(".die-svg").count()) === 2, "compare renders two dies");
  await page.getByRole("combobox", { name: "Clock" }).selectOption({ label: "120 ticks/s" });
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForTimeout(4000);
  await shot(page, "04-compare");
  await page.getByRole("combobox", { name: "Clock" }).selectOption({ label: "Heat · 50k instr/s" });
  await page.waitForFunction(() => document.querySelectorAll(".rail-result").length === 2, null, { timeout: 30_000 });
  const results = await page.locator(".rail-result").allTextContents();
  ok(results.length === 2 && results[0] === results[1], `ANMA and ANMR agree (${results.join(" / ")})`);
  const now = await page.locator(".rail-now").nth(1).textContent();
  const cursor = await page.locator(".die-svg").nth(1).locator(".imem-row.is-current .imem-text").textContent();
  ok(!!cursor && (now ?? "").includes(cursor.replace(/…$/, "")), `rail and IMEM cursor agree after heat mode (${now} / ${cursor})`);
  await shot(page, "05-compare-done");
  ok(errors.length === 0, `no page errors (${errors.join(" | ")})`);
  await ctx.close();
}

// 3. Interactive/effectful program, laptop size, reduced motion.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 }, "/chip?fixture=hello.anma&F=4", { reducedMotion: true });
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForTimeout(2500);
  ok((await page.locator(".die-svg .packet").count()) === 0, "no travelling packets under reduced motion");
  await shot(page, "06-laptop-reduced-motion");
  ok(errors.length === 0, `no page errors (${errors.join(" | ")})`);
  await ctx.close();
}

// 4. Phone width: no horizontal scroll.
{
  const { ctx, page, errors } = await open({ width: 390, height: 844 }, "/chip?fixture=square-plus-two.anma&F=1&x=5");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 0, `no horizontal scroll at 390px (overflow ${overflow})`);
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForTimeout(3000);
  await shot(page, "07-phone");
  ok(errors.length === 0, `no page errors (${errors.join(" | ")})`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failure(s)` : "all chip checks passed");
process.exit(failures ? 1 : 0);
