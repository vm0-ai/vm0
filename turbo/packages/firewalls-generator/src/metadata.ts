import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import type { ConnectorType } from "../../connectors/src/connectors";
import type {
  FirewallConfig,
  FirewallPolicy,
  FirewallPolicyValue,
} from "../../connectors/src/firewall-types";
import type {
  FirewallPermissionDefaultPolicyMetadata,
  FirewallPermissionDetailMetadata,
  FirewallPermissionMetadataPermission,
  FirewallPermissionSummaryMetadata,
} from "../../connectors/src/firewall-metadata/types";
import type { FirewallConnectorType } from "../../connectors/src/firewalls";

const POLICY_VALUES = ["allow", "deny", "ask"] as const;
const GENERATED_FILE_STEM_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

interface ConnectorCategories {
  readonly categories: Record<string, string>;
  readonly displayOrder: readonly string[];
}

interface GeneratedFirewallSource {
  readonly type: FirewallConnectorType;
  readonly firewall: FirewallConfig;
  readonly label: string;
  readonly categories: ConnectorCategories | null;
  readonly defaultAllowed: readonly string[] | null;
  readonly defaultUnknownPolicy: FirewallPolicyValue;
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
  type: FirewallConnectorType,
): Promise<GeneratedFirewallSource> {
  const moduleExports = await importModule(
    path.join(firewallsDir, generatedDetailFileName(type)),
  );
  const firewall = getRequiredGeneratedExport(
    moduleExports,
    type,
    "Firewall",
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

function extractRegisteredFirewallTypes(
  firewallsIndexFile: string,
): FirewallConnectorType[] {
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
    return name as FirewallConnectorType;
  });
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

function renderDetailFile(metadata: FirewallPermissionDetailMetadata): string {
  return `${generatedHeader()}import type { FirewallPermissionDetailMetadata } from "../types";

export const firewallPermissionMetadata = ${stableJson(metadata)} as const satisfies FirewallPermissionDetailMetadata;
`;
}

function renderSummaryFile(
  summaries: Record<string, FirewallPermissionSummaryMetadata>,
): string {
  return `${generatedHeader()}import type { FirewallPermissionSummaryMetadata } from "./types";

export const FIREWALL_PERMISSION_METADATA_SUMMARIES = ${stableJson(summaries)} as const satisfies Readonly<Record<string, FirewallPermissionSummaryMetadata>>;
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
  const summaryFile = path.join(outputDir, "summary.generated.ts");
  const loaderFile = path.join(outputDir, "loader.generated.ts");
  const detailsDir = path.join(outputDir, "details");

  const sources = await Promise.all(
    extractRegisteredFirewallTypes(firewallsIndexFile)
      .sort(compareStrings)
      .map((type) => {
        return loadGeneratedFirewallSource(firewallsDir, connectorsDir, type);
      }),
  );
  const summaries: Record<string, FirewallPermissionSummaryMetadata> = {};
  const details: {
    readonly type: FirewallConnectorType;
    readonly content: string;
  }[] = [];

  for (const source of sources) {
    const detail = buildDetailMetadata(source);
    summaries[source.type] = buildSummaryMetadata(detail);
    details.push({
      type: source.type,
      content: renderDetailFile(detail),
    });
  }

  const nextOutputDir = fs.mkdtempSync(path.join(outputDir, ".metadata-"));
  const nextDetailsDir = path.join(nextOutputDir, "details");

  for (const detail of details) {
    writeGeneratedFile(
      path.join(nextDetailsDir, generatedDetailFileName(detail.type)),
      detail.content,
    );
  }
  writeGeneratedFile(
    path.join(nextOutputDir, "summary.generated.ts"),
    renderSummaryFile(summaries),
  );
  writeGeneratedFile(
    path.join(nextOutputDir, "loader.generated.ts"),
    renderLoaderFile(
      sources.map((source) => {
        return source.type;
      }),
    ),
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
  } catch (error) {
    rollbackGeneratedReplacements(replacements);
    throw error;
  } finally {
    fs.rmSync(nextOutputDir, { recursive: true, force: true });
  }

  for (const replacement of replacements) {
    replacement.commit();
  }

  console.error(`  Written ${sources.length} metadata detail files`);
}
