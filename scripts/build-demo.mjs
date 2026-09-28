import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { transform } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist-demo");

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Expected one occurrence of ${before}`);
  return source.replace(before, after);
}

let html = await readFile(path.join(root, "ui/index.html"), "utf8");
html = replaceOnce(html, '<html lang="en">', '<html lang="en" data-demo="true">');
html = replaceOnce(html, "Nightshift · Sleep settings", "Nightshift · Public demo");
html = replaceOnce(html, "Checking schedule…", "Public demo");
html = replaceOnce(html, "Connecting securely", "Explore the schedule layout below.");
html = replaceOnce(html, "Checking connection…", "Account connection is unavailable in the demo.");
html = replaceOnce(
  html,
  "Changes take effect at your next scheduled run.",
  "Changes cannot be saved in this demo.",
);
html = replaceOnce(
  html,
  'id="save-button" type="submit"',
  'id="save-button" type="submit" disabled',
);
html = replaceOnce(
  html,
  'id="connect-button" type="button">Reconnect',
  'id="connect-button" type="button" disabled>Unavailable in demo',
);
html = replaceOnce(
  html,
  '<span title="Worker version {{workerVersionId}}">Build {{workerVersionShort}}</span>',
  "<span>Public demo</span>",
);
const dialog = /\s*<dialog id="connect-dialog"[\s\S]*?<\/dialog>/g;
if ([...html.matchAll(dialog)].length !== 1) throw new Error("Expected one account dialog");
html = html.replace(dialog, "");
if (/\{\{[^}]+\}\}/.test(html)) throw new Error("Unresolved template placeholder in demo HTML");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "index.html"), html);
for (const [source, target] of [
  ["styles.css", "styles.css"],
  ["app.js.txt", "app.js"],
  ["timeline.js.txt", "timeline.js"],
]) {
  await writeFile(path.join(output, target), await readFile(path.join(root, "ui", source)));
}
for (const name of ["token-key.html", "token-key.css", "token-key.js"]) {
  await writeFile(path.join(output, name), await readFile(path.join(root, "demo", name)));
}
const scheduleSource = await readFile(path.join(root, "worker/schedule/engine.ts"), "utf8");
const scheduleScript = (
  await transform(scheduleSource, { loader: "ts", format: "esm", target: "es2022" })
).code;
await writeFile(path.join(output, "schedule.js"), scheduleScript);
await writeFile(
  path.join(output, "_headers"),
  "/\n  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n",
);
