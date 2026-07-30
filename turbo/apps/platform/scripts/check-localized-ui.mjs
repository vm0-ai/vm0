import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");

function getCheckedFiles() {
  const excludedDirectories = new Set(["__tests__", "i18n", "mocks", "test"]);
  const checkedFiles = [];

  function collectFiles(relativeDirectory) {
    for (const entry of readdirSync(path.join(appRoot, relativeDirectory), {
      withFileTypes: true,
    })) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) {
          collectFiles(relativePath);
        }
        continue;
      }
      if (
        (relativePath.endsWith(".ts") || relativePath.endsWith(".tsx")) &&
        !relativePath.endsWith(".test.ts") &&
        !relativePath.endsWith(".test.tsx")
      ) {
        checkedFiles.push(relativePath);
      }
    }
  }

  collectFiles("src");
  return checkedFiles.sort();
}

function isUserVisibleAttribute(value) {
  return [
    "alt",
    "aria-description",
    "aria-label",
    "aria-placeholder",
    "description",
    "label",
    "placeholder",
    "title",
  ].includes(value);
}

function isUserVisibleProperty(value) {
  return [
    "actionLabel",
    "ariaLabel",
    "buttonLabel",
    "caption",
    "content",
    "description",
    "emptyLabel",
    "emptyMessage",
    "errorMessage",
    "heading",
    "help",
    "helperText",
    "hint",
    "label",
    "message",
    "name",
    "placeholder",
    "subtitle",
    "summary",
    "title",
    "tooltip",
    "tooltipLabel",
  ].includes(value);
}

function isToastMethod(value) {
  return ["error", "info", "success", "warning"].includes(value);
}

function isUserVisibleFunctionName(value) {
  return /(caption|copy|description|heading|help|hint|label|message|summary|title|tooltip)$/iu.test(
    value,
  );
}

// These literals are intentionally shown as protocol identifiers, provider or
// product names, or example input values. Keep exclusions exact and explain why
// each value must remain untranslated.
function getInternalAllowedLiterals() {
  return [
    [
      "src/signals/zero-page/chat-feedback.ts\u0000a sent email (mail ID: {…}{…})",
      "locale-neutral serialized agent prompt metadata",
    ],
    [
      "src/signals/zero-page/chat-feedback.ts\u0000an email draft (mail draft ID: {…})",
      "locale-neutral serialized agent prompt metadata",
    ],
    [
      "src/signals/chat-page/create-chat-thread.ts\u0000Run cancelled",
      "internal run event payload; the rendered cancellation message uses typed i18n",
    ],
    [
      "src/signals/zero-page/tiptap-workflow-composer.ts\u0000paragraph+",
      "Tiptap document schema expression",
    ],
    [
      "src/signals/zero-page/tiptap-workflow-composer.ts\u0000workflowHighlight",
      "Tiptap extension identifier",
    ],
    [
      "src/views/zero-page/tiptap-instructions-editor.tsx\u0000baselineMarkdown",
      "Tiptap storage plugin identifier",
    ],
    [
      "src/views/zero-page/tiptap-instructions-editor.tsx\u0000lowlightHighlight",
      "Tiptap extension identifier",
    ],
  ];
}

function getConnectorAllowedLiterals() {
  return [
    [
      "src/views/zero-page/components/model-provider-picker.tsx\u0000BYOK",
      "bring-your-own-key product acronym",
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
    [
      "src/views/zero-page/feishu-card.tsx\u0000im.message.receive_v1",
      "Feishu event identifier",
    ],
    [
      "src/views/zero-page/strapi-settings-page.tsx\u0000https://cms.example.com",
      "example Strapi URL",
    ],
  ];
}

function getFileAllowedLiterals() {
  return [
    [
      "src/views/zero-page/zero-file-preview-icon.tsx\u0000DB",
      "database file format abbreviation",
    ],
    [
      "src/views/zero-page/zero-file-preview-icon.tsx\u0000DOC",
      "document file format abbreviation",
    ],
    [
      "src/views/zero-page/zero-file-preview-icon.tsx\u0000HTML",
      "HTML file format abbreviation",
    ],
    [
      "src/views/zero-page/zero-file-preview-icon.tsx\u0000JSON",
      "JSON file format abbreviation",
    ],
    [
      "src/views/zero-page/zero-file-preview-icon.tsx\u0000MD",
      "Markdown file extension",
    ],
    [
      "src/views/zero-page/zero-file-preview-icon.tsx\u0000PDF",
      "PDF file format abbreviation",
    ],
    [
      "src/views/zero-page/zero-file-preview-icon.tsx\u0000PPT",
      "presentation file format abbreviation",
    ],
    [
      "src/views/zero-page/zero-file-preview-icon.tsx\u0000TXT",
      "plain-text file extension",
    ],
    [
      "src/views/zero-page/zero-file-preview-icon.tsx\u0000XLS",
      "spreadsheet file format abbreviation",
    ],
    [
      "src/views/zero-page/zero-file-preview-icon.tsx\u0000ZIP",
      "archive file format abbreviation",
    ],
  ];
}

function getAllowedLiterals() {
  return new Map([
    ...getInternalAllowedLiterals(),
    ...getConnectorAllowedLiterals(),
    ...getFileAllowedLiterals(),
  ]);
}

function getLiteralValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.flatMap((span) => {
        return ["{…}", span.literal.text];
      }),
    ].join("");
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
  const withoutEntities = value.replace(
    /&(?:[a-z][a-z0-9]+|#\d+|#x[0-9a-f]+);/giu,
    "",
  );
  return /\p{L}/u.test(withoutEntities);
}

function isTranslationCall(node) {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text === "t";
  }
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "t"
  );
}

function checkVisibleExpression(node, record, kind) {
  if (isTranslationCall(node)) {
    return;
  }
  const value = getLiteralValue(node);
  if (value !== null) {
    record(node, value, kind);
    return;
  }
  if (ts.isConditionalExpression(node)) {
    checkVisibleExpression(node.whenTrue, record, kind);
    checkVisibleExpression(node.whenFalse, record, kind);
    return;
  }
  if (ts.isBinaryExpression(node)) {
    if (
      node.operatorToken.kind === ts.SyntaxKind.PlusToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      checkVisibleExpression(node.left, record, kind);
      checkVisibleExpression(node.right, record, kind);
      return;
    }
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      checkVisibleExpression(node.right, record, kind);
    }
    return;
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    checkVisibleExpression(node.expression, record, kind);
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      checkVisibleExpression(element, record, kind);
    }
  }
}

function isStyleElement(node) {
  if (!ts.isJsxElement(node)) {
    return false;
  }
  const tagName = node.openingElement.tagName;
  return ts.isIdentifier(tagName) && tagName.text === "style";
}

function checkJsxText(node, record) {
  if (ts.isJsxText(node) && !isStyleElement(node.parent)) {
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
    checkVisibleExpression(node.initializer.expression, record, attributeName);
  }
}

function checkJsxExpression(node, record) {
  if (
    ts.isJsxExpression(node) &&
    node.expression &&
    (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) &&
    !isStyleElement(node.parent)
  ) {
    checkVisibleExpression(node.expression, record, "JSX expression");
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
  checkVisibleExpression(node.initializer, record, propertyName);
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
  checkVisibleExpression(node.arguments[1], record, "document title");
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
  checkVisibleExpression(node.arguments[0], record, "toast");
}

function checkBrowserDialogCall(node, record) {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) {
    return;
  }
  const expression = node.expression;
  const methodName = ts.isIdentifier(expression)
    ? expression.text
    : ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : null;
  if (!methodName || !["alert", "confirm", "prompt"].includes(methodName)) {
    return;
  }
  checkVisibleExpression(node.arguments[0], record, `browser ${methodName}`);
}

function functionLikeName(node) {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)) &&
    node.name &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) {
    return node.name.text;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (
      ts.isPropertyAssignment(parent) &&
      (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))
    ) {
      return parent.name.text;
    }
  }
  return null;
}

function checkUserVisibleFunctionReturn(node, record) {
  if (!ts.isReturnStatement(node) || !node.expression) {
    return;
  }
  let parent = node.parent;
  while (parent && !ts.isSourceFile(parent)) {
    if (ts.isFunctionLike(parent)) {
      const name = functionLikeName(parent);
      if (name && isUserVisibleFunctionName(name)) {
        checkVisibleExpression(node.expression, record, `${name} return`);
      }
      return;
    }
    parent = parent.parent;
  }
}

function checkSetAttributeCall(node, record) {
  if (
    !ts.isCallExpression(node) ||
    node.arguments.length < 2 ||
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "setAttribute"
  ) {
    return;
  }
  const attribute = getLiteralValue(node.arguments[0]);
  if (!attribute || !isUserVisibleAttribute(attribute)) {
    return;
  }
  checkVisibleExpression(
    node.arguments[1],
    record,
    `setAttribute(${attribute})`,
  );
}

function checkUserVisibleAssignment(node, record) {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(node.left)
  ) {
    return;
  }
  const propertyName = node.left.name.text;
  if (
    !["alt", "ariaLabel", "innerText", "placeholder", "title"].includes(
      propertyName,
    )
  ) {
    return;
  }
  checkVisibleExpression(node.right, record, `${propertyName} assignment`);
}

function checkFile(relativePath, allowedLiterals, usedAllowedLiterals) {
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
      usedAllowedLiterals.add(exclusionKey);
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
    checkBrowserDialogCall(node, record);
    checkUserVisibleFunctionReturn(node, record);
    checkSetAttributeCall(node, record);
    checkUserVisibleAssignment(node, record);
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function main() {
  const allowedLiterals = getAllowedLiterals();
  const usedAllowedLiterals = new Set();
  const checkedFiles = getCheckedFiles();
  const violations = checkedFiles.flatMap((relativePath) => {
    return checkFile(relativePath, allowedLiterals, usedAllowedLiterals).map(
      (violation) => {
        return { relativePath, ...violation };
      },
    );
  });
  const unusedAllowedLiterals = Array.from(allowedLiterals.entries()).filter(
    ([key]) => {
      return !usedAllowedLiterals.has(key);
    },
  );

  if (violations.length > 0 || unusedAllowedLiterals.length > 0) {
    process.stderr.write(`Platform localized UI lint failed.

Move these user-visible literals into the typed i18n resources. If a literal is
an intentional protocol identifier, provider/product name, or example value,
add a narrow file-and-value exclusion with a reason.

${
  violations.length > 0
    ? `Hardcoded UI copy:\n${violations
        .map((violation) => {
          return `  - ${violation.relativePath}:${violation.line}:${violation.column} (${violation.kind}) ${JSON.stringify(violation.value)}`;
        })
        .join("\n")}\n`
    : ""
}
${
  unusedAllowedLiterals.length > 0
    ? `Unused exclusions (remove stale entries):\n${unusedAllowedLiterals
        .map(([key, reason]) => {
          const [relativePath, value] = key.split("\u0000");
          return `  - ${relativePath} ${JSON.stringify(value)} (${reason})`;
        })
        .join("\n")}\n`
    : ""
}
`);
    process.exit(1);
  }
}

main();
