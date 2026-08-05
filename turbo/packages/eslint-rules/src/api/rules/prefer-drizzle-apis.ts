import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { parsePostgres } from "../sql-analysis/postgres-parser.ts";
import {
  directTypeAnnotation,
  drizzleCallName,
  importReference,
  isColumnExpression,
  isDatabaseExpression,
  isDrizzleExecuteCall,
  isDrizzleSqlTag,
  isSchemaTableExpression,
  isSqlWrapperExpression,
  localFunctionReturn,
  memberName,
  propertyName,
  resolveLocalExpression,
  unwrapExpression,
} from "../syntax.ts";
import { createRule } from "../utils.ts";

type SqlHelper =
  | "and"
  | "arrayContained"
  | "arrayContains"
  | "arrayOverlaps"
  | "asc"
  | "avg"
  | "avgDistinct"
  | "between"
  | "count"
  | "countDistinct"
  | "desc"
  | "eq"
  | "exists"
  | "gt"
  | "gte"
  | "ilike"
  | "inArray"
  | "isNotNull"
  | "isNull"
  | "like"
  | "lt"
  | "lte"
  | "max"
  | "min"
  | "ne"
  | "not"
  | "notBetween"
  | "notExists"
  | "notIlike"
  | "notInArray"
  | "notLike"
  | "or"
  | "sum"
  | "sumDistinct";

type AnalysisContext = "ordering" | "predicate" | "selection" | "statement";

type SqlNode = TSESTree.CallExpression | TSESTree.TaggedTemplateExpression;

interface HelperFinding {
  readonly helper: SqlHelper;
  readonly node: TSESTree.Node;
}

const BUILDER_ROOT_METHODS = new Set([
  "delete",
  "insert",
  "select",
  "selectDistinct",
  "selectDistinctOn",
  "update",
]);
const BUILDER_CHAIN_METHODS = new Set([
  "$dynamic",
  "as",
  "crossJoin",
  "crossJoinLateral",
  "except",
  "exceptAll",
  "for",
  "from",
  "fullJoin",
  "groupBy",
  "having",
  "innerJoin",
  "innerJoinLateral",
  "intersect",
  "intersectAll",
  "leftJoin",
  "leftJoinLateral",
  "limit",
  "offset",
  "onConflictDoNothing",
  "onConflictDoUpdate",
  "orderBy",
  "rightJoin",
  "rightJoinLateral",
  "set",
  "union",
  "unionAll",
  "values",
  "where",
]);
const PREDICATE_METHODS = new Set(["having", "where"]);
const ORDERING_METHODS = new Set(["orderBy"]);
const GROUPING_METHODS = new Set(["groupBy"]);
const JOIN_METHODS = new Set([
  "fullJoin",
  "innerJoin",
  "innerJoinLateral",
  "leftJoin",
  "leftJoinLateral",
  "rightJoin",
  "rightJoinLateral",
]);
const SELECTION_METHOD_ARGUMENT = new Map<string, number>([
  ["returning", 0],
  ["select", 0],
  ["selectDistinct", 0],
  ["selectDistinctOn", 1],
]);
const RELATIONAL_RESULT_METHODS = new Set(["findFirst", "findMany"]);

function staticText(
  node: TSESTree.TaggedTemplateExpression,
): readonly string[] {
  return node.quasi.quasis.map((quasi) => {
    return quasi.value.cooked ?? quasi.value.raw;
  });
}

function interpolationCodeStates(
  quasis: readonly string[],
): readonly boolean[] {
  type LexicalState =
    | "block-comment"
    | "dollar-quote"
    | "double-quote"
    | "line-comment"
    | "normal"
    | "single-quote";

  let blockDepth = 0;
  let dollarTag = "";
  let state: LexicalState = "normal";
  const results: boolean[] = [];

  for (const quasi of quasis.slice(0, -1)) {
    for (let index = 0; index < quasi.length; index += 1) {
      const current = quasi[index] ?? "";
      const next = quasi[index + 1] ?? "";
      if (state === "single-quote") {
        if (current === "'" && next === "'") {
          index += 1;
        } else if (current === "'") {
          state = "normal";
        }
        continue;
      }
      if (state === "double-quote") {
        if (current === '"' && next === '"') {
          index += 1;
        } else if (current === '"') {
          state = "normal";
        }
        continue;
      }
      if (state === "line-comment") {
        if (current === "\n" || current === "\r") {
          state = "normal";
        }
        continue;
      }
      if (state === "block-comment") {
        if (current === "/" && next === "*") {
          blockDepth += 1;
          index += 1;
        } else if (current === "*" && next === "/") {
          blockDepth -= 1;
          index += 1;
          if (blockDepth === 0) {
            state = "normal";
          }
        }
        continue;
      }
      if (state === "dollar-quote") {
        if (quasi.startsWith(dollarTag, index)) {
          index += dollarTag.length - 1;
          state = "normal";
        }
        continue;
      }

      if (current === "'") {
        state = "single-quote";
      } else if (current === '"') {
        state = "double-quote";
      } else if (current === "-" && next === "-") {
        state = "line-comment";
        index += 1;
      } else if (current === "/" && next === "*") {
        state = "block-comment";
        blockDepth = 1;
        index += 1;
      } else if (current === "$") {
        const match = /^(?:\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/u.exec(
          quasi.slice(index),
        );
        if (match?.[0] !== undefined) {
          dollarTag = match[0];
          state = "dollar-quote";
          index += dollarTag.length - 1;
        }
      }
    }
    results.push(state === "normal");
  }
  return results;
}

function builderRootedAtDatabase(
  sourceCode: Parameters<typeof isDatabaseExpression>[0],
  node: TSESTree.Expression,
  visited = new Set<TSESTree.Expression>(),
): boolean {
  const resolved = resolveLocalExpression(sourceCode, node);
  if (visited.has(resolved)) {
    return false;
  }
  visited.add(resolved);
  if (
    resolved.type !== AST_NODE_TYPES.CallExpression ||
    resolved.callee.type !== AST_NODE_TYPES.MemberExpression
  ) {
    return false;
  }
  const name = memberName(resolved.callee);
  if (name !== null && BUILDER_ROOT_METHODS.has(name)) {
    return isDatabaseExpression(sourceCode, resolved.callee.object);
  }
  return (
    name !== null &&
    BUILDER_CHAIN_METHODS.has(name) &&
    builderRootedAtDatabase(sourceCode, resolved.callee.object, visited)
  );
}

function isBuilderMethodCall(
  sourceCode: Parameters<typeof isDatabaseExpression>[0],
  node: TSESTree.CallExpression,
  names: ReadonlySet<string>,
): boolean {
  return (
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    names.has(memberName(node.callee) ?? "") &&
    builderRootedAtDatabase(sourceCode, node.callee.object)
  );
}

function resultMethodArgument(
  sourceCode: Parameters<typeof isDatabaseExpression>[0],
  node: TSESTree.CallExpression,
): TSESTree.CallExpressionArgument | null {
  if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
    return null;
  }
  const name = memberName(node.callee);
  const index = name === null ? undefined : SELECTION_METHOD_ARGUMENT.get(name);
  if (index === undefined) {
    return null;
  }
  const validReceiver =
    name === "returning"
      ? builderRootedAtDatabase(sourceCode, node.callee.object)
      : isDatabaseExpression(sourceCode, node.callee.object);
  return validReceiver ? (node.arguments[index] ?? null) : null;
}

function collectSqlNodes(
  sourceCode: Parameters<typeof resolveLocalExpression>[0],
  node: TSESTree.Node,
  results: SqlNode[],
  visited: Set<TSESTree.Node>,
): void {
  if (visited.has(node)) {
    return;
  }
  visited.add(node);
  if (node.type === AST_NODE_TYPES.Identifier) {
    const resolved = resolveLocalExpression(sourceCode, node);
    if (resolved !== node) {
      collectSqlNodes(sourceCode, resolved, results, visited);
    }
    return;
  }
  if (
    node.type === AST_NODE_TYPES.TSAsExpression ||
    node.type === AST_NODE_TYPES.TSNonNullExpression ||
    node.type === AST_NODE_TYPES.TSSatisfiesExpression ||
    node.type === AST_NODE_TYPES.TSTypeAssertion
  ) {
    collectSqlNodes(sourceCode, node.expression, results, visited);
    return;
  }
  if (node.type === AST_NODE_TYPES.TaggedTemplateExpression) {
    if (isDrizzleSqlTag(sourceCode, node.tag)) {
      results.push(node);
    }
    for (const expression of node.quasi.expressions) {
      collectSqlNodes(sourceCode, expression, results, visited);
    }
    return;
  }
  if (node.type === AST_NODE_TYPES.CallExpression) {
    if (drizzleCallName(sourceCode, node) === "join") {
      results.push(node);
    }
    if (node.callee.type === AST_NODE_TYPES.MemberExpression) {
      collectSqlNodes(sourceCode, node.callee.object, results, visited);
    }
    for (const argument of node.arguments) {
      collectSqlNodes(
        sourceCode,
        argument.type === AST_NODE_TYPES.SpreadElement
          ? argument.argument
          : argument,
        results,
        visited,
      );
    }
    return;
  }
  if (node.type === AST_NODE_TYPES.ObjectExpression) {
    for (const property of node.properties) {
      collectSqlNodes(
        sourceCode,
        property.type === AST_NODE_TYPES.SpreadElement
          ? property.argument
          : property.value,
        results,
        visited,
      );
    }
    return;
  }
  if (node.type === AST_NODE_TYPES.ArrayExpression) {
    for (const element of node.elements) {
      if (element !== null) {
        collectSqlNodes(
          sourceCode,
          element.type === AST_NODE_TYPES.SpreadElement
            ? element.argument
            : element,
          results,
          visited,
        );
      }
    }
    return;
  }
  if (node.type === AST_NODE_TYPES.ConditionalExpression) {
    collectSqlNodes(sourceCode, node.consequent, results, visited);
    collectSqlNodes(sourceCode, node.alternate, results, visited);
    return;
  }
  if (node.type === AST_NODE_TYPES.LogicalExpression) {
    collectSqlNodes(sourceCode, node.left, results, visited);
    collectSqlNodes(sourceCode, node.right, results, visited);
  }
}

function renderedTemplate(
  sourceCode: Parameters<typeof isColumnExpression>[0],
  node: TSESTree.TaggedTemplateExpression,
): string {
  const quasis = staticText(node);
  return node.quasi.expressions.reduce((source, expression, index) => {
    let marker: string;
    if (isColumnExpression(sourceCode, expression)) {
      marker = `"vm0_column_${index}"`;
    } else if (isSchemaTableExpression(sourceCode, expression)) {
      marker = `"vm0_table_${index}"`;
    } else if (isSqlWrapperExpression(sourceCode, expression)) {
      marker = "TRUE";
    } else {
      marker = `$${index + 1}`;
    }
    return `${source}${marker}${quasis[index + 1] ?? ""}`;
  }, quasis[0] ?? "");
}

function isValidPostgresFragment(
  sourceCode: Parameters<typeof isColumnExpression>[0],
  node: TSESTree.TaggedTemplateExpression,
): boolean {
  const rendered = renderedTemplate(sourceCode, node);
  return (
    parsePostgres(`SELECT ${rendered}`) !== null ||
    parsePostgres(`SELECT 1 WHERE ${rendered}`) !== null ||
    parsePostgres(`SELECT 1 ORDER BY ${rendered}`) !== null
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordChild(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | null {
  const child = value[key];
  return isRecord(child) ? child : null;
}

function selectStatement(
  statement: unknown,
): Readonly<Record<string, unknown>> | null {
  if (!isRecord(statement)) {
    return null;
  }
  const wrapped = recordChild(statement, "stmt");
  return wrapped === null ? null : recordChild(wrapped, "SelectStmt");
}

function nestedSelectStatements(
  value: unknown,
  results: Readonly<Record<string, unknown>>[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      nestedSelectStatements(item, results);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const nested = recordChild(value, "SelectStmt");
  if (nested !== null) {
    results.push(nested);
  }
  for (const child of Object.values(value)) {
    nestedSelectStatements(child, results);
  }
}

function stringNodeValue(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const string = recordChild(value, "String");
  return typeof string?.sval === "string" ? string.sval : null;
}

function supportedFromItem(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const range = recordChild(value, "RangeVar");
  if (range !== null) {
    return (
      typeof range.relname === "string" &&
      /^vm0_table_\d+$/u.test(range.relname)
    );
  }
  const join = recordChild(value, "JoinExpr");
  return (
    join !== null &&
    supportedFromItem(join.larg) &&
    supportedFromItem(join.rarg)
  );
}

function columnReferencesAreLocalMarkers(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every(columnReferencesAreLocalMarkers);
  }
  if (!isRecord(value)) {
    return true;
  }
  const column = recordChild(value, "ColumnRef");
  if (column !== null) {
    return (
      Array.isArray(column.fields) &&
      column.fields.some((field) => {
        const name = stringNodeValue(field);
        return name !== null && /^vm0_column_\d+$/u.test(name);
      })
    );
  }
  return Object.values(value).every(columnReferencesAreLocalMarkers);
}

function supportedSelectStatement(
  node: Readonly<Record<string, unknown>>,
  requireFrom: boolean,
): boolean {
  if (
    node.op !== "SETOP_NONE" ||
    node.withClause !== undefined ||
    node.intoClause !== undefined ||
    node.larg !== undefined ||
    node.rarg !== undefined ||
    (Array.isArray(node.lockingClause) && node.lockingClause.length > 0)
  ) {
    return false;
  }
  const from = node.fromClause;
  if (requireFrom && (!Array.isArray(from) || from.length === 0)) {
    return false;
  }
  return (
    (from === undefined ||
      (Array.isArray(from) && from.every(supportedFromItem))) &&
    columnReferencesAreLocalMarkers(node)
  );
}

function convertibleSelectQuery(
  sourceCode: Parameters<typeof isColumnExpression>[0],
  node: TSESTree.TaggedTemplateExpression,
): boolean {
  const parsed = parsePostgres(renderedTemplate(sourceCode, node));
  const root =
    parsed?.statements.length === 1
      ? selectStatement(parsed.statements[0])
      : null;
  if (root === null || !supportedSelectStatement(root, true)) {
    return false;
  }
  const nested: Readonly<Record<string, unknown>>[] = [];
  for (const value of Object.values(root)) {
    nestedSelectStatements(value, nested);
  }
  return nested.every((statement) => {
    return supportedSelectStatement(statement, true);
  });
}

function convertibleScalarQuery(
  sourceCode: Parameters<typeof isColumnExpression>[0],
  node: TSESTree.TaggedTemplateExpression,
): boolean {
  const parsed = parsePostgres(`SELECT ${renderedTemplate(sourceCode, node)}`);
  const root =
    parsed?.statements.length === 1
      ? selectStatement(parsed.statements[0])
      : null;
  if (root === null || !supportedSelectStatement(root, false)) {
    return false;
  }
  const nested: Readonly<Record<string, unknown>>[] = [];
  for (const value of Object.values(root)) {
    nestedSelectStatements(value, nested);
  }
  return (
    nested.length > 0 &&
    nested.every((statement) => {
      return supportedSelectStatement(statement, true);
    })
  );
}

function isSafeOperand(
  sourceCode: Parameters<typeof isColumnExpression>[0],
  node: TSESTree.Expression,
): boolean {
  const resolved = resolveLocalExpression(sourceCode, node);
  return (
    isColumnExpression(sourceCode, resolved) ||
    resolved.type === AST_NODE_TYPES.Literal ||
    resolved.type === AST_NODE_TYPES.TemplateLiteral ||
    (resolved.type !== AST_NODE_TYPES.ArrayExpression &&
      !isSqlWrapperExpression(sourceCode, resolved))
  );
}

function isArrayOperand(
  sourceCode: Parameters<typeof isColumnExpression>[0],
  node: TSESTree.Expression,
): boolean {
  const resolved = resolveLocalExpression(sourceCode, node);
  if (resolved.type === AST_NODE_TYPES.ArrayExpression) {
    return true;
  }
  let annotation = directTypeAnnotation(sourceCode, resolved);
  while (annotation?.type === AST_NODE_TYPES.TSTypeOperator) {
    annotation = annotation.typeAnnotation ?? null;
  }
  if (
    annotation?.type === AST_NODE_TYPES.TSArrayType ||
    annotation?.type === AST_NODE_TYPES.TSTupleType
  ) {
    return true;
  }
  if (
    annotation?.type !== AST_NODE_TYPES.TSTypeReference ||
    annotation.typeName.type !== AST_NODE_TYPES.Identifier
  ) {
    return false;
  }
  return (
    annotation.typeName.name === "Array" ||
    annotation.typeName.name === "ReadonlyArray"
  );
}

function comparisonHelper(operator: string): SqlHelper | null {
  switch (operator.toUpperCase().replaceAll(/\s+/g, " ").trim()) {
    case "=":
      return "eq";
    case "!=":
    case "<>":
      return "ne";
    case ">":
      return "gt";
    case ">=":
      return "gte";
    case "<":
      return "lt";
    case "<=":
      return "lte";
    case "LIKE":
      return "like";
    case "NOT LIKE":
      return "notLike";
    case "ILIKE":
      return "ilike";
    case "NOT ILIKE":
      return "notIlike";
    case "@>":
      return "arrayContains";
    case "<@":
      return "arrayContained";
    case "&&":
      return "arrayOverlaps";
    default:
      return null;
  }
}

function exactBinaryFindings(
  sourceCode: Parameters<typeof isColumnExpression>[0],
  node: TSESTree.TaggedTemplateExpression,
): readonly HelperFinding[] {
  const expressions = node.quasi.expressions;
  const quasis = staticText(node);
  const codeStates = interpolationCodeStates(quasis);
  const findings: HelperFinding[] = [];
  for (let index = 0; index + 1 < expressions.length; index += 1) {
    const left = expressions[index];
    const right = expressions[index + 1];
    const operator = quasis[index + 1]?.trim() ?? "";
    const helper = comparisonHelper(operator);
    if (
      codeStates[index] === true &&
      codeStates[index + 1] === true &&
      helper !== null &&
      isColumnExpression(sourceCode, left) &&
      (helper === "arrayContained" ||
      helper === "arrayContains" ||
      helper === "arrayOverlaps"
        ? isArrayOperand(sourceCode, right) ||
          isSqlWrapperExpression(sourceCode, right)
        : isSafeOperand(sourceCode, right))
    ) {
      findings.push({ helper, node });
      continue;
    }
    if (
      codeStates[index] === true &&
      codeStates[index + 1] === true &&
      (operator.toUpperCase() === "AND" || operator.toUpperCase() === "OR") &&
      isSqlWrapperExpression(sourceCode, left) &&
      isSqlWrapperExpression(sourceCode, right)
    ) {
      findings.push({
        helper: operator.toUpperCase() === "AND" ? "and" : "or",
        node,
      });
    }
  }
  return findings;
}

function unaryFinding(
  sourceCode: Parameters<typeof isColumnExpression>[0],
  node: TSESTree.TaggedTemplateExpression,
): HelperFinding | null {
  const expressions = node.quasi.expressions;
  const quasis = staticText(node);
  if (
    expressions.length === 0 &&
    /^\s*COUNT\s*\(\s*\*\s*\)\s*$/iu.test(quasis.join(""))
  ) {
    return { helper: "count", node };
  }
  if (expressions.length !== 1) {
    return null;
  }
  if (interpolationCodeStates(quasis)[0] !== true) {
    return null;
  }
  const expression = expressions[0];
  const prefix = quasis[0]?.trim().toUpperCase() ?? "";
  const suffix = quasis[1]?.trim().toUpperCase() ?? "";
  if (isColumnExpression(sourceCode, expression)) {
    if (prefix === "" && suffix === "IS NULL") {
      return { helper: "isNull", node };
    }
    if (prefix === "" && suffix === "IS NOT NULL") {
      return { helper: "isNotNull", node };
    }
    if (prefix === "" && suffix === "ASC") {
      return { helper: "asc", node };
    }
    if (prefix === "" && suffix === "DESC") {
      return { helper: "desc", node };
    }
  }
  if (
    prefix === "NOT" &&
    suffix === "" &&
    isSqlWrapperExpression(sourceCode, expression)
  ) {
    return { helper: "not", node };
  }
  if (
    (prefix === "EXISTS (" || prefix === "NOT EXISTS (") &&
    suffix === ")" &&
    builderRootedAtDatabase(sourceCode, expression)
  ) {
    return { helper: prefix === "EXISTS (" ? "exists" : "notExists", node };
  }
  const aggregate = /^(AVG|COUNT|MAX|MIN|SUM)\(\s*(DISTINCT\s*)?$/u.exec(
    prefix,
  );
  if (
    aggregate !== null &&
    suffix === ")" &&
    isColumnExpression(sourceCode, expression)
  ) {
    const name = aggregate[1]?.toLowerCase();
    const distinct = aggregate[2] !== undefined;
    const helper =
      name === "avg"
        ? distinct
          ? "avgDistinct"
          : "avg"
        : name === "count"
          ? distinct
            ? "countDistinct"
            : "count"
          : name === "sum"
            ? distinct
              ? "sumDistinct"
              : "sum"
            : name === "max"
              ? "max"
              : "min";
    return { helper, node };
  }
  return null;
}

function collectionFinding(
  sourceCode: Parameters<typeof isColumnExpression>[0],
  node: TSESTree.TaggedTemplateExpression,
): HelperFinding | null {
  const expressions = node.quasi.expressions;
  const quasis = staticText(node);
  const codeStates = interpolationCodeStates(quasis);
  if (expressions.length === 2) {
    const middle = quasis[1]?.trim().toUpperCase() ?? "";
    const suffix = quasis[2]?.trim() ?? "";
    if (
      codeStates[0] === true &&
      codeStates[1] === true &&
      isColumnExpression(sourceCode, expressions[0]) &&
      isArrayOperand(sourceCode, expressions[1]) &&
      suffix === ")"
    ) {
      if (middle === "IN (") {
        return { helper: "inArray", node };
      }
      if (middle === "NOT IN (") {
        return { helper: "notInArray", node };
      }
    }
  }
  if (expressions.length !== 3) {
    return null;
  }
  const first = quasis[1]?.trim().toUpperCase() ?? "";
  const second = quasis[2]?.trim().toUpperCase() ?? "";
  if (
    codeStates.every((state) => state) &&
    isColumnExpression(sourceCode, expressions[0]) &&
    isSafeOperand(sourceCode, expressions[1]) &&
    isSafeOperand(sourceCode, expressions[2]) &&
    second === "AND"
  ) {
    if (first === "BETWEEN") {
      return { helper: "between", node };
    }
    if (first === "NOT BETWEEN") {
      return { helper: "notBetween", node };
    }
  }
  return null;
}

function templateFindings(
  sourceCode: Parameters<typeof isColumnExpression>[0],
  node: TSESTree.TaggedTemplateExpression,
): readonly HelperFinding[] {
  const text = staticText(node).join(" ");
  if (
    !/(?:<>|!=|>=|<=|@>|<@|&&|=|>|<|\b(?:AND|ASC|AVG|BETWEEN|COUNT|DESC|EXISTS|ILIKE|IN|IS|LIKE|MAX|MIN|NOT|NULL|OR|SUM)\b)/iu.test(
      text,
    )
  ) {
    return [];
  }
  if (!isValidPostgresFragment(sourceCode, node)) {
    return [];
  }
  const findings = [...exactBinaryFindings(sourceCode, node)];
  const unary = unaryFinding(sourceCode, node);
  if (unary !== null) {
    findings.push(unary);
  }
  const collection = collectionFinding(sourceCode, node);
  if (collection !== null) {
    findings.push(collection);
  }
  return findings;
}

function joinFinding(
  sourceCode: Parameters<typeof drizzleCallName>[0],
  node: TSESTree.CallExpression,
): HelperFinding | null {
  if (drizzleCallName(sourceCode, node) !== "join") {
    return null;
  }
  const values = node.arguments[0];
  const separator = node.arguments[1];
  if (
    values === undefined ||
    values.type === AST_NODE_TYPES.SpreadElement ||
    separator === undefined ||
    separator.type === AST_NODE_TYPES.SpreadElement
  ) {
    return null;
  }
  const resolvedValues = resolveLocalExpression(sourceCode, values);
  const resolvedSeparator = resolveLocalExpression(sourceCode, separator);
  if (
    resolvedValues.type !== AST_NODE_TYPES.ArrayExpression ||
    resolvedValues.elements.length === 0 ||
    resolvedValues.elements.some((element) => {
      return (
        element === null ||
        element.type === AST_NODE_TYPES.SpreadElement ||
        !isSqlWrapperExpression(sourceCode, element)
      );
    }) ||
    resolvedSeparator.type !== AST_NODE_TYPES.TaggedTemplateExpression ||
    !isDrizzleSqlTag(sourceCode, resolvedSeparator.tag) ||
    resolvedSeparator.quasi.expressions.length !== 0
  ) {
    return null;
  }
  const separatorText = staticText(resolvedSeparator)
    .join("")
    .trim()
    .toUpperCase();
  return separatorText === "AND" || separatorText === "OR"
    ? { helper: separatorText === "AND" ? "and" : "or", node }
    : null;
}

function directColumnTag(
  sourceCode: Parameters<typeof isColumnExpression>[0],
  node: TSESTree.Expression,
): TSESTree.TaggedTemplateExpression | null {
  const resolved = resolveLocalExpression(sourceCode, node);
  if (
    resolved.type === AST_NODE_TYPES.CallExpression &&
    resolved.callee.type === AST_NODE_TYPES.MemberExpression &&
    memberName(resolved.callee) === "as"
  ) {
    return null;
  }
  if (
    resolved.type !== AST_NODE_TYPES.CallExpression ||
    resolved.callee.type !== AST_NODE_TYPES.MemberExpression ||
    memberName(resolved.callee) !== "mapWith"
  ) {
    return null;
  }
  const decoder = resolved.arguments[0];
  const receiver = resolveLocalExpression(sourceCode, resolved.callee.object);
  if (
    decoder === undefined ||
    decoder.type === AST_NODE_TYPES.SpreadElement ||
    receiver.type !== AST_NODE_TYPES.TaggedTemplateExpression ||
    !isDrizzleSqlTag(sourceCode, receiver.tag) ||
    receiver.quasi.expressions.length !== 1 ||
    interpolationCodeStates(staticText(receiver))[0] !== true ||
    staticText(receiver).some((text) => text.trim() !== "")
  ) {
    return null;
  }
  const column = receiver.quasi.expressions[0];
  return isColumnExpression(sourceCode, column) &&
    isColumnExpression(sourceCode, decoder) &&
    contextText(sourceCode, column) === contextText(sourceCode, decoder)
    ? receiver
    : null;
}

function contextText(
  sourceCode: Parameters<typeof isColumnExpression>[0],
  node: TSESTree.Node,
): string {
  return sourceCode.getText(unwrapExpression(node as TSESTree.Expression));
}

function selectedExpressions(
  sourceCode: Parameters<typeof resolveLocalExpression>[0],
  node: TSESTree.Node,
  results: TSESTree.Expression[],
  visited: Set<TSESTree.Node>,
): void {
  if (visited.has(node)) {
    return;
  }
  visited.add(node);
  if (node.type === AST_NODE_TYPES.Identifier) {
    const resolved = resolveLocalExpression(sourceCode, node);
    if (resolved !== node) {
      selectedExpressions(sourceCode, resolved, results, visited);
    }
    return;
  }
  if (
    node.type === AST_NODE_TYPES.TSAsExpression ||
    node.type === AST_NODE_TYPES.TSNonNullExpression ||
    node.type === AST_NODE_TYPES.TSSatisfiesExpression ||
    node.type === AST_NODE_TYPES.TSTypeAssertion
  ) {
    selectedExpressions(sourceCode, node.expression, results, visited);
    return;
  }
  if (node.type === AST_NODE_TYPES.ObjectExpression) {
    for (const property of node.properties) {
      selectedExpressions(
        sourceCode,
        property.type === AST_NODE_TYPES.SpreadElement
          ? property.argument
          : property.value,
        results,
        visited,
      );
    }
    return;
  }
  if (node.type === AST_NODE_TYPES.ConditionalExpression) {
    selectedExpressions(sourceCode, node.consequent, results, visited);
    selectedExpressions(sourceCode, node.alternate, results, visited);
    return;
  }
  if (node.type === AST_NODE_TYPES.LogicalExpression) {
    selectedExpressions(sourceCode, node.left, results, visited);
    selectedExpressions(sourceCode, node.right, results, visited);
    return;
  }
  if (node.type === AST_NODE_TYPES.CallExpression) {
    const returned = localFunctionReturn(sourceCode, node);
    if (returned !== null) {
      selectedExpressions(sourceCode, returned, results, visited);
      return;
    }
  }
  if (
    node.type === AST_NODE_TYPES.CallExpression ||
    node.type === AST_NODE_TYPES.MemberExpression ||
    node.type === AST_NODE_TYPES.TaggedTemplateExpression
  ) {
    results.push(node);
  }
}

function isDbRawRowsSource(source: string): boolean {
  return /(?:^|\/)db-raw-rows(?:\.[cm]?[jt]s)?$/u.test(source);
}

function isExecuteRawRowsReference(
  sourceCode: Parameters<typeof importReference>[0],
  node: TSESTree.Expression,
): boolean {
  const resolved = resolveLocalExpression(sourceCode, node);
  if (resolved.type === AST_NODE_TYPES.Identifier) {
    const imported = importReference(sourceCode, resolved);
    return (
      imported !== null &&
      !imported.isTypeOnly &&
      imported.importedName === "executeRawRows" &&
      isDbRawRowsSource(imported.source)
    );
  }
  if (resolved.type !== AST_NODE_TYPES.MemberExpression) {
    return false;
  }
  const object = resolveLocalExpression(sourceCode, resolved.object);
  if (object.type !== AST_NODE_TYPES.Identifier) {
    return false;
  }
  const imported = importReference(sourceCode, object);
  return (
    memberName(resolved) === "executeRawRows" &&
    imported?.importedName === "*" &&
    isDbRawRowsSource(imported.source)
  );
}

function rawRowsQueryArgument(
  sourceCode: Parameters<typeof importReference>[0],
  node: TSESTree.CallExpression,
): TSESTree.Expression | null {
  if (!isExecuteRawRowsReference(sourceCode, node.callee)) {
    return null;
  }
  const database = node.arguments[0];
  const query = node.arguments[1];
  return database !== undefined &&
    database.type !== AST_NODE_TYPES.SpreadElement &&
    isDatabaseExpression(sourceCode, database) &&
    query !== undefined &&
    query.type !== AST_NODE_TYPES.SpreadElement
    ? query
    : null;
}

function relationalConfigArgument(
  sourceCode: Parameters<typeof isDatabaseExpression>[0],
  node: TSESTree.CallExpression,
): TSESTree.Expression | null {
  if (
    node.callee.type !== AST_NODE_TYPES.MemberExpression ||
    !RELATIONAL_RESULT_METHODS.has(memberName(node.callee) ?? "")
  ) {
    return null;
  }
  const table = resolveLocalExpression(sourceCode, node.callee.object);
  if (table.type !== AST_NODE_TYPES.MemberExpression) {
    return null;
  }
  const query = resolveLocalExpression(sourceCode, table.object);
  if (
    query.type !== AST_NODE_TYPES.MemberExpression ||
    memberName(query) !== "query" ||
    !isDatabaseExpression(sourceCode, query.object)
  ) {
    return null;
  }
  const config = node.arguments[0];
  return config !== undefined && config.type !== AST_NODE_TYPES.SpreadElement
    ? config
    : null;
}

function rootSqlTemplates(
  sourceCode: Parameters<typeof resolveLocalExpression>[0],
  node: TSESTree.Expression,
  results: TSESTree.TaggedTemplateExpression[],
  visited: Set<TSESTree.Expression>,
): void {
  const resolved = resolveLocalExpression(sourceCode, node);
  if (visited.has(resolved)) {
    return;
  }
  visited.add(resolved);
  if (resolved.type === AST_NODE_TYPES.TaggedTemplateExpression) {
    if (isDrizzleSqlTag(sourceCode, resolved.tag)) {
      results.push(resolved);
    }
    return;
  }
  if (resolved.type === AST_NODE_TYPES.ConditionalExpression) {
    rootSqlTemplates(sourceCode, resolved.consequent, results, visited);
    rootSqlTemplates(sourceCode, resolved.alternate, results, visited);
    return;
  }
  if (resolved.type === AST_NODE_TYPES.LogicalExpression) {
    rootSqlTemplates(sourceCode, resolved.left, results, visited);
    rootSqlTemplates(sourceCode, resolved.right, results, visited);
    return;
  }
  if (resolved.type === AST_NODE_TYPES.CallExpression) {
    const returned = localFunctionReturn(sourceCode, resolved);
    if (returned !== null) {
      rootSqlTemplates(sourceCode, returned, results, visited);
    }
  }
}

function rootBuilderCall(
  sourceCode: Parameters<typeof isDatabaseExpression>[0],
  node: TSESTree.Expression,
  visited = new Set<TSESTree.Expression>(),
): TSESTree.CallExpression | null {
  const resolved = resolveLocalExpression(sourceCode, node);
  if (
    visited.has(resolved) ||
    resolved.type !== AST_NODE_TYPES.CallExpression ||
    resolved.callee.type !== AST_NODE_TYPES.MemberExpression
  ) {
    return null;
  }
  visited.add(resolved);
  const name = memberName(resolved.callee);
  if (
    name !== null &&
    BUILDER_ROOT_METHODS.has(name) &&
    isDatabaseExpression(sourceCode, resolved.callee.object)
  ) {
    return resolved;
  }
  return name !== null && BUILDER_CHAIN_METHODS.has(name)
    ? rootBuilderCall(sourceCode, resolved.callee.object, visited)
    : null;
}

function baseSqlTag(
  sourceCode: Parameters<typeof resolveLocalExpression>[0],
  node: TSESTree.Expression,
): TSESTree.TaggedTemplateExpression | null {
  let resolved = resolveLocalExpression(sourceCode, node);
  while (
    resolved.type === AST_NODE_TYPES.CallExpression &&
    resolved.callee.type === AST_NODE_TYPES.MemberExpression &&
    (memberName(resolved.callee) === "as" ||
      memberName(resolved.callee) === "mapWith")
  ) {
    resolved = resolveLocalExpression(sourceCode, resolved.callee.object);
  }
  return resolved.type === AST_NODE_TYPES.TaggedTemplateExpression &&
    isDrizzleSqlTag(sourceCode, resolved.tag)
    ? resolved
    : null;
}

function templateIdentity(
  sourceCode: Parameters<typeof resolveLocalExpression>[0],
  node: TSESTree.TaggedTemplateExpression,
): string {
  const quasis = staticText(node);
  return node.quasi.expressions.reduce((source, expression, index) => {
    const resolved = resolveLocalExpression(sourceCode, expression);
    return `${source}\u0000${sourceCode.getText(resolved)}\u0000${quasis[index + 1] ?? ""}`;
  }, quasis[0] ?? "");
}

function unstableGrouping(
  sourceCode: Parameters<typeof resolveLocalExpression>[0],
  node: TSESTree.CallExpression,
): boolean {
  if (
    node.callee.type !== AST_NODE_TYPES.MemberExpression ||
    !isBuilderMethodCall(sourceCode, node, GROUPING_METHODS)
  ) {
    return false;
  }
  const root = rootBuilderCall(sourceCode, node.callee.object);
  const rootName =
    root?.callee.type === AST_NODE_TYPES.MemberExpression
      ? memberName(root.callee)
      : null;
  const selectionIndex = rootName === "selectDistinctOn" ? 1 : 0;
  const selection = root?.arguments[selectionIndex];
  if (
    selection === undefined ||
    selection.type === AST_NODE_TYPES.SpreadElement
  ) {
    return false;
  }
  const selected: TSESTree.Expression[] = [];
  selectedExpressions(sourceCode, selection, selected, new Set());
  const selectedBaseTags = new Set<TSESTree.TaggedTemplateExpression>();
  const selectedTemplates = new Set<string>();
  for (const expression of selected) {
    const tag = baseSqlTag(sourceCode, expression);
    if (tag !== null) {
      selectedBaseTags.add(tag);
      selectedTemplates.add(templateIdentity(sourceCode, tag).trim());
    }
  }
  return node.arguments.some((argument) => {
    if (argument.type === AST_NODE_TYPES.SpreadElement) {
      return false;
    }
    const tag = baseSqlTag(sourceCode, argument);
    if (tag === null) {
      return false;
    }
    const text = renderedTemplate(sourceCode, tag).trim();
    return (
      (tag.quasi.expressions.length === 0 && /^\d+$/u.test(text)) ||
      (!selectedBaseTags.has(tag) &&
        selectedTemplates.has(templateIdentity(sourceCode, tag).trim()))
    );
  });
}

export const preferDrizzleApis = createRule({
  name: "prefer-drizzle-apis",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Prefer schema-aware Drizzle APIs for syntax-proven equivalent SQL in conventional code",
      recommended: true,
    },
    schema: [],
    messages: {
      crossJoin:
        "Use Drizzle crossJoin(...) for this equivalent inner join on true.",
      crossJoinLateral:
        "Use Drizzle crossJoinLateral(...) for this equivalent lateral join.",
      directColumn:
        "Select the Drizzle column directly instead of using an identity SQL wrapper.",
      emptyFragment:
        "Use Drizzle sql.empty() for this intentionally empty SQL fragment.",
      queryBuilder:
        "Use Drizzle's query builder for this syntax-proven structured SELECT.",
      structuredScalarQuery:
        "Use a Drizzle query builder for this syntax-proven scalar SELECT.",
      transactionConfig:
        "Use Drizzle transaction configuration APIs for this equivalent SET TRANSACTION statement.",
      typedApi: "Use Drizzle {{helper}}(...) for this equivalent SQL-tag leaf.",
      unstableGrouping:
        "Group by the selected Drizzle expression instead of repeating SQL text or using a positional ordinal.",
    },
  },
  create(context) {
    const reported = new Set<string>();

    function reportHelper(finding: HelperFinding): void {
      const key = `${finding.helper}:${finding.node.range[0]}:${finding.node.range[1]}`;
      if (reported.has(key)) {
        return;
      }
      reported.add(key);
      context.report({
        node: finding.node,
        messageId: "typedApi",
        data: { helper: finding.helper },
      });
    }

    function analyzeExpression(
      node: TSESTree.Node,
      analysisContext: AnalysisContext,
    ): void {
      const sqlNodes: SqlNode[] = [];
      collectSqlNodes(
        context.sourceCode,
        node,
        sqlNodes,
        new Set<TSESTree.Node>(),
      );
      for (const sqlNode of sqlNodes) {
        if (sqlNode.type === AST_NODE_TYPES.CallExpression) {
          const finding = joinFinding(context.sourceCode, sqlNode);
          if (finding !== null) {
            reportHelper(finding);
          }
          continue;
        }
        const quasis = staticText(sqlNode);
        if (
          analysisContext !== "statement" &&
          convertibleScalarQuery(context.sourceCode, sqlNode)
        ) {
          const key = `scalar:${sqlNode.range[0]}:${sqlNode.range[1]}`;
          if (!reported.has(key)) {
            reported.add(key);
            context.report({
              node: sqlNode,
              messageId: "structuredScalarQuery",
            });
          }
          continue;
        }
        if (
          sqlNode.quasi.expressions.length === 0 &&
          quasis.every((text) => text === "")
        ) {
          const key = `empty:${sqlNode.range[0]}:${sqlNode.range[1]}`;
          if (!reported.has(key)) {
            reported.add(key);
            context.report({ node: sqlNode, messageId: "emptyFragment" });
          }
          continue;
        }
        for (const finding of templateFindings(context.sourceCode, sqlNode)) {
          if (
            (finding.helper === "asc" || finding.helper === "desc") &&
            analysisContext !== "ordering"
          ) {
            continue;
          }
          reportHelper(finding);
        }
      }
    }

    function inspectSelection(node: TSESTree.Node): void {
      const expressions: TSESTree.Expression[] = [];
      selectedExpressions(
        context.sourceCode,
        node,
        expressions,
        new Set<TSESTree.Node>(),
      );
      for (const expression of expressions) {
        const directColumn = directColumnTag(context.sourceCode, expression);
        if (directColumn !== null) {
          const key = `column:${directColumn.range[0]}:${directColumn.range[1]}`;
          if (!reported.has(key)) {
            reported.add(key);
            context.report({ node: directColumn, messageId: "directColumn" });
          }
        }
      }
      analyzeExpression(node, "selection");
    }

    function callbackResult(node: TSESTree.Node): TSESTree.Node | null {
      if (
        node.type !== AST_NODE_TYPES.ArrowFunctionExpression &&
        node.type !== AST_NODE_TYPES.FunctionExpression
      ) {
        return node;
      }
      if (node.body.type !== AST_NODE_TYPES.BlockStatement) {
        return node.body;
      }
      const statement = node.body.body.at(-1);
      return statement?.type === AST_NODE_TYPES.ReturnStatement
        ? statement.argument
        : null;
    }

    function inspectRelationalConfig(
      node: TSESTree.Expression,
      visited: Set<TSESTree.Node>,
    ): void {
      const config = resolveLocalExpression(context.sourceCode, node);
      if (
        config.type !== AST_NODE_TYPES.ObjectExpression ||
        visited.has(config)
      ) {
        return;
      }
      visited.add(config);
      for (const property of config.properties) {
        if (property.type === AST_NODE_TYPES.SpreadElement) {
          continue;
        }
        const name = propertyName(property);
        const value = callbackResult(property.value);
        if (value === null) {
          continue;
        }
        if (name === "where") {
          analyzeExpression(value, "predicate");
          continue;
        }
        if (name === "orderBy") {
          analyzeExpression(value, "ordering");
          continue;
        }
        if (name === "extras") {
          inspectSelection(value);
          continue;
        }
        if (name !== "with") {
          continue;
        }
        const relations =
          property.value.type === AST_NODE_TYPES.Identifier
            ? resolveLocalExpression(context.sourceCode, property.value)
            : property.value;
        if (relations.type !== AST_NODE_TYPES.ObjectExpression) {
          continue;
        }
        for (const relation of relations.properties) {
          if (
            relation.type !== AST_NODE_TYPES.SpreadElement &&
            (relation.value.type === AST_NODE_TYPES.Identifier ||
              relation.value.type === AST_NODE_TYPES.ObjectExpression)
          ) {
            inspectRelationalConfig(relation.value, visited);
          }
        }
      }
    }

    function checkJoin(node: TSESTree.CallExpression): void {
      if (
        node.callee.type !== AST_NODE_TYPES.MemberExpression ||
        !isBuilderMethodCall(context.sourceCode, node, JOIN_METHODS)
      ) {
        return;
      }
      const name = memberName(node.callee);
      const predicate = node.arguments[1];
      if (
        predicate === undefined ||
        predicate.type === AST_NODE_TYPES.SpreadElement
      ) {
        return;
      }
      const resolved = resolveLocalExpression(context.sourceCode, predicate);
      if (
        resolved.type === AST_NODE_TYPES.TaggedTemplateExpression &&
        isDrizzleSqlTag(context.sourceCode, resolved.tag) &&
        resolved.quasi.expressions.length === 0 &&
        staticText(resolved).join("").trim().toLowerCase() === "true" &&
        (name === "innerJoin" || name === "innerJoinLateral")
      ) {
        context.report({
          node,
          messageId:
            name === "innerJoinLateral" ? "crossJoinLateral" : "crossJoin",
        });
        return;
      }
      analyzeExpression(predicate, "predicate");
    }

    function checkTransactionConfig(node: TSESTree.CallExpression): void {
      if (!isDrizzleExecuteCall(context.sourceCode, node)) {
        return;
      }
      const argument = node.arguments[0];
      if (
        argument === undefined ||
        argument.type === AST_NODE_TYPES.SpreadElement
      ) {
        return;
      }
      const resolved = resolveLocalExpression(context.sourceCode, argument);
      if (
        resolved.type === AST_NODE_TYPES.TaggedTemplateExpression &&
        isDrizzleSqlTag(context.sourceCode, resolved.tag) &&
        resolved.quasi.expressions.length === 0 &&
        /^\s*SET\s+TRANSACTION\s+(?:(?:ISOLATION\s+LEVEL\s+(?:READ\s+(?:COMMITTED|UNCOMMITTED)|REPEATABLE\s+READ|SERIALIZABLE)|READ\s+(?:ONLY|WRITE)|NOT\s+DEFERRABLE|DEFERRABLE)(?:\s*,\s*|\s*;?\s*$))+$/iu.test(
          staticText(resolved).join(""),
        )
      ) {
        context.report({ node: resolved, messageId: "transactionConfig" });
        return;
      }
      analyzeExpression(argument, "statement");
    }

    function checkRawSelect(node: TSESTree.CallExpression): void {
      const query = rawRowsQueryArgument(context.sourceCode, node);
      if (query === null) {
        return;
      }
      const templates: TSESTree.TaggedTemplateExpression[] = [];
      rootSqlTemplates(context.sourceCode, query, templates, new Set());
      for (const template of templates) {
        if (!convertibleSelectQuery(context.sourceCode, template)) {
          continue;
        }
        const key = `query:${template.range[0]}:${template.range[1]}`;
        if (!reported.has(key)) {
          reported.add(key);
          context.report({ node: template, messageId: "queryBuilder" });
        }
      }
    }

    return {
      CallExpression(node: TSESTree.CallExpression): void {
        const selection = resultMethodArgument(context.sourceCode, node);
        if (
          selection !== null &&
          selection.type !== AST_NODE_TYPES.SpreadElement
        ) {
          inspectSelection(selection);
        }
        if (isBuilderMethodCall(context.sourceCode, node, PREDICATE_METHODS)) {
          for (const argument of node.arguments) {
            if (argument.type !== AST_NODE_TYPES.SpreadElement) {
              analyzeExpression(argument, "predicate");
            }
          }
        }
        if (isBuilderMethodCall(context.sourceCode, node, ORDERING_METHODS)) {
          for (const argument of node.arguments) {
            if (argument.type !== AST_NODE_TYPES.SpreadElement) {
              analyzeExpression(argument, "ordering");
            }
          }
        }
        if (unstableGrouping(context.sourceCode, node)) {
          context.report({ node, messageId: "unstableGrouping" });
        }
        const relationalConfig = relationalConfigArgument(
          context.sourceCode,
          node,
        );
        if (relationalConfig !== null) {
          inspectRelationalConfig(relationalConfig, new Set<TSESTree.Node>());
        }
        checkJoin(node);
        checkTransactionConfig(node);
        checkRawSelect(node);
      },
    };
  },
});
