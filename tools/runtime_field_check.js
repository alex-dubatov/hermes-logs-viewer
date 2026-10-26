#!/usr/bin/env node
/**
 * Real-browser check for the "время выполнения" field in the "основное" pane.
 *
 * It drives the real UI: open a throwaway card, open the pencil next to the
 * runtime value, type minutes, save, and check that the value on the card and
 * the value in the board's database agree.
 *
 * The card is created and hard-deleted during the run.
 */
const fs = require("fs");
const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  "/home/alexander/src/alex-dubatov/hypercube/frontend/node_modules/playwright");
const CHROME = process.env.CHROME_PATH ||
  "/home/alexander/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome";
const ENV_FILE = "/home/alexander/.hermes/.env";
const ORIGIN = "http://127.0.0.1:9119";

const BOARD = "default";
const RESULTS = [];
function check(name, ok, detail) {
  RESULTS.push([name, !!ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}  — ${detail === undefined ? "" : detail}`);
}

async function login(page) {
  const env = fs.readFileSync(ENV_FILE, "utf8");
  const val = (k) => {
    const m = env.match(new RegExp("^" + k + "=(.*)$", "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  await page.goto(ORIGIN + "/login", { waitUntil: "domcontentloaded" });
  await page.fill('input[name="username"]', val("HERMES_DASHBOARD_BASIC_AUTH_USERNAME"));
  await page.fill('input[name="password"]', val("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD"));
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function api(page, method, path, body) {
  return page.evaluate(
    async ([m, p, b]) => {
      const res = await fetch(p, {
        method: m,
        headers: b ? { "Content-Type": "application/json" } : {},
        body: b ? JSON.stringify(b) : undefined,
        credentials: "include",
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { status: res.status, data };
    },
    [method, path, body || null]
  );
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  let taskId = null;
  let title = "";
  try {
    await login(page);
    await page.goto(`${ORIGIN}/hermes-logs-viewer?profile=default`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    // A throwaway card on the default board (profile "default" runs no worker).
    // The board is a QUERY parameter of POST /tasks — in the body it is
    // ignored and the card lands on the current board instead.
    const created = await api(
      page,
      "POST",
      `/api/plugins/kanban/tasks?board=${encodeURIComponent(BOARD)}`,
      {
        title: "hlv-runtime-check-" + Date.now(),
        body: "временная карточка проверки времени выполнения",
        profile: "default",
        status: "todo",
      }
    );
    taskId = created.data && created.data.task && created.data.task.id;
    title = (created.data && created.data.task && created.data.task.title) || "";
    check("карточка создана", !!taskId, taskId || JSON.stringify(created).slice(0, 200));

    if (taskId) {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
      // Match THIS run's card by its exact title — an older leftover card
      // with the same prefix would otherwise be selected and edited instead.
      const row = page.locator(".hlv-row").filter({ hasText: title }).first();
      await row.click();
      await page.waitForTimeout(1500);

      const tab = page.locator("text=/^основное$/i").first();
      if (await tab.count()) await tab.click();
      await page.waitForTimeout(1200);

      // The runtime row is a .hlv-field-row whose label is "время выполнения".
      const runtimeRow = page
        .locator(".hlv-field-row")
        .filter({ has: page.locator(".hlv-field-label", { hasText: "время выполнения" }) })
        .first();
      check(
        "поле «время выполнения» есть",
        (await runtimeRow.count()) > 0,
        (await runtimeRow.count()) > 0 ? (await runtimeRow.textContent()) : "нет строки"
      );

      // Open the pencil next to the runtime value.
      const pencil = runtimeRow.locator("button").first();
      check("карандаш у времени выполнения есть", (await pencil.count()) > 0);

      if ((await pencil.count()) > 0) {
        await pencil.click();
        await page.waitForTimeout(600);
        const input = runtimeRow.locator(".hlv-runtime-input").first();
        check("поле ввода открылось", (await input.count()) > 0);
        if (await input.count()) {
          await input.fill("7");
          await page.keyboard.press("Control+Enter");
          await page.waitForTimeout(1800);

          // What the board's own API says.
          const fromApi = await api(
            page,
            "GET",
            `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}?board=${BOARD}`
          );
          const secs =
            fromApi.data && fromApi.data.task
              ? fromApi.data.task.max_runtime_seconds
              : undefined;
          check(
            "на доске 7 минут = 420 секунд",
            secs === 420,
            `status=${fromApi.status} raw=${JSON.stringify(fromApi.data).slice(0, 300)}`
          );

          const shown = await runtimeRow.locator(".hlv-runtime-value").first().textContent();
          check("в панели показано 7", /\b7\b/.test(shown || ""), shown);
        }
      }
    }
  } catch (err) {
    check("проверка выполнена без ошибок", false, String(err && err.message ? err.message : err));
  } finally {
    if (taskId) {
      try {
        await api(page, "DELETE", `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}?board=${BOARD}`);
        console.log("  временная карточка удалена:", taskId);
      } catch (e) {
        console.log("  не удалось удалить временную карточку:", taskId);
      }
    }
    await browser.close();
  }

  const failed = RESULTS.filter(([, ok]) => !ok);
  console.log(`\n=== ${RESULTS.length - failed.length}/${RESULTS.length} checks passed ===`);
  process.exit(failed.length ? 1 : 0);
})();
