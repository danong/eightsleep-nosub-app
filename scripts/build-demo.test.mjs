import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist-demo");
await import("./build-demo.mjs");
const { scheduleTimeline } = await import(pathToFileURL(path.join(output, "schedule.js")).href);

test("demo build contains only static files and no live account form", () => {
  assert.deepEqual(readdirSync(output).sort(), [
    "_headers",
    "app.js",
    "index.html",
    "schedule.js",
    "styles.css",
    "timeline.js",
    "token-key.css",
    "token-key.html",
    "token-key.js",
  ]);
  const html = readFileSync(path.join(output, "index.html"), "utf8");
  assert.match(html, /data-demo="true"/);
  assert.match(html, /id="save-button" type="submit" disabled/);
  assert.match(html, /id="connect-button" type="button" disabled/);
  assert.match(html, /id="timeline-panel"/);
  assert.doesNotMatch(html, /demo-notice|<dialog|type="password"|\{\{[^}]+\}\}/);
  assert.match(
    readFileSync(path.join(output, "_headers"), "utf8"),
    /connect-src 'none'; form-action 'none'/,
  );
});

test("token key page generates a 32-byte hex key without network requests", async () => {
  const html = readFileSync(path.join(output, "token-key.html"), "utf8");
  const script = readFileSync(path.join(output, "token-key.js"), "utf8");
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /script src="\/token-key.js"/);
  const elements = new Map();
  for (const id of ["key", "status", "copy", "generate"]) {
    elements.set(id, {
      textContent: "",
      listeners: {},
      addEventListener(name, listener) {
        this.listeners[name] = listener;
      },
    });
  }
  let copied;
  vm.runInNewContext(script, {
    document: { getElementById: (id) => elements.get(id) },
    crypto: webcrypto,
    navigator: {
      clipboard: {
        async writeText(value) {
          copied = value;
        },
      },
    },
    fetch() {
      throw new Error("Key generator attempted a network request");
    },
  });
  const key = elements.get("key");
  assert.match(key.textContent, /^[0-9a-f]{64}$/);
  const first = key.textContent;
  elements.get("generate").listeners.click();
  assert.match(key.textContent, /^[0-9a-f]{64}$/);
  assert.notEqual(key.textContent, first);
  await elements.get("copy").listeners.click();
  assert.equal(copied, key.textContent);
});

test("demo renders and updates an overnight plan without an API request", async () => {
  const elements = new Map();
  const element = (key) => {
    if (!elements.has(key)) {
      elements.set(key, {
        value: "",
        textContent: "",
        hidden: true,
        disabled: false,
        options: [],
        listeners: {},
        replaceChildren(...children) {
          this.options = children;
        },
        addEventListener(name, callback) {
          this.listeners[name] = callback;
        },
      });
    }
    return elements.get(key);
  };
  const document = {
    documentElement: { dataset: { demo: "true" } },
    querySelector: element,
    querySelectorAll: () => [],
    createElement: () => ({ value: "", textContent: "" }),
    getElementById: element,
  };
  element("#bedtime").value = "22:00";
  element("#wakeTime").value = "06:00";
  element("#timezone").value = "UTC";
  for (const name of ["early", "middle", "late"]) element(name).value = "0";
  let requests = 0;
  const renders = [];
  const script = readFileSync(path.join(output, "app.js"), "utf8")
    .replace(
      'import { renderTimeline } from "/timeline.js";',
      "const renderTimeline = (status, settings) => renders.push({ status, settings });",
    )
    .replace('import("/schedule.js")', "Promise.resolve({ scheduleTimeline: demoTimeline })");
  vm.runInNewContext(script, {
    document,
    window: { setInterval() {} },
    Intl,
    renders,
    demoTimeline: scheduleTimeline,
    fetch() {
      requests++;
      throw new Error("Demo attempted an API request");
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 0);
  assert.ok(renders.at(-1).status.timeline.segments.length > 0);
  assert.equal(renders.at(-1).settings.bedtime, "22:00");
  element("#bedtime").value = "23:00";
  element("#settings-form").listeners.input();
  assert.equal(renders.at(-1).settings.bedtime, "23:00");
  assert.equal(element("#save-button").disabled, true);
  assert.equal(element("#connect-button").disabled, true);
  assert.equal(element("#connect-button").listeners.click, undefined);
  let prevented = false;
  await element("#settings-form").listeners.submit({
    preventDefault() {
      prevented = true;
    },
  });
  await element("#pause-button").listeners.click();
  assert.equal(prevented, true);
  assert.equal(requests, 0);
});
