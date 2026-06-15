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
  renderDefaultAllowed,
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

export const AWS_SERVICE_REFERENCE_URLS = {
  ec2: "https://servicereference.us-east-1.amazonaws.com/v1/ec2/ec2.json",
  dynamodb:
    "https://servicereference.us-east-1.amazonaws.com/v1/dynamodb/dynamodb.json",
  s3: "https://servicereference.us-east-1.amazonaws.com/v1/s3/s3.json",
} as const;

export const AWS_BOTOCORE_MODEL_URLS = {
  ec2: "https://raw.githubusercontent.com/boto/botocore/develop/botocore/data/ec2/2016-11-15/service-2.json",
  dynamodb:
    "https://raw.githubusercontent.com/boto/botocore/develop/botocore/data/dynamodb/2012-08-10/service-2.json",
  s3: "https://raw.githubusercontent.com/boto/botocore/develop/botocore/data/s3/2006-03-01/service-2.json",
} as const;

type AwsServiceKey = keyof typeof AWS_SERVICE_REFERENCE_URLS;

interface AwsServiceConfig {
  readonly key: AwsServiceKey;
  readonly servicePrefix: string;
  readonly sigv4Service: string;
  readonly operations: readonly string[];
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
    readonly protocol?: unknown;
    readonly protocols?: unknown;
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
  readonly defaultAllowed: string[];
}

const AWS_SERVICES: readonly AwsServiceConfig[] = [
  {
    key: "ec2",
    servicePrefix: "ec2",
    sigv4Service: "ec2",
    operations: ["DescribeInstances", "RunInstances", "CreateTags"],
  },
  {
    key: "dynamodb",
    servicePrefix: "dynamodb",
    sigv4Service: "dynamodb",
    operations: ["ListTables", "GetItem", "PutItem"],
  },
  {
    key: "s3",
    servicePrefix: "s3",
    sigv4Service: "s3",
    operations: [
      "GetBucketAcl",
      "PutBucketAcl",
      "GetBucketPolicy",
      "PutBucketPolicy",
      "GetObject",
      "PutObject",
      "GetObjectTagging",
      "PutObjectTagging",
    ],
  },
] as const;

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
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

function primaryActionName(
  service: AwsServiceConfig,
  operation: AwsOperationReference,
): string {
  const operationName = operation.Name;
  if (Array.isArray(operation.AuthorizedActions)) {
    for (const rawAuthorizedAction of operation.AuthorizedActions) {
      if (!isAwsAuthorizedAction(rawAuthorizedAction)) continue;
      const authorizedName = rawAuthorizedAction.Name;
      if (
        rawAuthorizedAction.Service === service.servicePrefix &&
        typeof authorizedName === "string" &&
        authorizedName === operationName
      ) {
        return authorizedName;
      }
    }
  }
  if (typeof operationName === "string") return operationName;
  throw new Error(`AWS operation for ${service.key} is missing a name`);
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

function rulesForOperation(
  service: AwsServiceConfig,
  model: BotocoreModel,
  operationName: string,
): string[] {
  const rawOperation = loadBotocoreOperations(model)[operationName];
  if (!isBotocoreOperation(rawOperation)) {
    throw new Error(
      `Botocore model for ${service.key} is missing ${operationName}`,
    );
  }
  const method = rawOperation.http?.method;
  const requestUri = rawOperation.http?.requestUri;
  if (typeof method !== "string" || typeof requestUri !== "string") {
    throw new Error(
      `Botocore operation ${service.key}.${operationName} is missing HTTP shape`,
    );
  }

  const protocol = botocoreProtocol(model);
  if (protocol === "ec2" || protocol === "query") {
    return queryRules(requestUri, service.sigv4Service, operationName);
  }
  if (protocol === "json") {
    return jsonRules(
      requestUri,
      service.sigv4Service,
      botocoreTargetPrefix(model),
      operationName,
    );
  }
  if (protocol === "rest-xml" || protocol === "rest-json") {
    return restRules(method, requestUri, service.sigv4Service);
  }
  throw new Error(`Unsupported AWS protocol for ${service.key}: ${protocol}`);
}

async function loadJson<T>(url: string, label: string): Promise<T> {
  const response = await fetchSpec(url, label);
  return (await response.json()) as T;
}

async function buildAwsPermissions(): Promise<BuildResult> {
  const permissions: PermissionGroup[] = [];
  const defaultAllowed: string[] = [];

  for (const service of AWS_SERVICES) {
    const reference = await loadJson<AwsServiceReference>(
      AWS_SERVICE_REFERENCE_URLS[service.key],
      `aws ${service.key} service reference`,
    );
    const model = await loadJson<BotocoreModel>(
      AWS_BOTOCORE_MODEL_URLS[service.key],
      `aws ${service.key} botocore model`,
    );
    const actionsByName = loadActionsByName(reference);
    const operationsByName = loadOperationsByName(reference);

    for (const operationName of service.operations) {
      const operation = operationsByName.get(operationName);
      if (!operation) {
        throw new Error(
          `AWS Service Reference for ${service.key} is missing ${operationName}`,
        );
      }
      const action = actionsByName.get(primaryActionName(service, operation));
      if (!action) {
        throw new Error(
          `AWS Service Reference for ${service.key} is missing action ${operationName}`,
        );
      }
      const primaryAction = actionName(action);
      if (!primaryAction) {
        throw new Error(
          `AWS action for ${service.key}.${operationName} is missing a name`,
        );
      }
      const name = `${service.servicePrefix}:${primaryAction}`;
      permissions.push({
        name,
        rules: rulesForOperation(service, model, operationName),
      });
      if (isDefaultAllowed(action)) {
        defaultAllowed.push(name);
      }
    }
  }

  permissions.sort((left, right) => {
    return left.name.localeCompare(right.name);
  });

  return {
    permissions,
    defaultAllowed: sortedUnique(defaultAllowed),
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
    'import type { FirewallConfig } from "../firewall-types";',
    'import type { PermissionNamesOf } from "./index";',
    "",
    "export const awsFirewall = {",
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
    lines.push("    {");
    lines.push(`      base: "${base}",`);
    renderAwsSigv4Auth(lines);
    lines.push("      permissions: [");
    renderPermissions(lines, result.permissions, "        ");
    lines.push("      ],");
    lines.push("    },");
  }

  lines.push("  ],");
  lines.push("} as const satisfies FirewallConfig;");
  lines.push(
    ...renderDefaultAllowed(
      "awsDefaultAllowed",
      "awsFirewall",
      result.defaultAllowed,
    ),
  );

  return lines.join("\n");
}

export async function generate(): Promise<void> {
  console.error("Generating AWS firewall config...");
  const result = await buildAwsPermissions();
  logStats(result.permissions);
  const ts = generateTypeScript(result);
  writeOutput("aws", ts, import.meta.dirname);
}
