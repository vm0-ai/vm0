/**
 * Formats Lighthouse CI results into a markdown PR comment.
 *
 * Reads LHR JSON files and links.json from the .lighthouseci/ directory
 * (created by `lhci collect` + `lhci upload --target=temporary-public-storage`).
 *
 * Usage:
 *   node format-report.cjs <app-name> [lhci-dir]
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

// Read LHR files to extract scores (lhci collect writes lhr-*.json)
const lhrFiles = fs
  .readdirSync(lhciDir)
  .filter((f) => f.startsWith("lhr-") && f.endsWith(".json"))
  .sort();

if (lhrFiles.length === 0) {
  console.error(`No LHR files found in ${lhciDir}`);
  process.exit(1);
}

// Use the median run (middle file when sorted by timestamp)
const medianIndex = Math.floor(lhrFiles.length / 2);
const lhr = JSON.parse(
  fs.readFileSync(path.join(lhciDir, lhrFiles[medianIndex]), "utf8"),
);

// Read links.json for the report URL (created by lhci upload --target=temporary-public-storage)
const linksPath = path.join(lhciDir, "links.json");
const links = fs.existsSync(linksPath)
  ? JSON.parse(fs.readFileSync(linksPath, "utf8"))
  : {};

const formatScore = (score) => Math.round(score * 100);
const emojiScore = (score) =>
  score >= 0.9 ? "🟢" : score >= 0.5 ? "🟠" : "🔴";
const scoreRow = (label, score) =>
  `| ${emojiScore(score)} ${label} | ${formatScore(score)} |`;

const testedUrl = lhr.requestedUrl || lhr.finalUrl || "unknown";
const [[, reportUrl] = []] = Object.entries(links);

const categoryMap = lhr.categories;
const categories = [
  ["Performance", categoryMap.performance?.score],
  ["Accessibility", categoryMap.accessibility?.score],
  ["Best Practices", categoryMap["best-practices"]?.score],
];

if (categoryMap.seo?.score !== undefined) {
  categories.push(["SEO", categoryMap.seo.score]);
}

const rows = categories
  .filter(([, score]) => score !== undefined)
  .map(([label, score]) => scoreRow(label, score));

const reportLine = reportUrl
  ? `*Tested URL: [${testedUrl}](${testedUrl}) · [Full report](${reportUrl})*`
  : `*Tested URL: [${testedUrl}](${testedUrl})*`;

const comment = `## ⚡ Lighthouse — ${appName}

| Category | Score |
| -------- | ----- |
${rows.join("\n")}

${reportLine}`;

console.log(comment);
