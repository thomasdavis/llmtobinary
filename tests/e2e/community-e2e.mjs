// Community pages in a real browser: node tests/e2e/community-e2e.mjs <url>
import { chromium, firefox } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const url = (process.argv[2] ?? "").replace(/\/$/, "");
if (!url) throw new Error("usage: community-e2e.mjs <url>");
const cache = join(homedir(), ".cache/ms-playwright");
const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse() : [];
const executablePath = process.env.CHROMIUM_PATH ?? dirs.flatMap((d) => [join(cache, d, "chrome-linux/headless_shell"), join(cache, d, "chrome-headless-shell-linux64/chrome-headless-shell")]).find((p) => existsSync(p));
const browser = process.env.BROWSER === "firefox" ? await firefox.launch() : await chromium.launch({ executablePath });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const errors = [];
for (const [label, viewport] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
  page.on("console", (m) => {
    // COEP blocks the analytics beacon on production. Scoped by URL so a real failure still counts.
    if (m.type() === "error" && !/google-analytics|googletagmanager|cloudflareinsights/.test(m.location().url ?? "")) errors.push(`${label}: ${m.text()} ${m.location().url}`);
  });
  await page.goto(`${url}/registry`);
  await page.getByRole("heading", { name: "Registry" }).waitFor();
  await page.locator(".package-list li").first().waitFor({ timeout: 15000 });
  check((await page.locator(".package-list li").count()) > 0, `${label}: the registry lists programs`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${label}: no horizontal scroll on the registry`);

  await page.selectOption("select[aria-label='Evidence class']", "E5");
  await page.waitForTimeout(1200);
  check((await page.getByText("No programs match.").count()) === 1, `${label}: filtering by evidence works and says when nothing matches`);
  await page.selectOption("select[aria-label='Evidence class']", "");
  await page.locator(".package-list li").first().waitFor();

  await page.locator(".package-list li a").first().click();
  await page.getByRole("heading", { name: "Evidence" }).waitFor();
  check(/^\/package\/sha256(:|%3A)/.test(new URL(page.url()).pathname), `${label}: a package has a content-addressed permalink`);
  check((await page.getByRole("link", { name: "Download bytes" }).count()) === 1, `${label}: bytes can be downloaded`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${label}: no horizontal scroll on a package page`);

  const open = page.getByRole("link", { name: "Open and run" });
  if (await open.count()) {
    await open.click();
    await page.waitForURL(/\?program=/);
    check(true, `${label}: Open and run reaches the machine`);
  }
  await page.close();
}

// A program built from library packages says so, and links to each one.
{
  const items = (await (await fetch(`${url}/api/registry?limit=50`)).json()).items;
  let linked = null;
  for (const p of items) {
    const d = await (await fetch(`${url}/api/registry/${p.object_id}`)).json();
    if (d.links?.uses.length) { linked = { id: p.object_id, slot: d.links.uses[0].slot }; break; }
  }
  if (linked) {
    const page = await browser.newPage();
    await page.goto(`${url}/package/${linked.id}`);
    await page.getByRole("heading", { name: "Built from" }).waitFor({ timeout: 15000 });
    check((await page.getByRole("link", { name: linked.slot, exact: true }).count()) >= 1, "a program built from the library links to the packages it reused");
    await page.close();
  } else console.log("- no linked program in the latest 50, so the Built from check was skipped");
}

const missing = await browser.newPage();
await missing.goto(`${url}/package/sha256:${"0".repeat(64)}`);
await missing.getByText("This object is not in the registry.").waitFor();
check(true, "an unknown object says so");
await missing.close();

check(errors.length === 0, `no page or console errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);
await browser.close();
console.log(failed ? `\n${failed} community checks failed` : "\nall community checks passed");
process.exit(failed ? 1 : 0);
