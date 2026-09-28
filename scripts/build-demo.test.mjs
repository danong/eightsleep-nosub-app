import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist-demo");
await import("./build-demo.mjs");

test("demo build contains only static files and no live account form", () => {
  assert.deepEqual(readdirSync(output).sort(), [
    "_headers",
    "app.js",
    "index.html",
    "styles.css",
    "timeline.js",
  ]);
  const html = readFileSync(path.join(output, "index.html"), "utf8");
  assert.match(html, /data-demo="true"/);
  assert.match(html, /id="save-button" type="submit" disabled/);
  assert.match(html, /id="connect-button" type="button" disabled/);
  assert.doesNotMatch(html, /<dialog|type="password"|\{\{[^}]+\}\}/);
  assert.match(
    readFileSync(path.join(output, "_headers"), "utf8"),
    /connect-src 'none'; form-action 'none'/,
  );
});

test("demo initializes and ignores schedule submission without an API request", async () => {
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
  let requests = 0;
  const script = readFileSync(path.join(output, "app.js"), "utf8").replace(
    'import { renderTimeline } from "/timeline.js";',
    "const renderTimeline = () => {};",
  );
  vm.runInNewContext(script, {
    document,
    window: { setInterval() {} },
    Intl,
    fetch() {
      requests++;
      throw new Error("Demo attempted an API request");
    },
  });
  assert.equal(requests, 0);
  assert.equal(element("#demo-notice").hidden, false);
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
