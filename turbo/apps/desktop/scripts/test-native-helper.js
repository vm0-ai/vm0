const { execFileSync } = require("node:child_process");
const path = require("node:path");

if (process.platform !== "darwin") {
  console.log(
    `Skipping native helper tests on ${process.platform} (macOS-only).`,
  );
  process.exit(0);
}

const appRoot = path.resolve(__dirname, "..");
const packageRoot = path.join(appRoot, "native", "computer-use-helper");

execFileSync("swift", ["test", "--package-path", packageRoot], {
  stdio: "inherit",
});
