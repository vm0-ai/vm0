import { describe, expect, it } from "vitest";

import {
  CONNECTOR_CATALOG_FIXTURE_KEYS,
  connectorCatalogArtifactDigest,
  createFixtureConnectorCatalogArtifactReader,
  getPublicConnectorCatalogDetailFromArtifact,
  getPublicConnectorCatalogPermissionDetailFromArtifact,
  listPublicConnectorCatalogFromArtifact,
  loadConnectorCatalogArtifacts,
  loadFixtureConnectorCatalogArtifacts,
  type ConnectorCatalogArtifactReader,
} from "../connector-catalog-artifacts";
import {
  connectorCatalogActivePointerSchema,
  connectorCatalogManifestSchema,
  connectorCatalogPrivateArtifactSchema,
  connectorCatalogPublicArtifactSchema,
  type ConnectorCatalogActivePointer,
  type ConnectorCatalogManifest,
  type ConnectorCatalogPrivateArtifact,
  type ConnectorCatalogPublicArtifact,
} from "../connector-catalog-artifacts/schemas";

const ACTIVE_KEY = "active.json";
const MANIFEST_KEY = "manifest.json";
const PUBLIC_ARTIFACT_KEY = "public/catalog.json";
const PRIVATE_ARTIFACT_KEY = "private/runtime.json";

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function requiredBytes(
  records: ReadonlyMap<string, Uint8Array>,
  key: string,
): Uint8Array {
  const bytes = records.get(key);
  if (!bytes) {
    throw new Error(`Missing fixture record ${key}`);
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
}

function activeFromRecords(
  records: ReadonlyMap<string, Uint8Array>,
): ConnectorCatalogActivePointer {
  return connectorCatalogActivePointerSchema.parse(
    parseJson(requiredBytes(records, ACTIVE_KEY)),
  );
}

function manifestFromRecords(
  records: ReadonlyMap<string, Uint8Array>,
): ConnectorCatalogManifest {
  return connectorCatalogManifestSchema.parse(
    parseJson(requiredBytes(records, MANIFEST_KEY)),
  );
}

function publicArtifactFromRecords(
  records: ReadonlyMap<string, Uint8Array>,
): ConnectorCatalogPublicArtifact {
  return connectorCatalogPublicArtifactSchema.parse(
    parseJson(requiredBytes(records, PUBLIC_ARTIFACT_KEY)),
  );
}

function privateArtifactFromRecords(
  records: ReadonlyMap<string, Uint8Array>,
): ConnectorCatalogPrivateArtifact {
  return connectorCatalogPrivateArtifactSchema.parse(
    parseJson(requiredBytes(records, PRIVATE_ARTIFACT_KEY)),
  );
}

function cloneRecords(
  records: ReadonlyMap<string, Uint8Array>,
): Map<string, Uint8Array> {
  return new Map(
    [...records].map(([key, bytes]) => {
      return [key, Buffer.from(bytes)] as const;
    }),
  );
}

function readerFromRecords(
  records: ReadonlyMap<string, Uint8Array>,
): ConnectorCatalogArtifactReader {
  return {
    readArtifact(key: string): Promise<Uint8Array> {
      return Promise.resolve(Buffer.from(requiredBytes(records, key)));
    },
  };
}

async function fixtureRecords(): Promise<Map<string, Uint8Array>> {
  const reader = createFixtureConnectorCatalogArtifactReader();
  const records = new Map<string, Uint8Array>();
  for (const key of CONNECTOR_CATALOG_FIXTURE_KEYS) {
    records.set(key, await reader.readArtifact(key));
  }
  return records;
}

function recordsWithManifest(
  records: ReadonlyMap<string, Uint8Array>,
  manifest: ConnectorCatalogManifest,
): Map<string, Uint8Array> {
  const nextRecords = cloneRecords(records);
  const manifestBytes = jsonBytes(manifest);
  const active = activeFromRecords(nextRecords);
  nextRecords.set(MANIFEST_KEY, manifestBytes);
  nextRecords.set(
    ACTIVE_KEY,
    jsonBytes({
      ...active,
      manifestDigest: connectorCatalogArtifactDigest(manifestBytes),
    }),
  );
  return nextRecords;
}

function recordsWithActive(
  records: ReadonlyMap<string, Uint8Array>,
  active: ConnectorCatalogActivePointer,
): Map<string, Uint8Array> {
  const nextRecords = cloneRecords(records);
  nextRecords.set(ACTIVE_KEY, jsonBytes(active));
  return nextRecords;
}

function recordsWithPublicArtifact(
  records: ReadonlyMap<string, Uint8Array>,
  publicArtifact: ConnectorCatalogPublicArtifact,
): Map<string, Uint8Array> {
  const nextRecords = cloneRecords(records);
  const publicBytes = jsonBytes(publicArtifact);
  const manifest = manifestFromRecords(nextRecords);
  nextRecords.set(PUBLIC_ARTIFACT_KEY, publicBytes);
  return recordsWithManifest(nextRecords, {
    ...manifest,
    artifacts: {
      ...manifest.artifacts,
      public: {
        ...manifest.artifacts.public,
        digest: connectorCatalogArtifactDigest(publicBytes),
      },
    },
  });
}

function recordsWithPrivateArtifact(
  records: ReadonlyMap<string, Uint8Array>,
  privateArtifact: ConnectorCatalogPrivateArtifact,
): Map<string, Uint8Array> {
  const nextRecords = cloneRecords(records);
  const privateBytes = jsonBytes(privateArtifact);
  const manifest = manifestFromRecords(nextRecords);
  nextRecords.set(PRIVATE_ARTIFACT_KEY, privateBytes);
  return recordsWithManifest(nextRecords, {
    ...manifest,
    artifacts: {
      ...manifest.artifacts,
      private: {
        ...manifest.artifacts.private,
        digest: connectorCatalogArtifactDigest(privateBytes),
      },
    },
  });
}

function fixtureManualConnector(
  publicArtifact: ConnectorCatalogPublicArtifact,
): ConnectorCatalogPublicArtifact["connectors"][number] {
  const connector = publicArtifact.connectors.find((item) => {
    return item.connectorRef === "fixture-manual";
  });
  if (!connector) {
    throw new Error("Missing fixture manual connector");
  }
  return connector;
}

function fixtureManualAuthMethod(
  publicArtifact: ConnectorCatalogPublicArtifact,
): ConnectorCatalogPublicArtifact["connectors"][number]["authMethods"][number] {
  const authMethod = fixtureManualConnector(publicArtifact).authMethods.find(
    (item) => {
      return item.id === "api-token";
    },
  );
  if (!authMethod) {
    throw new Error("Missing fixture manual auth method");
  }
  return authMethod;
}

function fixtureDeviceAuthMethod(
  publicArtifact: ConnectorCatalogPublicArtifact,
): ConnectorCatalogPublicArtifact["connectors"][number]["authMethods"][number] {
  const connector = publicArtifact.connectors.find((item) => {
    return item.connectorRef === "fixture-device";
  });
  const authMethod = connector?.authMethods.find((item) => {
    return item.id === "device";
  });
  if (!authMethod) {
    throw new Error("Missing fixture device auth method");
  }
  return authMethod;
}

describe("connector catalog artifacts", () => {
  it("loads the fixture artifact set and converts public view models", async () => {
    const artifacts = await loadFixtureConnectorCatalogArtifacts();

    expect(artifacts.active.catalogVersion).toBe("fixture-2026-07-03.1");
    expect(artifacts.manifest.requiredCapabilities).toContain(
      "catalog.public-connectors@1",
    );

    const list = listPublicConnectorCatalogFromArtifact(
      artifacts.publicArtifact,
    );
    expect(list).toStrictEqual([
      {
        connectorRef: "fixture-manual",
        label: "Fixture Manual",
        description: "Manual fixture connector",
        category: "Development",
        generation: ["text"],
        tags: ["fixture", "manual"],
        authMethods: [
          {
            id: "api-token",
            label: "API Token",
            description: "Connect with an API token.",
            grantKind: "manual",
          },
        ],
        permissionSummary: {
          hasPermissions: true,
          permissionCount: 2,
          hasCategories: true,
          hasDefaultPolicyOverrides: true,
        },
      },
      {
        connectorRef: "fixture-oauth",
        label: "Fixture OAuth",
        description: "OAuth fixture connector",
        category: "Development",
        generation: ["text"],
        tags: ["fixture", "oauth"],
        authMethods: [
          {
            id: "oauth",
            label: "OAuth",
            description: "Connect with OAuth.",
            grantKind: "auth-code",
          },
        ],
        permissionSummary: {
          hasPermissions: false,
          permissionCount: 0,
          hasCategories: false,
          hasDefaultPolicyOverrides: false,
        },
      },
      {
        connectorRef: "fixture-device",
        label: "Fixture Device",
        description: "Device-auth fixture connector",
        category: "Development",
        generation: ["text"],
        tags: ["fixture", "device"],
        authMethods: [
          {
            id: "device",
            label: "Device Code",
            description: "Connect with a device code.",
            grantKind: "device-auth",
          },
        ],
        permissionSummary: {
          hasPermissions: false,
          permissionCount: 0,
          hasCategories: false,
          hasDefaultPolicyOverrides: false,
        },
      },
    ]);

    expect(
      getPublicConnectorCatalogDetailFromArtifact(
        artifacts.publicArtifact,
        "fixture-manual",
      )?.authMethods[0]?.manualFields,
    ).toStrictEqual([
      {
        id: "apiKey",
        label: "API Key",
        required: true,
        placeholder: "key-...",
        inputType: "password",
      },
    ]);
    expect(
      getPublicConnectorCatalogPermissionDetailFromArtifact(
        artifacts.publicArtifact,
        "fixture-manual",
      )?.permissions,
    ).toStrictEqual([
      {
        name: "files.read",
        description: "Read fixture files",
      },
      {
        name: "files.write",
        description: "Write fixture files",
      },
    ]);
    expect(
      getPublicConnectorCatalogPermissionDetailFromArtifact(
        artifacts.publicArtifact,
        "fixture-manual",
      )?.categories,
    ).toStrictEqual({
      categories: {
        "files.read": "Files",
        "files.write": "Files",
      },
      displayOrder: ["Files"],
    });
  });

  it("rejects a fixture key that escapes the fixture root", async () => {
    const reader = createFixtureConnectorCatalogArtifactReader();

    await expect(reader.readArtifact("../manifest.json")).rejects.toThrow(
      "Artifact keys must be relative object keys",
    );
  });

  it.each(["../active.json", "./active.json", ".", "private/"])(
    "rejects invalid active artifact key %s before reading",
    async (activeKey) => {
      await expect(
        loadConnectorCatalogArtifacts({
          reader: readerFromRecords(new Map()),
          activeKey,
        }),
      ).rejects.toThrow("Artifact keys must be relative object keys");
    },
  );

  it("allows relative artifact keys with non-traversal dot substrings", async () => {
    const records = await fixtureRecords();
    const manifest = manifestFromRecords(records);
    const publicBytes = requiredBytes(records, PUBLIC_ARTIFACT_KEY);
    const recordsWithDottedKey = cloneRecords(records);
    recordsWithDottedKey.set("public/catalog..v1.json", publicBytes);

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithManifest(recordsWithDottedKey, {
            ...manifest,
            artifacts: {
              ...manifest.artifacts,
              public: {
                ...manifest.artifacts.public,
                key: "public/catalog..v1.json",
              },
            },
          }),
        ),
      }),
    ).resolves.toMatchObject({
      publicArtifact: {
        catalogVersion: "fixture-2026-07-03.1",
      },
    });
  });

  it("rejects invalid referenced artifact keys", async () => {
    const records = await fixtureRecords();
    const manifest = manifestFromRecords(records);

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithManifest(records, {
            ...manifest,
            artifacts: {
              ...manifest.artifacts,
              public: {
                ...manifest.artifacts.public,
                key: "./public/catalog.json",
              },
            },
          }),
        ),
      }),
    ).rejects.toThrow("Artifact keys must be relative object keys");
  });

  it("verifies artifact digests before parsing JSON", async () => {
    const records = await fixtureRecords();
    const tamperedPublicBytes = Buffer.from(
      requiredBytes(records, PUBLIC_ARTIFACT_KEY),
    );
    tamperedPublicBytes[0] = "{".charCodeAt(0) + 1;
    const tamperedRecords = cloneRecords(records);
    tamperedRecords.set(PUBLIC_ARTIFACT_KEY, tamperedPublicBytes);

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(tamperedRecords),
      }),
    ).rejects.toThrow("public/catalog.json digest mismatch");
  });

  it("rejects manifest and private artifact digest mismatches", async () => {
    const records = await fixtureRecords();
    const manifest = manifestFromRecords(records);
    const manifestBytes = jsonBytes({
      ...manifest,
      requiredCapabilities: [],
    });
    const privateBytes = Buffer.from(
      requiredBytes(records, PRIVATE_ARTIFACT_KEY),
    );
    privateBytes[0] = "{".charCodeAt(0) + 1;

    const manifestDigestMismatchRecords = cloneRecords(records);
    manifestDigestMismatchRecords.set(MANIFEST_KEY, manifestBytes);

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(manifestDigestMismatchRecords),
      }),
    ).rejects.toThrow("manifest.json digest mismatch");

    const privateDigestMismatchRecords = cloneRecords(records);
    privateDigestMismatchRecords.set(PRIVATE_ARTIFACT_KEY, privateBytes);

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(privateDigestMismatchRecords),
      }),
    ).rejects.toThrow("private/runtime.json digest mismatch");
  });

  it("rejects unsupported active and artifact schema versions", async () => {
    const records = await fixtureRecords();
    const active = activeFromRecords(records);
    const manifest = manifestFromRecords(records);

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithActive(records, {
            ...active,
            schemaVersion: 2,
          }),
        ),
      }),
    ).rejects.toThrow("Unsupported connector catalog active schema version: 2");

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithManifest(records, {
            ...manifest,
            artifactSchemaVersion: 2,
          }),
        ),
      }),
    ).rejects.toThrow(
      "Unsupported connector catalog artifact schema version: 2",
    );
  });

  it("rejects unsupported required capabilities", async () => {
    const records = await fixtureRecords();
    const manifest = manifestFromRecords(records);

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithManifest(records, {
            ...manifest,
            requiredCapabilities: [
              ...manifest.requiredCapabilities,
              "catalog.future@99",
            ],
          }),
        ),
      }),
    ).rejects.toThrow(
      "Unsupported connector catalog capabilities: catalog.future@99",
    );
  });

  it("rejects duplicate required capabilities", async () => {
    const records = await fixtureRecords();
    const manifest = manifestFromRecords(records);

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithManifest(records, {
            ...manifest,
            requiredCapabilities: [
              ...manifest.requiredCapabilities,
              manifest.requiredCapabilities[0] ?? "catalog.public-connectors@1",
            ],
          }),
        ),
      }),
    ).rejects.toThrow(
      "Duplicate connector catalog required capabilities: catalog.public-connectors@1",
    );
  });

  it("rejects public artifacts that leak private runtime names", async () => {
    const records = await fixtureRecords();
    const publicArtifact = publicArtifactFromRecords(records);
    const field = fixtureManualAuthMethod(publicArtifact).manualFields[0];
    if (!field) {
      throw new Error("Missing fixture manual field");
    }
    field.placeholder = "FIXTURE_MANUAL_API_TOKEN";

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPublicArtifact(records, publicArtifact),
        ),
      }),
    ).rejects.toThrow("Public connector catalog artifact leaked private value");
    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPublicArtifact(records, publicArtifact),
        ),
      }),
    ).rejects.not.toThrow("FIXTURE_MANUAL_API_TOKEN");
  });

  it("rejects public artifacts that leak private runtime artifact keys", async () => {
    const records = await fixtureRecords();
    const publicArtifact = publicArtifactFromRecords(records);
    fixtureManualConnector(publicArtifact).description =
      "Runtime schema: private/fixture-manual/runtime.json";

    const privateArtifact = privateArtifactFromRecords(records);
    const privateConnector = privateArtifact.connectors.find((item) => {
      return item.connectorRef === "fixture-manual";
    });
    if (!privateConnector) {
      throw new Error("Missing fixture private connector");
    }
    privateConnector.runtimeArtifactRefs = [
      {
        kind: "runtime-schema",
        key: "private/fixture-manual/runtime.json",
        digest:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
    ];

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPrivateArtifact(
            recordsWithPublicArtifact(records, publicArtifact),
            privateArtifact,
          ),
        ),
      }),
    ).rejects.toThrow("Public connector catalog artifact leaked private value");
    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPrivateArtifact(
            recordsWithPublicArtifact(records, publicArtifact),
            privateArtifact,
          ),
        ),
      }),
    ).rejects.not.toThrow("private/fixture-manual/runtime.json");
  });

  it("rejects public permission summary drift", async () => {
    const records = await fixtureRecords();
    const publicArtifact = publicArtifactFromRecords(records);
    fixtureManualConnector(publicArtifact).permissionSummary.permissionCount =
      1;

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPublicArtifact(records, publicArtifact),
        ),
      }),
    ).rejects.toThrow(
      "Connector catalog permission summary mismatch for fixture-manual",
    );
  });

  it("allows permission detail entries with zero permissions", async () => {
    const records = await fixtureRecords();
    const publicArtifact = publicArtifactFromRecords(records);
    publicArtifact.permissions.push({
      connectorRef: "fixture-oauth",
      label: "Fixture OAuth",
      permissionCount: 0,
      permissions: [],
      categories: null,
      defaultPolicy: {
        permissionDefault: "allow",
        unknownPolicy: "allow",
      },
    });

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPublicArtifact(records, publicArtifact),
        ),
      }),
    ).resolves.toMatchObject({
      publicArtifact: {
        permissions: [
          {
            connectorRef: "fixture-manual",
          },
          {
            connectorRef: "fixture-oauth",
            permissionCount: 0,
          },
        ],
      },
    });
  });

  it("allows forbidden-looking permission names inside category maps", async () => {
    const records = await fixtureRecords();
    const publicArtifact = publicArtifactFromRecords(records);
    const permission = publicArtifact.permissions[0];
    if (!permission?.categories) {
      throw new Error("Missing fixture permission categories");
    }
    const readPermission = permission.permissions.find((item) => {
      return item.name === "files.read";
    });
    if (!readPermission) {
      throw new Error("Missing fixture read permission");
    }

    readPermission.name = "storage";
    readPermission.description = "Read storage fixtures";
    permission.categories.categories = {
      storage: "Storage",
      "files.write": "Files",
    };
    permission.categories.displayOrder = ["Files", "Storage"];
    permission.defaultPolicy.permissionOverrides = {
      allow: ["storage"],
    };

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPublicArtifact(records, publicArtifact),
        ),
      }),
    ).resolves.toMatchObject({
      publicArtifact: {
        permissions: [
          {
            permissions: [
              {
                name: "storage",
                description: "Read storage fixtures",
              },
              {
                name: "files.write",
              },
            ],
          },
        ],
      },
    });
  });

  it("rejects invalid permission categories and default policy overrides", async () => {
    const records = await fixtureRecords();
    const categoryDriftArtifact = publicArtifactFromRecords(records);
    const categoryDriftPermission = categoryDriftArtifact.permissions[0];
    if (!categoryDriftPermission?.categories) {
      throw new Error("Missing fixture permission categories");
    }
    categoryDriftPermission.categories.displayOrder = ["Unknown"];

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPublicArtifact(records, categoryDriftArtifact),
        ),
      }),
    ).rejects.toThrow(
      "fixture-manual permission category display order mismatch",
    );

    const emptyCategoryArtifact = publicArtifactFromRecords(records);
    emptyCategoryArtifact.permissions.push({
      connectorRef: "fixture-oauth",
      label: "Fixture OAuth",
      permissionCount: 0,
      permissions: [],
      categories: {
        categories: {},
        displayOrder: [],
      },
      defaultPolicy: {
        permissionDefault: "allow",
        unknownPolicy: "allow",
      },
    });
    const oauthConnector = emptyCategoryArtifact.connectors.find((item) => {
      return item.connectorRef === "fixture-oauth";
    });
    if (!oauthConnector) {
      throw new Error("Missing fixture OAuth connector");
    }
    oauthConnector.permissionSummary.hasCategories = true;

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPublicArtifact(records, emptyCategoryArtifact),
        ),
      }),
    ).rejects.toThrow(
      "permission categories require permissions for fixture-oauth",
    );

    const overrideDriftArtifact = publicArtifactFromRecords(records);
    const overrideDriftPermission = overrideDriftArtifact.permissions[0];
    if (!overrideDriftPermission) {
      throw new Error("Missing fixture permission metadata");
    }
    overrideDriftPermission.defaultPolicy.permissionOverrides = {
      allow: ["files.read", "files.delete"],
    };

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPublicArtifact(records, overrideDriftArtifact),
        ),
      }),
    ).rejects.toThrow(
      "default policy override references unknown permission fixture-manual/files.delete",
    );
  });

  it("rejects auth method fields that do not match the grant kind", async () => {
    const records = await fixtureRecords();
    const publicArtifact = publicArtifactFromRecords(records);
    const oauthConnector = publicArtifact.connectors.find((item) => {
      return item.connectorRef === "fixture-oauth";
    });
    const oauthAuthMethod = oauthConnector?.authMethods[0];
    if (!oauthAuthMethod) {
      throw new Error("Missing fixture OAuth auth method");
    }
    oauthAuthMethod.manualFields = [
      {
        id: "apiKey",
        label: "API Key",
        required: true,
        placeholder: null,
        inputType: "password",
      },
    ];

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPublicArtifact(records, publicArtifact),
        ),
      }),
    ).rejects.toThrow(
      "fixture-oauth/oauth has manual fields for auth-code grant",
    );
  });

  it("rejects invalid auth method ids", async () => {
    const records = await fixtureRecords();
    const publicArtifact = publicArtifactFromRecords(records);
    fixtureManualAuthMethod(publicArtifact).id = "api/token";

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPublicArtifact(records, publicArtifact),
        ),
      }),
    ).rejects.toThrow();
  });

  it("rejects invalid device start option choices", async () => {
    const records = await fixtureRecords();
    const emptyOptionsArtifact = publicArtifactFromRecords(records);
    const emptyOptionsAuthMethod =
      fixtureDeviceAuthMethod(emptyOptionsArtifact);
    const emptyOptionsStartOption = emptyOptionsAuthMethod.startOptions[0];
    if (!emptyOptionsStartOption) {
      throw new Error("Missing fixture device start option");
    }
    emptyOptionsStartOption.options = [];

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPublicArtifact(records, emptyOptionsArtifact),
        ),
      }),
    ).rejects.toThrow();

    const duplicateOptionsArtifact = publicArtifactFromRecords(records);
    const duplicateOptionsAuthMethod = fixtureDeviceAuthMethod(
      duplicateOptionsArtifact,
    );
    const duplicateOptionsStartOption =
      duplicateOptionsAuthMethod.startOptions[0];
    const duplicateOption = duplicateOptionsStartOption?.options[0];
    if (!duplicateOptionsStartOption || !duplicateOption) {
      throw new Error("Missing fixture device start option choice");
    }
    duplicateOptionsStartOption.options.push({
      ...duplicateOption,
      label: "Duplicate Test",
    });

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPublicArtifact(records, duplicateOptionsArtifact),
        ),
      }),
    ).rejects.toThrow(
      "Duplicate connector catalog fixture-device/device/mode start option values: test",
    );

    const invalidDefaultArtifact = publicArtifactFromRecords(records);
    const invalidDefaultAuthMethod = fixtureDeviceAuthMethod(
      invalidDefaultArtifact,
    );
    const invalidDefaultStartOption = invalidDefaultAuthMethod.startOptions[0];
    if (!invalidDefaultStartOption) {
      throw new Error("Missing fixture device start option");
    }
    invalidDefaultStartOption.defaultValue = "missing";

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPublicArtifact(records, invalidDefaultArtifact),
        ),
      }),
    ).rejects.toThrow(
      "Connector catalog auth method fixture-device/device start option mode defaultValue is not an option",
    );
  });

  it("rejects private field mapping drift from public manual fields", async () => {
    const records = await fixtureRecords();
    const privateArtifact = privateArtifactFromRecords(records);
    const connector = privateArtifact.connectors.find((item) => {
      return item.connectorRef === "fixture-manual";
    });
    const authMethod = connector?.authMethods.find((item) => {
      return item.id === "api-token";
    });
    if (!authMethod) {
      throw new Error("Missing fixture private auth method");
    }
    authMethod.manualFieldMappings = [];

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPrivateArtifact(records, privateArtifact),
        ),
      }),
    ).rejects.toThrow(
      "fixture-manual/api-token private manual field public ids mismatch",
    );
  });

  it("rejects duplicate private mapping names within an auth method", async () => {
    const records = await fixtureRecords();
    const publicArtifact = publicArtifactFromRecords(records);
    const manualAuthMethod = fixtureManualAuthMethod(publicArtifact);
    manualAuthMethod.manualFields.push({
      id: "secondaryApiKey",
      label: "Secondary API Key",
      required: true,
      placeholder: null,
      inputType: "password",
    });

    const privateArtifact = privateArtifactFromRecords(records);
    const privateConnector = privateArtifact.connectors.find((item) => {
      return item.connectorRef === "fixture-manual";
    });
    const privateAuthMethod = privateConnector?.authMethods.find((item) => {
      return item.id === "api-token";
    });
    const privateMapping = privateAuthMethod?.manualFieldMappings[0];
    if (!privateAuthMethod || !privateMapping) {
      throw new Error("Missing fixture private manual field mapping");
    }
    privateAuthMethod.manualFieldMappings.push({
      ...privateMapping,
      publicId: "secondaryApiKey",
    });

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPrivateArtifact(
            recordsWithPublicArtifact(records, publicArtifact),
            privateArtifact,
          ),
        ),
      }),
    ).rejects.toThrow(
      "Duplicate connector catalog fixture-manual/api-token private manual field private names",
    );

    privateAuthMethod.manualFieldMappings[1] = {
      ...privateMapping,
      publicId: "secondaryApiKey",
      privateName: "FIXTURE_MANUAL_SECONDARY_API_TOKEN",
    };

    await expect(
      loadConnectorCatalogArtifacts({
        reader: readerFromRecords(
          recordsWithPrivateArtifact(
            recordsWithPublicArtifact(records, publicArtifact),
            privateArtifact,
          ),
        ),
      }),
    ).rejects.toThrow(
      "Duplicate connector catalog fixture-manual/api-token private manual field runtime names",
    );
  });
});
