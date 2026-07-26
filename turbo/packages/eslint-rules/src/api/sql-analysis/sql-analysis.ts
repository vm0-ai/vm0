import { Buffer } from "node:buffer";

import {
  AST_NODE_TYPES,
  type ParserServicesWithTypeInformation,
  type TSESTree,
} from "@typescript-eslint/utils";
import { type TypeChecker } from "typescript";

import {
  isDrizzleColumnType,
  isDrizzleTableType,
  isDrizzleWrapperType,
} from "../drizzle.ts";
import { parsePostgres } from "./postgres-parser.ts";
import {
  type SqlSourceChunk,
  type SqlSourceComposer,
  type SqlSourceVariant,
} from "./sql-source.ts";

type SqlAnalysisContext = "predicate" | "statement";

export type SqlAnalysisFinding =
  | {
      readonly helper: "and" | "eq" | "gt" | "gte" | "lt" | "lte" | "ne" | "or";
      readonly kind: "helper";
      readonly node: TSESTree.Node;
    }
  | {
      readonly kind: "query-builder";
      readonly node: TSESTree.Expression;
    };

export interface SqlAnalysis {
  readonly expandedTemplates: ReadonlySet<TSESTree.TaggedTemplateExpression>;
  readonly findings: readonly SqlAnalysisFinding[];
  readonly isSimpleSelect: boolean;
  readonly isTruePredicate: boolean;
  readonly ownsExpandedTemplates: boolean;
}

interface SqlMarker {
  readonly chunk: SqlSourceChunk;
  readonly isColumn: boolean;
  readonly isTable: boolean;
  readonly isWrapper: boolean;
  readonly node: TSESTree.Expression;
}

interface ParsedSql {
  readonly markers: ReadonlyMap<string, SqlMarker>;
  readonly sourceRanges: readonly SqlSourceRange[];
  readonly statement: unknown;
}

interface SqlSourceRange {
  readonly chunk: SqlSourceChunk;
  readonly end: number;
  readonly start: number;
}

type StructuralExpression = (
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
    }
) & {
  readonly sourceChunks: ReadonlySet<SqlSourceChunk>;
};

type ClassifiedHelperFinding = Extract<
  SqlAnalysisFinding,
  { readonly kind: "helper" }
> & {
  readonly sourceChunks: ReadonlySet<SqlSourceChunk>;
};

interface ExpressionClassification {
  readonly anchor: TSESTree.Node | undefined;
  readonly findings: readonly ClassifiedHelperFinding[];
  readonly isWholeReplacement: boolean;
}

interface RelationMatch {
  readonly joinedConditions: readonly SqlMarker[];
  readonly joinedTables: readonly SqlMarker[];
  readonly sourceTable: SqlMarker;
}

const ANALYSIS_CACHE = new WeakMap<
  SqlSourceComposer,
  WeakMap<TSESTree.Expression, Map<SqlAnalysisContext, SqlAnalysis>>
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

function parseSqlVariant(
  variant: SqlSourceVariant,
  context: SqlAnalysisContext,
  trackSourceRanges: boolean,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): ParsedSql | null {
  const literals = variant.chunks.flatMap((chunk) => {
    return chunk.kind === "literal" ? [chunk.text] : [];
  });
  const prefix = markerPrefix(literals);
  const markers = new Map<string, SqlMarker>();
  const sourceRanges: SqlSourceRange[] = [];
  const contextPrefix = context === "statement" ? "" : "SELECT 1 WHERE ";
  let source = contextPrefix;
  // libpg_query locations are UTF-8 byte offsets, not JavaScript string
  // indexes.
  let sourceByteLength = trackSourceRanges
    ? Buffer.byteLength(contextPrefix)
    : 0;
  let markerIndex = 0;
  for (const chunk of variant.chunks) {
    const start = sourceByteLength;
    if (chunk.kind === "literal") {
      source += chunk.text;
      if (trackSourceRanges) {
        sourceByteLength += Buffer.byteLength(chunk.text);
        sourceRanges.push({ chunk, end: sourceByteLength, start });
      }
      continue;
    }
    const expression = chunk.expression;
    const name = `${prefix}${markerIndex}`;
    const markerSource = `"${name}"`;
    markerIndex += 1;
    let cachedColumn: boolean | undefined;
    let cachedTable: boolean | undefined;
    let cachedWrapper: boolean | undefined;
    const marker: SqlMarker = {
      chunk,
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
    source += markerSource;
    if (trackSourceRanges) {
      sourceByteLength += Buffer.byteLength(markerSource);
      sourceRanges.push({ chunk, end: sourceByteLength, start });
    }
  }

  const parseResult = parsePostgres(source);
  if (parseResult === null || parseResult.statements.length !== 1) {
    return null;
  }
  const statement = parseResult.statements[0];
  return statement === undefined ? null : { markers, sourceRanges, statement };
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

function syntaxLocation(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const payload of Object.values(value)) {
    if (isRecord(payload) && typeof payload.location === "number") {
      return payload.location;
    }
  }
  return undefined;
}

function ownSourceChunks(
  value: unknown,
  sourceRanges: readonly SqlSourceRange[],
): ReadonlySet<SqlSourceChunk> {
  const location = syntaxLocation(value);
  if (location === undefined || location < 0) {
    return new Set();
  }
  const range = sourceRanges.find((candidate) => {
    return candidate.start <= location && location < candidate.end;
  });
  return range === undefined ? new Set() : new Set([range.chunk]);
}

function mergeSourceChunks(
  own: ReadonlySet<SqlSourceChunk>,
  expressions: readonly StructuralExpression[],
): ReadonlySet<SqlSourceChunk> {
  return new Set([
    ...own,
    ...expressions.flatMap((expression) => {
      return [...expression.sourceChunks];
    }),
  ]);
}

function collectStructuralExpressions(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
  sourceRanges: readonly SqlSourceRange[],
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
      expressions.push(structuralExpression(current, markers, sourceRanges));
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
  sourceRanges: readonly SqlSourceRange[],
): StructuralExpression {
  const marker = columnMarker(value, markers);
  if (marker !== undefined) {
    return {
      kind: "marker",
      marker,
      sourceChunks: new Set([marker.chunk]),
    };
  }
  if (recordProperty(value, "A_Const") !== undefined) {
    return {
      kind: "constant",
      sourceChunks: ownSourceChunks(value, sourceRanges),
    };
  }

  const binary = recordProperty(value, "A_Expr");
  const binaryOperator = operatorName(binary?.name);
  if (
    binary?.kind === "AEXPR_OP" &&
    binaryOperator !== undefined &&
    binary.lexpr !== undefined &&
    binary.rexpr !== undefined
  ) {
    const left = structuralExpression(binary.lexpr, markers, sourceRanges);
    const right = structuralExpression(binary.rexpr, markers, sourceRanges);
    return {
      kind: "comparison",
      left,
      operator: binaryOperator,
      right,
      sourceChunks: mergeSourceChunks(ownSourceChunks(value, sourceRanges), [
        left,
        right,
      ]),
    };
  }

  const boolean = recordProperty(value, "BoolExpr");
  if (
    (boolean?.boolop === "AND_EXPR" || boolean?.boolop === "OR_EXPR") &&
    Array.isArray(boolean.args) &&
    boolean.args.length >= 2
  ) {
    const items = boolean.args.map((item) => {
      return structuralExpression(item, markers, sourceRanges);
    });
    return {
      items,
      kind: "boolean",
      operator: boolean.boolop === "AND_EXPR" ? "and" : "or",
      sourceChunks: mergeSourceChunks(
        ownSourceChunks(value, sourceRanges),
        items,
      ),
    };
  }

  const payload = isRecord(value) ? Object.values(value)[0] : undefined;
  const children = collectStructuralExpressions(payload, markers, sourceRanges);
  return {
    children,
    kind: "opaque",
    sourceChunks: mergeSourceChunks(
      ownSourceChunks(value, sourceRanges),
      children,
    ),
  };
}

function deduplicateFindings<T extends SqlAnalysisFinding>(
  findings: readonly T[],
): T[] {
  const result: T[] = [];
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
      isWholeReplacement: false,
    };
  }
  if (expression.kind === "constant") {
    return {
      anchor: undefined,
      findings: [],
      isWholeReplacement: false,
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
            sourceChunks: expression.sourceChunks,
          },
        ],
        isWholeReplacement: true,
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
      isWholeReplacement: false,
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
              sourceChunks: expression.sourceChunks,
            },
          ],
          isWholeReplacement: true,
        };
      }
    }
    return {
      anchor: undefined,
      findings: [],
      isWholeReplacement: false,
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
    isWholeReplacement: false,
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

function isCompositionBoundary(
  node: TSESTree.Node,
): node is TSESTree.Expression {
  return (
    node.type === AST_NODE_TYPES.CallExpression ||
    node.type === AST_NODE_TYPES.ChainExpression ||
    node.type === AST_NODE_TYPES.ConditionalExpression ||
    node.type === AST_NODE_TYPES.Identifier ||
    node.type === AST_NODE_TYPES.TaggedTemplateExpression ||
    node.type === AST_NODE_TYPES.TSAsExpression ||
    node.type === AST_NODE_TYPES.TSNonNullExpression ||
    node.type === AST_NODE_TYPES.TSSatisfiesExpression ||
    node.type === AST_NODE_TYPES.TSTypeAssertion
  );
}

function commonCompositionBoundaries(
  chunks: readonly SqlSourceChunk[],
  preferCallBoundary: boolean,
): TSESTree.Expression[] {
  const contributingChunks = chunks.filter((chunk) => {
    return chunk.kind === "expression" || chunk.text.trim() !== "";
  });
  const firstChunk = contributingChunks[0];
  if (firstChunk === undefined) {
    return [];
  }
  const commonBoundaries = [
    ...new Set(
      firstChunk.origins.filter((origin): origin is TSESTree.Expression => {
        return (
          isCompositionBoundary(origin) &&
          contributingChunks.every((chunk) => {
            return chunk.origins.includes(origin);
          })
        );
      }),
    ),
  ];
  const callBoundaries: TSESTree.Expression[] = preferCallBoundary
    ? commonBoundaries.filter((boundary) => {
        return boundary.type === AST_NODE_TYPES.CallExpression;
      })
    : [];
  return [
    ...callBoundaries,
    ...[...commonBoundaries].reverse().filter((boundary) => {
      return !callBoundaries.includes(boundary);
    }),
  ];
}

function commonCompositionBoundary(
  variant: SqlSourceVariant,
  preferCallBoundary: boolean,
): TSESTree.Expression | undefined {
  return commonCompositionBoundaries(variant.chunks, preferCallBoundary)[0];
}

function publicFinding(finding: ClassifiedHelperFinding): SqlAnalysisFinding {
  return {
    helper: finding.helper,
    kind: finding.kind,
    node: finding.node,
  };
}

function replacementBoundaryForFinding(
  finding: ClassifiedHelperFinding,
  variant: SqlSourceVariant,
  variantCount: number,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): TSESTree.Expression | undefined {
  // A parsed descendant can cross template boundaries because Drizzle inserts
  // nested SQL without parentheses. Reparse each editable boundary in
  // isolation before claiming that the helper can replace it.
  const candidates = commonCompositionBoundaries(
    [...finding.sourceChunks],
    variantCount === 1,
  );
  for (const candidate of candidates) {
    const candidateVariant = {
      chunks: variant.chunks.filter((chunk) => {
        return chunk.origins.includes(candidate);
      }),
    };
    const parsed = parseSqlVariant(
      candidateVariant,
      "predicate",
      false,
      checker,
      services,
    );
    const expression =
      parsed === null ? undefined : predicateExpression(parsed.statement);
    if (parsed === null || expression === undefined) {
      continue;
    }
    const classification = classifyExpression(
      structuralExpression(expression, parsed.markers, parsed.sourceRanges),
    );
    if (
      classification.isWholeReplacement &&
      classification.findings.length === 1 &&
      classification.findings[0]?.helper === finding.helper
    ) {
      return candidate;
    }
  }
  return undefined;
}

function analyzeParsed(
  node: TSESTree.Expression,
  context: SqlAnalysisContext,
  hasLocalExpansion: boolean,
  parsed: ParsedSql,
  variant: SqlSourceVariant,
  variantCount: number,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): SqlAnalysis {
  const simpleSelect =
    context === "statement" && isSimpleSelect(parsed.statement, parsed.markers);
  if (simpleSelect) {
    return {
      expandedTemplates: new Set(),
      findings: [{ kind: "query-builder", node }],
      isSimpleSelect: true,
      isTruePredicate: false,
      ownsExpandedTemplates: true,
    };
  }

  const expression =
    context === "predicate"
      ? predicateExpression(parsed.statement)
      : parsed.statement;
  const structuralExpressions =
    context === "predicate" && expression !== undefined
      ? [structuralExpression(expression, parsed.markers, parsed.sourceRanges)]
      : collectStructuralExpressions(
          expression,
          parsed.markers,
          parsed.sourceRanges,
        );
  const classifications = structuralExpressions.map((item) => {
    return classifyExpression(item);
  });
  const predicateClassification =
    context === "predicate" ? classifications[0] : undefined;
  const predicateFinding = predicateClassification?.findings[0];
  const rootNeedsCompositionBoundary =
    hasLocalExpansion && predicateFinding !== undefined;
  const canReplaceRoot =
    predicateClassification?.isWholeReplacement === true &&
    predicateClassification.findings.length === 1 &&
    predicateFinding?.kind === "helper" &&
    rootNeedsCompositionBoundary;
  const replacementBoundary = canReplaceRoot
    ? commonCompositionBoundary(variant, variantCount === 1)
    : undefined;
  const ownsExpandedTemplates = replacementBoundary !== undefined;
  const findings = deduplicateFindings(
    classifications.flatMap((classification) => {
      if (ownsExpandedTemplates) {
        return classification.findings.map((finding) => {
          return publicFinding({
            ...finding,
            node: replacementBoundary ?? node,
          });
        });
      }
      return classification.findings.flatMap((finding) => {
        if (!hasLocalExpansion) {
          return [publicFinding(finding)];
        }
        const boundary = replacementBoundaryForFinding(
          finding,
          variant,
          variantCount,
          checker,
          services,
        );
        return boundary === undefined
          ? []
          : [publicFinding({ ...finding, node: boundary })];
      });
    }),
  );
  return {
    expandedTemplates: new Set(),
    findings,
    isSimpleSelect: false,
    isTruePredicate:
      context === "predicate" &&
      expression !== undefined &&
      isTrueConstant(expression),
    ownsExpandedTemplates,
  };
}

function sameAnalysisSignature(left: SqlAnalysis, right: SqlAnalysis): boolean {
  if (
    left.isSimpleSelect !== right.isSimpleSelect ||
    left.isTruePredicate !== right.isTruePredicate ||
    left.ownsExpandedTemplates !== right.ownsExpandedTemplates ||
    left.findings.length !== right.findings.length
  ) {
    return false;
  }
  return left.findings.every((finding, index) => {
    const other = right.findings[index];
    return (
      other !== undefined &&
      finding.kind === other.kind &&
      (finding.kind === "query-builder" ||
        (other.kind === "helper" && finding.helper === other.helper))
    );
  });
}

function emptyAnalysis(
  expandedTemplates: ReadonlySet<TSESTree.TaggedTemplateExpression>,
): SqlAnalysis {
  return {
    expandedTemplates,
    findings: [],
    isSimpleSelect: false,
    isTruePredicate: false,
    ownsExpandedTemplates: false,
  };
}

export function analyzeSql(
  node: TSESTree.Expression,
  context: SqlAnalysisContext,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
  composer: SqlSourceComposer,
): SqlAnalysis {
  let composerCache = ANALYSIS_CACHE.get(composer);
  if (composerCache === undefined) {
    composerCache = new WeakMap();
    ANALYSIS_CACHE.set(composer, composerCache);
  }
  const cached = composerCache.get(node)?.get(context);
  if (cached !== undefined) {
    return cached;
  }
  const source = composer.compose(node);
  let analysis: SqlAnalysis;
  if (source === null) {
    analysis = emptyAnalysis(new Set());
  } else {
    const variants: SqlAnalysis[] = [];
    for (const variant of source.variants) {
      const parsed = parseSqlVariant(
        variant,
        context,
        source.hasLocalExpansion,
        checker,
        services,
      );
      if (parsed === null) {
        variants.length = 0;
        break;
      }
      variants.push(
        analyzeParsed(
          node,
          context,
          source.hasLocalExpansion,
          parsed,
          variant,
          source.variants.length,
          checker,
          services,
        ),
      );
    }
    const first = variants[0];
    if (
      first === undefined ||
      variants.some((variant) => {
        return !sameAnalysisSignature(variant, first);
      })
    ) {
      analysis = emptyAnalysis(source.expandedTemplates);
    } else {
      analysis = {
        expandedTemplates: source.expandedTemplates,
        findings: deduplicateFindings(
          variants.flatMap((variant) => {
            return variant.findings;
          }),
        ),
        isSimpleSelect: first.isSimpleSelect,
        isTruePredicate: first.isTruePredicate,
        ownsExpandedTemplates: first.ownsExpandedTemplates,
      };
    }
  }
  const nodeCache = composerCache.get(node);
  if (nodeCache === undefined) {
    composerCache.set(node, new Map([[context, analysis]]));
  } else {
    nodeCache.set(context, analysis);
  }
  return analysis;
}
