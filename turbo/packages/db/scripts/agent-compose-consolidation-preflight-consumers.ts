import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface RuntimeContentConsumerManifest {
  readonly discovery: readonly string[];
  readonly reviewedConsumers: readonly string[];
}

type RuntimeContentConsumerMode =
  | "compose-independent-environment-shadow"
  | "first-plural-schema-parse"
  | "first-plural-framework-display"
  | "head-content-selection-and-type-projection"
  | "model-provider-binding-authority"
  | "raw-recursive-variable-secret-scan"
  | "recursive-reference-authority"
  | "run-status-authority"
  | "schema-authority"
  | "singular-or-first-plural-launch"
  | "singular-or-first-plural-storage-and-volumes";

interface ReviewedConsumer {
  readonly relativePath: string;
  readonly mode: RuntimeContentConsumerMode;
  readonly functions?: readonly string[];
  readonly interfaces?: readonly string[];
  readonly interfaceProperties?: readonly {
    readonly interfaceName: string;
    readonly propertyName: string;
  }[];
  readonly variables?: readonly string[];
  readonly modelProviderEnvironmentBindings?: true;
}

/**
 * Files are reviewed by semantic mode. Hashes cover normalized AST nodes only;
 * unrelated source edits elsewhere in a file do not create false drift.
 * Exhaustive discovery below independently detects a new raw source,
 * forwarding edge, schema parse, or indirect content-type consumer.
 */
const REVIEWED_CONSUMERS: readonly ReviewedConsumer[] = [
  {
    relativePath: "turbo/apps/api/src/signals/routes/integrations-slack.ts",
    mode: "raw-recursive-variable-secret-scan",
  },
  {
    relativePath:
      "turbo/apps/api/src/signals/services/agent-environment-shadow.ts",
    mode: "compose-independent-environment-shadow",
    interfaces: ["ApplicationOwnedEnvironmentCandidateInput"],
    functions: [
      "buildApplicationOwnedEnvironmentCandidate",
      "compareApplicationOwnedEnvironment",
    ],
    variables: ["ENVIRONMENT_SHADOW_COUNT_BUCKETS"],
  },
  {
    relativePath:
      "turbo/apps/api/src/signals/services/agent-instructions.service.ts",
    mode: "first-plural-schema-parse",
    functions: ["agentInstructions"],
  },
  {
    relativePath:
      "turbo/apps/api/src/signals/services/agent-run-create.service.ts",
    mode: "singular-or-first-plural-launch",
    interfaces: ["AgentComposeContent"],
    functions: [
      "buildRunnerJobPayload",
      "canonicalOkouAgentConfig",
      "canonicalOkouComposeContent",
      "composeArtifacts",
      "effectiveStoredConnectorEnvironment",
      "environmentTemplates",
      "firstAgent",
      "hasExplicitFrameworkApiKey",
      "loadPersistedRunEnvironmentSnapshot",
      "lookupComposeByVersion",
      "buildReferencedSecrets",
      "resolveByComposeId",
      "resolveBySessionId",
      "resolveFramework",
      "runnerGroup",
      "runnerProfile",
    ],
  },
  {
    relativePath:
      "turbo/apps/api/src/signals/services/agent-run-storage.service.ts",
    mode: "singular-or-first-plural-storage-and-volumes",
    interfaces: ["AgentComposeContent", "ResolvedVolume", "VolumeConfig"],
    functions: [
      "firstAgentEntry",
      "resolveComposeStorageInput",
      "resolveComposeVolumes",
      "resolveVolumeStorage",
      "storageManifestRequests",
    ],
  },
  {
    relativePath: "turbo/apps/api/src/signals/services/logs.service.ts",
    mode: "first-plural-framework-display",
    functions: ["extractFramework"],
  },
  {
    relativePath:
      "turbo/apps/api/src/signals/services/telegram-data.service.ts",
    mode: "raw-recursive-variable-secret-scan",
  },
  {
    relativePath:
      "turbo/apps/api/src/signals/services/zero-runs-create.service.ts",
    mode: "head-content-selection-and-type-projection",
    interfaces: ["ZeroAgentComposeContent"],
    interfaceProperties: [
      { interfaceName: "ZeroAgentRunRecord", propertyName: "content" },
    ],
  },
  {
    relativePath:
      "turbo/apps/api/src/signals/services/zero-teams-connect.service.ts",
    mode: "raw-recursive-variable-secret-scan",
  },
  {
    relativePath: "turbo/packages/api-contracts/src/contracts/composes.ts",
    mode: "schema-authority",
    variables: [
      "agentComposeApiContentSchema",
      "agentDefinitionSchema",
      "artifactConfigSchema",
      "artifactsArraySchema",
      "volumeConfigSchema",
    ],
  },
  {
    relativePath:
      "turbo/packages/api-contracts/src/contracts/model-providers.ts",
    mode: "model-provider-binding-authority",
    modelProviderEnvironmentBindings: true,
  },
  {
    relativePath: "turbo/packages/api-contracts/src/contracts/runs.ts",
    mode: "run-status-authority",
    variables: ["ALL_RUN_STATUSES"],
  },
  {
    relativePath: "turbo/packages/core/src/variable-expander.ts",
    mode: "recursive-reference-authority",
    variables: ["VARIABLE_PATTERN"],
    functions: [
      "extractAndGroupVariables",
      "extractVariableReferences",
      "extractVariableReferencesFromString",
      "groupVariablesBySource",
    ],
  },
] as const;

// Filled from the normalized semantic-node collector and reviewed with this
// transition. Updating this value requires reviewing both discovery and mode.
export const EXPECTED_RUNTIME_CONTENT_CONSUMER_MANIFEST: RuntimeContentConsumerManifest =
  {
    discovery: [
      "contentTypeDeclaration|turbo/apps/api/src/signals/services/agent-run-create.service.ts|1|7cbd1fef5957e98e47ee49a72493aedf1151703a2c2fb31908202001285c968d",
      "contentTypeDeclaration|turbo/apps/api/src/signals/services/agent-run-storage.service.ts|1|613c15a528c571b0128cbcc866f5745f175812cb90bac3e7abc20d74b874a4fa",
      "contentTypeDeclaration|turbo/apps/api/src/signals/services/zero-runs-create.service.ts|1|64d2a1643c5cb2f1111f904d4428840fee7ca543bddc4f77385a0fc070fba771",
      "legacyVolumeSystemRead|turbo/apps/api/src/signals/services/agent-run-storage.service.ts|1|0330a5d1f37ab9eb618e51d7e8c65eb0d2cc4842da208cb342861397e58e35f1",
      "legacyVolumeSystemRead|turbo/apps/api/src/signals/services/agent-run-storage.service.ts|2|16600c560ff9fea1ec4adc6401abc62e257b4d67d5dc3fdbea1874c8762151e4",
      "legacyVolumeSystemRead|turbo/apps/api/src/signals/services/agent-run-storage.service.ts|3|16600c560ff9fea1ec4adc6401abc62e257b4d67d5dc3fdbea1874c8762151e4",
      "legacyVolumeSystemRead|turbo/apps/api/src/signals/services/agent-run-storage.service.ts|4|f458730b95dd9dfac4fc5d702d71269d35bf06894583f29978e4f5b99666b802",
      "legacyVolumeSystemRead|turbo/apps/api/src/signals/services/agent-run-storage.service.ts|5|f458730b95dd9dfac4fc5d702d71269d35bf06894583f29978e4f5b99666b802",
      "rawContentSource|turbo/apps/api/src/signals/routes/integrations-slack.ts|1|9fdd08fc8b09c8179bd7c05ee55c5c25c488ffacdb266b98fb465b36814686a6",
      "rawContentSource|turbo/apps/api/src/signals/services/agent-instructions.service.ts|1|9fdd08fc8b09c8179bd7c05ee55c5c25c488ffacdb266b98fb465b36814686a6",
      "rawContentSource|turbo/apps/api/src/signals/services/agent-run-create.service.ts|1|703de4b3ec6845b843695422610a6df4dcd3b62d7158b9ebb130d306b75a82e2",
      "rawContentSource|turbo/apps/api/src/signals/services/agent-run-create.service.ts|2|703de4b3ec6845b843695422610a6df4dcd3b62d7158b9ebb130d306b75a82e2",
      "rawContentSource|turbo/apps/api/src/signals/services/agent-run-create.service.ts|3|9fdd08fc8b09c8179bd7c05ee55c5c25c488ffacdb266b98fb465b36814686a6",
      "rawContentSource|turbo/apps/api/src/signals/services/logs.service.ts|1|e023e4f3f81e7dd6271af5bb8cc016593d071b202611ce86e8bf2fd6f1a658ee",
      "rawContentSource|turbo/apps/api/src/signals/services/logs.service.ts|2|0446280af1a57f17ee19d46ca28e22d7f20093bd508ee20e47c0e14a3063e8f2",
      "rawContentSource|turbo/apps/api/src/signals/services/telegram-data.service.ts|1|9fdd08fc8b09c8179bd7c05ee55c5c25c488ffacdb266b98fb465b36814686a6",
      "rawContentSource|turbo/apps/api/src/signals/services/zero-runs-create.service.ts|1|9fdd08fc8b09c8179bd7c05ee55c5c25c488ffacdb266b98fb465b36814686a6",
      "rawContentSource|turbo/apps/api/src/signals/services/zero-teams-connect.service.ts|1|9fdd08fc8b09c8179bd7c05ee55c5c25c488ffacdb266b98fb465b36814686a6",
      "rawRecursiveScan|turbo/apps/api/src/signals/routes/integrations-slack.ts|1|0357a0f694d2882516d811fff5f28d57abb01a6df4f2bdcb1f8435d0827ea17f",
      "rawRecursiveScan|turbo/apps/api/src/signals/services/telegram-data.service.ts|1|0357a0f694d2882516d811fff5f28d57abb01a6df4f2bdcb1f8435d0827ea17f",
      "rawRecursiveScan|turbo/apps/api/src/signals/services/zero-teams-connect.service.ts|1|0357a0f694d2882516d811fff5f28d57abb01a6df4f2bdcb1f8435d0827ea17f",
      "schemaParse|turbo/apps/api/src/signals/services/agent-instructions.service.ts|1|712fe12ea1d29b388940ea5921cabf4e2dd2dbc2229162e5210dba575ac256f9",
      "storageForwarding|turbo/apps/api/src/signals/services/agent-run-create.service.ts|1|14ef880a94a1bae38cf026d24cd1a98096a30e4a16df5a32a746f93fee32c04d",
      "zeroRunRawContentUse|turbo/apps/api/src/signals/services/zero-runs-create.service.ts|1|b59eb415f1b94645a15ac9a30463465caac4a5420b05052a4120ba65c9481e9b",
    ],
    reviewedConsumers: [
      "turbo/apps/api/src/signals/routes/integrations-slack.ts|raw-recursive-variable-secret-scan|1|0357a0f694d2882516d811fff5f28d57abb01a6df4f2bdcb1f8435d0827ea17f",
      "turbo/apps/api/src/signals/services/agent-environment-shadow.ts|compose-independent-environment-shadow|4|bb1c66722499e90deb9a6471567a6d374aefe0f68b878249d0fc4822ddaf3f13",
      "turbo/apps/api/src/signals/services/agent-instructions.service.ts|first-plural-schema-parse|2|5e0e03733f7327b9e719691adccd8ef9e643f7945e7a2011884b50c17cd0d5ca",
      "turbo/apps/api/src/signals/services/agent-run-create.service.ts|singular-or-first-plural-launch|18|eff82337ee0438f35a74d19fda0fbe828ab087c7f1c5078df06d677e782932d4",
      "turbo/apps/api/src/signals/services/agent-run-storage.service.ts|singular-or-first-plural-storage-and-volumes|8|f892995687452b9c164950e90aab24e9da198326187dea19b646864d71d35cf9",
      "turbo/apps/api/src/signals/services/logs.service.ts|first-plural-framework-display|1|ea68586f0591ce59e883d688f75c0a37ac6022e9eb4e5a2fb2cda1be037123ce",
      "turbo/apps/api/src/signals/services/telegram-data.service.ts|raw-recursive-variable-secret-scan|1|0357a0f694d2882516d811fff5f28d57abb01a6df4f2bdcb1f8435d0827ea17f",
      "turbo/apps/api/src/signals/services/zero-runs-create.service.ts|head-content-selection-and-type-projection|10|2024999e59b45ad3c3bea825eb72378830fdea625e5e5835da8627d5c17b8f2e",
      "turbo/apps/api/src/signals/services/zero-teams-connect.service.ts|raw-recursive-variable-secret-scan|1|0357a0f694d2882516d811fff5f28d57abb01a6df4f2bdcb1f8435d0827ea17f",
      "turbo/packages/api-contracts/src/contracts/composes.ts|schema-authority|5|cbd115e5355554442c40dd32d555cf19eda9746e639b83b47ec159f2d647b814",
      "turbo/packages/api-contracts/src/contracts/model-providers.ts|model-provider-binding-authority|11|695fe4feb473e80e1fbe28c0553c8bfea2198e8a88da4d063409e291e516cd76",
      "turbo/packages/api-contracts/src/contracts/runs.ts|run-status-authority|1|4d41dae835d0667075b46527798550126907a3998f179a0939928a00ad9e05bb",
      "turbo/packages/core/src/variable-expander.ts|recursive-reference-authority|5|e8485b641c88c3f52da34898be604a0ca467a2995c3338d0ff749ca210eeb46f",
    ],
  };

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function isExcluded(relativePath: string): boolean {
  return (
    relativePath.includes("/node_modules/") ||
    relativePath.includes("/dist/") ||
    relativePath.includes("/.typecheck/") ||
    relativePath.includes("/__tests__/") ||
    relativePath.includes("/__benches__/") ||
    relativePath.includes("/tests/") ||
    relativePath.includes("/test-fixtures/") ||
    relativePath.includes("/mocks/") ||
    relativePath.includes("/packages/db/scripts/") ||
    relativePath.includes("/packages/db/src/migrations/") ||
    relativePath.includes("/apps/api/src/scripts/dev-") ||
    /\/(?:test|dev)-[^/]+\.[cm]?[jt]sx?$/u.test(relativePath) ||
    /\.(?:bench|spec|suite|test)\.[cm]?[jt]sx?$/u.test(relativePath)
  );
}

async function listFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => {
    return a.name.localeCompare(b.name);
  })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

const printer = ts.createPrinter({ removeComments: true });

function normalizedNode(source: ts.SourceFile, node: ts.Node): string {
  return printer
    .printNode(ts.EmitHint.Unspecified, node, source)
    .replace(/\s+/gu, " ")
    .trim();
}

function nodeDigest(source: ts.SourceFile, nodes: readonly ts.Node[]): string {
  const hash = createHash("sha256");
  for (const node of nodes) {
    const normalized = normalizedNode(source, node);
    hash.update(Buffer.byteLength(normalized, "utf8").toString());
    hash.update(":");
    hash.update(normalized);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function calledName(call: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) {
    const receiver = call.expression.expression;
    if (
      call.expression.name.text === "safeParse" &&
      ts.isIdentifier(receiver) &&
      receiver.text === "agentComposeApiContentSchema"
    ) {
      return "agentComposeApiContentSchema.safeParse";
    }
  }
  return undefined;
}

function isLegacyVolumeSystemRead(
  parsed: ParsedProductionSource,
  node: ts.Node,
): node is ts.PropertyAccessExpression {
  return (
    parsed.relativePath ===
      "turbo/apps/api/src/signals/services/agent-run-storage.service.ts" &&
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "system" &&
    ["args.volume", "config", "volume"].includes(
      node.expression.getText(parsed.source),
    )
  );
}

function rawContentSourceNode(node: ts.PropertyAccessExpression): ts.Node {
  return ts.isPropertyAssignment(node.parent) ? node.parent : node;
}

function isHeadContentJoin(
  call: ts.CallExpression,
  source: ts.SourceFile,
): boolean {
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    !["innerJoin", "leftJoin"].includes(call.expression.name.text)
  ) {
    return false;
  }
  const [table, condition] = call.arguments;
  return (
    table?.getText(source) === "agentComposeVersions" &&
    condition?.getText(source).includes("agentComposeVersions.id") === true &&
    condition.getText(source).includes("agentComposes.headVersionId")
  );
}

function isZeroRunForwarding(
  node: ts.Node,
  source: ts.SourceFile,
): node is ts.AsExpression {
  return (
    ts.isAsExpression(node) &&
    node.type.getText(source) === "ZeroAgentComposeContent" &&
    node.expression.getText(source).endsWith(".content")
  );
}

function headContentJoinSemanticNodes(
  call: ts.CallExpression,
): readonly ts.Node[] {
  if (!ts.isPropertyAccessExpression(call.expression)) return [];
  return [call.expression.name, ...call.arguments];
}

function isComposeIdentityJoin(
  call: ts.CallExpression,
  source: ts.SourceFile,
): boolean {
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    !["innerJoin", "leftJoin"].includes(call.expression.name.text)
  ) {
    return false;
  }
  const [table, condition] = call.arguments;
  return (
    table?.getText(source) === "agentComposes" &&
    condition?.getText(source).includes("agentComposes.id") === true &&
    condition.getText(source).includes("zeroAgents.id")
  );
}

function isZeroRunRawContentUse(
  parsed: ParsedProductionSource,
  node: ts.Node,
): node is ts.PropertyAccessExpression {
  return (
    parsed.relativePath ===
      "turbo/apps/api/src/signals/services/zero-runs-create.service.ts" &&
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "agent" &&
    node.name.text === "content"
  );
}

interface ParsedProductionSource {
  readonly relativePath: string;
  readonly source: ts.SourceFile;
}

async function productionSources(
  repositoryRoot: string,
): Promise<ParsedProductionSource[]> {
  const roots = ["turbo/apps/api/src", "turbo/packages"];
  const result: ParsedProductionSource[] = [];
  for (const root of roots) {
    for (const filePath of await listFiles(path.join(repositoryRoot, root))) {
      const relativePath = normalizePath(
        path.relative(repositoryRoot, filePath),
      );
      if (
        isExcluded(`/${relativePath}`) ||
        (!relativePath.endsWith(".ts") && !relativePath.endsWith(".tsx"))
      ) {
        continue;
      }
      result.push({
        relativePath,
        source: ts.createSourceFile(
          relativePath,
          await fs.readFile(filePath, "utf8"),
          ts.ScriptTarget.Latest,
          true,
          relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        ),
      });
    }
  }
  return result.sort((a, b) => {
    return a.relativePath.localeCompare(b.relativePath);
  });
}

function discoveryEntries(parsed: ParsedProductionSource): string[] {
  const rawSources: ts.Node[] = [];
  const rawScans: ts.Node[] = [];
  const schemaParses: ts.Node[] = [];
  const storageForwarding: ts.Node[] = [];
  const volumeSystemReads: ts.Node[] = [];
  const zeroRunRawContentUses: ts.Node[] = [];
  const contentTypeDeclarations: ts.Node[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "agentComposeVersions" &&
      node.name.text === "content"
    ) {
      rawSources.push(rawContentSourceNode(node));
    }
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === "agentComposeVersions"
    ) {
      rawSources.push(node);
    }
    if (ts.isCallExpression(node)) {
      const name = calledName(node);
      if (
        name === "extractAndGroupVariables" &&
        node.arguments.some((argument) => {
          return argument.getText(parsed.source).includes(".content");
        })
      ) {
        rawScans.push(node);
      }
      if (name === "agentComposeApiContentSchema.safeParse") {
        schemaParses.push(node);
      }
      if (name === "prepareAgentRunStorage") storageForwarding.push(node);
    }
    if (isZeroRunRawContentUse(parsed, node)) {
      zeroRunRawContentUses.push(node);
    }
    if (
      ts.isInterfaceDeclaration(node) &&
      ["AgentComposeContent", "ZeroAgentComposeContent"].includes(
        node.name.text,
      )
    ) {
      contentTypeDeclarations.push(node);
    }
    if (isLegacyVolumeSystemRead(parsed, node)) {
      volumeSystemReads.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed.source);

  const kinds = [
    ["rawContentSource", rawSources],
    ["rawRecursiveScan", rawScans],
    ["schemaParse", schemaParses],
    ["storageForwarding", storageForwarding],
    ["legacyVolumeSystemRead", volumeSystemReads],
    ["zeroRunRawContentUse", zeroRunRawContentUses],
    ["contentTypeDeclaration", contentTypeDeclarations],
  ] as const;
  return kinds.flatMap(([kind, nodes]) => {
    return nodes
      .sort((a, b) => {
        return a.pos - b.pos;
      })
      .map((node, index) => {
        return `${kind}|${parsed.relativePath}|${index + 1}|${nodeDigest(parsed.source, [node])}`;
      });
  });
}

interface ReviewedNodeContext {
  readonly consumer: ReviewedConsumer;
  readonly parsed: ParsedProductionSource;
  readonly wantedFunctions: ReadonlySet<string>;
  readonly wantedInterfaces: ReadonlySet<string>;
  readonly wantedInterfaceProperties: ReadonlySet<string>;
  readonly wantedVariables: ReadonlySet<string>;
}

function propertySignatureKey(node: ts.Node): string | undefined {
  if (
    !ts.isPropertySignature(node) ||
    !ts.isInterfaceDeclaration(node.parent) ||
    (!ts.isIdentifier(node.name) && !ts.isStringLiteral(node.name))
  ) {
    return undefined;
  }
  return `${node.parent.name.text}.${node.name.text}`;
}

function configuredDeclarationNodes(
  context: ReviewedNodeContext,
  node: ts.Node,
): readonly ts.Node[] {
  if (
    ts.isFunctionDeclaration(node) &&
    node.name &&
    context.wantedFunctions.has(node.name.text)
  ) {
    return [node];
  }
  if (
    ts.isInterfaceDeclaration(node) &&
    context.wantedInterfaces.has(node.name.text)
  ) {
    return [node];
  }
  const propertyKey = propertySignatureKey(node);
  if (propertyKey && context.wantedInterfaceProperties.has(propertyKey)) {
    return [node];
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    context.wantedVariables.has(node.name.text)
  ) {
    return [node];
  }
  return [];
}

function modelProviderBindingNodes(
  consumer: ReviewedConsumer,
  node: ts.Node,
): readonly ts.Node[] {
  if (
    !consumer.modelProviderEnvironmentBindings ||
    !ts.isPropertyAssignment(node) ||
    (!ts.isIdentifier(node.name) && !ts.isStringLiteral(node.name)) ||
    node.name.text !== "envBindings"
  ) {
    return [];
  }
  return [node];
}

function sharedConsumerCallNodes(
  parsed: ParsedProductionSource,
  node: ts.Node,
): readonly ts.Node[] {
  if (!ts.isCallExpression(node)) return [];
  const name = calledName(node);
  const recursiveRawContentScan =
    name === "extractAndGroupVariables" &&
    node.arguments.some((argument) => {
      return argument.getText(parsed.source).includes(".content");
    });
  return recursiveRawContentScan ||
    name === "agentComposeApiContentSchema.safeParse" ||
    name === "prepareAgentRunStorage"
    ? [node]
    : [];
}

function headContentModeNodes(
  context: ReviewedNodeContext,
  node: ts.Node,
): readonly ts.Node[] {
  if (context.consumer.mode !== "head-content-selection-and-type-projection") {
    return [];
  }
  if (ts.isCallExpression(node)) {
    if (
      isHeadContentJoin(node, context.parsed.source) ||
      isComposeIdentityJoin(node, context.parsed.source)
    ) {
      return headContentJoinSemanticNodes(node);
    }
    return [];
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "agentComposeVersions" &&
    node.name.text === "content"
  ) {
    return [rawContentSourceNode(node)];
  }
  return isZeroRunForwarding(node, context.parsed.source) ? [node] : [];
}

function reviewedConsumerEntry(args: {
  readonly consumer: ReviewedConsumer;
  readonly parsed: ParsedProductionSource | undefined;
}): string {
  const nodes: ts.Node[] = [];
  if (args.parsed) {
    const parsed = args.parsed;
    const wantedFunctions = new Set(args.consumer.functions ?? []);
    const wantedInterfaces = new Set(args.consumer.interfaces ?? []);
    const wantedInterfaceProperties = new Set(
      (args.consumer.interfaceProperties ?? []).map((property) => {
        return `${property.interfaceName}.${property.propertyName}`;
      }),
    );
    const wantedVariables = new Set(args.consumer.variables ?? []);
    const context: ReviewedNodeContext = {
      consumer: args.consumer,
      parsed,
      wantedFunctions,
      wantedInterfaces,
      wantedInterfaceProperties,
      wantedVariables,
    };
    const visit = (node: ts.Node): void => {
      nodes.push(
        ...configuredDeclarationNodes(context, node),
        ...modelProviderBindingNodes(args.consumer, node),
        ...sharedConsumerCallNodes(parsed, node),
        ...headContentModeNodes(context, node),
      );
      ts.forEachChild(node, visit);
    };
    visit(parsed.source);
  }
  nodes.sort((a, b) => {
    return a.pos - b.pos;
  });
  const digest = args.parsed
    ? nodeDigest(args.parsed.source, nodes)
    : createHash("sha256").digest("hex");
  return `${args.consumer.relativePath}|${args.consumer.mode}|${nodes.length}|${digest}`;
}

export async function collectRuntimeContentConsumerManifest(
  repositoryRoot: string,
): Promise<RuntimeContentConsumerManifest> {
  const sources = await productionSources(repositoryRoot);
  const byPath = new Map(
    sources.map((source) => {
      return [source.relativePath, source] as const;
    }),
  );
  return {
    discovery: sources.flatMap(discoveryEntries).sort(),
    reviewedConsumers: REVIEWED_CONSUMERS.map((consumer) => {
      return reviewedConsumerEntry({
        consumer,
        parsed: byPath.get(consumer.relativePath),
      });
    }).sort(),
  };
}

export function runtimeContentConsumerManifestsEqual(
  expected: RuntimeContentConsumerManifest,
  observed: RuntimeContentConsumerManifest,
): boolean {
  return (
    JSON.stringify(expected.discovery) === JSON.stringify(observed.discovery) &&
    JSON.stringify(expected.reviewedConsumers) ===
      JSON.stringify(observed.reviewedConsumers)
  );
}
