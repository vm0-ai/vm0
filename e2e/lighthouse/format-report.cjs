/**
 * Formats Lighthouse CI results into a markdown PR comment.
 *
 * Reads manifest.json and links.json from the .lighthouseci/ directory
 * (created by `lhci collect` + `lhci upload --target=temporary-public-storage`).
 *
 * Usage:
 *   node format-report.cjs <app-name>
 *
 * Outputs markdown to stdout.
 */

const fs = require("fs");
const path = require("path");

const appName = process.argv[2];
if (!appName) {
  console.error("Usage: node format-report.cjs <app-name> [lhci-dir]");
  process.exit(1);
}

const lhciDir = path.resolve(process.argv[3] || ".lighthouseci");
const manifest = JSON.parse(
  fs.readFileSync(path.join(lhciDir, "manifest.json"), "utf8"),
);
const links = JSON.parse(
  fs.readFileSync(path.join(lhciDir, "links.json"), "utf8"),
);

const formatScore = (score) => Math.round(score * 100);
const emojiScore = (score) =>
  score >= 0.9 ? "🟢" : score >= 0.5 ? "🟠" : "🔴";
const scoreRow = (label, score) =>
  `| ${emojiScore(score)} ${label} | ${formatScore(score)} |`;

// manifest[0] is the representative (median) run
const { summary } = manifest[0];
const [[testedUrl, reportUrl]] = Object.entries(links);

const categories = [
  ["Performance", summary.performance],
  ["Accessibility", summary.accessibility],
  ["Best Practices", summary["best-practices"]],
];

if (summary.seo !== undefined) {
  categories.push(["SEO", summary.seo]);
}

const rows = categories.map(([label, score]) => scoreRow(label, score));

const comment = `## ⚡ Lighthouse — ${appName}

| Category | Score |
| -------- | ----- |
${rows.join("\n")}

*Tested URL: [${testedUrl}](${testedUrl}) · [Full report](${reportUrl})*`;

console.log(comment);
