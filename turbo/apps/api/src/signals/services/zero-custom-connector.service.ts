import { command, computed, type Computed } from "ccstate";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type {
  CreateCustomConnectorBody,
  CustomConnectorField,
  CustomConnectorFieldKind,
  CustomConnectorHeaderInjection,
  CustomConnectorProposal,
  CustomConnectorQueryInjection,
  CustomConnectorResponse,
  CustomConnectorValueInput,
  UpdateCustomConnectorBody,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { getBuiltinConnectorHostOwner } from "@vm0/connectors/firewall-metadata/server";
import {
  expandHostWildcardsInBaseUrl,
  validateBaseUrl,
} from "@vm0/connectors/firewall-types";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";
import { orgCustomConnectorValues } from "@vm0/db/schema/org-custom-connector-value";

import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { badRequestMessage, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { safeSync, safeUrlParse } from "../utils";
import {
  encryptStoredSecretValue,
  decryptStoredSecretValue,
} from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";
import { addUserCustomConnector } from "./user-connectors.service";

const L = logger("CustomConnectorService");

const LEGACY_SECRET_PLACEHOLDER = "{{secret}}";
const LEGACY_SECRET_KEY = "secret";
const FIELD_KEY_REGEX = /^[a-z][a-z0-9_]{0,63}$/;
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const HEADER_NAME_REGEX = /^[A-Za-z][A-Za-z0-9-]*$/;
const TEMPLATE_REFERENCE_REGEX =
  /\{\{\s*(secrets|variables)\.([a-z][a-z0-9_]*)\s*\}\}/g;
const VARIABLE_REFERENCE_REGEX = /\{\{\s*variables\.[a-z][a-z0-9_]*\s*\}\}/;
const TEMPLATE_PLACEHOLDER_VALUE = "placeholder";
const HOST_TEMPLATE_VALUE_UNSAFE_REGEX = /[/?#\\@:]/;

type BadRequestResponse = ReturnType<typeof badRequestMessage>;
type NotFoundResponse = ReturnType<typeof notFound>;

interface CustomConnectorRow {
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
  readonly slug?: string;
}

interface ValidatedDefinition {
  readonly displayName: string;
  readonly prefixTemplates: readonly string[];
  readonly fields: readonly CustomConnectorField[];
  readonly headerInjections: readonly CustomConnectorHeaderInjection[];
  readonly queryInjections: readonly CustomConnectorQueryInjection[];
  readonly slug: string | undefined;
}

interface ValueMarker {
  readonly connectorId: string;
  readonly kind: CustomConnectorFieldKind;
  readonly key: string;
}

interface StoredValueRow extends ValueMarker {
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
): CustomConnectorRow {
  const prefixTemplates = stringArray(row.prefixTemplates);
  const fields = fieldArray(row.fields);
  const headerInjections = headerInjectionArray(row.headerInjections);
  const queryInjections = queryInjectionArray(row.queryInjections);
  const legacyPrefixes = stringArray(row.prefixes);
  return {
    ...row,
    prefixes: legacyPrefixes,
    prefixTemplates:
      prefixTemplates.length > 0 ? prefixTemplates : legacyPrefixes,
    fields: fields.length > 0 ? fields : canonicalFieldsFromLegacy(),
    headerInjections:
      headerInjections.length > 0
        ? headerInjections
        : [
            {
              name: row.headerName,
              valueTemplate: canonicalHeaderTemplateFromLegacy(
                row.headerTemplate,
              ),
            },
          ],
    queryInjections,
  };
}

function valueMarkerKey(marker: {
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
        return valueMarkerKey(marker);
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
      return configured.has(valueMarkerKey(field));
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
      return field.required && !configured.has(valueMarkerKey(field));
    })
    .map((field) => {
      return field.key;
    });
}

export function serialiseCustomConnector(args: {
  readonly row: CustomConnectorRow;
  readonly valueMarkers: readonly ValueMarker[];
}): CustomConnectorResponse {
  const missingRequiredFields = computeMissingRequiredFields({
    fields: args.row.fields,
    markers: args.valueMarkers.filter((marker) => {
      return marker.connectorId === args.row.id;
    }),
  });
  const configured = configuredFieldKeys({
    fields: args.row.fields,
    markers: args.valueMarkers.filter((marker) => {
      return marker.connectorId === args.row.id;
    }),
  });
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
    connected: missingRequiredFields.length === 0,
    missingRequiredFields: [...missingRequiredFields],
    configuredFieldKeys: [...configured],
    createdAt: args.row.createdAt.toISOString(),
    updatedAt: args.row.updatedAt.toISOString(),
    hasSecret: missingRequiredFields.length === 0,
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
      "Slug must be 3-64 chars, lowercase alphanumeric, and may contain internal hyphens",
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
  readonly namespace: "secrets" | "variables";
  readonly key: string;
}[] {
  return [...template.matchAll(TEMPLATE_REFERENCE_REGEX)].map((match) => {
    return {
      namespace: match[1] === "secrets" ? "secrets" : "variables",
      key: match[2]!,
    };
  });
}

function prefixTemplateVariableKeys(
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
    allowLegacySecret: false,
    context: "Prefix template",
  });
  if (templateError) {
    return templateError;
  }

  const parseable = templateWithPlaceholders(trimmed);
  const url = safeUrlParse(parseable);
  if (!url) {
    return badRequestMessage(`Invalid prefix URL: ${args.raw}`);
  }
  if (url.protocol !== "https:") {
    return badRequestMessage(`Prefix must use https://: ${args.raw}`);
  }
  if (url.search || url.hash) {
    return badRequestMessage(
      `Prefix must not contain query or fragment: ${args.raw}`,
    );
  }

  const normalised = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  const validationBase = expandHostWildcardsInBaseUrl(
    templateWithPlaceholders(normalised),
  );
  const validation = safeSync(() => {
    validateBaseUrl(validationBase, "custom connector");
  });
  if ("error" in validation) {
    const message =
      validation.error instanceof Error
        ? validation.error.message.replace(validationBase, normalised)
        : "not a valid URL";
    return badRequestMessage(`Invalid prefix URL: ${args.raw}: ${message}`);
  }

  if (!normalised.includes("{{")) {
    const host = safeUrlParse(normalised)?.host ?? "";
    const builtinOwner = getBuiltinConnectorHostOwner(host);
    if (builtinOwner) {
      return badRequestMessage(
        `Host "${host}" is already managed by the ${builtinOwner.label} connector`,
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
    const marker = valueMarkerKey({ kind: field.kind, key });
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
      allowSecrets: true,
      allowLegacySecret: true,
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
      allowSecrets: true,
      allowLegacySecret: true,
      context: `Query ${name}`,
    });
    if (templateError) {
      return templateError;
    }
    queries.push({ name, valueTemplate: injection.valueTemplate });
  }
  return queries;
}

function validateDefinition(
  input: DefinitionInput,
): ValidatedDefinition | BadRequestResponse {
  const displayName = validateDisplayName(input.displayName);
  if (isBadRequest(displayName)) {
    return displayName;
  }
  const fields = validateFields(input.fields);
  if (isBadRequest(fields)) {
    return fields;
  }

  const prefixTemplates: string[] = [];
  if (input.prefixTemplates.length === 0) {
    return badRequestMessage("At least one prefix template is required");
  }
  for (const raw of input.prefixTemplates) {
    const normalized = validateAndNormalizePrefixTemplate({ raw, fields });
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
  });
  if (isBadRequest(headerInjections)) {
    return headerInjections;
  }
  const queryInjections = validateQueryInjections({
    raw: input.queryInjections,
    fields,
  });
  if (isBadRequest(queryInjections)) {
    return queryInjections;
  }
  if (headerInjections.length === 0 && queryInjections.length === 0) {
    return badRequestMessage(
      "At least one header or query injection is required",
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
    input.queryInjections !== undefined;
  if (usesCanonical) {
    return {
      displayName: input.displayName,
      prefixTemplates: input.prefixTemplates ?? [],
      fields: input.fields ?? [],
      headerInjections: input.headerInjections ?? [],
      queryInjections: input.queryInjections ?? [],
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
    slug: input.slug,
  };
}

function definitionFromUpdateInput(
  input: UpdateCustomConnectorBody,
): DefinitionInput {
  return {
    displayName: input.displayName,
    prefixTemplates: input.prefixTemplates,
    fields: input.fields,
    headerInjections: input.headerInjections,
    queryInjections: input.queryInjections,
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
  const parsed = safeUrlParse(templateWithPlaceholders(prefix));
  const host = (parsed?.host ?? "").toLowerCase();
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
      return `${marker.connectorId}:${valueMarkerKey(marker)}`;
    }),
  );
  for (const row of legacyRows) {
    const marker = {
      connectorId: row.connectorId,
      kind: "secret" as const,
      key: LEGACY_SECRET_KEY,
    };
    const key = `${marker.connectorId}:${valueMarkerKey(marker)}`;
    if (!existing.has(key)) {
      markers.push(marker);
      existing.add(key);
    }
  }
  return markers;
}

export const createCustomConnector$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly input: CreateCustomConnectorBody;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorRow | BadRequestResponse> => {
    const canonicalInput = definitionFromCreateInput(args.input);
    if (isBadRequest(canonicalInput)) {
      return canonicalInput;
    }
    const v = validateDefinition(canonicalInput);
    if (isBadRequest(v)) {
      return v;
    }
    signal.throwIfAborted();

    const slug =
      v.slug ??
      `${hostSlugFromPrefixTemplate(v.prefixTemplates[0]!)}-${randomShortId()}`;
    const legacy = legacyColumns(v);
    L.debug("creating custom connector", { orgId: args.orgId, slug });

    const writeDb = set(writeDb$);
    const [row] = await writeDb
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
        createdBy: args.userId,
      })
      .returning();
    signal.throwIfAborted();

    if (!row) {
      throw new Error("Expected insert to return a row");
    }

    return normaliseCustomConnectorRow(row);
  },
);

export const updateCustomConnectorDefinition$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly id: string;
      readonly input: UpdateCustomConnectorBody;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorRow | BadRequestResponse | NotFoundResponse> => {
    const v = validateDefinition(definitionFromUpdateInput(args.input));
    if (isBadRequest(v)) {
      return v;
    }
    const legacy = legacyColumns(v);
    const writeDb = set(writeDb$);
    const [row] = await writeDb
      .update(orgCustomConnectors)
      .set({
        displayName: v.displayName,
        prefixes: [...legacy.prefixes],
        headerName: legacy.headerName,
        headerTemplate: legacy.headerTemplate,
        prefixTemplates: [...v.prefixTemplates],
        fields: [...v.fields],
        headerInjections: [...v.headerInjections],
        queryInjections: [...v.queryInjections],
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(orgCustomConnectors.id, args.id),
          eq(orgCustomConnectors.orgId, args.orgId),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!row) {
      return notFound("Custom connector not found");
    }
    return normaliseCustomConnectorRow(row);
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

function getCustomConnectorById(args: {
  readonly orgId: string;
  readonly connectorId: string;
}): Computed<Promise<CustomConnectorRow | null>> {
  return computed(async (get): Promise<CustomConnectorRow | null> => {
    const db = get(db$);
    const [row] = await db
      .select()
      .from(orgCustomConnectors)
      .where(
        and(
          eq(orgCustomConnectors.id, args.connectorId),
          eq(orgCustomConnectors.orgId, args.orgId),
        ),
      )
      .limit(1);
    if (!row) {
      return null;
    }
    return normaliseCustomConnectorRow(row);
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
    const markers = await loadConnectorValueMarkers({
      db,
      orgId: args.orgId,
      userId: args.userId,
    });
    return serialiseCustomConnector({ row: connector, valueMarkers: markers });
  });
}

function validateValueInputsForDefinition(args: {
  readonly fields: readonly CustomConnectorField[];
  readonly prefixTemplates: readonly string[];
  readonly values: readonly CustomConnectorValueInput[];
}): readonly CustomConnectorValueInput[] | BadRequestResponse {
  const allowed = new Set(
    args.fields.map((field) => {
      return valueMarkerKey(field);
    }),
  );
  const prefixVariables = prefixTemplateVariableKeys(args.prefixTemplates);
  const seen = new Set<string>();
  const values: CustomConnectorValueInput[] = [];
  for (const value of args.values) {
    const key = value.key.trim();
    const marker = valueMarkerKey({ kind: value.kind, key });
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

export const deleteCustomConnectorValues$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly syncLegacySecret?: boolean;
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
    await writeDb
      .delete(orgCustomConnectorValues)
      .where(
        and(
          eq(orgCustomConnectorValues.connectorId, args.connectorId),
          eq(orgCustomConnectorValues.userId, args.userId),
          eq(orgCustomConnectorValues.orgId, args.orgId),
        ),
      );
    signal.throwIfAborted();
    if (args.syncLegacySecret) {
      await writeDb
        .delete(orgCustomConnectorSecrets)
        .where(
          and(
            eq(orgCustomConnectorSecrets.connectorId, args.connectorId),
            eq(orgCustomConnectorSecrets.userId, args.userId),
            eq(orgCustomConnectorSecrets.orgId, args.orgId),
          ),
        );
    }
    signal.throwIfAborted();
    return undefined;
  },
);

export const deleteLegacyCustomConnectorSecret$ = command(
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
    await writeDb
      .delete(orgCustomConnectorValues)
      .where(
        and(
          eq(orgCustomConnectorValues.connectorId, args.connectorId),
          eq(orgCustomConnectorValues.userId, args.userId),
          eq(orgCustomConnectorValues.orgId, args.orgId),
          eq(orgCustomConnectorValues.kind, "secret"),
          eq(orgCustomConnectorValues.key, LEGACY_SECRET_KEY),
        ),
      );
    signal.throwIfAborted();
    await writeDb
      .delete(orgCustomConnectorSecrets)
      .where(
        and(
          eq(orgCustomConnectorSecrets.connectorId, args.connectorId),
          eq(orgCustomConnectorSecrets.userId, args.userId),
          eq(orgCustomConnectorSecrets.orgId, args.orgId),
        ),
      );
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
    result[valueMarkerKey(value)] = await decryptStoredSecretValue(
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
    args.template.includes(LEGACY_SECRET_PLACEHOLDER) &&
    !args.configuredValueMarkers.has(
      valueMarkerKey({ kind: "secret", key: LEGACY_SECRET_KEY }),
    )
  ) {
    return null;
  }
  for (const match of args.template.matchAll(TEMPLATE_REFERENCE_REGEX)) {
    const namespace = match[1];
    const key = match[2];
    if (!namespace || !key) {
      continue;
    }
    const field = fieldByReference.get(`${namespace}.${key}`);
    if (
      field &&
      args.configuredValueMarkers &&
      !args.configuredValueMarkers.has(valueMarkerKey(field))
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
}): string | null {
  let missing = false;
  const rendered = args.template.replaceAll(
    TEMPLATE_REFERENCE_REGEX,
    (_match, namespace: string, key: string) => {
      if (namespace !== "variables") {
        missing = true;
        return TEMPLATE_PLACEHOLDER_VALUE;
      }
      const value = args.values[valueMarkerKey({ kind: "variable", key })];
      if (!value || !isSafeHostTemplateVariableValue(value)) {
        missing = true;
        return TEMPLATE_PLACEHOLDER_VALUE;
      }
      return value;
    },
  );
  return missing ? null : rendered;
}

export function renderCustomConnectorRuntimePrefix(args: {
  readonly template: string;
  readonly values: Readonly<Record<string, string>>;
}): string | null {
  const rendered = renderPrefixTemplate(args);
  if (!rendered) {
    return null;
  }
  const base = expandHostWildcardsInBaseUrl(rendered);
  const validation = safeSync(() => {
    validateBaseUrl(base, "custom connector");
  });
  return "error" in validation ? null : base;
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
  const connectors = await measure("connectorRows", async () => {
    return await db
      .select()
      .from(orgCustomConnectors)
      .where(
        args.connectorIds
          ? and(
              eq(orgCustomConnectors.orgId, args.orgId),
              inArray(orgCustomConnectors.id, [...args.connectorIds]),
            )
          : eq(orgCustomConnectors.orgId, args.orgId),
      );
  });
  if (connectors.length === 0) {
    return [];
  }

  return await measure("connectorValueRows", async () => {
    return await Promise.all(
      connectors.map(async (row) => {
        const connector = normaliseCustomConnectorRow(row);
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
    args: SaveCustomConnectorProposalArgs,
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
        id: args.proposal.connectorId,
        input: updateInput,
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
    const proposalDefinition = validateDefinition(
      definitionFromUpdateInput(proposalUpdateInput(args.proposal)),
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

    const connector = await set(saveProposalDefinition$, args, signal);
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
