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
const retiredAliases = {
  keyPath: "VM0_DESKTOP_NOTARIZE_API_KEY_PATH",
  keyId: "VM0_DESKTOP_NOTARIZE_API_KEY_ID",
  issuer: "VM0_DESKTOP_NOTARIZE_API_ISSUER",
} as const;
const credentialAliases = [
  ...Object.values(canonicalAliases),
  ...Object.values(retiredAliases),
];
const canonicalKeychainAliases = {
  profile: "OKOU_DESKTOP_NOTARIZE_KEYCHAIN_PROFILE",
  path: "OKOU_DESKTOP_NOTARIZE_KEYCHAIN",
} as const;
const canonicalSigningIdentityAlias = "OKOU_DESKTOP_SIGNING_IDENTITY";
const legacySigningIdentityAlias = "VM0_DESKTOP_SIGNING_IDENTITY";
const developerIdApplicationIdentity =
  "Developer ID Application: Max & Zoe, Inc. (C5UWSXYB67)";

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
  const signingOptionsAreUnchanged =
    options.app === process.env.TEST_EXPECTED_APP_PATH &&
    options.batchCodesignCalls === true &&
    options.identity === process.env.TEST_EXPECTED_SIGNING_IDENTITY &&
    options.identityValidation ===
      (process.env.TEST_EXPECTED_IDENTITY_VALIDATION === "true") &&
    options.platform === "darwin" &&
    options.timestamp ===
      (process.env.TEST_EXPECTED_SIGNING_TIMESTAMP === "none"
        ? "none"
        : undefined) &&
    options.version === process.env.TEST_EXPECTED_ELECTRON_VERSION;
  if (!signingOptionsAreUnchanged) {
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
    credentialsAreUnchanged =
      options.appleApiKey ===
        process.env.OKOU_DESKTOP_NOTARIZE_API_KEY_PATH &&
      options.appleApiKeyId ===
        process.env.OKOU_DESKTOP_NOTARIZE_API_KEY_ID &&
      options.appleApiIssuer ===
        process.env.OKOU_DESKTOP_NOTARIZE_API_ISSUER &&
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
        process.env.TEST_EXPECTED_KEYCHAIN_PROFILE &&
      options.keychain === process.env.TEST_EXPECTED_KEYCHAIN &&
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
  | "canonical-and-retired"
  | "retired-only"
  | IncompleteCredentialCase;

const incompleteCredentialCases = [
  "key-path-only",
  "key-id-only",
  "issuer-only",
  "without-key-path",
  "without-key-id",
  "without-issuer",
] as const;
type IncompleteCredentialCase = (typeof incompleteCredentialCases)[number];

interface SigningIdentityInput {
  readonly canonical?: string;
  readonly legacy?: string;
}

interface KeychainEnvironmentInput {
  readonly canonicalProfile?: string;
  readonly canonicalPath?: string;
}

interface CredentialValues {
  readonly keyPath: string;
  readonly keyId: string;
  readonly issuer: string;
}

const incompleteCredentialFields: Readonly<
  Record<IncompleteCredentialCase, readonly (keyof CredentialValues)[]>
> = {
  "key-path-only": ["keyPath"],
  "key-id-only": ["keyId"],
  "issuer-only": ["issuer"],
  "without-key-path": ["keyId", "issuer"],
  "without-key-id": ["keyPath", "issuer"],
  "without-issuer": ["keyPath", "keyId"],
};

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
  readonly sensitiveValues: readonly string[];
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
  aliases: typeof canonicalAliases | typeof retiredAliases,
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
    for (const alias of credentialAliases) {
      environment[alias] = "";
    }
    return [];
  }

  const canonical = credentialValues(directory);
  const retired = credentialValues(directory);
  if (credentialCase === "canonical-only") {
    assignCredentialValues(environment, canonicalAliases, canonical);
  } else if (credentialCase === "canonical-and-retired") {
    assignCredentialValues(environment, canonicalAliases, canonical);
    assignCredentialValues(environment, retiredAliases, retired);
  } else if (credentialCase === "retired-only") {
    assignCredentialValues(environment, retiredAliases, retired);
  } else {
    for (const field of incompleteCredentialFields[credentialCase]) {
      environment[canonicalAliases[field]] = canonical[field];
    }
  }

  return credentialAliases.flatMap((alias) => {
    const value = environment[alias];
    return value ? [value] : [];
  });
}

function applySigningIdentityInput(
  environment: NodeJS.ProcessEnv,
  input: SigningIdentityInput,
): readonly string[] {
  if (input.canonical !== undefined) {
    environment[canonicalSigningIdentityAlias] = input.canonical;
  }
  if (input.legacy !== undefined) {
    environment[legacySigningIdentityAlias] = input.legacy;
  }
  return [input.canonical, input.legacy].filter((value): value is string =>
    Boolean(value),
  );
}

function applyKeychainEnvironmentInput(
  environment: NodeJS.ProcessEnv,
  input: KeychainEnvironmentInput,
): readonly string[] {
  const valuesByAlias = [
    [canonicalKeychainAliases.profile, input.canonicalProfile],
    [canonicalKeychainAliases.path, input.canonicalPath],
  ] as const;
  for (const [alias, value] of valuesByAlias) {
    if (value !== undefined) {
      environment[alias] = value;
    }
  }
  return valuesByAlias.flatMap(([, value]) =>
    value?.trim() ? [value.trim()] : [],
  );
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
    readonly keychainMode?: "default-keychain" | "custom-keychain";
    readonly keychainInput?: KeychainEnvironmentInput;
    readonly expectedKeychainProfile?: string;
    readonly expectedKeychain?: string;
    readonly signingIdentity?: SigningIdentityInput;
    readonly ci?: boolean;
  } = {},
): EntryPointResult {
  const harness = createTestHarness();
  const outputPath = join(harness.directory, "forge-output");
  const appPath = join(outputPath, "Zero Computer Use.app");
  mkdirSync(appPath, { recursive: true });
  const environment = baseEnvironment(harness);
  if (options.ci === false) {
    delete environment.CI;
  }
  environment.TEST_EXPECTED_APP_PATH = appPath;
  environment.TEST_OUTPUT_PATH = outputPath;
  if (options.notarize !== false) {
    environment.OKOU_DESKTOP_NOTARIZE = "true";
  }
  const credentialValues = applyCredentialCase(
    environment,
    harness.directory,
    credentialCase,
  );
  const defaultCustomKeychainProfile = randomUUID();
  const keychainInput: KeychainEnvironmentInput =
    options.keychainInput ??
    (options.keychainMode === "custom-keychain"
      ? { canonicalProfile: defaultCustomKeychainProfile }
      : {});
  const keychainValues = applyKeychainEnvironmentInput(
    environment,
    keychainInput,
  );
  const signingIdentity = options.signingIdentity ?? {};
  const signingIdentityValues = applySigningIdentityInput(
    environment,
    signingIdentity,
  );
  const expectedSigningIdentity =
    signingIdentity.canonical ??
    (environment.CI === "true" ? "-" : developerIdApplicationIdentity);
  environment.TEST_EXPECTED_SIGNING_IDENTITY = expectedSigningIdentity;
  environment.TEST_EXPECTED_IDENTITY_VALIDATION =
    expectedSigningIdentity === "-" ? "false" : "true";
  environment.TEST_EXPECTED_SIGNING_TIMESTAMP =
    expectedSigningIdentity === "-" ? "none" : "absent";
  if (
    credentialCase === "canonical-only" ||
    credentialCase === "canonical-and-retired"
  ) {
    environment.TEST_NOTARIZE_MODE = "api";
  }
  if (options.keychainMode) {
    environment.TEST_NOTARIZE_MODE = options.keychainMode;
  }
  if (options.keychainMode === "custom-keychain") {
    environment.TEST_EXPECTED_KEYCHAIN_PROFILE =
      options.expectedKeychainProfile ??
      keychainInput.canonicalProfile ??
      defaultCustomKeychainProfile;
    environment.TEST_EXPECTED_KEYCHAIN =
      options.expectedKeychain ?? environment.TEST_EXPECTED_DEFAULT_KEYCHAIN;
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
    sensitiveValues: [
      ...credentialValues,
      ...keychainValues,
      ...signingIdentityValues,
    ],
  };
}

function runPackagedAppHelper(
  credentialCase: CredentialCase,
  options: {
    readonly appName?: string;
    readonly product?: string;
    readonly signingIdentity?: SigningIdentityInput;
  } = {},
): EntryPointResult {
  const harness = createTestHarness();
  const appPath = join(
    harness.directory,
    options.appName ?? "Zero Computer Use.app",
  );
  mkdirSync(appPath, { recursive: true });
  const environment = baseEnvironment(harness);
  environment.TEST_EXPECTED_APP_PATH = appPath;
  environment.TEST_NOTARIZE_MODE = "api";
  const credentialValues = applyCredentialCase(
    environment,
    harness.directory,
    credentialCase,
  );
  const signingIdentity = options.signingIdentity ?? {
    canonical: ` ${randomUUID()} `,
  };
  const signingIdentityValues = applySigningIdentityInput(
    environment,
    signingIdentity,
  );
  const expectedSigningIdentity = signingIdentity.canonical;
  if (expectedSigningIdentity !== undefined) {
    environment.TEST_EXPECTED_SIGNING_IDENTITY = expectedSigningIdentity;
  }
  environment.TEST_EXPECTED_IDENTITY_VALIDATION = "true";
  environment.TEST_EXPECTED_SIGNING_TIMESTAMP = "absent";

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
    sensitiveValues: [...credentialValues, ...signingIdentityValues],
  };
}

function expectNoSensitiveValueDisclosure(result: EntryPointResult): void {
  const output = result.process.stdout + result.process.stderr;
  for (const value of result.sensitiveValues) {
    expect(output.includes(value)).toBe(false);
  }
  expect(output.includes("length=")).toBe(false);
}

function expectSuccessfulApiEntryPoint(result: EntryPointResult): void {
  expect(result.process.status === 0).toBe(true);
  expect(result.trace).toBe("sign\nnotarize\n");
  expectNoSensitiveValueDisclosure(result);
}

function expectFailedBeforeExternalSideEffects(
  result: EntryPointResult,
  state: "absent" | "incomplete",
): void {
  expect(result.process.status === 1).toBe(true);
  expect(result.trace).toBe("");
  expect(result.process.stderr).toContain(
    state === "absent"
      ? "Desktop notarization API environment is required: state=absent"
      : "Desktop notarization API credentials are incomplete: state=incomplete",
  );
  expectNoSensitiveValueDisclosure(result);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Desktop Forge notarization entry point", () => {
  const precedenceProfile = ` precedence-profile-${randomUUID()} `;

  it("uses one complete canonical API credential set byte-for-byte", () => {
    expectSuccessfulApiEntryPoint(runForge("canonical-only"));
  });

  it("keeps canonical credentials authoritative over hostile retired values", () => {
    expectSuccessfulApiEntryPoint(runForge("canonical-and-retired"));
  });

  it.each(incompleteCredentialCases)(
    "rejects the incomplete canonical %s shape before signing",
    (credentialCase) => {
      expectFailedBeforeExternalSideEffects(
        runForge(credentialCase),
        "incomplete",
      );
    },
  );

  it.each(["absent", "empty", "retired-only"] as const)(
    "keeps the default Keychain profile when API credentials are %s",
    (credentialCase) => {
      const result = runForge(credentialCase, {
        keychainMode: "default-keychain",
      });
      expect(result.process.status === 0).toBe(true);
      expect(result.trace).toBe("sign\nnotarize\n");
      expectNoSensitiveValueDisclosure(result);
    },
  );

  it.each([
    ["canonical and retired API credentials", "canonical-and-retired"],
    ["retired-only API credentials", "retired-only"],
    ["incomplete canonical API credentials", "key-path-only"],
  ] as const)(
    "keeps a custom Keychain profile ahead of %s",
    (_, credentialCase) => {
      const result = runForge(credentialCase, {
        keychainMode: "custom-keychain",
        keychainInput: { canonicalProfile: precedenceProfile },
        expectedKeychainProfile: precedenceProfile,
      });
      expect(result.process.status === 0).toBe(true);
      expect(result.trace).toBe("sign\nnotarize\n");
      expectNoSensitiveValueDisclosure(result);
    },
  );

  it("keeps notarization disabled unless the existing toggle is true", () => {
    const result = runForge("canonical-only", {
      notarize: false,
      keychainInput: {
        canonicalProfile: randomUUID(),
      },
    });
    expect(result.process.status === 0).toBe(true);
    expect(result.trace).toBe("sign\n");
    expectNoSensitiveValueDisclosure(result);
  });
});

describe("Desktop Forge Keychain notarization environment entry point", () => {
  const sharedProfile = ` profile-${randomUUID()} `;
  const sharedPath = ` /tmp/keychain-${randomUUID()} `;
  const canonicalPath = `/tmp/canonical-keychain-${randomUUID()}`;

  it("passes the canonical profile through byte-for-byte", () => {
    const result = runForge("absent", {
      keychainMode: "custom-keychain",
      keychainInput: { canonicalProfile: sharedProfile },
      expectedKeychainProfile: sharedProfile,
    });

    expect(result.process.status, result.process.stderr).toBe(0);
    expect(result.trace).toBe("sign\nnotarize\n");
    expectNoSensitiveValueDisclosure(result);
  });

  it.each([
    ["absent", { canonicalPath }],
    [
      "empty",
      {
        canonicalProfile: "",
        canonicalPath,
      },
    ],
    [
      "whitespace-only",
      {
        canonicalProfile: " \t ",
        canonicalPath,
      },
    ],
  ] as const)(
    "ignores the canonical path when the canonical profile is %s",
    (_, keychainInput) => {
      const result = runForge("absent", {
        keychainMode: "default-keychain",
        keychainInput,
      });

      expect(result.process.status, result.process.stderr).toBe(0);
      expect(result.trace).toBe("sign\nnotarize\n");
      expectNoSensitiveValueDisclosure(result);
    },
  );

  it.each([
    ["absent", {}],
    ["empty", { canonicalPath: "" }],
    ["whitespace-only", { canonicalPath: " \t " }],
  ] as const)(
    "uses the default path when selected-profile paths are %s",
    (_, pathInput) => {
      const result = runForge("absent", {
        keychainMode: "custom-keychain",
        keychainInput: {
          canonicalProfile: sharedProfile,
          ...pathInput,
        },
        expectedKeychainProfile: sharedProfile,
      });

      expect(result.process.status, result.process.stderr).toBe(0);
      expect(result.trace).toBe("sign\nnotarize\n");
      expectNoSensitiveValueDisclosure(result);
    },
  );

  it("trims the selected canonical path before use", () => {
    const result = runForge("absent", {
      keychainMode: "custom-keychain",
      keychainInput: {
        canonicalProfile: sharedProfile,
        canonicalPath: sharedPath,
      },
      expectedKeychainProfile: sharedProfile,
      expectedKeychain: sharedPath.trim(),
    });

    expect(result.process.status, result.process.stderr).toBe(0);
    expect(result.trace).toBe("sign\nnotarize\n");
    expectNoSensitiveValueDisclosure(result);
  });

  it("ignores a path without a profile when API mode is selected", () => {
    const result = runForge("canonical-only", {
      keychainInput: { canonicalPath },
    });

    expectSuccessfulApiEntryPoint(result);
  });
});

describe("Desktop Forge signing identity entry point", () => {
  const canonicalIdentity = ` ${randomUUID()} `;
  const hostileRetiredIdentity = `retired-${randomUUID()}`;

  it("passes the canonical identity through unchanged", () => {
    const result = runForge("absent", {
      notarize: false,
      signingIdentity: { canonical: canonicalIdentity },
    });

    expect(result.process.status, result.process.stderr).toBe(0);
    expect(result.trace).toBe("sign\n");
    expectNoSensitiveValueDisclosure(result);
  });

  it("does not replace an explicit-empty canonical identity", () => {
    const result = runForge("absent", {
      notarize: false,
      signingIdentity: { canonical: "" },
    });

    expect(result.process.status, result.process.stderr).toBe(0);
    expect(result.trace).toBe("sign\n");
    expectNoSensitiveValueDisclosure(result);
  });

  it.each([
    ["CI", true],
    ["local", false],
  ] as const)(
    "keeps the existing %s fallback when both aliases are absent",
    (_, ci) => {
      const result = runForge("absent", {
        ci,
        notarize: false,
        signingIdentity: {},
      });

      expect(result.process.status, result.process.stderr).toBe(0);
      expect(result.trace).toBe("sign\n");
      expectNoSensitiveValueDisclosure(result);
    },
  );

  it("treats retired-only input as absent", () => {
    const result = runForge("absent", {
      notarize: false,
      signingIdentity: { legacy: hostileRetiredIdentity },
    });

    expect(result.process.status, result.process.stderr).toBe(0);
    expect(result.trace).toBe("sign\n");
    expectNoSensitiveValueDisclosure(result);
  });

  it("uses the canonical identity unchanged with hostile retired input", () => {
    const result = runForge("absent", {
      notarize: false,
      signingIdentity: {
        canonical: canonicalIdentity,
        legacy: hostileRetiredIdentity,
      },
    });

    expect(result.process.status, result.process.stderr).toBe(0);
    expect(result.trace).toBe("sign\n");
    expectNoSensitiveValueDisclosure(result);
  });
});

describe("packaged Desktop signing and notarization entry point", () => {
  it("uses one complete canonical API credential set byte-for-byte", () => {
    expectSuccessfulApiEntryPoint(runPackagedAppHelper("canonical-only"));
  });

  it("keeps canonical credentials authoritative over hostile retired values", () => {
    expectSuccessfulApiEntryPoint(
      runPackagedAppHelper("canonical-and-retired"),
    );
  });

  it.each(incompleteCredentialCases)(
    "rejects the incomplete canonical %s shape before signing",
    (credentialCase) => {
      expectFailedBeforeExternalSideEffects(
        runPackagedAppHelper(credentialCase),
        "incomplete",
      );
    },
  );

  it.each(["absent", "empty", "retired-only"] as const)(
    "rejects %s API credentials before signing",
    (credentialCase) => {
      expectFailedBeforeExternalSideEffects(
        runPackagedAppHelper(credentialCase),
        "absent",
      );
    },
  );

  it("preserves packaged app-name validation before external side effects", () => {
    const result = runPackagedAppHelper("canonical-only", {
      appName: "Unexpected.app",
    });
    expect(result.process.status === 1).toBe(true);
    expect(result.trace).toBe("");
    expect(
      result.process.stderr.includes(
        "Expected a Zero Computer Use.app directory",
      ),
    ).toBe(true);
    expectNoSensitiveValueDisclosure(result);
  });

  it("preserves product validation before external side effects", () => {
    const result = runPackagedAppHelper("canonical-only", {
      product: "unexpected",
    });
    expect(result.process.status === 1).toBe(true);
    expect(result.trace).toBe("");
    expect(
      result.process.stderr.includes(
        "Usage: sign-and-notarize-packaged-app.mjs",
      ),
    ).toBe(true);
    expectNoSensitiveValueDisclosure(result);
  });
});

describe("packaged Desktop signing identity entry point", () => {
  const canonicalIdentity = ` ${randomUUID()} `;
  const hostileRetiredIdentity = `retired-${randomUUID()}`;

  it.each([
    ["canonical-only", { canonical: canonicalIdentity }],
    [
      "canonical with hostile retired input",
      {
        canonical: canonicalIdentity,
        legacy: hostileRetiredIdentity,
      },
    ],
  ] as const)("passes the %s identity through unchanged", (_, input) => {
    const result = runPackagedAppHelper("canonical-only", {
      signingIdentity: input,
    });

    expectSuccessfulApiEntryPoint(result);
  });

  it.each([
    ["absent", {}],
    ["retired-only", { legacy: hostileRetiredIdentity }],
  ] as const)(
    "keeps the required-variable failure for %s canonical input",
    (_, input) => {
      const result = runPackagedAppHelper("canonical-only", {
        signingIdentity: input,
      });

      expect(result.process.status).toBe(1);
      expect(result.trace).toBe("");
      expect(result.process.stderr).toContain(
        "OKOU_DESKTOP_SIGNING_IDENTITY is required",
      );
      expectNoSensitiveValueDisclosure(result);
    },
  );

  it("keeps the required-variable failure for an explicit-empty canonical identity", () => {
    const result = runPackagedAppHelper("canonical-only", {
      signingIdentity: {
        canonical: "",
        legacy: hostileRetiredIdentity,
      },
    });

    expect(result.process.status).toBe(1);
    expect(result.trace).toBe("");
    expect(result.process.stderr).toContain(
      "OKOU_DESKTOP_SIGNING_IDENTITY is required",
    );
    expectNoSensitiveValueDisclosure(result);
  });
});
