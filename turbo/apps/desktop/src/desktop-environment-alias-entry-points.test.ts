import { randomUUID } from "node:crypto";
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

const aliases = {
  canonicalPlatformUrl: "OKOU_DESKTOP_PLATFORM_URL",
  canonicalProduct: "OKOU_DESKTOP_PRODUCT",
  legacyPlatformUrl: "VM0_DESKTOP_PLATFORM_URL",
  legacyProduct: "VM0_DESKTOP_PRODUCT",
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

interface AliasValues {
  readonly canonicalPlatformUrl?: string;
  readonly canonicalProduct?: string;
  readonly legacyPlatformUrl?: string;
  readonly legacyProduct?: string;
}

interface RuntimeFileConfig {
  readonly platformUrl: string;
  readonly product?: "zero" | "okou";
}

interface SurfaceCase {
  readonly aliases?: AliasValues;
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
  readonly aliasValues: readonly string[];
}

function createDesktopFixture(): DesktopFixture {
  const directory = mkdtempSync(join(tmpdir(), "desktop-env-alias-entry-"));
  temporaryDirectories.push(directory);
  const fixtureDesktopDirectory = join(directory, "desktop");
  const scriptsDirectory = join(fixtureDesktopDirectory, "scripts");
  const sourceDirectory = join(fixtureDesktopDirectory, "src");
  mkdirSync(scriptsDirectory, { recursive: true });
  mkdirSync(sourceDirectory, { recursive: true });

  for (const relativePath of [
    "scripts/desktop-build-config.js",
    "scripts/desktop-environment-alias.js",
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

function applyAliases(
  environment: NodeJS.ProcessEnv,
  values: AliasValues | undefined,
): readonly string[] {
  if (!values) {
    return [];
  }

  const selectedValues: string[] = [];
  for (const [key, environmentName] of Object.entries(aliases)) {
    const value = values[key as keyof AliasValues];
    if (value !== undefined) {
      environment[environmentName] = value;
      if (value.trim()) {
        selectedValues.push(value.trim());
      }
    }
  }
  return selectedValues;
}

function baseEnvironment(): NodeJS.ProcessEnv {
  return process.env.PATH ? { PATH: process.env.PATH } : {};
}

function surfaceEnvironment(
  testCase: SurfaceCase,
  fixture: DesktopFixture,
): {
  readonly environment: NodeJS.ProcessEnv;
  readonly values: readonly string[];
} {
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
  return {
    environment,
    values: applyAliases(environment, testCase.aliases),
  };
}

function trace(fixture: DesktopFixture): string {
  return existsSync(fixture.tracePath)
    ? readFileSync(fixture.tracePath, "utf8")
    : "";
}

function runBuildConfig(testCase: SurfaceCase): EntryPointResult {
  const fixture = createDesktopFixture();
  writeRuntimeConfig(fixture, testCase.fileConfig);
  const { environment, values } = surfaceEnvironment(testCase, fixture);
  const processResult = spawnSync(
    process.execPath,
    ["--eval", buildConfigHarnessSource],
    { encoding: "utf8", env: environment },
  );
  return { process: processResult, trace: trace(fixture), aliasValues: values };
}

function runInstalledConfig(testCase: InstalledSurfaceCase): EntryPointResult {
  const fixture = createDesktopFixture();
  writeRuntimeConfig(fixture, testCase.fileConfig);
  const harnessPath = join(fixture.desktopDirectory, "installed-config.ts");
  writeFileSync(harnessPath, installedConfigHarnessSource);
  const { environment, values } = surfaceEnvironment(testCase, fixture);
  environment.TEST_EXPECTED_ENVIRONMENT = testCase.expectedEnvironment;
  environment.TEST_EXPECTED_SESSION_PARTITION = `persist:vm0-desktop-${testCase.expectedEnvironment}`;
  const processResult = spawnSync(
    process.execPath,
    ["--import", "tsx", harnessPath],
    { cwd: turboDirectory, encoding: "utf8", env: environment },
  );
  return { process: processResult, trace: trace(fixture), aliasValues: values };
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
  values: AliasValues,
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
  const aliasValues = applyAliases(environment, values);
  const processResult = spawnSync(
    process.execPath,
    [
      "--require",
      fixture.platformOverridePath,
      join(fixture.desktopDirectory, "scripts", wrapper),
    ],
    { encoding: "utf8", env: environment },
  );
  return {
    process: processResult,
    trace: trace(fixture),
    aliasValues,
  };
}

function sourceEvents(result: EntryPointResult): readonly string[] {
  return result.process.stdout
    .split("\n")
    .filter((line) => line.startsWith("desktop_environment_alias_source "));
}

function expectBoundedSourceEvents(
  result: EntryPointResult,
  expectedEvents: readonly string[],
): void {
  expect(sourceEvents(result)).toStrictEqual(expectedEvents);
  for (const event of sourceEvents(result)) {
    expect(event).toMatch(
      /^desktop_environment_alias_source key=OKOU_DESKTOP_(?:PLATFORM_URL|PRODUCT) source=(?:canonical-only|legacy-only|dual)$/,
    );
  }
}

function expectNoAliasValueDisclosure(result: EntryPointResult): void {
  const output = result.process.stdout + result.process.stderr;
  for (const value of result.aliasValues) {
    expect(output.includes(value)).toBe(false);
  }
  expect(output.includes("length=")).toBe(false);
}

function expectSuccessfulEntryPoint(
  result: EntryPointResult,
  expectedEvents: readonly string[],
): void {
  expect(result.process.status, result.process.stderr).toBe(0);
  expectBoundedSourceEvents(result, expectedEvents);
  expectNoAliasValueDisclosure(result);
}

function expectConflict(
  result: EntryPointResult,
  key: "OKOU_DESKTOP_PLATFORM_URL" | "OKOU_DESKTOP_PRODUCT",
): void {
  expect(result.process.status).toBe(1);
  expect(result.trace).toBe("");
  expect(result.process.stderr).toContain(
    `Desktop environment aliases conflict: key=${key} state=conflict`,
  );
  expectNoAliasValueDisclosure(result);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Desktop build configuration entry point", () => {
  it.each([
    {
      name: "canonical-only aliases",
      aliases: {
        canonicalProduct: "okou",
        canonicalPlatformUrl: "https://app.okou.ai",
      },
      events: [
        "desktop_environment_alias_source key=OKOU_DESKTOP_PRODUCT source=canonical-only",
        "desktop_environment_alias_source key=OKOU_DESKTOP_PLATFORM_URL source=canonical-only",
      ],
    },
    {
      name: "legacy-only aliases",
      aliases: {
        legacyProduct: "okou",
        legacyPlatformUrl: "https://app.okou.ai",
      },
      events: [
        "desktop_environment_alias_source key=OKOU_DESKTOP_PRODUCT source=legacy-only",
        "desktop_environment_alias_source key=OKOU_DESKTOP_PLATFORM_URL source=legacy-only",
      ],
    },
    {
      name: "trimmed equal dual aliases",
      aliases: {
        canonicalProduct: " okou ",
        legacyProduct: "okou",
        canonicalPlatformUrl: " https://app.okou.ai ",
        legacyPlatformUrl: "https://app.okou.ai",
      },
      events: [
        "desktop_environment_alias_source key=OKOU_DESKTOP_PRODUCT source=dual",
        "desktop_environment_alias_source key=OKOU_DESKTOP_PLATFORM_URL source=dual",
      ],
    },
    {
      name: "canonical product and legacy platform URL",
      aliases: {
        canonicalProduct: "okou",
        legacyPlatformUrl: "https://app.okou.ai",
      },
      events: [
        "desktop_environment_alias_source key=OKOU_DESKTOP_PRODUCT source=canonical-only",
        "desktop_environment_alias_source key=OKOU_DESKTOP_PLATFORM_URL source=legacy-only",
      ],
    },
    {
      name: "legacy product and canonical platform URL",
      aliases: {
        legacyProduct: "okou",
        canonicalPlatformUrl: "https://app.okou.ai",
      },
      events: [
        "desktop_environment_alias_source key=OKOU_DESKTOP_PRODUCT source=legacy-only",
        "desktop_environment_alias_source key=OKOU_DESKTOP_PLATFORM_URL source=canonical-only",
      ],
    },
  ])("resolves $name independently", ({ aliases: values, events }) => {
    const result = runBuildConfig({
      aliases: values,
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
    });

    expectSuccessfulEntryPoint(result, events);
  });

  it("keeps environment ahead of the runtime file and the file ahead of defaults", () => {
    const environmentResult = runBuildConfig({
      aliases: {
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
    expectSuccessfulEntryPoint(environmentResult, [
      "desktop_environment_alias_source key=OKOU_DESKTOP_PRODUCT source=canonical-only",
      "desktop_environment_alias_source key=OKOU_DESKTOP_PLATFORM_URL source=canonical-only",
    ]);

    const fileResult = runBuildConfig({
      aliases: {
        canonicalProduct: " ",
        legacyProduct: "\t",
        canonicalPlatformUrl: " ",
        legacyPlatformUrl: "\n",
      },
      fileConfig: {
        product: "okou",
        platformUrl: "https://staging-app.omby.ai",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://staging-app.omby.ai/",
      expectedDisplayName: "Okou Dev",
    });
    expectSuccessfulEntryPoint(fileResult, []);
  });

  it("keeps non-empty explicit options ahead of conflicting aliases", () => {
    const result = runBuildConfig({
      aliases: {
        canonicalProduct: "zero",
        legacyProduct: "okou",
        canonicalPlatformUrl: "https://app.vm0.ai",
        legacyPlatformUrl: "https://staging-app.omby.ai",
      },
      productArgument: " okou ",
      platformArgument: " https://app.okou.ai ",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
    });

    expectSuccessfulEntryPoint(result, []);
  });

  it("lets trimmed-empty explicit options fall through to aliases", () => {
    const result = runBuildConfig({
      aliases: {
        canonicalProduct: "okou",
        canonicalPlatformUrl: "https://app.okou.ai",
      },
      productArgument: " ",
      platformArgument: "\t",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
    });

    expectSuccessfulEntryPoint(result, [
      "desktop_environment_alias_source key=OKOU_DESKTOP_PRODUCT source=canonical-only",
      "desktop_environment_alias_source key=OKOU_DESKTOP_PLATFORM_URL source=canonical-only",
    ]);
  });

  it.each([
    {
      key: "OKOU_DESKTOP_PRODUCT" as const,
      aliases: { canonicalProduct: "okou", legacyProduct: "zero" },
    },
    {
      key: "OKOU_DESKTOP_PLATFORM_URL" as const,
      aliases: {
        canonicalPlatformUrl: `https://${randomUUID()}.example`,
        legacyPlatformUrl: `https://${randomUUID()}.example`,
      },
      productArgument: "okou",
    },
  ])("fails closed for unequal $key aliases", (testCase) => {
    const result = runBuildConfig({
      ...testCase,
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
    });

    expectConflict(result, testCase.key);
  });
});

describe("installed Desktop configuration entry point", () => {
  it.each([
    {
      name: "canonical product and legacy platform URL",
      aliases: {
        canonicalProduct: "okou",
        legacyPlatformUrl: "https://app.okou.ai",
      },
      events: [
        "desktop_environment_alias_source key=OKOU_DESKTOP_PRODUCT source=canonical-only",
        "desktop_environment_alias_source key=OKOU_DESKTOP_PLATFORM_URL source=legacy-only",
      ],
    },
    {
      name: "legacy product and canonical platform URL",
      aliases: {
        legacyProduct: "okou",
        canonicalPlatformUrl: "https://app.okou.ai",
      },
      events: [
        "desktop_environment_alias_source key=OKOU_DESKTOP_PRODUCT source=legacy-only",
        "desktop_environment_alias_source key=OKOU_DESKTOP_PLATFORM_URL source=canonical-only",
      ],
    },
    {
      name: "trimmed equal dual aliases",
      aliases: {
        canonicalProduct: " okou ",
        legacyProduct: "okou",
        canonicalPlatformUrl: " https://app.okou.ai ",
        legacyPlatformUrl: "https://app.okou.ai",
      },
      events: [
        "desktop_environment_alias_source key=OKOU_DESKTOP_PRODUCT source=dual",
        "desktop_environment_alias_source key=OKOU_DESKTOP_PLATFORM_URL source=dual",
      ],
    },
  ])("resolves $name independently", ({ aliases: values, events }) => {
    const result = runInstalledConfig({
      aliases: values,
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    });

    expectSuccessfulEntryPoint(result, events);
  });

  it("keeps environment ahead of the runtime file and the file ahead of defaults", () => {
    const environmentResult = runInstalledConfig({
      aliases: {
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
    expectSuccessfulEntryPoint(environmentResult, [
      "desktop_environment_alias_source key=OKOU_DESKTOP_PRODUCT source=canonical-only",
      "desktop_environment_alias_source key=OKOU_DESKTOP_PLATFORM_URL source=canonical-only",
    ]);

    const fileResult = runInstalledConfig({
      fileConfig: {
        product: "okou",
        platformUrl: "https://staging-app.omby.ai",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://staging-app.omby.ai/",
      expectedDisplayName: "Okou Dev",
      expectedEnvironment: "staging",
    });
    expectSuccessfulEntryPoint(fileResult, []);
  });

  it("keeps non-empty arguments ahead of conflicting aliases", () => {
    const result = runInstalledConfig({
      aliases: {
        canonicalProduct: "zero",
        legacyProduct: "okou",
        canonicalPlatformUrl: "https://app.vm0.ai",
        legacyPlatformUrl: "https://staging-app.omby.ai",
      },
      productArgument: " okou ",
      platformArgument: " https://app.okou.ai ",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    });

    expectSuccessfulEntryPoint(result, []);
  });

  it("lets a trimmed-empty product argument fall through to aliases", () => {
    const result = runInstalledConfig({
      aliases: { canonicalProduct: "okou" },
      productArgument: " ",
      platformArgument: "https://app.okou.ai",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    });

    expectSuccessfulEntryPoint(result, [
      "desktop_environment_alias_source key=OKOU_DESKTOP_PRODUCT source=canonical-only",
    ]);
  });

  it("keeps a defined-empty platform argument ahead of aliases and the runtime file", () => {
    const result = runInstalledConfig({
      aliases: {
        canonicalPlatformUrl: `https://${randomUUID()}.example`,
        legacyPlatformUrl: `https://${randomUUID()}.example`,
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

    expectSuccessfulEntryPoint(result, []);
  });

  it("names the canonical platform URL in protocol validation diagnostics", () => {
    const result = runInstalledConfig({
      aliases: {
        canonicalPlatformUrl: `ftp://${randomUUID()}.example`,
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
    expect(result.process.stderr).not.toContain(
      "VM0_DESKTOP_PLATFORM_URL must use http or https",
    );
    expectBoundedSourceEvents(result, [
      "desktop_environment_alias_source key=OKOU_DESKTOP_PLATFORM_URL source=canonical-only",
    ]);
    expectNoAliasValueDisclosure(result);
  });

  it.each([
    {
      key: "OKOU_DESKTOP_PRODUCT" as const,
      aliases: { canonicalProduct: "okou", legacyProduct: "zero" },
      platformArgument: "https://app.okou.ai",
    },
    {
      key: "OKOU_DESKTOP_PLATFORM_URL" as const,
      aliases: {
        canonicalPlatformUrl: `https://${randomUUID()}.example`,
        legacyPlatformUrl: `https://${randomUUID()}.example`,
      },
      productArgument: "okou",
    },
  ])("fails closed for unequal $key aliases", (testCase) => {
    const result = runInstalledConfig({
      ...testCase,
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    });

    expectConflict(result, testCase.key);
  });
});

describe("packaged Desktop wrapper entry points", () => {
  it.each([
    {
      wrapper: "run-packaged-app.js" as const,
      aliases: {
        canonicalProduct: "okou",
        legacyPlatformUrl: "https://staging-app.omby.ai",
      },
      events: [
        "desktop_environment_alias_source key=OKOU_DESKTOP_PRODUCT source=canonical-only",
        "desktop_environment_alias_source key=OKOU_DESKTOP_PLATFORM_URL source=legacy-only",
      ],
    },
    {
      wrapper: "smoke-test-packaged-app.js" as const,
      aliases: {
        legacyProduct: "okou",
        canonicalPlatformUrl: "https://staging-app.omby.ai",
      },
      events: [
        "desktop_environment_alias_source key=OKOU_DESKTOP_PRODUCT source=legacy-only",
        "desktop_environment_alias_source key=OKOU_DESKTOP_PLATFORM_URL source=canonical-only",
      ],
    },
  ])("delegates independent aliases through $wrapper", (testCase) => {
    const result = runWrapper(testCase.wrapper, testCase.aliases, "Okou Dev");

    expectSuccessfulEntryPoint(result, testCase.events);
    expect(result.trace).toBe("selected\n");
  });

  it.each([
    {
      wrapper: "run-packaged-app.js" as const,
      key: "OKOU_DESKTOP_PRODUCT" as const,
      aliases: {
        canonicalProduct: "okou",
        legacyProduct: "zero",
        canonicalPlatformUrl: "https://app.okou.ai",
      },
    },
    {
      wrapper: "run-packaged-app.js" as const,
      key: "OKOU_DESKTOP_PLATFORM_URL" as const,
      aliases: {
        canonicalProduct: "okou",
        canonicalPlatformUrl: `https://${randomUUID()}.example`,
        legacyPlatformUrl: `https://${randomUUID()}.example`,
      },
    },
    {
      wrapper: "smoke-test-packaged-app.js" as const,
      key: "OKOU_DESKTOP_PRODUCT" as const,
      aliases: {
        canonicalProduct: "okou",
        legacyProduct: "zero",
        canonicalPlatformUrl: "https://app.okou.ai",
      },
    },
    {
      wrapper: "smoke-test-packaged-app.js" as const,
      key: "OKOU_DESKTOP_PLATFORM_URL" as const,
      aliases: {
        canonicalProduct: "okou",
        canonicalPlatformUrl: `https://${randomUUID()}.example`,
        legacyPlatformUrl: `https://${randomUUID()}.example`,
      },
    },
  ])("rejects $key conflicts before $wrapper side effects", (testCase) => {
    const result = runWrapper(testCase.wrapper, testCase.aliases, "Okou");

    expectConflict(result, testCase.key);
  });
});
