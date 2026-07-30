import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");

function getCheckedFiles() {
  return [
    "src/signals/connectors-page/connector-callback-page-setup.ts",
    "src/signals/external/org-model-policies.ts",
    "src/signals/zero-page/settings/connectors.ts",
    "src/signals/zero-page/strapi-settings-page.ts",
    "src/signals/zero-page/zero-strapi.ts",
    "src/views/zero-page/components/model-provider-picker.tsx",
    "src/views/zero-page/components/org-manage/org-model-policies-section.tsx",
    "src/views/zero-page/components/preferences/codex-reset-usage-dialog.tsx",
    "src/views/zero-page/components/settings/connector-catalog-diagnostics-block.tsx",
    "src/views/zero-page/components/settings/custom-connector-connect-dialog.tsx",
    "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx",
    "src/views/zero-page/components/settings/custom-connector-update-confirm.tsx",
    "src/views/zero-page/components/settings/custom-connectors-panel.tsx",
    "src/views/zero-page/components/settings/provider-ui-config.ts",
    "src/views/zero-page/feishu-card.tsx",
    "src/views/zero-page/strapi-settings-page.tsx",
    "src/views/zero-page/zero-chat-thread-page.tsx",
    "src/views/zero-page/zero-sidebar-account.tsx",
    "src/views/zero-page/zero-sidebar-subscriptions.tsx",
  ];
}

function isUserVisibleAttribute(value) {
  return [
    "alt",
    "aria-description",
    "aria-label",
    "description",
    "label",
    "placeholder",
    "title",
  ].includes(value);
}

function isUserVisibleProperty(value) {
  return [
    "ariaLabel",
    "description",
    "errorMessage",
    "label",
    "message",
    "placeholder",
    "title",
  ].includes(value);
}

function isToastMethod(value) {
  return ["error", "info", "success", "warning"].includes(value);
}

// These literals are intentionally shown as protocol identifiers, provider or
// product names, or example input values. Keep exclusions exact and explain why
// each value must remain untranslated.
function getAllowedLiterals() {
  return new Map([
    [
      "src/views/zero-page/components/model-provider-picker.tsx\u0000BYOK",
      "bring-your-own-key product acronym",
    ],
    [
      "src/views/zero-page/components/settings/provider-ui-config.ts\u0000Azure foundry portal",
      "provider product name",
    ],
    [
      "src/views/zero-page/components/settings/provider-ui-config.ts\u0000Claude Code (OAuth token)",
      "provider product name with OAuth credential type",
    ],
    [
      "src/views/zero-page/components/settings/provider-ui-config.ts\u0000Deepseek",
      "provider brand name",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-connect-dialog.tsx\u0000OAuth 2.0",
      "OAuth protocol name",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000Acme API",
      "example connector name",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000Authorization",
      "example HTTP header name",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000Bearer {{secret}}",
      "example HTTP authorization value",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000{{secret}}",
      "header-template interpolation token",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000API credential",
      "locale-neutral persisted field metadata",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000OAuth 2.0",
      "OAuth protocol name",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000PKCE",
      "OAuth protocol extension name",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000S256",
      "OAuth PKCE method identifier",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000Secret",
      "locale-neutral persisted field metadata",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000cli_...",
      "example provider application identifier",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000consent",
      "example OAuth prompt value",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000https://api.acme.com/v1/",
      "example API URL",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000https://api.provider.example",
      "example OAuth audience",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000https://api.provider.example/authorize",
      "example OAuth authorization URL",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000https://api.provider.example/token",
      "example OAuth token URL",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000https://provider.example.com/oauth/authorize",
      "example OAuth authorization URL",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000https://provider.example.com/oauth/token",
      "example OAuth token URL",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000offline",
      "example OAuth access type",
    ],
    [
      "src/views/zero-page/components/settings/custom-connector-create-dialog.tsx\u0000read\nwrite",
      "example OAuth scopes",
    ],
    [
      "src/views/zero-page/feishu-card.tsx\u0000cli_...",
      "example Feishu application identifier",
    ],
    ["src/views/zero-page/feishu-card.tsx\u0000Feishu", "provider name"],
    [
      "src/views/zero-page/feishu-card.tsx\u0000im.message.receive_v1",
      "Feishu event identifier",
    ],
    [
      "src/views/zero-page/strapi-settings-page.tsx\u0000https://cms.example.com",
      "example Strapi URL",
    ],
    [
      "src/views/zero-page/zero-chat-thread-page.tsx\u0000Feishu",
      "provider name",
    ],
    [
      "src/views/zero-page/zero-chat-thread-page.tsx\u0000Slack",
      "provider name",
    ],
  ]);
}

function getLiteralValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function getPropertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
    return node.text;
  }
  return null;
}

function hasHumanText(value) {
  return /\p{L}/u.test(value);
}

function checkJsxText(node, record) {
  if (ts.isJsxText(node)) {
    record(node, node.text, "JSX text");
  }
}

function checkJsxAttribute(node, record) {
  if (!ts.isJsxAttribute(node)) {
    return;
  }
  const attributeName = node.name.text;
  if (
    typeof attributeName !== "string" ||
    !isUserVisibleAttribute(attributeName) ||
    !node.initializer
  ) {
    return;
  }
  if (ts.isStringLiteral(node.initializer)) {
    record(node.initializer, node.initializer.text, attributeName);
    return;
  }
  if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
    const value = getLiteralValue(node.initializer.expression);
    if (value !== null) {
      record(node.initializer.expression, value, attributeName);
    }
  }
}

function checkJsxExpression(node, record) {
  if (
    ts.isJsxExpression(node) &&
    node.expression &&
    (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
  ) {
    const value = getLiteralValue(node.expression);
    if (value !== null) {
      record(node.expression, value, "JSX expression");
    }
  }
}

function checkPropertyAssignment(node, record) {
  if (!ts.isPropertyAssignment(node)) {
    return;
  }
  const propertyName = getPropertyName(node.name);
  if (!propertyName || !isUserVisibleProperty(propertyName)) {
    return;
  }
  const value = getLiteralValue(node.initializer);
  if (value !== null) {
    record(node.initializer, value, propertyName);
  }
}

function checkDocumentTitle(node, record) {
  if (
    !ts.isCallExpression(node) ||
    node.arguments.length < 2 ||
    !ts.isIdentifier(node.arguments[0]) ||
    node.arguments[0].text !== "updateDocumentTitle$"
  ) {
    return;
  }
  const value = getLiteralValue(node.arguments[1]);
  if (value !== null) {
    record(node.arguments[1], value, "document title");
  }
}

function checkToastCall(node, record) {
  if (
    !ts.isCallExpression(node) ||
    node.arguments.length === 0 ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== "toast" ||
    !isToastMethod(node.expression.name.text)
  ) {
    return;
  }
  const value = getLiteralValue(node.arguments[0]);
  if (value !== null) {
    record(node.arguments[0], value, "toast");
  }
}

function checkFile(relativePath, allowedLiterals) {
  const absolutePath = path.join(appRoot, relativePath);
  const sourceText = readFileSync(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations = [];

  function record(node, value, kind) {
    const normalizedValue = value.trim();
    if (!hasHumanText(normalizedValue)) {
      return;
    }
    const exclusionKey = `${relativePath}\u0000${normalizedValue}`;
    if (allowedLiterals.has(exclusionKey)) {
      return;
    }
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    violations.push({
      column: position.character + 1,
      kind,
      line: position.line + 1,
      value: normalizedValue,
    });
  }

  function visit(node) {
    checkJsxText(node, record);
    checkJsxAttribute(node, record);
    checkJsxExpression(node, record);
    checkPropertyAssignment(node, record);
    checkDocumentTitle(node, record);
    checkToastCall(node, record);
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function main() {
  const allowedLiterals = getAllowedLiterals();
  const checkedFiles = getCheckedFiles();
  const violations = checkedFiles.flatMap((relativePath) => {
    return checkFile(relativePath, allowedLiterals).map((violation) => {
      return { relativePath, ...violation };
    });
  });

  if (violations.length > 0) {
    process.stderr.write(`Platform localized UI lint failed.

Move these user-visible literals into the typed i18n resources. If a literal is
an intentional protocol identifier, provider/product name, or example value,
add a narrow file-and-value exclusion with a reason.

${violations
  .map((violation) => {
    return `  - ${violation.relativePath}:${violation.line}:${violation.column} (${violation.kind}) ${JSON.stringify(violation.value)}`;
  })
  .join("\n")}
`);
    process.exit(1);
  }
}

main();
