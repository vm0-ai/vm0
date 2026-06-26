import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import type {
  FirewallConfig,
  FirewallPolicyValue,
} from "../../connectors/src/firewall-types";
import {
  BILLABLE_FIREWALL_CONNECTOR_TYPES,
  FIREWALL_CONNECTOR_TYPES,
  type FirewallConnectorType,
} from "./connector-firewall-manifest";
import { getGeneratedFirewallOutput } from "./codegen";

const GENERATED_METADATA_FILE_STEM_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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
    label: connectorMetadata.label,
    envBindingEntries: connectorMetadata.envBindingEntries,
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
