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

const referenceConstraintContracts = new Map([
  [
    "agentSessions",
    { canonicalProperties: new Set(["agentId"]), kind: "immutable-equality" },
  ],
  [
    "chatThreads",
    { canonicalProperties: new Set(["agentId"]), kind: "immutable-equality" },
  ],
  [
    "chatThreadEvents",
    { canonicalProperties: new Set(["agentId"]), kind: "immutable-equality" },
  ],
  [
    "chatEventSearchMessages",
    { canonicalProperties: new Set(["agentId"]), kind: "immutable-equality" },
  ],
  [
    "telegramInstallations",
    {
      canonicalProperties: new Set(["defaultAgentId"]),
      kind: "mutable-required",
    },
  ],
  [
    "feishuOrgInstallations",
    {
      canonicalProperties: new Set(["defaultAgentId"]),
      kind: "mutable-required",
    },
  ],
  [
    "githubInstallations",
    {
      canonicalProperties: new Set(["defaultAgentId"]),
      kind: "immutable-equality",
    },
  ],
  [
    "slackUserAgentPreferences",
    {
      canonicalProperties: new Set(["selectedAgentId"]),
      kind: "mutable-nullable",
    },
  ],
  [
    "teamsUserAgentPreferences",
    {
      canonicalProperties: new Set(["selectedAgentId"]),
      kind: "mutable-nullable",
    },
  ],
  [
    "agentphoneUserAgentPreferences",
    {
      canonicalProperties: new Set(["selectedAgentId"]),
      kind: "immutable-equality",
    },
  ],
  [
    "telegramUserAgentPreferences",
    {
      canonicalProperties: new Set(["selectedAgentId"]),
      kind: "mutable-nullable",
    },
  ],
  [
    "feishuUserAgentPreferences",
    {
      canonicalProperties: new Set(["selectedAgentId"]),
      kind: "mutable-nullable",
    },
  ],
]);

const expectedCanonicalReferenceMutationOccurrences = new Map([
  ["telegramInstallations|update|defaultAgentId", 2],
  ["feishuOrgInstallations|update|defaultAgentId", 2],
  ["slackUserAgentPreferences|upsert|selectedAgentId", 1],
  ["teamsUserAgentPreferences|upsert|selectedAgentId", 1],
  ["telegramUserAgentPreferences|upsert|selectedAgentId", 1],
  ["feishuUserAgentPreferences|upsert|selectedAgentId", 1],
]);

const referenceConstraintSchemaContracts = [
  [
    "turbo/packages/db/src/schema/agent-run-session-conversation.ts",
    "agent_sessions_agent_reference_match",
    "immutable-equality",
  ],
  [
    "turbo/packages/db/src/schema/chat-thread.ts",
    "chat_threads_agent_reference_match",
    "immutable-equality",
  ],
  [
    "turbo/packages/db/src/schema/chat-thread-event.ts",
    "chat_thread_events_agent_reference_match",
    "immutable-equality",
  ],
  [
    "turbo/packages/db/src/schema/chat-event-search.ts",
    "chat_event_search_messages_agent_reference_match",
    "immutable-equality",
  ],
  [
    "turbo/packages/db/src/schema/telegram-installation.ts",
    "telegram_installations_agent_reference_match",
    "mutable-required",
  ],
  [
    "turbo/packages/db/src/schema/feishu-org-installation.ts",
    "feishu_org_installations_agent_reference_match",
    "mutable-required",
  ],
  [
    "turbo/packages/db/src/schema/github-installation.ts",
    "github_installations_agent_reference_match",
    "immutable-equality",
  ],
  [
    "turbo/packages/db/src/schema/slack-user-agent-preference.ts",
    "slack_user_agent_preferences_agent_reference_match",
    "mutable-nullable",
  ],
  [
    "turbo/packages/db/src/schema/teams-user-agent-preference.ts",
    "teams_user_agent_preferences_agent_reference_match",
    "mutable-nullable",
  ],
  [
    "turbo/packages/db/src/schema/agentphone-user-agent-preference.ts",
    "agentphone_user_agent_preferences_agent_reference_match",
    "immutable-equality",
  ],
  [
    "turbo/packages/db/src/schema/telegram-user-agent-preference.ts",
    "telegram_user_agent_preferences_agent_reference_match",
    "mutable-nullable",
  ],
  [
    "turbo/packages/db/src/schema/feishu-user-agent-preference.ts",
    "feishu_user_agent_preferences_agent_reference_match",
    "mutable-nullable",
  ],
];

// Stage 8 PR 1 permits only these exact lifecycle teardown and privacy
// de-identification statements against legacy identity/config tables. They
// must also execute inside the schema-absence-safe savepoint boundary below.
// Canonical create/update authority is never admitted here, and reads are not
// admitted merely because a file writes.
const pr1IdentityWriterExpectedOccurrences = new Map([
  [
    "turbo/apps/api/src/signals/services/agent-compose-provenance-lifecycle.service.ts|deleteLegacyAgentIdentitiesInTransaction|agentComposes|delete",
    1,
  ],
  [
    "turbo/apps/api/src/signals/services/agent-compose-provenance-lifecycle.service.ts|scrubLegacyAgentComposeVersionCreatorInTransaction|agentComposeVersions|update",
    1,
  ],
]);
const pr1IdentityWriters = new Set(pr1IdentityWriterExpectedOccurrences.keys());
const legacyPrivacyTeardownBoundary = {
  file: "turbo/apps/api/src/signals/services/agent-compose-provenance-lifecycle.service.ts",
  functionName: "withLegacyAgentPrivacyTeardownSavepoint",
};

// Stage 7 has no legacy dependent-reference writers.
const stage7ReferenceWriters = new Set([]);

// Opaque legacy dependent-reference payloads are also forbidden.
const stage7IndirectReferenceWriters = new Set([]);

// Stage 7 has no legacy writer guards.
const stage7WriterGuardReads = new Set([]);

// Stage 7 has no Run-version dependent-writer support reads.
const legacyDependentWriterSupportReads = new Set([]);

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

function referenceConstraintContractViolations() {
  const violations = [];
  for (const [
    file,
    constraintName,
    kind,
  ] of referenceConstraintSchemaContracts) {
    const absolutePath = path.resolve(repositoryRoot, file);
    const sourceText = fs.readFileSync(absolutePath, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const matchingChecks = [];
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "check" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === constraintName
      ) {
        matchingChecks.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    const add = (node, message) => {
      violations.push({
        file,
        ...(node ? location(sourceFile, node) : { line: 1, column: 1 }),
        message,
      });
    };
    if (kind === "mutable-nullable") {
      for (const checkNode of matchingChecks) {
        add(
          checkNode,
          `mutable nullable reference must not retain ${constraintName}`,
        );
      }
      continue;
    }
    if (matchingChecks.length !== 1) {
      add(
        matchingChecks[0],
        `${kind} reference must define ${constraintName} exactly once; found ${matchingChecks.length}`,
      );
      continue;
    }

    const checkNode = matchingChecks[0];
    const expression = checkNode.arguments[1]?.getText(sourceFile) ?? "";
    const nullCount = (expression.match(/\bIS NULL\b/gu) ?? []).length;
    const notNullCount = (expression.match(/\bIS NOT NULL\b/gu) ?? []).length;
    const distinctCount = (expression.match(/\bIS NOT DISTINCT FROM\b/gu) ?? [])
      .length;
    if (
      kind === "immutable-equality" &&
      (nullCount !== 2 || notNullCount !== 0 || distinctCount !== 1)
    ) {
      add(
        checkNode,
        `${constraintName} must use the symmetric immutable equality contract`,
      );
    }
    if (
      kind === "mutable-required" &&
      (nullCount !== 0 || notNullCount !== 2 || distinctCount !== 0)
    ) {
      add(
        checkNode,
        `${constraintName} must require at least one mutable reference sibling`,
      );
    }
  }
  return violations;
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
        const constraintContract =
          referenceConstraintContracts.get(exportedName);
        if (!constraintContract) {
          throw new Error(
            `missing Stage 7 reference constraint contract for ${exportedName}`,
          );
        }
        referenceBindings.set(localName, {
          exportedName,
          legacyProperties,
          ...constraintContract,
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

function isInsideLegacyPrivacyTeardownBoundary(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === legacyPrivacyTeardownBoundary.functionName
    ) {
      const cleanup = current.arguments[1];
      return (
        cleanup !== undefined &&
        (ts.isArrowFunction(cleanup) || ts.isFunctionExpression(cleanup)) &&
        cleanup.pos <= node.pos &&
        node.end <= cleanup.end
      );
    }
    current = current.parent;
  }
  return false;
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
        isInsideLegacyPrivacyTeardownBoundary(candidate) &&
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

function opaquePayloadExpressions(node) {
  const expressions = [];
  const collect = (candidate) => {
    while (
      ts.isParenthesizedExpression(candidate) ||
      ts.isAsExpression(candidate) ||
      ts.isTypeAssertionExpression(candidate)
    ) {
      candidate = candidate.expression;
    }
    if (ts.isObjectLiteralExpression(candidate)) {
      for (const property of candidate.properties) {
        if (ts.isSpreadAssignment(property)) {
          collect(property.expression);
        }
      }
      return;
    }
    if (ts.isConditionalExpression(candidate)) {
      collect(candidate.whenTrue);
      collect(candidate.whenFalse);
      return;
    }
    if (ts.isArrayLiteralExpression(candidate)) {
      for (const element of candidate.elements) {
        if (ts.isSpreadElement(element)) {
          expressions.push(element.expression);
        } else {
          collect(element);
        }
      }
      return;
    }
    expressions.push(candidate);
  };
  for (const argument of node.arguments) {
    collect(argument);
  }
  return expressions;
}

function hasOpaqueWritePayload(node) {
  return opaquePayloadExpressions(node).length > 0;
}

function enclosingParameterType(identifier) {
  let current = identifier.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      const parameter = current.parameters.find((candidate) => {
        return (
          ts.isIdentifier(candidate.name) &&
          candidate.name.text === identifier.text
        );
      });
      return parameter?.type;
    }
    current = current.parent;
  }
  return undefined;
}

function declaredPayloadTypeName(typeNode) {
  let current = typeNode;
  while (current && ts.isTypeOperatorNode(current)) {
    current = current.type;
  }
  if (current && ts.isArrayTypeNode(current)) {
    current = current.elementType;
  }
  if (
    current &&
    ts.isTypeReferenceNode(current) &&
    ts.isIdentifier(current.typeName)
  ) {
    return current.typeName.text;
  }
  return undefined;
}

function declaredPayloadFields(sourceFile, typeName) {
  const declaration = sourceFile.statements.find((statement) => {
    return (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name.text === typeName
    );
  });
  const members =
    declaration && ts.isInterfaceDeclaration(declaration)
      ? declaration.members
      : declaration &&
          ts.isTypeAliasDeclaration(declaration) &&
          ts.isTypeLiteralNode(declaration.type)
        ? declaration.type.members
        : undefined;
  if (!members || members.length === 0) {
    return undefined;
  }
  const fields = new Set();
  for (const member of members) {
    if (
      !ts.isPropertySignature(member) ||
      (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name))
    ) {
      return undefined;
    }
    fields.add(member.name.text);
  }
  return fields;
}

function functionReturnType(sourceFile, functionName) {
  const declaration = sourceFile.statements.find((statement) => {
    return (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === functionName
    );
  });
  return declaration?.type;
}

function payloadTypeNode(expression, sourceFile) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  if (ts.isIdentifier(current)) {
    return enclosingParameterType(current);
  }
  if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
    return functionReturnType(sourceFile, current.expression.text);
  }
  return undefined;
}

function canonicalOpaquePayloadShape(node, sourceFile, legacyProperties) {
  const opaqueExpressions = opaquePayloadExpressions(node);
  if (opaqueExpressions.length === 0) {
    return false;
  }
  return opaqueExpressions.every((expression) => {
    const typeName = declaredPayloadTypeName(
      payloadTypeNode(expression, sourceFile),
    );
    const fields = typeName
      ? declaredPayloadFields(sourceFile, typeName)
      : undefined;
    return (
      fields !== undefined &&
      [...legacyProperties].every((field) => {
        return !fields.has(field);
      })
    );
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
        `legacy identity write is not an enumerated PR 1 teardown/privacy writer: ${exportedName}.${method}`,
      );
    } else if (!isInsideLegacyPrivacyTeardownBoundary(args.node)) {
      args.add(
        args.node,
        `enumerated legacy identity write is outside ${legacyPrivacyTeardownBoundary.functionName}: ${exportedName}.${method}`,
      );
    } else if (args.observedWriterOccurrences) {
      args.observedWriterOccurrences.set(
        writerKey,
        (args.observedWriterOccurrences.get(writerKey) ?? 0) + 1,
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
  analyzeCanonicalReferenceMutation({
    ...args,
    method,
    target,
  });
  if (
    !["values", "set"].includes(method) ||
    fields.size > 0 ||
    !hasOpaqueWritePayload(args.node) ||
    canonicalOpaquePayloadShape(
      args.node,
      args.sourceFile,
      target.legacyProperties,
    )
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

function upsertHasOpaqueSet(node) {
  const [options] = node.arguments;
  if (!options || !ts.isObjectLiteralExpression(options)) {
    return true;
  }
  const setProperty = options.properties.find((property) => {
    return (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === "set"
    );
  });
  return (
    !setProperty ||
    !ts.isPropertyAssignment(setProperty) ||
    !ts.isObjectLiteralExpression(setProperty.initializer) ||
    setProperty.initializer.properties.some((property) => {
      return ts.isSpreadAssignment(property);
    })
  );
}

function analyzeCanonicalReferenceMutation(args) {
  const mutationKind =
    args.method === "set" && args.target.method === "update"
      ? "update"
      : args.method === "onConflictDoUpdate" && args.target.method === "insert"
        ? "upsert"
        : undefined;
  if (!mutationKind) {
    return;
  }

  const fields = legacyReferencePayloadFields(
    args.node,
    args.target.canonicalProperties,
  );
  const opaque =
    mutationKind === "upsert"
      ? upsertHasOpaqueSet(args.node)
      : hasOpaqueWritePayload(args.node) &&
        !canonicalOpaquePayloadShape(
          args.node,
          args.sourceFile,
          args.target.canonicalProperties,
        );
  if (fields.size === 0) {
    if (opaque) {
      args.add(
        args.node,
        `opaque canonical reference ${mutationKind} cannot be classified for ${args.target.exportedName}`,
      );
    }
    return;
  }

  for (const field of fields) {
    const key = `${args.target.exportedName}|${mutationKind}|${field}`;
    if (args.target.kind === "immutable-equality") {
      args.add(
        args.node,
        `canonical mutation violates immutable reference classification: ${key}`,
      );
      continue;
    }
    if (args.observedCanonicalReferenceMutations) {
      args.observedCanonicalReferenceMutations.set(
        key,
        (args.observedCanonicalReferenceMutations.get(key) ?? 0) + 1,
      );
    }
  }
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
  if (tokens.length > 0) {
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
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === legacyPrivacyTeardownBoundary.functionName
    ) {
      if (args.file !== legacyPrivacyTeardownBoundary.file) {
        add(
          node,
          `legacy privacy/teardown boundary must be declared only in ${legacyPrivacyTeardownBoundary.file}`,
        );
      } else if (args.observedBoundaryDefinitions) {
        args.observedBoundaryDefinitions.count += 1;
      }
    }
    analyzeLegacyModuleBoundary({ node, add });
    if (ts.isCallExpression(node)) {
      analyzeIdentityCall({
        node,
        file: args.file,
        identityBindings,
        identityUses,
        stage7Reads: args.stage7Reads,
        stage7Writers: args.stage7Writers,
        observedWriterOccurrences: args.observedWriterOccurrences,
        add,
      });
      analyzeReferenceWriteCall({
        node,
        sourceFile,
        file: args.file,
        referenceBindings,
        stage7IndirectReferenceWriters: args.stage7IndirectReferenceWriters,
        stage7ReferenceWriters: args.stage7ReferenceWriters,
        observedCanonicalReferenceMutations:
          args.observedCanonicalReferenceMutations,
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

function assertLegacyReferenceWriterSelfTests(violations, fixturePath) {
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

function assertReferenceWriterSelfTests(violations, fixturePath) {
  assertLegacyReferenceWriterSelfTests(violations, fixturePath);

  const canonicalTypedPayload = `
    import { chatThreads } from "@okouai/db/schema/chat-thread";
    interface CanonicalThreadInsert { readonly agentId: string; }
    function writeThread(payload: readonly CanonicalThreadInsert[]) {
      return db.insert(chatThreads).values([...payload]);
    }
  `;
  if (violations(canonicalTypedPayload).length > 0) {
    throw new Error(
      "validator self-test rejected a typed canonical opaque payload",
    );
  }

  const legacyTypedPayload = `
    import { chatThreads } from "@okouai/db/schema/chat-thread";
    interface LegacyThreadInsert { readonly agentComposeId: string; }
    function writeThread(payload: readonly LegacyThreadInsert[]) {
      return db.insert(chatThreads).values([...payload]);
    }
  `;
  if (violations(legacyTypedPayload).length === 0) {
    throw new Error(
      "validator self-test accepted a typed legacy opaque payload",
    );
  }

  const canonicalHelperPayload = `
    import { chatThreads } from "@okouai/db/schema/chat-thread";
    interface CanonicalThreadInsert { readonly agentId: string; }
    function threadValues(): CanonicalThreadInsert {
      return { agentId: id };
    }
    function writeThread() {
      return db.insert(chatThreads).values({ ...threadValues() });
    }
  `;
  if (violations(canonicalHelperPayload).length > 0) {
    throw new Error(
      "validator self-test rejected a typed canonical helper payload",
    );
  }

  const legacyHelperPayload = `
    import { chatThreads } from "@okouai/db/schema/chat-thread";
    interface LegacyThreadInsert { readonly agentComposeId: string; }
    function threadValues(): LegacyThreadInsert {
      return { agentComposeId: id };
    }
    function writeThread() {
      return db.insert(chatThreads).values({ ...threadValues() });
    }
  `;
  if (violations(legacyHelperPayload).length === 0) {
    throw new Error(
      "validator self-test accepted a typed legacy helper payload",
    );
  }

  const immutableMutation = `
    import { chatThreads } from "@okouai/db/schema/chat-thread";
    db.update(chatThreads).set({ agentId: nextAgentId });
  `;
  if (violations(immutableMutation).length === 0) {
    throw new Error(
      "validator self-test accepted a canonical mutation of an immutable reference",
    );
  }

  const observedMutations = new Map();
  const mutableMutation = `
    import { telegramInstallations } from "@okouai/db/schema/telegram-installation";
    db.update(telegramInstallations).set({ defaultAgentId: nextAgentId });
  `;
  if (
    violations(mutableMutation, {
      observedCanonicalReferenceMutations: observedMutations,
    }).length > 0 ||
    observedMutations.get("telegramInstallations|update|defaultAgentId") !== 1
  ) {
    throw new Error(
      "validator self-test failed to inventory a mutable canonical update",
    );
  }

  observedMutations.clear();
  const mutableUpsert = `
    import { slackUserAgentPreferences } from "@okouai/db/schema/slack-user-agent-preference";
    db.insert(slackUserAgentPreferences)
      .values({ userId, orgId, selectedAgentId })
      .onConflictDoUpdate({
        target: [slackUserAgentPreferences.userId],
        set: { selectedAgentId },
      });
  `;
  if (
    violations(mutableUpsert, {
      observedCanonicalReferenceMutations: observedMutations,
    }).length > 0 ||
    observedMutations.get(
      "slackUserAgentPreferences|upsert|selectedAgentId",
    ) !== 1
  ) {
    throw new Error(
      "validator self-test failed to inventory a mutable canonical upsert",
    );
  }
}

function assertLegacyIdentityWriterSelfTests(violations, fixturePath) {
  const writerKey = `${fixturePath}|<module>|agentComposes|insert`;
  if (
    violations(`
      import { agentComposes } from "@okouai/db/schema/agent-compose";
      db.insert(agentComposes).values({ name: "writer" });
    `).length === 0
  ) {
    throw new Error(
      "validator self-test failed to reject an unenumerated legacy identity writer",
    );
  }
  if (
    violations(
      `
        import { agentComposes } from "@okouai/db/schema/agent-compose";
        withLegacyAgentPrivacyTeardownSavepoint(tx, async (legacyTx) => {
          await legacyTx.insert(agentComposes).values({ name: "writer" }).returning({ id: agentComposes.id });
        });
      `,
      { stage7Writers: new Set([writerKey]) },
    ).length > 0
  ) {
    throw new Error(
      "validator self-test rejected an enumerated PR 1 boundary writer",
    );
  }

  if (
    violations(
      `
        import { agentComposes } from "@okouai/db/schema/agent-compose";
        db.insert(agentComposes).values({ name: "writer" });
      `,
      { stage7Writers: new Set([writerKey]) },
    ).length === 0
  ) {
    throw new Error(
      "validator self-test accepted an unconditional enumerated legacy writer",
    );
  }

  if (
    violations(
      `
        import { agentComposes } from "@okouai/db/schema/agent-compose";
        withLegacyAgentPrivacyTeardownSavepoint(
          db.insert(agentComposes).values({ name: "writer" }),
          async () => {},
        );
      `,
      { stage7Writers: new Set([writerKey]) },
    ).length === 0
  ) {
    throw new Error(
      "validator self-test accepted a writer outside the boundary callback",
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
  assertLegacyIdentityWriterSelfTests(violations, fixturePath);
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
const observedIdentityWriterOccurrences = new Map();
const observedCanonicalReferenceMutations = new Map();
const observedBoundaryDefinitions = { count: 0 };
const violations = runtimeFiles.flatMap((filePath) => {
  return analyzeSource({
    file: relativePath(filePath),
    sourceText: fs.readFileSync(filePath, "utf8"),
    stage7Reads: allowedLegacyWriterReads,
    stage7IndirectReferenceWriters,
    stage7ReferenceWriters,
    stage7Writers: pr1IdentityWriters,
    observedWriterOccurrences: observedIdentityWriterOccurrences,
    observedCanonicalReferenceMutations,
    observedBoundaryDefinitions,
  });
});

violations.push(...referenceConstraintContractViolations());

for (const [key, expected] of pr1IdentityWriterExpectedOccurrences) {
  const observed = observedIdentityWriterOccurrences.get(key) ?? 0;
  if (observed !== expected) {
    violations.push({
      file: key.split("|")[0] ?? "<validator>",
      line: 1,
      column: 1,
      message: `bounded legacy writer occurrence count drifted: expected ${expected}, observed ${observed} for ${key}`,
    });
  }
}

if (observedBoundaryDefinitions.count !== 1) {
  violations.push({
    file: legacyPrivacyTeardownBoundary.file,
    line: 1,
    column: 1,
    message: `legacy privacy/teardown boundary definition count drifted: expected 1, observed ${observedBoundaryDefinitions.count}`,
  });
}

for (const [key, expected] of expectedCanonicalReferenceMutationOccurrences) {
  const observed = observedCanonicalReferenceMutations.get(key) ?? 0;
  if (observed !== expected) {
    violations.push({
      file: "<validator>",
      line: 1,
      column: 1,
      message: `canonical mutable reference occurrence count drifted: expected ${expected}, observed ${observed} for ${key}`,
    });
  }
}
for (const key of observedCanonicalReferenceMutations.keys()) {
  if (!expectedCanonicalReferenceMutationOccurrences.has(key)) {
    violations.push({
      file: "<validator>",
      line: 1,
      column: 1,
      message: `unexpected canonical mutable reference mutation: ${key}`,
    });
  }
}

const expectedLegacyIdentityOccurrenceCount = [
  ...pr1IdentityWriterExpectedOccurrences.values(),
].reduce((sum, count) => {
  return sum + count;
}, 0);
const expectedCanonicalReferenceMutationCount = [
  ...expectedCanonicalReferenceMutationOccurrences.values(),
].reduce((sum, count) => {
  return sum + count;
}, 0);

if (violations.length > 0) {
  process.stderr.write(
    "Canonical Agent runtime validation failed (Stage 8 PR 1 runtime seal):\n",
  );
  for (const violation of violations) {
    process.stderr.write(
      `  ${violation.file}:${violation.line}:${violation.column} ${violation.message}\n`,
    );
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Canonical Agent runtime validation passed across ${runtimeFiles.length} production source files (${expectedLegacyIdentityOccurrenceCount} exact schema-absence-safe legacy teardown/privacy occurrences in ${pr1IdentityWriters.size} writer keys, 1 temporary savepoint boundary, ${stage7ReferenceWriters.size} direct and ${stage7IndirectReferenceWriters.size} opaque legacy reference writer keys, ${stage7WriterGuardReads.size} legacy writer guards, ${legacyDependentWriterSupportReads.size} Run-version dependent-writer support reads, 0 schema/FK probes; ${expectedCanonicalReferenceMutationCount} canonical mutable reference mutations in ${expectedCanonicalReferenceMutationOccurrences.size} keys; 6 immutable equality, 2 mutable required-presence, and 4 mutable nullable reference contracts).\n`,
  );
}
