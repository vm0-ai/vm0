import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import type { ConnectorType } from "../../connectors/src/connectors";
import { expandFirewallPlaceholders } from "../../connectors/src/firewall-placeholder-expansion";
import {
  extractBaseUrlVarNames,
  extractSecretNamesFromApis,
  firewallAuthInjectsCredentials,
  hasBaseUrlVars,
  type FirewallConfig,
  type FirewallPolicy,
  type FirewallPolicyValue,
} from "../../connectors/src/firewall-types";
import type {
  FirewallExecutionMetadataDetail,
  FirewallExecutionMetadataSummary,
} from "../../connectors/src/firewall-execution-metadata/types";
import type {
  FirewallPermissionDefaultPolicyMetadata,
  FirewallPermissionDetailMetadata,
  FirewallPermissionMetadataPermission,
  FirewallPermissionSummaryMetadata,
} from "../../connectors/src/firewall-metadata/types";
import type { FirewallConnectorType } from "../../connectors/src/firewalls";

const POLICY_VALUES = ["allow", "deny", "ask"] as const;
const GENERATED_FILE_STEM_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_FIREWALL_SECRET_PLACEHOLDER =
  "c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe";

interface ConnectorCategories {
  readonly categories: Record<string, string>;
  readonly displayOrder: readonly string[];
}

interface GeneratedFirewallSource {
  readonly type: FirewallConnectorType;
  readonly firewallExportName: string;
  readonly firewall: FirewallConfig;
  readonly label: string;
  readonly categories: ConnectorCategories | null;
  readonly defaultAllowed: readonly string[] | null;
  readonly defaultUnknownPolicy: FirewallPolicyValue;
}

interface RegisteredFirewallSource {
  readonly type: FirewallConnectorType;
  readonly firewallExportName: string;
}

interface GeneratedPathReplacement {
  commit: () => void;
  rollback: () => void;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      return typeof item === "string";
    })
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((item) => {
    return typeof item === "string";
  });
}

function isFirewallConfig(value: unknown): value is FirewallConfig {
  return isRecord(value) && Array.isArray(value.apis);
}

function isPolicyValue(value: unknown): value is FirewallPolicyValue {
  return value === "allow" || value === "deny" || value === "ask";
}

function generatedExportCandidates(
  moduleExports: Readonly<Record<string, unknown>>,
  suffix: string,
): [string, unknown][] {
  return Object.entries(moduleExports).filter(([name]) => {
    return name.endsWith(suffix);
  });
}

function getRequiredGeneratedExport<T>(
  moduleExports: Readonly<Record<string, unknown>>,
  type: FirewallConnectorType,
  suffix: string,
  isExpected: (value: unknown) => value is T,
): T {
  const matches = generatedExportCandidates(moduleExports, suffix);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${suffix} export for firewall metadata: ${type}`,
    );
  }
  const match = matches[0];
  if (!match) {
    throw new Error(
      `Expected exactly one ${suffix} export for firewall metadata: ${type}`,
    );
  }
  const [name, value] = match;
  if (!isExpected(value)) {
    throw new Error(
      `Unexpected ${name} export shape for firewall metadata: ${type}`,
    );
  }
  return value;
}

function getRequiredGeneratedExportByName<T>(
  moduleExports: Readonly<Record<string, unknown>>,
  type: FirewallConnectorType,
  name: string,
  isExpected: (value: unknown) => value is T,
): T {
  const value = moduleExports[name];
  if (!isExpected(value)) {
    throw new Error(
      `Unexpected ${name} export shape for firewall metadata: ${type}`,
    );
  }
  return value;
}

function getOptionalGeneratedExport<T>(
  moduleExports: Readonly<Record<string, unknown>>,
  type: FirewallConnectorType,
  suffix: string,
  isExpected: (value: unknown) => value is T,
): T | null {
  const matches = generatedExportCandidates(moduleExports, suffix);
  if (matches.length > 1) {
    throw new Error(
      `Expected at most one ${suffix} export for firewall metadata: ${type}`,
    );
  }
  const [match] = matches;
  if (!match) {
    return null;
  }
  const [name, value] = match;
  if (!isExpected(value)) {
    throw new Error(
      `Unexpected ${name} export shape for firewall metadata: ${type}`,
    );
  }
  return value;
}

async function importModule(
  filePath: string,
): Promise<Record<string, unknown>> {
  const moduleExports: unknown = await import(pathToFileURL(filePath).href);
  if (!isRecord(moduleExports)) {
    throw new Error(`Expected module exports object: ${filePath}`);
  }
  return moduleExports;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return null;
}

function unwrapObjectLiteral(
  expression: ts.Expression,
): ts.ObjectLiteralExpression | null {
  if (ts.isObjectLiteralExpression(expression)) {
    return expression;
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  ) {
    return unwrapObjectLiteral(expression.expression);
  }
  return null;
}

function unwrapArrayLiteral(
  expression: ts.Expression,
): ts.ArrayLiteralExpression | null {
  if (ts.isArrayLiteralExpression(expression)) {
    return expression;
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  ) {
    return unwrapArrayLiteral(expression.expression);
  }
  return null;
}

function findObjectProperty(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.Expression | null {
  let result: ts.Expression | null = null;
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    if (propertyNameText(property.name) !== propertyName) {
      continue;
    }
    if (result) {
      throw new Error(`Duplicate object property in firewall metadata source`);
    }
    result = property.initializer;
  }
  return result;
}

function stringLiteralText(expression: ts.Expression): string | null {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  return null;
}

function loadConnectorLabel(
  connectorsDir: string,
  type: FirewallConnectorType,
): string {
  const connectorFile = path.join(connectorsDir, `${type}.ts`);
  if (!fs.existsSync(connectorFile)) {
    throw new Error(
      `Firewall connector is missing connector metadata: ${type}`,
    );
  }

  const source = fs.readFileSync(connectorFile, "utf-8");
  const sourceFile = ts.createSourceFile(
    connectorFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer) {
        continue;
      }
      const connectorDefinitions = unwrapObjectLiteral(declaration.initializer);
      if (!connectorDefinitions) {
        continue;
      }
      const connector = findObjectProperty(connectorDefinitions, type);
      const connectorObject = connector ? unwrapObjectLiteral(connector) : null;
      if (!connectorObject) {
        continue;
      }
      const label = findObjectProperty(connectorObject, "label");
      if (!label) {
        continue;
      }
      const labelText = stringLiteralText(label);
      if (labelText !== null) {
        return labelText;
      }
    }
  }

  throw new Error(`Firewall connector is missing connector metadata: ${type}`);
}

function buildDefaultPolicy(
  firewall: FirewallConfig,
  defaultAllowed: readonly string[] | null,
  defaultUnknownPolicy: FirewallPolicyValue,
): FirewallPolicy {
  const allowSet = defaultAllowed ? new Set<string>(defaultAllowed) : null;
  const policies: Record<string, FirewallPolicyValue> = {};
  for (const api of firewall.apis) {
    for (const permission of api.permissions ?? []) {
      policies[permission.name] =
        !allowSet || allowSet.has(permission.name) ? "allow" : "deny";
    }
  }
  return { policies, unknownPolicy: defaultUnknownPolicy };
}

async function loadGeneratedFirewallSource(
  firewallsDir: string,
  connectorsDir: string,
  registration: RegisteredFirewallSource,
): Promise<GeneratedFirewallSource> {
  const { type, firewallExportName } = registration;
  const moduleExports = await importModule(
    path.join(firewallsDir, generatedDetailFileName(type)),
  );
  const firewall = getRequiredGeneratedExportByName(
    moduleExports,
    type,
    firewallExportName,
    isFirewallConfig,
  );
  const categories = getOptionalGeneratedExport(
    moduleExports,
    type,
    "Categories",
    isStringRecord,
  );
  const displayOrder = getOptionalGeneratedExport(
    moduleExports,
    type,
    "CategoryOrder",
    isStringArray,
  );
  if ((categories === null) !== (displayOrder === null)) {
    throw new Error(
      `Firewall metadata categories are incomplete for connector: ${type}`,
    );
  }

  return {
    type,
    firewallExportName,
    firewall,
    label: loadConnectorLabel(connectorsDir, type),
    categories:
      categories && displayOrder ? { categories, displayOrder } : null,
    defaultAllowed: getOptionalGeneratedExport(
      moduleExports,
      type,
      "DefaultAllowed",
      isStringArray,
    ),
    defaultUnknownPolicy:
      getOptionalGeneratedExport(
        moduleExports,
        type,
        "DefaultUnknownPolicy",
        isPolicyValue,
      ) ?? "allow",
  };
}

function findConnectorFirewallsRegistry(
  sourceFile: ts.SourceFile,
): ts.ObjectLiteralExpression | null {
  let registry: ts.ObjectLiteralExpression | null = null;

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "CONNECTOR_FIREWALLS" &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const [firstArgument] = node.initializer.arguments;
      if (firstArgument) {
        registry = unwrapObjectLiteral(firstArgument);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return registry;
}

function findVariableInitializer(
  sourceFile: ts.SourceFile,
  variableName: string,
): ts.Expression | null {
  let initializer: ts.Expression | null = null;

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer
    ) {
      if (initializer) {
        throw new Error(`Duplicate variable declaration: ${variableName}`);
      }
      initializer = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return initializer;
}

function extractRegisteredFirewallSources(
  firewallsIndexFile: string,
): RegisteredFirewallSource[] {
  const source = fs.readFileSync(firewallsIndexFile, "utf-8");
  const sourceFile = ts.createSourceFile(
    firewallsIndexFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const registry = findConnectorFirewallsRegistry(sourceFile);

  if (!registry) {
    throw new Error("Unable to find CONNECTOR_FIREWALLS registry");
  }

  return registry.properties.map((property) => {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error("CONNECTOR_FIREWALLS must only contain property entries");
    }
    const name = propertyNameText(property.name);
    if (!name) {
      throw new Error("CONNECTOR_FIREWALLS contains an unsupported key");
    }
    if (!ts.isIdentifier(property.initializer)) {
      throw new Error(
        `CONNECTOR_FIREWALLS contains an unsupported value for: ${name}`,
      );
    }
    return {
      type: name as FirewallConnectorType,
      firewallExportName: property.initializer.text,
    };
  });
}

function extractBillableConnectorTypes(
  firewallsIndexFile: string,
): ReadonlySet<FirewallConnectorType> {
  const source = fs.readFileSync(firewallsIndexFile, "utf-8");
  const sourceFile = ts.createSourceFile(
    firewallsIndexFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const initializer = findVariableInitializer(
    sourceFile,
    "BILLABLE_CONNECTORS",
  );
  const entries = initializer ? unwrapArrayLiteral(initializer) : null;
  if (!entries) {
    throw new Error("Unable to find BILLABLE_CONNECTORS registry");
  }

  const billable = new Set<FirewallConnectorType>();
  for (const element of entries.elements) {
    const type = stringLiteralText(element);
    if (type === null) {
      throw new Error("BILLABLE_CONNECTORS must only contain string entries");
    }
    billable.add(type as FirewallConnectorType);
  }
  return billable;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function generatedHeader(): string {
  return [
    "// Auto-generated by @vm0/firewalls-generator.",
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
  ].join("\n");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function writeGeneratedFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    throw new Error(`Generated metadata file is empty: ${filePath}`);
  }
}

function generatedDetailFileName(type: FirewallConnectorType): string {
  if (!GENERATED_FILE_STEM_PATTERN.test(type)) {
    throw new Error(
      `Unsupported firewall metadata generated file name: ${type}`,
    );
  }
  return `${type}.generated.ts`;
}

function generatedDetailModuleSpecifier(type: FirewallConnectorType): string {
  return `./details/${generatedDetailFileName(type).replace(/\.ts$/, "")}`;
}

function generatedRuntimeModuleSpecifier(type: FirewallConnectorType): string {
  return `./${generatedDetailFileName(type).replace(/\.ts$/, "")}`;
}

function replaceGeneratedPath(
  targetPath: string,
  nextPath: string,
): GeneratedPathReplacement {
  const previousPath = fs.existsSync(targetPath)
    ? path.join(
        path.dirname(targetPath),
        `.${path.basename(targetPath)}.previous-${process.pid}-${Date.now()}`,
      )
    : null;
  let previousMoved = false;
  let nextMoved = false;

  try {
    if (previousPath) {
      fs.renameSync(targetPath, previousPath);
      previousMoved = true;
    }
    fs.renameSync(nextPath, targetPath);
    nextMoved = true;
  } catch (error) {
    if (previousPath && previousMoved && !fs.existsSync(targetPath)) {
      fs.renameSync(previousPath, targetPath);
    }
    throw error;
  } finally {
    if (!nextMoved) {
      fs.rmSync(nextPath, { recursive: true, force: true });
    }
  }

  return {
    commit: () => {
      if (previousPath) {
        fs.rmSync(previousPath, { recursive: true, force: true });
      }
    },
    rollback: () => {
      fs.rmSync(targetPath, { recursive: true, force: true });
      if (previousPath && fs.existsSync(previousPath)) {
        fs.renameSync(previousPath, targetPath);
      }
    },
  };
}

function rollbackGeneratedReplacements(
  replacements: readonly GeneratedPathReplacement[],
): void {
  for (const replacement of [...replacements].reverse()) {
    replacement.rollback();
  }
}

function collectPermissions(
  firewall: FirewallConfig,
): FirewallPermissionMetadataPermission[] {
  const permissions = new Map<string, FirewallPermissionMetadataPermission>();
  for (const api of firewall.apis) {
    for (const permission of api.permissions ?? []) {
      if (!permissions.has(permission.name)) {
        permissions.set(permission.name, {
          name: permission.name,
          ...(permission.description !== undefined
            ? { description: permission.description }
            : {}),
        });
      }
    }
  }
  return [...permissions.values()].sort((a, b) => {
    return compareStrings(a.name, b.name);
  });
}

function sortedRecord(
  entries: Iterable<readonly [string, string]>,
): Record<string, string> {
  return Object.fromEntries(
    [...entries].sort(([a], [b]) => compareStrings(a, b)),
  );
}

function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort(compareStrings);
}

function fixedFirewallApiBaseHost(base: string): string | null {
  if (base.includes("${{")) {
    return null;
  }
  try {
    return new URL(base).host;
  } catch {
    return null;
  }
}

function buildFixedHostOwners(
  sources: readonly GeneratedFirewallSource[],
): Record<string, string> {
  const owners = new Map<string, string>();
  for (const source of sources) {
    for (const api of source.firewall.apis) {
      const host = fixedFirewallApiBaseHost(api.base);
      if (!host || owners.has(host)) {
        continue;
      }
      owners.set(host, source.type);
    }
  }
  return sortedRecord(owners.entries());
}

function choosePermissionDefault(policy: FirewallPolicy): FirewallPolicyValue {
  const counts = new Map<FirewallPolicyValue, number>(
    POLICY_VALUES.map((value) => {
      return [value, 0];
    }),
  );
  for (const value of Object.values(policy.policies)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return POLICY_VALUES.reduce<FirewallPolicyValue>((best, candidate) => {
    const bestCount = counts.get(best) ?? 0;
    const candidateCount = counts.get(candidate) ?? 0;
    return candidateCount > bestCount ? candidate : best;
  }, "allow");
}

function compactDefaultPolicy(
  policy: FirewallPolicy,
): FirewallPermissionDefaultPolicyMetadata {
  const permissionDefault = choosePermissionDefault(policy);
  const permissionOverrides: Partial<Record<FirewallPolicyValue, string[]>> =
    {};

  for (const value of POLICY_VALUES) {
    if (value === permissionDefault) {
      continue;
    }
    const permissions = Object.entries(policy.policies)
      .filter(([, policyValue]) => {
        return policyValue === value;
      })
      .map(([permission]) => {
        return permission;
      })
      .sort(compareStrings);
    if (permissions.length > 0) {
      permissionOverrides[value] = permissions;
    }
  }

  return {
    permissionDefault,
    ...(Object.keys(permissionOverrides).length > 0
      ? { permissionOverrides }
      : {}),
    unknownPolicy: policy.unknownPolicy ?? "allow",
  };
}

function hasDefaultPolicyOverrides(
  defaultPolicy: FirewallPermissionDefaultPolicyMetadata,
): boolean {
  return (
    defaultPolicy.permissionDefault !== "allow" ||
    defaultPolicy.unknownPolicy !== "allow" ||
    Object.keys(defaultPolicy.permissionOverrides ?? {}).length > 0
  );
}

function buildDetailMetadata(
  source: GeneratedFirewallSource,
): FirewallPermissionDetailMetadata {
  const permissions = collectPermissions(source.firewall);
  const defaultPolicy = compactDefaultPolicy(
    buildDefaultPolicy(
      source.firewall,
      source.defaultAllowed,
      source.defaultUnknownPolicy,
    ),
  );

  return {
    type: source.type as FirewallConnectorType & ConnectorType,
    label: source.label,
    permissionCount: permissions.length,
    permissions,
    ...(source.categories
      ? {
          categories: {
            categories: sortedRecord(
              Object.entries(source.categories.categories),
            ),
            displayOrder: [...source.categories.displayOrder],
          },
        }
      : {}),
    defaultPolicy,
  };
}

function buildSummaryMetadata(
  detail: FirewallPermissionDetailMetadata,
): FirewallPermissionSummaryMetadata {
  return {
    type: detail.type,
    label: detail.label,
    hasPermissions: detail.permissionCount > 0,
    permissionCount: detail.permissionCount,
    hasCategories: detail.categories !== undefined,
    hasDefaultPolicyOverrides: hasDefaultPolicyOverrides(detail.defaultPolicy),
  };
}

function buildExecutionBaseUrlTemplates(
  firewall: FirewallConfig,
): FirewallExecutionMetadataDetail["baseUrlTemplates"] {
  const templates = new Map<string, boolean>();
  for (const api of firewall.apis) {
    if (!hasBaseUrlVars(api.base)) {
      continue;
    }
    templates.set(
      api.base,
      (templates.get(api.base) ?? false) ||
        firewallAuthInjectsCredentials(api.auth),
    );
  }
  return [...templates.entries()]
    .sort(([a], [b]) => {
      return compareStrings(a, b);
    })
    .map(([base, credentialed]) => {
      return { base, credentialed };
    });
}

function buildExecutionPlaceholderValues(
  firewall: FirewallConfig,
): Record<string, string> {
  const placeholders: Record<string, string> = {};
  const secretNames = extractSecretNamesFromApis(firewall.apis);
  for (const name of secretNames) {
    placeholders[name] =
      firewall.placeholders?.[name] ?? DEFAULT_FIREWALL_SECRET_PLACEHOLDER;
  }
  for (const [name, value] of Object.entries(firewall.placeholders ?? {})) {
    placeholders[name] = value;
  }
  return sortedRecord(Object.entries(placeholders));
}

function buildExecutionMetadata(
  source: GeneratedFirewallSource,
  billableTypes: ReadonlySet<FirewallConnectorType>,
): FirewallExecutionMetadataDetail {
  const firewall = expandFirewallPlaceholders(
    source.firewall,
    source.type as ConnectorType,
  );
  const baseUrlTemplates = buildExecutionBaseUrlTemplates(firewall);
  const baseUrlVarNames = sortedStrings(
    new Set(
      baseUrlTemplates.flatMap((template) => {
        return extractBaseUrlVarNames(template.base);
      }),
    ),
  );
  const placeholderValues = buildExecutionPlaceholderValues(firewall);

  return {
    type: source.type as FirewallConnectorType & ConnectorType,
    billable: billableTypes.has(source.type),
    baseUrlVarNames,
    baseUrlTemplates,
    secretPlaceholderNames: Object.keys(placeholderValues),
    placeholderValues,
  };
}

function buildExecutionSummaryMetadata(
  detail: FirewallExecutionMetadataDetail,
): FirewallExecutionMetadataSummary {
  return {
    type: detail.type,
    billable: detail.billable,
  };
}

function renderDetailFile(metadata: FirewallPermissionDetailMetadata): string {
  return `${generatedHeader()}import type { FirewallPermissionDetailMetadata } from "../types";

export const firewallPermissionMetadata = ${stableJson(metadata)} as const satisfies FirewallPermissionDetailMetadata;
`;
}

function renderExecutionDetailFile(
  metadata: FirewallExecutionMetadataDetail,
): string {
  return `${generatedHeader()}import type { FirewallExecutionMetadataDetail } from "../types";

export const firewallExecutionMetadata = ${stableJson(metadata)} as const satisfies FirewallExecutionMetadataDetail;
`;
}

function renderSummaryFile(
  summaries: Record<string, FirewallPermissionSummaryMetadata>,
): string {
  return `${generatedHeader()}import type { FirewallPermissionSummaryMetadata } from "./types";

export const FIREWALL_PERMISSION_METADATA_SUMMARIES = ${stableJson(summaries)} as const satisfies Readonly<Record<string, FirewallPermissionSummaryMetadata>>;
`;
}

function renderExecutionSummaryFile(
  summaries: Record<string, FirewallExecutionMetadataSummary>,
): string {
  return `${generatedHeader()}import type { FirewallExecutionMetadataSummary } from "./types";

export const FIREWALL_EXECUTION_METADATA_SUMMARIES = ${stableJson(summaries)} as const satisfies Readonly<Record<string, FirewallExecutionMetadataSummary>>;
`;
}

function renderServerFile(fixedHostOwners: Record<string, string>): string {
  return `${generatedHeader()}import type { FirewallPermissionSummaryMetadata } from "./types";

export const BUILTIN_FIREWALL_FIXED_HOST_OWNERS = ${stableJson(fixedHostOwners)} as const satisfies Readonly<Record<string, FirewallPermissionSummaryMetadata["type"]>>;
`;
}

function renderExecutionLoaderFile(
  types: readonly FirewallConnectorType[],
): string {
  const loaders = types
    .map((type) => {
      const key = JSON.stringify(type);
      const specifier = JSON.stringify(generatedDetailModuleSpecifier(type));
      return `  ${key}: async () => {
    return (await import(${specifier})).firewallExecutionMetadata;
  },`;
    })
    .join("\n");

  return `${generatedHeader()}import type { FirewallExecutionMetadataDetail } from "./types";

const FIREWALL_EXECUTION_METADATA_LOADERS: Readonly<
  Record<string, () => Promise<FirewallExecutionMetadataDetail>>
> = {
${loaders}
};

export async function loadGeneratedFirewallExecutionMetadata(
  type: string,
): Promise<FirewallExecutionMetadataDetail | null> {
  const load = FIREWALL_EXECUTION_METADATA_LOADERS[type];
  if (!load) {
    return null;
  }
  return await load();
}
`;
}

function renderLoaderFile(types: readonly FirewallConnectorType[]): string {
  const loaders = types
    .map((type) => {
      const key = JSON.stringify(type);
      const specifier = JSON.stringify(generatedDetailModuleSpecifier(type));
      return `  ${key}: async () => {
    return (await import(${specifier})).firewallPermissionMetadata;
  },`;
    })
    .join("\n");

  return `${generatedHeader()}import type { FirewallPermissionDetailMetadata } from "./types";

const FIREWALL_PERMISSION_METADATA_LOADERS: Readonly<
  Record<string, () => Promise<FirewallPermissionDetailMetadata>>
> = {
${loaders}
};

export async function loadGeneratedFirewallPermissionMetadata(
  type: string,
): Promise<FirewallPermissionDetailMetadata | null> {
  const load = FIREWALL_PERMISSION_METADATA_LOADERS[type];
  if (!load) {
    return null;
  }
  return await load();
}
`;
}

function renderRuntimeLoaderFile(
  sources: readonly GeneratedFirewallSource[],
): string {
  const connectorTypes = sources
    .map((source) => {
      return `  ${JSON.stringify(source.type)},`;
    })
    .join("\n");
  const loaders = sources
    .map((source) => {
      const key = JSON.stringify(source.type);
      const specifier = JSON.stringify(
        generatedRuntimeModuleSpecifier(source.type),
      );
      return `  ${key}: async () => {
    return (await import(${specifier})).${source.firewallExportName};
  },`;
    })
    .join("\n");

  return `${generatedHeader()}import type { FirewallConfig } from "../firewall-types";

export const RUNTIME_FIREWALL_CONNECTOR_TYPES = [
${connectorTypes}
] as const;

export type GeneratedRuntimeFirewallConnectorType =
  (typeof RUNTIME_FIREWALL_CONNECTOR_TYPES)[number];

const GENERATED_RUNTIME_FIREWALL_LOADERS: Readonly<
  Record<GeneratedRuntimeFirewallConnectorType, () => Promise<FirewallConfig>>
> = {
${loaders}
};

export function hasGeneratedRuntimeFirewall(
  type: string,
): type is GeneratedRuntimeFirewallConnectorType {
  return Object.prototype.hasOwnProperty.call(
    GENERATED_RUNTIME_FIREWALL_LOADERS,
    type,
  );
}

export async function loadGeneratedRuntimeFirewall(
  type: GeneratedRuntimeFirewallConnectorType,
): Promise<FirewallConfig> {
  return await GENERATED_RUNTIME_FIREWALL_LOADERS[type]();
}
`;
}

export async function generateFirewallMetadata(): Promise<void> {
  console.error("\n=== firewall metadata ===");

  const firewallsDir = path.resolve(
    import.meta.dirname,
    "../../connectors/src/firewalls",
  );
  const connectorsDir = path.resolve(
    import.meta.dirname,
    "../../connectors/src/connectors",
  );
  const firewallsIndexFile = path.join(firewallsDir, "index.ts");
  const outputDir = path.resolve(
    import.meta.dirname,
    "../../connectors/src/firewall-metadata",
  );
  const executionOutputDir = path.resolve(
    import.meta.dirname,
    "../../connectors/src/firewall-execution-metadata",
  );
  const summaryFile = path.join(outputDir, "summary.generated.ts");
  const loaderFile = path.join(outputDir, "loader.generated.ts");
  const serverFile = path.join(outputDir, "server.generated.ts");
  const detailsDir = path.join(outputDir, "details");
  const executionSummaryFile = path.join(
    executionOutputDir,
    "summary.generated.ts",
  );
  const executionLoaderFile = path.join(
    executionOutputDir,
    "loader.generated.ts",
  );
  const executionDetailsDir = path.join(executionOutputDir, "details");
  const runtimeLoaderFile = path.join(
    firewallsDir,
    "runtime-loader.generated.ts",
  );

  const registeredSources =
    extractRegisteredFirewallSources(firewallsIndexFile);
  const billableTypes = extractBillableConnectorTypes(firewallsIndexFile);
  const sources = await Promise.all(
    [...registeredSources]
      .sort((a, b) => {
        return compareStrings(a.type, b.type);
      })
      .map((registration) => {
        return loadGeneratedFirewallSource(
          firewallsDir,
          connectorsDir,
          registration,
        );
      }),
  );
  const sourceByType = new Map<FirewallConnectorType, GeneratedFirewallSource>(
    sources.map((source) => {
      return [source.type, source];
    }),
  );
  const registryOrderedSources = registeredSources.map(({ type }) => {
    const source = sourceByType.get(type);
    if (!source) {
      throw new Error(`Missing firewall metadata source: ${type}`);
    }
    return source;
  });
  const summaries: Record<string, FirewallPermissionSummaryMetadata> = {};
  const executionSummaries: Record<string, FirewallExecutionMetadataSummary> =
    {};
  const permissionDetails: {
    readonly type: FirewallConnectorType;
    readonly content: string;
  }[] = [];
  const executionDetails: {
    readonly type: FirewallConnectorType;
    readonly content: string;
  }[] = [];

  for (const source of sources) {
    const detail = buildDetailMetadata(source);
    const executionDetail = buildExecutionMetadata(source, billableTypes);
    summaries[source.type] = buildSummaryMetadata(detail);
    executionSummaries[source.type] =
      buildExecutionSummaryMetadata(executionDetail);
    permissionDetails.push({
      type: source.type,
      content: renderDetailFile(detail),
    });
    executionDetails.push({
      type: source.type,
      content: renderExecutionDetailFile(executionDetail),
    });
  }

  fs.mkdirSync(executionOutputDir, { recursive: true });
  const nextOutputDir = fs.mkdtempSync(path.join(outputDir, ".metadata-"));
  const nextDetailsDir = path.join(nextOutputDir, "details");
  const nextExecutionOutputDir = fs.mkdtempSync(
    path.join(executionOutputDir, ".metadata-"),
  );
  const nextExecutionDetailsDir = path.join(nextExecutionOutputDir, "details");

  for (const detail of permissionDetails) {
    writeGeneratedFile(
      path.join(nextDetailsDir, generatedDetailFileName(detail.type)),
      detail.content,
    );
  }
  for (const detail of executionDetails) {
    writeGeneratedFile(
      path.join(nextExecutionDetailsDir, generatedDetailFileName(detail.type)),
      detail.content,
    );
  }
  writeGeneratedFile(
    path.join(nextOutputDir, "summary.generated.ts"),
    renderSummaryFile(summaries),
  );
  writeGeneratedFile(
    path.join(nextExecutionOutputDir, "summary.generated.ts"),
    renderExecutionSummaryFile(executionSummaries),
  );
  writeGeneratedFile(
    path.join(nextOutputDir, "server.generated.ts"),
    renderServerFile(buildFixedHostOwners(registryOrderedSources)),
  );
  writeGeneratedFile(
    path.join(nextOutputDir, "loader.generated.ts"),
    renderLoaderFile(
      sources.map((source) => {
        return source.type;
      }),
    ),
  );
  writeGeneratedFile(
    path.join(nextExecutionOutputDir, "loader.generated.ts"),
    renderExecutionLoaderFile(
      sources.map((source) => {
        return source.type;
      }),
    ),
  );
  writeGeneratedFile(
    path.join(nextOutputDir, "runtime-loader.generated.ts"),
    renderRuntimeLoaderFile(sources),
  );

  const replacements: GeneratedPathReplacement[] = [];
  try {
    replacements.push(replaceGeneratedPath(detailsDir, nextDetailsDir));
    replacements.push(
      replaceGeneratedPath(
        summaryFile,
        path.join(nextOutputDir, "summary.generated.ts"),
      ),
    );
    replacements.push(
      replaceGeneratedPath(
        loaderFile,
        path.join(nextOutputDir, "loader.generated.ts"),
      ),
    );
    replacements.push(
      replaceGeneratedPath(
        serverFile,
        path.join(nextOutputDir, "server.generated.ts"),
      ),
    );
    replacements.push(
      replaceGeneratedPath(executionDetailsDir, nextExecutionDetailsDir),
    );
    replacements.push(
      replaceGeneratedPath(
        executionSummaryFile,
        path.join(nextExecutionOutputDir, "summary.generated.ts"),
      ),
    );
    replacements.push(
      replaceGeneratedPath(
        executionLoaderFile,
        path.join(nextExecutionOutputDir, "loader.generated.ts"),
      ),
    );
    replacements.push(
      replaceGeneratedPath(
        runtimeLoaderFile,
        path.join(nextOutputDir, "runtime-loader.generated.ts"),
      ),
    );
  } catch (error) {
    rollbackGeneratedReplacements(replacements);
    throw error;
  } finally {
    fs.rmSync(nextOutputDir, { recursive: true, force: true });
    fs.rmSync(nextExecutionOutputDir, { recursive: true, force: true });
  }

  for (const replacement of replacements) {
    replacement.commit();
  }

  console.error(`  Written ${sources.length} metadata detail files`);
}
