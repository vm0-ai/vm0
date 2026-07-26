import {
  type ParserServicesWithTypeInformation,
  type TSESTree,
} from "@typescript-eslint/utils";
import { type TypeChecker } from "typescript";

import {
  isDrizzleColumnType,
  isDrizzleSqlTag,
  isDrizzleTableType,
  isDrizzleWrapperType,
} from "../drizzle.ts";
import { parsePostgres } from "./postgres-parser.ts";

type DirectSqlContext = "predicate" | "statement";

export type DirectSqlFinding =
  | {
      readonly helper: "and" | "eq" | "gt" | "gte" | "lt" | "lte" | "ne" | "or";
      readonly kind: "helper";
      readonly node: TSESTree.Node;
    }
  | {
      readonly kind: "query-builder";
      readonly node: TSESTree.TaggedTemplateExpression;
    };

export interface DirectSqlAnalysis {
  readonly findings: readonly DirectSqlFinding[];
  readonly isSimpleSelect: boolean;
  readonly isTruePredicate: boolean;
}

interface SqlMarker {
  readonly isColumn: boolean;
  readonly isTable: boolean;
  readonly isWrapper: boolean;
  readonly node: TSESTree.Expression;
}

interface ParsedDirectSql {
  readonly markers: ReadonlyMap<string, SqlMarker>;
  readonly statement: unknown;
}

type StructuralExpression =
  | {
      readonly children: readonly StructuralExpression[];
      readonly kind: "opaque";
    }
  | {
      readonly kind: "constant";
    }
  | {
      readonly kind: "marker";
      readonly marker: SqlMarker;
    }
  | {
      readonly kind: "comparison";
      readonly left: StructuralExpression;
      readonly operator: string;
      readonly right: StructuralExpression;
    }
  | {
      readonly items: readonly StructuralExpression[];
      readonly kind: "boolean";
      readonly operator: "and" | "or";
    };

interface ExpressionClassification {
  readonly anchor: TSESTree.Node | undefined;
  readonly findings: readonly DirectSqlFinding[];
}

interface RelationMatch {
  readonly joinedConditions: readonly SqlMarker[];
  readonly joinedTables: readonly SqlMarker[];
  readonly sourceTable: SqlMarker;
}

const EMPTY_ANALYSIS: DirectSqlAnalysis = {
  findings: [],
  isSimpleSelect: false,
  isTruePredicate: false,
};

const ANALYSIS_CACHE = new WeakMap<
  TSESTree.TaggedTemplateExpression,
  Map<DirectSqlContext, DirectSqlAnalysis>
>();

const COMPARISON_HELPERS = new Map<
  string,
  "eq" | "gt" | "gte" | "lt" | "lte" | "ne"
>([
  ["=", "eq"],
  ["<>", "ne"],
  [">", "gt"],
  [">=", "gte"],
  ["<", "lt"],
  ["<=", "lte"],
]);

const EXPRESSION_NODE_KEYS = new Set([
  "A_ArrayExpr",
  "A_Const",
  "A_Expr",
  "A_Indirection",
  "BoolExpr",
  "BooleanTest",
  "CaseExpr",
  "CaseWhen",
  "CoalesceExpr",
  "CollateClause",
  "ColumnRef",
  "FuncCall",
  "MinMaxExpr",
  "NamedArgExpr",
  "NullTest",
  "ParamRef",
  "RowExpr",
  "SQLValueFunction",
  "SetToDefault",
  "SubLink",
  "TypeCast",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordProperty(
  value: unknown,
  property: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const result = value[property];
  return isRecord(result) ? result : undefined;
}

function quasiText(node: TSESTree.TemplateElement): string {
  return node.value.cooked ?? node.value.raw;
}

function markerIsColumn(
  node: TSESTree.Expression,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): boolean {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  const type = checker.getTypeAtLocation(tsNode);
  return isDrizzleColumnType(checker, type, tsNode);
}

function markerIsTable(
  node: TSESTree.Expression,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): boolean {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  const type = checker.getTypeAtLocation(tsNode);
  return isDrizzleTableType(checker, type, tsNode);
}

function markerIsWrapper(
  node: TSESTree.Expression,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): boolean {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  return isDrizzleWrapperType(checker, checker.getTypeAtLocation(tsNode));
}

function markerPrefix(quasis: readonly string[]): string {
  let suffix = 0;
  while (true) {
    const prefix = `__vm0_sql_marker_${suffix}_`;
    if (
      quasis.every((quasi) => {
        return !quasi.toLowerCase().includes(prefix);
      })
    ) {
      return prefix;
    }
    suffix += 1;
  }
}

function parseDirectSql(
  node: TSESTree.TaggedTemplateExpression,
  context: DirectSqlContext,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): ParsedDirectSql | null {
  if (!isDrizzleSqlTag(checker, services, node.tag)) {
    return null;
  }
  const quasis = node.quasi.quasis.map(quasiText);
  const prefix = markerPrefix(quasis);
  const markers = new Map<string, SqlMarker>();
  let source = quasis[0] ?? "";
  for (let index = 0; index < node.quasi.expressions.length; index += 1) {
    const expression = node.quasi.expressions[index];
    const followingQuasi = quasis[index + 1];
    if (expression === undefined || followingQuasi === undefined) {
      return null;
    }
    const name = `${prefix}${index}`;
    let cachedColumn: boolean | undefined;
    let cachedTable: boolean | undefined;
    let cachedWrapper: boolean | undefined;
    const marker: SqlMarker = {
      get isColumn(): boolean {
        cachedColumn ??= markerIsColumn(expression, checker, services);
        return cachedColumn;
      },
      get isTable(): boolean {
        cachedTable ??= markerIsTable(expression, checker, services);
        return cachedTable;
      },
      get isWrapper(): boolean {
        cachedWrapper ??= markerIsWrapper(expression, checker, services);
        return cachedWrapper;
      },
      node: expression,
    };
    markers.set(name, marker);
    source += `"${name}"${followingQuasi}`;
  }

  const parseResult = parsePostgres(
    context === "statement" ? source : `SELECT 1 WHERE ${source}`,
  );
  if (parseResult === null || parseResult.statements.length !== 1) {
    return null;
  }
  const statement = parseResult.statements[0];
  return statement === undefined ? null : { markers, statement };
}

function stringNodeValue(value: unknown): string | undefined {
  const stringNode = recordProperty(value, "String");
  return typeof stringNode?.sval === "string" ? stringNode.sval : undefined;
}

function columnMarker(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): SqlMarker | undefined {
  const columnRef = recordProperty(value, "ColumnRef");
  if (!Array.isArray(columnRef?.fields) || columnRef.fields.length !== 1) {
    return undefined;
  }
  const name = stringNodeValue(columnRef.fields[0]);
  return name === undefined ? undefined : markers.get(name);
}

function relationMarker(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): SqlMarker | undefined {
  const rangeVar = recordProperty(value, "RangeVar");
  if (
    rangeVar === undefined ||
    typeof rangeVar.relname !== "string" ||
    Object.keys(rangeVar).some((key) => {
      return !["inh", "location", "relname", "relpersistence"].includes(key);
    })
  ) {
    return undefined;
  }
  return markers.get(rangeVar.relname);
}

function operatorName(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 1) {
    return undefined;
  }
  return stringNodeValue(value[0]);
}

function isExpressionNode(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).some((key) => {
      return EXPRESSION_NODE_KEYS.has(key);
    })
  );
}

function collectStructuralExpressions(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): StructuralExpression[] {
  const expressions: StructuralExpression[] = [];

  function visit(current: unknown): void {
    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item);
      }
      return;
    }
    if (!isRecord(current)) {
      return;
    }
    if (isExpressionNode(current)) {
      expressions.push(structuralExpression(current, markers));
      return;
    }
    for (const child of Object.values(current)) {
      visit(child);
    }
  }

  visit(value);
  return expressions;
}

function structuralExpression(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): StructuralExpression {
  const marker = columnMarker(value, markers);
  if (marker !== undefined) {
    return { kind: "marker", marker };
  }
  if (recordProperty(value, "A_Const") !== undefined) {
    return { kind: "constant" };
  }

  const binary = recordProperty(value, "A_Expr");
  const binaryOperator = operatorName(binary?.name);
  if (
    binary?.kind === "AEXPR_OP" &&
    binaryOperator !== undefined &&
    binary.lexpr !== undefined &&
    binary.rexpr !== undefined
  ) {
    return {
      kind: "comparison",
      left: structuralExpression(binary.lexpr, markers),
      operator: binaryOperator,
      right: structuralExpression(binary.rexpr, markers),
    };
  }

  const boolean = recordProperty(value, "BoolExpr");
  if (
    (boolean?.boolop === "AND_EXPR" || boolean?.boolop === "OR_EXPR") &&
    Array.isArray(boolean.args) &&
    boolean.args.length >= 2
  ) {
    return {
      items: boolean.args.map((item) => {
        return structuralExpression(item, markers);
      }),
      kind: "boolean",
      operator: boolean.boolop === "AND_EXPR" ? "and" : "or",
    };
  }

  const payload = isRecord(value) ? Object.values(value)[0] : undefined;
  return {
    children: collectStructuralExpressions(payload, markers),
    kind: "opaque",
  };
}

function deduplicateFindings(
  findings: readonly DirectSqlFinding[],
): DirectSqlFinding[] {
  const result: DirectSqlFinding[] = [];
  const seen = new Map<TSESTree.Node, Set<string>>();
  for (const finding of findings) {
    const key =
      finding.kind === "query-builder"
        ? finding.kind
        : `${finding.kind}:${finding.helper}`;
    const nodeKeys = seen.get(finding.node);
    if (nodeKeys?.has(key) === true) {
      continue;
    }
    if (nodeKeys === undefined) {
      seen.set(finding.node, new Set([key]));
    } else {
      nodeKeys.add(key);
    }
    result.push(finding);
  }
  return result;
}

function classifyExpression(
  expression: StructuralExpression,
): ExpressionClassification {
  if (expression.kind === "marker") {
    return {
      anchor:
        expression.marker.isColumn || expression.marker.isWrapper
          ? expression.marker.node
          : undefined,
      findings: [],
    };
  }
  if (expression.kind === "constant") {
    return {
      anchor: undefined,
      findings: [],
    };
  }
  if (expression.kind === "comparison") {
    const helper = COMPARISON_HELPERS.get(expression.operator);
    if (
      helper !== undefined &&
      expression.left.kind === "marker" &&
      (expression.left.marker.isColumn || expression.left.marker.isWrapper)
    ) {
      return {
        anchor: expression.left.marker.node,
        findings: [
          {
            helper,
            kind: "helper",
            node: expression.left.marker.node,
          },
        ],
      };
    }
    const left = classifyExpression(expression.left);
    const right = classifyExpression(expression.right);
    return {
      anchor:
        left.anchor ??
        left.findings[0]?.node ??
        right.anchor ??
        right.findings[0]?.node,
      findings: deduplicateFindings([...left.findings, ...right.findings]),
    };
  }
  if (expression.kind === "boolean") {
    for (const item of expression.items) {
      const child = classifyExpression(item);
      const reportNode = child.anchor ?? child.findings[0]?.node;
      if (reportNode !== undefined) {
        return {
          anchor: reportNode,
          findings: [
            {
              helper: expression.operator,
              kind: "helper",
              node: reportNode,
            },
          ],
        };
      }
    }
    return {
      anchor: undefined,
      findings: [],
    };
  }

  const children = expression.children.map((child) => {
    return classifyExpression(child);
  });
  return {
    anchor:
      children.find((child) => {
        return child.anchor !== undefined || child.findings.length > 0;
      })?.anchor ??
      children.find((child) => {
        return child.findings[0] !== undefined;
      })?.findings[0]?.node,
    findings: deduplicateFindings(
      children.flatMap((child) => {
        return child.findings;
      }),
    ),
  };
}

function selectStatement(value: unknown): Record<string, unknown> | undefined {
  const statement = recordProperty(value, "stmt");
  return recordProperty(statement, "SelectStmt");
}

function selectedColumn(
  select: Record<string, unknown>,
  markers: ReadonlyMap<string, SqlMarker>,
): SqlMarker | undefined {
  if (!Array.isArray(select.targetList) || select.targetList.length !== 1) {
    return undefined;
  }
  const target = recordProperty(select.targetList[0], "ResTarget");
  if (
    target === undefined ||
    (target.name !== undefined && typeof target.name !== "string") ||
    Object.keys(target).some((key) => {
      return !["location", "name", "val"].includes(key);
    })
  ) {
    return undefined;
  }
  return columnMarker(target.val, markers);
}

function relationMatch(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): RelationMatch | undefined {
  const direct = relationMarker(value, markers);
  if (direct !== undefined) {
    return {
      joinedConditions: [],
      joinedTables: [],
      sourceTable: direct,
    };
  }

  const join = recordProperty(value, "JoinExpr");
  if (
    join?.jointype !== "JOIN_INNER" ||
    join.larg === undefined ||
    join.rarg === undefined ||
    join.quals === undefined ||
    Object.keys(join).some((key) => {
      return !["jointype", "larg", "quals", "rarg"].includes(key);
    })
  ) {
    return undefined;
  }
  const left = relationMatch(join.larg, markers);
  const right = relationMarker(join.rarg, markers);
  const condition = columnMarker(join.quals, markers);
  if (left === undefined || right === undefined || condition === undefined) {
    return undefined;
  }
  return {
    joinedConditions: [...left.joinedConditions, condition],
    joinedTables: [...left.joinedTables, right],
    sourceTable: left.sourceTable,
  };
}

function isLimitOne(value: unknown): boolean {
  const constant = recordProperty(value, "A_Const");
  const integer = recordProperty(constant, "ival");
  return integer?.ival === 1;
}

function isSimpleSelect(
  statement: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): boolean {
  const select = selectStatement(statement);
  if (
    select === undefined ||
    Object.keys(select).some((key) => {
      return ![
        "fromClause",
        "limitCount",
        "limitOption",
        "op",
        "targetList",
        "whereClause",
      ].includes(key);
    }) ||
    select.limitOption !== "LIMIT_OPTION_COUNT" ||
    select.op !== "SETOP_NONE" ||
    select.whereClause === undefined ||
    !isLimitOne(select.limitCount) ||
    !Array.isArray(select.fromClause) ||
    select.fromClause.length !== 1
  ) {
    return false;
  }

  const selected = selectedColumn(select, markers);
  const relation = relationMatch(select.fromClause[0], markers);
  return (
    selected?.isColumn === true &&
    relation?.sourceTable.isTable === true &&
    relation.joinedTables.every((marker) => {
      return marker.isTable;
    }) &&
    relation.joinedConditions.every((marker) => {
      return marker.isColumn || marker.isWrapper;
    })
  );
}

function predicateExpression(statement: unknown): unknown {
  return selectStatement(statement)?.whereClause;
}

function isTrueConstant(expression: unknown): boolean {
  const constant = recordProperty(expression, "A_Const");
  const boolean = recordProperty(constant, "boolval");
  return boolean?.boolval === true;
}

function analyzeParsed(
  node: TSESTree.TaggedTemplateExpression,
  context: DirectSqlContext,
  parsed: ParsedDirectSql,
): DirectSqlAnalysis {
  const simpleSelect =
    context === "statement" && isSimpleSelect(parsed.statement, parsed.markers);
  if (simpleSelect) {
    return {
      findings: [{ kind: "query-builder", node }],
      isSimpleSelect: true,
      isTruePredicate: false,
    };
  }

  const expression =
    context === "predicate"
      ? predicateExpression(parsed.statement)
      : parsed.statement;
  const structuralExpressions =
    context === "predicate" && expression !== undefined
      ? [structuralExpression(expression, parsed.markers)]
      : collectStructuralExpressions(expression, parsed.markers);
  const findings = deduplicateFindings(
    structuralExpressions.flatMap((item) => {
      return classifyExpression(item).findings;
    }),
  );
  return {
    findings,
    isSimpleSelect: false,
    isTruePredicate:
      context === "predicate" &&
      expression !== undefined &&
      isTrueConstant(expression),
  };
}

export function analyzeDirectSql(
  node: TSESTree.TaggedTemplateExpression,
  context: DirectSqlContext,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): DirectSqlAnalysis {
  const cached = ANALYSIS_CACHE.get(node)?.get(context);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = parseDirectSql(node, context, checker, services);
  const analysis =
    parsed === null ? EMPTY_ANALYSIS : analyzeParsed(node, context, parsed);
  const nodeCache = ANALYSIS_CACHE.get(node);
  if (nodeCache === undefined) {
    ANALYSIS_CACHE.set(node, new Map([[context, analysis]]));
  } else {
    nodeCache.set(context, analysis);
  }
  return analysis;
}
