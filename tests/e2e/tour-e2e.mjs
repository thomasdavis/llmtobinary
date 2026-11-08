// Both explainer tours open, step through to the end, and fit a phone: node tests/e2e/tour-e2e.mjs <url> [screenshot-dir]
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const url = (process.argv[2] ?? "").replace(/\/$/, "");
const shots = process.argv[3];
const cache = join(homedir(), ".cache/ms-playwright");
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse().flatMap((d) => [join(cache, d, "chrome-linux/headless_shell"), join(cache, d, "chrome-headless-shell-linux64/chrome-headless-shell")]).find((p) => existsSync(p)) : undefined);
const browser = await chromium.launch({ executablePath });
let failed = 0;
const check = (ok, name) => { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) failed++; };
const walk = async (page, tag, prefix) => {
  const dialog = page.locator("dialog.intro[open]");
  await dialog.waitFor();
  const total = Number((await dialog.locator(".intro-kicker").textContent()).match(/of (\d+)/)[1]);
  for (let i = 1; i <= total; i++) {
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    if (wide) check(false, `${tag} step ${i} scrolls sideways`);
    if (shots) await page.screenshot({ path: join(shots, `${prefix}-${tag}-${i}.png`) });
    if (i < total) await dialog.getByRole("button", { name: "Next" }).click();
  }
  return { dialog, total };
};
for (const [tag, viewport] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844 }]]) {
  const page = await (await browser.newContext({ viewport })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  const one = await walk(page, tag, "part1");
  check(one.total === 9, `${tag}: part one still has its 9 steps`);
  await one.dialog.getByRole("button", { name: /from programs to an operating system/ }).click();
  const two = await walk(page, tag, "part2");
  check(two.total === 7 && (await two.dialog.textContent()).includes("Part 2"), `${tag}: part two opens from part one`);
  check(await two.dialog.getByRole("button", { name: "▶ Boot the OS" }).isVisible(), `${tag}: part two ends with Boot`);
  await page.goto(`${url}/boot`);
  await page.getByRole("button", { name: "Take the short tour" }).click();
  check((await page.locator("dialog.intro[open] .intro-kicker").textContent()).includes("Part 2"), `${tag}: Boot page opens the tour`);
  await page.keyboard.press("Escape");
  await page.goto(`${url}/registry`);
  await page.getByRole("button", { name: "What is this?" }).click();
  check((await page.locator("dialog.intro[open] .intro-kicker").textContent()).includes("Part 2"), `${tag}: Registry opens the tour`);
  check(errors.length === 0, `${tag}: no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
}
await browser.close();
process.exit(failed ? 1 : 0);
