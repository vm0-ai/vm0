const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const packageRoot = path.join(appRoot, "native", "computer-use-helper");
const buildOutput = path.join(
  packageRoot,
  ".build",
  "release",
  "computer-use-helper",
);
const distDir = path.join(appRoot, "native", "dist", "native");
const distOutput = path.join(distDir, "computer-use-helper");

execFileSync(
  "swift",
  ["build", "--package-path", packageRoot, "-c", "release"],
  {
    stdio: "inherit",
  },
);

fs.mkdirSync(distDir, { recursive: true });
fs.copyFileSync(buildOutput, distOutput);
fs.chmodSync(distOutput, 0o755);
