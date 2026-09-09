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
const distDir = path.join(appRoot, "native", "dist", "native");
const symbolsDir = path.join(appRoot, "native", "dist", "symbols");

// Both executables ship from one SwiftPM package, but they run as separate
// processes: the Computer Use client kills and respawns its helper on command
// timeouts, which would destroy an in-flight screen capture.
const helperNames = ["computer-use-helper", "screen-recorder-helper"];

execFileSync(
  "swift",
  ["build", "--package-path", packageRoot, "-c", "release"],
  {
    stdio: "inherit",
  },
);

fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(symbolsDir, { recursive: true });

for (const helperName of helperNames) {
  const buildOutput = path.join(packageRoot, ".build", "release", helperName);
  const distOutput = path.join(distDir, helperName);
  const symbolsOutput = path.join(symbolsDir, `${helperName}.dSYM`);

  fs.copyFileSync(buildOutput, distOutput);
  fs.chmodSync(distOutput, 0o755);

  fs.rmSync(symbolsOutput, { recursive: true, force: true });
  execFileSync("dsymutil", [buildOutput, "-o", symbolsOutput], {
    stdio: "inherit",
  });
}

const supervisorRoot = path.join(appRoot, "native", "cua-supervisor");
const nodeInclude = path.resolve(
  path.dirname(process.execPath),
  "..",
  "include",
  "node",
);
for (const [source, output, flags] of [
  ["guardian.c", "cua-guardian", []],
  [
    "owner.c",
    "cua-owner.node",
    ["-bundle", "-undefined", "dynamic_lookup", `-I${nodeInclude}`],
  ],
]) {
  execFileSync(
    "cc",
    [
      "-std=c11",
      "-g",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-arch",
      "arm64",
      "-mmacosx-version-min=14.0",
      ...flags,
      path.join(supervisorRoot, source),
      "-o",
      path.join(distDir, output),
    ],
    { stdio: "inherit" },
  );
}
