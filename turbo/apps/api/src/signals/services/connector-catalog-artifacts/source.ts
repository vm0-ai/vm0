import { connectorAuthMethodIdSchema } from "@vm0/api-contracts/contracts/connector-identity";
import { z } from "zod";
import {
  connectorRefSchema,
  connectorCatalogVersionSchema,
  privateNameSchema,
} from "./common";

export const publicFieldIdSchema = z.string().regex(/^[a-z][a-zA-Z0-9]*$/u);
export const connectorFeatureSwitchKeySchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-zA-Z0-9]*$/u);
export const internalOptionNameSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/u);
export { connectorAuthMethodIdSchema };
const connectorCategoryIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);
const connectorGenerationTypeSchema = z.enum([
  "audio",
  "code",
  "document",
  "image",
  "presentation",
  "text",
  "video",
  "website",
]);
export const connectorValueRefSchema = z
  .string()
  .regex(/^\$(?:secrets|vars)\.[A-Z][A-Z0-9_]*$/u);
const connectorSecretRefSchema = z
  .string()
  .regex(/^\$secrets\.[A-Z][A-Z0-9_]*$/u);

const categoryGroupSourceSchema = z
  .object({
    id: connectorCategoryIdSchema,
    label: z.string().min(1),
    menuLabel: z.string().min(1),
  })
  .strict();

const categorySourceSchema = z
  .object({
    id: connectorCategoryIdSchema,
    label: z.string().min(1),
    menuLabel: z.string().min(1),
    groupId: connectorCategoryIdSchema.nullable(),
  })
  .strict();

export const catalogSourceSchema = z
  .object({
    catalogVersion: connectorCatalogVersionSchema,
    connectorRefs: z.array(connectorRefSchema).min(1),
    categoryMetadata: z
      .object({
        categories: z.array(categorySourceSchema).min(1),
        groups: z.array(categoryGroupSourceSchema),
      })
      .strict(),
  })
  .strict();

const staticConfidentialClientSourceSchema = z
  .object({
    clientRegistration: z.literal("static"),
    clientType: z.literal("confidential"),
    clientIdEnv: privateNameSchema,
    clientSecretEnv: privateNameSchema,
  })
  .strict();

const staticPublicClientSourceSchema = z
  .object({
    clientRegistration: z.literal("static"),
    clientType: z.literal("public"),
    clientId: z.string().min(1),
  })
  .strict();

const dynamicPublicClientSourceSchema = z
  .object({
    clientRegistration: z.literal("dynamic"),
    clientType: z.literal("public"),
  })
  .strict();

export const connectorAuthClientSourceSchema = z.union([
  staticConfidentialClientSourceSchema,
  staticPublicClientSourceSchema,
  dynamicPublicClientSourceSchema,
]);

export const connectorStorageSourceSchema = z
  .object({
    version: z.number().int().positive(),
    secrets: z.array(privateNameSchema),
    variables: z.array(privateNameSchema),
  })
  .strict();

const manualGrantFieldSourceSchema = z
  .object({
    privateName: privateNameSchema,
    publicId: publicFieldIdSchema,
    label: z.string().min(1),
    required: z.boolean(),
    placeholder: z.string().min(1).optional(),
    storage: z.enum(["secret", "variable"]),
    normalize: z.literal("host").optional(),
  })
  .strict();

const deviceStartOptionChoiceSourceSchema = z
  .object({
    value: z.string().min(1),
    label: z.string().min(1),
  })
  .strict();

const deviceStartOptionSourceSchema = z
  .object({
    privateName: internalOptionNameSchema,
    publicId: publicFieldIdSchema,
    kind: z.literal("select"),
    label: z.string().min(1),
    required: z.boolean(),
    defaultValue: z.string().min(1).optional(),
    options: z.array(deviceStartOptionChoiceSourceSchema).min(1),
  })
  .strict();

const outputBindingsSchema = z.record(
  z.string().min(1),
  connectorValueRefSchema,
);

const manualGrantSourceSchema = z
  .object({
    kind: z.literal("manual"),
    fields: z.array(manualGrantFieldSourceSchema).min(1),
  })
  .strict();

const authCodeGrantSourceSchema = z
  .object({
    kind: z.literal("auth-code"),
    scopes: z.array(z.string()),
    callbackOrigin: z.enum(["web", "api"]),
    outputs: outputBindingsSchema,
  })
  .strict();

const openIdGrantSourceSchema = z
  .object({
    kind: z.literal("openid-auth"),
    callbackOrigin: z.enum(["web", "api"]),
    outputs: outputBindingsSchema,
  })
  .strict();

const externalCodeGrantSourceSchema = z
  .object({
    kind: z.literal("external-code"),
    scopes: z.array(z.string()),
    outputs: outputBindingsSchema,
  })
  .strict();

const deviceAuthGrantSourceSchema = z
  .object({
    kind: z.literal("device-auth"),
    scopes: z.array(z.string()),
    outputs: outputBindingsSchema,
    startOptions: z.array(deviceStartOptionSourceSchema),
  })
  .strict();

const connectorGrantSourceSchema = z.discriminatedUnion("kind", [
  manualGrantSourceSchema,
  authCodeGrantSourceSchema,
  openIdGrantSourceSchema,
  externalCodeGrantSourceSchema,
  deviceAuthGrantSourceSchema,
]);

const envBindingSourceSchema = z.union([
  connectorValueRefSchema,
  z
    .object({
      valueRef: connectorValueRefSchema,
      optional: z.literal(true),
    })
    .strict(),
]);

const staticAccessSourceSchema = z
  .object({
    kind: z.literal("static"),
    envBindings: z.record(z.string().min(1), envBindingSourceSchema),
    platformSecrets: z.array(privateNameSchema).optional(),
  })
  .strict();

const refreshTokenAccessSourceSchema = z
  .object({
    kind: z.literal("refresh-token"),
    envBindings: z.record(z.string().min(1), envBindingSourceSchema),
    platformSecrets: z.array(privateNameSchema).optional(),
    inputs: z.record(z.string().min(1), connectorValueRefSchema),
    outputs: z.record(z.string().min(1), connectorValueRefSchema),
    refreshableSecrets: z.array(privateNameSchema),
  })
  .strict();

export const connectorAccessSourceSchema = z.discriminatedUnion("kind", [
  staticAccessSourceSchema,
  refreshTokenAccessSourceSchema,
]);

const noRevokeSourceSchema = z.object({ kind: z.literal("none") }).strict();
const tokenRevokeSourceSchema = z
  .object({
    kind: z.literal("token-revoke"),
    inputs: z.record(z.string().min(1), connectorSecretRefSchema),
    revokePreviousOnReplace: z.boolean().optional(),
  })
  .strict();

export const connectorRevokeSourceSchema = z.discriminatedUnion("kind", [
  noRevokeSourceSchema,
  tokenRevokeSourceSchema,
]);

const connectorAuthMethodSourceSchema = z
  .object({
    id: connectorAuthMethodIdSchema,
    label: z.string().min(1),
    description: z.string().min(1).nullable(),
    visible: z.boolean(),
    featureSwitch: connectorFeatureSwitchKeySchema.optional(),
    client: connectorAuthClientSourceSchema.optional(),
    storage: connectorStorageSourceSchema,
    grant: connectorGrantSourceSchema,
    access: connectorAccessSourceSchema,
    revoke: connectorRevokeSourceSchema,
  })
  .strict();

export const connectorSourceSchema = z
  .object({
    ref: connectorRefSchema,
    label: z.string().min(1),
    description: z.string().min(1),
    category: connectorCategoryIdSchema,
    generation: z.array(connectorGenerationTypeSchema),
    tags: z.array(z.string().min(1)),
    authMethods: z.array(connectorAuthMethodSourceSchema).min(1),
  })
  .strict();

export const connectorStaticIconPathSchema = z
  .string()
  .regex(
    /^platform\/views\/zero-page\/components\/settings\/icons\/[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{12}\.(?:png|svg)$/u,
  );

type CatalogSource = z.infer<typeof catalogSourceSchema>;
type ConnectorSource = z.infer<typeof connectorSourceSchema>;
export type ConnectorAuthMethodSource = ConnectorSource["authMethods"][number];
export type ConnectorGrantSource = ConnectorAuthMethodSource["grant"];

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertUnique(args: {
  readonly values: readonly string[];
  readonly label: string;
}): void {
  const seen = new Set<string>();
  for (const value of args.values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate ${args.label}: ${value}`);
    }
    seen.add(value);
  }
}

function assertAlphabetical(args: {
  readonly values: readonly string[];
  readonly label: string;
}): void {
  const expected = [...args.values].sort(compareStrings);
  if (
    expected.some((value, index) => {
      return value !== args.values[index];
    })
  ) {
    throw new Error(`${args.label} must be alphabetical`);
  }
}

function normalizePublicId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/gu, "").toLowerCase();
}

function valueRefName(valueRef: string): string {
  const separator = valueRef.indexOf(".");
  return valueRef.slice(separator + 1);
}

function authMethodValueRefs(
  authMethod: ConnectorAuthMethodSource,
): readonly string[] {
  const refs: string[] = [];
  if (authMethod.grant.kind !== "manual") {
    refs.push(...Object.values(authMethod.grant.outputs));
  }
  for (const binding of Object.values(authMethod.access.envBindings)) {
    refs.push(typeof binding === "string" ? binding : binding.valueRef);
  }
  if (authMethod.access.kind === "refresh-token") {
    refs.push(...Object.values(authMethod.access.inputs));
    refs.push(...Object.values(authMethod.access.outputs));
  }
  if (authMethod.revoke.kind === "token-revoke") {
    refs.push(...Object.values(authMethod.revoke.inputs));
  }
  return refs;
}

interface AuthStorageSets {
  readonly secretNames: ReadonlySet<string>;
  readonly variableNames: ReadonlySet<string>;
  readonly platformSecrets: ReadonlySet<string>;
}

function authStorageSets(
  authMethod: ConnectorAuthMethodSource,
): AuthStorageSets {
  return {
    secretNames: new Set(authMethod.storage.secrets),
    variableNames: new Set(authMethod.storage.variables),
    platformSecrets: new Set(authMethod.access.platformSecrets ?? []),
  };
}

function validateStorageDeclarations(
  methodRef: string,
  authMethod: ConnectorAuthMethodSource,
  storage: AuthStorageSets,
): void {
  assertUnique({
    values: authMethod.storage.secrets,
    label: `${methodRef} storage secret`,
  });
  assertUnique({
    values: authMethod.storage.variables,
    label: `${methodRef} storage variable`,
  });
  for (const name of storage.secretNames) {
    if (storage.variableNames.has(name)) {
      throw new Error(`${methodRef} declares ${name} in both storage classes`);
    }
  }
  for (const name of storage.platformSecrets) {
    if (storage.secretNames.has(name) || storage.variableNames.has(name)) {
      throw new Error(
        `${methodRef} declares platform secret ${name} in connector storage`,
      );
    }
  }
}

function validateManualGrant(
  methodRef: string,
  authMethod: ConnectorAuthMethodSource,
  storage: AuthStorageSets,
): void {
  if (authMethod.grant.kind !== "manual") {
    return;
  }
  assertUnique({
    values: authMethod.grant.fields.map((field) => {
      return field.privateName;
    }),
    label: `${methodRef} manual private name`,
  });
  assertUnique({
    values: authMethod.grant.fields.map((field) => {
      return field.publicId;
    }),
    label: `${methodRef} manual public id`,
  });
  for (const field of authMethod.grant.fields) {
    const expectedNames =
      field.storage === "secret" ? storage.secretNames : storage.variableNames;
    if (!expectedNames.has(field.privateName)) {
      throw new Error(
        `${methodRef} manual field ${field.privateName} is missing from ${field.storage} storage`,
      );
    }
    const normalizedPublicId = normalizePublicId(field.publicId);
    const normalizedPrivateName = normalizePublicId(field.privateName);
    if (
      normalizedPublicId === normalizedPrivateName ||
      normalizedPublicId.includes(normalizedPrivateName)
    ) {
      throw new Error(
        `${methodRef} public field id ${field.publicId} derives from a private name`,
      );
    }
  }
}

function validateDeviceGrant(
  methodRef: string,
  authMethod: ConnectorAuthMethodSource,
): void {
  if (authMethod.grant.kind !== "device-auth") {
    return;
  }
  assertUnique({
    values: authMethod.grant.startOptions.map((option) => {
      return option.privateName;
    }),
    label: `${methodRef} start option private name`,
  });
  assertUnique({
    values: authMethod.grant.startOptions.map((option) => {
      return option.publicId;
    }),
    label: `${methodRef} start option public id`,
  });
  for (const option of authMethod.grant.startOptions) {
    assertUnique({
      values: option.options.map((choice) => {
        return choice.value;
      }),
      label: `${methodRef}/${option.publicId} option value`,
    });
    if (
      option.defaultValue !== undefined &&
      !option.options.some((choice) => {
        return choice.value === option.defaultValue;
      })
    ) {
      throw new Error(
        `${methodRef}/${option.publicId} defaultValue is not an option`,
      );
    }
  }
}

function validateClientGrantAlignment(
  methodRef: string,
  authMethod: ConnectorAuthMethodSource,
): void {
  const grantNeedsClient = [
    "auth-code",
    "external-code",
    "device-auth",
  ].includes(authMethod.grant.kind);
  if (grantNeedsClient !== (authMethod.client !== undefined)) {
    throw new Error(`${methodRef} client does not match its grant kind`);
  }
  if (
    authMethod.grant.kind === "auth-code" &&
    authMethod.client?.clientType !== "confidential"
  ) {
    throw new Error(
      `${methodRef} auth-code grant requires a confidential client`,
    );
  }
  if (
    (authMethod.grant.kind === "external-code" ||
      authMethod.grant.kind === "device-auth") &&
    authMethod.client?.clientType !== "public"
  ) {
    throw new Error(`${methodRef} grant requires a public client`);
  }
}

function validateValueReferences(
  methodRef: string,
  authMethod: ConnectorAuthMethodSource,
  storage: AuthStorageSets,
): void {
  for (const valueRef of authMethodValueRefs(authMethod)) {
    const name = valueRefName(valueRef);
    const known = valueRef.startsWith("$secrets.")
      ? storage.secretNames.has(name) || storage.platformSecrets.has(name)
      : storage.variableNames.has(name);
    if (!known) {
      throw new Error(`${methodRef} references undeclared storage ${valueRef}`);
    }
  }
}

function validateRefreshableSecrets(
  methodRef: string,
  authMethod: ConnectorAuthMethodSource,
  storage: AuthStorageSets,
): void {
  if (authMethod.access.kind !== "refresh-token") {
    return;
  }
  for (const name of authMethod.access.refreshableSecrets) {
    if (!storage.secretNames.has(name)) {
      throw new Error(`${methodRef} refreshable secret ${name} is not stored`);
    }
  }
}

function validateAuthMethodSemantics(args: {
  readonly connectorRef: string;
  readonly authMethod: ConnectorAuthMethodSource;
}): void {
  const methodRef = `${args.connectorRef}/${args.authMethod.id}`;
  const storage = authStorageSets(args.authMethod);
  validateStorageDeclarations(methodRef, args.authMethod, storage);
  validateManualGrant(methodRef, args.authMethod, storage);
  validateDeviceGrant(methodRef, args.authMethod);
  validateClientGrantAlignment(methodRef, args.authMethod);
  validateValueReferences(methodRef, args.authMethod, storage);
  validateRefreshableSecrets(methodRef, args.authMethod, storage);
}

export function validateConnectorSourceSemantics(
  source: ConnectorSource,
): void {
  assertUnique({
    values: source.authMethods.map((authMethod) => {
      return authMethod.id;
    }),
    label: `${source.ref} auth method id`,
  });
  for (const authMethod of source.authMethods) {
    validateAuthMethodSemantics({ connectorRef: source.ref, authMethod });
  }
}

export function validateCatalogSourceSemantics(source: CatalogSource): void {
  assertUnique({
    values: source.connectorRefs,
    label: "catalog connector ref",
  });
  assertAlphabetical({
    values: source.connectorRefs,
    label: "catalog connector refs",
  });
  const groupIds = source.categoryMetadata.groups.map((group) => {
    return group.id;
  });
  const categoryIds = source.categoryMetadata.categories.map((category) => {
    return category.id;
  });
  assertUnique({ values: groupIds, label: "catalog category group id" });
  assertUnique({ values: categoryIds, label: "catalog category id" });
  const knownGroups = new Set(groupIds);
  for (const category of source.categoryMetadata.categories) {
    if (category.groupId !== null && !knownGroups.has(category.groupId)) {
      throw new Error(
        `Catalog category ${category.id} references unknown group ${category.groupId}`,
      );
    }
  }
}
