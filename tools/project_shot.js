#!/usr/bin/env node
/**
 * Visual check of the project picker in the LIVE dashboard.
 *
 * Opens the real plugin in Chromium against the real ff board, picks a board
 * with projects, then screenshots the dialog in three states that must differ:
 * project chosen + dir, project chosen + worktree, and scratch (project locked
 * out). Writes to /tmp so a real board is never touched — nothing is submitted.
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/.hermes/tools/node-26.7.0-linux-x64/lib/node_modules/@playwright/cli/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const CREDS = "/tmp/hlv.cookies";
const ORIGIN = "http://127.0.0.1:9119";
const PAGE = ORIGIN + "/hermes-logs-viewer?profile=default";
const OUT = "/tmp/hlv-project-shots";

function cookies() {
  return fs.readFileSync(CREDS, "utf8")
    .split("\n")
    .filter((l) => l.split("\t").length === 7)
    .map((l) => {
      const p = l.split("\t");
      return { name: p[5], value: p[6], domain: "127.0.0.1", path: "/", httpOnly: true };
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await ctx.addCookies(cookies());
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error("console:", m.text()); });
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  // The plugin registers through the host SPA after its own bundles load, so
  // wait for the button rather than guessing a delay.
  await page.waitForSelector("text=+ Новая задача", { timeout: 60000 });
  await sleep(1500);
  await page.click("text=+ Новая задача");
  await sleep(600);

  // Match the field by its own label, not by the whole field's text: the
  // workspace hint also contains the word "доска", so a `hasText` filter on the
  // container matches both.
  const fieldByLabel = (name) =>
    page.locator(".hlv-modal .hlv-field").filter({
      has: page.locator(".hlv-field-label", { hasText: new RegExp("^" + name + "$") }),
    });
  const boardSel = fieldByLabel("Доска").locator("select");
  await boardSel.selectOption("ff");
  await sleep(700);

  const prjField = fieldByLabel("Проект");
  const prjSel = prjField.locator("select");
  const wsSel = fieldByLabel("Воркспейс").locator("select");
  const titleInput = page.locator(".hlv-modal input").first();

  const report = async (label) => {
    const text = await page.locator(".hlv-modal").innerText();
    const opts = await prjSel.locator("option").allTextContents();
    const disabled = await prjSel.isDisabled();
    const inputs = await page.locator(".hlv-modal input").evaluateAll(
      (ns) => ns.map((n) => ({ ph: n.placeholder, val: n.value })));
    console.log(`\n[${label}]`);
    console.log("  workspace =", await wsSel.inputValue());
    console.log("  project options =", JSON.stringify(opts));
    console.log("  project disabled =", disabled);
    console.log("  path field =", JSON.stringify(inputs.filter((i) => (i.ph || "").startsWith("/путь/"))));
    console.log("  hints:", text.split("\n").filter((l) => /проект|primary_path|worktrees/i.test(l)));
    await page.screenshot({ path: path.join(OUT, label + ".png"), fullPage: false });
  };

  await titleInput.fill("Проверка выбора проекта");
  await report("1-board-ff-no-project");

  // Pick a repo-backed project and report BEFORE forcing any kind: the form
  // must have switched the workspace kind on its own.
  await prjSel.selectOption({ index: 1 });
  await sleep(600);
  await report("2-auto-kind-after-project");

  // now force dir to check that path
  await wsSel.selectOption("dir");
  await sleep(500);
  await report("3-dir-with-project");

  // worktree + the same project: the path must vanish
  await wsSel.selectOption("worktree");
  await sleep(500);
  await report("4-worktree-with-project");

  // scratch: the project must be locked out and explained
  await wsSel.selectOption("scratch");
  await sleep(500);
  await report("5-scratch-projectless");

  await browser.close();
  console.log("\nshots in " + OUT);
})().catch((e) => { console.error(e); process.exit(1); });