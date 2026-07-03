import { createHash } from "node:crypto";

import {
  connectorCatalogActivePointerSchema,
  connectorCatalogManifestSchema,
  connectorCatalogPrivateArtifactSchema,
  connectorCatalogPublicArtifactSchema,
  isSupportedConnectorCatalogCapability,
  SUPPORTED_CONNECTOR_CATALOG_ACTIVE_SCHEMA_VERSION,
  SUPPORTED_CONNECTOR_CATALOG_ARTIFACT_SCHEMA_VERSION,
  type ConnectorCatalogActivePointer,
  type ConnectorCatalogManifest,
  type ConnectorCatalogPrivateArtifact,
  type ConnectorCatalogPublicArtifact,
  type ConnectorCatalogPublicArtifactPermission,
} from "./schemas";
import { safeJsonParse } from "../../utils";
import {
  assertPublicCatalogArtifactHasNoPrivateFields,
  privateCatalogArtifactSensitiveValues,
} from "./public-leak";

export const DEFAULT_CONNECTOR_CATALOG_ACTIVE_KEY = "active.json";

export interface ConnectorCatalogArtifactReader {
  readArtifact(key: string): Promise<Uint8Array>;
}

export interface ValidatedConnectorCatalogArtifacts {
  readonly active: ConnectorCatalogActivePointer;
  readonly manifest: ConnectorCatalogManifest;
  readonly publicArtifact: ConnectorCatalogPublicArtifact;
  readonly privateArtifact: ConnectorCatalogPrivateArtifact;
}

export function connectorCatalogArtifactDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function artifactBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

async function readArtifactBytes(
  reader: ConnectorCatalogArtifactReader,
  key: string,
): Promise<Buffer> {
  return artifactBuffer(await reader.readArtifact(key));
}

function parseJsonArtifact(key: string, bytes: Uint8Array): unknown {
  const parsed = safeJsonParse(artifactBuffer(bytes).toString("utf8"));
  if (parsed === undefined) {
    throw new Error(`Connector catalog artifact ${key} is not valid JSON`, {
      cause: new SyntaxError("Invalid JSON"),
    });
  }
  return parsed;
}

function assertDigest(args: {
  readonly key: string;
  readonly expectedDigest: string;
  readonly bytes: Uint8Array;
}): void {
  const actualDigest = connectorCatalogArtifactDigest(args.bytes);
  if (actualDigest !== args.expectedDigest) {
    throw new Error(
      `Connector catalog artifact ${args.key} digest mismatch: expected ${args.expectedDigest}, got ${actualDigest}`,
    );
  }
}

function assertActiveSchemaVersion(
  active: ConnectorCatalogActivePointer,
): void {
  if (
    active.schemaVersion !== SUPPORTED_CONNECTOR_CATALOG_ACTIVE_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported connector catalog active schema version: ${active.schemaVersion}`,
    );
  }
}

function assertArtifactSchemaVersion(version: number): void {
  if (version !== SUPPORTED_CONNECTOR_CATALOG_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported connector catalog artifact schema version: ${version}`,
    );
  }
}

function assertRequiredCapabilities(
  requiredCapabilities: readonly string[],
): void {
  const unsupported = requiredCapabilities.filter((capability) => {
    return !isSupportedConnectorCatalogCapability(capability);
  });
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported connector catalog capabilities: ${unsupported
        .sort()
        .join(", ")}`,
    );
  }
}

function assertCatalogVersionMatches(args: {
  readonly source: string;
  readonly expected: string;
  readonly actual: string;
}): void {
  if (args.actual !== args.expected) {
    throw new Error(
      `Connector catalog ${args.source} catalogVersion mismatch: expected ${args.expected}, got ${args.actual}`,
    );
  }
}

function assertUniqueValues(args: {
  readonly values: readonly string[];
  readonly label: string;
}): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of args.values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Duplicate connector catalog ${args.label}: ${[...duplicates]
        .sort()
        .join(", ")}`,
    );
  }
}

function sorted(values: Iterable<string>): string {
  return [...values].sort().join(", ");
}

function assertSameValues(args: {
  readonly expected: ReadonlySet<string>;
  readonly actual: ReadonlySet<string>;
  readonly label: string;
}): void {
  const missing = [...args.expected].filter((value) => {
    return !args.actual.has(value);
  });
  const unexpected = [...args.actual].filter((value) => {
    return !args.expected.has(value);
  });

  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Connector catalog ${args.label} mismatch: missing [${sorted(
        missing,
      )}], unexpected [${sorted(unexpected)}]`,
    );
  }
}

function hasPermissionOverrides(
  permission: ConnectorCatalogPublicArtifactPermission,
): boolean {
  return (
    permission.defaultPolicy.permissionOverrides !== undefined &&
    Object.values(permission.defaultPolicy.permissionOverrides).some(
      (permissions) => {
        return permissions.length > 0;
      },
    )
  );
}

function assertPermissionOverridesConsistency(
  permission: ConnectorCatalogPublicArtifactPermission,
  permissionNames: ReadonlySet<string>,
): void {
  const overrides = permission.defaultPolicy.permissionOverrides;
  if (!overrides) {
    return;
  }

  const overridePermissionNames = Object.values(overrides).flatMap(
    (permissions) => {
      return permissions ?? [];
    },
  );
  assertUniqueValues({
    values: overridePermissionNames,
    label: `${permission.connectorRef} default policy override permission names`,
  });

  for (const permissionName of overridePermissionNames) {
    if (!permissionNames.has(permissionName)) {
      throw new Error(
        `Connector catalog default policy override references unknown permission ${permission.connectorRef}/${permissionName}`,
      );
    }
  }
}

function assertPermissionSummaryConsistency(
  publicArtifact: ConnectorCatalogPublicArtifact,
): void {
  const permissionByConnectorRef = new Map(
    publicArtifact.permissions.map((permission) => {
      return [permission.connectorRef, permission];
    }),
  );

  for (const connector of publicArtifact.connectors) {
    const permission = permissionByConnectorRef.get(connector.connectorRef);
    const expectedSummary = permission
      ? {
          hasPermissions: true,
          permissionCount: permission.permissionCount,
          hasCategories: permission.categories !== null,
          hasDefaultPolicyOverrides: hasPermissionOverrides(permission),
        }
      : {
          hasPermissions: false,
          permissionCount: 0,
          hasCategories: false,
          hasDefaultPolicyOverrides: false,
        };

    if (
      connector.permissionSummary.hasPermissions !==
        expectedSummary.hasPermissions ||
      connector.permissionSummary.permissionCount !==
        expectedSummary.permissionCount ||
      connector.permissionSummary.hasCategories !==
        expectedSummary.hasCategories ||
      connector.permissionSummary.hasDefaultPolicyOverrides !==
        expectedSummary.hasDefaultPolicyOverrides
    ) {
      throw new Error(
        `Connector catalog permission summary mismatch for ${connector.connectorRef}`,
      );
    }
  }

  for (const permission of publicArtifact.permissions) {
    if (permission.permissionCount !== permission.permissions.length) {
      throw new Error(
        `Connector catalog permission count mismatch for ${permission.connectorRef}`,
      );
    }
    assertUniqueValues({
      values: permission.permissions.map((item) => {
        return item.name;
      }),
      label: `${permission.connectorRef} permission names`,
    });
    const permissionNames = new Set(
      permission.permissions.map((item) => {
        return item.name;
      }),
    );
    assertPermissionOverridesConsistency(permission, permissionNames);

    if (permission.categories) {
      assertSameValues({
        expected: permissionNames,
        actual: new Set(Object.keys(permission.categories.categories)),
        label: `${permission.connectorRef} permission category permission names`,
      });
      assertUniqueValues({
        values: permission.categories.displayOrder,
        label: `${permission.connectorRef} permission category display order`,
      });
      const categoryValues = new Set(
        Object.values(permission.categories.categories),
      );
      assertSameValues({
        expected: categoryValues,
        actual: new Set(permission.categories.displayOrder),
        label: `${permission.connectorRef} permission category display order`,
      });
    }
  }
}

function assertAuthMethodShape(args: {
  readonly connectorRef: string;
  readonly authMethod: ConnectorCatalogPublicArtifact["connectors"][number]["authMethods"][number];
}): void {
  if (
    args.authMethod.grantKind !== "manual" &&
    args.authMethod.manualFields.length > 0
  ) {
    throw new Error(
      `Connector catalog auth method ${args.connectorRef}/${args.authMethod.id} has manual fields for ${args.authMethod.grantKind} grant`,
    );
  }
  if (
    args.authMethod.grantKind !== "device-auth" &&
    args.authMethod.startOptions.length > 0
  ) {
    throw new Error(
      `Connector catalog auth method ${args.connectorRef}/${args.authMethod.id} has start options for ${args.authMethod.grantKind} grant`,
    );
  }
}

function assertPublicArtifactConsistency(
  publicArtifact: ConnectorCatalogPublicArtifact,
): void {
  assertUniqueValues({
    values: publicArtifact.connectors.map((connector) => {
      return connector.connectorRef;
    }),
    label: "public connector refs",
  });
  assertUniqueValues({
    values: publicArtifact.permissions.map((permission) => {
      return permission.connectorRef;
    }),
    label: "permission connector refs",
  });

  const connectorRefs = new Set(
    publicArtifact.connectors.map((connector) => {
      return connector.connectorRef;
    }),
  );
  for (const permission of publicArtifact.permissions) {
    if (!connectorRefs.has(permission.connectorRef)) {
      throw new Error(
        `Permission metadata references unknown connector ${permission.connectorRef}`,
      );
    }
  }
  assertPermissionSummaryConsistency(publicArtifact);

  for (const connector of publicArtifact.connectors) {
    assertUniqueValues({
      values: connector.authMethods.map((authMethod) => {
        return authMethod.id;
      }),
      label: `${connector.connectorRef} auth method ids`,
    });
    for (const authMethod of connector.authMethods) {
      assertAuthMethodShape({
        connectorRef: connector.connectorRef,
        authMethod,
      });
      assertUniqueValues({
        values: authMethod.manualFields.map((field) => {
          return field.id;
        }),
        label: `${connector.connectorRef}/${authMethod.id} manual field ids`,
      });
      assertUniqueValues({
        values: authMethod.startOptions.map((option) => {
          return option.id;
        }),
        label: `${connector.connectorRef}/${authMethod.id} start option ids`,
      });
    }
  }
}

function assertPrivateArtifactConsistency(args: {
  readonly publicArtifact: ConnectorCatalogPublicArtifact;
  readonly privateArtifact: ConnectorCatalogPrivateArtifact;
}): void {
  const publicConnectorByRef = new Map(
    args.publicArtifact.connectors.map((connector) => {
      return [connector.connectorRef, connector];
    }),
  );

  assertUniqueValues({
    values: args.privateArtifact.connectors.map((connector) => {
      return connector.connectorRef;
    }),
    label: "private connector refs",
  });
  assertSameValues({
    expected: new Set(publicConnectorByRef.keys()),
    actual: new Set(
      args.privateArtifact.connectors.map((connector) => {
        return connector.connectorRef;
      }),
    ),
    label: "private connector refs",
  });

  for (const privateConnector of args.privateArtifact.connectors) {
    const publicConnector = publicConnectorByRef.get(
      privateConnector.connectorRef,
    );
    if (!publicConnector) {
      throw new Error(
        `Private artifact references unknown connector ${privateConnector.connectorRef}`,
      );
    }

    const publicAuthMethodById = new Map(
      publicConnector.authMethods.map((authMethod) => {
        return [authMethod.id, authMethod];
      }),
    );
    assertUniqueValues({
      values: privateConnector.authMethods.map((authMethod) => {
        return authMethod.id;
      }),
      label: `${privateConnector.connectorRef} private auth method ids`,
    });
    assertSameValues({
      expected: new Set(publicAuthMethodById.keys()),
      actual: new Set(
        privateConnector.authMethods.map((authMethod) => {
          return authMethod.id;
        }),
      ),
      label: `${privateConnector.connectorRef} private auth method ids`,
    });

    for (const privateAuthMethod of privateConnector.authMethods) {
      const publicAuthMethod = publicAuthMethodById.get(privateAuthMethod.id);
      if (!publicAuthMethod) {
        throw new Error(
          `Private artifact references unknown auth method ${privateConnector.connectorRef}/${privateAuthMethod.id}`,
        );
      }

      const publicManualFieldIds = new Set(
        publicAuthMethod.manualFields.map((field) => {
          return field.id;
        }),
      );
      const publicStartOptionIds = new Set(
        publicAuthMethod.startOptions.map((option) => {
          return option.id;
        }),
      );
      assertUniqueValues({
        values: privateAuthMethod.manualFieldMappings.map((mapping) => {
          return mapping.publicId;
        }),
        label: `${privateConnector.connectorRef}/${privateAuthMethod.id} private manual field public ids`,
      });
      assertUniqueValues({
        values: privateAuthMethod.startOptionMappings.map((mapping) => {
          return mapping.publicId;
        }),
        label: `${privateConnector.connectorRef}/${privateAuthMethod.id} private start option public ids`,
      });
      assertSameValues({
        expected: publicManualFieldIds,
        actual: new Set(
          privateAuthMethod.manualFieldMappings.map((mapping) => {
            return mapping.publicId;
          }),
        ),
        label: `${privateConnector.connectorRef}/${privateAuthMethod.id} private manual field public ids`,
      });
      assertSameValues({
        expected: publicStartOptionIds,
        actual: new Set(
          privateAuthMethod.startOptionMappings.map((mapping) => {
            return mapping.publicId;
          }),
        ),
        label: `${privateConnector.connectorRef}/${privateAuthMethod.id} private start option public ids`,
      });

      for (const mapping of privateAuthMethod.manualFieldMappings) {
        if (!publicManualFieldIds.has(mapping.publicId)) {
          throw new Error(
            `Private manual field mapping references unknown public id ${privateConnector.connectorRef}/${privateAuthMethod.id}/${mapping.publicId}`,
          );
        }
      }
      for (const mapping of privateAuthMethod.startOptionMappings) {
        if (!publicStartOptionIds.has(mapping.publicId)) {
          throw new Error(
            `Private start option mapping references unknown public id ${privateConnector.connectorRef}/${privateAuthMethod.id}/${mapping.publicId}`,
          );
        }
      }
    }
  }
}

export async function loadConnectorCatalogArtifacts(args: {
  readonly reader: ConnectorCatalogArtifactReader;
  readonly activeKey?: string;
}): Promise<ValidatedConnectorCatalogArtifacts> {
  const activeKey = args.activeKey ?? DEFAULT_CONNECTOR_CATALOG_ACTIVE_KEY;
  const activeBytes = await readArtifactBytes(args.reader, activeKey);
  const active = connectorCatalogActivePointerSchema.parse(
    parseJsonArtifact(activeKey, activeBytes),
  );
  assertActiveSchemaVersion(active);

  const manifestBytes = await readArtifactBytes(
    args.reader,
    active.manifestKey,
  );
  assertDigest({
    key: active.manifestKey,
    expectedDigest: active.manifestDigest,
    bytes: manifestBytes,
  });
  const manifest = connectorCatalogManifestSchema.parse(
    parseJsonArtifact(active.manifestKey, manifestBytes),
  );
  assertCatalogVersionMatches({
    source: "manifest",
    expected: active.catalogVersion,
    actual: manifest.catalogVersion,
  });
  assertArtifactSchemaVersion(manifest.artifactSchemaVersion);
  assertRequiredCapabilities(manifest.requiredCapabilities);

  const [publicBytes, privateBytes] = await Promise.all([
    readArtifactBytes(args.reader, manifest.artifacts.public.key),
    readArtifactBytes(args.reader, manifest.artifacts.private.key),
  ]);
  assertDigest({
    key: manifest.artifacts.public.key,
    expectedDigest: manifest.artifacts.public.digest,
    bytes: publicBytes,
  });
  assertDigest({
    key: manifest.artifacts.private.key,
    expectedDigest: manifest.artifacts.private.digest,
    bytes: privateBytes,
  });

  const publicArtifact = connectorCatalogPublicArtifactSchema.parse(
    parseJsonArtifact(manifest.artifacts.public.key, publicBytes),
  );
  const privateArtifact = connectorCatalogPrivateArtifactSchema.parse(
    parseJsonArtifact(manifest.artifacts.private.key, privateBytes),
  );
  assertArtifactSchemaVersion(publicArtifact.artifactSchemaVersion);
  assertArtifactSchemaVersion(privateArtifact.artifactSchemaVersion);
  assertCatalogVersionMatches({
    source: "public artifact",
    expected: manifest.catalogVersion,
    actual: publicArtifact.catalogVersion,
  });
  assertCatalogVersionMatches({
    source: "private artifact",
    expected: manifest.catalogVersion,
    actual: privateArtifact.catalogVersion,
  });
  assertPublicArtifactConsistency(publicArtifact);
  assertPrivateArtifactConsistency({ publicArtifact, privateArtifact });
  assertPublicCatalogArtifactHasNoPrivateFields(
    publicArtifact,
    privateCatalogArtifactSensitiveValues(privateArtifact),
  );

  return {
    active,
    manifest,
    publicArtifact,
    privateArtifact,
  };
}
