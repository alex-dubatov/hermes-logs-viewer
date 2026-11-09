#!/usr/bin/env node
/**
 * Real-browser geometry + behaviour check for the new-task dialog's MODEL row.
 *
 * WHY: jsdom lays nothing out, so `tests/render_test.js` proves the payload and
 * the DOM structure of the model picker but cannot see that "provider | model"
 * really sit on one line inside the modal, that the provider column is the
 * intended width, or that a narrow viewport does not squeeze the row out of the
 * dialog. The picker is two selects — provider first, then that provider's
 * models — and both orders of failure (a stacked row, an overflowing row) are
 * invisible without a layout engine.
 *
 * Everything that CAN be read from the live API is read there: the profile to
 * check (`default` — installed everywhere) and the "other" provider come from
 * `/profiles` and `/model-options`, so the check does not depend on a hardcoded
 * catalog.
 *
 * Usage:
 *   PLAYWRIGHT_PATH=<path to playwright> CHROME_PATH=<path to chrome> \
 *     node tools/model_picker_layout_check.js
 */
const fs = require("fs");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/frontend/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome";
const ENV_FILE = "/home/alexander/.hermes/.env";
const ORIGIN = "http://127.0.0.1:9119";
const PAGE_URL = ORIGIN + "/hermes-logs-viewer?profile=default";
const PROFILE = process.env.HLV_MODEL_PROFILE || "default";

function envValue(k) {
  const env = fs.readFileSync(ENV_FILE, "utf8");
  const m = env.match(new RegExp("^" + k + "=(.*)$", "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

async function login(page) {
  const user = envValue("HERMES_DASHBOARD_BASIC_AUTH_USERNAME");
  const pass = envValue("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD");
  if (!user || !pass) throw new Error("нет учётных данных в ~/.hermes/.env");
  await page.goto(ORIGIN + "/login?next=" + encodeURIComponent("/hermes-logs-viewer"),
    { waitUntil: "domcontentloaded" });
  await page.fill('input[name="u"], input[type="text"]', user);
  await page.fill('input[name="p"], input[type="password"]', pass);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }),
    page.click('button[type="submit"], input[type="submit"]'),
  ]);
}

// The plugin's provider/model row inside the OPEN modal.
function measure(page) {
  return page.evaluate(() => {
    const modal = document.querySelector(".hlv-modal");
    if (!modal) return { found: false };
    const prov = modal.querySelector("select.hlv-model-provider");
    const model = modal.querySelector("select.hlv-model-name");
    if (!prov || !model) return { found: false };
    const box = (n) => {
      const b = n.getBoundingClientRect();
      return { x: Math.round(b.left), y: Math.round(b.top),
               w: Math.round(b.width), h: Math.round(b.height) };
    };
    const mb = modal.getBoundingClientRect();
    return {
      found: true,
      prov: box(prov), model: box(model),
      modal: { x: Math.round(mb.left), w: Math.round(mb.width) },
      provLabel: (prov.closest(".hlv-field").querySelector(".hlv-field-label") || {}).textContent || "",
      modelLabel: (model.closest(".hlv-field").querySelector(".hlv-field-label") || {}).textContent || "",
      provValue: prov.value,
      modelValue: model.value,
      modelDisabled: model.disabled,
      modelOptions: Array.from(model.options).map((o) => o.value),
      providerOptions: Array.from(prov.options).map((o) => o.value),
      hint: (prov.closest(".hlv-field-row").parentElement
        .querySelector(".hlv-modal-hint") || {}).textContent || "",
    };
  });
}

const results = [];
const check = (name, ok, extra) => {
  results.push(ok);
  console.log((ok ? "PASS " : "FAIL ") + name + (extra ? "  — " + extra : ""));
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await login(page);
  // The roster and the model catalog come from the live API, read INSIDE the
  // logged-in page: a Node-side fetch has no dashboard session.
  const live = await page.evaluate(async () => {
    const p = await (await fetch("/api/plugins/kanban/profiles")).json();
    const m = await (await fetch("/api/plugins/kanban/model-options")).json();
    return { profiles: p.profiles || [], catalog: m.providers || [] };
  });
  const profiles = live.profiles;
  const catalog = live.catalog;
  const who = profiles.find((p) => p.name === PROFILE);
  if (!who) throw new Error("профиль " + PROFILE + " не установлен — задайте HLV_MODEL_PROFILE");
  if (!catalog.length) throw new Error("каталог /model-options пуст");
  const other = catalog.find((p) => p.slug !== who.provider && (p.models || []).length);
  const offCatalog = profiles.find(
    (p) => p.provider && !catalog.some((c) => c.slug === p.provider) && p.model);
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hlv-row", { timeout: 30000 });
  await page.click('button:has-text("+ Новая задача")');
  await page.waitForSelector(".hlv-modal", { timeout: 10000 });
  await page.locator(".hlv-modal select").first().selectOption({ index: 1 });
  await page.waitForTimeout(600);
  const profileSelect = page.locator(
    '.hlv-modal .hlv-field:has(.hlv-field-label:text-is("Профиль")) select');
  await profileSelect.selectOption(PROFILE);
  await page.waitForTimeout(700);

  const d = await measure(page);
  check("поле модели найдено в настоящем DOM", d.found);
  if (d.found) {
    check("подписи полей — «провайдер» и «модель»",
      d.provLabel.trim() === "провайдер" && d.modelLabel.trim() === "модель",
      d.provLabel + " / " + d.modelLabel);
    check("провайдер и модель стоят в одну строку", Math.abs(d.prov.y - d.model.y) < 4,
      "y " + d.prov.y + " vs " + d.model.y);
    check("модель справа от провайдера, без наложения",
      d.model.x >= d.prov.x + d.prov.w,
      "провайдер " + d.prov.x + "+" + d.prov.w + ", модель " + d.model.x);
    check("колонка провайдера ~190px, модель занимает остаток",
      Math.abs(d.prov.w - 190) <= 12 && d.model.w > d.prov.w,
      "провайдер " + d.prov.w + "px, модель " + d.model.w + "px");
    check("оба селекта внутри модала",
      d.prov.x >= d.modal.x && d.model.x + d.model.w <= d.modal.x + d.modal.w,
      "модал " + d.modal.x + ".." + (d.modal.x + d.modal.w) +
        ", модель " + d.model.x + ".." + (d.model.x + d.model.w));
    check("по умолчанию подставлена пара профиля " + PROFILE,
      d.provValue === (who.provider || "") && d.modelValue === (who.model || "") &&
        d.modelDisabled === false,
      d.provValue + " · " + d.modelValue + " (опций " + d.modelOptions.length + ")");
    check("в списке провайдеров — провайдеры каталога",
      catalog.every((c) => d.providerOptions.includes(c.slug)),
      d.providerOptions.join(", "));
    check("подсказка называет дефолтную модель профиля",
      /по умолчанию — модель профиля/.test(d.hint), d.hint.trim().slice(0, 90));

    if (other) {
      await page.locator(".hlv-modal select.hlv-model-provider").selectOption(other.slug);
      await page.waitForTimeout(500);
      const d2 = await measure(page);
      check("смена провайдера перезаполняет список его моделями",
        d2.modelOptions.join("\u0000") === other.models.join("\u0000"),
        d2.modelOptions.length + " опций у " + other.slug);
      check("после смены провайдера выбрана модель этого провайдера",
        other.models.includes(d2.modelValue), "модель=" + d2.modelValue);
      check("подсказка называет переопределение пары",
        /переопределение/.test(d2.hint), d2.hint.trim().slice(0, 90));
    } else {
      check("каталог дал провайдера, отличного от профиля", false,
        catalog.map((c) => c.slug).join(", "));
    }

    await page.locator(".hlv-modal select.hlv-model-provider").selectOption("");
    await page.waitForTimeout(400);
    const d3 = await measure(page);
    check("«как в профиле» запирает список моделей", d3.modelDisabled === true,
      "disabled=" + d3.modelDisabled);

    if (offCatalog) {
      await profileSelect.selectOption(offCatalog.name);
      await page.waitForTimeout(700);
      const d4 = await measure(page);
      check("провайдер вне каталога (" + offCatalog.provider + ") остаётся в значении и списке",
        d4.provValue === offCatalog.provider &&
          d4.providerOptions.includes(offCatalog.provider) &&
          d4.modelValue === offCatalog.model,
        d4.provValue + " · " + d4.modelValue);
    }
  }

  // A phone-ish viewport: the row must still fit inside the modal.
  await page.setViewportSize({ width: 420, height: 820 });
  await page.waitForTimeout(700);
  const n = await measure(page);
  if (n.found) {
    check("узкий экран: строка модели не вылезла за модал",
      n.model.x + n.model.w <= n.modal.x + n.modal.w + 2,
      "модал " + n.modal.x + ".." + (n.modal.x + n.modal.w) +
        ", модель " + n.model.x + ".." + (n.model.x + n.model.w));
    check("узкий экран: модель справа от провайдера без наложения",
      n.model.x >= n.prov.x + n.prov.w,
      "провайдер " + n.prov.x + "+" + n.prov.w + ", модель " + n.model.x);
  }

  check("страница без JS-ошибок", errors.length === 0, errors.slice(0, 3).join(" | ") || "0");
  await browser.close();

  const failed = results.filter((r) => !r).length;
  console.log("\n=== " + (results.length - failed) + "/" + results.length + " checks passed ===");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("PROBE ERROR:", e && e.stack || e); process.exit(2); });
