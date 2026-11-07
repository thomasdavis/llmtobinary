// The GitHub emulator sign-in in a real browser: GITHUB_EMULATOR_PASSCODE=... node tests/e2e/auth-e2e.mjs <url>
// Proves the site's side of sign-in. It never talks to GitHub, so it says nothing about GitHub itself.
import { chromium, firefox } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const url = (process.argv[2] ?? "").replace(/\/$/, "");
const passcode = process.env.GITHUB_EMULATOR_PASSCODE;
if (!url || !passcode) throw new Error("usage: GITHUB_EMULATOR_PASSCODE=... auth-e2e.mjs <url>");
const cache = join(homedir(), ".cache/ms-playwright");
const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse() : [];
const executablePath = process.env.CHROMIUM_PATH ?? dirs.flatMap((d) => [join(cache, d, "chrome-linux/headless_shell"), join(cache, d, "chrome-headless-shell-linux64/chrome-headless-shell")]).find((p) => existsSync(p));
const browser = process.env.BROWSER === "firefox" ? await firefox.launch() : await chromium.launch({ executablePath });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

const context = await browser.newContext();
const page = await context.newPage();
const api = (path, init) => page.evaluate(async ([p, i]) => { const r = await fetch(p, i); return { status: r.status, body: await r.json().catch(() => null) }; }, [path, init]);

await page.goto(url);
const config = await api("/api/config");
check(config.body.accountsEmulated === true, "the site reports that sign-in is emulated");
check(config.body.accounts === false && config.body.signInRequired === false, "the public site shows no sign-in and does not require it");
await page.goto(`${url}/registry`);
await page.locator(".package-list li").first().waitFor({ timeout: 15000 });
check((await page.getByText("Sign in with GitHub").count()) === 0, "no sign-in button is shown");
check((await page.request.get(`${url}/api/auth/fake?id=1`, { maxRedirects: 0 })).status() === 404, "the test-only fake sign-in stays off");
check((await api("/api/me")).body.member === null, "the visitor starts signed out");

await page.goto(`${url}/api/auth/github`);
check(new URL(page.url()).pathname === "/api/auth/emulator/authorize", "sign-in goes to the emulator");
check((await page.getByText("This is not GitHub").count()) === 1, "the emulator says it is not GitHub");

await page.fill("input[name=passcode]", "wrong".repeat(10));
const [wrong] = await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]);
check(wrong.status() === 401, "a wrong passcode is refused");
await page.goBack();

await page.fill("input[name=passcode]", passcode);
await Promise.all([page.waitForURL(`${url}/`), page.click("button[type=submit]")]);
const me = await api("/api/me");
check(me.body.member?.id === -1 && me.body.member?.login === "emulated-owner", "the browser is signed in as the emulated account");
check(me.body.member?.role === "member", "the emulated account has no extra role");
check(me.body.quotaMicroUsd > 0, "the member has a generation quota");

const cookie = (await context.cookies()).find((c) => c.name === "__Host-lb_session");
check(cookie?.secure === true && cookie?.httpOnly === true && cookie?.sameSite === "Lax", "the session cookie is hardened");

const list = await api("/api/registry?limit=1");
const id = (list.body.items ?? list.body.packages ?? list.body.results ?? [])[0]?.id;
check(!!id, "a package is available to star");
const star = `/api/registry/${id}/star`;
check((await api(star, { method: "PUT" })).status === 200, "a signed-in member can star");
check((await api(star, { method: "DELETE" })).status === 200, "and remove the star");

await page.goto(`${url}/registry`);
await page.getByRole("button", { name: "Sign out" }).waitFor({ timeout: 15000 });
check((await page.getByRole("link", { name: "emulated-owner" }).count()) === 1, "the community bar shows the member");

check((await api("/api/me", { method: "DELETE" })).status === 200, "the account can be deleted, leaving nothing behind");
check((await api("/api/me")).body.member === null, "the session ends with the account");

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
