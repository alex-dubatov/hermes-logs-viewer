#!/usr/bin/env node
/**
 * Computed-style probe for the "основное" pane.
 *
 * WHY: the pane's class and the LAYOUT WRAPPER's class were both "hlv-main".
 * The wrapper rule sets `display: flex` (row) — so the pane inherited it and
 * its four children (head, priority row, state row, body) laid out
 * HORIZONTALLY instead of stacked, making the whole card unreadable.
 *
 * jsdom does not lay out, so `tests/render_test.js` cannot see this: it
 * checks class names, not geometry. This probe asks the CSS engine what the
 * pane actually computes to, so the collision is measured rather than
 * argued about. It reads the REAL stylesheet that the dashboard serves.
 */
const fs = require("fs");
const path = require("path");
const ROOT = process.env.HERMES_ROOT || "/home/alexander/.hermes/hermes-agent";
const { JSDOM } = require(path.join(ROOT, "node_modules/jsdom"));

const REPO = process.env.HLV_REPO || "/home/alexander/src/alex-dubatov/hermes-logs-viewer";
const css = fs.readFileSync(path.join(REPO, "dashboard/dist/style.css"), "utf8");

const dom = new JSDOM(
  `<!doctype html><html><head><style>${css}</style></head>
   <body>
     <div class="hlv-root">
       <div class="hlv-main" id="wrapper">
         <div class="hlv-left"></div>
         <div class="hlv-right"></div>
       </div>
       <div class="hlv-log hlv-card" id="pane">
         <div class="hlv-desc-head"></div>
         <div class="hlv-field-row"></div>
         <div class="hlv-field-row"></div>
         <div class="hlv-desc-body"></div>
       </div>
     </div>
   </body></html>`,
  { pretendToBeVisual: true }
);

const win = dom.window;
const doc = win.document;
const probe = (id) => {
  const el = doc.getElementById(id);
  const cs = win.getComputedStyle(el);
  return {
    id,
    className: el.className,
    display: cs.display,
    flexDirection: cs.flexDirection,
    gap: cs.gap,
    flex: cs.flex,
  };
};

const wrapper = probe("wrapper");
const pane = probe("pane");

console.log("wrapper:", JSON.stringify(wrapper));
console.log("pane:   ", JSON.stringify(pane));

// The pane must be a normal flow box: its children stack vertically.
const stacked = pane.display !== "flex" || pane.flexDirection === "column";
// The wrapper must stay a horizontal row: left column + right pane.
const wrapperRow = wrapper.display === "flex" && wrapper.flexDirection === "row";

console.log("");
console.log(stacked ? "OK: панель «основное» — вертикальный поток" : "BUG: панель «основное» — дети в строку");
console.log(wrapperRow ? "OK: обёртка макета — строка" : "BUG: обёртка макета — не строка");
process.exit(stacked && wrapperRow ? 0 : 1);
