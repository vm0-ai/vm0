import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const VENDOR_FILE_PATTERN = /^vendor-[^/]+\.js$/u;
const RUNTIME_FILE_PATTERN = /^rolldown-runtime-[^/]+\.js$/u;
const WORKER_FILE_PATTERN = /^shared-database-worker-[^/]+\.js$/u;
const BASELINE_COMMIT_SHA = "1111111111111111111111111111111111111111";
const ALTERNATE_COMMIT_SHA = "2222222222222222222222222222222222222222";

const appDirectory = process.cwd();
const packageJson = JSON.parse(
  await readFile(path.join(appDirectory, "package.json"), "utf8"),
);
const appVersion = process.env.OKOU_APP_VERSION ?? packageJson.version;
const appCommitSha = process.env.OKOU_APP_GIT_COMMIT_SHA;
assert.match(
  appCommitSha ?? "",
  COMMIT_SHA_PATTERN,
  "OKOU_APP_GIT_COMMIT_SHA must be a full lowercase commit SHA",
);
assert.equal(typeof appVersion, "string");
assert.ok(appVersion.length > 0, "App version must not be empty");

const baselineCommitSha =
  appCommitSha === BASELINE_COMMIT_SHA
    ? ALTERNATE_COMMIT_SHA
    : BASELINE_COMMIT_SHA;
const alternateVersion = `${appVersion}-bundle-stability`;
const sourceMaps = process.argv.includes("--sourcemap");
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "okou-app-hash-stability-"),
);

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function compressedSizes(content) {
  return {
    raw: content.byteLength,
    gzip9: gzipSync(content, { level: 9 }).byteLength,
    brotli11: brotliCompressSync(content, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      },
    }).byteLength,
  };
}

async function describeFile(assetsDirectory, fileName) {
  const content = await readFile(path.join(assetsDirectory, fileName));
  return {
    fileName,
    sha256: digest(content),
    ...compressedSizes(content),
  };
}

function exactlyOne(files, pattern, label) {
  const matches = files.filter((fileName) => {
    return pattern.test(fileName);
  });
  assert.equal(
    matches.length,
    1,
    `Expected exactly one ${label}, found: ${matches.join(", ") || "none"}`,
  );
  return matches[0];
}

async function describeBuild(outputDirectory) {
  const assetsDirectory = path.join(outputDirectory, "assets");
  const files = await readdir(assetsDirectory);
  const javaScriptFiles = files.filter((fileName) => {
    return fileName.endsWith(".js");
  });
  const vendorFile = exactlyOne(
    javaScriptFiles,
    VENDOR_FILE_PATTERN,
    "vendor JavaScript file",
  );
  const runtimeFile = exactlyOne(
    javaScriptFiles,
    RUNTIME_FILE_PATTERN,
    "Rolldown runtime JavaScript file",
  );
  const workerFile = exactlyOne(
    javaScriptFiles,
    WORKER_FILE_PATTERN,
    "SharedWorker JavaScript file",
  );
  const appFiles = javaScriptFiles.filter((fileName) => {
    return ![vendorFile, runtimeFile, workerFile].includes(fileName);
  });
  assert.equal(
    appFiles.length,
    1,
    `Expected exactly one app entry JavaScript file, found: ${appFiles.join(", ") || "none"}`,
  );
  const appFile = appFiles[0];
  assert.ok(appFile);

  const result = {
    app: await describeFile(assetsDirectory, appFile),
    vendor: await describeFile(assetsDirectory, vendorFile),
    runtime: await describeFile(assetsDirectory, runtimeFile),
    worker: await describeFile(assetsDirectory, workerFile),
  };
  if (sourceMaps) {
    for (const label of ["app", "vendor", "worker"]) {
      const mapFile = `${result[label].fileName}.map`;
      assert.ok(files.includes(mapFile), `Expected source map: ${mapFile}`);
    }
  }
  return result;
}

async function runBuild({ commitSha, label, outputDirectory, version }) {
  await rm(outputDirectory, { force: true, recursive: true });
  const arguments_ = [
    "exec",
    "vite",
    "build",
    "--outDir",
    outputDirectory,
    "--emptyOutDir",
    "--logLevel",
    "warn",
  ];
  if (sourceMaps) {
    arguments_.push("--sourcemap");
  }
  const child = spawn("pnpm", arguments_, {
    cwd: appDirectory,
    env: {
      ...process.env,
      OKOU_APP_GIT_COMMIT_SHA: commitSha,
      OKOU_APP_VERSION: version,
      SENTRY_AUTH_TOKEN: "",
    },
    stdio: "inherit",
  });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) {
    throw new Error(
      `${label} build failed (${signal ? `signal ${signal}` : `exit ${code}`})`,
    );
  }
  return await describeBuild(outputDirectory);
}

function assertStable(builds, label) {
  const expected = builds[0][label];
  for (const build of builds.slice(1)) {
    assert.equal(build[label].fileName, expected.fileName);
    assert.equal(build[label].sha256, expected.sha256);
  }
}

try {
  const baseline = await runBuild({
    commitSha: baselineCommitSha,
    label: "baseline commit",
    outputDirectory: path.join(temporaryRoot, "baseline"),
    version: appVersion,
  });
  const versionChange = await runBuild({
    commitSha: appCommitSha,
    label: "version change",
    outputDirectory: path.join(temporaryRoot, "version-change"),
    version: alternateVersion,
  });
  const canonical = await runBuild({
    commitSha: appCommitSha,
    label: "canonical",
    outputDirectory: path.join(appDirectory, "dist"),
    version: appVersion,
  });
  const builds = [baseline, versionChange, canonical];

  for (const label of ["vendor", "runtime"]) {
    assertStable(builds, label);
  }
  assert.notEqual(baseline.app.fileName, canonical.app.fileName);
  assert.notEqual(baseline.app.sha256, canonical.app.sha256);
  assert.notEqual(versionChange.app.fileName, canonical.app.fileName);
  assert.notEqual(versionChange.app.sha256, canonical.app.sha256);

  process.stdout.write(
    `${JSON.stringify(
      {
        builds: {
          baselineCommit: {
            commitSha: baselineCommitSha,
            version: appVersion,
            artifacts: baseline,
          },
          canonical: {
            commitSha: appCommitSha,
            version: appVersion,
            artifacts: canonical,
          },
          versionChange: {
            commitSha: appCommitSha,
            version: alternateVersion,
            artifacts: versionChange,
          },
        },
        verifiedStable: ["vendor", "runtime"],
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
