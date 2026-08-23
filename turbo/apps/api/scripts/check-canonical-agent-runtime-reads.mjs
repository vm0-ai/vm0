#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(packageRoot, "../../..");
const runtimeRoots = [
  path.resolve(repositoryRoot, "turbo/apps"),
  path.resolve(repositoryRoot, "turbo/packages"),
];

const legacyIdentityExports = new Map([
  [
    "@okouai/db/schema/agent-compose",
    new Set(["agentComposes", "agentComposeVersions"]),
  ],
  ["@okouai/db/schema/zero-agent", new Set(["zeroAgents"])],
]);

const legacyReferenceExports = new Map([
  [
    "@okouai/db/schema/agent-session",
    new Map([["agentSessions", new Set(["agentComposeId"])]]),
  ],
  [
    "@okouai/db/schema/agent-run-session-conversation",
    new Map([["agentSessions", new Set(["agentComposeId"])]]),
  ],
  [
    "@okouai/db/schema/agentphone-user-agent-preference",
    new Map([
      ["agentphoneUserAgentPreferences", new Set(["selectedComposeId"])],
    ]),
  ],
  [
    "@okouai/db/schema/chat-event-search",
    new Map([["chatEventSearchMessages", new Set(["agentComposeId"])]]),
  ],
  [
    "@okouai/db/schema/chat-thread-event",
    new Map([["chatThreadEvents", new Set(["agentComposeId"])]]),
  ],
  [
    "@okouai/db/schema/chat-thread",
    new Map([["chatThreads", new Set(["agentComposeId"])]]),
  ],
  [
    "@okouai/db/schema/feishu-org-installation",
    new Map([["feishuOrgInstallations", new Set(["defaultComposeId"])]]),
  ],
  [
    "@okouai/db/schema/feishu-user-agent-preference",
    new Map([["feishuUserAgentPreferences", new Set(["selectedComposeId"])]]),
  ],
  [
    "@okouai/db/schema/github-installation",
    new Map([["githubInstallations", new Set(["defaultComposeId"])]]),
  ],
  [
    "@okouai/db/schema/slack-user-agent-preference",
    new Map([["slackUserAgentPreferences", new Set(["selectedComposeId"])]]),
  ],
  [
    "@okouai/db/schema/teams-user-agent-preference",
    new Map([["teamsUserAgentPreferences", new Set(["selectedComposeId"])]]),
  ],
  [
    "@okouai/db/schema/telegram-installation",
    new Map([["telegramInstallations", new Set(["defaultComposeId"])]]),
  ],
  [
    "@okouai/db/schema/telegram-user-agent-preference",
    new Map([["telegramUserAgentPreferences", new Set(["selectedComposeId"])]]),
  ],
]);

// Stage 7 owns these writes. A new legacy identity-table writer must be added
// deliberately here; reads are never admitted merely because a file writes.
const stage7IdentityWriters = new Set([
  "turbo/apps/api/src/signals/routes/agents.ts|upsertZeroAgentAfterCompose|zeroAgents|insert",
  "turbo/apps/api/src/signals/routes/agents.ts|createAgentInner$|zeroAgents|insert",
  "turbo/apps/api/src/signals/routes/agents.ts|updateAgentMetadataInner$|zeroAgents|update",
  "turbo/apps/api/src/signals/services/agent-compose-provenance-lifecycle.service.ts|deleteClerkAgentLifecycleData|agentComposes|delete",
  "turbo/apps/api/src/signals/services/agent-compose.service.ts|recomposeAgentIfStale$|agentComposeVersions|insert",
  "turbo/apps/api/src/signals/services/agent-compose.service.ts|recomposeAgentIfStale$|agentComposes|update",
  "turbo/apps/api/src/signals/services/agent-compose.service.ts|createServerSideZeroAgentCompose$|agentComposes|insert",
  "turbo/apps/api/src/signals/services/agent-compose.service.ts|createServerSideZeroAgentCompose$|agentComposeVersions|insert",
  "turbo/apps/api/src/signals/services/agent-compose.service.ts|createServerSideZeroAgentCompose$|agentComposes|update",
  "turbo/apps/api/src/signals/services/agent-compose.service.ts|serverSideZeroAgentCompose$|agentComposeVersions|insert",
  "turbo/apps/api/src/signals/services/agent-compose.service.ts|serverSideZeroAgentCompose$|agentComposes|update",
  "turbo/apps/api/src/signals/services/compose-data.service.ts|deleteComposeInTransaction|agentComposes|delete",
  "turbo/apps/api/src/signals/services/org-limited-free-bootstrap.service.ts|ensureBootstrapComposeRow|agentComposes|insert",
  "turbo/apps/api/src/signals/services/org-limited-free-bootstrap.service.ts|finalizeBootstrap|zeroAgents|insert",
  "turbo/apps/api/src/signals/services/webhooks-clerk-cleanup.service.ts|deleteOrgData|zeroAgents|delete",
  "turbo/apps/api/src/signals/services/webhooks-clerk-cleanup.service.ts|deleteUserData|agentComposeVersions|update",
]);

// Stage 7 also owns legacy dependent-reference writes. Each entry identifies
// one exact production scope and write operation; populate only from the
// refreshed writer inventory.
const stage7ReferenceWriters = new Set([
  "turbo/apps/api/src/signals/routes/integrations-telegram-bot-id.ts|updateCustomBot$|telegramInstallations|update|defaultComposeId",
  "turbo/apps/api/src/signals/routes/integrations-telegram-bot-id.ts|updateOfficialBot$|telegramUserAgentPreferences|insert|selectedComposeId",
  "turbo/apps/api/src/signals/services/agentphone-chat-ingress.service.ts|createCanonicalAgentPhoneChatThread|chatThreads|insert|agentComposeId",
  "turbo/apps/api/src/signals/services/chat-events.command.ts|createChatThread|chatThreads|insert|agentComposeId",
  "turbo/apps/api/src/signals/services/chat-thread-event.service.ts|appendChatThreadEvent|chatThreadEvents|insert|agentComposeId",
  "turbo/apps/api/src/signals/services/chat-thread.service.ts|createChatThread$|chatThreads|insert|agentComposeId",
  "turbo/apps/api/src/signals/services/feishu-chat-ingress.service.ts|ensureFeishuChatThreadRoute|chatThreads|insert|agentComposeId",
  "turbo/apps/api/src/signals/services/feishu-connect.service.ts|persistFeishuInstallation|feishuOrgInstallations|insert|defaultComposeId",
  "turbo/apps/api/src/signals/services/feishu-connect.service.ts|persistFeishuInstallation|feishuOrgInstallations|update|defaultComposeId",
  "turbo/apps/api/src/signals/services/feishu-connect.service.ts|updateFeishuInstallationAgent$|feishuOrgInstallations|update|defaultComposeId",
  "turbo/apps/api/src/signals/services/feishu-dispatch.service.ts|setUserAgentPreference|feishuUserAgentPreferences|insert|selectedComposeId",
  "turbo/apps/api/src/signals/services/github-oauth.service.ts|createOrActivateGithubInstallation|githubInstallations|insert|defaultComposeId",
  "turbo/apps/api/src/signals/services/github-oauth.service.ts|tryLinkGithubFromRemoteInstallations|githubInstallations|insert|defaultComposeId",
  "turbo/apps/api/src/signals/services/goal.service.ts|createGoalThread|chatThreads|insert|agentComposeId",
  "turbo/apps/api/src/signals/services/slack-chat-ingress.service.ts|ensureCanonicalSlackChatThreadRoute|chatThreads|insert|agentComposeId",
  "turbo/apps/api/src/signals/services/slack-webhooks.service.ts|setUserAgentPreference|slackUserAgentPreferences|insert|selectedComposeId",
  "turbo/apps/api/src/signals/services/teams-chat-ingress.service.ts|createCanonicalTeamsChatThread|chatThreads|insert|agentComposeId",
  "turbo/apps/api/src/signals/services/teams-dispatch.service.ts|setUserAgentPreference|teamsUserAgentPreferences|insert|selectedComposeId",
  "turbo/apps/api/src/signals/services/telegram-chat-ingress.service.ts|createCanonicalTelegramChatThread|chatThreads|insert|agentComposeId",
  "turbo/apps/api/src/signals/services/telegram-post.service.ts|handleExistingInstallation$|telegramInstallations|update|defaultComposeId",
  "turbo/apps/api/src/signals/services/telegram-post.service.ts|registerTelegramBot$|telegramInstallations|insert|defaultComposeId",
  "turbo/apps/api/src/signals/services/workflow-user-automation-thread.service.ts|createAutomationChatThread|chatThreads|insert|agentComposeId",
]);

// These write calls receive a typed payload built outside the Drizzle call,
// so the validator enumerates the exact opaque write boundary separately.
const stage7IndirectReferenceWriters = new Set([
  "turbo/apps/api/src/signals/services/agent-run-create.service.ts|buildAtomicLaunchCteContext|agentSessions|insert|agentComposeId",
  "turbo/apps/api/src/signals/services/agent-run-create.service.ts|insertLaunchRunRows|agentSessions|insert|agentComposeId",
  "turbo/apps/api/src/signals/services/cron-project-chat-event-search.service.ts|insertSearchMessages|chatEventSearchMessages|insert|agentComposeId",
]);

// These bounded reads are part of a Stage 7 write transaction: a lock and
// optimistic guard, a delete safety veto, and insert-conflict resolution.
const stage7WriterGuardReads = new Set([
  "turbo/apps/api/src/signals/services/agent-compose.service.ts|readAgentComposeHeadForWriterGuard|agentComposes",
  "turbo/apps/api/src/signals/services/agent-compose.service.ts|recomposeAgentIfStale$|agentComposes",
  "turbo/apps/api/src/signals/services/compose-data.service.ts|lockAgentLifecycleForDeletion|agentComposes",
  "turbo/apps/api/src/signals/services/compose-data.service.ts|lockAgentLifecycleForDeletion|agentComposeVersions",
  "turbo/apps/api/src/signals/services/org-limited-free-bootstrap.service.ts|ensureBootstrapComposeRow|agentComposes",
]);

// Stage 4 retained agent_runs.agent_compose_version_id as nullable physical
// rollback material. This exact helper reads only the current physical version
// reference to preserve that legacy dependent writer; it cannot supply Agent
// identity or configuration.
const legacyDependentWriterSupportReads = new Set([
  "turbo/apps/api/src/signals/services/agent-run-create.service.ts|readLegacyRunVersionProvenanceForWrite|agentComposes",
  "turbo/apps/api/src/signals/services/agent-run-create.service.ts|readLegacyRunVersionProvenanceForWrite|agentComposeVersions",
]);

// This exact runtime probe verifies the retained legacy provenance FK before
// a lifecycle delete. It is schema/FK compatibility evidence, not Agent data.
const schemaFkRuntimeProbes = new Set([
  "turbo/apps/api/src/signals/services/agent-compose-provenance-lifecycle.service.ts|assertAgentComposeProvenanceSchemaAvailable",
]);

const legacySqlTokens = [
  "agent_composes",
  "agent_compose_versions",
  "zero_agents",
  "agent_compose_id",
  "default_compose_id",
  "selected_compose_id",
];

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function relativePath(filePath) {
  return normalizePath(path.relative(repositoryRoot, filePath));
}

function isNonRuntimeSupport(filePath) {
  const relative = `/${normalizePath(path.relative(repositoryRoot, filePath))}`;
  return (
    relative.includes("/node_modules/") ||
    relative.includes("/dist/") ||
    relative.includes("/.next/") ||
    relative.includes("/.typecheck/") ||
    relative.includes("/.turbo/") ||
    relative.includes("/__tests__/") ||
    relative.includes("/__benches__/") ||
    relative.includes("/test-fixtures/") ||
    relative.includes("/migrations/") ||
    relative.includes("/scripts/") ||
    relative.includes("/packages/db/scripts/") ||
    relative.includes("/packages/db/src/schema/") ||
    relative.includes("/apps/api/src/signals/routes/test-") ||
    relative.endsWith("/apps/api/src/signals/routes/cli-auth-test.ts") ||
    /\.(?:bench|spec|suite|test)\.[cm]?[jt]sx?$/u.test(relative)
  );
}

function listRuntimeFiles(directory) {
  const files = [];
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => {
      return a.name.localeCompare(b.name);
    })) {
    const entryPath = path.join(directory, entry.name);
    if (isNonRuntimeSupport(entryPath)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...listRuntimeFiles(entryPath));
    } else if (entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function location(sourceFile, node) {
  const start = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return { line: start.line + 1, column: start.character + 1 };
}

function namedImports(sourceFile) {
  const identityBindings = new Map();
  const referenceBindings = new Map();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const moduleName = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const element of bindings.elements) {
      const exportedName = element.propertyName?.text ?? element.name.text;
      const localName = element.name.text;
      if (legacyIdentityExports.get(moduleName)?.has(exportedName)) {
        identityBindings.set(localName, exportedName);
      }
      const legacyProperties = legacyReferenceExports
        .get(moduleName)
        ?.get(exportedName);
      if (legacyProperties) {
        referenceBindings.set(localName, {
          exportedName,
          legacyProperties,
        });
      }
    }
  }
  return { identityBindings, referenceBindings };
}

function legacySchemaModule(moduleName) {
  return (
    legacyIdentityExports.has(moduleName) ||
    legacyReferenceExports.has(moduleName)
  );
}

function analyzeLegacyModuleBoundary(args) {
  if (
    ts.isImportDeclaration(args.node) &&
    ts.isStringLiteral(args.node.moduleSpecifier) &&
    legacySchemaModule(args.node.moduleSpecifier.text) &&
    args.node.importClause?.namedBindings &&
    ts.isNamespaceImport(args.node.importClause.namedBindings)
  ) {
    args.add(
      args.node,
      "namespace imports from legacy Agent schema modules are not allowed",
    );
  }
  if (
    ts.isExportDeclaration(args.node) &&
    args.node.moduleSpecifier &&
    ts.isStringLiteral(args.node.moduleSpecifier) &&
    legacySchemaModule(args.node.moduleSpecifier.text)
  ) {
    args.add(
      args.node,
      "runtime re-exports from legacy Agent schema modules are not allowed",
    );
  }
}

function callMethod(node) {
  return ts.isPropertyAccessExpression(node.expression)
    ? node.expression.name.text
    : undefined;
}

function identifierArgument(node) {
  const [argument] = node.arguments;
  return argument && ts.isIdentifier(argument) ? argument.text : undefined;
}

function enclosingScopeNames(node) {
  const names = [];
  let current = node.parent;
  while (current) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isMethodDeclaration(current)) &&
      current.name
    ) {
      names.push(current.name.getText());
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      names.push(current.name.text);
    }
    current = current.parent;
  }
  return names;
}

function stage7ReadAllowed(file, node, exportedName, allowances) {
  return enclosingScopeNames(node).some((scope) => {
    return allowances.has(`${file}|${scope}|${exportedName}`);
  });
}

function schemaProbeAllowed(file, node, allowances) {
  return enclosingScopeNames(node).some((scope) => {
    return allowances.has(`${file}|${scope}`);
  });
}

function literalText(node) {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  ) {
    return node.text;
  }
  return undefined;
}

function enclosingStatement(node) {
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (
      ts.isExpressionStatement(current) ||
      ts.isVariableStatement(current) ||
      ts.isReturnStatement(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return node.parent;
}

function isEnumeratedIdentityWriterUse(args) {
  const root = enclosingStatement(args.node);
  let enumeratedWriter = false;
  const findWriter = (candidate) => {
    if (ts.isCallExpression(candidate)) {
      const method = callMethod(candidate);
      const target = identifierArgument(candidate);
      if (
        target === args.localName &&
        ["insert", "update", "delete"].includes(method) &&
        args.stage7Writers.has(
          `${args.file}|${enclosingScopeNames(candidate).at(-1) ?? "<module>"}|${args.exportedIdentity}|${method}`,
        )
      ) {
        enumeratedWriter = true;
      }
    }
    ts.forEachChild(candidate, findWriter);
  };
  findWriter(root);
  return enumeratedWriter;
}

function chainedReferenceWriteTarget(node, referenceBindings) {
  let current = node;
  while (ts.isCallExpression(current)) {
    const method = callMethod(current);
    const localName = identifierArgument(current);
    const reference = localName ? referenceBindings.get(localName) : undefined;
    if (reference && ["insert", "update"].includes(method)) {
      return { ...reference, method };
    }
    const expression = current.expression;
    if (!ts.isPropertyAccessExpression(expression)) {
      return undefined;
    }
    current = expression.expression;
  }
  return undefined;
}

function legacyReferencePayloadFields(node, legacyProperties) {
  const fields = new Set();
  const findFields = (candidate) => {
    if (
      (ts.isPropertyAssignment(candidate) ||
        ts.isShorthandPropertyAssignment(candidate)) &&
      (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
      legacyProperties.has(candidate.name.text)
    ) {
      fields.add(candidate.name.text);
    }
    ts.forEachChild(candidate, findFields);
  };
  for (const argument of node.arguments) {
    findFields(argument);
  }
  return fields;
}

function hasOpaqueWritePayload(node) {
  return node.arguments.some((argument) => {
    if (ts.isObjectLiteralExpression(argument)) {
      return false;
    }
    if (ts.isArrayLiteralExpression(argument)) {
      return argument.elements.some((element) => {
        return !ts.isObjectLiteralExpression(element);
      });
    }
    return true;
  });
}

function referenceWriterKey(args) {
  const scopes = enclosingScopeNames(args.node);
  const scope = scopes.at(-1) ?? "<module>";
  return `${args.file}|${scope}|${args.exportedName}|${args.method}|${args.field}`;
}

function analyzeIdentityCall(args) {
  const method = callMethod(args.node);
  const localName = identifierArgument(args.node);
  const exportedName = localName
    ? args.identityBindings.get(localName)
    : undefined;
  if (!exportedName || !localName) {
    return;
  }
  args.identityUses.add(localName);
  if (["insert", "update", "delete"].includes(method)) {
    const writerKey = `${args.file}|${enclosingScopeNames(args.node).at(-1) ?? "<module>"}|${exportedName}|${method}`;
    if (!args.stage7Writers.has(writerKey)) {
      args.add(
        args.node,
        `legacy identity write is not an enumerated Stage 7 writer: ${exportedName}.${method}`,
      );
    }
    return;
  }
  if (
    ["from", "innerJoin", "leftJoin", "rightJoin", "fullJoin"].includes(
      method,
    ) &&
    !stage7ReadAllowed(args.file, args.node, exportedName, args.stage7Reads)
  ) {
    args.add(
      args.node,
      `runtime Agent read must use canonical agents; found ${method}(${exportedName})`,
    );
  }
}

function reportUnenumeratedReferenceWrites(args) {
  for (const field of args.fields) {
    const key = referenceWriterKey({
      node: args.node,
      file: args.file,
      exportedName: args.target.exportedName,
      method: args.target.method,
      field,
    });
    if (!args.allowances.has(key)) {
      args.add(args.node, `${args.message}: ${key}`);
    }
  }
}

function analyzeReferenceWriteCall(args) {
  const method = callMethod(args.node);
  if (!["values", "set", "onConflictDoUpdate"].includes(method)) {
    return;
  }
  const target = chainedReferenceWriteTarget(args.node, args.referenceBindings);
  if (!target) {
    return;
  }
  const fields = legacyReferencePayloadFields(
    args.node,
    target.legacyProperties,
  );
  reportUnenumeratedReferenceWrites({
    node: args.node,
    file: args.file,
    target,
    fields,
    allowances: args.stage7ReferenceWriters,
    message: "legacy reference write is not an enumerated Stage 7 writer",
    add: args.add,
  });
  if (
    !["values", "set"].includes(method) ||
    fields.size > 0 ||
    !hasOpaqueWritePayload(args.node)
  ) {
    return;
  }
  reportUnenumeratedReferenceWrites({
    node: args.node,
    file: args.file,
    target,
    fields: target.legacyProperties,
    allowances: args.stage7IndirectReferenceWriters,
    message:
      "opaque legacy reference write is not an enumerated Stage 7 writer",
    add: args.add,
  });
}

function analyzePropertyAccess(args) {
  if (
    !ts.isPropertyAccessExpression(args.node) ||
    !ts.isIdentifier(args.node.expression)
  ) {
    return;
  }
  const localName = args.node.expression.text;
  const exportedIdentity = args.identityBindings.get(localName);
  if (exportedIdentity) {
    args.identityUses.add(localName);
    const enumeratedWriter = isEnumeratedIdentityWriterUse({
      node: args.node,
      localName,
      exportedIdentity,
      file: args.file,
      stage7Writers: args.stage7Writers,
    });
    if (
      !enumeratedWriter &&
      !stage7ReadAllowed(
        args.file,
        args.node,
        exportedIdentity,
        args.stage7Reads,
      )
    ) {
      args.add(
        args.node,
        `runtime Agent field read must use canonical agents; found ${exportedIdentity}.${args.node.name.text}`,
      );
    }
  }
  const reference = args.referenceBindings.get(localName);
  if (reference?.legacyProperties.has(args.node.name.text)) {
    args.add(
      args.node,
      `runtime reference read must use the canonical field; found ${reference.exportedName}.${args.node.name.text}`,
    );
  }
}

function analyzeLegacyLiteral(args) {
  const text = literalText(args.node);
  if (!text) {
    return;
  }
  const normalizedText = text.toLowerCase();
  const tokens = legacySqlTokens.filter((token) => {
    return normalizedText.includes(token);
  });
  if (
    tokens.length > 0 &&
    !schemaProbeAllowed(args.file, args.node, args.schemaProbes)
  ) {
    args.add(
      args.node,
      `runtime SQL/literal references legacy Agent storage: ${tokens.join(", ")}`,
    );
  }
}

function analyzeSource(args) {
  const sourceFile = ts.createSourceFile(
    args.file,
    args.sourceText,
    ts.ScriptTarget.Latest,
    true,
    args.file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const { identityBindings, referenceBindings } = namedImports(sourceFile);
  const violations = [];
  const identityUses = new Set();

  function add(node, message) {
    violations.push({
      file: args.file,
      ...location(sourceFile, node),
      message,
    });
  }

  function visit(node) {
    analyzeLegacyModuleBoundary({ node, add });
    if (ts.isCallExpression(node)) {
      analyzeIdentityCall({
        node,
        file: args.file,
        identityBindings,
        identityUses,
        stage7Reads: args.stage7Reads,
        stage7Writers: args.stage7Writers,
        add,
      });
      analyzeReferenceWriteCall({
        node,
        file: args.file,
        referenceBindings,
        stage7IndirectReferenceWriters: args.stage7IndirectReferenceWriters,
        stage7ReferenceWriters: args.stage7ReferenceWriters,
        add,
      });
    }
    analyzePropertyAccess({
      node,
      file: args.file,
      identityBindings,
      identityUses,
      referenceBindings,
      stage7Reads: args.stage7Reads,
      stage7Writers: args.stage7Writers,
      add,
    });
    analyzeLegacyLiteral({
      node,
      file: args.file,
      schemaProbes: args.schemaProbes,
      add,
    });
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  for (const [localName, exportedName] of identityBindings) {
    if (!identityUses.has(localName)) {
      add(
        sourceFile,
        `unused legacy identity import is not allowed in runtime code: ${exportedName}`,
      );
    }
  }
  return violations;
}

function assertReferenceWriterSelfTests(violations, fixturePath) {
  const writerKey = `${fixturePath}|writeThread|chatThreads|insert|agentComposeId`;
  const directWriter = `
    import { chatThreads } from "@okouai/db/schema/chat-thread";
    function writeThread() {
      return db.insert(chatThreads).values({ agentComposeId: id });
    }
  `;
  if (
    violations(directWriter).length === 0 ||
    violations(directWriter, {
      stage7ReferenceWriters: new Set([writerKey]),
    }).length > 0
  ) {
    throw new Error(
      "validator self-test failed to enumerate legacy reference writers",
    );
  }

  const opaqueWriter = `
    import { chatThreads } from "@okouai/db/schema/chat-thread";
    function writeThread() {
      return db.insert(chatThreads).values(payload);
    }
  `;
  if (
    violations(opaqueWriter).length === 0 ||
    violations(opaqueWriter, {
      stage7IndirectReferenceWriters: new Set([writerKey]),
    }).length > 0
  ) {
    throw new Error(
      "validator self-test failed to enumerate opaque legacy reference writers",
    );
  }
}

function assertSelfTests() {
  const fixturePath = "turbo/apps/api/src/validator-fixture.ts";
  const base = {
    file: fixturePath,
    stage7Reads: new Set(),
    stage7IndirectReferenceWriters: new Set(),
    stage7ReferenceWriters: new Set(),
    stage7Writers: new Set(),
    schemaProbes: new Set(),
  };
  const violations = (sourceText, overrides = {}) => {
    return analyzeSource({ ...base, ...overrides, sourceText });
  };

  if (
    violations(`
      import { agents } from "@okouai/db/schema/agent";
      import { agentComposes } from "@okouai/db/schema/agent-compose";
      db.select({ id: agentComposes.id }).from(agentComposes);
      db.select({ id: agents.id }).from(agents);
    `).length === 0
  ) {
    throw new Error("validator self-test failed to reject a legacy table read");
  }

  assertReferenceWriterSelfTests(violations, fixturePath);
  if (
    violations(`
      import { agentComposes as legacyAgents } from "@okouai/db/schema/agent-compose";
      db.select().innerJoin(legacyAgents, predicate);
    `).length === 0
  ) {
    throw new Error("validator self-test failed to reject an aliased join");
  }
  if (
    violations(`
      import * as legacy from "@okouai/db/schema/agent-compose";
      db.select().from(legacy.agentComposes);
    `).length === 0
  ) {
    throw new Error("validator self-test failed to reject a namespace import");
  }
  if (
    violations(`
      export { agentComposes as runtimeAgents } from "@okouai/db/schema/agent-compose";
    `).length === 0
  ) {
    throw new Error("validator self-test failed to reject a legacy re-export");
  }
  if (
    violations(`
      import { chatThreads as threads } from "@okouai/db/schema/chat-thread";
      db.select({ id: threads.agentComposeId }).from(threads);
    `).length === 0
  ) {
    throw new Error("validator self-test failed to reject a legacy reference");
  }
  if (
    violations("db.execute(sql`SELECT * FROM agent_composes`);").length === 0
  ) {
    throw new Error("validator self-test failed to reject raw legacy SQL");
  }

  const writerKey = `${fixturePath}|<module>|agentComposes|insert`;
  if (
    violations(
      `
        import { agentComposes } from "@okouai/db/schema/agent-compose";
        db.insert(agentComposes).values({ name: "writer" }).returning({ id: agentComposes.id });
      `,
      { stage7Writers: new Set([writerKey]) },
    ).length > 0
  ) {
    throw new Error(
      "validator self-test rejected an enumerated Stage 7 writer",
    );
  }

  if (
    violations(`
      import { agents } from "@okouai/db/schema/agent";
      import { chatThreads } from "@okouai/db/schema/chat-thread";
      db.insert(chatThreads).values({ title: "writer" });
      db.select({ id: agents.id }).from(agents);
    `).length > 0
  ) {
    throw new Error(
      "validator self-test rejected a canonical read or non-legacy write payload",
    );
  }

  const guardKey = `${fixturePath}|guardedWriter|agentComposes`;
  if (
    violations(
      `
        import { agentComposes } from "@okouai/db/schema/agent-compose";
        function guardedWriter() {
          return db.select({ id: agentComposes.id }).from(agentComposes).for("update");
        }
      `,
      { stage7Reads: new Set([guardKey]) },
    ).length > 0
  ) {
    throw new Error("validator self-test rejected an enumerated writer guard");
  }

  if (
    !isNonRuntimeSupport(
      path.join(packageRoot, "src/__tests__/fixture.test.ts"),
    )
  ) {
    throw new Error("validator self-test failed to classify test-only support");
  }
  if (
    !isNonRuntimeSupport(
      path.join(repositoryRoot, "turbo/packages/db/src/migrations/fixture.sql"),
    )
  ) {
    throw new Error("validator self-test failed to classify migrations");
  }
}

assertSelfTests();

const runtimeFiles = runtimeRoots.flatMap(listRuntimeFiles);
const allowedLegacyWriterReads = new Set([
  ...stage7WriterGuardReads,
  ...legacyDependentWriterSupportReads,
]);
const violations = runtimeFiles.flatMap((filePath) => {
  return analyzeSource({
    file: relativePath(filePath),
    sourceText: fs.readFileSync(filePath, "utf8"),
    stage7Reads: allowedLegacyWriterReads,
    stage7IndirectReferenceWriters,
    stage7ReferenceWriters,
    stage7Writers: stage7IdentityWriters,
    schemaProbes: schemaFkRuntimeProbes,
  });
});

if (violations.length > 0) {
  process.stderr.write(
    "Canonical Agent runtime-read validation failed (Stage 6 reads canonical; Stage 7 retains enumerated writers):\n",
  );
  for (const violation of violations) {
    process.stderr.write(
      `  ${violation.file}:${violation.line}:${violation.column} ${violation.message}\n`,
    );
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Canonical Agent runtime-read validation passed across ${runtimeFiles.length} production source files (${stage7IdentityWriters.size} Stage 7 identity writer keys, ${stage7ReferenceWriters.size} direct and ${stage7IndirectReferenceWriters.size} opaque Stage 7 reference writer keys, ${stage7WriterGuardReads.size} writer guards, ${legacyDependentWriterSupportReads.size} dependent-writer support reads, ${schemaFkRuntimeProbes.size} schema/FK probe).\n`,
  );
}
