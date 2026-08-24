import { randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
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

import packageMetadata from "../package.json";

const desktopDirectory = resolve(__dirname, "..");
const forgeConfigPath = join(desktopDirectory, "forge.config.js");
const packagedAppScriptPath = join(
  desktopDirectory,
  "scripts",
  "sign-and-notarize-packaged-app.mjs",
);
const temporaryDirectories: string[] = [];

const canonicalAliases = {
  keyPath: "OKOU_DESKTOP_NOTARIZE_API_KEY_PATH",
  keyId: "OKOU_DESKTOP_NOTARIZE_API_KEY_ID",
  issuer: "OKOU_DESKTOP_NOTARIZE_API_ISSUER",
} as const;
const legacyAliases = {
  keyPath: "VM0_DESKTOP_NOTARIZE_API_KEY_PATH",
  keyId: "VM0_DESKTOP_NOTARIZE_API_KEY_ID",
  issuer: "VM0_DESKTOP_NOTARIZE_API_ISSUER",
} as const;
const allAliases = [
  ...Object.values(canonicalAliases),
  ...Object.values(legacyAliases),
];

const moduleLoaderSource = `
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const externalModules = new Map([
  ["@electron/osx-sign", pathToFileURL(process.env.TEST_OSX_SIGN_MODULE).href],
  ["@electron/notarize", pathToFileURL(process.env.TEST_NOTARIZE_MODULE).href],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const replacement = externalModules.get(specifier);
    if (replacement) {
      return { shortCircuit: true, url: replacement };
    }
    return nextResolve(specifier, context);
  },
});
`;

const osxSignModuleSource = `
import { appendFileSync } from "node:fs";

export async function sign(options) {
  appendFileSync(process.env.TEST_TRACE_PATH, "sign\\n");
  const forgeOptionsAreUnchanged =
    process.env.TEST_SIGN_KIND === "forge" &&
    options.app === process.env.TEST_EXPECTED_APP_PATH &&
    options.batchCodesignCalls === true &&
    options.identity === "-" &&
    options.identityValidation === false &&
    options.platform === "darwin" &&
    options.timestamp === "none" &&
    options.version === process.env.TEST_EXPECTED_ELECTRON_VERSION;
  const helperOptionsAreUnchanged =
    process.env.TEST_SIGN_KIND === "helper" &&
    options.app === process.env.TEST_EXPECTED_APP_PATH &&
    options.batchCodesignCalls === true &&
    options.identity === process.env.VM0_DESKTOP_SIGNING_IDENTITY &&
    options.identityValidation === true &&
    options.platform === "darwin" &&
    options.timestamp === undefined &&
    options.version === process.env.TEST_EXPECTED_ELECTRON_VERSION;
  if (!forgeOptionsAreUnchanged && !helperOptionsAreUnchanged) {
    throw new Error("Desktop signing options changed");
  }
}
`;

const notarizeModuleSource = `
import { appendFileSync } from "node:fs";

export async function notarize(options) {
  appendFileSync(process.env.TEST_TRACE_PATH, "notarize\\n");
  const appPathIsUnchanged =
    options.appPath === process.env.TEST_EXPECTED_APP_PATH;
  const mode = process.env.TEST_NOTARIZE_MODE;
  let credentialsAreUnchanged = false;
  if (mode === "api") {
    const prefix =
      process.env.TEST_EXPECTED_API_SOURCE === "legacy-only" ? "VM0" : "OKOU";
    credentialsAreUnchanged =
      options.appleApiKey ===
        process.env[prefix + "_DESKTOP_NOTARIZE_API_KEY_PATH"] &&
      options.appleApiKeyId ===
        process.env[prefix + "_DESKTOP_NOTARIZE_API_KEY_ID"] &&
      options.appleApiIssuer ===
        process.env[prefix + "_DESKTOP_NOTARIZE_API_ISSUER"] &&
      options.keychainProfile === undefined &&
      options.keychain === undefined;
  } else if (mode === "default-keychain") {
    credentialsAreUnchanged =
      options.keychainProfile === "vm0-desktop-notary" &&
      options.keychain === process.env.TEST_EXPECTED_DEFAULT_KEYCHAIN &&
      options.appleApiKey === undefined &&
      options.appleApiKeyId === undefined &&
      options.appleApiIssuer === undefined;
  } else if (mode === "custom-keychain") {
    credentialsAreUnchanged =
      options.keychainProfile ===
        process.env.VM0_DESKTOP_NOTARIZE_KEYCHAIN_PROFILE &&
      options.keychain === process.env.TEST_EXPECTED_DEFAULT_KEYCHAIN &&
      options.appleApiKey === undefined &&
      options.appleApiKeyId === undefined &&
      options.appleApiIssuer === undefined;
  }
  if (!appPathIsUnchanged || !credentialsAreUnchanged) {
    throw new Error("Desktop notarization options changed");
  }
}
`;

const forgeHarnessSource = `
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const forgeConfig = require(process.env.TEST_FORGE_CONFIG_PATH);
await forgeConfig.hooks.postPackage({}, {
  platform: "darwin",
  outputPaths: [process.env.TEST_OUTPUT_PATH],
});
`;

type CredentialCase =
  | "absent"
  | "empty"
  | "canonical-only"
  | "legacy-only"
  | "dual"
  | "conflict"
  | "mixed"
  | "incomplete";
type SuccessfulSource = "canonical-only" | "legacy-only" | "dual";

interface CredentialValues {
  readonly keyPath: string;
  readonly keyId: string;
  readonly issuer: string;
}

interface TestHarness {
  readonly directory: string;
  readonly loaderPath: string;
  readonly tracePath: string;
  readonly signModulePath: string;
  readonly notarizeModulePath: string;
}

interface EntryPointResult {
  readonly process: SpawnSyncReturns<string>;
  readonly trace: string;
  readonly credentialValues: readonly string[];
}

function createTestHarness(): TestHarness {
  const directory = mkdtempSync(join(tmpdir(), "desktop-notarize-entry-"));
  temporaryDirectories.push(directory);
  const loaderPath = join(directory, "external-module-loader.mjs");
  const signModulePath = join(directory, "osx-sign.mjs");
  const notarizeModulePath = join(directory, "notarize.mjs");
  writeFileSync(loaderPath, moduleLoaderSource);
  writeFileSync(signModulePath, osxSignModuleSource);
  writeFileSync(notarizeModulePath, notarizeModuleSource);
  return {
    directory,
    loaderPath,
    tracePath: join(directory, "external-side-effects.txt"),
    signModulePath,
    notarizeModulePath,
  };
}

function credentialValues(directory: string): CredentialValues {
  return {
    keyPath: join(directory, randomUUID()),
    keyId: randomUUID(),
    issuer: randomUUID(),
  };
}

function assignCredentialValues(
  environment: NodeJS.ProcessEnv,
  aliases: typeof canonicalAliases | typeof legacyAliases,
  values: CredentialValues,
): void {
  environment[aliases.keyPath] = values.keyPath;
  environment[aliases.keyId] = values.keyId;
  environment[aliases.issuer] = values.issuer;
}

function applyCredentialCase(
  environment: NodeJS.ProcessEnv,
  directory: string,
  credentialCase: CredentialCase,
): readonly string[] {
  if (credentialCase === "absent") {
    return [];
  }
  if (credentialCase === "empty") {
    for (const alias of allAliases) {
      environment[alias] = "";
    }
    return [];
  }

  const canonical = credentialValues(directory);
  const legacy =
    credentialCase === "dual" ? canonical : credentialValues(directory);
  if (credentialCase === "canonical-only") {
    assignCredentialValues(environment, canonicalAliases, canonical);
    for (const alias of Object.values(legacyAliases)) {
      environment[alias] = "";
    }
  } else if (credentialCase === "legacy-only") {
    assignCredentialValues(environment, legacyAliases, legacy);
    for (const alias of Object.values(canonicalAliases)) {
      environment[alias] = "";
    }
  } else if (credentialCase === "dual" || credentialCase === "conflict") {
    assignCredentialValues(environment, canonicalAliases, canonical);
    assignCredentialValues(environment, legacyAliases, legacy);
  } else if (credentialCase === "mixed") {
    environment[canonicalAliases.keyPath] = canonical.keyPath;
    environment[legacyAliases.keyId] = legacy.keyId;
    environment[legacyAliases.issuer] = legacy.issuer;
  } else {
    environment[canonicalAliases.keyPath] = canonical.keyPath;
    environment[canonicalAliases.keyId] = canonical.keyId;
    environment[canonicalAliases.issuer] = "";
  }

  return allAliases.flatMap((alias) => {
    const value = environment[alias];
    return value ? [value] : [];
  });
}

function baseEnvironment(harness: TestHarness): NodeJS.ProcessEnv {
  return {
    CI: "true",
    HOME: harness.directory,
    TEST_EXPECTED_DEFAULT_KEYCHAIN: join(
      harness.directory,
      "Library",
      "Keychains",
      "login.keychain-db",
    ),
    TEST_EXPECTED_ELECTRON_VERSION: packageMetadata.devDependencies.electron,
    TEST_FORGE_CONFIG_PATH: forgeConfigPath,
    TEST_NOTARIZE_MODULE: harness.notarizeModulePath,
    TEST_OSX_SIGN_MODULE: harness.signModulePath,
    TEST_TRACE_PATH: harness.tracePath,
  };
}

function trace(harness: TestHarness): string {
  return existsSync(harness.tracePath)
    ? readFileSync(harness.tracePath, "utf8")
    : "";
}

function runForge(
  credentialCase: CredentialCase,
  options: {
    readonly notarize?: boolean;
    readonly source?: SuccessfulSource;
    readonly keychainMode?: "default-keychain" | "custom-keychain";
  } = {},
): EntryPointResult {
  const harness = createTestHarness();
  const outputPath = join(harness.directory, "forge-output");
  const appPath = join(outputPath, "Zero Computer Use.app");
  mkdirSync(appPath, { recursive: true });
  const environment = baseEnvironment(harness);
  environment.TEST_EXPECTED_APP_PATH = appPath;
  environment.TEST_OUTPUT_PATH = outputPath;
  environment.TEST_SIGN_KIND = "forge";
  if (options.notarize !== false) {
    environment.VM0_DESKTOP_NOTARIZE = "true";
  }
  const values = applyCredentialCase(
    environment,
    harness.directory,
    credentialCase,
  );
  if (options.source) {
    environment.TEST_NOTARIZE_MODE = "api";
    environment.TEST_EXPECTED_API_SOURCE = options.source;
  }
  if (options.keychainMode) {
    environment.TEST_NOTARIZE_MODE = options.keychainMode;
  }
  if (options.keychainMode === "custom-keychain") {
    environment.VM0_DESKTOP_NOTARIZE_KEYCHAIN_PROFILE = randomUUID();
  }

  const processResult = spawnSync(
    process.execPath,
    [
      "--import",
      harness.loaderPath,
      "--input-type=module",
      "--eval",
      forgeHarnessSource,
    ],
    {
      cwd: desktopDirectory,
      encoding: "utf8",
      env: environment,
    },
  );
  return {
    process: processResult,
    trace: trace(harness),
    credentialValues: values,
  };
}

function runPackagedAppHelper(
  credentialCase: CredentialCase,
  options: { readonly appName?: string; readonly product?: string } = {},
): EntryPointResult {
  const harness = createTestHarness();
  const appPath = join(
    harness.directory,
    options.appName ?? "Zero Computer Use.app",
  );
  mkdirSync(appPath, { recursive: true });
  const environment = baseEnvironment(harness);
  environment.TEST_EXPECTED_APP_PATH = appPath;
  environment.TEST_SIGN_KIND = "helper";
  environment.TEST_NOTARIZE_MODE = "api";
  environment.VM0_DESKTOP_SIGNING_IDENTITY = randomUUID();
  const values = applyCredentialCase(
    environment,
    harness.directory,
    credentialCase,
  );
  if (
    credentialCase === "canonical-only" ||
    credentialCase === "legacy-only" ||
    credentialCase === "dual"
  ) {
    environment.TEST_EXPECTED_API_SOURCE = credentialCase;
  }

  const processResult = spawnSync(
    process.execPath,
    [
      "--import",
      harness.loaderPath,
      packagedAppScriptPath,
      "--app",
      appPath,
      "--product",
      options.product ?? "zero",
    ],
    {
      cwd: desktopDirectory,
      encoding: "utf8",
      env: environment,
    },
  );
  return {
    process: processResult,
    trace: trace(harness),
    credentialValues: values,
  };
}

function sourceEvents(result: EntryPointResult): readonly string[] {
  return result.process.stdout
    .split("\n")
    .filter((line) => line.startsWith("desktop_notarize_api_env_source "));
}

function expectNoCredentialDisclosure(result: EntryPointResult): void {
  const output = result.process.stdout + result.process.stderr;
  for (const value of result.credentialValues) {
    expect(output.includes(value)).toBe(false);
  }
}

function expectSuccessfulApiEntryPoint(
  result: EntryPointResult,
  source: SuccessfulSource,
): void {
  expect(result.process.status === 0).toBe(true);
  expect(result.trace).toBe("sign\nnotarize\n");
  expect(sourceEvents(result)).toStrictEqual([
    `desktop_notarize_api_env_source source=${source}`,
  ]);
  expectNoCredentialDisclosure(result);
}

function expectFailedBeforeExternalSideEffects(
  result: EntryPointResult,
  state: "absent" | "conflict" | "mixed" | "incomplete",
): void {
  expect(result.process.status === 1).toBe(true);
  expect(result.trace).toBe("");
  expect(sourceEvents(result)).toStrictEqual([]);
  expect(result.process.stderr.includes(`state=${state}`)).toBe(true);
  expectNoCredentialDisclosure(result);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Desktop Forge notarization entry point", () => {
  it.each([
    ["canonical-only", "canonical-only"],
    ["legacy-only", "legacy-only"],
    ["dual", "dual"],
  ] as const)(
    "uses one complete %s API credential set",
    (credentialCase, source) => {
      expectSuccessfulApiEntryPoint(
        runForge(credentialCase, { source }),
        source,
      );
    },
  );

  it.each([
    ["conflict", "conflict"],
    ["mixed", "mixed"],
    ["incomplete", "incomplete"],
  ] as const)(
    "rejects %s API credentials before signing",
    (credentialCase, state) => {
      expectFailedBeforeExternalSideEffects(runForge(credentialCase), state);
    },
  );

  it.each(["absent", "empty"] as const)(
    "keeps the default Keychain profile when API aliases are %s",
    (credentialCase) => {
      const result = runForge(credentialCase, {
        keychainMode: "default-keychain",
      });
      expect(result.process.status === 0).toBe(true);
      expect(result.trace).toBe("sign\nnotarize\n");
      expect(sourceEvents(result)).toStrictEqual([]);
    },
  );

  it("keeps a custom Keychain profile ahead of conflicting API aliases", () => {
    const result = runForge("conflict", {
      keychainMode: "custom-keychain",
    });
    expect(result.process.status === 0).toBe(true);
    expect(result.trace).toBe("sign\nnotarize\n");
    expect(sourceEvents(result)).toStrictEqual([]);
    expectNoCredentialDisclosure(result);
  });

  it("keeps notarization disabled unless the existing toggle is true", () => {
    const result = runForge("canonical-only", { notarize: false });
    expect(result.process.status === 0).toBe(true);
    expect(result.trace).toBe("sign\n");
    expect(sourceEvents(result)).toStrictEqual([]);
    expectNoCredentialDisclosure(result);
  });
});

describe("packaged Desktop signing and notarization entry point", () => {
  it.each([
    ["canonical-only", "canonical-only"],
    ["legacy-only", "legacy-only"],
    ["dual", "dual"],
  ] as const)(
    "uses one complete %s API credential set",
    (credentialCase, source) => {
      expectSuccessfulApiEntryPoint(
        runPackagedAppHelper(credentialCase),
        source,
      );
    },
  );

  it.each([
    ["conflict", "conflict"],
    ["mixed", "mixed"],
    ["incomplete", "incomplete"],
    ["absent", "absent"],
    ["empty", "absent"],
  ] as const)(
    "rejects %s API credentials before signing",
    (credentialCase, state) => {
      expectFailedBeforeExternalSideEffects(
        runPackagedAppHelper(credentialCase),
        state,
      );
    },
  );

  it("preserves packaged app-name validation before external side effects", () => {
    const result = runPackagedAppHelper("canonical-only", {
      appName: "Unexpected.app",
    });
    expect(result.process.status === 1).toBe(true);
    expect(result.trace).toBe("");
    expect(sourceEvents(result)).toStrictEqual([]);
    expect(
      result.process.stderr.includes(
        "Expected a Zero Computer Use.app directory",
      ),
    ).toBe(true);
    expectNoCredentialDisclosure(result);
  });

  it("preserves product validation before external side effects", () => {
    const result = runPackagedAppHelper("canonical-only", {
      product: "unexpected",
    });
    expect(result.process.status === 1).toBe(true);
    expect(result.trace).toBe("");
    expect(sourceEvents(result)).toStrictEqual([]);
    expect(
      result.process.stderr.includes(
        "Usage: sign-and-notarize-packaged-app.mjs",
      ),
    ).toBe(true);
    expectNoCredentialDisclosure(result);
  });
});
