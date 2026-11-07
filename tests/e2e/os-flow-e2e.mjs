// The whole community loop in a real browser, with no command-line steps inside it (A3.7, A6.7, A7.4):
// sign in, pick a slot, generate, see the candidate, compose a build, boot it.
// Runs against a local server in the test environment, which enables the fake sign-in and model.
//
//   node tests/e2e/os-flow-e2e.mjs <url>
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const url = (process.argv[2] ?? "").replace(/\/$/, "");
if (!url) throw new Error("usage: os-flow-e2e.mjs <url>");
const cache = join(homedir(), ".cache/ms-playwright");
const dirs = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
const executablePath = process.env.CHROMIUM_PATH ?? dirs.flatMap((d) => [join(cache, d, "chrome-linux/headless_shell"), join(cache, d, "chrome-headless-shell-linux64/chrome-headless-shell")]).find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath });

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// Sign in.
await page.goto(`${url}/api/auth/fake?id=4242&login=e2e-member`);
await page.goto(`${url}/os`);
await page.getByRole("heading", { name: "OS board" }).waitFor();
await page.getByRole("link", { name: "e2e-member" }).waitFor();
check(true, "signed in, and the board shows the member");

// Generate for a slot.
const before = await (await page.request.get(`${url}/api/slots/str`)).json();
await page.locator("li", { hasText: "str" }).first().getByRole("button", { name: "Generate" }).click();
await page.getByText(/Submitted\. The verifier will test it/).waitFor({ timeout: 60000 });
check(true, "a member generated a candidate for a slot from the board");
await page.waitForTimeout(1500);
const after = await (await page.request.get(`${url}/api/slots/str`)).json();
check(after.candidates.length === before.candidates.length + 1, "the new candidate appears on the slot");

// The verifier judges the candidate. In production this is the running service.
const added = after.candidates.find((c) => !before.candidates.some((b) => b.object_id === c.object_id));
if (process.env.VERIFIER_COMMAND) {
  execSync(process.env.VERIFIER_COMMAND, { stdio: "ignore", timeout: 120000 });
  await page.waitForTimeout(1000);
  const judged = (await (await page.request.get(`${url}/api/slots`)).json()).slots.find((s) => s.id === "str");
  check(judged.winner.object_id === added.object_id && judged.winner.evidence_class === "E3", "the verifier passed it, and the rule made it the slot's default");
}

// Compose and publish from the winners.
await page.goto(`${url}/compose`);
await page.getByRole("heading", { name: "Compose a build" }).waitFor();
await page.getByRole("button", { name: "Link" }).waitFor();
if (process.env.VERIFIER_COMMAND) check((await page.getByLabel(/^str /).first().inputValue()) === added.object_id, "Compose selects the member's candidate");
await page.getByRole("button", { name: "Link" }).click();
await page.getByText(/^Linked: /).waitFor({ timeout: 20000 });
check(true, "the browser linked the selected packages");
await page.getByLabel("Build name").fill("e2e build");
await page.getByRole("button", { name: "Publish build" }).click();
await page.getByRole("link", { name: "Boot this build" }).waitFor({ timeout: 20000 });
check(true, "the server re-linked and accepted the build");

// Boot it.
await page.getByRole("link", { name: "Boot this build" }).click();
const term = page.getByRole("textbox", { name: "Terminal" });
await term.waitFor();
await page.getByText("anma os").waitFor({ timeout: 30000 });
await term.click();
await page.keyboard.type("ls\n");
await page.getByText(/hello\s+crash\s+spin/).waitFor({ timeout: 15000 });
check(true, "the forked build boots and lists the disk");
if (process.env.VERIFIER_COMMAND) {
  const builds = (await (await page.request.get(`${url}/api/builds`)).json()).builds;
  check(builds[0].lock_slots?.str === added.object_id, "the booted build contains the member's candidate");
}
await page.keyboard.type("run hello\n");
await page.getByText("hello from disk").waitFor({ timeout: 15000 });
await page.keyboard.type("run crash\n");
await page.getByText("trapped").waitFor({ timeout: 15000 });
await page.keyboard.type("write note kept\n");
await page.waitForTimeout(800);
check(true, "programs run from disk, and the shell survives a crash");

// Reload: the disk is the browser's.
await page.reload();
await term.waitFor();
await page.getByText("anma os").waitFor({ timeout: 30000 });
await term.click();
await page.keyboard.type("cat note\n");
await page.getByText("kept").waitFor({ timeout: 15000 });
check(true, "a file survives a page reload");

// Live generation needs the page's permission, outside the guest.
const hasGen = await page.evaluate(async () => (await (await fetch("/default-build.json")).json()).authority.includes("gen.request"));
if (hasGen) {
  await page.goto(`${url}/boot`);
  await term.waitFor();
  await page.getByText("anma os").waitFor({ timeout: 30000 });
  let sessions = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/generation-sessions")) sessions++;
  });
  await term.click();
  await page.keyboard.type("gen tool a greeting\n");
  await page.getByRole("alertdialog").waitFor({ timeout: 15000 });
  check(sessions === 0, "nothing is spent until the page confirms");
  check((await page.getByRole("alertdialog").getByText("a greeting").count()) === 1, "the confirmation shows the exact prompt");
  await page.getByRole("button", { name: "Refuse" }).click();
  await term.click();
  await page.keyboard.type("\n");
  await page.getByText("generation failed").waitFor({ timeout: 15000 });
  check(sessions === 0, "a refusal spends nothing, and the OS keeps running");
  await page.keyboard.type("gen tool2 a greeting\n");
  await page.getByRole("button", { name: "Allow" }).click({ timeout: 15000 });
  await page.getByText(/Done\. Press Enter/).waitFor({ timeout: 60000 });
  await term.click();
  await page.keyboard.type("\n");
  await page.getByText("generated tool2").waitFor({ timeout: 15000 });
  await page.keyboard.type("run tool2\n");
  await page.getByText(/ok\s/).last().waitFor({ timeout: 15000 });
  check(sessions === 1, "a confirmed request arrives on the running OS and runs with no reboot");
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await browser.close();
console.log(failed ? `\n${failed} checks failed` : "\nall flow checks passed");
process.exit(failed ? 1 : 0);
