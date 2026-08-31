import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const VENDOR_FILE_PATTERN = /^vendor-[^/]+\.js$/u;
const RUNTIME_FILE_PATTERN = /^rolldown-runtime-[^/]+\.js$/u;
const WORKER_FILE_PATTERN = /^shared-database-worker-[^/]+\.js$/u;
const MERMAID_LITE_MODULE_PATH =
  "/packages/mermaid-lite/dist/mermaid.esm.min.mjs";
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
const mutationConfigFile = path.join(temporaryRoot, "vite-mutation.config.mjs");

await writeFile(
  mutationConfigFile,
  `import baseConfig from ${JSON.stringify(
    pathToFileURL(path.join(appDirectory, "vite.config.ts")).href,
  )};

const mutationTargets = {
  app: "/apps/platform/src/main.ts",
  mermaid: ${JSON.stringify(MERMAID_LITE_MODULE_PATH)},
};

export default (environment) => {
  const config =
    typeof baseConfig === "function" ? baseConfig(environment) : baseConfig;
  const mutation = process.env.OKOU_BUILD_HASH_MUTATION;
  const target = mutationTargets[mutation];
  if (!target) {
    throw new Error(\`Unknown build hash mutation: \${mutation}\`);
  }
  return {
    ...config,
    plugins: [
      {
        enforce: "pre",
        name: "okou-build-hash-mutation",
        transform(code, id) {
          const moduleId = id.replaceAll("\\\\", "/").split("?", 1)[0];
          if (!moduleId.endsWith(target)) {
            return;
          }
          return {
            code:
              code +
              "\\nglobalThis.__okouBuildHashMutation = " +
              JSON.stringify(mutation) +
              ";",
            map: null,
          };
        },
      },
      ...(config.plugins ?? []),
    ],
  };
};
`,
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
    const vendorSourceMap = JSON.parse(
      await readFile(
        path.join(assetsDirectory, `${result.vendor.fileName}.map`),
        "utf8",
      ),
    );
    assert.ok(
      vendorSourceMap.sources.some((source) => {
        return source.replaceAll("\\", "/").endsWith(MERMAID_LITE_MODULE_PATH);
      }),
      "Expected the vendor source map to include the generated Mermaid module",
    );
  }
  return result;
}

async function runBuild({
  commitSha,
  label,
  mutation,
  outputDirectory,
  version,
}) {
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
  if (mutation) {
    arguments_.push("--config", mutationConfigFile);
  }
  if (sourceMaps) {
    arguments_.push("--sourcemap");
  }
  const child = spawn("pnpm", arguments_, {
    cwd: appDirectory,
    env: {
      ...process.env,
      OKOU_APP_GIT_COMMIT_SHA: commitSha,
      OKOU_APP_VERSION: version,
      OKOU_BUILD_HASH_MUTATION: mutation ?? "",
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
  const appMutation = await runBuild({
    commitSha: appCommitSha,
    label: "app-only mutation",
    mutation: "app",
    outputDirectory: path.join(temporaryRoot, "app-mutation"),
    version: appVersion,
  });
  const mermaidMutation = await runBuild({
    commitSha: appCommitSha,
    label: "Mermaid mutation",
    mutation: "mermaid",
    outputDirectory: path.join(temporaryRoot, "mermaid-mutation"),
    version: appVersion,
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
  for (const label of ["vendor", "runtime", "worker"]) {
    assertStable([canonical, appMutation], label);
  }
  for (const label of ["runtime", "worker"]) {
    assertStable([canonical, mermaidMutation], label);
  }
  assert.notEqual(baseline.app.fileName, canonical.app.fileName);
  assert.notEqual(baseline.app.sha256, canonical.app.sha256);
  assert.notEqual(versionChange.app.fileName, canonical.app.fileName);
  assert.notEqual(versionChange.app.sha256, canonical.app.sha256);
  assert.notEqual(appMutation.app.fileName, canonical.app.fileName);
  assert.notEqual(appMutation.app.sha256, canonical.app.sha256);
  assert.notEqual(mermaidMutation.vendor.fileName, canonical.vendor.fileName);
  assert.notEqual(mermaidMutation.vendor.sha256, canonical.vendor.sha256);
  assert.notEqual(mermaidMutation.app.fileName, canonical.app.fileName);
  assert.notEqual(mermaidMutation.app.sha256, canonical.app.sha256);

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
          appMutation: {
            commitSha: appCommitSha,
            version: appVersion,
            artifacts: appMutation,
          },
          mermaidMutation: {
            commitSha: appCommitSha,
            version: appVersion,
            artifacts: mermaidMutation,
          },
          versionChange: {
            commitSha: appCommitSha,
            version: alternateVersion,
            artifacts: versionChange,
          },
        },
        verifiedStable: {
          appMutation: ["vendor", "runtime", "worker"],
          mermaidMutation: ["runtime", "worker"],
          metadataChanges: ["vendor", "runtime"],
        },
        verifiedInvalidated: {
          appMutation: ["app"],
          mermaidMutation: ["app", "vendor"],
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
