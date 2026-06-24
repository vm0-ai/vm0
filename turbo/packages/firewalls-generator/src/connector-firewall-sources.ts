import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import type {
  FirewallConfig,
  FirewallPolicyValue,
} from "../../connectors/src/firewall-types";
import type { FirewallConnectorType } from "../../connectors/src/firewalls";

const GENERATED_FILE_STEM_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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

interface RegisteredFirewallSource {
  readonly type: FirewallConnectorType;
  readonly firewallExportName: string;
}

export interface ConnectorFirewallSourceSetOptions {
  readonly firewallsDir: string;
  readonly connectorsDir: string;
  readonly firewallsIndexFile: string;
}

interface ConnectorFirewallSourceSet {
  readonly sources: readonly ConnectorFirewallSource[];
  readonly registryOrderedSources: readonly ConnectorFirewallSource[];
  readonly billableTypes: ReadonlySet<FirewallConnectorType>;
}

interface FirewallsIndexSource {
  readonly registeredSources: readonly RegisteredFirewallSource[];
  readonly billableTypes: ReadonlySet<FirewallConnectorType>;
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

export function generatedFirewallFileName(type: FirewallConnectorType): string {
  if (!GENERATED_FILE_STEM_PATTERN.test(type)) {
    throw new Error(
      `Unsupported firewall metadata generated file name: ${type}`,
    );
  }
  return `${type}.generated.ts`;
}

async function loadGeneratedFirewallSource(
  firewallsDir: string,
  connectorsDir: string,
  registration: RegisteredFirewallSource,
): Promise<ConnectorFirewallSource> {
  const { type, firewallExportName } = registration;
  const connectorMetadata = loadConnectorMetadata(connectorsDir, type);
  const moduleExports = await importModule(
    path.join(firewallsDir, generatedFirewallFileName(type)),
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
  sourceFile: ts.SourceFile,
): RegisteredFirewallSource[] {
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
  sourceFile: ts.SourceFile,
): ReadonlySet<FirewallConnectorType> {
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

function loadFirewallsIndexSource(
  firewallsIndexFile: string,
): FirewallsIndexSource {
  const source = fs.readFileSync(firewallsIndexFile, "utf-8");
  const sourceFile = ts.createSourceFile(
    firewallsIndexFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  return {
    registeredSources: extractRegisteredFirewallSources(sourceFile),
    billableTypes: extractBillableConnectorTypes(sourceFile),
  };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function loadConnectorFirewallSourceSet({
  firewallsDir,
  connectorsDir,
  firewallsIndexFile,
}: ConnectorFirewallSourceSetOptions): Promise<ConnectorFirewallSourceSet> {
  const { registeredSources, billableTypes } =
    loadFirewallsIndexSource(firewallsIndexFile);
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
  const sourceByType = new Map<FirewallConnectorType, ConnectorFirewallSource>(
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

  return {
    sources,
    registryOrderedSources,
    billableTypes,
  };
}
