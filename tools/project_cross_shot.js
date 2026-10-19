#!/usr/bin/env node
/**
 * Manual check: an UNBOUND project (board_slug NULL) must be offered on a
 * board that is not its own, must survive a board switch, and must anchor the
 * workspace to the PROJECT's repo.
 *
 * Seeds one unbound project into the live projects.db, screenshots the form,
 * and removes the row afterwards. Nothing is submitted.
 */
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const CREDS = "/tmp/hlv.cookies";
const ORIGIN = "http://127.0.0.1:9119";
const PAGE = ORIGIN + "/hermes-logs-viewer";
const DB = "/home/alexander/.hermes/projects.db";
const OUT = "/tmp/hlv-project-shots";
const SEED_ID = "p_hlvshot";
const SEED_SLUG = "hlv-shot-unbound";
const SEED_PATH = "/home/alexander/src/ff/ff-mobile";

function cookies() {
  return fs.readFileSync(CREDS, "utf8").split("\n")
    .filter((l) => l.split("\t").length === 7)
    .map((l) => { const p = l.split("\t");
      return { name: p[5], value: p[6], domain: "127.0.0.1", path: "/", httpOnly: true }; });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let db;
const seed = () => {
  db = new DatabaseSync(DB);
  db.prepare("DELETE FROM projects WHERE slug = ?").run(SEED_SLUG);
  db.prepare(
    "INSERT INTO projects (id, slug, name, description, icon, color, board_slug, primary_path, created_at, archived) " +
    "VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 0)"
  ).run(SEED_ID, SEED_SLUG, "HLV Shot Unbound", SEED_PATH, Math.floor(Date.now() / 1000));
};
const unseed = () => {
  try { db.prepare("DELETE FROM projects WHERE slug = ?").run(SEED_SLUG); db.close(); }
  catch (e) { console.error("cleanup:", e.message); }
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  seed();
  try {
    const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await ctx.addCookies(cookies());
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
    await page.goto(PAGE, { waitUntil: "domcontentloaded" });
    await sleep(3000);
    await page.click("text=+ Новая задача");
    await sleep(600);

    const fieldByLabel = (name) =>
      page.locator(".hlv-modal .hlv-field").filter({
        has: page.locator(".hlv-field-label", { hasText: new RegExp("^" + name + "$") }),
      });
    const boardSel = fieldByLabel("Доска").locator("select");
    const prjSel = fieldByLabel("Проект").locator("select");
    const wsSel = fieldByLabel("Воркспейс").locator("select");

    const report = async (label) => {
      const opts = await prjSel.locator("option").allTextContents();
      console.log(`\n[${label}]`);
      console.log("  options  =", JSON.stringify(opts));
      console.log("  selected =", await prjSel.inputValue());
      console.log("  ws       =", await wsSel.inputValue());
      const inputs = await page.locator(".hlv-modal input").evaluateAll(
        (ns) => ns.map((n) => ({ ph: n.placeholder, val: n.value })));
      console.log("  path     =", JSON.stringify(inputs.filter((i) => (i.ph || "").startsWith("/путь/"))));
      console.log("  hint     =", (await fieldByLabel("Проект").innerText()).split("\n").slice(-1)[0]);
      await page.screenshot({ path: path.join(OUT, label + ".png") });
    };

    await boardSel.selectOption("ff");
    await sleep(700);
    await report("A-ff-list");

    // Pick the UNBOUND project on a board it is not bound to.
    await prjSel.selectOption(SEED_ID);
    await sleep(500);
    await wsSel.selectOption("dir");
    await sleep(500);
    await report("B-unbound-on-ff");

    // Switch boards — the selection must SURVIVE and re-anchor.
    await boardSel.selectOption("hypercube");
    await sleep(800);
    await report("C-after-board-switch");

    await browser.close();
    console.log("\nshots in " + OUT);
  } finally {
    unseed();
  }
})().catch((e) => { unseed(); console.error(e); process.exit(1); });