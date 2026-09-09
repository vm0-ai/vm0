import { createHash } from "node:crypto";
import manifest from "../cua/artifacts.json";
import packageMetadata from "../package.json";
import identities from "./desktop-identities.json";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const desktopDirectory = resolve(__dirname, "..");
const turboDirectory = resolve(desktopDirectory, "../..");
const temporaryDirectories: string[] = [];

const environmentNames = {
  canonicalPlatformUrl: "OKOU_DESKTOP_PLATFORM_URL",
  canonicalProduct: "OKOU_DESKTOP_PRODUCT",
} as const;

const buildConfigHarnessSource = `
const { resolveDesktopBuildConfig } = require(process.env.TEST_CONFIG_MODULE);

function optionalValue(prefix) {
  return process.env[prefix + "_DEFINED"] === "true"
    ? process.env[prefix + "_VALUE"]
    : undefined;
}

const config = resolveDesktopBuildConfig({
  platformUrl: optionalValue("TEST_PLATFORM_ARGUMENT"),
  product: optionalValue("TEST_PRODUCT_ARGUMENT"),
});
if (
  config.product !== process.env.TEST_EXPECTED_PRODUCT ||
  config.platformUrl.toString() !== process.env.TEST_EXPECTED_PLATFORM_URL ||
  config.identity.displayName !== process.env.TEST_EXPECTED_DISPLAY_NAME
) {
  throw new Error("Desktop build configuration changed");
}
`;

const installedConfigHarnessSource = `
import { resolveDesktopConfig } from "./src/config.ts";

function optionalValue(prefix: string): string | undefined {
  return process.env[prefix + "_DEFINED"] === "true"
    ? process.env[prefix + "_VALUE"]
    : undefined;
}

const config = resolveDesktopConfig(
  optionalValue("TEST_PLATFORM_ARGUMENT"),
  optionalValue("TEST_PRODUCT_ARGUMENT"),
);
if (
  config.identity.product !== process.env.TEST_EXPECTED_PRODUCT ||
  config.platformUrl.toString() !== process.env.TEST_EXPECTED_PLATFORM_URL ||
  config.authUrl.origin !== (config.environment === "production" ? "https://app.okou.ai" : config.platformUrl.origin) ||
  config.authPartition === config.sessionPartition ||
  config.environment !== process.env.TEST_EXPECTED_ENVIRONMENT ||
  config.identity.displayName !== process.env.TEST_EXPECTED_DISPLAY_NAME ||
  config.sessionPartition !== process.env.TEST_EXPECTED_SESSION_PARTITION
) {
  throw new Error("Installed Desktop configuration changed");
}
`;

const forgeConfigHarnessSource = `
const path = require("node:path");
const config = require(process.env.TEST_FORGE_CONFIG);
if (
  path.basename(config.packagerConfig.icon) !==
  process.env.TEST_EXPECTED_APP_ICON_BASE_NAME
) {
  throw new Error("Desktop package icon changed");
}
`;

const platformOverrideSource = `
Object.defineProperty(process, "platform", { value: "darwin" });
`;

interface EnvironmentValues {
  readonly canonicalPlatformUrl?: string;
  readonly canonicalProduct?: string;
}

interface RuntimeFileConfig {
  readonly platformUrl: string;
  readonly product?: unknown;
}

interface SurfaceCase {
  readonly environment?: EnvironmentValues;
  readonly fileConfig?: RuntimeFileConfig;
  readonly platformArgument?: string;
  readonly productArgument?: string;
  readonly expectedProduct: "okou";
  readonly expectedPlatformUrl: string;
  readonly expectedDisplayName: string;
}

interface InstalledSurfaceCase extends SurfaceCase {
  readonly expectedEnvironment: "production" | "staging" | "development";
}

interface DesktopFixture {
  readonly desktopDirectory: string;
  readonly platformOverridePath: string;
  readonly tracePath: string;
}

interface EntryPointResult {
  readonly process: SpawnSyncReturns<string>;
  readonly trace: string;
}

function createDesktopFixture(): DesktopFixture {
  const directory = mkdtempSync(join(tmpdir(), "desktop-environment-entry-"));
  temporaryDirectories.push(directory);
  const fixtureDesktopDirectory = join(directory, "desktop");
  const scriptsDirectory = join(fixtureDesktopDirectory, "scripts");
  const sourceDirectory = join(fixtureDesktopDirectory, "src");
  mkdirSync(scriptsDirectory, { recursive: true });
  mkdirSync(sourceDirectory, { recursive: true });
  mkdirSync(join(fixtureDesktopDirectory, "cua"));

  for (const relativePath of [
    "scripts/desktop-build-config.js",
    "scripts/desktop-environment.js",
    "scripts/packaged-app-paths.js",
    "scripts/run-packaged-app.js",
    "scripts/smoke-test-packaged-app.js",
    "scripts/desktop-smoke-evidence.js",
    "scripts/stage-cua-runtime.py",
    "cua/artifacts.json",
    "package.json",
    "src/config.ts",
    "src/desktop-api-base-url.ts",
    "src/desktop-identities.json",
  ]) {
    copyFileSync(
      join(desktopDirectory, relativePath),
      join(fixtureDesktopDirectory, relativePath),
    );
  }

  const platformOverridePath = join(directory, "darwin-platform.cjs");
  writeFileSync(platformOverridePath, platformOverrideSource);
  return {
    desktopDirectory: fixtureDesktopDirectory,
    platformOverridePath,
    tracePath: join(directory, "external-side-effects.txt"),
  };
}

function writeRuntimeConfig(
  fixture: DesktopFixture,
  config: RuntimeFileConfig | undefined,
): void {
  if (config) {
    writeFileSync(
      join(fixture.desktopDirectory, "desktop-runtime-config.json"),
      JSON.stringify(config),
    );
  }
}

function applyEnvironmentValues(
  environment: NodeJS.ProcessEnv,
  values: EnvironmentValues | undefined,
): void {
  if (!values) {
    return;
  }

  for (const [environmentName, value] of [
    [environmentNames.canonicalPlatformUrl, values.canonicalPlatformUrl],
    [environmentNames.canonicalProduct, values.canonicalProduct],
  ] as const) {
    if (value !== undefined) {
      environment[environmentName] = value;
    }
  }
}

function baseEnvironment(): NodeJS.ProcessEnv {
  return process.env.PATH ? { PATH: process.env.PATH } : {};
}

function surfaceEnvironment(
  testCase: SurfaceCase,
  fixture: DesktopFixture,
): NodeJS.ProcessEnv {
  const environment = baseEnvironment();
  environment.TEST_CONFIG_MODULE = join(
    fixture.desktopDirectory,
    "scripts",
    "desktop-build-config.js",
  );
  environment.TEST_EXPECTED_DISPLAY_NAME = testCase.expectedDisplayName;
  environment.TEST_EXPECTED_PLATFORM_URL = testCase.expectedPlatformUrl;
  environment.TEST_EXPECTED_PRODUCT = testCase.expectedProduct;
  environment.TEST_PLATFORM_ARGUMENT_DEFINED = String(
    testCase.platformArgument !== undefined,
  );
  environment.TEST_PLATFORM_ARGUMENT_VALUE = testCase.platformArgument;
  environment.TEST_PRODUCT_ARGUMENT_DEFINED = String(
    testCase.productArgument !== undefined,
  );
  environment.TEST_PRODUCT_ARGUMENT_VALUE = testCase.productArgument;
  applyEnvironmentValues(environment, testCase.environment);
  return environment;
}

function trace(fixture: DesktopFixture): string {
  return existsSync(fixture.tracePath)
    ? readFileSync(fixture.tracePath, "utf8")
    : "";
}

function runBuildConfig(testCase: SurfaceCase): EntryPointResult {
  const fixture = createDesktopFixture();
  writeRuntimeConfig(fixture, testCase.fileConfig);
  const processResult = spawnSync(
    process.execPath,
    ["--eval", buildConfigHarnessSource],
    { encoding: "utf8", env: surfaceEnvironment(testCase, fixture) },
  );
  return { process: processResult, trace: trace(fixture) };
}

function runInstalledConfig(testCase: InstalledSurfaceCase): EntryPointResult {
  const fixture = createDesktopFixture();
  writeRuntimeConfig(fixture, testCase.fileConfig);
  const harnessPath = join(fixture.desktopDirectory, "installed-config.ts");
  writeFileSync(harnessPath, installedConfigHarnessSource);
  const environment = surfaceEnvironment(testCase, fixture);
  environment.TEST_EXPECTED_ENVIRONMENT = testCase.expectedEnvironment;
  environment.TEST_EXPECTED_SESSION_PARTITION = `persist:vm0-desktop-${testCase.expectedEnvironment}`;
  const processResult = spawnSync(
    process.execPath,
    ["--import", "tsx", harnessPath],
    { cwd: turboDirectory, encoding: "utf8", env: environment },
  );
  return { process: processResult, trace: trace(fixture) };
}

function runForgeConfig(): SpawnSyncReturns<string> {
  const environment = baseEnvironment();
  environment.TEST_FORGE_CONFIG = join(desktopDirectory, "forge.config.js");
  environment.TEST_EXPECTED_APP_ICON_BASE_NAME = "icon";
  return spawnSync(process.execPath, ["--eval", forgeConfigHarnessSource], {
    cwd: desktopDirectory,
    encoding: "utf8",
    env: environment,
  });
}

function dormantDriverEvidence() {
  return {
    experimentalCuaEnabled: false,
    selectedDriver: "okou",
    developerAvailability: "unavailable",
    actual: null,
    phase: "stopped",
    lifecycleElapsedMs: 1,
    cleanupPending: false,
    expectedCuaVersion: manifest.driverVersion,
    error: null,
    canRetry: true,
  };
}

function probeEvidence(bundleId = "ai.okou.desktop") {
  const state = {
    phase: "ready",
    generation: 1,
    cleanupPending: false,
    driverVersion: manifest.driverVersion,
    loadedDriverVersion: manifest.driverVersion,
    error: null,
  };
  return {
    schemaVersion: 1,
    desktopVersion: packageMetadata.version,
    electronVersion: packageMetadata.devDependencies.electron,
    bundleId,
    generation: 1,
    driverVersion: manifest.driverVersion,
    metadata: {
      pid: 42,
      embedded: true,
      hostBundleId: bundleId,
      driverVersion: manifest.driverVersion,
      contractVersion: "1",
      mcpProtocolVersion: "2025-03-26",
    },
    readyState: state,
    stoppedState: {
      ...state,
      phase: "stopped",
      generation: null,
      loadedDriverVersion: null,
    },
    accessibility: false,
    screenRecording: false,
    attribution: "host",
    capture: "not_requested",
    cleanup: {
      generation: 1,
      exitObserved: true,
      exitSuccess: true,
      exitCode: 0,
      hostStopped: true,
      directoryRemoved: true,
      process: {
        guardianPid: 24,
        guardianExitObserved: true,
        descendantsExited: true,
        forced: false,
        elapsedMs: 75,
        heartbeatCount: 1,
      },
    },
  };
}

interface SmokeScenario {
  readonly probe?: boolean;
  readonly settledDriver?: unknown;
  readonly output?: string;
  readonly exit?: number | "signal";
  readonly corrupt?: "missing" | "javascript" | "version" | "signature";
}

function prepareCuaPayload(
  resources: string,
  corrupt?: SmokeScenario["corrupt"],
) {
  const root = join(resources, "cua");
  mkdirSync(root, { recursive: true });
  for (const artifact of manifest.artifacts) {
    for (const file of artifact.files) {
      const name = join(
        artifact.destination,
        artifact.destination === "." ? file : file.slice("package/".length),
      );
      const target = join(root, name);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(
        target,
        manifest.nativeCode.includes(name)
          ? Buffer.from([
              0xcf,
              0xfa,
              0xed,
              0xfe,
              0x0c,
              0,
              0,
              1,
              ...new Array<number>(24).fill(0),
            ])
          : "fixture resource",
      );
      chmodSync(target, 0o755);
    }
  }
  writeFileSync(join(root, "artifacts.json"), JSON.stringify(manifest));
  const files: Record<string, string> = {};
  const names = [
    "artifacts.json",
    ...manifest.artifacts.flatMap((artifact) =>
      artifact.files.map((file) =>
        join(
          artifact.destination,
          artifact.destination === "." ? file : file.slice("package/".length),
        ),
      ),
    ),
  ];
  for (const name of names)
    files[name] = createHash("sha256")
      .update(readFileSync(join(root, name)))
      .digest("hex");
  writeFileSync(
    join(root, "payload.json"),
    JSON.stringify({
      driverVersion: corrupt === "version" ? "0.23.1" : manifest.driverVersion,
      files,
    }),
  );
  const entry = join(root, "node_modules/@trycua/cua-driver/dist/index.js");
  if (corrupt === "missing") rmSync(entry);
  if (corrupt === "javascript") writeFileSync(entry, "tampered resource");
}

function preparePackagedApp(
  fixture: DesktopFixture,
  appName: string,
  marker: "selected" | "unexpected",
  scenario: SmokeScenario,
): void {
  const appBundlePath = join(
    fixture.desktopDirectory,
    "out",
    `${appName}-darwin-${process.arch}`,
    `${appName}.app`,
  );
  const executablePath = join(appBundlePath, "Contents", "MacOS", appName);
  const resourcesPath = join(appBundlePath, "Contents", "Resources");
  mkdirSync(join(resourcesPath, "app", "dist"), { recursive: true });
  mkdirSync(join(resourcesPath, "mcp"), { recursive: true });
  mkdirSync(join(appBundlePath, "Contents", "MacOS"), { recursive: true });
  const identity = Object.values(identities)
    .flatMap((product) => [product.production, product.development])
    .find((item) => item.displayName === appName)!;
  const { product, brandName, displayName, bundleId } = identity;
  const evidence = {
    schemaVersion: 1,
    desktopVersion: packageMetadata.version,
    electronVersion: packageMetadata.devDependencies.electron,
    bundleId,
    bridge: {
      auth: true,
      authCompletionRejected: true,
      computerUse: true,
      developerTools: true,
      driverControls: true,
      driver: dormantDriverEvidence(),
      settledDriver: scenario.settledDriver ?? dormantDriverEvidence(),
      identity: { product, brandName, displayName },
    },
    sdkLoadAttempted: false,
  };
  const output =
    scenario.output ??
    (scenario.probe
      ? `[cua-probe] ${JSON.stringify(probeEvidence(bundleId))}`
      : `[smoke-test] evidence ${JSON.stringify(evidence)}`);
  writeFileSync(
    executablePath,
    `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.TEST_TRACE_PATH, "${marker}\\n");\nconsole.log(${JSON.stringify(output)});\n${scenario.exit === "signal" ? 'process.kill(process.pid, "SIGTERM");' : `process.exit(${scenario.exit ?? 0});`}\n`,
  );
  if (scenario.probe) prepareCuaPayload(resourcesPath, scenario.corrupt);
  chmodSync(executablePath, 0o755);
  writeFileSync(join(resourcesPath, "app", "dist", "main.js"), "");
  writeFileSync(join(resourcesPath, "mcp", "index.mjs"), "");
}

function runWrapper(
  wrapper: "run-packaged-app.js" | "smoke-test-packaged-app.js",
  values: EnvironmentValues,
  expectedAppName: "Okou" | "Okou Dev",
  scenario: SmokeScenario = {},
): EntryPointResult {
  const fixture = createDesktopFixture();
  for (const appName of ["Okou", "Okou Dev"]) {
    preparePackagedApp(
      fixture,
      appName,
      appName === expectedAppName ? "selected" : "unexpected",
      scenario,
    );
  }
  const environment = baseEnvironment();
  environment.TEST_TRACE_PATH = fixture.tracePath;
  if (scenario.probe) {
    const bin = join(fixture.desktopDirectory, "bin");
    mkdirSync(bin);
    // macOS codesign is the only substituted verification boundary.
    const codesign = join(bin, "codesign");
    writeFileSync(
      codesign,
      `#!${process.execPath}\nprocess.exit(${scenario.corrupt === "signature" ? 1 : 0});\n`,
    );
    chmodSync(codesign, 0o755);
    environment.PATH = bin + ":" + environment.PATH;
  }
  applyEnvironmentValues(environment, values);
  const processResult = spawnSync(
    process.execPath,
    [
      "--require",
      fixture.platformOverridePath,
      join(fixture.desktopDirectory, "scripts", wrapper),
      ...(scenario.probe ? ["--cua-probe", "--signed"] : []),
    ],
    { encoding: "utf8", env: environment },
  );
  return { process: processResult, trace: trace(fixture) };
}

function expectSuccessfulEntryPoint(result: EntryPointResult): void {
  expect(result.process.status, result.process.stderr).toBe(0);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Desktop build configuration entry point", () => {
  const lifecycleCases = [
    {
      name: "uses product defaults when inputs are absent",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
    },
    {
      name: "treats trimmed-empty canonical inputs as absent",
      environment: {
        canonicalProduct: " ",
        canonicalPlatformUrl: "\t",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
    },
    {
      name: "trims canonical inputs",
      environment: {
        canonicalProduct: " okou ",
        canonicalPlatformUrl: " https://app.okou.ai ",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
    },
    {
      name: "uses the runtime file when canonical inputs are absent",
      fileConfig: {
        product: "okou",
        platformUrl: "https://staging-app.omby.ai",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://staging-app.omby.ai/",
      expectedDisplayName: "Okou Dev",
    },
  ] satisfies readonly (SurfaceCase & { readonly name: string })[];

  it.each(lifecycleCases)("$name", (testCase) => {
    expectSuccessfulEntryPoint(runBuildConfig(testCase));
  });

  it("keeps canonical environment ahead of the runtime file", () => {
    const result = runBuildConfig({
      environment: {
        canonicalProduct: "okou",
        canonicalPlatformUrl: "https://app.okou.ai",
      },
      fileConfig: {
        product: "okou",
        platformUrl: "https://staging-app.omby.ai",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
    });

    expectSuccessfulEntryPoint(result);
  });

  it("keeps non-empty explicit options ahead of canonical environment", () => {
    const result = runBuildConfig({
      environment: {
        canonicalProduct: "okou",
        canonicalPlatformUrl: "https://app.okou.ai",
      },
      productArgument: " okou ",
      platformArgument: " https://app.okou.ai ",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
    });

    expectSuccessfulEntryPoint(result);
  });

  it("lets trimmed-empty explicit options fall through to canonical environment", () => {
    const result = runBuildConfig({
      environment: {
        canonicalProduct: "okou",
        canonicalPlatformUrl: "https://app.okou.ai",
      },
      productArgument: " ",
      platformArgument: "\t",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
    });

    expectSuccessfulEntryPoint(result);
  });
});

describe("installed Desktop configuration entry point", () => {
  const lifecycleCases = [
    {
      name: "uses product defaults when inputs are absent",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    },
    {
      name: "treats trimmed-empty canonical inputs as absent",
      environment: {
        canonicalProduct: " ",
        canonicalPlatformUrl: "\n",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    },
    {
      name: "trims canonical inputs",
      environment: {
        canonicalProduct: " okou ",
        canonicalPlatformUrl: " https://app.okou.ai ",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    },
    {
      name: "uses the runtime file when canonical inputs are absent",
      fileConfig: {
        product: "okou",
        platformUrl: "https://staging-app.omby.ai",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://staging-app.omby.ai/",
      expectedDisplayName: "Okou Dev",
      expectedEnvironment: "staging",
    },
  ] satisfies readonly (InstalledSurfaceCase & { readonly name: string })[];

  it.each(lifecycleCases)("$name", (testCase) => {
    expectSuccessfulEntryPoint(runInstalledConfig(testCase));
  });

  it("keeps canonical environment ahead of the runtime file", () => {
    const result = runInstalledConfig({
      environment: {
        canonicalProduct: "okou",
        canonicalPlatformUrl: "https://app.okou.ai",
      },
      fileConfig: {
        product: "okou",
        platformUrl: "https://staging-app.omby.ai",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    });

    expectSuccessfulEntryPoint(result);
  });

  it("keeps non-empty arguments ahead of canonical environment", () => {
    const result = runInstalledConfig({
      environment: {
        canonicalProduct: "okou",
        canonicalPlatformUrl: "https://app.okou.ai",
      },
      productArgument: " okou ",
      platformArgument: " https://app.okou.ai ",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    });

    expectSuccessfulEntryPoint(result);
  });

  it("lets a trimmed-empty product argument fall through to canonical environment", () => {
    const result = runInstalledConfig({
      environment: { canonicalProduct: "okou" },
      productArgument: " ",
      platformArgument: "https://app.okou.ai",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    });

    expectSuccessfulEntryPoint(result);
  });

  it("keeps a defined-empty platform argument ahead of environment and the runtime file", () => {
    const result = runInstalledConfig({
      environment: {
        canonicalPlatformUrl: "https://canonical.example.invalid",
      },
      fileConfig: {
        product: "okou",
        platformUrl: "https://staging-app.omby.ai",
      },
      productArgument: "okou",
      platformArgument: "",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    });

    expectSuccessfulEntryPoint(result);
  });

  it("names the canonical platform URL in protocol validation diagnostics", () => {
    const result = runInstalledConfig({
      environment: {
        canonicalPlatformUrl: "ftp://canonical.example.invalid",
      },
      productArgument: "okou",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    });

    expect(result.process.status).toBe(1);
    expect(result.process.stderr).toContain(
      "OKOU_DESKTOP_PLATFORM_URL must use http or https, received ftp:",
    );
  });
});

describe("Desktop product configuration validation", () => {
  it.each([
    { productArgument: "unsupported" },
    { environment: { canonicalProduct: "unsupported" } },
    ...["unsupported", "", 1, null].map((product) => ({
      fileConfig: { product, platformUrl: "https://app.okou.ai" },
    })),
  ])(
    "rejects invalid configured product input at build and runtime: %j",
    (input) => {
      const testCase: InstalledSurfaceCase = {
        ...input,
        expectedProduct: "okou",
        expectedPlatformUrl: "https://app.okou.ai/",
        expectedDisplayName: "Okou",
        expectedEnvironment: "production",
      };
      for (const result of [
        runBuildConfig(testCase),
        runInstalledConfig(testCase),
      ]) {
        expect(result.process.status).toBe(1);
        expect(result.process.stderr).toMatch(
          /Unsupported desktop product|product must be okou/,
        );
      }
    },
  );
});

describe("packaged Desktop wrapper entry points", () => {
  const wrappers = [
    "run-packaged-app.js",
    "smoke-test-packaged-app.js",
  ] as const;

  it.each(wrappers)("uses canonical values through %s", (wrapper) => {
    const result = runWrapper(
      wrapper,
      {
        canonicalProduct: " okou ",
        canonicalPlatformUrl: " https://staging-app.omby.ai ",
      },
      "Okou Dev",
    );

    expectSuccessfulEntryPoint(result);
    expect(result.trace).toBe("selected\n");
  });

  it("accepts structured lifecycle evidence only after successful process exit", () => {
    const result = runWrapper("smoke-test-packaged-app.js", {}, "Okou", {
      probe: true,
    });
    expectSuccessfulEntryPoint(result);
    expect(result.trace).toBe("selected\n");
    expect(result.process.stdout).toContain('"exitObserved":true');
    expect(result.process.stdout).toContain('"code":0,"signal":null');
  });

  it.each(["missing", "javascript", "version", "signature"] as const)(
    "rejects %s package damage before launching the executable",
    (corrupt) => {
      const result = runWrapper("smoke-test-packaged-app.js", {}, "Okou", {
        probe: true,
        corrupt,
      });
      expect(result.process.status).not.toBe(0);
      expect(result.trace).toBe("");
    },
  );

  it.each([1, "signal"] as const)(
    "rejects valid metadata with process exit %s",
    (exit) => {
      const result = runWrapper("smoke-test-packaged-app.js", {}, "Okou", {
        probe: true,
        exit,
      });
      expect(result.process.status).toBe(1);
      expect(result.trace).toBe("selected\n");
    },
  );

  const validProbe = probeEvidence();
  const malformedEvidence = [
    "[cua-probe] {invalid JSON with private-input}",
    '[cua-probe] {"cleanup":"confirmed"}',
    "[cua-probe] " + JSON.stringify({ ...validProbe, driverVersion: "0.23.1" }),
    "[cua-probe] " +
      JSON.stringify({
        ...validProbe,
        metadata: { ...validProbe.metadata, embedded: false },
      }),
    "[cua-probe] " +
      JSON.stringify({
        ...validProbe,
        metadata: { ...validProbe.metadata, hostBundleId: "unowned.app" },
      }),
    "[cua-probe] " +
      JSON.stringify({
        ...validProbe,
        readyState: { ...validProbe.readyState, loadedDriverVersion: null },
      }),
    "[cua-probe] " + JSON.stringify({ ...validProbe, capture: "success" }),
    "[cua-probe] " + JSON.stringify({ ...validProbe, accessibility: "false" }),
    "[cua-probe] " +
      JSON.stringify({
        ...validProbe,
        cleanup: { ...validProbe.cleanup, exitObserved: false },
      }),
    "[cua-probe] " +
      JSON.stringify({
        ...validProbe,
        cleanup: { ...validProbe.cleanup, exitCode: null, exitSuccess: false },
      }),
    "[cua-probe] " +
      JSON.stringify({
        ...validProbe,
        cleanup: { ...validProbe.cleanup, generation: 2 },
      }),
    "[cua-probe] " +
      JSON.stringify({
        ...validProbe,
        stoppedState: { ...validProbe.stoppedState, cleanupPending: true },
      }),
    "[cua-probe] " +
      JSON.stringify({ ...validProbe, privateField: "private-input" }),
    `[cua-probe] ${JSON.stringify(validProbe)}\n[cua-probe] ${JSON.stringify(validProbe)}`,
    "private-input".repeat(12000),
    "no record",
  ];
  it.each(malformedEvidence.map((output, index) => ({ output, index })))(
    "rejects invalid or unproven lifecycle evidence $index without exposing raw output",
    ({ output }) => {
      const result = runWrapper("smoke-test-packaged-app.js", {}, "Okou", {
        probe: true,
        output,
      });
      expect(result.process.status).toBe(1);
      expect(result.process.stdout + result.process.stderr).not.toContain(
        "private-input",
      );
    },
  );

  it.each([
    { ...dormantDriverEvidence(), selectedDriver: "cua" },
    { ...dormantDriverEvidence(), phase: "ready" },
    { ...dormantDriverEvidence(), expectedCuaVersion: "0.23.1" },
    {
      ...dormantDriverEvidence(),
      actual: { id: "cua", generation: 1, version: null },
    },
    {
      ...dormantDriverEvidence(),
      actual: { id: "okou", generation: 0, version: null },
    },
    { ...dormantDriverEvidence(), cleanupPending: true },
  ])(
    "rejects non-default or invalid settled driver state %#",
    (settledDriver) => {
      const result = runWrapper("smoke-test-packaged-app.js", {}, "Okou", {
        settledDriver,
      });
      expect(result.process.status).toBe(1);
    },
  );

  it("does not accept ordinary readiness/dormancy markers without actual driver state", () => {
    const result = runWrapper("smoke-test-packaged-app.js", {}, "Okou", {
      output: "[smoke-test] desktop main ready\n[smoke-test] cua dormant",
    });
    expect(result.process.status).toBe(1);
  });
});

describe("Desktop package brand assets", () => {
  it("uses the Okou app icon by default", () => {
    const result = runForgeConfig();

    expect(result.status, result.stderr).toBe(0);
  });
});
