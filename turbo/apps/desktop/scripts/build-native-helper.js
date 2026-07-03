const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

if (process.platform !== "darwin") {
  console.log(
    `Skipping native helper build on ${process.platform} (macOS-only).`,
  );
  process.exit(0);
}

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
const symbolsDir = path.join(appRoot, "native", "dist", "symbols");
const symbolsOutput = path.join(symbolsDir, "computer-use-helper.dSYM");

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

fs.rmSync(symbolsOutput, { recursive: true, force: true });
fs.mkdirSync(symbolsDir, { recursive: true });
execFileSync("dsymutil", [buildOutput, "-o", symbolsOutput], {
  stdio: "inherit",
});
