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

// 2. The ANMA-1 vs ANMR-1 compare is hidden (kept in code), even with ?compare=1.
{
  const { ctx, page, errors } = await open({ width: 1600, height: 1000 }, "/chip?fixture=upstream-capstone-40.anma&F=8&compare=1&R=8&x=7");
  ok((await page.locator(".die-svg").count()) === 1, "compare is hidden: one die even with ?compare=1");
  ok((await page.getByText("Compare with ANMR-1").count()) === 0, "no compare control");
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

// 3b. Recursive fibonacci grows the call stack on the die.
{
  const { ctx, page, errors } = await open({ width: 1600, height: 1000 }, "/chip?fixture=fibonacci.anma&F=4&x=7");
  await page.getByRole("combobox", { name: "Clock" }).selectOption({ label: "120 ticks/s" });
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".die-svg .frame-bar").length > 2, null, { timeout: 30_000 }).catch(() => undefined);
  const bars = await page.locator(".die-svg .frame-bar").count();
  ok(bars > 2, `call stack shows nested calls (${bars} frames)`);
  await shot(page, "07b-fibonacci-stack");
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

// 5. Live chip in the machine panel: it lights up for the panel's own run.
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(base, { waitUntil: "networkidle" });
  const live = page.locator("section.livechip");
  const liveCount = async (label) => num(await live.locator(".rail-counters dt", { hasText: label }).first().locator("xpath=following-sibling::dd[1]").textContent());

  // Slowed run: the machine itself runs at 10 instructions per second and every microstep is shown.
  await page.getByRole("button", { name: "square-plus-two.anma" }).click();
  await page.getByText(/✓ task-passed/).waitFor({ timeout: 60_000 });
  await live.waitFor({ timeout: 10_000 });
  await live.getByRole("combobox", { name: "Speed" }).selectOption({ label: "10 instr/s" });
  await page.getByRole("button", { name: "▶ Run" }).click();
  await page.waitForTimeout(1200);
  const mid = await liveCount("Instructions");
  ok(mid > 0 && (await live.locator(".unit-glow").count()) > 0, `slowed run lights the chip (${mid} instructions after 1.2 s)`);
  await shot(page, "08-live-slow");
  await page.getByText(/state: halted/).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  ok((await page.getByLabel("Terminal output").textContent()) === "146", "slowed run prints the same terminal output");
  ok((await liveCount("Instructions")) >= mid, "chip counters reach the end of the run");

  await live.getByRole("combobox", { name: "Speed" }).selectOption({ label: "Full speed" });

  // Full speed: the chip adopts the machine's own state, including hardware evictions.
  await page.getByRole("button", { name: "upstream-capstone-40.anma" }).click();
  await page.getByText("d6e710f149bac62226ad57f9d3a2f4e4bf958cebbf3727994f0ec5477013e88a").waitFor();
  await page.getByText(/✓ task-passed/).waitFor({ timeout: 60_000 });
  await page.locator('label:has-text("fast slots F") select').selectOption("4");
  await page.getByRole("button", { name: "▶ Run" }).click();
  await page.getByText(/state: halted/).waitFor({ timeout: 30_000 });
  ok((await liveCount("Evictions")) > 0, `full-speed capstone at F = 4 shows hardware evictions on the chip (${await liveCount("Evictions")})`);

  // Pong at full speed with live keys: activity glow and the framebuffer beside the die in full screen.
  await page.getByRole("button", { name: "ball-paddle.anma" }).click();
  await page.getByText("d87054b75358754cdbd3a671962ed6f783669794bdda8491be2440cd19b7b64a").waitFor({ timeout: 30_000 });
  await page.getByText(/✓ task-passed|✕ task-failed/).first().waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "▶ Run" }).click();
  await page.getByText(/state: (running|waiting-input)/).first().waitFor({ timeout: 10_000 });
  await live.getByRole("button", { name: "Full screen" }).click();
  await page.locator("section.livechip.is-expanded").waitFor({ timeout: 5000 });
  await page.locator("section.livechip canvas.fb").click();
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(1200);
  ok((await live.locator(".unit-glow").count()) > 0, "pong at full speed lights the chip");
  const die = await live.locator(".die-svg").boundingBox();
  const fb = await live.locator("canvas.fb").boundingBox();
  ok(!!die && !!fb && fb.x > die.x + die.width - 2, `framebuffer sits beside the die in full screen (die right ${Math.round(die.x + die.width)}, fb left ${Math.round(fb.x)})`);
  const lit = await page.evaluate(() => {
    const c = document.querySelector("section.livechip canvas.fb");
    const d = c.getContext("2d").getImageData(0, 0, 256, 144).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  ok(lit > 0, `framebuffer shows the game (${lit} drawn pixels)`);
  ok(await live.getByRole("button", { name: "Pause", exact: true }).isVisible(), "full screen carries its own controls");
  await shot(page, "09-live-pong-fullscreen");
  await live.getByRole("button", { name: "Exit full screen" }).click();
  ok((await page.locator("section.livechip.is-expanded").count()) === 0, "exit full screen");
  await page.getByRole("button", { name: "■ Stop execution" }).click();
  await shot(page, "10-live-sidebar");
  ok(errors.length === 0, `no page errors (${errors.join(" | ")})`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failure(s)` : "all chip checks passed");
process.exit(failures ? 1 : 0);
