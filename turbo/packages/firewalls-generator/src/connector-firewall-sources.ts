import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import { collectAndValidatePermissions } from "@vm0/connectors/firewall-expander";
import {
  firewallConfigSchema,
  type FirewallConfig,
  type FirewallPolicyValue,
} from "@vm0/connectors/firewall-types";
import {
  BILLABLE_FIREWALL_CONNECTOR_TYPES,
  FIREWALL_CONNECTOR_TYPES,
  type FirewallConnectorType,
} from "./connector-firewall-manifest";
import { getGeneratedFirewallOutput } from "./codegen";

const GENERATED_METADATA_FILE_STEM_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const FIREWALL_CONFIG_KEYS = new Set([
  "name",
  "description",
  "apis",
  "placeholders",
]);
const FIREWALL_API_KEYS = new Set(["base", "auth", "permissions"]);
const FIREWALL_AUTH_KEYS = new Set(["headers", "base", "query", "awsSigv4"]);
const FIREWALL_AWS_SIGV4_AUTH_KEYS = new Set([
  "accessKeyId",
  "secretAccessKey",
  "sessionToken",
]);
const FIREWALL_PERMISSION_KEYS = new Set(["name", "description", "rules"]);

export interface ConnectorCategories {
  readonly categories: Record<string, string>;
  readonly displayOrder: readonly string[];
}

export interface ConnectorEnvBindingEntry {
  readonly envName: string;
  readonly valueRef: string;
}

interface ConnectorMetadata {
  readonly label: string;
  readonly envBindingEntries: readonly ConnectorEnvBindingEntry[];
}

export interface ConnectorFirewallSource {
  readonly type: FirewallConnectorType;
  readonly firewallExportName: string;
  readonly firewall: FirewallConfig;
  readonly label: string;
  readonly envBindingEntries: readonly ConnectorEnvBindingEntry[];
  readonly categories: ConnectorCategories | null;
  readonly defaultAllowed: readonly string[] | null;
  readonly defaultUnknownPolicy: FirewallPolicyValue;
}

interface ConnectorFirewallSourceSetOptions {
  readonly connectorsDir?: string;
}

interface ConnectorFirewallSourceSet {
  readonly sources: readonly ConnectorFirewallSource[];
  readonly registryOrderedSources: readonly ConnectorFirewallSource[];
  readonly billableTypes: ReadonlySet<FirewallConnectorType>;
}

interface ConnectorFirewallGeneratorModule {
  readonly generate: () => Promise<void>;
}

const generatedModuleCache = new Map<
  FirewallConnectorType,
  {
    readonly source: string;
    readonly moduleExports: Promise<Record<string, unknown>>;
  }
>();
const generatedOutputPromises = new Map<FirewallConnectorType, Promise<void>>();

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isPolicyValue(value: unknown): value is FirewallPolicyValue {
  return value === "allow" || value === "deny" || value === "ask";
}

function unknownObjectKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: ReadonlySet<string>,
): string[] {
  return Object.keys(value)
    .filter((key) => {
      return !allowedKeys.has(key);
    })
    .sort(compareStrings);
}

function assertOnlyObjectKeys(
  value: unknown,
  location: string,
  allowedKeys: ReadonlySet<string>,
): void {
  if (!isRecord(value)) {
    return;
  }
  const unknownKeys = unknownObjectKeys(value, allowedKeys);
  if (unknownKeys.length > 0) {
    throw new Error(
      `Generated firewall config contains unknown keys at ${location}: ${unknownKeys.join(", ")}`,
    );
  }
}

function validateGeneratedFirewallConfigKeys(
  type: FirewallConnectorType,
  value: unknown,
): void {
  assertOnlyObjectKeys(value, type, FIREWALL_CONFIG_KEYS);
  if (!isRecord(value) || !Array.isArray(value.apis)) {
    return;
  }

  for (const [apiIndex, api] of value.apis.entries()) {
    const apiLocation = `${type}.apis[${apiIndex}]`;
    assertOnlyObjectKeys(api, apiLocation, FIREWALL_API_KEYS);
    if (!isRecord(api)) {
      continue;
    }
    assertOnlyObjectKeys(api.auth, `${apiLocation}.auth`, FIREWALL_AUTH_KEYS);
    if (isRecord(api.auth)) {
      assertOnlyObjectKeys(
        api.auth.awsSigv4,
        `${apiLocation}.auth.awsSigv4`,
        FIREWALL_AWS_SIGV4_AUTH_KEYS,
      );
    }
    if (!Array.isArray(api.permissions)) {
      continue;
    }
    for (const [permissionIndex, permission] of api.permissions.entries()) {
      assertOnlyObjectKeys(
        permission,
        `${apiLocation}.permissions[${permissionIndex}]`,
        FIREWALL_PERMISSION_KEYS,
      );
    }
  }
}

function formatZodIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "<root>";
  }
  return path.map((segment) => String(segment)).join(".");
}

function parseGeneratedFirewallConfig(
  type: FirewallConnectorType,
  exportName: string,
  value: unknown,
): FirewallConfig {
  validateGeneratedFirewallConfigKeys(type, value);
  const result = firewallConfigSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Unexpected ${exportName} export shape for firewall metadata: ${type}: ${result.error.issues
        .map((issue) => {
          return `${formatZodIssuePath(issue.path)} ${issue.message}`;
        })
        .join("; ")}`,
    );
  }
  collectAndValidatePermissions(result.data);
  return result.data;
}

function firewallPermissionNames(firewall: FirewallConfig): Set<string> {
  const names = new Set<string>();
  for (const api of firewall.apis) {
    for (const permission of api.permissions ?? []) {
      names.add(permission.name);
    }
  }
  return names;
}

function duplicateStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].sort(compareStrings);
}

function unknownStrings(
  values: Iterable<string>,
  knownValues: ReadonlySet<string>,
): string[] {
  const unknown = new Set<string>();
  for (const value of values) {
    if (!knownValues.has(value)) {
      unknown.add(value);
    }
  }
  return [...unknown].sort(compareStrings);
}

function validateGeneratedDefaultAllowed(
  type: FirewallConnectorType,
  permissionNames: ReadonlySet<string>,
  defaultAllowed: readonly string[] | null,
): void {
  if (defaultAllowed === null) {
    return;
  }

  const duplicates = duplicateStrings(defaultAllowed);
  if (duplicates.length > 0) {
    throw new Error(
      `Generated default allowed permissions contain duplicates for ${type}: ${duplicates.join(", ")}`,
    );
  }

  const unknownPermissions = unknownStrings(defaultAllowed, permissionNames);
  if (unknownPermissions.length > 0) {
    throw new Error(
      `Generated default allowed permissions reference unknown permissions for ${type}: ${unknownPermissions.join(", ")}`,
    );
  }
}

function validateGeneratedCategories(
  type: FirewallConnectorType,
  permissionNames: ReadonlySet<string>,
  categories: ConnectorCategories | null,
): void {
  if (categories === null) {
    return;
  }

  const categoryPermissionNames = new Set(Object.keys(categories.categories));
  const uncategorizedPermissions = unknownStrings(
    permissionNames,
    categoryPermissionNames,
  );
  if (uncategorizedPermissions.length > 0) {
    throw new Error(
      `Generated categories are missing permissions for ${type}: ${uncategorizedPermissions.join(", ")}`,
    );
  }

  const unknownPermissions = unknownStrings(
    categoryPermissionNames,
    permissionNames,
  );
  if (unknownPermissions.length > 0) {
    throw new Error(
      `Generated categories reference unknown permissions for ${type}: ${unknownPermissions.join(", ")}`,
    );
  }

  const duplicateDisplayOrder = duplicateStrings([...categories.displayOrder]);
  if (duplicateDisplayOrder.length > 0) {
    throw new Error(
      `Generated category display order contains duplicates for ${type}: ${duplicateDisplayOrder.join(", ")}`,
    );
  }

  const displayOrder = new Set(categories.displayOrder);
  const unknownCategories = unknownStrings(
    Object.values(categories.categories),
    displayOrder,
  );
  if (unknownCategories.length > 0) {
    throw new Error(
      `Generated categories reference display-order categories missing for ${type}: ${unknownCategories.join(", ")}`,
    );
  }

  const unusedCategories = unknownStrings(
    displayOrder,
    new Set(Object.values(categories.categories)),
  );
  if (unusedCategories.length > 0) {
    throw new Error(
      `Generated category display order has unused categories for ${type}: ${unusedCategories.join(", ")}`,
    );
  }
}

function generatedExportCandidates(
  moduleExports: Readonly<Record<string, unknown>>,
  suffix: string,
): [string, unknown][] {
  return Object.entries(moduleExports).filter(([name]) => {
    return name.endsWith(suffix);
  });
}

function hasOwnKey(
  value: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function getOptionalGeneratedExportByName<T>(
  moduleExports: Readonly<Record<string, unknown>>,
  type: FirewallConnectorType,
  name: string,
  suffix: string,
  isExpected: (value: unknown) => value is T,
): T | null {
  const unexpectedMatches = generatedExportCandidates(moduleExports, suffix)
    .map(([matchName]) => {
      return matchName;
    })
    .filter((matchName) => {
      return matchName !== name;
    })
    .sort(compareStrings);
  if (unexpectedMatches.length > 0) {
    throw new Error(
      `Unexpected ${suffix} export names for firewall metadata: ${type}: ${unexpectedMatches.join(", ")}; expected ${name}`,
    );
  }
  if (!hasOwnKey(moduleExports, name)) {
    return null;
  }
  const value = moduleExports[name];
  if (!isExpected(value)) {
    throw new Error(
      `Unexpected ${name} export shape for firewall metadata: ${type}`,
    );
  }
  return value;
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

function connectorEnvBindingValueRef(expression: ts.Expression): string | null {
  const direct = stringLiteralText(expression);
  if (direct !== null) {
    return direct;
  }
  const object = unwrapObjectLiteral(expression);
  if (!object) {
    return null;
  }
  const valueRef = findObjectProperty(object, "valueRef");
  return valueRef ? stringLiteralText(valueRef) : null;
}

function connectorEnvBindingEntries(
  expression: ts.Expression,
): ConnectorEnvBindingEntry[] {
  const envBindings = unwrapObjectLiteral(expression);
  if (!envBindings) {
    return [];
  }

  const entries: ConnectorEnvBindingEntry[] = [];
  for (const property of envBindings.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const envName = propertyNameText(property.name);
    const valueRef = connectorEnvBindingValueRef(property.initializer);
    if (envName && valueRef) {
      entries.push({ envName, valueRef });
    }
  }
  return entries;
}

function connectorAuthMethodEnvBindingEntries(
  connectorObject: ts.ObjectLiteralExpression,
): ConnectorEnvBindingEntry[] {
  const authMethods = findObjectProperty(connectorObject, "authMethods");
  const authMethodsObject = authMethods
    ? unwrapObjectLiteral(authMethods)
    : null;
  if (!authMethodsObject) {
    return [];
  }

  const entries: ConnectorEnvBindingEntry[] = [];
  for (const property of authMethodsObject.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const authMethod = unwrapObjectLiteral(property.initializer);
    if (!authMethod) {
      continue;
    }
    const access = findObjectProperty(authMethod, "access");
    const accessObject = access ? unwrapObjectLiteral(access) : null;
    if (!accessObject) {
      continue;
    }
    const envBindings = findObjectProperty(accessObject, "envBindings");
    if (envBindings) {
      entries.push(...connectorEnvBindingEntries(envBindings));
    }
  }
  return entries;
}

function loadConnectorMetadata(
  connectorsDir: string,
  type: FirewallConnectorType,
): ConnectorMetadata {
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
      const labelText = label ? stringLiteralText(label) : null;
      if (labelText === null) {
        continue;
      }
      return {
        label: labelText,
        envBindingEntries:
          connectorAuthMethodEnvBindingEntries(connectorObject),
      };
    }
  }

  throw new Error(`Firewall connector is missing connector metadata: ${type}`);
}

export function generatedConnectorMetadataFileName(
  type: FirewallConnectorType,
): string {
  if (!GENERATED_METADATA_FILE_STEM_PATTERN.test(type)) {
    throw new Error(
      `Unsupported firewall metadata generated file name: ${type}`,
    );
  }
  return `${type}.generated.ts`;
}

export function generatedFirewallExportName(
  type: FirewallConnectorType,
): string {
  return `${type
    .split("-")
    .map((segment, index) => {
      if (index === 0) {
        return segment;
      }
      return `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`;
    })
    .join("")}Firewall`;
}

function generatedOptionalExportName(
  type: FirewallConnectorType,
  suffix: string,
): string {
  return `${generatedFirewallExportName(type).replace(/Firewall$/, "")}${suffix}`;
}

function defaultConnectorsDir(): string {
  return path.resolve(import.meta.dirname, "../../connectors/src/connectors");
}

function isConnectorFirewallGeneratorModule(
  value: unknown,
): value is ConnectorFirewallGeneratorModule {
  return isRecord(value) && typeof value.generate === "function";
}

async function importGeneratorModule(
  type: FirewallConnectorType,
): Promise<ConnectorFirewallGeneratorModule> {
  const filePath = path.resolve(import.meta.dirname, `${type}.ts`);
  const moduleExports: unknown = await import(pathToFileURL(filePath).href);
  if (!isConnectorFirewallGeneratorModule(moduleExports)) {
    throw new Error(`Expected connector firewall generator module: ${type}`);
  }
  return moduleExports;
}

async function generateConnectorFirewallOutput(
  type: FirewallConnectorType,
): Promise<void> {
  const generatorModule = await importGeneratorModule(type);
  await generatorModule.generate();
  if (getGeneratedFirewallOutput(type) === null) {
    throw new Error(`Generator did not produce firewall source: ${type}`);
  }
}

async function ensureGeneratedFirewallOutput(
  type: FirewallConnectorType,
): Promise<string> {
  const existing = getGeneratedFirewallOutput(type);
  if (existing !== null) {
    return existing;
  }

  let generatedOutputPromise = generatedOutputPromises.get(type);
  if (!generatedOutputPromise) {
    generatedOutputPromise = generateConnectorFirewallOutput(type).catch(
      (error: unknown) => {
        generatedOutputPromises.delete(type);
        throw error;
      },
    );
    generatedOutputPromises.set(type, generatedOutputPromise);
  }
  await generatedOutputPromise;
  const generated = getGeneratedFirewallOutput(type);
  if (generated === null) {
    throw new Error(`Missing generated firewall source: ${type}`);
  }
  return generated;
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

async function loadGeneratedModuleExports(
  type: FirewallConnectorType,
  source: string,
): Promise<Record<string, unknown>> {
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  const diagnostics =
    transpiled.diagnostics?.filter((diagnostic) => {
      return diagnostic.category === ts.DiagnosticCategory.Error;
    }) ?? [];
  if (diagnostics.length > 0) {
    throw new Error(
      `Failed to transpile generated firewall source for ${type}: ${diagnostics
        .map(diagnosticText)
        .join("; ")}`,
    );
  }

  const moduleSource = `${transpiled.outputText}\n//# sourceURL=vm0-firewall:${type}.generated.js\n`;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
  const moduleExports: unknown = await import(moduleUrl);
  if (!isRecord(moduleExports)) {
    throw new Error(`Expected generated firewall module exports: ${type}`);
  }
  return moduleExports;
}

export async function loadGeneratedConnectorFirewallModuleExports(
  type: FirewallConnectorType,
): Promise<Record<string, unknown>> {
  const source = await ensureGeneratedFirewallOutput(type);
  const cached = generatedModuleCache.get(type);
  if (cached && cached.source === source) {
    return await cached.moduleExports;
  }

  const moduleExports = loadGeneratedModuleExports(type, source).catch(
    (error: unknown) => {
      generatedModuleCache.delete(type);
      throw error;
    },
  );
  generatedModuleCache.set(type, { source, moduleExports });
  return await moduleExports;
}

async function loadGeneratedFirewallSource(
  connectorsDir: string,
  type: FirewallConnectorType,
): Promise<ConnectorFirewallSource> {
  const firewallExportName = generatedFirewallExportName(type);
  const connectorMetadata = loadConnectorMetadata(connectorsDir, type);
  const moduleExports = await loadGeneratedConnectorFirewallModuleExports(type);
  const firewall = parseGeneratedFirewallConfig(
    type,
    firewallExportName,
    moduleExports[firewallExportName],
  );
  const categories = getOptionalGeneratedExportByName(
    moduleExports,
    type,
    generatedOptionalExportName(type, "Categories"),
    "Categories",
    isStringRecord,
  );
  const displayOrder = getOptionalGeneratedExportByName(
    moduleExports,
    type,
    generatedOptionalExportName(type, "CategoryOrder"),
    "CategoryOrder",
    isStringArray,
  );
  if ((categories === null) !== (displayOrder === null)) {
    throw new Error(
      `Firewall metadata categories are incomplete for connector: ${type}`,
    );
  }
  const connectorCategories =
    categories && displayOrder ? { categories, displayOrder } : null;
  const defaultAllowed = getOptionalGeneratedExportByName(
    moduleExports,
    type,
    generatedOptionalExportName(type, "DefaultAllowed"),
    "DefaultAllowed",
    isStringArray,
  );
  const permissionNames = firewallPermissionNames(firewall);
  validateGeneratedCategories(type, permissionNames, connectorCategories);
  validateGeneratedDefaultAllowed(type, permissionNames, defaultAllowed);

  return {
    type,
    firewallExportName,
    firewall,
    label: connectorMetadata.label,
    envBindingEntries: connectorMetadata.envBindingEntries,
    categories: connectorCategories,
    defaultAllowed,
    defaultUnknownPolicy:
      getOptionalGeneratedExportByName(
        moduleExports,
        type,
        generatedOptionalExportName(type, "DefaultUnknownPolicy"),
        "DefaultUnknownPolicy",
        isPolicyValue,
      ) ?? "allow",
  };
}

export async function loadGeneratedConnectorFirewallSource(
  type: FirewallConnectorType,
  {
    connectorsDir = defaultConnectorsDir(),
  }: ConnectorFirewallSourceSetOptions = {},
): Promise<ConnectorFirewallSource> {
  return await loadGeneratedFirewallSource(connectorsDir, type);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function loadConnectorFirewallSourceSet({
  connectorsDir = defaultConnectorsDir(),
}: ConnectorFirewallSourceSetOptions = {}): Promise<ConnectorFirewallSourceSet> {
  for (const type of FIREWALL_CONNECTOR_TYPES) {
    await ensureGeneratedFirewallOutput(type);
  }

  const sources = await Promise.all(
    [...FIREWALL_CONNECTOR_TYPES].sort(compareStrings).map((type) => {
      return loadGeneratedFirewallSource(connectorsDir, type);
    }),
  );
  const sourceByType = new Map<FirewallConnectorType, ConnectorFirewallSource>(
    sources.map((source) => {
      return [source.type, source];
    }),
  );
  const registryOrderedSources = FIREWALL_CONNECTOR_TYPES.map((type) => {
    const source = sourceByType.get(type);
    if (!source) {
      throw new Error(`Missing firewall metadata source: ${type}`);
    }
    return source;
  });

  return {
    sources,
    registryOrderedSources,
    billableTypes: new Set(BILLABLE_FIREWALL_CONNECTOR_TYPES),
  };
}
