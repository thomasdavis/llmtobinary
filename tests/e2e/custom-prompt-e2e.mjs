// Real-browser checks for writing your own generation prompt.
//   node tests/e2e/custom-prompt-e2e.mjs <base-url> [--live]   (--live runs one real OpenAI generation)
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

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
  console.error("usage: node tests/e2e/custom-prompt-e2e.mjs <base-url> [--live]");
  process.exit(2);
}
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};

const exe = executablePath();
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(() => {
  // These suites exercise the full instrument: start in expert view with the explainer dismissed.
  localStorage.setItem("llmtobinary.settings.v1.expert", "true");
  localStorage.setItem("llmtobinary.settings.v1.introSeen", "true");
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(base, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.removeItem("llmtobinary.customPrompt.v1"));
await page.reload({ waitUntil: "networkidle" });

// Start from a curated task and edit it.
await page.getByRole("radio", { name: "Pick a task" }).click();
await page.getByRole("combobox", { name: "task" }).selectOption({ label: "Moving ball / keyboard paddle" });
await page.getByRole("button", { name: "Edit as my own prompt" }).click();
const prompt = page.getByRole("textbox", { name: "your prompt" });
ok((await prompt.inputValue()).includes("If key 6 (Escape) is down"), "Edit as my own prompt copies the task text");
ok(await page.getByText("fn0() -> u64").first().isVisible(), "…and its entry signature");
ok(await page.getByRole("checkbox", { name: "framebuffer" }).isChecked(), "…and its devices");

// Write from scratch: signature editor and a remembered draft.
await prompt.fill("Return the sum of the decimal digits of n.");
await page.getByRole("button", { name: "+ input" }).click();
ok(await page.getByText("fn0(arg0: u64) -> u64").isVisible(), "adding an input updates the signature");
await page.reload({ waitUntil: "networkidle" });
ok((await page.getByRole("textbox", { name: "your prompt" }).inputValue()) === "Return the sum of the decimal digits of n.", "the draft survives a reload");
ok(await page.getByRole("radio", { name: "Write your own" }).getAttribute("aria-checked") === "true", "a saved draft reopens the custom prompt");
ok(await page.getByText("fn0(arg0: u64) -> u64").isVisible(), "…with its signature");
for (const name of ["framebuffer", "event input", "typed heap"]) {
  const box = page.getByRole("checkbox", { name });
  if (await box.isChecked()) await box.uncheck();
}
if (await page.getByRole("checkbox", { name: "terminal" }).isChecked()) await page.getByRole("checkbox", { name: "terminal" }).uncheck();

if (live) {
  await page.getByText(/I understand my task text/).click();
  // Test runs never seed the public program list.
  const publish = page.getByLabel(/list the program and my prompt publicly/);
  if (await publish.isChecked()) await publish.uncheck();
  await page.getByRole("button", { name: "Generate" }).click();
  const modal = page.locator("dialog.genmodal");
  await modal.waitFor({ timeout: 10_000 });
  ok(await modal.isVisible(), "Generate opens the progress modal");
  await page.keyboard.press("Escape");
  ok(await modal.isVisible(), "the modal cannot be dismissed while the AI works");
  await modal.getByRole("heading", { name: "Finished" }).waitFor({ timeout: 360_000 });
  ok((await modal.locator(".genmodal-timeline li").count()) >= 3, "the modal shows the loop's steps");
  await modal.getByRole("button", { name: "Close" }).click();
  await page.getByText(/✓ executed; intent not independently verified|✓ passed|■ stopped/).first().waitFor({ timeout: 30_000 });
  const outcome = await page.locator(".outcome").first().textContent();
  ok(/executed; intent not independently verified/.test(outcome ?? ""), `custom prompt generates a program (${outcome?.trim()})`);
  await page.getByRole("button", { name: "Share for debugging" }).click();
  const line = await page.locator("code.debug-line").textContent({ timeout: 30_000 }).catch(() => null);
  ok(/^llmtobinary debug \w+ [0-9a-f-]{36}$/.test(line ?? ""), `Share for debugging returns a debug line (${line})`);
  if (line) console.log(`DEBUG_LINE ${line}`);
  if (/executed/.test(outcome ?? "")) {
    await page.locator('label:has-text("input 0") input').fill("9875");
    await page.getByRole("button", { name: "▶ Run" }).click();
    await page.getByText(/state: halted/).waitFor({ timeout: 30_000 });
    const status = await page.locator("p.status").last().textContent();
    ok(/return 29\b/.test(status ?? ""), `the generated program runs: digit sum of 9875 (${status?.trim().slice(0, 60)})`);
  }
}

ok(errors.length === 0, `no page errors (${errors.join(" | ")})`);
await browser.close();
console.log(failures ? `${failures} failure(s)` : "all custom-prompt checks passed");
process.exit(failures ? 1 : 0);
