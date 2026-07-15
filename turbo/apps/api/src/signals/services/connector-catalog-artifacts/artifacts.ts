import { z } from "zod";
import {
  artifactKeySchema,
  connectorCatalogVersionSchema,
  connectorRefSchema,
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

const CONNECTOR_SKILL_STORAGE_NAME_PREFIX = "connector-skill@";
const CONNECTOR_SKILL_STORAGE_PATH_PREFIX = "__system__/volume";

export const SUPPORTED_CONNECTOR_CATALOG_CAPABILITIES = [
  "bundle.required-resources@1",
  "catalog.public@1",
  "catalog.private@1",
  "firewall.private@1",
  "firewall.runner@1",
  "icon.static-files-path@1",
  "skill-bundled@1",
  "skill-none@1",
  "firewall-generated@1",
  "firewall-none@1",
  "firewall.categories@1",
  "firewall.defaults@1",
  "firewall.host-policy@1",
  "firewall.auth-base@1",
  "firewall.sigv4@1",
  "firewall.billing@1",
  "client.static-confidential-env@1",
  "client.static-public-literal@1",
  "client.dynamic-public@1",
  "grant.manual@1",
  "grant.auth-code@1",
  "grant.openid-auth@1",
  "grant.external-code@1",
  "grant.device-auth@1",
  "access.static@1",
  "access.refresh-token@1",
  "binding.optional@1",
  "binding.platform-secret@1",
  "manual.normalize-host@1",
  "revoke.token@1",
  "revoke.previous-on-replace@1",
] as const;

export type ConnectorCatalogCapability =
  (typeof SUPPORTED_CONNECTOR_CATALOG_CAPABILITIES)[number];

const artifactHeaderShape = Object.freeze({
  artifactSchemaVersion: z.literal(SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION),
  catalogVersion: connectorCatalogVersionSchema,
});

export const artifactReferenceSchema = z
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

const connectorSkillFrontmatterSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
  })
  .strict();

const staticFilesPublicationFileSchema = z
  .object({
    key: publicConnectorIconKeySchema,
    digest: digestSchema,
    size: z.number().int().positive(),
    contentType: z.enum(["image/svg+xml", "image/png"]),
  })
  .strict()
  .superRefine((file, context) => {
    const expectedSuffix = file.contentType === "image/png" ? ".png" : ".svg";
    const digestHex = file.digest.slice("sha256:".length);
    const keyDigest = /-([a-f0-9]{12})\.(?:png|svg)$/u.exec(file.key)?.[1];
    if (
      !file.key.endsWith(expectedSuffix) ||
      keyDigest === undefined ||
      !digestHex.startsWith(keyDigest)
    ) {
      context.addIssue({
        code: "custom",
        message: "Static-files key must match its digest prefix and media type",
        path: ["key"],
      });
    }
  });

export const staticFilesPublicationManifestSchema = z
  .object({
    artifactSchemaVersion: z.literal(
      SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    ),
    files: z.array(staticFilesPublicationFileSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const keys = manifest.files.map((file) => {
      return file.key;
    });
    const sortedKeys = [...keys].sort(compareStrings);
    if (
      keys.some((key, index) => {
        return key !== sortedKeys[index];
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Static-files publication entries must be alphabetical",
        path: ["files"],
      });
    }
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        message: "Static-files publication keys must be unique",
        path: ["files"],
      });
    }
  });

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
    defaultVisible: z.boolean(),
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

const assetIntegritySchema = publicConnectorIconReferenceSchema.extend({
  contentType: z.enum(["image/svg+xml", "image/png"]),
  size: z.number().int().positive(),
});

const skillArtifactIntegritySchema = artifactReferenceSchema.extend({
  kind: z.enum(["archive", "manifest"]),
  size: z.number().int().positive(),
});

const connectorSkillIntegritySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("bundled"),
      storageName: connectorSkillStorageNameSchema,
      versionId: connectorSkillVersionIdSchema,
      manifest: artifactReferenceSchema,
      archive: artifactReferenceSchema,
    })
    .strict(),
]);

const connectorIntegritySchema = z
  .object({
    connectorRef: connectorRefSchema,
    sourceFiles: z.array(artifactReferenceSchema).min(5),
    publicDigest: digestSchema,
    privateDigest: digestSchema,
    privateFirewallDigest: digestSchema.nullable(),
    runnerFirewallDigest: digestSchema.nullable(),
    skill: connectorSkillIntegritySchema,
    icon: publicConnectorIconReferenceSchema,
  })
  .strict();

export const connectorCatalogIntegrityArtifactSchema = z
  .object({
    ...artifactHeaderShape,
    requiredCapabilities: z.array(
      z.enum(SUPPORTED_CONNECTOR_CATALOG_CAPABILITIES),
    ),
    catalogSource: artifactReferenceSchema,
    generatorSources: z.array(artifactReferenceSchema).min(1),
    artifacts: z
      .object({
        publicCatalog: artifactReferenceSchema,
        privateCatalog: artifactReferenceSchema,
        privateFirewalls: artifactReferenceSchema,
        runnerFirewalls: artifactReferenceSchema,
        staticFilesPublication: artifactReferenceSchema,
      })
      .strict(),
    assets: z.array(assetIntegritySchema).min(1),
    skillArtifacts: z.array(skillArtifactIntegritySchema),
    connectors: z.array(connectorIntegritySchema).min(1),
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
type StaticFilesPublicationManifest = z.infer<
  typeof staticFilesPublicationManifestSchema
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
  readonly staticFilesPublicationArtifact: StaticFilesPublicationManifest;
  readonly integrity: ConnectorCatalogIntegrityArtifact;
}

function addPublicCapabilities(
  capabilities: Set<ConnectorCatalogCapability>,
  artifact: ConnectorCatalogPublicArtifact,
): void {
  for (const connector of artifact.connectors) {
    const firewall = connector.firewall;
    if (firewall.kind === "none") {
      capabilities.add("firewall-none@1");
      continue;
    }
    capabilities.add("firewall-generated@1");
    if (firewall.categories !== null) {
      capabilities.add("firewall.categories@1");
    }
    if (
      firewall.defaultAllowed !== null ||
      firewall.defaultUnknownPolicy !== "allow"
    ) {
      capabilities.add("firewall.defaults@1");
    }
  }
}

function addClientCapability(
  capabilities: Set<ConnectorCatalogCapability>,
  authMethod: ConnectorCatalogPrivateArtifactConnector["authMethods"][number],
): void {
  const client = authMethod.client;
  if (!client) {
    return;
  }
  if (client.clientRegistration === "dynamic") {
    capabilities.add("client.dynamic-public@1");
  } else if (client.clientType === "confidential") {
    capabilities.add("client.static-confidential-env@1");
  } else {
    capabilities.add("client.static-public-literal@1");
  }
}

function addAuthMethodCapabilities(
  capabilities: Set<ConnectorCatalogCapability>,
  authMethod: ConnectorCatalogPrivateArtifactConnector["authMethods"][number],
): void {
  addClientCapability(capabilities, authMethod);
  capabilities.add(`grant.${authMethod.grant.kind}@1`);
  capabilities.add(`access.${authMethod.access.kind}@1`);
  if (
    Object.values(authMethod.access.envBindings).some((binding) => {
      return typeof binding !== "string" && binding.optional;
    })
  ) {
    capabilities.add("binding.optional@1");
  }
  if ((authMethod.access.platformSecrets?.length ?? 0) > 0) {
    capabilities.add("binding.platform-secret@1");
  }
  if (
    authMethod.grant.kind === "manual" &&
    authMethod.grant.fields.some((field) => {
      return field.normalize === "host";
    })
  ) {
    capabilities.add("manual.normalize-host@1");
  }
  if (authMethod.revoke.kind === "token-revoke") {
    capabilities.add("revoke.token@1");
    if (authMethod.revoke.revokePreviousOnReplace === true) {
      capabilities.add("revoke.previous-on-replace@1");
    }
  }
}

function addPrivateCapabilities(
  capabilities: Set<ConnectorCatalogCapability>,
  artifact: ConnectorCatalogPrivateArtifact,
): void {
  for (const connector of artifact.connectors) {
    capabilities.add(
      connector.skill.kind === "bundled" ? "skill-bundled@1" : "skill-none@1",
    );
    for (const authMethod of connector.authMethods) {
      addAuthMethodCapabilities(capabilities, authMethod);
    }
  }
}

function addFirewallCapabilities(
  capabilities: Set<ConnectorCatalogCapability>,
  artifact: ConnectorCatalogPrivateFirewallsArtifact,
): void {
  for (const connector of artifact.connectors) {
    if (connector.billable) {
      capabilities.add("firewall.billing@1");
    }
    for (const api of connector.firewall.apis) {
      if (api.hostPolicy !== undefined) {
        capabilities.add("firewall.host-policy@1");
      }
      if (api.auth.base !== undefined) {
        capabilities.add("firewall.auth-base@1");
      }
      if (api.auth.awsSigv4 !== undefined) {
        capabilities.add("firewall.sigv4@1");
      }
    }
  }
}

function deriveConnectorCatalogCapabilities(
  args: Pick<
    ConnectorCatalogArtifacts,
    "publicArtifact" | "privateArtifact" | "privateFirewallsArtifact"
  >,
): ConnectorCatalogCapability[] {
  const capabilities = new Set<ConnectorCatalogCapability>([
    "bundle.required-resources@1",
    "catalog.public@1",
    "catalog.private@1",
    "firewall.private@1",
    "firewall.runner@1",
    "icon.static-files-path@1",
  ]);
  addPublicCapabilities(capabilities, args.publicArtifact);
  addPrivateCapabilities(capabilities, args.privateArtifact);
  addFirewallCapabilities(capabilities, args.privateFirewallsArtifact);
  return SUPPORTED_CONNECTOR_CATALOG_CAPABILITIES.filter((capability) => {
    return capabilities.has(capability);
  });
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
  const integrityRefs = args.integrity.connectors.map((connector) => {
    return connector.connectorRef;
  });
  for (const [values, label] of [
    [publicRefs, "public connector refs"],
    [privateRefs, "private connector refs"],
    [generatedRefs, "private firewall refs"],
    [runnerRefs, "runner firewall refs"],
    [integrityRefs, "integrity connector refs"],
  ] as const) {
    assertUnique(values, label);
    assertAlphabetical(values, label);
  }
  assertSameValues({
    expected: new Set(publicRefs),
    actual: new Set(privateRefs),
    label: "private connector refs",
  });
  assertSameValues({
    expected: new Set(publicRefs),
    actual: new Set(integrityRefs),
    label: "integrity connector refs",
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

function assertCapabilityAlignment(args: ConnectorCatalogArtifacts): void {
  const expectedCapabilities = deriveConnectorCatalogCapabilities(args);
  if (
    expectedCapabilities.length !==
      args.integrity.requiredCapabilities.length ||
    expectedCapabilities.some((capability, index) => {
      return capability !== args.integrity.requiredCapabilities[index];
    })
  ) {
    throw new Error("Connector catalog requiredCapabilities mismatch");
  }
}

function assertArtifactKeyAlignment(args: ConnectorCatalogArtifacts): void {
  const releaseKeys = connectorCatalogReleaseArtifactKeys(
    args.publicArtifact.catalogVersion,
  );
  const expectedArtifactKeys = {
    publicCatalog: releaseKeys.publicCatalog,
    privateCatalog: releaseKeys.privateCatalog,
    privateFirewalls: releaseKeys.privateFirewalls,
    runnerFirewalls: releaseKeys.runnerFirewalls,
    staticFilesPublication: "icons/static-files.json",
  };
  for (const [name, key] of Object.entries(expectedArtifactKeys)) {
    const reference =
      args.integrity.artifacts[name as keyof typeof expectedArtifactKeys];
    if (reference.key !== key) {
      throw new Error(
        `Connector catalog integrity artifact key mismatch: ${name}`,
      );
    }
  }
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
  readonly integrityByRef: ReadonlyMap<
    string,
    ConnectorCatalogIntegrityArtifact["connectors"][number]
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
    integrityByRef: new Map(
      args.integrity.connectors.map((connector) => {
        return [connector.connectorRef, connector];
      }),
    ),
  };
}

function assertSkillIconAndAuthAlignment(args: {
  readonly publicConnector: ConnectorCatalogPublicArtifactConnector;
  readonly privateConnector: ConnectorCatalogPrivateArtifactConnector;
  readonly integrityConnector: ConnectorCatalogIntegrityArtifact["connectors"][number];
}): void {
  const expectedSkillIntegrity =
    args.privateConnector.skill.kind === "none"
      ? { kind: "none" as const }
      : {
          kind: "bundled" as const,
          storageName: args.privateConnector.skill.storageName,
          versionId: args.privateConnector.skill.versionId,
          manifest: args.privateConnector.skill.manifest,
          archive: args.privateConnector.skill.archive,
        };
  if (
    JSON.stringify(args.integrityConnector.skill) !==
    JSON.stringify(expectedSkillIntegrity)
  ) {
    throw new Error(
      `Skill integrity mismatch: ${args.publicConnector.connectorRef}`,
    );
  }
  if (
    JSON.stringify(args.integrityConnector.icon) !==
    JSON.stringify(args.publicConnector.icon.asset)
  ) {
    throw new Error(
      `Icon integrity mismatch: ${args.publicConnector.connectorRef}`,
    );
  }
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
  const integrityConnector = maps.integrityByRef.get(connector.connectorRef);
  if (!integrityConnector) {
    throw new Error(`Missing integrity connector ${connector.connectorRef}`);
  }
  assertSkillIconAndAuthAlignment({
    publicConnector: connector,
    privateConnector,
    integrityConnector,
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

function assertAssetAlignment(args: ConnectorCatalogArtifacts): void {
  const publicIconKeys = args.publicArtifact.connectors.map((connector) => {
    return connector.icon.asset.key;
  });
  assertUnique(publicIconKeys, "public connector icon key");
  const assetByKey = new Map(
    args.integrity.assets.map((asset) => {
      return [asset.key, asset] as const;
    }),
  );
  assertUnique(
    args.integrity.assets.map((asset) => {
      return asset.key;
    }),
    "integrity asset key",
  );
  const publicationKeys = args.staticFilesPublicationArtifact.files.map(
    (file) => {
      return file.key;
    },
  );
  assertUnique(publicationKeys, "static-files publication key");
  assertAlphabetical(publicationKeys, "static-files publication keys");
  assertSameValues({
    expected: new Set(assetByKey.keys()),
    actual: new Set(publicationKeys),
    label: "static-files publication keys",
  });
  assertSameValues({
    expected: new Set(publicIconKeys),
    actual: new Set(assetByKey.keys()),
    label: "integrity asset keys",
  });
  const publicationByKey = new Map(
    args.staticFilesPublicationArtifact.files.map((file) => {
      return [file.key, file];
    }),
  );
  for (const connector of args.publicArtifact.connectors) {
    const asset = assetByKey.get(connector.icon.asset.key);
    const publication = publicationByKey.get(connector.icon.asset.key);
    if (
      !asset ||
      asset.digest !== connector.icon.asset.digest ||
      asset.contentType !== connector.icon.contentType ||
      !publication ||
      publication.digest !== asset.digest ||
      publication.size !== asset.size ||
      publication.contentType !== asset.contentType
    ) {
      throw new Error(
        `Icon integrity alignment mismatch: ${connector.connectorRef}`,
      );
    }
  }
}

interface ExpectedSkillArtifact {
  readonly digest: string;
  readonly kind: "archive" | "manifest";
}

function expectedSkillArtifacts(
  artifact: ConnectorCatalogPrivateArtifact,
): ReadonlyMap<string, ExpectedSkillArtifact> {
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
  return expected;
}

function assertSkillArtifactAlignment(args: ConnectorCatalogArtifacts): void {
  const expected = expectedSkillArtifacts(args.privateArtifact);
  const actualKeys = args.integrity.skillArtifacts.map((artifact) => {
    return artifact.key;
  });
  assertUnique(actualKeys, "integrity skill artifact key");
  assertSameValues({
    expected: new Set(expected.keys()),
    actual: new Set(actualKeys),
    label: "integrity skill artifact keys",
  });
  for (const artifact of args.integrity.skillArtifacts) {
    const expectedArtifact = expected.get(artifact.key);
    if (
      !expectedArtifact ||
      artifact.digest !== expectedArtifact.digest ||
      artifact.kind !== expectedArtifact.kind
    ) {
      throw new Error(`Skill artifact integrity mismatch: ${artifact.key}`);
    }
  }
}

export function validateConnectorCatalogArtifacts(
  args: ConnectorCatalogArtifacts,
): void {
  assertHeaderAlignment(args);
  assertReferenceAlignment(args);
  assertCapabilityAlignment(args);
  assertArtifactKeyAlignment(args);
  assertConnectorRelationships(args);
  assertAssetAlignment(args);
  assertSkillArtifactAlignment(args);
}
