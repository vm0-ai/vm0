const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const sentryCliBin = require.resolve("@sentry/cli/bin/sentry-cli");
const pkg = JSON.parse(
  fs.readFileSync(path.join(appRoot, "package.json"), "utf8"),
);
const release = `desktop@${pkg.version}`;
const org = process.env.SENTRY_ORG;
const project =
  process.env.SENTRY_PROJECT_DESKTOP ?? process.env.SENTRY_PROJECT;
const authToken = process.env.SENTRY_AUTH_TOKEN;

if (!authToken || !org || !project) {
  console.log(
    "Skipping Desktop Sentry artifact upload; SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT_DESKTOP are required.",
  );
  process.exit(0);
}

function runSentryCli(args) {
  execFileSync(process.execPath, [sentryCliBin, ...args], {
    cwd: appRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      SENTRY_AUTH_TOKEN: authToken,
    },
  });
}

function existing(paths) {
  return paths.filter((candidate) => {
    return fs.existsSync(path.join(appRoot, candidate));
  });
}

const mainProcessArtifacts = existing([
  "dist/main.js",
  "dist/main.js.map",
  "dist/preload.js",
  "dist/preload.js.map",
]);

if (mainProcessArtifacts.length > 0) {
  runSentryCli([
    "sourcemaps",
    "upload",
    "--org",
    org,
    "--project",
    project,
    "--release",
    release,
    "--dist",
    "desktop-main",
    "--strip-common-prefix",
    ...mainProcessArtifacts,
  ]);
  for (const sourcemap of mainProcessArtifacts.filter((artifact) => {
    return artifact.endsWith(".map");
  })) {
    fs.rmSync(path.join(appRoot, sourcemap), { force: true });
  }
}

const symbolsDir = path.join(appRoot, "native", "dist", "symbols");
if (fs.existsSync(symbolsDir)) {
  runSentryCli([
    "debug-files",
    "upload",
    "--org",
    org,
    "--project",
    project,
    "--type",
    "dsym",
    symbolsDir,
  ]);
}
