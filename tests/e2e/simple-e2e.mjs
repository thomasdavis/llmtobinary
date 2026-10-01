// Real-browser checks for the first-visit experience: the explainer, the simple view, and the
// AI-written example.   node tests/e2e/simple-e2e.mjs <base-url> [screenshot-dir]
import { existsSync, mkdirSync, readdirSync } from "node:fs";
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
const shots = process.argv[3] ?? null;
if (!base) {
  console.error("usage: node tests/e2e/simple-e2e.mjs <base-url> [screenshot-dir]");
  process.exit(2);
}
if (shots) mkdirSync(shots, { recursive: true });
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};

const exe = executablePath();
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });

for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(base, { waitUntil: "networkidle" });
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 10_000 }).catch(() => undefined);
  ok(await dialog.isVisible(), `${label}: the explainer opens on a first visit`);
  const titles = [];
  const steps = await dialog.locator(".intro-dots button").count();
  for (let i = 0; i < steps; i++) {
    titles.push((await dialog.locator("h2").textContent()) ?? "");
    const overflow = await page.evaluate(() => {
      const d = document.querySelector("dialog.intro");
      return d ? d.scrollWidth - d.clientWidth : 0;
    });
    ok(overflow <= 0, `${label}: step ${i + 1} "${titles[i]}" fits without sideways scrolling`);
    if (shots) await page.screenshot({ path: join(shots, `${label}-intro-${i + 1}.png`) });
    if (i < steps - 1) await dialog.getByRole("button", { name: "Next" }).click();
  }
  ok(titles[0] === "Computers only understand binary" && titles.includes("How the AI writes a program: draft, check, fix") && titles.includes("Notes the AI attaches: claims, contracts, examples") && titles.includes("Making AI better at writing ANMA-1") && titles.includes("Is ANMA-1 a real chip?"), `${label}: the story covers binary, the generation loop, annotations and manufacturing (${steps} steps)`);
  await dialog.getByRole("button", { name: "Close the explanation" }).click();
  ok(!(await dialog.isVisible()), `${label}: ✕ closes it`);
  await page.reload({ waitUntil: "networkidle" });
  ok(!(await page.getByRole("dialog").isVisible()), `${label}: it stays closed on the next visit`);
  await page.getByRole("button", { name: "What is this?" }).click();
  ok(await page.getByRole("dialog").isVisible(), `${label}: "What is this?" reopens it`);
  await page.keyboard.press("Escape");
  ok(!(await page.getByRole("dialog").isVisible()), `${label}: Escape closes it`);

  // The top bar stays in view and carries the view switch.
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(300);
  const bar = await page.locator("nav.topbar").boundingBox();
  ok(!!bar && bar.y <= 1, `${label}: the top bar stays pinned while scrolling`);
  ok((await page.getByRole("radio", { name: "Simple", exact: true }).getAttribute("aria-checked")) === "true", `${label}: the top bar shows Simple selected`);
  await page.mouse.wheel(0, -3000);

  // The program bar: one dropdown with the presets and everything visitors published.
  const pbar = await page.locator("nav.programbar").boundingBox();
  ok(!!pbar && Math.abs(pbar.y - (bar?.height ?? 48)) <= 2, `${label}: the program bar sits under the top bar`);
  await page.locator(".picker-trigger").click();
  const pop = page.getByRole("dialog", { name: "Choose a program" });
  ok(await pop.isVisible(), `${label}: the program dropdown opens`);
  ok((await pop.getByRole("group", { name: "Featured" }).count()) === 1 && (await pop.getByRole("group", { name: "Published by visitors" }).count()) === 1 && (await pop.getByRole("group", { name: "Reference programs" }).count()) === 1, `${label}: it groups featured, published and reference programs`);
  ok(/build a good looking version/.test((await pop.locator(".picker-row").first().textContent()) ?? ""), `${label}: rows show the prompt`);
  await page.keyboard.type("pong");
  ok((await pop.locator(".picker-row").count()) === 1, `${label}: search narrows the list`);
  await page.keyboard.press("Enter");
  await page.locator(".program-card").waitFor({ timeout: 20_000 });
  ok(!(await pop.isVisible()), `${label}: Enter loads the program and closes the dropdown`);
  ok((await page.locator(".picker-trigger-main").textContent()) === "Pong", `${label}: the bar names the loaded program`);
  ok(/not the AI/.test((await page.locator(".program-card").textContent()) ?? ""), `${label}: the card says a reference program was not written by the AI`);
  await page.getByRole("button", { name: "■ Stop execution" }).click({ timeout: 3000 }).catch(() => undefined);
  const gallery = await (await page.request.get(new URL("/api/gallery", base).href)).json();
  if (gallery.items.length > 0) {
    const g = gallery.items[0];
    await page.goto(new URL(`/?program=${g.id}`, base).href, { waitUntil: "networkidle" });
    await page.locator(".program-card").waitFor({ timeout: 20_000 });
    ok((await page.locator(".program-card-prompt").textContent())?.trim().startsWith(g.prompt.slice(0, 40)) === true, `${label}: a shared ?program= link opens a published program with its prompt`);
    ok(/asked by a visitor/.test((await page.locator(".program-card-by").textContent()) ?? ""), `${label}: the card credits the visitor's prompt`);
    await page.getByRole("button", { name: "■ Stop execution" }).click({ timeout: 3000 }).catch(() => undefined);
    await page.goto(base, { waitUntil: "networkidle" });
  } else ok(true, `${label}: (no published programs yet; shared-link check skipped)`);

  // Simple view hides the instrument's expert controls.
  ok((await page.getByLabel("Bundled fixture").count()) === 0, `${label}: the fixture picker is hidden`);
  ok((await page.getByText("output mode").count()) === 0, `${label}: generation research options are hidden`);

  // The last step's call to action runs the AI-written game.
  await page.getByRole("button", { name: "What is this?" }).click();
  for (let i = 0; i < steps - 1; i++) await page.getByRole("dialog").getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: /Watch the AI's game run/ }).click();
  await page.locator("p.status", { hasText: /state: (running|waiting-input)/ }).first().waitFor({ timeout: 30_000 });
  ok(true, `${label}: "Watch the AI's game run" loads and runs the AI-written program`);
  if (label === "phone") await page.getByRole("tab", { name: "executable" }).click();
  ok(await page.getByText(/Written by the AI \(gpt-6-luna\), byte by byte/).isVisible(), `${label}: the binary view says the AI wrote it`);
  ok((await page.locator(".plain-list li").count()) >= 40, `${label}: instructions are listed in plain English`);
  ok(/v\d+ = |Start of function/.test((await page.locator(".plain-list li").first().textContent()) ?? ""), `${label}: plain-English reading shown`);
  if (label === "phone") await page.getByRole("tab", { name: "machine" }).click();
  await page.waitForTimeout(2500);
  if (shots) await page.screenshot({ path: join(shots, `${label}-simple-running.png`), fullPage: label === "desktop" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 0, `${label}: no sideways page scroll (${overflow})`);
  ok((await page.locator('label:has-text("fast slots F")').count()) === 0, `${label}: F is hidden in the simple view`);
  await page.getByRole("button", { name: "■ Stop execution" }).click();

  // Expert view brings everything back.
  await page.getByRole("radio", { name: "Expert", exact: true }).click();
  ok((await page.getByLabel("Bundled fixture").count()) === 1, `${label}: expert view shows the fixture picker`);
  ok((await page.locator('label:has-text("fast slots F")').count()) === 1, `${label}: expert view shows F`);
  ok(errors.length === 0, `${label}: no page errors (${errors.join(" | ")})`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failure(s)` : "all simple-view checks passed");
process.exit(failures ? 1 : 0);
