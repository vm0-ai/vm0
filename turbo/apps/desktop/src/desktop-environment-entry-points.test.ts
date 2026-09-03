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
  config.environment !== process.env.TEST_EXPECTED_ENVIRONMENT ||
  config.identity.displayName !== process.env.TEST_EXPECTED_DISPLAY_NAME ||
  config.sessionPartition !== process.env.TEST_EXPECTED_SESSION_PARTITION
) {
  throw new Error("Installed Desktop configuration changed");
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
  readonly product?: "zero" | "okou";
}

interface SurfaceCase {
  readonly environment?: EnvironmentValues;
  readonly fileConfig?: RuntimeFileConfig;
  readonly platformArgument?: string;
  readonly productArgument?: string;
  readonly expectedProduct: "zero" | "okou";
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

  for (const relativePath of [
    "scripts/desktop-build-config.js",
    "scripts/desktop-environment.js",
    "scripts/packaged-app-paths.js",
    "scripts/run-packaged-app.js",
    "scripts/smoke-test-packaged-app.js",
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

function preparePackagedApp(
  fixture: DesktopFixture,
  appName: string,
  marker: "selected" | "unexpected",
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
  writeFileSync(
    executablePath,
    `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.TEST_TRACE_PATH, "${marker}\\n");\nconsole.log("[smoke-test] desktop main ready");\n`,
  );
  chmodSync(executablePath, 0o755);
  writeFileSync(join(resourcesPath, "app", "dist", "main.js"), "");
  writeFileSync(join(resourcesPath, "mcp", "index.mjs"), "");
}

function runWrapper(
  wrapper: "run-packaged-app.js" | "smoke-test-packaged-app.js",
  values: EnvironmentValues,
  expectedAppName: "Zero Computer Use" | "Zero CU Dev" | "Okou" | "Okou Dev",
): EntryPointResult {
  const fixture = createDesktopFixture();
  for (const appName of [
    "Zero Computer Use",
    "Zero CU Dev",
    "Okou",
    "Okou Dev",
  ]) {
    preparePackagedApp(
      fixture,
      appName,
      appName === expectedAppName ? "selected" : "unexpected",
    );
  }
  const environment = baseEnvironment();
  environment.TEST_TRACE_PATH = fixture.tracePath;
  applyEnvironmentValues(environment, values);
  const processResult = spawnSync(
    process.execPath,
    [
      "--require",
      fixture.platformOverridePath,
      join(fixture.desktopDirectory, "scripts", wrapper),
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
      expectedProduct: "zero",
      expectedPlatformUrl: "https://app.vm0.ai/",
      expectedDisplayName: "Zero Computer Use",
    },
    {
      name: "treats trimmed-empty canonical inputs as absent",
      environment: {
        canonicalProduct: " ",
        canonicalPlatformUrl: "\t",
      },
      expectedProduct: "zero",
      expectedPlatformUrl: "https://app.vm0.ai/",
      expectedDisplayName: "Zero Computer Use",
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
        product: "zero",
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
        canonicalProduct: "zero",
        canonicalPlatformUrl: "https://app.vm0.ai",
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
      expectedProduct: "zero",
      expectedPlatformUrl: "https://app.vm0.ai/",
      expectedDisplayName: "Zero Computer Use",
      expectedEnvironment: "production",
    },
    {
      name: "treats trimmed-empty canonical inputs as absent",
      environment: {
        canonicalProduct: " ",
        canonicalPlatformUrl: "\n",
      },
      expectedProduct: "zero",
      expectedPlatformUrl: "https://app.vm0.ai/",
      expectedDisplayName: "Zero Computer Use",
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
        product: "zero",
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
        canonicalProduct: "zero",
        canonicalPlatformUrl: "https://app.vm0.ai",
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
        product: "zero",
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
});
