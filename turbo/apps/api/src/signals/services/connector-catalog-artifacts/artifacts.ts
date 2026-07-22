import { z } from "zod";
import {
  artifactKeySchema,
  connectorRefSchema,
  connectorCatalogVersionSchema,
  digestSchema,
  privateNameSchema,
} from "./common";
import {
  firewallAuthSchema,
  firewallCategoriesSchema,
  firewallConfigSchema,
  firewallHostPolicySchema,
  firewallPermissionSchema,
  firewallPolicyValueSchema,
} from "./firewall";
import {
  catalogSourceSchema,
  connectorAuthMethodIdSchema,
  connectorAuthMethodSourceSchema,
  connectorFeatureSwitchKeySchema,
  connectorStaticIconPathSchema,
  connectorValueRefSchema,
  internalOptionNameSchema,
  publicFieldIdSchema,
} from "./source";

export { connectorCatalogVersionSchema } from "./common";

export const SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION = 1;
export const CONNECTOR_CATALOG_ACTIVE_KEY = `connectors/v${SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION}/active.json`;

interface ConnectorCatalogReleaseArtifactKeys {
  readonly releasePrefix: string;
  readonly publicCatalog: string;
  readonly privateCatalog: string;
  readonly privateFirewalls: string;
  readonly runnerFirewalls: string;
  readonly integrityCatalog: string;
}

export function connectorCatalogReleaseArtifactKeys(
  catalogVersion: string,
): ConnectorCatalogReleaseArtifactKeys {
  const parsedCatalogVersion =
    connectorCatalogVersionSchema.parse(catalogVersion);
  const releasePrefix =
    `connectors/v${SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION}/releases/` +
    parsedCatalogVersion;
  return {
    releasePrefix,
    publicCatalog: `${releasePrefix}/public/catalog.json`,
    privateCatalog: `${releasePrefix}/private/catalog.json`,
    privateFirewalls: `${releasePrefix}/private/firewalls.json`,
    runnerFirewalls: `${releasePrefix}/runner/firewalls.json`,
    integrityCatalog: `${releasePrefix}/integrity/catalog.json`,
  };
}

// These schema-v1 limits mirror vm0-connectors output. Changing them requires
// a new connector catalog artifact schema generation in both repositories.
const CONNECTOR_SKILL_MAX_FILES = 64;
const CONNECTOR_SKILL_MAX_FILE_BYTES = 512 * 1024;
export const CONNECTOR_SKILL_MAX_TOTAL_BYTES = 1024 * 1024;
const CONNECTOR_SKILL_MAX_PATH_BYTES = 512;
const CONNECTOR_SKILL_STORAGE_NAME_PREFIX = "connector-skill@";
export const CONNECTOR_SKILL_STORAGE_PATH_PREFIX = "__system__/volume";

const artifactHeaderShape = Object.freeze({
  artifactSchemaVersion: z.literal(SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION),
  catalogVersion: connectorCatalogVersionSchema,
});

const artifactReferenceSchema = z
  .object({
    key: artifactKeySchema,
    digest: digestSchema,
  })
  .strict();

const publicConnectorIconKeySchema = connectorStaticIconPathSchema;

const publicConnectorIconReferenceSchema = artifactReferenceSchema.extend({
  key: publicConnectorIconKeySchema,
});

const connectorSkillStorageNameSchema = z
  .string()
  .max(256)
  .regex(/^connector-skill@[a-z0-9][a-z0-9-]*$/u);

const privateSkillManifestReferenceSchema = artifactReferenceSchema.refine(
  (reference) => {
    return /^__system__\/volume\/connector-skill@[a-z0-9][a-z0-9-]*\/[a-f0-9]{64}\/manifest\.json$/u.test(
      reference.key,
    );
  },
  "Skill manifest key must use its final system volume path",
);

const privateSkillArchiveReferenceSchema = artifactReferenceSchema.refine(
  (reference) => {
    return /^__system__\/volume\/connector-skill@[a-z0-9][a-z0-9-]*\/[a-f0-9]{64}\/archive\.tar\.gz$/u.test(
      reference.key,
    );
  },
  "Skill archive key must use its final system volume path",
);

const connectorSkillVersionIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const connectorSkillFilePathSchema = artifactKeySchema
  .refine(
    (filePath) => {
      return filePath === filePath.normalize("NFC");
    },
    {
      message: "Skill file paths must use NFC normalization",
    },
  )
  .refine(
    (filePath) => {
      return !Array.from(filePath).some((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
        );
      });
    },
    { message: "Skill file paths must not contain control characters" },
  )
  .refine(
    (filePath) => {
      return (
        Buffer.byteLength(filePath, "utf8") <= CONNECTOR_SKILL_MAX_PATH_BYTES
      );
    },
    {
      message: `Skill file paths must not exceed ${CONNECTOR_SKILL_MAX_PATH_BYTES} UTF-8 bytes`,
    },
  );

export const connectorSkillManifestSchema = z
  .object({
    version: z.literal(1),
    files: z
      .array(
        z
          .object({
            path: connectorSkillFilePathSchema,
            hash: z.string().regex(/^[a-f0-9]{64}$/u),
            size: z
              .number()
              .int()
              .nonnegative()
              .max(CONNECTOR_SKILL_MAX_FILE_BYTES),
          })
          .strict(),
      )
      .min(1)
      .max(CONNECTOR_SKILL_MAX_FILES),
    createdAt: z.literal("1970-01-01T00:00:00.000Z"),
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = manifest.files.map((file) => {
      return file.path;
    });
    const sortedPaths = [...paths].sort(compareStrings);
    if (
      paths.some((filePath, index) => {
        return filePath !== sortedPaths[index];
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Skill manifest files must be alphabetical",
        path: ["files"],
      });
    }
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        message: "Skill manifest file paths must be unique",
        path: ["files"],
      });
    }
    if (
      new Set(
        paths.map((filePath) => {
          return filePath.toLowerCase();
        }),
      ).size !== paths.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Skill manifest file paths must not collide by case",
        path: ["files"],
      });
    }
    if (!paths.includes("SKILL.md")) {
      context.addIssue({
        code: "custom",
        message: "Skill manifest requires root SKILL.md",
        path: ["files"],
      });
    }
    const totalSize = manifest.files.reduce((total, file) => {
      return total + file.size;
    }, 0);
    if (totalSize > CONNECTOR_SKILL_MAX_TOTAL_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Skill manifest files must not exceed ${CONNECTOR_SKILL_MAX_TOTAL_BYTES} total bytes`,
        path: ["files"],
      });
    }
  });

const connectorSkillFrontmatterSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
  })
  .strict();

const publicManualFieldSchema = z
  .object({
    id: publicFieldIdSchema,
    label: z.string().min(1),
    required: z.boolean(),
    placeholder: z.string().nullable(),
    inputType: z.enum(["password", "text"]),
  })
  .strict();

const publicStartOptionChoiceSchema = z
  .object({
    value: z.string().min(1),
    label: z.string().min(1),
  })
  .strict();

const publicStartOptionSchema = z
  .object({
    id: publicFieldIdSchema,
    kind: z.literal("select"),
    label: z.string().min(1),
    required: z.boolean(),
    defaultValue: z.string().nullable(),
    options: z.array(publicStartOptionChoiceSchema).min(1),
  })
  .strict();

const publicAuthMethodSchema = z
  .object({
    id: connectorAuthMethodIdSchema,
    label: z.string().min(1),
    description: z.string().min(1).nullable(),
    visible: z.boolean(),
    featureSwitch: connectorFeatureSwitchKeySchema.nullable(),
    grantKind: z.enum([
      "manual",
      "auth-code",
      "openid-auth",
      "external-code",
      "device-auth",
    ]),
    manualFields: z.array(publicManualFieldSchema),
    startOptions: z.array(publicStartOptionSchema),
  })
  .strict();

const publicConnectorCatalogIconSchema = z
  .object({
    asset: publicConnectorIconReferenceSchema,
    contentType: z.enum(["image/svg+xml", "image/png"]),
    invertInDarkMode: z.boolean(),
    scale: z.number().min(1).max(3).optional(),
  })
  .strict()
  .superRefine((icon, context) => {
    const expectedSuffix = icon.contentType === "image/png" ? ".png" : ".svg";
    const digestHex = icon.asset.digest.slice("sha256:".length);
    const keyDigest = /-([a-f0-9]{12})\.(?:png|svg)$/u.exec(
      icon.asset.key,
    )?.[1];
    if (
      !icon.asset.key.endsWith(expectedSuffix) ||
      keyDigest === undefined ||
      !digestHex.startsWith(keyDigest)
    ) {
      context.addIssue({
        code: "custom",
        message: "Icon key must match its digest prefix and media type",
        path: ["asset", "key"],
      });
    }
  });

const publicFirewallPermissionSchema = firewallPermissionSchema
  .omit({ rules: true })
  .strict();

const publicFirewallMetadataSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("generated"),
      permissions: z.array(publicFirewallPermissionSchema),
      categories: firewallCategoriesSchema.nullable(),
      defaultAllowed: z.array(z.string().min(1)).nullable(),
      defaultUnknownPolicy: firewallPolicyValueSchema,
    })
    .strict(),
]);

const publicConnectorCatalogArtifactConnectorSchema = z
  .object({
    connectorRef: connectorRefSchema,
    label: z.string().min(1),
    description: z.string().min(1),
    category: z.string().min(1),
    generation: z.array(z.string().min(1)),
    tags: z.array(z.string().min(1)),
    authMethods: z.array(publicAuthMethodSchema).min(1),
    icon: publicConnectorCatalogIconSchema,
    firewall: publicFirewallMetadataSchema,
  })
  .strict();

export const connectorCatalogPublicArtifactSchema = z
  .object({
    ...artifactHeaderShape,
    categoryMetadata: catalogSourceSchema.shape.categoryMetadata,
    connectors: z.array(publicConnectorCatalogArtifactConnectorSchema).min(1),
  })
  .strict();

const privateOutputBindingsSchema = z.record(
  z.string().min(1),
  connectorValueRefSchema,
);

const privateGrantSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("manual"),
      fields: z.array(
        z
          .object({
            privateName: privateNameSchema,
            publicId: publicFieldIdSchema,
            storage: z.enum(["secret", "variable"]),
            normalize: z.literal("host").optional(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("auth-code"),
      scopes: z.array(z.string()),
      callbackOrigin: z.enum(["web", "api"]),
      outputs: privateOutputBindingsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("openid-auth"),
      callbackOrigin: z.enum(["web", "api"]),
      outputs: privateOutputBindingsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("external-code"),
      scopes: z.array(z.string()),
      outputs: privateOutputBindingsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("device-auth"),
      scopes: z.array(z.string()),
      outputs: privateOutputBindingsSchema,
      startOptionMappings: z.array(
        z
          .object({
            privateName: internalOptionNameSchema,
            publicId: publicFieldIdSchema,
          })
          .strict(),
      ),
    })
    .strict(),
]);

const privateAuthMethodSchema = z
  .object({
    id: connectorAuthMethodSourceSchema.shape.id,
    client: connectorAuthMethodSourceSchema.shape.client,
    storage: connectorAuthMethodSourceSchema.shape.storage,
    grant: privateGrantSchema,
    access: connectorAuthMethodSourceSchema.shape.access,
    revoke: connectorAuthMethodSourceSchema.shape.revoke,
  })
  .strict();

const privateConnectorSkillSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("bundled"),
      storageName: connectorSkillStorageNameSchema,
      versionId: connectorSkillVersionIdSchema,
      frontmatter: connectorSkillFrontmatterSchema,
      manifest: privateSkillManifestReferenceSchema,
      archive: privateSkillArchiveReferenceSchema,
    })
    .strict(),
]);

const privateConnectorCatalogArtifactConnectorSchema = z
  .object({
    connectorRef: connectorRefSchema,
    skill: privateConnectorSkillSchema,
    authMethods: z.array(privateAuthMethodSchema).min(1),
  })
  .strict()
  .superRefine((connector, context) => {
    if (connector.skill.kind === "none") {
      return;
    }
    const expectedStorageName = `${CONNECTOR_SKILL_STORAGE_NAME_PREFIX}${connector.connectorRef}`;
    if (connector.skill.storageName !== expectedStorageName) {
      context.addIssue({
        code: "custom",
        message: "Skill storage name must match connector ref",
        path: ["skill", "storageName"],
      });
    }
    const prefix =
      `${CONNECTOR_SKILL_STORAGE_PATH_PREFIX}/${expectedStorageName}/` +
      `${connector.skill.versionId}/`;
    if (connector.skill.manifest.key !== `${prefix}manifest.json`) {
      context.addIssue({
        code: "custom",
        message: "Skill manifest key must match storage name and version id",
        path: ["skill", "manifest", "key"],
      });
    }
    if (connector.skill.archive.key !== `${prefix}archive.tar.gz`) {
      context.addIssue({
        code: "custom",
        message: "Skill archive key must match storage name and version id",
        path: ["skill", "archive", "key"],
      });
    }
  });

export const connectorCatalogPrivateArtifactSchema = z
  .object({
    ...artifactHeaderShape,
    connectors: z.array(privateConnectorCatalogArtifactConnectorSchema).min(1),
  })
  .strict();

const firewallExecutionBaseTemplateSchema = z
  .object({
    base: z.string().min(1),
    credentialed: z.boolean(),
    hostPolicy: firewallHostPolicySchema.optional(),
  })
  .strict();

const firewallRoutingRouteSchema = z
  .object({
    permissionName: z.string().min(1),
    rule: z.string().min(1),
  })
  .strict();

const firewallRoutingApiSchema = z
  .object({
    base: z.string().min(1),
    environmentNames: z.array(privateNameSchema),
    routes: z.array(firewallRoutingRouteSchema),
  })
  .strict();

const firewallRoutingSchema = z
  .object({
    fixedHosts: z.array(z.string().min(1)),
    baseUrlVarNames: z.array(privateNameSchema),
    baseUrlTemplates: z.array(firewallExecutionBaseTemplateSchema),
    apis: z.array(firewallRoutingApiSchema).min(1),
  })
  .strict();

const firewallDiagnosticsSchema = z
  .object({
    apiCount: z.number().int().positive(),
    permissionCount: z.number().int().nonnegative(),
    ruleCount: z.number().int().nonnegative(),
  })
  .strict();

const privateFirewallArtifactConnectorSchema = z
  .object({
    connectorRef: connectorRefSchema,
    label: z.string().min(1),
    billable: z.boolean(),
    firewall: firewallConfigSchema,
    categories: firewallCategoriesSchema.nullable(),
    defaultAllowed: z.array(z.string().min(1)).nullable(),
    defaultUnknownPolicy: firewallPolicyValueSchema,
    routing: firewallRoutingSchema,
    diagnostics: firewallDiagnosticsSchema,
  })
  .strict();

export const connectorCatalogPrivateFirewallsArtifactSchema = z
  .object({
    ...artifactHeaderShape,
    connectors: z.array(privateFirewallArtifactConnectorSchema),
  })
  .strict();

const runnerFirewallPermissionSchema = firewallPermissionSchema
  .omit({ description: true })
  .strict();

const runnerFirewallApiSchema = z
  .object({
    base: z.string().min(1),
    hostPolicy: firewallHostPolicySchema.optional(),
    auth: firewallAuthSchema,
    permissions: z.array(runnerFirewallPermissionSchema),
  })
  .strict();

const runnerFirewallArtifactConnectorSchema = z
  .object({
    name: connectorRefSchema,
    apis: z.array(runnerFirewallApiSchema).min(1),
  })
  .strict();

export const connectorCatalogRunnerFirewallsArtifactSchema = z
  .object({
    ...artifactHeaderShape,
    firewalls: z.array(runnerFirewallArtifactConnectorSchema),
  })
  .strict();

export const connectorCatalogIntegrityArtifactSchema = z
  .object({
    ...artifactHeaderShape,
    artifacts: z
      .object({
        publicCatalog: digestSchema,
        privateCatalog: digestSchema,
        privateFirewalls: digestSchema,
        runnerFirewalls: digestSchema,
      })
      .strict(),
  })
  .strict();

export type ConnectorCatalogPublicArtifact = z.infer<
  typeof connectorCatalogPublicArtifactSchema
>;
type ConnectorCatalogPublicArtifactConnector = z.infer<
  typeof publicConnectorCatalogArtifactConnectorSchema
>;
export type ConnectorCatalogPrivateArtifact = z.infer<
  typeof connectorCatalogPrivateArtifactSchema
>;
type ConnectorCatalogPrivateArtifactConnector = z.infer<
  typeof privateConnectorCatalogArtifactConnectorSchema
>;
export type ConnectorCatalogPrivateFirewallsArtifact = z.infer<
  typeof connectorCatalogPrivateFirewallsArtifactSchema
>;
type PrivateFirewallArtifactConnector = z.infer<
  typeof privateFirewallArtifactConnectorSchema
>;
export type ConnectorCatalogRunnerFirewallsArtifact = z.infer<
  typeof connectorCatalogRunnerFirewallsArtifactSchema
>;
type RunnerFirewallArtifactConnector = z.infer<
  typeof runnerFirewallArtifactConnectorSchema
>;
export type ConnectorCatalogIntegrityArtifact = z.infer<
  typeof connectorCatalogIntegrityArtifactSchema
>;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted(values: Iterable<string>): string {
  return [...values].sort(compareStrings).join(", ");
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate connector catalog ${label}: ${value}`);
    }
    seen.add(value);
  }
}

function assertAlphabetical(values: readonly string[], label: string): void {
  const expected = [...values].sort(compareStrings);
  if (
    expected.some((value, index) => {
      return value !== values[index];
    })
  ) {
    throw new Error(`Connector catalog ${label} must be alphabetical`);
  }
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
      `Connector catalog ${args.label} mismatch: missing [${sorted(missing)}], unexpected [${sorted(unexpected)}]`,
    );
  }
}

interface ConnectorCatalogArtifacts {
  readonly publicArtifact: ConnectorCatalogPublicArtifact;
  readonly privateArtifact: ConnectorCatalogPrivateArtifact;
  readonly privateFirewallsArtifact: ConnectorCatalogPrivateFirewallsArtifact;
  readonly runnerFirewallsArtifact: ConnectorCatalogRunnerFirewallsArtifact;
  readonly integrity: ConnectorCatalogIntegrityArtifact;
}

function assertHeaderAlignment(args: ConnectorCatalogArtifacts): void {
  const headers = [
    args.privateArtifact,
    args.privateFirewallsArtifact,
    args.runnerFirewallsArtifact,
    args.integrity,
  ];
  for (const artifact of headers) {
    if (artifact.catalogVersion !== args.publicArtifact.catalogVersion) {
      throw new Error("Connector catalog artifact header mismatch");
    }
  }
}

function assertReferenceAlignment(args: ConnectorCatalogArtifacts): void {
  const publicRefs = args.publicArtifact.connectors.map((connector) => {
    return connector.connectorRef;
  });
  const privateRefs = args.privateArtifact.connectors.map((connector) => {
    return connector.connectorRef;
  });
  const generatedRefs = args.privateFirewallsArtifact.connectors.map(
    (connector) => {
      return connector.connectorRef;
    },
  );
  const runnerRefs = args.runnerFirewallsArtifact.firewalls.map((firewall) => {
    return firewall.name;
  });
  for (const [values, label] of [
    [publicRefs, "public connector refs"],
    [privateRefs, "private connector refs"],
    [generatedRefs, "private firewall refs"],
    [runnerRefs, "runner firewall refs"],
  ] as const) {
    assertUnique(values, label);
    assertAlphabetical(values, label);
  }
  assertSameValues({
    expected: new Set(publicRefs),
    actual: new Set(privateRefs),
    label: "private connector refs",
  });
  const expectedGenerated = new Set(
    args.publicArtifact.connectors.flatMap((connector) => {
      return connector.firewall.kind === "generated"
        ? [connector.connectorRef]
        : [];
    }),
  );
  assertSameValues({
    expected: expectedGenerated,
    actual: new Set(generatedRefs),
    label: "private firewall refs",
  });
  assertSameValues({
    expected: expectedGenerated,
    actual: new Set(runnerRefs),
    label: "runner firewall refs",
  });
}

interface ConnectorRelationshipMaps {
  readonly privateByRef: ReadonlyMap<
    string,
    ConnectorCatalogPrivateArtifactConnector
  >;
  readonly serverFirewallByRef: ReadonlyMap<
    string,
    PrivateFirewallArtifactConnector
  >;
  readonly runnerFirewallByRef: ReadonlyMap<
    string,
    RunnerFirewallArtifactConnector
  >;
}

function connectorRelationshipMaps(
  args: ConnectorCatalogArtifacts,
): ConnectorRelationshipMaps {
  return {
    privateByRef: new Map(
      args.privateArtifact.connectors.map((connector) => {
        return [connector.connectorRef, connector];
      }),
    ),
    serverFirewallByRef: new Map(
      args.privateFirewallsArtifact.connectors.map((connector) => {
        return [connector.connectorRef, connector];
      }),
    ),
    runnerFirewallByRef: new Map(
      args.runnerFirewallsArtifact.firewalls.map((firewall) => {
        return [firewall.name, firewall];
      }),
    ),
  };
}

function assertAuthAlignment(args: {
  readonly publicConnector: ConnectorCatalogPublicArtifactConnector;
  readonly privateConnector: ConnectorCatalogPrivateArtifactConnector;
}): void {
  const publicMethodIds = args.publicConnector.authMethods.map((method) => {
    return method.id;
  });
  const privateMethodIds = args.privateConnector.authMethods.map((method) => {
    return method.id;
  });
  if (
    publicMethodIds.length !== privateMethodIds.length ||
    publicMethodIds.some((methodId, index) => {
      return methodId !== privateMethodIds[index];
    })
  ) {
    throw new Error(
      `Auth method alignment mismatch: ${args.publicConnector.connectorRef}`,
    );
  }
  for (const [
    index,
    publicMethod,
  ] of args.publicConnector.authMethods.entries()) {
    const privateMethod = args.privateConnector.authMethods[index];
    if (
      privateMethod === undefined ||
      publicMethod.grantKind !== privateMethod.grant.kind
    ) {
      throw new Error(
        `Grant alignment mismatch: ${args.publicConnector.connectorRef}`,
      );
    }
  }
}

function publicFirewallPermissions(
  firewall: PrivateFirewallArtifactConnector,
): readonly { readonly name: string; readonly description?: string }[] {
  const permissions = new Map<
    string,
    { readonly name: string; readonly description?: string }
  >();
  for (const api of firewall.firewall.apis) {
    for (const permission of api.permissions ?? []) {
      if (!permissions.has(permission.name)) {
        permissions.set(permission.name, {
          name: permission.name,
          ...(permission.description === undefined
            ? {}
            : { description: permission.description }),
        });
      }
    }
  }
  return [...permissions.values()].sort((left, right) => {
    return compareStrings(left.name, right.name);
  });
}

function expectedRunnerFirewall(
  firewall: PrivateFirewallArtifactConnector,
): RunnerFirewallArtifactConnector {
  return {
    name: firewall.connectorRef,
    apis: firewall.firewall.apis.map((api) => {
      return {
        base: api.base,
        ...(api.hostPolicy === undefined ? {} : { hostPolicy: api.hostPolicy }),
        auth: api.auth,
        permissions: (api.permissions ?? []).map((permission) => {
          return { name: permission.name, rules: permission.rules };
        }),
      };
    }),
  };
}

function assertFirewallAlignment(args: {
  readonly publicConnector: ConnectorCatalogPublicArtifactConnector;
  readonly serverFirewall: PrivateFirewallArtifactConnector;
  readonly runnerFirewall: RunnerFirewallArtifactConnector;
}): void {
  if (args.publicConnector.firewall.kind !== "generated") {
    throw new Error(
      `Unexpected generated firewall ${args.publicConnector.connectorRef}`,
    );
  }
  if (
    JSON.stringify(args.publicConnector.firewall.categories) !==
      JSON.stringify(args.serverFirewall.categories) ||
    JSON.stringify(args.publicConnector.firewall.defaultAllowed) !==
      JSON.stringify(args.serverFirewall.defaultAllowed) ||
    args.publicConnector.firewall.defaultUnknownPolicy !==
      args.serverFirewall.defaultUnknownPolicy
  ) {
    throw new Error(
      `Firewall metadata alignment mismatch: ${args.publicConnector.connectorRef}`,
    );
  }
  if (
    JSON.stringify(args.publicConnector.firewall.permissions) !==
    JSON.stringify(publicFirewallPermissions(args.serverFirewall))
  ) {
    throw new Error(
      `Firewall permission alignment mismatch: ${args.publicConnector.connectorRef}`,
    );
  }
  if (
    JSON.stringify(args.runnerFirewall) !==
    JSON.stringify(expectedRunnerFirewall(args.serverFirewall))
  ) {
    throw new Error(
      `Runner firewall alignment mismatch: ${args.publicConnector.connectorRef}`,
    );
  }
}

function assertConnectorRelationship(
  connector: ConnectorCatalogPublicArtifactConnector,
  maps: ConnectorRelationshipMaps,
): void {
  const privateConnector = maps.privateByRef.get(connector.connectorRef);
  if (!privateConnector) {
    throw new Error(`Missing private connector ${connector.connectorRef}`);
  }
  assertAuthAlignment({
    publicConnector: connector,
    privateConnector,
  });
  if (connector.firewall.kind === "none") {
    return;
  }
  const serverFirewall = maps.serverFirewallByRef.get(connector.connectorRef);
  const runnerFirewall = maps.runnerFirewallByRef.get(connector.connectorRef);
  if (!serverFirewall || !runnerFirewall) {
    throw new Error(`Missing generated firewall ${connector.connectorRef}`);
  }
  assertFirewallAlignment({
    publicConnector: connector,
    serverFirewall,
    runnerFirewall,
  });
}

function assertConnectorRelationships(args: ConnectorCatalogArtifacts): void {
  const maps = connectorRelationshipMaps(args);
  for (const connector of args.publicArtifact.connectors) {
    assertConnectorRelationship(connector, maps);
  }
}

interface ExpectedSkillArtifact {
  readonly digest: string;
  readonly kind: "archive" | "manifest";
}

function assertSkillArtifactReferencesConsistent(
  artifact: ConnectorCatalogPrivateArtifact,
): void {
  const expected = new Map<string, ExpectedSkillArtifact>();
  for (const connector of artifact.connectors) {
    if (connector.skill.kind === "none") {
      continue;
    }
    for (const [kind, reference] of [
      ["archive", connector.skill.archive],
      ["manifest", connector.skill.manifest],
    ] as const) {
      const existing = expected.get(reference.key);
      if (
        existing &&
        (existing.digest !== reference.digest || existing.kind !== kind)
      ) {
        throw new Error(`Conflicting private skill artifact: ${reference.key}`);
      }
      expected.set(reference.key, { digest: reference.digest, kind });
    }
  }
}

export function validateConnectorCatalogArtifacts(
  args: ConnectorCatalogArtifacts,
): void {
  assertHeaderAlignment(args);
  assertReferenceAlignment(args);
  assertConnectorRelationships(args);
  assertSkillArtifactReferencesConsistent(args.privateArtifact);
}
