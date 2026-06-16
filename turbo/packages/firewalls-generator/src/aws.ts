/**
 * Generate AWS firewall config.
 *
 * Sources:
 * - AWS Service Authorization Reference JSON for IAM action metadata.
 * - AWS-maintained Botocore service models for protocol and HTTP shapes.
 *
 * AWS SDKs and CLI sign requests with AWS SigV4. The runner firewall replaces
 * placeholder signatures with signatures produced from real connector
 * credentials at request time.
 */

import {
  escapeString,
  fetchSpec,
  logStats,
  renderCategories,
  renderDefaultUnknownPolicy,
  writeOutput,
  type PermissionGroup,
} from "./codegen";

const ACCESS_KEY_ID_PLACEHOLDER = "ASIAC0FFEE5AFE10CA1C";
const SECRET_ACCESS_KEY_PLACEHOLDER =
  "C0ffee5afe10ca1C0ffee5afe10ca1C0ffee5afe";
const SESSION_TOKEN_PLACEHOLDER =
  "C0ffee5afe10ca1C0ffee5afe10ca1C0ffee5afe10ca1";

const AWS_BASES = [
  "https://{awsHost+}.amazonaws.com",
  "https://{awsHost+}.amazonaws.com.cn",
  "https://{awsHost+}.api.aws",
] as const;

const S3_VIRTUAL_HOSTED_BASES = [
  "https://{Bucket+}.s3.amazonaws.com",
  "https://{Bucket+}.s3.{Region}.amazonaws.com",
  "https://{Bucket+}.s3.dualstack.{Region}.amazonaws.com",
  "https://{Bucket+}.s3-fips.{Region}.amazonaws.com",
  "https://{Bucket+}.s3.{Region}.amazonaws.com.cn",
  "https://{Bucket+}.s3.dualstack.{Region}.amazonaws.com.cn",
  "https://{Bucket+}.s3-fips.{Region}.amazonaws.com.cn",
  "https://{Bucket+}.s3-accelerate.amazonaws.com",
  "https://{Bucket+}.s3-accelerate.dualstack.amazonaws.com",
] as const;

export const AWS_SERVICE_REFERENCE_MAPPING_URL =
  "https://servicereference.us-east-1.amazonaws.com/v1/mapping.json";
export const AWS_BOTOCORE_TREE_URL =
  "https://api.github.com/repos/boto/botocore/git/trees/develop?recursive=1";
const AWS_BOTOCORE_RAW_BASE_URL =
  "https://raw.githubusercontent.com/boto/botocore/develop";

const SUPPORTED_AWS_PROTOCOLS = new Set([
  "ec2",
  "json",
  "query",
  "rest-json",
  "rest-xml",
  "smithy-rpc-v2-cbor",
]);

interface AwsServiceSource {
  readonly key: string;
  readonly servicePrefix: string;
  readonly serviceReferenceUrl: string;
  readonly botocoreModelUrl: string;
}

interface AwsServiceReference {
  readonly Actions?: unknown;
  readonly Operations?: unknown;
}

interface AwsAction {
  readonly Name?: unknown;
  readonly Annotations?: {
    readonly Properties?: {
      readonly IsList?: unknown;
      readonly IsPermissionManagement?: unknown;
      readonly IsTaggingOnly?: unknown;
      readonly IsWrite?: unknown;
    };
  };
}

interface AwsAuthorizedAction {
  readonly Name?: unknown;
  readonly Service?: unknown;
}

interface AwsOperationReference {
  readonly Name?: unknown;
  readonly AuthorizedActions?: unknown;
}

interface BotocoreModel {
  readonly metadata?: {
    readonly auth?: unknown;
    readonly endpointPrefix?: unknown;
    readonly protocol?: unknown;
    readonly protocols?: unknown;
    readonly signatureVersion?: unknown;
    readonly signingName?: unknown;
    readonly targetPrefix?: unknown;
  };
  readonly operations?: unknown;
}

interface BotocoreOperation {
  readonly http?: {
    readonly method?: unknown;
    readonly requestUri?: unknown;
  };
}

interface BuildResult {
  readonly permissions: PermissionGroup[];
  readonly s3VirtualHostedPermissions: PermissionGroup[];
  readonly categories: Record<string, string>;
  readonly categoryOrder: string[];
  readonly defaultAllowed: string[];
  readonly stats: BuildStats;
}

interface BuildStats {
  sourceServices: number;
  generatedServices: number;
  operations: number;
  generatedOperations: number;
  fallbackActionMappings: number;
  unsupportedProtocolServices: number;
  unsupportedOperations: number;
  unmappedOperations: number;
}

interface PermissionAccumulator {
  readonly action: AwsAction;
  readonly rules: Set<string>;
}

interface SelectedAction {
  readonly name: string;
  readonly action: AwsAction;
}

const AWS_OPERATION_ACTION_OVERRIDES = new Map<string, string>([
  // SAR AuthorizedActions order is not a primary-action signal. These S3 REST
  // operation names do not match their IAM action names, so pick the action
  // users expect to control the generated endpoint rule.
  ["s3:CompleteMultipartUpload", "PutObject"],
  ["s3:CreateMultipartUpload", "PutObject"],
  ["s3:GetBucketLifecycleConfiguration", "GetLifecycleConfiguration"],
  ["s3:HeadObject", "GetObject"],
  ["s3:ListObjects", "ListBucket"],
  ["s3:ListObjectsV2", "ListBucket"],
  ["s3:PutBucketLifecycleConfiguration", "PutLifecycleConfiguration"],
  ["s3:UploadPart", "PutObject"],
]);

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function parseBoto3ServiceMappings(
  mapping: unknown,
): Map<string, { readonly servicePrefix: string; readonly url: string }> {
  const root = assertObject(mapping, "AWS service reference mapping");
  const sdk = assertObject(root.SDK, "AWS service reference SDK mapping");
  const python = assertObject(sdk.Python, "AWS Python SDK mapping");
  const boto3 = assertObject(python.Boto3, "AWS Boto3 service mapping");

  const result = new Map<
    string,
    { readonly servicePrefix: string; readonly url: string }
  >();
  for (const [key, rawEntry] of Object.entries(boto3)) {
    const entry = assertObject(rawEntry, `AWS Boto3 mapping for ${key}`);
    const servicePrefix = optionalString(entry.service);
    const url = optionalString(entry.url);
    if (!servicePrefix || !url) {
      throw new Error(`AWS Boto3 mapping for ${key} is missing service or url`);
    }
    result.set(key, { servicePrefix, url });
  }
  return result;
}

function parseBotocoreModelUrls(tree: unknown): Map<string, string> {
  const root = assertObject(tree, "Botocore git tree");
  if (!Array.isArray(root.tree)) {
    throw new Error("Botocore git tree is missing tree array");
  }

  const latestByService = new Map<
    string,
    { readonly path: string; readonly version: string }
  >();
  for (const rawEntry of root.tree) {
    if (typeof rawEntry !== "object" || rawEntry === null) continue;
    const entry = rawEntry as Record<string, unknown>;
    if (entry.type !== "blob" || typeof entry.path !== "string") continue;
    const match = /^botocore\/data\/([^/]+)\/([^/]+)\/service-2\.json$/.exec(
      entry.path,
    );
    if (!match) continue;
    const serviceKey = match[1]!;
    const version = match[2]!;
    const current = latestByService.get(serviceKey);
    if (!current || version.localeCompare(current.version) > 0) {
      latestByService.set(serviceKey, { path: entry.path, version });
    }
  }

  const result = new Map<string, string>();
  for (const [serviceKey, model] of latestByService) {
    result.set(serviceKey, `${AWS_BOTOCORE_RAW_BASE_URL}/${model.path}`);
  }
  return result;
}

export function discoverAwsServiceSources(
  mapping: unknown,
  botocoreTree: unknown,
): AwsServiceSource[] {
  const mappings = parseBoto3ServiceMappings(mapping);
  const modelUrls = parseBotocoreModelUrls(botocoreTree);
  const sources: AwsServiceSource[] = [];

  for (const [key, entry] of mappings) {
    const botocoreModelUrl = modelUrls.get(key);
    if (!botocoreModelUrl) {
      throw new Error(`Botocore tree is missing service model for ${key}`);
    }
    sources.push({
      key,
      servicePrefix: entry.servicePrefix,
      serviceReferenceUrl: entry.url,
      botocoreModelUrl,
    });
  }

  return sources.sort((left, right) => {
    return left.key.localeCompare(right.key);
  });
}

function isAwsAction(value: unknown): value is AwsAction {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAwsOperationReference(
  value: unknown,
): value is AwsOperationReference {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAwsAuthorizedAction(value: unknown): value is AwsAuthorizedAction {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBotocoreOperation(value: unknown): value is BotocoreOperation {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionName(action: AwsAction): string | null {
  return typeof action.Name === "string" ? action.Name : null;
}

function loadActionsByName(
  reference: AwsServiceReference,
): Map<string, AwsAction> {
  if (!Array.isArray(reference.Actions)) {
    throw new Error("AWS Service Reference is missing Actions array");
  }
  const result = new Map<string, AwsAction>();
  for (const rawAction of reference.Actions) {
    if (!isAwsAction(rawAction)) continue;
    const name = actionName(rawAction);
    if (name) result.set(name, rawAction);
  }
  return result;
}

function loadOperationsByName(
  reference: AwsServiceReference,
): Map<string, AwsOperationReference> {
  if (!Array.isArray(reference.Operations)) {
    throw new Error("AWS Service Reference is missing Operations array");
  }
  const result = new Map<string, AwsOperationReference>();
  for (const rawOperation of reference.Operations) {
    if (!isAwsOperationReference(rawOperation)) continue;
    if (typeof rawOperation.Name === "string") {
      result.set(rawOperation.Name, rawOperation);
    }
  }
  return result;
}

function loadBotocoreOperations(model: BotocoreModel): Record<string, unknown> {
  return assertObject(model.operations, "Botocore operations");
}

function botocoreProtocol(model: BotocoreModel): string {
  const protocols = model.metadata?.protocols;
  if (Array.isArray(protocols) && typeof protocols[0] === "string") {
    return protocols[0];
  }
  if (typeof model.metadata?.protocol === "string") {
    return model.metadata.protocol;
  }
  throw new Error("Botocore model is missing protocol metadata");
}

function botocoreTargetPrefix(model: BotocoreModel): string {
  const targetPrefix = model.metadata?.targetPrefix;
  if (typeof targetPrefix !== "string" || targetPrefix === "") {
    throw new Error("Botocore JSON protocol model is missing targetPrefix");
  }
  return targetPrefix;
}

function botocoreSigv4Service(
  service: AwsServiceSource,
  model: BotocoreModel,
): string {
  return (
    optionalString(model.metadata?.signingName) ??
    optionalString(model.metadata?.endpointPrefix) ??
    service.key
  );
}

function botocoreSupportsSigv4(model: BotocoreModel): boolean {
  const signatureVersion = model.metadata?.signatureVersion;
  if (
    signatureVersion === "v4" ||
    signatureVersion === "s3" ||
    signatureVersion === "s3v4"
  ) {
    return true;
  }
  const auth = model.metadata?.auth;
  return (
    Array.isArray(auth) &&
    auth.some((scheme) => {
      return typeof scheme === "string" && scheme.includes("sigv4");
    })
  );
}

function selectPrimaryAction(
  service: AwsServiceSource,
  operation: AwsOperationReference,
  actionsByName: Map<string, AwsAction>,
  operationHttpMethod: string | null,
): SelectedAction | null {
  const operationName = operation.Name;
  if (typeof operationName !== "string") {
    throw new Error(`AWS operation for ${service.key} is missing a name`);
  }

  const sameServiceAuthorizedNames: string[] = [];
  if (Array.isArray(operation.AuthorizedActions)) {
    for (const rawAuthorizedAction of operation.AuthorizedActions) {
      if (!isAwsAuthorizedAction(rawAuthorizedAction)) continue;
      const authorizedName = rawAuthorizedAction.Name;
      if (
        rawAuthorizedAction.Service === service.servicePrefix &&
        typeof authorizedName === "string" &&
        actionsByName.has(authorizedName)
      ) {
        sameServiceAuthorizedNames.push(authorizedName);
      }
    }
  }

  const exactAuthorizedName = sameServiceAuthorizedNames.find((name) => {
    return name === operationName;
  });
  const overrideName = AWS_OPERATION_ACTION_OVERRIDES.get(
    `${service.servicePrefix}:${operationName}`,
  );
  const methodActionName =
    service.servicePrefix === "apigateway" && operationHttpMethod
      ? sameServiceAuthorizedNames.find((name) => {
          return name === operationHttpMethod;
        })
      : undefined;
  const selectedName = exactAuthorizedName
    ? exactAuthorizedName
    : overrideName && sameServiceAuthorizedNames.includes(overrideName)
      ? overrideName
      : methodActionName
        ? methodActionName
        : sameServiceAuthorizedNames.length === 1
          ? sameServiceAuthorizedNames[0]!
          : sameServiceAuthorizedNames.length > 1
            ? null
            : operationName;
  if (selectedName === null) {
    return null;
  }
  const action = actionsByName.get(selectedName);
  return action ? { name: selectedName, action } : null;
}

function selectActionForOperation(
  service: AwsServiceSource,
  operationName: string,
  operationsByName: Map<string, AwsOperationReference>,
  actionsByName: Map<string, AwsAction>,
  operationHttpMethod: string | null,
): SelectedAction | null {
  const operation = operationsByName.get(operationName);
  if (operation) {
    return selectPrimaryAction(
      service,
      operation,
      actionsByName,
      operationHttpMethod,
    );
  }

  const overrideName = AWS_OPERATION_ACTION_OVERRIDES.get(
    `${service.servicePrefix}:${operationName}`,
  );
  if (overrideName) {
    const overrideAction = actionsByName.get(overrideName);
    if (overrideAction) {
      return { name: overrideName, action: overrideAction };
    }
  }

  const action = actionsByName.get(operationName);
  return action ? { name: operationName, action } : null;
}

function isDefaultAllowed(action: AwsAction): boolean {
  const properties = action.Annotations?.Properties;
  return (
    properties?.IsWrite === false &&
    properties.IsPermissionManagement === false &&
    properties.IsTaggingOnly === false
  );
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => {
    return left.localeCompare(right);
  });
}

function queryRules(
  requestUri: string,
  sigv4Service: string,
  action: string,
): string[] {
  return sortedUnique([
    `GET ${requestUri} AWS sigv4=${sigv4Service} action=${action}`,
    `POST ${requestUri} AWS sigv4=${sigv4Service} action=${action}`,
  ]);
}

function jsonRules(
  requestUri: string,
  sigv4Service: string,
  targetPrefix: string,
  operationName: string,
): string[] {
  return [
    `POST ${requestUri} AWS sigv4=${sigv4Service} target=${targetPrefix}.${operationName}`,
  ];
}

function restRules(
  method: string,
  requestUri: string,
  sigv4Service: string,
): string[] {
  return [`${method} ${requestUri} AWS sigv4=${sigv4Service}`];
}

function smithyRpcV2CborRules(
  method: string,
  targetPrefix: string,
  sigv4Service: string,
  operationName: string,
): string[] {
  return restRules(
    method,
    `/service/${targetPrefix}/operation/${operationName}`,
    sigv4Service,
  );
}

function s3VirtualHostedRequestUri(requestUri: string): string | null {
  if (requestUri === "/{Bucket}") {
    return "/";
  }
  if (requestUri.startsWith("/{Bucket}/")) {
    return `/${requestUri.slice("/{Bucket}/".length)}`;
  }
  if (requestUri.startsWith("/{Bucket}?")) {
    return `/${requestUri.slice("/{Bucket}".length)}`;
  }
  return null;
}

function rulesForOperation(
  service: AwsServiceSource,
  model: BotocoreModel,
  operationName: string,
  sigv4Service: string,
  options?: { readonly s3VirtualHosted: boolean },
): string[] | null {
  const rawOperation = loadBotocoreOperations(model)[operationName];
  if (!isBotocoreOperation(rawOperation)) {
    throw new Error(
      `Botocore model for ${service.key} is missing ${operationName}`,
    );
  }
  const method = rawOperation.http?.method;
  const requestUri = rawOperation.http?.requestUri;
  if (typeof method !== "string" || typeof requestUri !== "string") {
    return null;
  }

  const protocol = botocoreProtocol(model);
  if (protocol === "ec2" || protocol === "query") {
    return queryRules(requestUri, sigv4Service, operationName);
  }
  if (protocol === "json") {
    return jsonRules(
      requestUri,
      sigv4Service,
      botocoreTargetPrefix(model),
      operationName,
    );
  }
  if (protocol === "smithy-rpc-v2-cbor") {
    return smithyRpcV2CborRules(
      method,
      botocoreTargetPrefix(model),
      sigv4Service,
      operationName,
    );
  }
  if (protocol === "rest-xml" || protocol === "rest-json") {
    if (options?.s3VirtualHosted) {
      const virtualHostedRequestUri = s3VirtualHostedRequestUri(requestUri);
      if (service.key !== "s3" || virtualHostedRequestUri === null) {
        return null;
      }
      return restRules(method, virtualHostedRequestUri, sigv4Service);
    }
    return restRules(method, requestUri, sigv4Service);
  }
  throw new Error(`Unsupported AWS protocol for ${service.key}: ${protocol}`);
}

function operationHttpMethod(
  model: BotocoreModel,
  operationName: string,
): string | null {
  const rawOperation = loadBotocoreOperations(model)[operationName];
  if (!isBotocoreOperation(rawOperation)) {
    return null;
  }
  const method = rawOperation.http?.method;
  return typeof method === "string" ? method : null;
}

async function loadJson<T>(url: string, label: string): Promise<T> {
  const response = await fetchSpec(url, label);
  return (await response.json()) as T;
}

function addPermissionRules(
  permissionsByName: Map<string, PermissionAccumulator>,
  name: string,
  action: AwsAction,
  rules: string[] | null,
): boolean {
  if (!rules || rules.length === 0) {
    return false;
  }

  let permission = permissionsByName.get(name);
  if (!permission) {
    permission = { action, rules: new Set<string>() };
    permissionsByName.set(name, permission);
  }
  for (const rule of rules) {
    permission.rules.add(rule);
  }
  return true;
}

function materializePermissions(
  permissionsByName: Map<string, PermissionAccumulator>,
): PermissionGroup[] {
  return [...permissionsByName.entries()]
    .map(([name, permission]) => {
      return {
        name,
        rules: sortedUnique([...permission.rules]),
      };
    })
    .sort((left, right) => {
      return left.name.localeCompare(right.name);
    });
}

async function buildAwsPermissions(): Promise<BuildResult> {
  const mapping = await loadJson<unknown>(
    AWS_SERVICE_REFERENCE_MAPPING_URL,
    "aws service reference mapping",
  );
  const botocoreTree = await loadJson<unknown>(
    AWS_BOTOCORE_TREE_URL,
    "aws botocore service tree",
  );
  const services = discoverAwsServiceSources(mapping, botocoreTree);
  const permissionsByName = new Map<string, PermissionAccumulator>();
  const s3VirtualHostedPermissionsByName = new Map<
    string,
    PermissionAccumulator
  >();
  const categories = new Map<string, string>();
  const defaultAllowed = new Set<string>();
  const stats: BuildStats = {
    sourceServices: services.length,
    generatedServices: 0,
    operations: 0,
    generatedOperations: 0,
    fallbackActionMappings: 0,
    unsupportedProtocolServices: 0,
    unsupportedOperations: 0,
    unmappedOperations: 0,
  };

  for (const service of services) {
    const reference = await loadJson<AwsServiceReference>(
      service.serviceReferenceUrl,
      `aws ${service.key} service reference`,
    );
    const model = await loadJson<BotocoreModel>(
      service.botocoreModelUrl,
      `aws ${service.key} botocore model`,
    );
    if (!botocoreSupportsSigv4(model)) {
      stats.unsupportedProtocolServices += 1;
      continue;
    }
    const protocol = botocoreProtocol(model);
    if (!SUPPORTED_AWS_PROTOCOLS.has(protocol)) {
      stats.unsupportedProtocolServices += 1;
      continue;
    }

    const actionsByName = loadActionsByName(reference);
    const operationsByName = loadOperationsByName(reference);
    const sigv4Service = botocoreSigv4Service(service, model);
    let generatedServiceOperation = false;

    for (const operationName of Object.keys(loadBotocoreOperations(model))) {
      stats.operations += 1;
      const operation = operationsByName.get(operationName);
      const selectedAction = selectActionForOperation(
        service,
        operationName,
        operationsByName,
        actionsByName,
        operationHttpMethod(model, operationName),
      );
      if (!selectedAction) {
        stats.unmappedOperations += 1;
        continue;
      }
      if (!operation) {
        stats.fallbackActionMappings += 1;
      }
      const name = `${service.servicePrefix}:${selectedAction.name}`;
      const generated = addPermissionRules(
        permissionsByName,
        name,
        selectedAction.action,
        rulesForOperation(service, model, operationName, sigv4Service),
      );
      if (!generated) {
        stats.unsupportedOperations += 1;
        continue;
      }
      categories.set(name, service.servicePrefix);
      addPermissionRules(
        s3VirtualHostedPermissionsByName,
        name,
        selectedAction.action,
        service.key === "s3"
          ? rulesForOperation(service, model, operationName, sigv4Service, {
              s3VirtualHosted: true,
            })
          : null,
      );
      stats.generatedOperations += 1;
      generatedServiceOperation = true;
      if (isDefaultAllowed(selectedAction.action)) {
        defaultAllowed.add(name);
      }
    }

    if (generatedServiceOperation) {
      stats.generatedServices += 1;
    }
  }

  const permissions = materializePermissions(permissionsByName);
  const s3VirtualHostedPermissions = materializePermissions(
    s3VirtualHostedPermissionsByName,
  );

  return {
    permissions,
    s3VirtualHostedPermissions,
    categories: Object.fromEntries(
      [...categories.entries()].sort(([left], [right]) => {
        return left.localeCompare(right);
      }),
    ),
    categoryOrder: sortedUnique([...categories.values()]),
    defaultAllowed: sortedUnique([...defaultAllowed]),
    stats,
  };
}

function renderAwsSigv4Auth(lines: string[]): void {
  lines.push("      auth: {");
  lines.push("        awsSigv4: {");
  lines.push('          accessKeyId: "${{ secrets.AWS_ACCESS_KEY_ID }}",');
  lines.push(
    '          secretAccessKey: "${{ secrets.AWS_SECRET_ACCESS_KEY }}",',
  );
  lines.push('          sessionToken: "${{ secrets.AWS_SESSION_TOKEN }}",');
  lines.push("        },");
  lines.push("      },");
}

function renderPermissions(
  lines: string[],
  permissions: PermissionGroup[],
  indent: string,
): void {
  for (const permission of permissions) {
    lines.push(`${indent}{`);
    lines.push(`${indent}  name: "${escapeString(permission.name)}",`);
    lines.push(`${indent}  rules: [`);
    for (const rule of permission.rules) {
      lines.push(`${indent}    "${escapeString(rule)}",`);
    }
    lines.push(`${indent}  ],`);
    lines.push(`${indent}},`);
  }
}

function renderApiEntry(
  lines: string[],
  base: string,
  permissions: PermissionGroup[],
): void {
  lines.push("    {");
  lines.push(`      base: "${base}",`);
  renderAwsSigv4Auth(lines);
  lines.push("      permissions: [");
  renderPermissions(lines, permissions, "        ");
  lines.push("      ],");
  lines.push("    },");
}

function renderAwsDefaultAllowed(
  lines: string[],
  defaultAllowed: string[],
): void {
  lines.push("");
  lines.push("export const awsDefaultAllowed: ReadonlyArray<string> = [");
  for (const name of defaultAllowed) {
    lines.push(`  "${escapeString(name)}",`);
  }
  lines.push("];");
  lines.push("");
}

function generateTypeScript(result: BuildResult): string {
  const lines: string[] = [
    "// Auto-generated from AWS Service Authorization Reference and Botocore models.",
    "// Sources:",
    "// - https://servicereference.us-east-1.amazonaws.com/",
    "// - https://github.com/boto/botocore/tree/develop/botocore/data",
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:aws",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig, FirewallPolicyValue } from "../firewall-types";',
    'import type { PermissionNamesOf } from "./index";',
    "",
    "export const awsFirewall: FirewallConfig = {",
    '  name: "aws",',
    '  description: "AWS APIs signed with SigV4",',
    "  placeholders: {",
    `    AWS_ACCESS_KEY_ID: "${escapeString(ACCESS_KEY_ID_PLACEHOLDER)}",`,
    `    AWS_SECRET_ACCESS_KEY: "${escapeString(SECRET_ACCESS_KEY_PLACEHOLDER)}",`,
    `    AWS_SESSION_TOKEN: "${escapeString(SESSION_TOKEN_PLACEHOLDER)}",`,
    "  },",
    "  apis: [",
  ];

  for (const base of AWS_BASES) {
    renderApiEntry(lines, base, result.permissions);
  }
  for (const base of S3_VIRTUAL_HOSTED_BASES) {
    renderApiEntry(lines, base, result.s3VirtualHostedPermissions);
  }

  lines.push("  ],");
  lines.push("};");
  lines.push(
    ...renderCategories("awsCategories", "awsFirewall", {
      categories: result.categories,
      displayOrder: result.categoryOrder,
    }),
  );
  renderAwsDefaultAllowed(lines, result.defaultAllowed);
  lines.push(...renderDefaultUnknownPolicy("awsDefaultUnknownPolicy", "deny"));

  return lines.join("\n");
}

export async function generate(): Promise<void> {
  console.error("Generating AWS firewall config...");
  const result = await buildAwsPermissions();
  logStats(result.permissions);
  console.error(
    `  ${result.stats.generatedServices}/${result.stats.sourceServices} SigV4 services generated`,
  );
  console.error(
    `  ${result.stats.generatedOperations}/${result.stats.operations} operations generated`,
  );
  console.error(
    `  ${result.stats.fallbackActionMappings} fallback action mappings, ${result.stats.unmappedOperations} unmapped operations, ${result.stats.unsupportedOperations} unsupported operations, ${result.stats.unsupportedProtocolServices} unsupported services`,
  );
  const ts = generateTypeScript(result);
  writeOutput("aws", ts, import.meta.dirname);
}
