import { command, computed, type Computed } from "ccstate";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type {
  CreateCustomConnectorBody,
  CustomConnectorAuthMode,
  CustomConnectorField,
  CustomConnectorFieldKind,
  CustomConnectorHeaderInjection,
  CustomConnectorOAuthConfig,
  CustomConnectorOAuthConfigInput,
  CustomConnectorProposal,
  CustomConnectorQueryInjection,
  CustomConnectorResponse,
  CustomConnectorValueInput,
  UpdateCustomConnectorBody,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import {
  canonicalizeFirewallBaseUrl,
  expandHostWildcardsInBaseUrl,
} from "@vm0/connectors/firewall-types";
import { connectors } from "@vm0/db/schema/connector";
import {
  orgCustomConnectorOauthConfigs,
  type OrgCustomConnectorOAuthPkceMethod,
  type OrgCustomConnectorOAuthProviderAdapter,
  type OrgCustomConnectorOAuthTokenEndpointAuthMethod,
} from "@vm0/db/schema/org-custom-connector-oauth-config";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";
import { orgCustomConnectorValues } from "@vm0/db/schema/org-custom-connector-value";
import { secrets } from "@vm0/db/schema/secret";

import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { badRequestMessage, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { safeSync } from "../utils";
import {
  encryptStoredSecretValue,
  decryptStoredSecretValue,
} from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";
import { addUserCustomConnector } from "./user-connectors.service";
import {
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import type { ConnectorServerFirewallCatalog } from "./connector-server-firewall-catalog.service";

const L = logger("CustomConnectorService");

const LEGACY_SECRET_PLACEHOLDER = "{{secret}}";
const LEGACY_SECRET_KEY = "secret";
const FIELD_KEY_REGEX = /^[a-z][a-z0-9_]{0,63}$/;
const SLUG_REGEX = /^_[a-z0-9][a-z0-9-]{0,60}[a-z0-9]$/;
const HEADER_NAME_REGEX = /^[A-Za-z][A-Za-z0-9-]*$/;
const TEMPLATE_REFERENCE_REGEX =
  /\{\{\s*(secrets|variables|oauth)\.([a-z][a-z0-9_]*)\s*\}\}/g;
const VARIABLE_REFERENCE_REGEX = /\{\{\s*variables\.[a-z][a-z0-9_]*\s*\}\}/;
const TEMPLATE_PLACEHOLDER_VALUE = "placeholder";
const HOST_TEMPLATE_VALUE_UNSAFE_REGEX = /[/?#\\@:]/;
export const CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME = "access_token";
export const CUSTOM_CONNECTOR_OAUTH_REFRESH_TOKEN_SECRET_NAME = "refresh_token";
export const CUSTOM_CONNECTOR_OAUTH_ID_TOKEN_SECRET_NAME = "id_token";
export const CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_RUNTIME_KEY =
  "__oauth_access_token";
const CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_REFERENCE = "oauth.access_token";

type BadRequestResponse = ReturnType<typeof badRequestMessage>;
type NotFoundResponse = ReturnType<typeof notFound>;

export interface CustomConnectorOAuthConfigRow {
  readonly connectorId: string;
  readonly orgId: string;
  readonly providerAdapter: OrgCustomConnectorOAuthProviderAdapter;
  readonly clientId: string;
  readonly encryptedClientSecret: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly tokenEndpointAuthMethod: OrgCustomConnectorOAuthTokenEndpointAuthMethod;
  readonly pkceMethod: OrgCustomConnectorOAuthPkceMethod;
  readonly scopes: readonly string[];
  readonly authorizationParams: Readonly<Record<string, string>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CustomConnectorRow {
  readonly id: string;
  readonly orgId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly prefixes: readonly string[];
  readonly headerName: string;
  readonly headerTemplate: string;
  readonly prefixTemplates: readonly string[];
  readonly fields: readonly CustomConnectorField[];
  readonly headerInjections: readonly CustomConnectorHeaderInjection[];
  readonly queryInjections: readonly CustomConnectorQueryInjection[];
  readonly authMode: CustomConnectorAuthMode;
  readonly oauthConfig: CustomConnectorOAuthConfigRow | null;
  readonly revision: number;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface DefinitionInput {
  readonly displayName: string;
  readonly prefixTemplates: readonly string[];
  readonly fields: readonly CustomConnectorField[];
  readonly headerInjections: readonly CustomConnectorHeaderInjection[];
  readonly queryInjections: readonly CustomConnectorQueryInjection[];
  readonly authMode?: CustomConnectorAuthMode;
  readonly slug?: string;
}

interface ValidatedDefinition {
  readonly displayName: string;
  readonly prefixTemplates: readonly string[];
  readonly fields: readonly CustomConnectorField[];
  readonly headerInjections: readonly CustomConnectorHeaderInjection[];
  readonly queryInjections: readonly CustomConnectorQueryInjection[];
  readonly authMode: CustomConnectorAuthMode;
  readonly slug: string | undefined;
}

type ValidatedOAuthConfigUpdate =
  | { readonly kind: "none" }
  | { readonly kind: "preserve"; readonly config: CustomConnectorOAuthConfigRow }
  | {
      readonly kind: "upsert";
      readonly config: CustomConnectorOAuthConfig;
      readonly clientSecret: string | null;
    };

interface ValueMarker {
  readonly connectorId: string;
  readonly kind: CustomConnectorFieldKind;
  readonly key: string;
}

export class CustomConnectorRuntimePrefixError extends Error {
  constructor(connectorName: string | undefined) {
    super(
      connectorName
        ? `Custom connector "${connectorName}" has an invalid configured hostname`
        : "Custom connector has an invalid configured hostname",
    );
    this.name = "CustomConnectorRuntimePrefixError";
  }
}

export interface StoredValueRow extends ValueMarker {
  readonly encryptedValue: string;
}

type FeatureSwitchContextArg = Parameters<typeof decryptStoredSecretValue>[1];

function isBadRequest(value: unknown): value is BadRequestResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value as { status: unknown }).status === 400
  );
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => {
        return typeof item === "string";
      })
    : [];
}

function fieldArray(value: unknown): readonly CustomConnectorField[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is CustomConnectorField => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const candidate = item as {
      readonly key?: unknown;
      readonly label?: unknown;
      readonly kind?: unknown;
      readonly required?: unknown;
      readonly description?: unknown;
    };
    return (
      typeof candidate.key === "string" &&
      typeof candidate.label === "string" &&
      (candidate.kind === "secret" || candidate.kind === "variable") &&
      typeof candidate.required === "boolean" &&
      (candidate.description === undefined ||
        typeof candidate.description === "string")
    );
  });
}

function headerInjectionArray(
  value: unknown,
): readonly CustomConnectorHeaderInjection[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is CustomConnectorHeaderInjection => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const candidate = item as {
      readonly name?: unknown;
      readonly valueTemplate?: unknown;
    };
    return (
      typeof candidate.name === "string" &&
      typeof candidate.valueTemplate === "string"
    );
  });
}

function queryInjectionArray(
  value: unknown,
): readonly CustomConnectorQueryInjection[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is CustomConnectorQueryInjection => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const candidate = item as {
      readonly name?: unknown;
      readonly valueTemplate?: unknown;
    };
    return (
      typeof candidate.name === "string" &&
      typeof candidate.valueTemplate === "string"
    );
  });
}

function canonicalFieldsFromLegacy(): readonly CustomConnectorField[] {
  return [
    {
      key: LEGACY_SECRET_KEY,
      label: "Secret",
      kind: "secret",
      required: true,
      description: "API credential",
    },
  ];
}


function canonicalHeaderTemplateFromLegacy(template: string): string {
  return template.replaceAll(
    LEGACY_SECRET_PLACEHOLDER,
    `{{secrets.${LEGACY_SECRET_KEY}}}`,
  );
}

function legacyHeaderTemplateFromCanonical(template: string): string {
  return template.replaceAll(
    `{{secrets.${LEGACY_SECRET_KEY}}}`,
    LEGACY_SECRET_PLACEHOLDER,
  );
}

export function normaliseCustomConnectorRow(
  row: typeof orgCustomConnectors.$inferSelect,
  oauthConfig: CustomConnectorOAuthConfigRow | null = null,
): CustomConnectorRow {
  const prefixTemplates = stringArray(row.prefixTemplates);
  const storedFields = fieldArray(row.fields);
  const storedHeaderInjections = headerInjectionArray(row.headerInjections);
  const queryInjections = queryInjectionArray(row.queryInjections);
  const legacyPrefixes = stringArray(row.prefixes);
  return {
    ...row,
    prefixes: legacyPrefixes,
    prefixTemplates:
      prefixTemplates.length > 0 ? prefixTemplates : legacyPrefixes,
    fields:
      storedFields.length > 0
        ? storedFields
        : row.authMode === "manual"
          ? canonicalFieldsFromLegacy()
          : [],
    headerInjections:
      storedHeaderInjections.length > 0
        ? storedHeaderInjections
        : row.authMode === "manual"
          ? [
              {
                name: row.headerName,
                valueTemplate: canonicalHeaderTemplateFromLegacy(
                  row.headerTemplate,
                ),
              },
            ]
          : [],
    queryInjections,
    oauthConfig,
  };
}

function oauthConfigsEqual(
  left: CustomConnectorOAuthConfigRow | null,
  right: CustomConnectorOAuthConfigRow | null,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.providerAdapter === right.providerAdapter &&
    left.clientId === right.clientId &&
    left.encryptedClientSecret === right.encryptedClientSecret &&
    left.authorizationUrl === right.authorizationUrl &&
    left.tokenUrl === right.tokenUrl &&
    left.tokenEndpointAuthMethod === right.tokenEndpointAuthMethod &&
    left.pkceMethod === right.pkceMethod &&
    left.scopes.length === right.scopes.length &&
    left.scopes.every((scope, index) => {
      return scope === right.scopes[index];
    }) &&
    JSON.stringify(left.authorizationParams) ===
      JSON.stringify(right.authorizationParams)
  );
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function grantConfigurationChanged(args: {
  readonly existing: CustomConnectorRow;
  readonly definition: ValidatedDefinition;
  readonly nextOAuthConfig: CustomConnectorOAuthConfigRow | null;
}): boolean {
  return (
    args.existing.authMode !== args.definition.authMode ||
    !jsonValuesEqual(
      args.existing.prefixTemplates,
      args.definition.prefixTemplates,
    ) ||
    !jsonValuesEqual(args.existing.fields, args.definition.fields) ||
    !jsonValuesEqual(
      args.existing.headerInjections,
      args.definition.headerInjections,
    ) ||
    !jsonValuesEqual(
      args.existing.queryInjections,
      args.definition.queryInjections,
    ) ||
    !oauthConfigsEqual(args.existing.oauthConfig, args.nextOAuthConfig)
  );
}

function serialiseOAuthConfig(
  config: CustomConnectorOAuthConfigRow,
): CustomConnectorOAuthConfig {
  return {
    providerAdapter: config.providerAdapter,
    clientId: config.clientId,
    authorizationUrl: config.authorizationUrl,
    tokenUrl: config.tokenUrl,
    tokenEndpointAuthMethod: config.tokenEndpointAuthMethod,
    pkceMethod: config.pkceMethod,
    scopes: [...config.scopes],
    authorizationParams: { ...config.authorizationParams },
  };
}

export function customConnectorValueMarkerKey(marker: {
  readonly kind: CustomConnectorFieldKind;
  readonly key: string;
}): string {
  return `${marker.kind}:${marker.key}`;
}

function configuredValueMarkerKeys(
  markers: readonly ValueMarker[],
): readonly string[] {
  return [
    ...new Set(
      markers.map((marker) => {
        return customConnectorValueMarkerKey(marker);
      }),
    ),
  ].sort();
}

function configuredFieldKeys(args: {
  readonly fields: readonly CustomConnectorField[];
  readonly markers: readonly ValueMarker[];
}): readonly string[] {
  const configured = new Set(configuredValueMarkerKeys(args.markers));
  return args.fields
    .filter((field) => {
      return configured.has(customConnectorValueMarkerKey(field));
    })
    .map((field) => {
      return field.key;
    })
    .sort();
}

function computeMissingRequiredFields(args: {
  readonly fields: readonly CustomConnectorField[];
  readonly markers: readonly ValueMarker[];
}): readonly string[] {
  const configured = new Set(configuredValueMarkerKeys(args.markers));
  return args.fields
    .filter((field) => {
      return (
        field.required && !configured.has(customConnectorValueMarkerKey(field))
      );
    })
    .map((field) => {
      return field.key;
    });
}

export function serialiseCustomConnector(args: {
  readonly row: CustomConnectorRow;
  readonly valueMarkers: readonly ValueMarker[];
  readonly oauthConnected?: boolean;
}): CustomConnectorResponse {
  const connectorMarkers = args.valueMarkers.filter((marker) => {
    return marker.connectorId === args.row.id;
  });
  const missingRequiredFields = computeMissingRequiredFields({
    fields: args.row.fields,
    markers: connectorMarkers,
  });
  const configured = configuredFieldKeys({
    fields: args.row.fields,
    markers: connectorMarkers,
  });
  const oauthConnected = args.oauthConnected ?? false;
  const connected =
    missingRequiredFields.length === 0 &&
    (args.row.authMode === "manual" || oauthConnected);
  const responseMissingRequiredFields = [
    ...missingRequiredFields,
    ...(args.row.authMode === "oauth" && !oauthConnected ? ["oauth"] : []),
  ];
  return {
    id: args.row.id,
    slug: args.row.slug,
    displayName: args.row.displayName,
    prefixes: [...args.row.prefixTemplates],
    headerName: args.row.headerInjections[0]?.name ?? args.row.headerName,
    headerTemplate: legacyHeaderTemplateFromCanonical(
      args.row.headerInjections[0]?.valueTemplate ?? args.row.headerTemplate,
    ),
    prefixTemplates: [...args.row.prefixTemplates],
    fields: [...args.row.fields],
    headerInjections: [...args.row.headerInjections],
    queryInjections: [...args.row.queryInjections],
    authMode: args.row.authMode,
    ...(args.row.oauthConfig
      ? { oauthConfig: serialiseOAuthConfig(args.row.oauthConfig) }
      : {}),
    revision: args.row.revision,
    connected,
    missingRequiredFields: [...responseMissingRequiredFields],
    configuredFieldKeys: [...configured],
    createdAt: args.row.createdAt.toISOString(),
    updatedAt: args.row.updatedAt.toISOString(),
    hasSecret: connected,
  };
}

export function validateDisplayName(raw: string): string | BadRequestResponse {
  const displayName = raw.trim();
  if (displayName.length < 1 || displayName.length > 128) {
    return badRequestMessage(
      "Display name must be between 1 and 128 characters",
    );
  }
  return displayName;
}

function validateOptionalSlug(
  raw: string | undefined,
): string | undefined | BadRequestResponse {
  const slug = raw?.trim();
  if (slug === undefined || slug.length === 0) {
    return undefined;
  }
  if (!SLUG_REGEX.test(slug)) {
    return badRequestMessage(
      "Slug must start with _, be 3-64 chars, and use lowercase alphanumeric characters or internal hyphens",
    );
  }
  return slug;
}

function declaredFieldsByNamespace(fields: readonly CustomConnectorField[]) {
  return {
    secrets: new Set(
      fields
        .filter((field) => {
          return field.kind === "secret";
        })
        .map((field) => {
          return field.key;
        }),
    ),
    variables: new Set(
      fields
        .filter((field) => {
          return field.kind === "variable";
        })
        .map((field) => {
          return field.key;
        }),
    ),
  };
}

function extractTemplateReferences(template: string): readonly {
  readonly namespace: "secrets" | "variables" | "oauth";
  readonly key: string;
}[] {
  return [...template.matchAll(TEMPLATE_REFERENCE_REGEX)].map((match) => {
    const namespace = match[1];
    if (
      namespace !== "secrets" &&
      namespace !== "variables" &&
      namespace !== "oauth"
    ) {
      throw new Error("Invalid custom connector template namespace");
    }
    return {
      namespace,
      key: match[2]!,
    };
  });
}

export function customConnectorPrefixTemplateVariableKeys(
  prefixTemplates: readonly string[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const template of prefixTemplates) {
    for (const ref of extractTemplateReferences(template)) {
      if (ref.namespace === "variables") {
        keys.add(ref.key);
      }
    }
  }
  return keys;
}

function isSafeHostTemplateVariableValue(value: string): boolean {
  return (
    value.length > 0 &&
    !HOST_TEMPLATE_VALUE_UNSAFE_REGEX.test(value) &&
    !hasRawWhitespaceOrControlCharacter(value)
  );
}

function hasRawWhitespaceOrControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
}

function validateTemplateReferences(args: {
  readonly template: string;
  readonly fields: readonly CustomConnectorField[];
  readonly allowSecrets: boolean;
  readonly allowOAuth: boolean;
  readonly allowLegacySecret: boolean;
  readonly context: string;
}): BadRequestResponse | null {
  const declared = declaredFieldsByNamespace(args.fields);
  if (args.template.includes(LEGACY_SECRET_PLACEHOLDER)) {
    if (!args.allowLegacySecret || !declared.secrets.has(LEGACY_SECRET_KEY)) {
      return badRequestMessage(
        `${args.context} uses unsupported ${LEGACY_SECRET_PLACEHOLDER} placeholder`,
      );
    }
  }
  for (const ref of extractTemplateReferences(args.template)) {
    if (ref.namespace === "secrets" && !args.allowSecrets) {
      return badRequestMessage(`${args.context} must not reference secrets`);
    }
    if (ref.namespace === "oauth") {
      if (
        !args.allowOAuth ||
        ref.key !== CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME
      ) {
        return badRequestMessage(
          `${args.context} uses unsupported oauth.${ref.key} placeholder`,
        );
      }
      continue;
    }
    const allowed =
      ref.namespace === "secrets" ? declared.secrets : declared.variables;
    if (!allowed.has(ref.key)) {
      return badRequestMessage(
        `${args.context} references undeclared ${ref.namespace}.${ref.key}`,
      );
    }
  }
  return null;
}

function templateWithPlaceholders(template: string): string {
  return template.replaceAll(
    TEMPLATE_REFERENCE_REGEX,
    TEMPLATE_PLACEHOLDER_VALUE,
  );
}

function prefixContainsPathVariable(raw: string): boolean {
  if (!raw.startsWith("https://")) {
    return false;
  }
  const afterScheme = raw.slice("https://".length);
  const firstPathSlash = afterScheme.indexOf("/");
  if (firstPathSlash === -1) {
    return false;
  }
  return VARIABLE_REFERENCE_REGEX.test(afterScheme.slice(firstPathSlash));
}

function validateAndNormalizePrefixTemplate(args: {
  readonly raw: string;
  readonly fields: readonly CustomConnectorField[];
  readonly serverFirewalls: ConnectorServerFirewallCatalog;
}): string | BadRequestResponse {
  const trimmed = args.raw.trim();
  if (trimmed.length === 0) {
    return badRequestMessage("Prefix template must not be empty");
  }
  if (prefixContainsPathVariable(trimmed)) {
    return badRequestMessage(
      "Prefix template variables may only appear in the URL host",
    );
  }
  const templateError = validateTemplateReferences({
    template: trimmed,
    fields: args.fields,
    allowSecrets: false,
    allowOAuth: false,
    allowLegacySecret: false,
    context: "Prefix template",
  });
  if (templateError) {
    return templateError;
  }

  const normalised = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  const validationBase = expandHostWildcardsInBaseUrl(
    templateWithPlaceholders(normalised),
  );
  const validation = safeSync(() => {
    return canonicalizeFirewallBaseUrl(validationBase, "custom connector");
  });
  if ("error" in validation) {
    const message =
      validation.error instanceof Error
        ? validation.error.message.replace(validationBase, normalised)
        : "not a valid URL";
    return badRequestMessage(`Invalid prefix URL: ${args.raw}: ${message}`);
  }
  const canonicalPrefix = validation.ok;
  const schemeEnd = canonicalPrefix.indexOf("://");
  const scheme = canonicalPrefix.slice(0, schemeEnd).toLowerCase();
  if (scheme !== "https") {
    return badRequestMessage(`Prefix must use https://: ${args.raw}`);
  }

  if (!normalised.includes("{{")) {
    const authorityStart = schemeEnd + 3;
    const authorityEnd = canonicalPrefix.indexOf("/", authorityStart);
    const host = canonicalPrefix.slice(authorityStart, authorityEnd);
    const builtinOwner = args.serverFirewalls.getFixedHostOwner(host);
    if (builtinOwner) {
      const rawAuthority = normalised.slice(
        "https://".length,
        normalised.indexOf("/", "https://".length),
      );
      return badRequestMessage(
        `Host "${rawAuthority}" is already managed by the ${builtinOwner.label} connector`,
      );
    }
  }

  return normalised;
}

function validateFields(
  raw: readonly CustomConnectorField[],
): readonly CustomConnectorField[] | BadRequestResponse {
  const seen = new Set<string>();
  const fields: CustomConnectorField[] = [];
  for (const field of raw) {
    const key = field.key.trim();
    if (!FIELD_KEY_REGEX.test(key)) {
      return badRequestMessage(
        "Field keys must start with a lowercase letter and contain only lowercase letters, digits, and underscores",
      );
    }
    const marker = customConnectorValueMarkerKey({ kind: field.kind, key });
    if (seen.has(marker) || seen.has(key)) {
      return badRequestMessage(`Duplicate field key: ${key}`);
    }
    seen.add(marker);
    seen.add(key);
    const label = field.label.trim();
    if (label.length === 0 || label.length > 128) {
      return badRequestMessage(`Field label is invalid for ${key}`);
    }
    const description = field.description?.trim();
    fields.push({
      key,
      label,
      kind: field.kind,
      required: field.required,
      ...(description ? { description } : {}),
    });
  }
  return fields;
}

function validateHeaderName(raw: string): string | BadRequestResponse {
  const headerName = raw.trim();
  if (!HEADER_NAME_REGEX.test(headerName)) {
    return badRequestMessage(
      "Header name must start with a letter and contain only letters, digits, and hyphens",
    );
  }
  return headerName;
}

function validateHeaderInjections(args: {
  readonly raw: readonly CustomConnectorHeaderInjection[];
  readonly fields: readonly CustomConnectorField[];
  readonly authMode: CustomConnectorAuthMode;
}): readonly CustomConnectorHeaderInjection[] | BadRequestResponse {
  const seen = new Set<string>();
  const headers: CustomConnectorHeaderInjection[] = [];
  for (const injection of args.raw) {
    const name = validateHeaderName(injection.name);
    if (isBadRequest(name)) {
      return name;
    }
    const normalisedName = name.toLowerCase();
    if (seen.has(normalisedName)) {
      return badRequestMessage(`Duplicate header injection: ${name}`);
    }
    seen.add(normalisedName);
    const templateError = validateTemplateReferences({
      template: injection.valueTemplate,
      fields: args.fields,
      allowSecrets: args.authMode === "manual",
      allowOAuth: args.authMode === "oauth",
      allowLegacySecret: args.authMode === "manual",
      context: `Header ${name}`,
    });
    if (templateError) {
      return templateError;
    }
    headers.push({ name, valueTemplate: injection.valueTemplate });
  }
  return headers;
}

function validateQueryInjections(args: {
  readonly raw: readonly CustomConnectorQueryInjection[];
  readonly fields: readonly CustomConnectorField[];
  readonly authMode: CustomConnectorAuthMode;
}): readonly CustomConnectorQueryInjection[] | BadRequestResponse {
  const seen = new Set<string>();
  const queries: CustomConnectorQueryInjection[] = [];
  for (const injection of args.raw) {
    const name = injection.name.trim();
    if (name.length === 0 || name.length > 128) {
      return badRequestMessage("Query injection names must be 1-128 chars");
    }
    if (seen.has(name)) {
      return badRequestMessage(`Duplicate query injection: ${name}`);
    }
    seen.add(name);
    const templateError = validateTemplateReferences({
      template: injection.valueTemplate,
      fields: args.fields,
      allowSecrets: args.authMode === "manual",
      allowOAuth: args.authMode === "oauth",
      allowLegacySecret: args.authMode === "manual",
      context: `Query ${name}`,
    });
    if (templateError) {
      return templateError;
    }
    queries.push({ name, valueTemplate: injection.valueTemplate });
  }
  return queries;
}

function validateOAuth2Endpoint(
  raw: string,
  label: string,
): URL | BadRequestResponse {
  if (!URL.canParse(raw)) {
    return badRequestMessage(`${label} must be a valid URL`);
  }
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    return badRequestMessage(`${label} must use https://`);
  }
  if (url.username || url.password || url.hash) {
    return badRequestMessage(
      `${label} must not contain credentials or a fragment`,
    );
  }
  return url;
}

function validateOAuthConfigInput(
  config: CustomConnectorOAuthConfigInput,
): CustomConnectorOAuthConfigInput | BadRequestResponse {
  if (config.providerAdapter !== "standard") {
    return badRequestMessage(
      "Only the standard OAuth provider adapter is supported",
    );
  }
  const authorizationUrl = validateOAuth2Endpoint(
    config.authorizationUrl.trim(),
    "OAuth authorization URL",
  );
  if (isBadRequest(authorizationUrl)) {
    return authorizationUrl;
  }
  const tokenUrl = validateOAuth2Endpoint(
    config.tokenUrl.trim(),
    "OAuth token URL",
  );
  if (isBadRequest(tokenUrl)) {
    return tokenUrl;
  }
  const scopes = config.scopes.map((scope) => {
    return scope.trim();
  });
  if (
    scopes.some((scope) => {
      return scope.length === 0 || /\s/u.test(scope);
    })
  ) {
    return badRequestMessage(
      "OAuth scopes must be non-empty and must not contain whitespace",
    );
  }
  if (new Set(scopes).size !== scopes.length) {
    return badRequestMessage("OAuth scopes must be unique");
  }
  const clientId = config.clientId.trim();
  if (clientId.length === 0 || clientId.length > 255) {
    return badRequestMessage("OAuth client ID is invalid");
  }
  if (
    config.tokenEndpointAuthMethod === "client_secret_basic" &&
    clientId.includes(":")
  ) {
    return badRequestMessage(
      "OAuth client ID must not contain a colon when using HTTP Basic authentication",
    );
  }
  const clientSecret = config.clientSecret;
  if (
    clientSecret !== undefined &&
    (clientSecret.trim().length === 0 || clientSecret.length > 4096)
  ) {
    return badRequestMessage("OAuth client secret is invalid");
  }
  const authorizationParams: Record<string, string> = {};
  const allowedAuthorizationParamNames = new Set([
    "resource",
    "audience",
    "access_type",
    "prompt",
  ]);
  for (const [name, rawValue] of Object.entries(
    config.authorizationParams,
  ).sort(([left], [right]) => {
    return left.localeCompare(right);
  })) {
    if (!allowedAuthorizationParamNames.has(name)) {
      return badRequestMessage(
        `OAuth authorization parameter is not supported: ${name}`,
      );
    }
    const value = rawValue.trim();
    if (value.length === 0 || value.length > 2048) {
      return badRequestMessage(
        `OAuth authorization parameter is invalid: ${name}`,
      );
    }
    authorizationParams[name] = value;
  }
  return {
    providerAdapter: config.providerAdapter,
    clientId,
    authorizationUrl: authorizationUrl.toString(),
    tokenUrl: tokenUrl.toString(),
    tokenEndpointAuthMethod: config.tokenEndpointAuthMethod,
    pkceMethod: config.pkceMethod,
    scopes,
    authorizationParams,
    ...(clientSecret === undefined ? {} : { clientSecret }),
  };
}

function validateOAuthConfigUpdate(args: {
  readonly authMode: CustomConnectorAuthMode;
  readonly input: CustomConnectorOAuthConfigInput | undefined;
  readonly existingConfig: CustomConnectorOAuthConfigRow | null;
}): ValidatedOAuthConfigUpdate | BadRequestResponse {
  if (args.authMode === "manual") {
    if (args.input !== undefined) {
      return badRequestMessage(
        "OAuth configuration requires OAuth authentication mode",
      );
    }
    return { kind: "none" };
  }
  if (args.input === undefined) {
    return args.existingConfig
      ? { kind: "preserve", config: args.existingConfig }
      : badRequestMessage("OAuth configuration is required");
  }
  const config = validateOAuthConfigInput(args.input);
  if (isBadRequest(config)) {
    return config;
  }
  if (config.clientSecret === undefined && !args.existingConfig) {
    return badRequestMessage("OAuth client secret is required");
  }
  const { clientSecret, ...publicConfig } = config;
  return {
    kind: "upsert",
    config: publicConfig,
    clientSecret: clientSecret ?? null,
  };
}

function validateDefinition(
  input: DefinitionInput,
  serverFirewalls: ConnectorServerFirewallCatalog,
): ValidatedDefinition | BadRequestResponse {
  const displayName = validateDisplayName(input.displayName);
  if (isBadRequest(displayName)) {
    return displayName;
  }
  const fields = validateFields(input.fields);
  if (isBadRequest(fields)) {
    return fields;
  }
  const authMode = input.authMode ?? "manual";
  if (
    authMode === "oauth" &&
    fields.some((field) => {
      return field.kind === "secret";
    })
  ) {
    return badRequestMessage("OAuth custom connector fields must be variables");
  }

  const prefixTemplates: string[] = [];
  if (input.prefixTemplates.length === 0) {
    return badRequestMessage("At least one prefix template is required");
  }
  for (const raw of input.prefixTemplates) {
    const normalized = validateAndNormalizePrefixTemplate({
      raw,
      fields,
      serverFirewalls,
    });
    if (isBadRequest(normalized)) {
      return normalized;
    }
    prefixTemplates.push(normalized);
  }
  const seenPrefixes = new Set<string>();
  for (const prefix of prefixTemplates) {
    if (seenPrefixes.has(prefix)) {
      return badRequestMessage(`Duplicate prefix template: ${prefix}`);
    }
    seenPrefixes.add(prefix);
  }

  const headerInjections = validateHeaderInjections({
    raw: input.headerInjections,
    fields,
    authMode,
  });
  if (isBadRequest(headerInjections)) {
    return headerInjections;
  }
  const queryInjections = validateQueryInjections({
    raw: input.queryInjections,
    fields,
    authMode,
  });
  if (isBadRequest(queryInjections)) {
    return queryInjections;
  }
  if (headerInjections.length === 0 && queryInjections.length === 0) {
    return badRequestMessage(
      "At least one header or query injection is required",
    );
  }
  if (
    authMode === "oauth" &&
    ![...headerInjections, ...queryInjections].some((injection) => {
      return extractTemplateReferences(injection.valueTemplate).some(
        (reference) => {
          return (
            reference.namespace === "oauth" &&
            reference.key === CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME
          );
        },
      );
    })
  ) {
    return badRequestMessage(
      `OAuth custom connector injections must reference {{${CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_REFERENCE}}}`,
    );
  }
  const slug = validateOptionalSlug(input.slug);
  if (isBadRequest(slug)) {
    return slug;
  }

  return {
    displayName,
    prefixTemplates,
    fields,
    headerInjections,
    queryInjections,
    authMode,
    slug,
  };
}

function definitionFromCreateInput(
  input: CreateCustomConnectorBody,
): DefinitionInput | BadRequestResponse {
  const usesCanonical =
    input.prefixTemplates !== undefined ||
    input.fields !== undefined ||
    input.headerInjections !== undefined ||
    input.queryInjections !== undefined ||
    input.authMode !== undefined ||
    input.oauthConfig !== undefined;
  if (usesCanonical) {
    return {
      displayName: input.displayName,
      prefixTemplates: input.prefixTemplates ?? [],
      fields: input.fields ?? [],
      headerInjections: input.headerInjections ?? [],
      queryInjections: input.queryInjections ?? [],
      authMode: input.authMode,
      slug: input.slug,
    };
  }
  if (!input.prefixes || !input.headerName || !input.headerTemplate) {
    return badRequestMessage(
      "Custom connector requires prefix templates, fields, and header/query injections",
    );
  }
  if (!input.headerTemplate.includes(LEGACY_SECRET_PLACEHOLDER)) {
    return badRequestMessage(
      `Custom connector header template must contain ${LEGACY_SECRET_PLACEHOLDER}`,
    );
  }
  return {
    displayName: input.displayName,
    prefixTemplates: input.prefixes,
    fields: canonicalFieldsFromLegacy(),
    headerInjections: [
      {
        name: input.headerName,
        valueTemplate: canonicalHeaderTemplateFromLegacy(input.headerTemplate),
      },
    ],
    queryInjections: [],
    authMode: "manual",
    slug: input.slug,
  };
}

function definitionFromUpdateInput(
  input: UpdateCustomConnectorBody,
  authMode: CustomConnectorAuthMode = "manual",
): DefinitionInput {
  return {
    displayName: input.displayName,
    prefixTemplates: input.prefixTemplates,
    fields: input.fields,
    headerInjections: input.headerInjections,
    queryInjections: input.queryInjections,
    authMode: input.authMode ?? authMode,
  };
}

function legacyColumns(definition: ValidatedDefinition): {
  readonly prefixes: readonly string[];
  readonly headerName: string;
  readonly headerTemplate: string;
} {
  const firstHeader = definition.headerInjections[0];
  return {
    prefixes: [...definition.prefixTemplates],
    headerName: firstHeader?.name ?? "X-VM0-Custom-Connector",
    headerTemplate: firstHeader
      ? legacyHeaderTemplateFromCanonical(firstHeader.valueTemplate)
      : LEGACY_SECRET_PLACEHOLDER,
  };
}

function hostSlugFromPrefixTemplate(prefix: string): string {
  const canonicalPrefix = canonicalizeFirewallBaseUrl(
    expandHostWildcardsInBaseUrl(templateWithPlaceholders(prefix)),
    "custom connector",
  );
  const authorityStart = canonicalPrefix.indexOf("://") + 3;
  const authorityEnd = canonicalPrefix.indexOf("/", authorityStart);
  const host = canonicalPrefix
    .slice(authorityStart, authorityEnd)
    .replace(/\{hostWildcard[0-9]+\}/g, "")
    .toLowerCase();
  return host
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function randomShortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 6);
}

async function loadConnectorValueMarkers(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
}): Promise<readonly ValueMarker[]> {
  const [valueRows, legacyRows] = await Promise.all([
    args.db
      .select({
        connectorId: orgCustomConnectorValues.connectorId,
        kind: orgCustomConnectorValues.kind,
        key: orgCustomConnectorValues.key,
      })
      .from(orgCustomConnectorValues)
      .where(
        and(
          eq(orgCustomConnectorValues.orgId, args.orgId),
          eq(orgCustomConnectorValues.userId, args.userId),
        ),
      ),
    args.db
      .select({ connectorId: orgCustomConnectorSecrets.connectorId })
      .from(orgCustomConnectorSecrets)
      .where(
        and(
          eq(orgCustomConnectorSecrets.orgId, args.orgId),
          eq(orgCustomConnectorSecrets.userId, args.userId),
        ),
      ),
  ]);
  const markers: ValueMarker[] = valueRows
    .filter((row): row is ValueMarker => {
      return row.kind === "secret" || row.kind === "variable";
    })
    .map((row) => {
      return { connectorId: row.connectorId, kind: row.kind, key: row.key };
    });
  const existing = new Set(
    markers.map((marker) => {
      return `${marker.connectorId}:${customConnectorValueMarkerKey(marker)}`;
    }),
  );
  for (const row of legacyRows) {
    const marker = {
      connectorId: row.connectorId,
      kind: "secret" as const,
      key: LEGACY_SECRET_KEY,
    };
    const key = `${marker.connectorId}:${customConnectorValueMarkerKey(marker)}`;
    if (!existing.has(key)) {
      markers.push(marker);
      existing.add(key);
    }
  }
  return markers;
}

async function loadConnectedOAuthConnectorIds(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
}): Promise<ReadonlySet<string>> {
  const rows = await args.db
    .select({ customConnectorId: connectors.customConnectorId })
    .from(connectors)
    .innerJoin(
      secrets,
      and(
        eq(secrets.connectorId, connectors.id),
        eq(secrets.name, CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME),
      ),
    )
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.authMethod, "oauth"),
        eq(connectors.needsReconnect, false),
      ),
    );
  return new Set(
    rows.flatMap((row) => {
      return row.customConnectorId ? [row.customConnectorId] : [];
    }),
  );
}

export const createCustomConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly input: CreateCustomConnectorBody;
      readonly connectorCatalogSnapshot?: ConnectorRuntimeSnapshot;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorRow | BadRequestResponse> => {
    const canonicalInput = definitionFromCreateInput(args.input);
    if (isBadRequest(canonicalInput)) {
      return canonicalInput;
    }
    const writeDb = set(writeDb$);
    const connectorCatalogSnapshot =
      args.connectorCatalogSnapshot ??
      (await loadConnectorRuntimeSnapshot(writeDb));
    signal.throwIfAborted();
    const v = validateDefinition(
      canonicalInput,
      connectorCatalogSnapshot.serverFirewalls,
    );
    if (isBadRequest(v)) {
      return v;
    }
    const oauthConfigUpdate = validateOAuthConfigUpdate({
      authMode: v.authMode,
      input: args.input.oauthConfig,
      existingConfig: null,
    });
    if (isBadRequest(oauthConfigUpdate)) {
      return oauthConfigUpdate;
    }
    signal.throwIfAborted();

    let encryptedClientSecret: string | null = null;
    if (oauthConfigUpdate.kind === "upsert" && oauthConfigUpdate.clientSecret) {
      const featureContext = await get(
        userFeatureSwitchContext(args.orgId, args.userId),
      );
      signal.throwIfAborted();
      encryptedClientSecret = await encryptStoredSecretValue(
        oauthConfigUpdate.clientSecret,
        featureContext,
      );
    }
    signal.throwIfAborted();

    const slug =
      v.slug ??
      `_${hostSlugFromPrefixTemplate(v.prefixTemplates[0]!)}-${randomShortId()}`;
    const legacy = legacyColumns(v);
    L.debug("creating custom connector", { orgId: args.orgId, slug });

    const created = await writeDb.transaction(async (tx) => {
      const [row] = await tx
        .insert(orgCustomConnectors)
        .values({
          orgId: args.orgId,
          slug,
          displayName: v.displayName,
          prefixes: [...legacy.prefixes],
          headerName: legacy.headerName,
          headerTemplate: legacy.headerTemplate,
          prefixTemplates: [...v.prefixTemplates],
          fields: [...v.fields],
          headerInjections: [...v.headerInjections],
          queryInjections: [...v.queryInjections],
          authMode: v.authMode,
          createdBy: args.userId,
        })
        .returning();
      if (!row) {
        throw new Error("Expected insert to return a row");
      }
      if (oauthConfigUpdate.kind !== "upsert" || !encryptedClientSecret) {
        return { row, oauthConfig: null };
      }
      const [oauthConfig] = await tx
        .insert(orgCustomConnectorOauthConfigs)
        .values({
          connectorId: row.id,
          orgId: args.orgId,
          ...oauthConfigUpdate.config,
          encryptedClientSecret,
        })
        .returning();
      if (!oauthConfig) {
        throw new Error("Expected OAuth config insert to return a row");
      }
      return { row, oauthConfig };
    });
    signal.throwIfAborted();

    return normaliseCustomConnectorRow(created.row, created.oauthConfig);
  },
);

async function loadCustomConnectorForUpdate(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly id: string },
): Promise<CustomConnectorRow | null> {
  const [result] = await db
    .select({
      connector: orgCustomConnectors,
      oauthConfig: orgCustomConnectorOauthConfigs,
    })
    .from(orgCustomConnectors)
    .leftJoin(
      orgCustomConnectorOauthConfigs,
      and(
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
        eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
      ),
    )
    .where(
      and(
        eq(orgCustomConnectors.id, args.id),
        eq(orgCustomConnectors.orgId, args.orgId),
      ),
    )
    .limit(1);
  return result
    ? normaliseCustomConnectorRow(result.connector, result.oauthConfig)
    : null;
}

function nextOAuthConfigForUpdate(args: {
  readonly connector: CustomConnectorRow;
  readonly orgId: string;
  readonly update: ValidatedOAuthConfigUpdate;
  readonly encryptedClientSecret: string | null;
}): CustomConnectorOAuthConfigRow | null {
  if (args.update.kind === "none") {
    return null;
  }
  if (args.update.kind === "preserve") {
    return args.update.config;
  }
  if (!args.encryptedClientSecret) {
    return null;
  }
  return {
    connectorId: args.connector.id,
    orgId: args.orgId,
    ...args.update.config,
    encryptedClientSecret: args.encryptedClientSecret,
    createdAt: args.connector.oauthConfig?.createdAt ?? nowDate(),
    updatedAt: nowDate(),
  };
}

async function persistCustomConnectorUpdate(
  db: Db,
  args: {
    readonly orgId: string;
    readonly id: string;
    readonly definition: ValidatedDefinition;
    readonly existing: CustomConnectorRow;
    readonly oauthConfigUpdate: ValidatedOAuthConfigUpdate;
    readonly encryptedClientSecret: string | null;
    readonly grantConfigurationChanged: boolean;
    readonly oauthConfigurationChanged: boolean;
  },
): Promise<{
  readonly row: typeof orgCustomConnectors.$inferSelect;
  readonly oauthConfig: CustomConnectorOAuthConfigRow | null;
} | null> {
  const legacy = legacyColumns(args.definition);
  return await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(orgCustomConnectors)
      .set({
        displayName: args.definition.displayName,
        prefixes: [...legacy.prefixes],
        headerName: legacy.headerName,
        headerTemplate: legacy.headerTemplate,
        prefixTemplates: [...args.definition.prefixTemplates],
        fields: [...args.definition.fields],
        headerInjections: [...args.definition.headerInjections],
        queryInjections: [...args.definition.queryInjections],
        authMode: args.definition.authMode,
        revision: args.grantConfigurationChanged
          ? args.existing.revision + 1
          : args.existing.revision,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(orgCustomConnectors.id, args.id),
          eq(orgCustomConnectors.orgId, args.orgId),
        ),
      )
      .returning();
    if (!updated) {
      return null;
    }
    let storedOAuthConfig: CustomConnectorOAuthConfigRow | null = null;
    if (args.oauthConfigUpdate.kind === "none") {
      await tx
        .delete(orgCustomConnectorOauthConfigs)
        .where(
          and(
            eq(orgCustomConnectorOauthConfigs.connectorId, args.id),
            eq(orgCustomConnectorOauthConfigs.orgId, args.orgId),
          ),
        );
    } else if (args.oauthConfigUpdate.kind === "preserve") {
      storedOAuthConfig = args.oauthConfigUpdate.config;
    } else {
      if (!args.encryptedClientSecret) {
        throw new Error("Expected encrypted OAuth client secret");
      }
      const [upserted] = await tx
        .insert(orgCustomConnectorOauthConfigs)
        .values({
          connectorId: args.id,
          orgId: args.orgId,
          ...args.oauthConfigUpdate.config,
          encryptedClientSecret: args.encryptedClientSecret,
        })
        .onConflictDoUpdate({
          target: orgCustomConnectorOauthConfigs.connectorId,
          set: {
            ...args.oauthConfigUpdate.config,
            encryptedClientSecret: args.encryptedClientSecret,
            updatedAt: nowDate(),
          },
        })
        .returning();
      storedOAuthConfig = upserted ?? null;
    }
    if (args.oauthConfigurationChanged) {
      await tx
        .delete(connectors)
        .where(
          and(
            eq(connectors.customConnectorId, args.id),
            eq(connectors.orgId, args.orgId),
          ),
        );
    }
    return { row: updated, oauthConfig: storedOAuthConfig };
  });
}

export const updateCustomConnectorDefinition$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly id: string;
      readonly input: UpdateCustomConnectorBody;
      readonly connectorCatalogSnapshot?: ConnectorRuntimeSnapshot;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorRow | BadRequestResponse | NotFoundResponse> => {
    const writeDb = set(writeDb$);
    const existingConnector = await loadCustomConnectorForUpdate(writeDb, args);
    signal.throwIfAborted();
    if (!existingConnector) {
      return notFound("Custom connector not found");
    }
    const connectorCatalogSnapshot =
      args.connectorCatalogSnapshot ??
      (await loadConnectorRuntimeSnapshot(writeDb));
    signal.throwIfAborted();
    const v = validateDefinition(
      definitionFromUpdateInput(args.input, existingConnector.authMode),
      connectorCatalogSnapshot.serverFirewalls,
    );
    if (isBadRequest(v)) {
      return v;
    }
    const oauthConfigUpdate = validateOAuthConfigUpdate({
      authMode: v.authMode,
      input: args.input.oauthConfig,
      existingConfig: existingConnector.oauthConfig,
    });
    if (isBadRequest(oauthConfigUpdate)) {
      return oauthConfigUpdate;
    }

    let encryptedClientSecret =
      existingConnector.oauthConfig?.encryptedClientSecret ?? null;
    if (oauthConfigUpdate.kind === "upsert" && oauthConfigUpdate.clientSecret) {
      const featureContext = await get(
        userFeatureSwitchContext(args.orgId, args.userId),
      );
      signal.throwIfAborted();
      encryptedClientSecret = await encryptStoredSecretValue(
        oauthConfigUpdate.clientSecret,
        featureContext,
      );
      signal.throwIfAborted();
    }

    const nextOAuthConfig = nextOAuthConfigForUpdate({
      connector: existingConnector,
      orgId: args.orgId,
      update: oauthConfigUpdate,
      encryptedClientSecret,
    });
    const oauthConfigurationChanged =
      existingConnector.authMode !== v.authMode ||
      !oauthConfigsEqual(existingConnector.oauthConfig, nextOAuthConfig);
    const connectorGrantConfigurationChanged = grantConfigurationChanged({
      existing: existingConnector,
      definition: v,
      nextOAuthConfig,
    });
    const result = await persistCustomConnectorUpdate(writeDb, {
      orgId: args.orgId,
      id: args.id,
      definition: v,
      existing: existingConnector,
      oauthConfigUpdate,
      encryptedClientSecret,
      grantConfigurationChanged: connectorGrantConfigurationChanged,
      oauthConfigurationChanged,
    });
    signal.throwIfAborted();
    if (!result) {
      return notFound("Custom connector not found");
    }
    return normaliseCustomConnectorRow(result.row, result.oauthConfig);
  },
);

export const deleteCustomConnector$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly id: string },
    signal: AbortSignal,
  ): Promise<NotFoundResponse | undefined> => {
    const writeDb = set(writeDb$);
    const deleted = await writeDb.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: orgCustomConnectors.id })
        .from(orgCustomConnectors)
        .where(
          and(
            eq(orgCustomConnectors.id, args.id),
            eq(orgCustomConnectors.orgId, args.orgId),
          ),
        )
        .limit(1);
      if (!existing) {
        return false;
      }
      await tx
        .delete(orgCustomConnectorValues)
        .where(eq(orgCustomConnectorValues.connectorId, args.id));
      await tx
        .delete(orgCustomConnectorSecrets)
        .where(eq(orgCustomConnectorSecrets.connectorId, args.id));
      await tx
        .delete(orgCustomConnectors)
        .where(
          and(
            eq(orgCustomConnectors.id, args.id),
            eq(orgCustomConnectors.orgId, args.orgId),
          ),
        );
      return true;
    });
    signal.throwIfAborted();
    if (!deleted) {
      return notFound("Custom connector not found");
    }
    L.debug("custom connector deleted", { orgId: args.orgId, id: args.id });
    return undefined;
  },
);

export function getCustomConnectorById(args: {
  readonly orgId: string;
  readonly connectorId: string;
}): Computed<Promise<CustomConnectorRow | null>> {
  return computed(async (get): Promise<CustomConnectorRow | null> => {
    const db = get(db$);
    const [result] = await db
      .select({
        connector: orgCustomConnectors,
        oauthConfig: orgCustomConnectorOauthConfigs,
      })
      .from(orgCustomConnectors)
      .leftJoin(
        orgCustomConnectorOauthConfigs,
        and(
          eq(
            orgCustomConnectorOauthConfigs.connectorId,
            orgCustomConnectors.id,
          ),
          eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
        ),
      )
      .where(
        and(
          eq(orgCustomConnectors.id, args.connectorId),
          eq(orgCustomConnectors.orgId, args.orgId),
        ),
      )
      .limit(1);
    if (!result) {
      return null;
    }
    return normaliseCustomConnectorRow(result.connector, result.oauthConfig);
  });
}

export function getCustomConnectorResponse(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
}): Computed<Promise<CustomConnectorResponse | null>> {
  return computed(async (get): Promise<CustomConnectorResponse | null> => {
    const db = get(db$);
    const connector = await get(
      getCustomConnectorById({
        orgId: args.orgId,
        connectorId: args.connectorId,
      }),
    );
    if (!connector) {
      return null;
    }
    const [markers, oauthConnections] = await Promise.all([
      loadConnectorValueMarkers({
        db,
        orgId: args.orgId,
        userId: args.userId,
      }),
      loadConnectedOAuthConnectorIds({
        db,
        orgId: args.orgId,
        userId: args.userId,
      }),
    ]);
    return serialiseCustomConnector({
      row: connector,
      valueMarkers: markers,
      oauthConnected: oauthConnections.has(connector.id),
    });
  });
}

function validateValueInputsForDefinition(args: {
  readonly fields: readonly CustomConnectorField[];
  readonly prefixTemplates: readonly string[];
  readonly values: readonly CustomConnectorValueInput[];
}): readonly CustomConnectorValueInput[] | BadRequestResponse {
  const allowed = new Set(
    args.fields.map((field) => {
      return customConnectorValueMarkerKey(field);
    }),
  );
  const prefixVariables = customConnectorPrefixTemplateVariableKeys(
    args.prefixTemplates,
  );
  const seen = new Set<string>();
  const values: CustomConnectorValueInput[] = [];
  for (const value of args.values) {
    const key = value.key.trim();
    const marker = customConnectorValueMarkerKey({ kind: value.kind, key });
    if (!allowed.has(marker)) {
      return badRequestMessage(
        `Value references undeclared custom connector field: ${marker}`,
      );
    }
    if (seen.has(marker)) {
      return badRequestMessage(`Duplicate value for field: ${marker}`);
    }
    if (
      value.kind === "variable" &&
      prefixVariables.has(key) &&
      !isSafeHostTemplateVariableValue(value.value)
    ) {
      return badRequestMessage(
        `Value for variable ${key} contains characters that are not safe in custom connector host templates`,
      );
    }
    if (value.kind === "variable" && prefixVariables.has(key)) {
      for (const prefixTemplate of args.prefixTemplates) {
        const referencesValue = extractTemplateReferences(prefixTemplate).some(
          (reference) => {
            return reference.namespace === "variables" && reference.key === key;
          },
        );
        if (!referencesValue) {
          continue;
        }
        const rendered = prefixTemplate.replaceAll(
          TEMPLATE_REFERENCE_REGEX,
          (_match, namespace: string, referenceKey: string) => {
            return namespace === "variables" && referenceKey === key
              ? value.value
              : TEMPLATE_PLACEHOLDER_VALUE;
          },
        );
        const validation = safeSync(() => {
          return canonicalizeFirewallBaseUrl(
            expandHostWildcardsInBaseUrl(rendered),
            "custom connector",
          );
        });
        if ("error" in validation) {
          return badRequestMessage(
            `Value for variable ${key} is not a valid custom connector hostname`,
          );
        }
      }
    }
    seen.add(marker);
    values.push({ key, kind: value.kind, value: value.value });
  }
  return values;
}

function validateValueInputs(args: {
  readonly connector: CustomConnectorRow;
  readonly values: readonly CustomConnectorValueInput[];
}): readonly CustomConnectorValueInput[] | BadRequestResponse {
  return validateValueInputsForDefinition({
    fields: args.connector.fields,
    prefixTemplates: args.connector.prefixTemplates,
    values: args.values,
  });
}

export const setCustomConnectorValues$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly values: readonly CustomConnectorValueInput[];
      readonly syncLegacySecret?: boolean;
    },
    signal: AbortSignal,
  ): Promise<
    CustomConnectorResponse | BadRequestResponse | NotFoundResponse
  > => {
    const connector = await get(
      getCustomConnectorById({
        orgId: args.orgId,
        connectorId: args.connectorId,
      }),
    );
    signal.throwIfAborted();
    if (!connector) {
      return notFound("Custom connector not found");
    }
    if (connector.authMode !== "manual") {
      return badRequestMessage(
        "OAuth custom connectors must be connected through OAuth",
      );
    }
    const values = validateValueInputs({ connector, values: args.values });
    if (isBadRequest(values)) {
      return values;
    }
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const writeDb = set(writeDb$);
    for (const value of values) {
      const encryptedValue = await encryptStoredSecretValue(
        value.value,
        featureSwitchContext,
      );
      signal.throwIfAborted();
      await writeDb
        .insert(orgCustomConnectorValues)
        .values({
          connectorId: args.connectorId,
          userId: args.userId,
          orgId: args.orgId,
          kind: value.kind,
          key: value.key,
          encryptedValue,
        })
        .onConflictDoUpdate({
          target: [
            orgCustomConnectorValues.connectorId,
            orgCustomConnectorValues.userId,
            orgCustomConnectorValues.kind,
            orgCustomConnectorValues.key,
          ],
          set: {
            encryptedValue,
            updatedAt: nowDate(),
          },
        });
      signal.throwIfAborted();

      if (
        args.syncLegacySecret &&
        value.kind === "secret" &&
        value.key === LEGACY_SECRET_KEY
      ) {
        await writeDb
          .insert(orgCustomConnectorSecrets)
          .values({
            connectorId: args.connectorId,
            userId: args.userId,
            orgId: args.orgId,
            encryptedValue,
          })
          .onConflictDoUpdate({
            target: [
              orgCustomConnectorSecrets.connectorId,
              orgCustomConnectorSecrets.userId,
            ],
            set: {
              encryptedValue,
              updatedAt: nowDate(),
            },
          });
      }
    }
    signal.throwIfAborted();

    const db = get(db$);
    const markers = await loadConnectorValueMarkers({
      db,
      orgId: args.orgId,
      userId: args.userId,
    });
    signal.throwIfAborted();
    return serialiseCustomConnector({ row: connector, valueMarkers: markers });
  },
);

export const disconnectCustomConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
    },
    signal: AbortSignal,
  ): Promise<NotFoundResponse | undefined> => {
    const connector = await get(
      getCustomConnectorById({
        orgId: args.orgId,
        connectorId: args.connectorId,
      }),
    );
    signal.throwIfAborted();
    if (!connector) {
      return notFound("Custom connector not found");
    }
    const writeDb = set(writeDb$);
    await writeDb.transaction(async (tx) => {
      await tx
        .delete(orgCustomConnectorValues)
        .where(
          and(
            eq(orgCustomConnectorValues.connectorId, args.connectorId),
            eq(orgCustomConnectorValues.userId, args.userId),
            eq(orgCustomConnectorValues.orgId, args.orgId),
            eq(orgCustomConnectorValues.kind, "secret"),
          ),
        );
      await tx
        .delete(orgCustomConnectorSecrets)
        .where(
          and(
            eq(orgCustomConnectorSecrets.connectorId, args.connectorId),
            eq(orgCustomConnectorSecrets.userId, args.userId),
            eq(orgCustomConnectorSecrets.orgId, args.orgId),
          ),
        );
      await tx
        .delete(connectors)
        .where(
          and(
            eq(connectors.customConnectorId, args.connectorId),
            eq(connectors.userId, args.userId),
            eq(connectors.orgId, args.orgId),
          ),
        );
    });
    signal.throwIfAborted();
    return undefined;
  },
);

async function loadStoredValuesForConnector(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
}): Promise<readonly StoredValueRow[]> {
  const [valueRows, legacyRows] = await Promise.all([
    args.db
      .select({
        connectorId: orgCustomConnectorValues.connectorId,
        kind: orgCustomConnectorValues.kind,
        key: orgCustomConnectorValues.key,
        encryptedValue: orgCustomConnectorValues.encryptedValue,
      })
      .from(orgCustomConnectorValues)
      .where(
        and(
          eq(orgCustomConnectorValues.orgId, args.orgId),
          eq(orgCustomConnectorValues.userId, args.userId),
          eq(orgCustomConnectorValues.connectorId, args.connectorId),
        ),
      ),
    args.db
      .select({
        connectorId: orgCustomConnectorSecrets.connectorId,
        encryptedValue: orgCustomConnectorSecrets.encryptedValue,
      })
      .from(orgCustomConnectorSecrets)
      .where(
        and(
          eq(orgCustomConnectorSecrets.orgId, args.orgId),
          eq(orgCustomConnectorSecrets.userId, args.userId),
          eq(orgCustomConnectorSecrets.connectorId, args.connectorId),
        ),
      ),
  ]);
  const rows: StoredValueRow[] = valueRows
    .filter((row): row is StoredValueRow => {
      return row.kind === "secret" || row.kind === "variable";
    })
    .map((row) => {
      return {
        connectorId: row.connectorId,
        kind: row.kind,
        key: row.key,
        encryptedValue: row.encryptedValue,
      };
    });
  const hasLegacySecret = rows.some((row) => {
    return row.kind === "secret" && row.key === LEGACY_SECRET_KEY;
  });
  for (const row of legacyRows) {
    if (!hasLegacySecret) {
      rows.push({
        connectorId: row.connectorId,
        kind: "secret",
        key: LEGACY_SECRET_KEY,
        encryptedValue: row.encryptedValue,
      });
    }
  }
  return rows;
}

export async function decryptCustomConnectorValues(args: {
  readonly values: readonly StoredValueRow[];
  readonly featureSwitchContext: FeatureSwitchContextArg;
}): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const value of args.values) {
    result[customConnectorValueMarkerKey(value)] =
      await decryptStoredSecretValue(
        value.encryptedValue,
        args.featureSwitchContext,
      );
  }
  return result;
}

export function customConnectorInternalName(connectorId: string): string {
  return `custom_connector_${connectorId.replaceAll("-", "")}`;
}

export function customConnectorSecretKey(args: {
  readonly connectorId: string;
  readonly kind: CustomConnectorFieldKind;
  readonly key: string;
}): string {
  const kindPrefix = args.kind === "secret" ? "S" : "V";
  return `CUSTOM_${args.connectorId.replaceAll("-", "")}_${kindPrefix}_${args.key.toUpperCase()}`;
}

export function renderTemplateForRuntime(args: {
  readonly template: string;
  readonly connectorId: string;
  readonly fields: readonly CustomConnectorField[];
  readonly configuredValueMarkers?: ReadonlySet<string>;
}): string | null {
  const fieldByReference = new Map<string, CustomConnectorField>(
    args.fields.map((field) => {
      return [
        `${field.kind === "secret" ? "secrets" : "variables"}.${field.key}`,
        field,
      ] as const;
    }),
  );

  if (
    args.configuredValueMarkers &&
    args.template.includes(LEGACY_SECRET_PLACEHOLDER)
  ) {
    const legacyField = fieldByReference.get(`secrets.${LEGACY_SECRET_KEY}`);
    if (
      !legacyField ||
      !args.configuredValueMarkers.has(
        customConnectorValueMarkerKey(legacyField),
      )
    ) {
      return null;
    }
  }
  for (const match of args.template.matchAll(TEMPLATE_REFERENCE_REGEX)) {
    const namespace = match[1];
    const key = match[2];
    if (!namespace || !key) {
      continue;
    }
    if (
      namespace === "oauth" &&
      key === CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME
    ) {
      if (
        args.configuredValueMarkers &&
        !args.configuredValueMarkers.has(
          customConnectorValueMarkerKey({
            kind: "secret",
            key: CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_RUNTIME_KEY,
          }),
        )
      ) {
        return null;
      }
      continue;
    }
    const field = fieldByReference.get(`${namespace}.${key}`);
    if (!field) {
      return null;
    }
    if (
      args.configuredValueMarkers &&
      !args.configuredValueMarkers.has(customConnectorValueMarkerKey(field))
    ) {
      return null;
    }
  }

  return args.template
    .replaceAll(
      LEGACY_SECRET_PLACEHOLDER,
      `\${{ secrets.${customConnectorSecretKey({
        connectorId: args.connectorId,
        kind: "secret",
        key: LEGACY_SECRET_KEY,
      })} }}`,
    )
    .replaceAll(
      TEMPLATE_REFERENCE_REGEX,
      (_match, namespace: string, key: string) => {
        if (
          namespace === "oauth" &&
          key === CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME
        ) {
          return `\${{ secrets.${customConnectorSecretKey({
            connectorId: args.connectorId,
            kind: "secret",
            key: CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_RUNTIME_KEY,
          })} }}`;
        }
        const field = fieldByReference.get(`${namespace}.${key}`);
        if (!field) {
          return TEMPLATE_PLACEHOLDER_VALUE;
        }
        return `\${{ secrets.${customConnectorSecretKey({
          connectorId: args.connectorId,
          kind: field.kind,
          key: field.key,
        })} }}`;
      },
    );
}

function renderPrefixTemplate(args: {
  readonly template: string;
  readonly values: Readonly<Record<string, string>>;
  readonly connectorName?: string;
}): string | null {
  let missing = false;
  let invalid = false;
  const rendered = args.template.replaceAll(
    TEMPLATE_REFERENCE_REGEX,
    (_match, namespace: string, key: string) => {
      if (namespace !== "variables") {
        missing = true;
        return TEMPLATE_PLACEHOLDER_VALUE;
      }
      const value =
        args.values[customConnectorValueMarkerKey({ kind: "variable", key })];
      if (!value) {
        missing = true;
        return TEMPLATE_PLACEHOLDER_VALUE;
      }
      if (!isSafeHostTemplateVariableValue(value)) {
        invalid = true;
        return TEMPLATE_PLACEHOLDER_VALUE;
      }
      return value;
    },
  );
  if (invalid) {
    throw new CustomConnectorRuntimePrefixError(args.connectorName);
  }
  return missing ? null : rendered;
}

export function renderCustomConnectorRuntimePrefix(args: {
  readonly template: string;
  readonly values: Readonly<Record<string, string>>;
  readonly connectorName?: string;
}): string | null {
  const rendered = renderPrefixTemplate(args);
  if (!rendered) {
    return null;
  }
  const base = expandHostWildcardsInBaseUrl(rendered);
  const validation = safeSync(() => {
    return canonicalizeFirewallBaseUrl(base, "custom connector");
  });
  if ("error" in validation) {
    throw new CustomConnectorRuntimePrefixError(args.connectorName);
  }
  return validation.ok;
}

type CustomConnectorRuntimeDataTimingStep =
  | "connectorRows"
  | "connectorValueRows";
type CustomConnectorRuntimeDataTimingMeasure = <T>(
  step: CustomConnectorRuntimeDataTimingStep,
  operation: () => Promise<T>,
) => Promise<T>;

export async function loadCustomConnectorRuntimeData(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorIds: readonly string[] | undefined;
    readonly measure?: CustomConnectorRuntimeDataTimingMeasure;
  },
): Promise<
  readonly {
    readonly connector: CustomConnectorRow;
    readonly values: readonly StoredValueRow[];
  }[]
> {
  const measure =
    args.measure ??
    (async <T>(
      _step: CustomConnectorRuntimeDataTimingStep,
      operation: () => Promise<T>,
    ) => {
      return await operation();
    });
  const connectorRows = await measure("connectorRows", async () => {
    return await db
      .select({
        connector: orgCustomConnectors,
        oauthConfig: orgCustomConnectorOauthConfigs,
      })
      .from(orgCustomConnectors)
      .leftJoin(
        orgCustomConnectorOauthConfigs,
        and(
          eq(
            orgCustomConnectorOauthConfigs.connectorId,
            orgCustomConnectors.id,
          ),
          eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
        ),
      )
      .where(
        args.connectorIds
          ? and(
              eq(orgCustomConnectors.orgId, args.orgId),
              eq(orgCustomConnectors.enabled, true),
              inArray(orgCustomConnectors.id, [...args.connectorIds]),
            )
          : and(
              eq(orgCustomConnectors.orgId, args.orgId),
              eq(orgCustomConnectors.enabled, true),
            ),
      );
  });
  if (connectorRows.length === 0) {
    return [];
  }

  return await measure("connectorValueRows", async () => {
    return await Promise.all(
      connectorRows.map(async (row) => {
        const connector = normaliseCustomConnectorRow(
          row.connector,
          row.oauthConfig,
        );
        const values = await loadStoredValuesForConnector({
          db,
          orgId: args.orgId,
          userId: args.userId,
          connectorId: connector.id,
        });
        return { connector, values };
      }),
    );
  });
}

interface SaveCustomConnectorProposalArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly isAdmin: boolean;
  readonly proposal: CustomConnectorProposal;
  readonly values: readonly CustomConnectorValueInput[];
  readonly agentId?: string;
}

type ForbiddenResponse = {
  readonly status: 403;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: "FORBIDDEN";
    };
  };
};

type SaveCustomConnectorProposalResult =
  | {
      readonly connector: CustomConnectorResponse;
      readonly authorizedAgentId?: string;
    }
  | BadRequestResponse
  | NotFoundResponse
  | ForbiddenResponse;

function forbidden(message: string): ForbiddenResponse {
  return {
    status: 403,
    body: {
      error: {
        message,
        code: "FORBIDDEN",
      },
    },
  };
}

function proposalUpdateInput(
  proposal: CustomConnectorProposal,
): UpdateCustomConnectorBody {
  return {
    displayName: proposal.displayName,
    prefixTemplates: proposal.prefixTemplates,
    fields: proposal.fields,
    headerInjections: proposal.headerInjections,
    queryInjections: proposal.queryInjections,
  };
}

const saveProposalDefinition$ = command(
  async (
    { set },
    args: SaveCustomConnectorProposalArgs & {
      readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot;
    },
    signal: AbortSignal,
  ): Promise<
    | CustomConnectorRow
    | BadRequestResponse
    | NotFoundResponse
    | ForbiddenResponse
  > => {
    const updateInput = proposalUpdateInput(args.proposal);
    if (args.proposal.operation === "create") {
      if (!args.isAdmin) {
        return forbidden("Only org admins can create custom connectors");
      }
      return await set(
        createCustomConnector$,
        {
          orgId: args.orgId,
          userId: args.userId,
          input: updateInput,
          connectorCatalogSnapshot: args.connectorCatalogSnapshot,
        },
        signal,
      );
    }
    if (!args.proposal.connectorId) {
      return badRequestMessage("connectorId is required for updates");
    }
    if (!args.isAdmin) {
      return forbidden("Only org admins can update custom connectors");
    }
    return await set(
      updateCustomConnectorDefinition$,
      {
        orgId: args.orgId,
        userId: args.userId,
        id: args.proposal.connectorId,
        input: updateInput,
        connectorCatalogSnapshot: args.connectorCatalogSnapshot,
      },
      signal,
    );
  },
);

const authorizeProposalAgent$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly agentId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<string | undefined | NotFoundResponse> => {
    if (!args.agentId) {
      return undefined;
    }
    const writeDb = set(writeDb$);
    const added = await addUserCustomConnector(writeDb, {
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.agentId,
      customConnectorId: args.connectorId,
    });
    signal.throwIfAborted();
    if (added.status === "agentNotFound") {
      return notFound("Agent not found");
    }
    if (added.status === "customConnectorsNotFound") {
      return notFound("Custom connector not found");
    }
    if (added.status === "customConnectorsNotConfigured") {
      return undefined;
    }
    return args.agentId;
  },
);

export const saveCustomConnectorProposal$ = command(
  async (
    { get, set },
    args: SaveCustomConnectorProposalArgs,
    signal: AbortSignal,
  ): Promise<SaveCustomConnectorProposalResult> => {
    const connectorCatalogSnapshot = await loadConnectorRuntimeSnapshot(
      get(db$),
    );
    signal.throwIfAborted();
    const proposalDefinition = validateDefinition(
      definitionFromUpdateInput(proposalUpdateInput(args.proposal)),
      connectorCatalogSnapshot.serverFirewalls,
    );
    if (isBadRequest(proposalDefinition)) {
      return proposalDefinition;
    }
    const proposalValues = validateValueInputsForDefinition({
      fields: proposalDefinition.fields,
      prefixTemplates: proposalDefinition.prefixTemplates,
      values: args.values,
    });
    if (isBadRequest(proposalValues)) {
      return proposalValues;
    }

    const connector = await set(
      saveProposalDefinition$,
      { ...args, connectorCatalogSnapshot },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in connector) {
      return connector;
    }

    const valueResult = await set(
      setCustomConnectorValues$,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorId: connector.id,
        values: args.values,
        syncLegacySecret: true,
      },
      signal,
    );
    if ("status" in valueResult) {
      return valueResult;
    }

    const authorizedAgentId = await set(
      authorizeProposalAgent$,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorId: connector.id,
        agentId: args.agentId,
      },
      signal,
    );
    if (authorizedAgentId && typeof authorizedAgentId !== "string") {
      return authorizedAgentId;
    }

    const response = await get(
      getCustomConnectorResponse({
        orgId: args.orgId,
        userId: args.userId,
        connectorId: connector.id,
      }),
    );
    signal.throwIfAborted();
    if (!response) {
      return notFound("Custom connector not found");
    }
    return {
      connector: response,
      ...(authorizedAgentId ? { authorizedAgentId } : {}),
    };
  },
);
