// Guards the crash-resilient bootstrap bundle (see src/bootstrap.ts): the
// bundler must never inline workspace code or the main bundle into it,
// otherwise a broken main bundle would take the auto-updater down with it.
import { readFileSync } from "node:fs";

const bundle = readFileSync(
  new URL("../dist/bootstrap.js", import.meta.url),
  "utf8",
);

const failures = [];
if (bundle.includes("@vm0/")) {
  failures.push('dist/bootstrap.js must not bundle any "@vm0/" workspace code');
}
if (!bundle.includes('require("./main.js")')) {
  failures.push(
    'dist/bootstrap.js must load the main bundle via a runtime require("./main.js")',
  );
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exit(1);
}

console.log("bootstrap bundle guard passed");
