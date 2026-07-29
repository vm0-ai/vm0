import { Buffer } from "node:buffer";

import {
  AST_NODE_TYPES,
  type ParserServicesWithTypeInformation,
  type TSESTree,
} from "@typescript-eslint/utils";
import {
  isArrayLiteralExpression,
  isCallExpression,
  isConditionalExpression,
  isIdentifier,
  isNonNullExpression,
  isParenthesizedExpression,
  isSatisfiesExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  IndexKind,
  NodeFlags,
  TypeFlags,
  type Node,
  type SourceFile,
  type Symbol as TypeScriptSymbol,
  type Type,
  type TypeChecker,
} from "typescript";

import {
  drizzleCallName,
  getDrizzleColumnMetadata,
  getDrizzleTableMetadataForWrite,
  isDrizzleArrayParameter,
  isDrizzleColumnType,
  isDrizzleArrayOperandType,
  isDrizzlePatternOperandType,
  isDrizzleSelectType,
  isDrizzleTableType,
  isDrizzleWrapperType,
  resolvedSymbol,
  type DrizzleTableColumnMetadata,
  type DrizzleTableMetadata,
} from "../drizzle.ts";
import { parsePostgres } from "./postgres-parser.ts";
import {
  type SqlSourceChunk,
  type SqlSourceComposer,
  type SqlSourceVariant,
} from "./sql-source.ts";

export type SqlAnalysisContext =
  | "ordering"
  | "optional-predicate"
  | "predicate"
  | "relation"
  | "selection"
  | "source-predicate-prefix"
  | "source-selection"
  | "source-statement"
  | "source-where-prefix"
  | "statement"
  | "structured-selection"
  | "write-expression";

type QueryCapability =
  | "composed-cte"
  | "delete"
  | "exists"
  | "locking"
  | "locking-cte-update"
  | "scalar-cte"
  | "select"
  | "structured-scalar"
  | "unnest-update"
  | "upsert";

export type SqlAnalysisFinding =
  | {
      readonly helper: SqlHelper;
      readonly kind: "helper";
      readonly node: TSESTree.Node;
      readonly sourceKey: string;
      readonly sourceLocalEligible: boolean;
      readonly sourceTemplateKey: string;
    }
  | {
      readonly helper: "exists" | "notExists";
      readonly kind: "existence-predicate";
      readonly node: TSESTree.Node;
      readonly sourceKey: string;
      readonly sourceLocalEligible: boolean;
      readonly sourceTemplateKey: string;
    }
  | {
      readonly kind: "empty-fragment";
      readonly node: TSESTree.Node;
    }
  | {
      readonly capability: QueryCapability;
      readonly kind: "query-builder";
      readonly node: TSESTree.Expression;
    };

export interface SqlCapabilityChecks {
  acceptsOptionalSql(node: TSESTree.Expression): boolean;
  allowsWriteQueryBuilder(
    node: TSESTree.Expression,
    expandedTemplates: ReadonlySet<TSESTree.TaggedTemplateExpression>,
  ): boolean;
  hasDirectResultMapping(node: TSESTree.Expression): boolean;
  hasParameterListOrigin(node: TSESTree.Expression): boolean;
  isInlineParameterList(node: TSESTree.Expression): boolean;
}

const NO_CAPABILITY_CHECKS: SqlCapabilityChecks = {
  acceptsOptionalSql(): boolean {
    return false;
  },
  allowsWriteQueryBuilder(): boolean {
    return false;
  },
  hasDirectResultMapping(): boolean {
    return false;
  },
  hasParameterListOrigin(): boolean {
    return false;
  },
  isInlineParameterList(): boolean {
    return false;
  },
};

export interface SqlAnalysis {
  readonly expandedTemplates: ReadonlySet<TSESTree.TaggedTemplateExpression>;
  readonly findingSignatures: readonly SqlFindingSignature[];
  readonly findings: readonly SqlAnalysisFinding[];
  readonly hasWholeReplacementBoundary: boolean;
  readonly isTruePredicate: boolean;
}

interface SqlFindingSignature {
  readonly boundaryIsRoot: boolean;
  readonly boundaryType: TSESTree.Node["type"];
  readonly helper: SqlHelper | undefined;
  readonly isPartial: boolean;
  readonly kind: SqlAnalysisFinding["kind"];
  readonly ownsResultMapping: boolean;
  readonly queryCapability: QueryCapability | undefined;
}

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

interface SqlMarker {
  readonly chunk: SqlSourceChunk;
  readonly columnMetadata:
    | Readonly<
        Omit<
          DrizzleTableColumnMetadata,
          "isWritable" | "propertyName" | "propertySymbol"
        >
      >
    | undefined;
  readonly expressionSymbol: TypeScriptSymbol | undefined;
  readonly isArrayParameter: boolean;
  readonly isArrayOperand: boolean;
  readonly isBoundScalar: boolean;
  readonly isColumn: boolean;
  readonly isNumber: boolean;
  readonly isPatternOperand: boolean;
  readonly isSelect: boolean;
  readonly isStringOrWrapper: boolean;
  readonly isAnalyzableWriteInterpolation: boolean;
  readonly isTable: boolean;
  readonly isWrapper: boolean;
  readonly node: TSESTree.Expression;
  readonly tableMetadata: DrizzleTableMetadata | undefined;
}

interface ParsedSql {
  readonly markers: ReadonlyMap<string, SqlMarker>;
  readonly sourceRanges: readonly SqlSourceRange[];
  readonly statement: unknown;
}

interface RenderedSql {
  readonly source: string;
  readonly sourceRanges: readonly SqlSourceRange[];
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
      readonly nodeKey: string;
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
      readonly operator: "and" | "not" | "or";
    }
  | {
      readonly argument: StructuralExpression | undefined;
      readonly filter: StructuralExpression | undefined;
      readonly helper: AggregateHelper | undefined;
      readonly hasInternalOrdering: boolean;
      readonly isDistinct: boolean;
      readonly isStar: boolean;
      readonly isVariadic: boolean;
      readonly isWindowed: boolean;
      readonly kind: "aggregate";
      readonly orderings: readonly StructuralOrdering[];
    }
  | {
      readonly escape: StructuralExpression | undefined;
      readonly helper: PatternHelper;
      readonly kind: "pattern";
      readonly left: StructuralExpression;
      readonly right: StructuralExpression;
    }
  | {
      readonly helper: ArrayHelper;
      readonly kind: "array";
      readonly left: StructuralExpression;
      readonly right: StructuralExpression;
    }
  | {
      readonly helper: "inArray" | "notInArray";
      readonly kind: "membership";
      readonly left: StructuralExpression;
      readonly values: readonly StructuralExpression[];
    }
  | {
      readonly helper: "between" | "notBetween";
      readonly kind: "range";
      readonly left: StructuralExpression;
      readonly maximum: StructuralExpression;
      readonly minimum: StructuralExpression;
    }
  | {
      readonly helper: "isNotNull" | "isNull";
      readonly kind: "null";
      readonly operand: StructuralExpression;
    }
  | {
      readonly children: readonly StructuralExpression[];
      readonly isHandBuiltSelect: boolean;
      readonly kind: "existence";
      readonly selectMarker: SqlMarker | undefined;
      readonly subselect: unknown;
    }
) & {
  readonly sourceChunks: ReadonlySet<SqlSourceChunk>;
};

interface StructuralOrdering {
  readonly direction: "asc" | "desc" | undefined;
  readonly expression: StructuralExpression;
  readonly hasExplicitNullOrdering: boolean;
  readonly sourceChunks: ReadonlySet<SqlSourceChunk>;
}

type ClassifiedHelperFinding = (
  | {
      readonly helper: SqlHelper;
      readonly kind: "helper";
      readonly node: TSESTree.Node;
    }
  | {
      readonly helper: "exists" | "notExists";
      readonly kind: "existence-predicate";
      readonly node: TSESTree.Node;
    }
) & {
  readonly isolationContext: "ordering" | "predicate" | "selection";
  readonly isPartial: boolean;
  readonly sourceChunks: ReadonlySet<SqlSourceChunk>;
};

interface ExpressionClassification {
  readonly anchor: TSESTree.Node | undefined;
  readonly findings: readonly ClassifiedHelperFinding[];
  readonly isWholeReplacement: boolean;
}

interface ClassificationContext {
  readonly allowsOptionalSql: boolean;
  readonly allowsRetainedSqlWrapper: boolean;
  readonly capabilities: SqlCapabilityChecks;
  readonly checker: TypeChecker;
  readonly ownsResultMapping: boolean;
  readonly root: TSESTree.Expression;
  readonly services: ParserServicesWithTypeInformation;
  readonly variant: SqlSourceVariant;
}

interface RelationMatch {
  readonly joinedConditions: readonly SqlMarker[];
  readonly joinedTables: readonly SqlMarker[];
  readonly sourceTable: SqlMarker;
}

interface SchemaJoinGraph {
  readonly joinCount: number;
  readonly conditions: readonly unknown[];
}

interface ScalarCte {
  readonly guaranteedOneRow: boolean;
  readonly name: string;
}

interface WithClauseMatch {
  readonly ctes: readonly unknown[];
}

interface CommonTableExpressionMatch {
  readonly ctename: string;
  readonly ctequery: unknown;
}

interface RangeVarMatch {
  readonly alias: unknown;
  readonly relname: string;
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

type AggregateHelper =
  | "avg"
  | "avgDistinct"
  | "count"
  | "countDistinct"
  | "max"
  | "min"
  | "sum"
  | "sumDistinct";

type ArrayHelper = "arrayContained" | "arrayContains" | "arrayOverlaps";

type PatternHelper = "ilike" | "like" | "notIlike" | "notLike";

const ARRAY_HELPERS = new Map<string, ArrayHelper>([
  ["@>", "arrayContains"],
  ["<@", "arrayContained"],
  ["&&", "arrayOverlaps"],
]);

const PATTERN_HELPERS = new Map<string, PatternHelper>([
  ["~~", "like"],
  ["!~~", "notLike"],
  ["~~*", "ilike"],
  ["!~~*", "notIlike"],
]);

// These helpers always emit an expression fragment. Whole-write analysis can
// retain them as leaves after checking that none of their arguments is an
// opaque SQL-producing value.
const ANALYZABLE_WRITE_EXPRESSION_HELPERS = new Set<string>([
  ...COMPARISON_HELPERS.values(),
  ...ARRAY_HELPERS.values(),
  ...PATTERN_HELPERS.values(),
  "and",
  "avg",
  "avgDistinct",
  "between",
  "count",
  "countDistinct",
  "inArray",
  "isNotNull",
  "isNull",
  "max",
  "min",
  "not",
  "notBetween",
  "notInArray",
  "or",
  "sum",
  "sumDistinct",
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

function markerExpressionSymbol(
  node: TSESTree.Expression,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): TypeScriptSymbol | undefined {
  const symbolNode =
    node.type === AST_NODE_TYPES.MemberExpression ? node.property : node;
  const tsNode = services.esTreeNodeToTSNodeMap.get(symbolNode);
  return resolvedSymbol(checker, checker.getSymbolAtLocation(tsNode));
}

function markerColumnMetadata(
  node: TSESTree.Expression,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): SqlMarker["columnMetadata"] {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  return getDrizzleColumnMetadata(
    checker,
    checker.getTypeAtLocation(tsNode),
    tsNode,
  );
}

function markerTableMetadata(
  node: TSESTree.Expression,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): DrizzleTableMetadata | undefined {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  return getDrizzleTableMetadataForWrite(checker, tsNode);
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

function isBoundScalarType(type: Type, checker: TypeChecker): boolean {
  if ((type.flags & TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint !== undefined && isBoundScalarType(constraint, checker);
  }
  if (type.isUnion()) {
    return type.types.every((member) => {
      return isBoundScalarType(member, checker);
    });
  }
  return (
    (type.flags &
      (TypeFlags.BigIntLike |
        TypeFlags.BooleanLike |
        TypeFlags.Null |
        TypeFlags.NumberLike |
        TypeFlags.StringLike)) !==
    0
  );
}

function markerIsBoundScalar(
  node: TSESTree.Expression,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): boolean {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  return isBoundScalarType(checker.getTypeAtLocation(tsNode), checker);
}

function isNumberType(type: Type): boolean {
  if (type.isUnion()) {
    return type.types.every(isNumberType);
  }
  return (type.flags & TypeFlags.NumberLike) !== 0;
}

function markerIsNumber(
  node: TSESTree.Expression,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): boolean {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  return isNumberType(checker.getTypeAtLocation(tsNode));
}

function markerIsArrayOperand(
  node: TSESTree.Expression,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): boolean {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  return isDrizzleArrayOperandType(
    checker,
    checker.getTypeAtLocation(tsNode),
    tsNode,
  );
}

function markerIsPatternOperand(
  node: TSESTree.Expression,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): boolean {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  return isDrizzlePatternOperandType(
    checker,
    checker.getTypeAtLocation(tsNode),
    tsNode,
  );
}

function markerIsSelect(
  node: TSESTree.Expression,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): boolean {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  return isDrizzleSelectType(
    checker,
    checker.getTypeAtLocation(tsNode),
    tsNode,
  );
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

function isStringOrDrizzleWrapper(type: Type, checker: TypeChecker): boolean {
  if (type.isUnion()) {
    return type.types.every((member) => {
      return isStringOrDrizzleWrapper(member, checker);
    });
  }
  if ((type.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0) {
    return false;
  }
  if ((type.flags & TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type);
    return (
      constraint !== undefined && isStringOrDrizzleWrapper(constraint, checker)
    );
  }
  return (
    (type.flags & TypeFlags.StringLike) !== 0 ||
    isDrizzleWrapperType(checker, type)
  );
}

function markerIsStringOrWrapper(
  node: TSESTree.Expression,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): boolean {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  return isStringOrDrizzleWrapper(checker.getTypeAtLocation(tsNode), checker);
}

function markerIsWrapper(
  node: TSESTree.Expression,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): boolean {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  return isDrizzleWrapperType(checker, checker.getTypeAtLocation(tsNode));
}

function typeMayBeSqlWrapper(type: Type, checker: TypeChecker): boolean {
  if ((type.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0) {
    return true;
  }
  if ((type.flags & TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint === undefined || typeMayBeSqlWrapper(constraint, checker);
  }
  if (type.isUnion()) {
    return type.types.some((member) => {
      return typeMayBeSqlWrapper(member, checker);
    });
  }
  // Drizzle treats values with getSQL() as source-producing wrappers.
  return checker.getPropertyOfType(type, "getSQL") !== undefined;
}

function typeMayBeArray(type: Type, checker: TypeChecker): boolean {
  if ((type.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0) {
    return true;
  }
  if ((type.flags & TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint === undefined || typeMayBeArray(constraint, checker);
  }
  if (type.isUnion()) {
    return type.types.some((member) => {
      return typeMayBeArray(member, checker);
    });
  }
  return checker.isArrayType(type) || checker.isTupleType(type);
}

function typeMayBeUndefined(type: Type, checker: TypeChecker): boolean {
  if ((type.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0) {
    return true;
  }
  if ((type.flags & TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint === undefined || typeMayBeUndefined(constraint, checker);
  }
  if (type.isUnion()) {
    return type.types.some((member) => {
      return typeMayBeUndefined(member, checker);
    });
  }
  return (type.flags & (TypeFlags.Undefined | TypeFlags.Void)) !== 0;
}

function arrayMayContainDrizzleWrapper(
  type: Type,
  checker: TypeChecker,
): boolean {
  if ((type.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0) {
    return true;
  }
  if ((type.flags & TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type);
    return (
      constraint === undefined ||
      arrayMayContainDrizzleWrapper(constraint, checker)
    );
  }
  if (type.isUnion()) {
    return type.types.some((member) => {
      return arrayMayContainDrizzleWrapper(member, checker);
    });
  }
  const element = checker.getIndexTypeOfType(type, IndexKind.Number);
  return element === undefined || typeMayBeSqlWrapper(element, checker);
}

function unwrapWriteInterpolationExpression(node: Node): Node {
  let current = node;
  while (
    isNonNullExpression(current) ||
    isParenthesizedExpression(current) ||
    isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

interface LocalConstInitializer {
  readonly initializer: Node;
  readonly symbol: TypeScriptSymbol;
}

function localConstInitializer(
  checker: TypeChecker,
  node: Node,
  sourceFile: SourceFile,
  visited: Set<TypeScriptSymbol>,
): LocalConstInitializer | undefined {
  if (!isIdentifier(node)) {
    return undefined;
  }
  const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(node));
  if (
    symbol === undefined ||
    visited.has(symbol) ||
    symbol.valueDeclaration === undefined
  ) {
    return undefined;
  }
  const declaration = symbol.valueDeclaration;
  if (
    !isVariableDeclaration(declaration) ||
    declaration.getSourceFile() !== sourceFile ||
    !isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & NodeFlags.Const) === 0 ||
    declaration.initializer === undefined
  ) {
    return undefined;
  }
  return {
    initializer: declaration.initializer,
    symbol,
  };
}

function isAnalyzableWriteInterpolation(
  checker: TypeChecker,
  node: Node,
  sourceFile: SourceFile,
  visited: Set<TypeScriptSymbol>,
  allowsValueSemantics: boolean,
): boolean {
  const expression = unwrapWriteInterpolationExpression(node);
  const type = checker.getTypeAtLocation(expression);
  const isColumnOrTable =
    isDrizzleColumnType(checker, type, expression) ||
    isDrizzleTableType(checker, type, expression);
  const local = localConstInitializer(checker, expression, sourceFile, visited);
  if (local !== undefined) {
    visited.add(local.symbol);
    const analyzable = isAnalyzableWriteInterpolation(
      checker,
      local.initializer,
      sourceFile,
      visited,
      allowsValueSemantics,
    );
    visited.delete(local.symbol);
    return analyzable;
  }

  if (isConditionalExpression(expression)) {
    return (
      isAnalyzableWriteInterpolation(
        checker,
        expression.whenTrue,
        sourceFile,
        visited,
        allowsValueSemantics,
      ) &&
      isAnalyzableWriteInterpolation(
        checker,
        expression.whenFalse,
        sourceFile,
        visited,
        allowsValueSemantics,
      )
    );
  }

  if (isColumnOrTable) {
    return true;
  }
  if (typeMayBeArray(type, checker)) {
    // A directly interpolated array is a list of SQL chunks in Drizzle, not a
    // bound value. Arrays are only analyzable inside a known helper or
    // sql.param.
    if (!allowsValueSemantics) {
      return false;
    }
    if (!arrayMayContainDrizzleWrapper(type, checker)) {
      return true;
    }
    if (!isArrayLiteralExpression(expression)) {
      return false;
    }
    return expression.elements.every((element) => {
      return isSpreadElement(element)
        ? isAnalyzableWriteInterpolation(
            checker,
            element.expression,
            sourceFile,
            visited,
            true,
          )
        : isAnalyzableWriteInterpolation(
            checker,
            element,
            sourceFile,
            visited,
            false,
          );
    });
  }

  if (isCallExpression(expression)) {
    const callName = drizzleCallName(checker, expression);
    if (callName === "param") {
      const argument = expression.arguments[0];
      return (
        expression.arguments.length === 1 &&
        argument !== undefined &&
        !isSpreadElement(argument) &&
        isAnalyzableWriteInterpolation(
          checker,
          argument,
          sourceFile,
          visited,
          true,
        )
      );
    }
    if (
      callName !== undefined &&
      ANALYZABLE_WRITE_EXPRESSION_HELPERS.has(callName) &&
      expression.arguments.every((argument) => {
        return (
          !isSpreadElement(argument) &&
          isAnalyzableWriteInterpolation(
            checker,
            argument,
            sourceFile,
            visited,
            true,
          )
        );
      })
    ) {
      return (
        (callName !== "and" && callName !== "or") ||
        expression.arguments.some((argument) => {
          return (
            !isSpreadElement(argument) &&
            !typeMayBeUndefined(checker.getTypeAtLocation(argument), checker)
          );
        })
      );
    }
  }

  // Undefined top-level chunks disappear from Drizzle SQL entirely. Inside a
  // known helper or sql.param, the helper owns that value's placement.
  if (!allowsValueSemantics && typeMayBeUndefined(type, checker)) {
    return false;
  }
  if (!typeMayBeSqlWrapper(type, checker)) {
    return true;
  }
  return false;
}

function markerIsAnalyzableWriteInterpolation(
  node: TSESTree.Expression,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): boolean {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  return isAnalyzableWriteInterpolation(
    checker,
    tsNode,
    tsNode.getSourceFile(),
    new Set(),
    false,
  );
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
  const markerNames: string[] = [];
  const selectCandidateNames = new Set<string>();
  const contextPrefix =
    context === "statement" || context === "source-statement"
      ? ""
      : context === "predicate" || context === "optional-predicate"
        ? "SELECT 1 WHERE "
        : context === "source-predicate-prefix"
          ? "SELECT 1 WHERE TRUE "
          : context === "source-where-prefix"
            ? "SELECT 1 "
            : context === "selection" ||
                context === "source-selection" ||
                context === "structured-selection" ||
                context === "write-expression"
              ? "SELECT "
              : context === "ordering"
                ? "SELECT 1 ORDER BY "
                : "SELECT 1 FROM ";
  let markerIndex = 0;
  let precedingLiteral = "";
  for (const chunk of variant.chunks) {
    if (chunk.kind === "literal") {
      precedingLiteral += chunk.text;
      continue;
    }
    const expression = chunk.expression;
    const name = `${prefix}${markerIndex}`;
    markerIndex += 1;
    markerNames.push(name);
    if (/\bEXISTS\b/i.test(precedingLiteral)) {
      selectCandidateNames.add(name);
    }
    precedingLiteral = "";
    let cachedArrayParameter: boolean | undefined;
    let cachedArrayOperand: boolean | undefined;
    let cachedBoundScalar: boolean | undefined;
    let cachedColumn: boolean | undefined;
    let cachedColumnMetadata: SqlMarker["columnMetadata"] | null | undefined;
    let cachedExpressionSymbol: TypeScriptSymbol | null | undefined;
    let cachedNumber: boolean | undefined;
    let cachedPatternOperand: boolean | undefined;
    let cachedSelect: boolean | undefined;
    let cachedAnalyzableWriteInterpolation: boolean | undefined;
    let cachedStringOrWrapper: boolean | undefined;
    let cachedTable: boolean | undefined;
    let cachedTableMetadata: DrizzleTableMetadata | null | undefined;
    let cachedWrapper: boolean | undefined;
    const marker: SqlMarker = {
      chunk,
      get columnMetadata(): SqlMarker["columnMetadata"] {
        cachedColumnMetadata ??=
          markerColumnMetadata(expression, checker, services) ?? null;
        return cachedColumnMetadata ?? undefined;
      },
      get expressionSymbol(): TypeScriptSymbol | undefined {
        cachedExpressionSymbol ??=
          markerExpressionSymbol(expression, checker, services) ?? null;
        return cachedExpressionSymbol ?? undefined;
      },
      get isArrayParameter(): boolean {
        cachedArrayParameter ??= isDrizzleArrayParameter(
          checker,
          services,
          expression,
        );
        return cachedArrayParameter;
      },
      get isArrayOperand(): boolean {
        cachedArrayOperand ??= markerIsArrayOperand(
          expression,
          checker,
          services,
        );
        return cachedArrayOperand;
      },
      get isBoundScalar(): boolean {
        cachedBoundScalar ??= markerIsBoundScalar(
          expression,
          checker,
          services,
        );
        return cachedBoundScalar;
      },
      get isColumn(): boolean {
        cachedColumn ??= markerIsColumn(expression, checker, services);
        return cachedColumn;
      },
      get isNumber(): boolean {
        cachedNumber ??= markerIsNumber(expression, checker, services);
        return cachedNumber;
      },
      get isPatternOperand(): boolean {
        cachedPatternOperand ??= markerIsPatternOperand(
          expression,
          checker,
          services,
        );
        return cachedPatternOperand;
      },
      get isSelect(): boolean {
        cachedSelect ??= markerIsSelect(expression, checker, services);
        return cachedSelect;
      },
      get isAnalyzableWriteInterpolation(): boolean {
        cachedAnalyzableWriteInterpolation ??=
          markerIsAnalyzableWriteInterpolation(expression, checker, services);
        return cachedAnalyzableWriteInterpolation;
      },
      get isStringOrWrapper(): boolean {
        cachedStringOrWrapper ??= markerIsStringOrWrapper(
          expression,
          checker,
          services,
        );
        return cachedStringOrWrapper;
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
      get tableMetadata(): DrizzleTableMetadata | undefined {
        cachedTableMetadata ??=
          markerTableMetadata(expression, checker, services) ?? null;
        return cachedTableMetadata ?? undefined;
      },
    };
    markers.set(name, marker);
  }

  function render(useSelectMarkers: boolean): RenderedSql {
    const sourceRanges: SqlSourceRange[] = [];
    let source = contextPrefix;
    // libpg_query locations are UTF-8 byte offsets, not JavaScript string
    // indexes.
    let sourceByteLength = trackSourceRanges
      ? Buffer.byteLength(contextPrefix)
      : 0;
    let expressionIndex = 0;
    for (const chunk of variant.chunks) {
      const start = sourceByteLength;
      let chunkSource: string;
      if (chunk.kind === "literal") {
        chunkSource = chunk.text;
      } else {
        const name = markerNames[expressionIndex];
        expressionIndex += 1;
        if (name === undefined) {
          return { source: "", sourceRanges: [] };
        }
        const markerIdentifier = `"${name}"`;
        chunkSource =
          useSelectMarkers &&
          selectCandidateNames.has(name) &&
          markers.get(name)?.isSelect === true
            ? `(SELECT ${markerIdentifier})`
            : markerIdentifier;
      }
      source += chunkSource;
      if (trackSourceRanges) {
        sourceByteLength += Buffer.byteLength(chunkSource);
        sourceRanges.push({ chunk, end: sourceByteLength, start });
      }
    }
    return { source, sourceRanges };
  }

  let rendered = render(false);
  let parseResult = parsePostgres(rendered.source);
  if (parseResult === null && selectCandidateNames.size > 0) {
    rendered = render(true);
    parseResult = parsePostgres(rendered.source);
  }
  if (parseResult === null || parseResult.statements.length !== 1) {
    return null;
  }
  const statement = parseResult.statements[0];
  return statement === undefined
    ? null
    : { markers, sourceRanges: rendered.sourceRanges, statement };
}

function stringNodeValue(value: unknown): string | undefined {
  const stringNode = recordProperty(value, "String");
  return stringNode !== undefined &&
    typeof stringNode.sval === "string" &&
    hasOnlyKeys(stringNode, new Set(["sval"]))
    ? stringNode.sval
    : undefined;
}

function columnMarker(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): SqlMarker | undefined {
  const columnRef = recordProperty(value, "ColumnRef");
  if (
    !Array.isArray(columnRef?.fields) ||
    columnRef.fields.length !== 1 ||
    !hasOnlyKeys(columnRef, new Set(["fields", "location"]))
  ) {
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

function listItems(value: unknown): readonly unknown[] | undefined {
  const list = recordProperty(value, "List");
  return Array.isArray(list?.items) ? list.items : undefined;
}

function functionName(value: unknown): readonly string[] | undefined {
  const call = recordProperty(value, "FuncCall");
  if (!Array.isArray(call?.funcname)) {
    return undefined;
  }
  const names = call.funcname.map(stringNodeValue);
  return names.every((name): name is string => {
    return name !== undefined;
  })
    ? names
    : undefined;
}

function aggregateHelper(
  call: Record<string, unknown>,
): AggregateHelper | undefined {
  const names = functionName({ FuncCall: call });
  if (names?.length !== 1) {
    return undefined;
  }
  const name = names[0]?.toLowerCase();
  const isDistinct = call.agg_distinct === true;
  if (name === "count") {
    return isDistinct ? "countDistinct" : "count";
  }
  if (name === "avg") {
    return isDistinct ? "avgDistinct" : "avg";
  }
  if (name === "sum") {
    return isDistinct ? "sumDistinct" : "sum";
  }
  if (!isDistinct && (name === "max" || name === "min")) {
    return name;
  }
  return undefined;
}

function opaqueNodeKey(value: unknown): string {
  if (!isRecord(value)) {
    return "unknown";
  }
  const key = Object.keys(value)[0] ?? "unknown";
  const names = functionName(value);
  return names === undefined
    ? key
    : `${key}:${names
        .map((name) => {
          return name.toLowerCase();
        })
        .join(".")}`;
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
    binary !== undefined &&
    binaryOperator !== undefined &&
    binary.lexpr !== undefined &&
    binary.rexpr !== undefined
  ) {
    const left = structuralExpression(binary.lexpr, markers, sourceRanges);
    const right = structuralExpression(binary.rexpr, markers, sourceRanges);
    const own = ownSourceChunks(value, sourceRanges);
    if (binary.kind === "AEXPR_LIKE" || binary.kind === "AEXPR_ILIKE") {
      const helper = PATTERN_HELPERS.get(binaryOperator);
      if (helper !== undefined) {
        const rightCall = recordProperty(binary.rexpr, "FuncCall");
        const rightNames = functionName(binary.rexpr);
        const rightArguments = Array.isArray(rightCall?.args)
          ? rightCall.args
          : undefined;
        const hasEscape =
          rightNames?.length === 2 &&
          rightNames[0] === "pg_catalog" &&
          rightNames[1] === "like_escape" &&
          rightArguments?.length === 2;
        const pattern = hasEscape
          ? structuralExpression(rightArguments?.[0], markers, sourceRanges)
          : right;
        const escape = hasEscape
          ? structuralExpression(rightArguments?.[1], markers, sourceRanges)
          : undefined;
        return {
          escape,
          helper,
          kind: "pattern",
          left,
          right: pattern,
          sourceChunks: mergeSourceChunks(
            own,
            escape === undefined ? [left, pattern] : [left, pattern, escape],
          ),
        };
      }
    }
    if (binary.kind === "AEXPR_OP") {
      const arrayHelper = ARRAY_HELPERS.get(binaryOperator);
      if (arrayHelper !== undefined) {
        return {
          helper: arrayHelper,
          kind: "array",
          left,
          right,
          sourceChunks: mergeSourceChunks(own, [left, right]),
        };
      }
      return {
        kind: "comparison",
        left,
        operator: binaryOperator,
        right,
        sourceChunks: mergeSourceChunks(own, [left, right]),
      };
    }
    const items = listItems(binary.rexpr);
    if (
      binary.kind === "AEXPR_IN" &&
      items !== undefined &&
      (binaryOperator === "=" || binaryOperator === "<>")
    ) {
      const values = items.map((item) => {
        return structuralExpression(item, markers, sourceRanges);
      });
      return {
        helper: binaryOperator === "=" ? "inArray" : "notInArray",
        kind: "membership",
        left,
        sourceChunks: mergeSourceChunks(own, [left, ...values]),
        values,
      };
    }
    if (
      (binary.kind === "AEXPR_BETWEEN" ||
        binary.kind === "AEXPR_NOT_BETWEEN") &&
      items?.length === 2
    ) {
      const minimum = structuralExpression(items[0], markers, sourceRanges);
      const maximum = structuralExpression(items[1], markers, sourceRanges);
      return {
        helper: binary.kind === "AEXPR_BETWEEN" ? "between" : "notBetween",
        kind: "range",
        left,
        maximum,
        minimum,
        sourceChunks: mergeSourceChunks(own, [left, minimum, maximum]),
      };
    }
  }

  const nullTest = recordProperty(value, "NullTest");
  if (
    nullTest?.arg !== undefined &&
    (nullTest.nulltesttype === "IS_NULL" ||
      nullTest.nulltesttype === "IS_NOT_NULL")
  ) {
    const operand = structuralExpression(nullTest.arg, markers, sourceRanges);
    return {
      helper: nullTest.nulltesttype === "IS_NULL" ? "isNull" : "isNotNull",
      kind: "null",
      operand,
      sourceChunks: mergeSourceChunks(ownSourceChunks(value, sourceRanges), [
        operand,
      ]),
    };
  }

  const boolean = recordProperty(value, "BoolExpr");
  if (
    (boolean?.boolop === "AND_EXPR" ||
      boolean?.boolop === "NOT_EXPR" ||
      boolean?.boolop === "OR_EXPR") &&
    Array.isArray(boolean.args) &&
    ((boolean.boolop === "NOT_EXPR" && boolean.args.length === 1) ||
      (boolean.boolop !== "NOT_EXPR" && boolean.args.length >= 2))
  ) {
    const items = boolean.args.map((item) => {
      return structuralExpression(item, markers, sourceRanges);
    });
    return {
      items,
      kind: "boolean",
      operator:
        boolean.boolop === "AND_EXPR"
          ? "and"
          : boolean.boolop === "OR_EXPR"
            ? "or"
            : "not",
      sourceChunks: mergeSourceChunks(
        ownSourceChunks(value, sourceRanges),
        items,
      ),
    };
  }

  const call = recordProperty(value, "FuncCall");
  if (call !== undefined) {
    const helper = aggregateHelper(call);
    const args = Array.isArray(call.args) ? call.args : [];
    const isStar = call.agg_star === true;
    const validArity =
      helper === "count" && isStar
        ? args.length === 0
        : !isStar && args.length === 1;
    if (helper !== undefined && validArity) {
      const orderings = Array.isArray(call.agg_order)
        ? call.agg_order.flatMap((item) => {
            return structuralOrdering(item, markers, sourceRanges);
          })
        : [];
      const argument =
        args[0] === undefined
          ? undefined
          : structuralExpression(args[0], markers, sourceRanges);
      const filter =
        call.agg_filter === undefined
          ? undefined
          : structuralExpression(call.agg_filter, markers, sourceRanges);
      return {
        argument,
        filter,
        helper,
        hasInternalOrdering: orderings.length > 0,
        isDistinct: call.agg_distinct === true,
        isStar,
        isVariadic: call.func_variadic === true,
        isWindowed: call.over !== undefined,
        kind: "aggregate",
        orderings,
        sourceChunks: mergeSourceChunks(
          ownSourceChunks(value, sourceRanges),
          [
            argument,
            filter,
            ...orderings.map((ordering) => {
              return ordering.expression;
            }),
          ].filter((item): item is StructuralExpression => {
            return item !== undefined;
          }),
        ),
      };
    }
  }

  const sublink = recordProperty(value, "SubLink");
  if (
    sublink?.subLinkType === "EXISTS_SUBLINK" &&
    sublink.subselect !== undefined
  ) {
    const children = collectStructuralExpressions(
      sublink.subselect,
      markers,
      sourceRanges,
    );
    return {
      children,
      isHandBuiltSelect: isHandBuiltExistenceSelect(sublink.subselect, markers),
      kind: "existence",
      selectMarker: syntheticSelectMarker(sublink.subselect, markers),
      sourceChunks: mergeSourceChunks(
        ownSourceChunks(value, sourceRanges),
        children,
      ),
      subselect: sublink.subselect,
    };
  }

  const payload = isRecord(value) ? Object.values(value)[0] : undefined;
  const children = collectStructuralExpressions(payload, markers, sourceRanges);
  return {
    children,
    kind: "opaque",
    nodeKey: opaqueNodeKey(value),
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
        : finding.kind === "empty-fragment"
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

interface FindingWithSignature {
  readonly finding: SqlAnalysisFinding;
  readonly signature: SqlFindingSignature;
}

function deduplicateFindingEntries(
  entries: readonly FindingWithSignature[],
): FindingWithSignature[] {
  const findings = deduplicateFindings(
    entries.map((entry) => {
      return entry.finding;
    }),
  );
  return findings.flatMap((finding) => {
    const entry = entries.find((candidate) => {
      return candidate.finding === finding;
    });
    return entry === undefined ? [] : [entry];
  });
}

type DrizzleOperandRole =
  | "array"
  | "column"
  | "pattern"
  | "string-or-wrapper"
  | "wrapper";

type RetainedOperandRequirement = "interpolation" | "schema-column";

function directMarkerMatchesRole(
  marker: SqlMarker,
  role: DrizzleOperandRole,
): boolean {
  if (role === "array") {
    return marker.isArrayOperand;
  }
  if (role === "column") {
    return marker.isColumn;
  }
  if (role === "pattern") {
    return marker.isPatternOperand;
  }
  if (role === "string-or-wrapper") {
    return marker.isStringOrWrapper;
  }
  return marker.isWrapper;
}

function nodeMatchesRole(
  node: TSESTree.Expression,
  role: DrizzleOperandRole,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): boolean {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  const type = checker.getTypeAtLocation(tsNode);
  if (role === "array") {
    return isDrizzleArrayOperandType(checker, type, tsNode);
  }
  if (role === "column") {
    return isDrizzleColumnType(checker, type, tsNode);
  }
  if (role === "pattern") {
    return isDrizzlePatternOperandType(checker, type, tsNode);
  }
  if (role === "string-or-wrapper") {
    return isStringOrDrizzleWrapper(type, checker);
  }
  return isDrizzleWrapperType(checker, type);
}

function directStructuralChildren(
  expression: StructuralExpression,
): readonly StructuralExpression[] {
  if (expression.kind === "marker" || expression.kind === "constant") {
    return [];
  }
  if (expression.kind === "comparison" || expression.kind === "array") {
    return [expression.left, expression.right];
  }
  if (expression.kind === "boolean") {
    return expression.items;
  }
  if (expression.kind === "aggregate") {
    return [
      expression.argument,
      expression.filter,
      ...expression.orderings.map((ordering) => {
        return ordering.expression;
      }),
    ].filter((item): item is StructuralExpression => {
      return item !== undefined;
    });
  }
  if (expression.kind === "pattern") {
    return [expression.left, expression.right, expression.escape].filter(
      (item): item is StructuralExpression => {
        return item !== undefined;
      },
    );
  }
  if (expression.kind === "membership") {
    return [expression.left, ...expression.values];
  }
  if (expression.kind === "range") {
    return [expression.left, expression.minimum, expression.maximum];
  }
  if (expression.kind === "null") {
    return [expression.operand];
  }
  return expression.children;
}

function retainableInlineMarkers(
  expression: StructuralExpression,
  context: ClassificationContext,
): readonly SqlMarker[] | undefined {
  if (expression.kind === "marker") {
    const marker = expression.marker;
    return !marker.isTable &&
      !marker.isSelect &&
      (marker.isAnalyzableWriteInterpolation ||
        (context.allowsRetainedSqlWrapper && marker.isWrapper))
      ? [marker]
      : undefined;
  }
  const markers: SqlMarker[] = [];
  for (const child of directStructuralChildren(expression)) {
    const childMarkers = retainableInlineMarkers(child, context);
    if (childMarkers === undefined) {
      return undefined;
    }
    markers.push(...childMarkers);
  }
  return markers;
}

function hasInlineValueBoundary(
  expression: StructuralExpression,
  context: ClassificationContext,
): boolean {
  return (
    commonCompositionBoundaries([...expression.sourceChunks], context.root)
      .length > 0
  );
}

function isSafeHelperValueOperand(
  expression: StructuralExpression,
  context: ClassificationContext,
): boolean {
  if (expression.kind === "constant") {
    return true;
  }
  if (expression.kind === "marker") {
    const marker = expression.marker;
    return (
      !marker.isTable &&
      !marker.isSelect &&
      (marker.isBoundScalar || marker.isWrapper)
    );
  }
  const markers = retainableInlineMarkers(expression, context);
  return (
    markers !== undefined &&
    (markers.length === 0 || hasInlineValueBoundary(expression, context))
  );
}

// A retained operand has no standalone TypeScript node. PostgreSQL has already
// proved the expression boundary, so keep its original chunks and use a
// schema-aware interpolation only as the diagnostic anchor.
function retainedOperandAnchor(
  expression: StructuralExpression,
  role: DrizzleOperandRole,
  requirement: RetainedOperandRequirement,
  context: ClassificationContext,
): TSESTree.Expression | undefined {
  const markers = retainableInlineMarkers(expression, context);
  if (
    role === "array" ||
    role === "column" ||
    markers === undefined ||
    markers.length === 0 ||
    !hasInlineValueBoundary(expression, context)
  ) {
    return undefined;
  }
  const schemaColumn = markers.find((marker) => {
    return marker.isColumn;
  });
  if (requirement === "schema-column") {
    return schemaColumn?.node;
  }
  return (schemaColumn ?? markers[0])?.node;
}

function operandAnchor(
  expression: StructuralExpression,
  role: DrizzleOperandRole,
  classificationContext: ClassificationContext,
  retainedRequirement: RetainedOperandRequirement = "schema-column",
): TSESTree.Expression | undefined {
  if (expression.kind === "marker") {
    return directMarkerMatchesRole(expression.marker, role)
      ? expression.marker.node
      : undefined;
  }
  const boundary = exactExpressionBoundary(
    expression,
    classificationContext.variant,
    classificationContext.root,
    classificationContext.checker,
    classificationContext.services,
  );
  return boundary !== undefined &&
    nodeMatchesRole(
      boundary,
      role,
      classificationContext.checker,
      classificationContext.services,
    )
    ? boundary
    : retainedOperandAnchor(
        expression,
        role,
        retainedRequirement,
        classificationContext,
      );
}

function nestedClassificationContext(
  context: ClassificationContext,
): ClassificationContext {
  return context.ownsResultMapping || !context.allowsOptionalSql
    ? { ...context, allowsOptionalSql: true, ownsResultMapping: false }
    : context;
}

function classifiedFinding(
  helper: SqlHelper,
  node: TSESTree.Node,
  sourceChunks: ReadonlySet<SqlSourceChunk>,
  isolationContext: "ordering" | "predicate" | "selection" = "predicate",
  isPartial = false,
): ClassifiedHelperFinding {
  return {
    helper,
    isolationContext,
    isPartial,
    kind: "helper",
    node,
    sourceChunks,
  };
}

function firstClassificationNode(
  classification: ExpressionClassification,
): TSESTree.Node | undefined {
  return classification.anchor ?? classification.findings[0]?.node;
}

function classifyExistence(
  expression: Extract<StructuralExpression, { readonly kind: "existence" }>,
  helper: "exists" | "notExists",
  context: ClassificationContext,
): ExpressionClassification {
  const selectMarker = expression.selectMarker;
  if (selectMarker?.isSelect === true) {
    return {
      anchor: selectMarker.node,
      findings: [
        classifiedFinding(helper, selectMarker.node, expression.sourceChunks),
      ],
      isWholeReplacement: true,
    };
  }
  if (expression.isHandBuiltSelect) {
    const handBuilt = literalBoundaryNode(
      expression.sourceChunks,
      context.root,
    );
    return {
      anchor: handBuilt,
      findings: [
        {
          helper,
          isolationContext: "predicate",
          isPartial: false,
          kind: "existence-predicate",
          node: handBuilt,
          sourceChunks: expression.sourceChunks,
        },
      ],
      isWholeReplacement: true,
    };
  }
  const children = expression.children.map((child) => {
    return classifyExpression(child, nestedClassificationContext(context));
  });
  return {
    anchor: children.map(firstClassificationNode).find((node) => {
      return node !== undefined;
    }),
    findings: children.flatMap((child) => {
      return child.findings;
    }),
    isWholeReplacement: false,
  };
}

function classifyExpression(
  expression: StructuralExpression,
  context: ClassificationContext,
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
    const leftNode =
      helper === undefined
        ? undefined
        : operandAnchor(expression.left, "wrapper", context);
    if (
      helper !== undefined &&
      leftNode !== undefined &&
      isSafeHelperValueOperand(expression.right, context)
    ) {
      return {
        anchor: leftNode,
        findings: [
          classifiedFinding(helper, leftNode, expression.sourceChunks),
        ],
        isWholeReplacement: true,
      };
    }
    const childContext = nestedClassificationContext(context);
    const left = classifyExpression(expression.left, childContext);
    const right = classifyExpression(expression.right, childContext);
    return {
      anchor:
        left.anchor ??
        left.findings[0]?.node ??
        right.anchor ??
        right.findings[0]?.node,
      findings: [...left.findings, ...right.findings],
      isWholeReplacement: false,
    };
  }
  if (expression.kind === "boolean") {
    if (
      expression.operator === "not" &&
      expression.items[0]?.kind === "existence"
    ) {
      return classifyExistence(expression.items[0], "notExists", context);
    }
    const helper = expression.operator;
    const children = expression.items.map((item) => {
      return classifyExpression(item, nestedClassificationContext(context));
    });
    if ((helper !== "and" && helper !== "or") || context.allowsOptionalSql) {
      for (const child of children) {
        const reportNode = firstClassificationNode(child);
        if (reportNode !== undefined) {
          return {
            anchor: reportNode,
            findings: [
              classifiedFinding(helper, reportNode, expression.sourceChunks),
            ],
            isWholeReplacement: true,
          };
        }
      }
    }
    return {
      anchor: children.map(firstClassificationNode).find((node) => {
        return node !== undefined;
      }),
      findings: children.flatMap((child) => {
        return child.findings;
      }),
      isWholeReplacement: false,
    };
  }

  if (expression.kind === "null") {
    const node = operandAnchor(expression.operand, "wrapper", context);
    if (node !== undefined) {
      return {
        anchor: node,
        findings: [
          classifiedFinding(expression.helper, node, expression.sourceChunks),
        ],
        isWholeReplacement: true,
      };
    }
    return classifyExpression(
      expression.operand,
      nestedClassificationContext(context),
    );
  }

  if (expression.kind === "pattern") {
    const left = operandAnchor(expression.left, "pattern", context);
    const right = operandAnchor(
      expression.right,
      "string-or-wrapper",
      context,
      "interpolation",
    );
    if (left !== undefined && right !== undefined) {
      return {
        anchor: left,
        findings: [
          classifiedFinding(
            expression.helper,
            left,
            expression.sourceChunks,
            "predicate",
            expression.escape !== undefined,
          ),
        ],
        isWholeReplacement: expression.escape === undefined,
      };
    }
    const childContext = nestedClassificationContext(context);
    const children = [expression.left, expression.right, expression.escape]
      .filter((item): item is StructuralExpression => {
        return item !== undefined;
      })
      .map((item) => {
        return classifyExpression(item, childContext);
      });
    return {
      anchor: children.map(firstClassificationNode).find((node) => {
        return node !== undefined;
      }),
      findings: children.flatMap((child) => {
        return child.findings;
      }),
      isWholeReplacement: false,
    };
  }

  if (expression.kind === "array") {
    const left = operandAnchor(expression.left, "array", context);
    const right = operandAnchor(expression.right, "wrapper", context);
    if (left !== undefined && right !== undefined) {
      return {
        anchor: left,
        findings: [
          classifiedFinding(expression.helper, left, expression.sourceChunks),
        ],
        isWholeReplacement: true,
      };
    }
    const childContext = nestedClassificationContext(context);
    const leftChild = classifyExpression(expression.left, childContext);
    const rightChild = classifyExpression(expression.right, childContext);
    return {
      anchor:
        firstClassificationNode(leftChild) ??
        firstClassificationNode(rightChild),
      findings: [...leftChild.findings, ...rightChild.findings],
      isWholeReplacement: false,
    };
  }

  if (expression.kind === "membership") {
    const directColumn = operandAnchor(expression.left, "column", context);
    const left =
      directColumn ?? operandAnchor(expression.left, "wrapper", context);
    const value =
      expression.values.length === 1 && expression.values[0]?.kind === "marker"
        ? expression.values[0].marker.node
        : undefined;
    const hasExactLiteralValues =
      expression.values.length > 0 &&
      expression.values.every((item) => {
        return item.kind === "constant";
      });
    const hasParameterListValues =
      value !== undefined &&
      (directColumn !== undefined
        ? context.capabilities.hasParameterListOrigin(value)
        : context.capabilities.isInlineParameterList(value));
    if (
      left !== undefined &&
      (hasExactLiteralValues || hasParameterListValues)
    ) {
      return {
        anchor: left,
        findings: [
          classifiedFinding(expression.helper, left, expression.sourceChunks),
        ],
        isWholeReplacement: true,
      };
    }
    const childContext = nestedClassificationContext(context);
    const children = [expression.left, ...expression.values].map((item) => {
      return classifyExpression(item, childContext);
    });
    return {
      anchor: children.map(firstClassificationNode).find((node) => {
        return node !== undefined;
      }),
      findings: children.flatMap((child) => {
        return child.findings;
      }),
      isWholeReplacement: false,
    };
  }

  if (expression.kind === "range") {
    const left = operandAnchor(expression.left, "wrapper", context);
    if (
      left !== undefined &&
      isSafeHelperValueOperand(expression.minimum, context) &&
      isSafeHelperValueOperand(expression.maximum, context)
    ) {
      return {
        anchor: left,
        findings: [
          classifiedFinding(expression.helper, left, expression.sourceChunks),
        ],
        isWholeReplacement: true,
      };
    }
    const childContext = nestedClassificationContext(context);
    const children = [
      expression.left,
      expression.minimum,
      expression.maximum,
    ].map((item) => {
      return classifyExpression(item, childContext);
    });
    return {
      anchor: children.map(firstClassificationNode).find((node) => {
        return node !== undefined;
      }),
      findings: children.flatMap((child) => {
        return child.findings;
      }),
      isWholeReplacement: false,
    };
  }

  if (expression.kind === "aggregate") {
    const childContext = nestedClassificationContext(context);
    const argumentClassification =
      expression.argument === undefined
        ? undefined
        : classifyExpression(expression.argument, childContext);
    const filterClassification =
      expression.filter === undefined
        ? undefined
        : classifyExpression(expression.filter, childContext);
    const orderingClassifications = expression.orderings.map((ordering) => {
      return classifyOrdering(ordering, childContext);
    });
    const children = [
      argumentClassification,
      filterClassification,
      ...orderingClassifications,
    ].filter((item): item is ExpressionClassification => {
      return item !== undefined;
    });
    const argumentNode =
      expression.argument === undefined
        ? undefined
        : operandAnchor(
            expression.argument,
            "wrapper",
            context,
            "interpolation",
          );
    const validArgument = expression.isStar
      ? expression.helper === "count"
      : argumentNode !== undefined;
    const helper = expression.helper;
    const sameColumnDecoder =
      (helper === "max" || helper === "min") &&
      expression.argument !== undefined &&
      operandAnchor(expression.argument, "column", context) !== undefined;
    const mappingAllowed =
      !context.ownsResultMapping ||
      context.capabilities.hasDirectResultMapping(context.root) ||
      sameColumnDecoder;
    if (
      helper !== undefined &&
      validArgument &&
      !expression.hasInternalOrdering &&
      !expression.isVariadic &&
      !expression.isWindowed &&
      mappingAllowed
    ) {
      const node =
        argumentNode ??
        literalBoundaryNode(expression.sourceChunks, context.root);
      return {
        anchor: node,
        findings: [
          classifiedFinding(
            helper,
            node,
            expression.sourceChunks,
            "selection",
            expression.filter !== undefined,
          ),
          ...(filterClassification?.findings ?? []),
        ],
        isWholeReplacement: expression.filter === undefined,
      };
    }
    return {
      anchor: children.map(firstClassificationNode).find((node) => {
        return node !== undefined;
      }),
      findings: children.flatMap((child) => {
        return child.findings;
      }),
      isWholeReplacement: false,
    };
  }

  if (expression.kind === "existence") {
    return classifyExistence(expression, "exists", context);
  }

  const children = expression.children.map((child) => {
    return classifyExpression(child, nestedClassificationContext(context));
  });
  return {
    anchor:
      children.find((child) => {
        return child.anchor !== undefined || child.findings.length > 0;
      })?.anchor ??
      children.find((child) => {
        return child.findings[0] !== undefined;
      })?.findings[0]?.node,
    findings: children.flatMap((child) => {
      return child.findings;
    }),
    isWholeReplacement: false,
  };
}

function selectStatement(value: unknown): Record<string, unknown> | undefined {
  const statement = recordProperty(value, "stmt");
  return recordProperty(statement, "SelectStmt");
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

function syntheticSelectMarker(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): SqlMarker | undefined {
  const select = recordProperty(value, "SelectStmt");
  if (
    select === undefined ||
    select.limitOption !== "LIMIT_OPTION_DEFAULT" ||
    select.op !== "SETOP_NONE" ||
    Object.keys(select).some((key) => {
      return !["limitOption", "op", "targetList"].includes(key);
    }) ||
    !Array.isArray(select.targetList) ||
    select.targetList.length !== 1
  ) {
    return undefined;
  }
  const target = recordProperty(select.targetList[0], "ResTarget");
  if (
    target === undefined ||
    Object.keys(target).some((key) => {
      return !["location", "val"].includes(key);
    })
  ) {
    return undefined;
  }
  return columnMarker(target.val, markers);
}

function isSelectOneTarget(value: unknown): boolean {
  const target = recordProperty(value, "ResTarget");
  if (
    target === undefined ||
    Object.keys(target).some((key) => {
      return !["location", "val"].includes(key);
    })
  ) {
    return false;
  }
  const constant = recordProperty(target.val, "A_Const");
  const integer = recordProperty(constant, "ival");
  return (
    constant !== undefined &&
    integer?.ival === 1 &&
    hasOnlyKeys(constant, new Set(["ival", "location"])) &&
    hasOnlyKeys(integer, new Set(["ival"]))
  );
}

function predicateMarkers(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): readonly SqlMarker[] | undefined {
  const direct = columnMarker(value, markers);
  if (direct !== undefined) {
    return [direct];
  }
  const boolean = recordProperty(value, "BoolExpr");
  if (
    boolean?.boolop !== "AND_EXPR" ||
    !Array.isArray(boolean.args) ||
    boolean.args.length < 2
  ) {
    return undefined;
  }
  const result = boolean.args.map((argument) => {
    return columnMarker(argument, markers);
  });
  return result.every((marker): marker is SqlMarker => {
    return marker !== undefined;
  })
    ? result
    : undefined;
}

function isHandBuiltExistenceSelect(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): boolean {
  const select = recordProperty(value, "SelectStmt");
  if (
    select === undefined ||
    select.op !== "SETOP_NONE" ||
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
    !Array.isArray(select.targetList) ||
    select.targetList.length !== 1 ||
    !isSelectOneTarget(select.targetList[0]) ||
    !Array.isArray(select.fromClause) ||
    select.fromClause.length !== 1 ||
    select.whereClause === undefined
  ) {
    return false;
  }
  const relation = relationMatch(select.fromClause[0], markers);
  const predicates = predicateMarkers(select.whereClause, markers);
  const validLimit =
    select.limitOption === "LIMIT_OPTION_DEFAULT" &&
    select.limitCount === undefined
      ? true
      : select.limitOption === "LIMIT_OPTION_COUNT" &&
        isLimitOne(select.limitCount);
  return (
    validLimit &&
    relation?.sourceTable.isTable === true &&
    relation.joinedTables.every((marker) => {
      return marker.isTable;
    }) &&
    relation.joinedConditions.every((marker) => {
      return marker.isWrapper;
    }) &&
    predicates?.every((marker) => {
      return marker.isWrapper;
    }) === true
  );
}

function isLimitOne(value: unknown): boolean {
  const constant = recordProperty(value, "A_Const");
  const integer = recordProperty(constant, "ival");
  return (
    constant !== undefined &&
    integer?.ival === 1 &&
    hasOnlyKeys(constant, new Set(["ival", "location"])) &&
    hasOnlyKeys(integer, new Set(["ival"]))
  );
}

function isCompleteBuilderSelect(
  statement: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): boolean {
  const select = selectStatement(statement);
  if (
    select === undefined ||
    !hasOnlyKeys(
      select,
      new Set([
        "fromClause",
        "groupClause",
        "limitCount",
        "limitOption",
        "op",
        "sortClause",
        "targetList",
        "whereClause",
      ]),
    ) ||
    select.limitOption !== "LIMIT_OPTION_COUNT" ||
    select.op !== "SETOP_NONE" ||
    select.whereClause === undefined ||
    containsNodeKey(select.whereClause, "SubLink") ||
    !Array.isArray(select.fromClause) ||
    select.fromClause.length !== 1
  ) {
    return false;
  }

  const targets = targetValues(select);
  const relation = schemaJoinGraph(select.fromClause[0], markers);
  if (
    targets === undefined ||
    relation === undefined ||
    (relation.joinCount === 0
      ? targets.length !== 1 ||
        !isLimitOne(select.limitCount) ||
        select.groupClause !== undefined ||
        select.sortClause !== undefined
      : !isSupportedNumericLimit(select.limitCount, markers)) ||
    !markersMatch(targets, markers, (marker) => {
      return marker.isWrapper;
    }) ||
    !relation.conditions.every((condition) => {
      return markersMatch(condition, markers, (marker) => {
        return marker.isWrapper;
      });
    }) ||
    !markersMatch(select.whereClause, markers, (marker) => {
      return marker.isWrapper;
    })
  ) {
    return false;
  }
  if (
    select.groupClause !== undefined &&
    (!Array.isArray(select.groupClause) ||
      select.groupClause.length === 0 ||
      !markersMatch(select.groupClause, markers, (marker) => {
        return marker.isWrapper;
      }))
  ) {
    return false;
  }
  return (
    select.sortClause === undefined ||
    (Array.isArray(select.sortClause) &&
      select.sortClause.length > 0 &&
      markersMatch(select.sortClause, markers, (marker) => {
        return marker.isWrapper;
      }))
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => {
    return allowed.has(key);
  });
}

function markersWithin(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): readonly SqlMarker[] {
  const result = new Set<SqlMarker>();

  function visit(current: unknown): void {
    if (typeof current === "string") {
      const marker = markers.get(current);
      if (marker !== undefined) {
        result.add(marker);
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item);
      }
      return;
    }
    if (!isRecord(current)) {
      return;
    }
    for (const child of Object.values(current)) {
      visit(child);
    }
  }

  visit(value);
  return [...result];
}

function markersMatch(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
  predicate: (marker: SqlMarker) => boolean,
): boolean {
  const occurrences = markersWithin(value, markers);
  return (
    occurrences.length > 0 &&
    occurrences.every((marker) => {
      return predicate(marker);
    })
  );
}

function targetValues(
  select: Record<string, unknown>,
): readonly unknown[] | undefined {
  if (!Array.isArray(select.targetList) || select.targetList.length === 0) {
    return undefined;
  }
  const values: unknown[] = [];
  for (const item of select.targetList) {
    const target = recordProperty(item, "ResTarget");
    if (
      target?.val === undefined ||
      (target.name !== undefined && typeof target.name !== "string") ||
      !hasOnlyKeys(target, new Set(["location", "name", "val"]))
    ) {
      return undefined;
    }
    values.push(target.val);
  }
  return values;
}

function integerConstant(value: unknown): number | undefined {
  const constant = recordProperty(value, "A_Const");
  const integer = recordProperty(constant, "ival");
  return constant !== undefined &&
    typeof integer?.ival === "number" &&
    hasOnlyKeys(constant, new Set(["ival", "location"])) &&
    hasOnlyKeys(integer, new Set(["ival"]))
    ? integer.ival
    : undefined;
}

function isSupportedNumericLimit(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): boolean {
  const integer = integerConstant(value);
  if (integer !== undefined) {
    return Number.isInteger(integer) && integer >= 0;
  }
  return columnMarker(value, markers)?.isNumber === true;
}

function schemaJoinGraph(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): SchemaJoinGraph | undefined {
  const table = relationMarker(value, markers);
  if (table !== undefined) {
    return table.isTable ? { conditions: [], joinCount: 0 } : undefined;
  }

  const join = recordProperty(value, "JoinExpr");
  if (
    join === undefined ||
    (join.jointype !== "JOIN_INNER" && join.jointype !== "JOIN_LEFT") ||
    join.larg === undefined ||
    join.rarg === undefined ||
    join.quals === undefined ||
    !hasOnlyKeys(join, new Set(["jointype", "larg", "quals", "rarg"]))
  ) {
    return undefined;
  }
  const left = schemaJoinGraph(join.larg, markers);
  const right = relationMarker(join.rarg, markers);
  if (left === undefined || right?.isTable !== true) {
    return undefined;
  }
  return {
    conditions: [...left.conditions, join.quals],
    joinCount: left.joinCount + 1,
  };
}

const PAGINATED_SELECT_KEYS = new Set([
  "fromClause",
  "limitCount",
  "limitOption",
  "op",
  "sortClause",
  "targetList",
  "whereClause",
]);

function isPaginatedJoinedSelect(
  select: Record<string, unknown>,
  markers: ReadonlyMap<string, SqlMarker>,
): boolean {
  if (
    select.limitOption !== "LIMIT_OPTION_COUNT" ||
    select.op !== "SETOP_NONE" ||
    !hasOnlyKeys(select, PAGINATED_SELECT_KEYS) ||
    !Array.isArray(select.targetList) ||
    !Array.isArray(select.fromClause) ||
    select.fromClause.length !== 1 ||
    select.whereClause === undefined ||
    containsNodeKey(select.whereClause, "SubLink") ||
    !isSupportedNumericLimit(select.limitCount, markers)
  ) {
    return false;
  }
  const targetList = select.targetList;
  const targets = targetValues(select);
  if (
    targets === undefined ||
    targets.length !== 1 ||
    !isSelectOneTarget(targetList[0])
  ) {
    return false;
  }
  const relation = schemaJoinGraph(select.fromClause[0], markers);
  if (
    relation === undefined ||
    relation.joinCount === 0 ||
    !relation.conditions.every((condition) => {
      return markersMatch(condition, markers, (marker) => {
        return marker.isWrapper;
      });
    }) ||
    !markersMatch(select.whereClause, markers, (marker) => {
      return marker.isWrapper;
    })
  ) {
    return false;
  }
  if (select.sortClause === undefined) {
    return true;
  }
  return (
    Array.isArray(select.sortClause) &&
    select.sortClause.length > 0 &&
    markersMatch(select.sortClause, markers, (marker) => {
      return marker.isWrapper;
    })
  );
}

function exactSubLink(value: unknown): Record<string, unknown> | undefined {
  const subLink = recordProperty(value, "SubLink");
  return subLink !== undefined &&
    hasOnlyKeys(subLink, new Set(["location", "subLinkType", "subselect"])) &&
    subLink.subselect !== undefined
    ? subLink
    : undefined;
}

function isPaginatedExistsSelect(
  select: Record<string, unknown>,
  markers: ReadonlyMap<string, SqlMarker>,
): boolean {
  if (
    select.limitOption !== "LIMIT_OPTION_DEFAULT" ||
    select.op !== "SETOP_NONE" ||
    !hasOnlyKeys(select, new Set(["limitOption", "op", "targetList"])) ||
    !Array.isArray(select.targetList) ||
    select.targetList.length !== 1
  ) {
    return false;
  }
  const target = recordProperty(select.targetList[0], "ResTarget");
  const subLink = exactSubLink(target?.val);
  const inner = recordProperty(subLink?.subselect, "SelectStmt");
  return (
    target !== undefined &&
    typeof target.name === "string" &&
    hasOnlyKeys(target, new Set(["location", "name", "val"])) &&
    subLink?.subLinkType === "EXISTS_SUBLINK" &&
    inner !== undefined &&
    isPaginatedJoinedSelect(inner, markers)
  );
}

function rangeVarPayload(value: unknown): RangeVarMatch | undefined {
  const range = recordProperty(value, "RangeVar");
  if (
    range === undefined ||
    typeof range.relname !== "string" ||
    !hasOnlyKeys(
      range,
      new Set(["alias", "inh", "location", "relname", "relpersistence"]),
    )
  ) {
    return undefined;
  }
  return { alias: range.alias, relname: range.relname };
}

function validRelationAlias(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  const alias = isRecord(value) ? value : undefined;
  return (
    alias !== undefined &&
    typeof alias.aliasname === "string" &&
    hasOnlyKeys(alias, new Set(["aliasname"]))
  );
}

function literalRelationName(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
  allowAlias: boolean,
): string | undefined {
  const range = rangeVarPayload(value);
  if (
    range === undefined ||
    markers.has(range.relname) ||
    (!allowAlias && range.alias !== undefined) ||
    !validRelationAlias(range.alias)
  ) {
    return undefined;
  }
  return range.relname;
}

function directRangeMarker(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
  allowAlias: boolean,
): SqlMarker | undefined {
  const range = rangeVarPayload(value);
  if (
    range === undefined ||
    (!allowAlias && range.alias !== undefined) ||
    !validRelationAlias(range.alias)
  ) {
    return undefined;
  }
  return markers.get(range.relname);
}

function relationOriginIsDirect(
  value: unknown,
  sourceRanges: readonly SqlSourceRange[],
  hasLocalExpansion: boolean,
): boolean {
  if (!hasLocalExpansion) {
    return true;
  }
  const chunks = ownSourceChunks(value, sourceRanges);
  return (
    chunks.size > 0 &&
    [...chunks].every((chunk) => {
      return chunk.kind === "literal" && chunk.depth === 0;
    })
  );
}

function containsNodeKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => {
      return containsNodeKey(item, key);
    });
  }
  if (!isRecord(value)) {
    return false;
  }
  if (value[key] !== undefined) {
    return true;
  }
  return Object.values(value).some((child) => {
    return containsNodeKey(child, key);
  });
}

const LOCKING_SELECT_KEYS = new Set([
  "fromClause",
  "limitCount",
  "limitOption",
  "lockingClause",
  "op",
  "sortClause",
  "targetList",
  "whereClause",
]);

function isSupportedLockingSelect(
  select: Record<string, unknown>,
  markers: ReadonlyMap<string, SqlMarker>,
  sourceRanges: readonly SqlSourceRange[],
  hasLocalExpansion: boolean,
): boolean {
  if (
    select.op !== "SETOP_NONE" ||
    !hasOnlyKeys(select, LOCKING_SELECT_KEYS) ||
    !Array.isArray(select.fromClause) ||
    select.fromClause.length !== 1 ||
    select.whereClause === undefined ||
    targetValues(select) === undefined ||
    !Array.isArray(select.lockingClause) ||
    select.lockingClause.length !== 1 ||
    containsNodeKey(select.targetList, "SubLink") ||
    containsNodeKey(select.whereClause, "SubLink") ||
    containsNodeKey(select.sortClause, "SubLink")
  ) {
    return false;
  }
  const source = select.fromClause[0];
  const sourceMarker = directRangeMarker(source, markers, false);
  if (
    sourceMarker?.isTable !== true &&
    (literalRelationName(source, markers, false) === undefined ||
      !relationOriginIsDirect(source, sourceRanges, hasLocalExpansion))
  ) {
    return false;
  }
  const lock = recordProperty(select.lockingClause[0], "LockingClause");
  if (
    lock === undefined ||
    lock.strength !== "LCS_FORUPDATE" ||
    (lock.waitPolicy !== "LockWaitBlock" &&
      lock.waitPolicy !== "LockWaitSkip") ||
    !hasOnlyKeys(lock, new Set(["lockedRels", "strength", "waitPolicy"]))
  ) {
    return false;
  }
  if (lock.lockedRels !== undefined) {
    if (
      lock.waitPolicy !== "LockWaitBlock" ||
      !Array.isArray(lock.lockedRels) ||
      lock.lockedRels.length !== 1 ||
      directRangeMarker(lock.lockedRels[0], markers, false)?.isTable !== true
    ) {
      return false;
    }
  }
  if (
    select.sortClause !== undefined &&
    (!Array.isArray(select.sortClause) || select.sortClause.length === 0)
  ) {
    return false;
  }
  return select.limitCount === undefined
    ? select.limitOption === "LIMIT_OPTION_DEFAULT"
    : select.limitOption === "LIMIT_OPTION_COUNT" &&
        isLimitOne(select.limitCount);
}

const SCALAR_CONSTANT_PROPERTIES = [
  "boolval",
  "bsval",
  "fval",
  "ival",
  "sval",
] as const;

function scalarConstant(value: unknown): boolean {
  const constant = recordProperty(value, "A_Const");
  const scalarValues =
    constant === undefined
      ? []
      : SCALAR_CONSTANT_PROPERTIES.filter((property) => {
          const payload = recordProperty(constant, property);
          return (
            payload !== undefined && hasOnlyKeys(payload, new Set([property]))
          );
        });
  return (
    constant !== undefined &&
    hasOnlyKeys(
      constant,
      new Set([
        "boolval",
        "bsval",
        "fval",
        "isnull",
        "ival",
        "location",
        "sval",
      ]),
    ) &&
    scalarValues.length + (constant.isnull === true ? 1 : 0) === 1
  );
}

function scalarCastTypeName(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.names) &&
    value.names.length > 0 &&
    value.names.every((name) => {
      return stringNodeValue(name) !== undefined;
    }) &&
    hasOnlyKeys(
      value,
      new Set([
        "arrayBounds",
        "location",
        "names",
        "pct_type",
        "setof",
        "typemod",
        "typmods",
      ]),
    )
  );
}

function unwrapTypeCasts(value: unknown): unknown {
  let current = value;
  while (true) {
    const cast = recordProperty(current, "TypeCast");
    if (
      cast?.arg === undefined ||
      !hasOnlyKeys(cast, new Set(["arg", "location", "typeName"])) ||
      !scalarCastTypeName(cast.typeName)
    ) {
      return current;
    }
    current = cast.arg;
  }
}

const SCALAR_AGGREGATES = new Set(["avg", "count", "max", "min", "sum"]);

function isScalarAggregate(value: unknown): boolean {
  const call = recordProperty(value, "FuncCall");
  const names = functionName(value);
  return (
    call !== undefined &&
    hasOnlyKeys(
      call,
      new Set([
        "agg_distinct",
        "agg_filter",
        "agg_order",
        "agg_star",
        "agg_within_group",
        "args",
        "func_variadic",
        "funcformat",
        "funcname",
        "location",
        "over",
      ]),
    ) &&
    names?.length === 1 &&
    SCALAR_AGGREGATES.has(names[0]?.toLowerCase() ?? "") &&
    call.over === undefined
  );
}

function isScalarFallback(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): boolean {
  return (
    scalarConstant(value) ||
    columnMarker(value, markers)?.isBoundScalar === true
  );
}

function isGuaranteedScalarAggregate(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): boolean {
  const expression = unwrapTypeCasts(value);
  if (isScalarAggregate(expression)) {
    return true;
  }
  const coalesce = recordProperty(expression, "CoalesceExpr");
  return (
    coalesce !== undefined &&
    hasOnlyKeys(coalesce, new Set(["args", "location"])) &&
    Array.isArray(coalesce.args) &&
    coalesce.args.length === 2 &&
    isScalarAggregate(coalesce.args[0]) &&
    isScalarFallback(coalesce.args[1], markers)
  );
}

const SCALAR_CTE_BODY_KEYS = new Set([
  "fromClause",
  "limitCount",
  "limitOption",
  "op",
  "targetList",
  "whereClause",
]);

function scalarCteBody(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): Omit<ScalarCte, "name"> | undefined {
  const select = recordProperty(value, "SelectStmt");
  if (
    select === undefined ||
    select.op !== "SETOP_NONE" ||
    !hasOnlyKeys(select, SCALAR_CTE_BODY_KEYS) ||
    !Array.isArray(select.fromClause) ||
    select.fromClause.length !== 1 ||
    literalRelationName(select.fromClause[0], markers, false) === undefined ||
    select.whereClause === undefined ||
    containsNodeKey(select.targetList, "SubLink") ||
    containsNodeKey(select.whereClause, "SubLink")
  ) {
    return undefined;
  }
  const targets = targetValues(select);
  if (targets === undefined) {
    return undefined;
  }
  const guaranteedOneRow =
    targets.length === 1 && isGuaranteedScalarAggregate(targets[0], markers);
  const hasLimitOne =
    select.limitOption === "LIMIT_OPTION_COUNT" &&
    isLimitOne(select.limitCount);
  if (
    (!guaranteedOneRow && !hasLimitOne) ||
    (guaranteedOneRow &&
      select.limitCount === undefined &&
      select.limitOption !== "LIMIT_OPTION_DEFAULT")
  ) {
    return undefined;
  }
  return { guaranteedOneRow };
}

function scalarCteReference(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): string | undefined {
  const select = recordProperty(value, "SelectStmt");
  if (
    select === undefined ||
    select.limitOption !== "LIMIT_OPTION_DEFAULT" ||
    select.op !== "SETOP_NONE" ||
    !hasOnlyKeys(
      select,
      new Set(["fromClause", "limitOption", "op", "targetList"]),
    ) ||
    !Array.isArray(select.targetList) ||
    select.targetList.length !== 1 ||
    !Array.isArray(select.fromClause) ||
    select.fromClause.length !== 1
  ) {
    return undefined;
  }
  const target = recordProperty(select.targetList[0], "ResTarget");
  const column = recordProperty(target?.val, "ColumnRef");
  const name =
    Array.isArray(column?.fields) &&
    column.fields.length === 1 &&
    hasOnlyKeys(column, new Set(["fields", "location"]))
      ? stringNodeValue(column.fields[0])
      : undefined;
  const relation = literalRelationName(select.fromClause[0], markers, false);
  return target !== undefined &&
    name !== undefined &&
    relation !== undefined &&
    hasOnlyKeys(target, new Set(["location", "val"]))
    ? relation
    : undefined;
}

function withClausePayload(
  select: Record<string, unknown>,
): WithClauseMatch | undefined {
  const withClause = isRecord(select.withClause)
    ? select.withClause
    : undefined;
  if (
    withClause === undefined ||
    withClause.recursive === true ||
    !Array.isArray(withClause.ctes) ||
    withClause.ctes.length === 0 ||
    !hasOnlyKeys(withClause, new Set(["ctes", "location", "recursive"]))
  ) {
    return undefined;
  }
  return { ctes: withClause.ctes };
}

function commonTableExpression(
  value: unknown,
): CommonTableExpressionMatch | undefined {
  const cte = recordProperty(value, "CommonTableExpr");
  if (
    cte === undefined ||
    typeof cte.ctename !== "string" ||
    cte.ctematerialized !== "CTEMaterializeDefault" ||
    cte.ctequery === undefined ||
    !hasOnlyKeys(
      cte,
      new Set(["ctematerialized", "ctename", "ctequery", "location"]),
    )
  ) {
    return undefined;
  }
  return { ctename: cte.ctename, ctequery: cte.ctequery };
}

function isScalarCteProjection(
  select: Record<string, unknown>,
  markers: ReadonlyMap<string, SqlMarker>,
): boolean {
  if (
    select.limitOption !== "LIMIT_OPTION_DEFAULT" ||
    select.op !== "SETOP_NONE" ||
    !hasOnlyKeys(
      select,
      new Set(["limitOption", "op", "targetList", "withClause"]),
    ) ||
    ![...markers.values()].every((marker) => {
      return marker.isBoundScalar;
    })
  ) {
    return false;
  }
  const withClause = withClausePayload(select);
  if (withClause === undefined || withClause.ctes.length < 2) {
    return false;
  }
  const ctes = new Map<string, ScalarCte>();
  for (const item of withClause.ctes) {
    const cte = commonTableExpression(item);
    const body = scalarCteBody(cte?.ctequery, markers);
    if (cte === undefined || body === undefined || ctes.has(cte.ctename)) {
      return false;
    }
    ctes.set(cte.ctename, {
      guaranteedOneRow: body.guaranteedOneRow,
      name: cte.ctename,
    });
  }
  if (!Array.isArray(select.targetList) || select.targetList.length === 0) {
    return false;
  }
  const referenced = new Set<string>();
  const aliases = new Set<string>();
  let hasGuaranteedOneRow = false;
  for (const item of select.targetList) {
    const target = recordProperty(item, "ResTarget");
    const subLink = exactSubLink(target?.val);
    const reference = scalarCteReference(subLink?.subselect, markers);
    const cte = reference === undefined ? undefined : ctes.get(reference);
    if (
      target === undefined ||
      typeof target.name !== "string" ||
      !hasOnlyKeys(target, new Set(["location", "name", "val"])) ||
      subLink?.subLinkType !== "EXPR_SUBLINK" ||
      cte === undefined ||
      aliases.has(target.name)
    ) {
      return false;
    }
    referenced.add(cte.name);
    aliases.add(target.name);
    hasGuaranteedOneRow ||= cte.guaranteedOneRow;
  }
  return hasGuaranteedOneRow && referenced.size === ctes.size;
}

interface BuilderRelationPolicy {
  readonly allowedLiteralRelations?: ReadonlySet<string>;
  readonly requireTableMarkers: boolean;
}

function builderRelation(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
  policy?: BuilderRelationPolicy,
): boolean {
  const range = rangeVarPayload(value);
  if (range !== undefined) {
    const marker = markers.get(range.relname);
    return (
      validRelationAlias(range.alias) &&
      (marker === undefined
        ? policy?.allowedLiteralRelations === undefined ||
          policy.allowedLiteralRelations.has(range.relname)
        : policy?.requireTableMarkers === true
          ? marker.isTable
          : marker.isWrapper)
    );
  }
  const join = recordProperty(value, "JoinExpr");
  return (
    join !== undefined &&
    (join.jointype === "JOIN_INNER" || join.jointype === "JOIN_LEFT") &&
    join.larg !== undefined &&
    join.rarg !== undefined &&
    join.quals !== undefined &&
    hasOnlyKeys(join, new Set(["jointype", "larg", "quals", "rarg"])) &&
    builderRelation(join.larg, markers, policy) &&
    rangeVarPayload(join.rarg) !== undefined &&
    builderRelation(join.rarg, markers, policy)
  );
}

const BUILDER_READ_SELECT_KEYS = new Set([
  "fromClause",
  "groupClause",
  "limitCount",
  "limitOption",
  "op",
  "sortClause",
  "targetList",
  "whereClause",
  "withClause",
]);

function isBuilderReadSelect(
  select: Record<string, unknown>,
  markers: ReadonlyMap<string, SqlMarker>,
  allowUnionAll: boolean,
  allowWithClause: boolean,
  relationPolicy?: BuilderRelationPolicy,
): boolean {
  if (select.op === "SETOP_UNION") {
    if (
      !allowUnionAll ||
      select.all !== true ||
      !hasOnlyKeys(
        select,
        new Set([
          "all",
          "larg",
          "limitCount",
          "limitOption",
          "op",
          "rarg",
          "sortClause",
          ...(allowWithClause ? ["withClause"] : []),
        ]),
      ) ||
      !isRecord(select.larg) ||
      !isRecord(select.rarg) ||
      (select.sortClause !== undefined &&
        (!Array.isArray(select.sortClause) ||
          select.sortClause.length === 0)) ||
      (select.limitCount === undefined
        ? select.limitOption !== "LIMIT_OPTION_DEFAULT"
        : select.limitOption !== "LIMIT_OPTION_COUNT" ||
          !isSupportedNumericLimit(select.limitCount, markers))
    ) {
      return false;
    }
    return (
      isBuilderReadSelect(select.larg, markers, true, false, relationPolicy) &&
      isBuilderReadSelect(select.rarg, markers, true, false, relationPolicy)
    );
  }
  if (
    select.op !== "SETOP_NONE" ||
    select.limitOption === undefined ||
    !hasOnlyKeys(
      select,
      allowWithClause
        ? BUILDER_READ_SELECT_KEYS
        : new Set(
            [...BUILDER_READ_SELECT_KEYS].filter((key) => {
              return key !== "withClause";
            }),
          ),
    ) ||
    targetValues(select) === undefined ||
    !Array.isArray(select.fromClause) ||
    select.fromClause.length !== 1 ||
    !builderRelation(select.fromClause[0], markers, relationPolicy)
  ) {
    return false;
  }
  if (
    select.groupClause !== undefined &&
    (!Array.isArray(select.groupClause) || select.groupClause.length === 0)
  ) {
    return false;
  }
  if (
    select.sortClause !== undefined &&
    (!Array.isArray(select.sortClause) || select.sortClause.length === 0)
  ) {
    return false;
  }
  return select.limitCount === undefined
    ? select.limitOption === "LIMIT_OPTION_DEFAULT"
    : select.limitOption === "LIMIT_OPTION_COUNT" &&
        isSupportedNumericLimit(select.limitCount, markers);
}

function isBuilderReadCte(
  select: Record<string, unknown>,
  markers: ReadonlyMap<string, SqlMarker>,
  hasLocalExpansion: boolean,
): boolean {
  if (
    ![...markers.values()].every((marker) => {
      return marker.isBoundScalar || marker.isWrapper;
    })
  ) {
    return false;
  }
  const withClause = withClausePayload(select);
  if (withClause === undefined) {
    return false;
  }
  const names = new Set<string>();
  const directRelationPolicy: BuilderRelationPolicy = {
    allowedLiteralRelations: names,
    requireTableMarkers: true,
  };
  for (const item of withClause.ctes) {
    const cte = commonTableExpression(item);
    const body = recordProperty(cte?.ctequery, "SelectStmt");
    if (
      cte === undefined ||
      body === undefined ||
      names.has(cte.ctename) ||
      !isBuilderReadSelect(
        body,
        markers,
        false,
        false,
        hasLocalExpansion ? undefined : directRelationPolicy,
      )
    ) {
      return false;
    }
    names.add(cte.ctename);
  }
  return isBuilderReadSelect(
    select,
    markers,
    true,
    true,
    hasLocalExpansion ? undefined : directRelationPolicy,
  );
}

function isStructuredScalarSelect(
  select: Record<string, unknown>,
  markers: ReadonlyMap<string, SqlMarker>,
): boolean {
  if (
    select.limitOption !== "LIMIT_OPTION_DEFAULT" ||
    select.op !== "SETOP_NONE" ||
    !hasOnlyKeys(select, new Set(["limitOption", "op", "targetList"])) ||
    !Array.isArray(select.targetList) ||
    select.targetList.length !== 1
  ) {
    return false;
  }
  const outerTarget = recordProperty(select.targetList[0], "ResTarget");
  const subLink = exactSubLink(outerTarget?.val);
  const inner = recordProperty(subLink?.subselect, "SelectStmt");
  return (
    outerTarget !== undefined &&
    hasOnlyKeys(outerTarget, new Set(["location", "val"])) &&
    subLink?.subLinkType === "EXPR_SUBLINK" &&
    inner !== undefined &&
    inner.limitOption === "LIMIT_OPTION_COUNT" &&
    inner.op === "SETOP_NONE" &&
    hasOnlyKeys(
      inner,
      new Set([
        "fromClause",
        "limitCount",
        "limitOption",
        "op",
        "targetList",
        "whereClause",
      ]),
    ) &&
    targetValues(inner) !== undefined &&
    Array.isArray(inner.fromClause) &&
    inner.fromClause.length === 1 &&
    builderRelation(inner.fromClause[0], markers, {
      requireTableMarkers: true,
    }) &&
    inner.whereClause !== undefined &&
    isLimitOne(inner.limitCount)
  );
}

function readQueryCapability(
  context: SqlAnalysisContext,
  hasLocalExpansion: boolean,
  parsed: ParsedSql,
): QueryCapability | undefined {
  const select = selectStatement(parsed.statement);
  if (select === undefined) {
    return undefined;
  }
  if (context === "structured-selection") {
    return isStructuredScalarSelect(select, parsed.markers)
      ? "structured-scalar"
      : undefined;
  }
  if (context !== "statement") {
    return undefined;
  }
  if (isBuilderReadCte(select, parsed.markers, hasLocalExpansion)) {
    return "composed-cte";
  }
  if (isScalarCteProjection(select, parsed.markers)) {
    return "scalar-cte";
  }
  if (
    isSupportedLockingSelect(
      select,
      parsed.markers,
      parsed.sourceRanges,
      hasLocalExpansion,
    )
  ) {
    return "locking";
  }
  if (isPaginatedExistsSelect(select, parsed.markers)) {
    return "exists";
  }
  if (isCompleteBuilderSelect(parsed.statement, parsed.markers)) {
    return "select";
  }
  return undefined;
}

const WRITE_RELATION_KEYS = new Set([
  "inh",
  "location",
  "relname",
  "relpersistence",
]);

function writeTargetMarker(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): SqlMarker | undefined {
  if (
    !isRecord(value) ||
    typeof value.relname !== "string" ||
    value.inh !== true ||
    value.relpersistence !== "p" ||
    !hasOnlyKeys(value, WRITE_RELATION_KEYS)
  ) {
    return undefined;
  }
  const marker = markers.get(value.relname);
  // Drizzle aliases and runtime-selected relations are not direct builder
  // targets, so whole-write findings are limited to declared tables.
  return marker?.tableMetadata?.hasDirectDeclaration === true
    ? marker
    : undefined;
}

function writeRangeMarker(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): SqlMarker | undefined {
  const range = recordProperty(value, "RangeVar");
  return range === undefined ? undefined : writeTargetMarker(range, markers);
}

function markerBelongsToTable(
  marker: SqlMarker | undefined,
  table: DrizzleTableMetadata,
): boolean {
  const column = marker?.columnMetadata;
  const tableColumn =
    column === undefined ? undefined : table.columns.get(column.databaseName);
  return (
    marker !== undefined &&
    column !== undefined &&
    column.tableName === table.name &&
    tableColumn !== undefined &&
    tableColumn.propertySymbol === marker.expressionSymbol
  );
}

function sameMarkerSymbol(
  first: SqlMarker | undefined,
  ...rest: readonly (SqlMarker | undefined)[]
): boolean {
  const symbol = first?.expressionSymbol;
  return (
    symbol !== undefined &&
    rest.every((marker) => {
      return marker?.expressionSymbol === symbol;
    })
  );
}

function mappedWritableColumnNames(
  values: unknown,
  table: DrizzleTableMetadata,
  requireValue: boolean,
): readonly string[] | undefined {
  if (!Array.isArray(values) || values.length === 0) {
    return undefined;
  }
  const names = new Set<string>();
  for (const value of values) {
    const target = recordProperty(value, "ResTarget");
    const column =
      typeof target?.name === "string"
        ? table.columns.get(target.name)
        : undefined;
    if (
      target === undefined ||
      typeof target.name !== "string" ||
      (requireValue ? target.val === undefined : target.val !== undefined) ||
      (requireValue &&
        recordProperty(target.val, "MultiAssignRef") !== undefined) ||
      !hasOnlyKeys(
        target,
        requireValue
          ? new Set(["location", "name", "val"])
          : new Set(["location", "name"]),
      ) ||
      column?.isWritable !== true ||
      names.has(target.name)
    ) {
      return undefined;
    }
    names.add(target.name);
  }
  return [...names];
}

function isSupportedWritePredicate(value: unknown): boolean {
  return value !== undefined && !containsNodeKey(value, "CurrentOfExpr");
}

function hasTableColumnOrder(
  names: readonly string[],
  table: DrizzleTableMetadata,
): boolean {
  if (!table.hasSimpleColumnOrder) {
    return false;
  }
  const positions = new Map<string, number>();
  let index = 0;
  for (const name of table.columns.keys()) {
    positions.set(name, index);
    index += 1;
  }
  let previous = -1;
  for (const name of names) {
    const position = positions.get(name);
    if (position === undefined || position <= previous) {
      return false;
    }
    previous = position;
  }
  return true;
}

function hasExactInsertColumnOrder(
  names: readonly string[],
  table: DrizzleTableMetadata,
): boolean {
  if (!table.hasSimpleColumnOrder) {
    return false;
  }
  const emittedNames = [...table.columns.values()].flatMap((column) => {
    return column.isEmittedOnInsert ? [column.databaseName] : [];
  });
  return (
    names.length === emittedNames.length &&
    names.every((name, index) => {
      return name === emittedNames[index];
    })
  );
}

function hasNoPotentialOnUpdateColumns(table: DrizzleTableMetadata): boolean {
  // Drizzle folds `$onUpdate` into `hasDefault` and erases its origin from the
  // built column type. Its update builder eagerly invokes that callback even
  // when an explicit assignment overrides the result, and it can implicitly
  // assign generated or identity columns. No typed builder equivalence can be
  // determined while any column may carry the callback.
  return [...table.columns.values()].every((column) => {
    return !column.hasDefault;
  });
}

function isSingleTargetDelete(
  statement: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): boolean {
  const payload = recordProperty(statement, "stmt");
  const deletion = recordProperty(payload, "DeleteStmt");
  return (
    deletion !== undefined &&
    hasOnlyKeys(deletion, new Set(["relation", "whereClause"])) &&
    writeTargetMarker(deletion.relation, markers) !== undefined &&
    isSupportedWritePredicate(deletion.whereClause)
  );
}

function arrayCastMarker(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): SqlMarker | undefined {
  const cast = recordProperty(value, "TypeCast");
  const typeName = isRecord(cast?.typeName) ? cast.typeName : undefined;
  if (
    cast?.arg === undefined ||
    typeName === undefined ||
    !hasOnlyKeys(cast, new Set(["arg", "location", "typeName"])) ||
    !scalarCastTypeName(typeName) ||
    !Array.isArray(typeName.arrayBounds) ||
    typeName.arrayBounds.length !== 1
  ) {
    return undefined;
  }
  const bound = recordProperty(typeName.arrayBounds[0], "Integer");
  if (
    bound?.ival !== -1 ||
    !hasOnlyKeys(bound, new Set(["ival"])) ||
    !isRecord(typeName.arrayBounds[0]) ||
    !hasOnlyKeys(typeName.arrayBounds[0], new Set(["Integer"]))
  ) {
    return undefined;
  }
  const marker = columnMarker(cast.arg, markers);
  return marker?.isArrayParameter === true ? marker : undefined;
}

function supportedUnnestRelation(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): boolean {
  const range = recordProperty(value, "RangeFunction");
  if (
    range === undefined ||
    !hasOnlyKeys(range, new Set(["alias", "functions"])) ||
    !Array.isArray(range.functions) ||
    range.functions.length !== 1
  ) {
    return false;
  }
  const functionList = recordProperty(range.functions[0], "List");
  if (
    functionList === undefined ||
    !hasOnlyKeys(functionList, new Set(["items"])) ||
    !Array.isArray(functionList.items) ||
    functionList.items.length !== 2 ||
    !isRecord(functionList.items[1]) ||
    !hasOnlyKeys(functionList.items[1], new Set())
  ) {
    return false;
  }
  const call = recordProperty(functionList.items[0], "FuncCall");
  const name = functionName(functionList.items[0]);
  if (
    call === undefined ||
    name?.length !== 1 ||
    name[0]?.toLowerCase() !== "unnest" ||
    call.funcformat !== "COERCE_EXPLICIT_CALL" ||
    !hasOnlyKeys(
      call,
      new Set(["args", "funcformat", "funcname", "location"]),
    ) ||
    !Array.isArray(call.args) ||
    call.args.length === 0 ||
    !call.args.every((argument) => {
      return arrayCastMarker(argument, markers) !== undefined;
    })
  ) {
    return false;
  }
  const alias = isRecord(range.alias) ? range.alias : undefined;
  if (
    alias === undefined ||
    typeof alias.aliasname !== "string" ||
    !hasOnlyKeys(alias, new Set(["aliasname", "colnames"])) ||
    !Array.isArray(alias.colnames) ||
    alias.colnames.length !== call.args.length
  ) {
    return false;
  }
  const columnNames = alias.colnames.map(stringNodeValue);
  return (
    columnNames.every((column): column is string => {
      return column !== undefined;
    }) && new Set(columnNames).size === columnNames.length
  );
}

function isUnnestUpdate(
  statement: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): boolean {
  const payload = recordProperty(statement, "stmt");
  const update = recordProperty(payload, "UpdateStmt");
  if (
    update === undefined ||
    !hasOnlyKeys(
      update,
      new Set(["fromClause", "relation", "targetList", "whereClause"]),
    ) ||
    !isSupportedWritePredicate(update.whereClause) ||
    !Array.isArray(update.fromClause) ||
    update.fromClause.length !== 1
  ) {
    return false;
  }
  const target = writeTargetMarker(update.relation, markers);
  const assignmentNames =
    target?.tableMetadata === undefined
      ? undefined
      : mappedWritableColumnNames(
          update.targetList,
          target.tableMetadata,
          true,
        );
  return (
    target?.tableMetadata !== undefined &&
    assignmentNames !== undefined &&
    hasTableColumnOrder(assignmentNames, target.tableMetadata) &&
    hasNoPotentialOnUpdateColumns(target.tableMetadata) &&
    supportedUnnestRelation(update.fromClause[0], markers)
  );
}

function lockingSortMarker(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): SqlMarker | undefined {
  const sort = recordProperty(value, "SortBy");
  if (
    sort === undefined ||
    (sort.sortby_dir !== "SORTBY_DEFAULT" &&
      sort.sortby_dir !== "SORTBY_ASC" &&
      sort.sortby_dir !== "SORTBY_DESC") ||
    sort.sortby_nulls !== "SORTBY_NULLS_DEFAULT" ||
    !hasOnlyKeys(
      sort,
      new Set(["location", "node", "sortby_dir", "sortby_nulls"]),
    )
  ) {
    return undefined;
  }
  return columnMarker(sort.node, markers);
}

interface LockingCteBody {
  readonly lockTable: SqlMarker;
  readonly orderColumn: SqlMarker;
  readonly selectedColumn: SqlMarker;
  readonly sourceTable: SqlMarker;
}

function lockingCteBody(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): LockingCteBody | undefined {
  const select = recordProperty(value, "SelectStmt");
  if (
    select === undefined ||
    select.limitOption !== "LIMIT_OPTION_DEFAULT" ||
    select.op !== "SETOP_NONE" ||
    select.whereClause === undefined ||
    !hasOnlyKeys(
      select,
      new Set([
        "fromClause",
        "limitOption",
        "lockingClause",
        "op",
        "sortClause",
        "targetList",
        "whereClause",
      ]),
    ) ||
    !Array.isArray(select.targetList) ||
    select.targetList.length !== 1 ||
    !Array.isArray(select.fromClause) ||
    select.fromClause.length !== 1 ||
    !Array.isArray(select.sortClause) ||
    select.sortClause.length !== 1 ||
    !Array.isArray(select.lockingClause) ||
    select.lockingClause.length !== 1
  ) {
    return undefined;
  }
  const selectedTarget = recordProperty(select.targetList[0], "ResTarget");
  const selectedColumn =
    selectedTarget?.val === undefined ||
    !hasOnlyKeys(selectedTarget, new Set(["location", "val"]))
      ? undefined
      : columnMarker(selectedTarget.val, markers);
  const sourceTable = writeRangeMarker(select.fromClause[0], markers);
  const orderColumn = lockingSortMarker(select.sortClause[0], markers);
  const lock = recordProperty(select.lockingClause[0], "LockingClause");
  if (
    lock === undefined ||
    lock.strength !== "LCS_FORUPDATE" ||
    lock.waitPolicy !== "LockWaitBlock" ||
    !hasOnlyKeys(lock, new Set(["lockedRels", "strength", "waitPolicy"])) ||
    !Array.isArray(lock.lockedRels) ||
    lock.lockedRels.length !== 1
  ) {
    return undefined;
  }
  const lockTable = writeRangeMarker(lock.lockedRels[0], markers);
  return selectedColumn !== undefined &&
    sourceTable?.tableMetadata !== undefined &&
    orderColumn !== undefined &&
    lockTable?.tableMetadata !== undefined
    ? { lockTable, orderColumn, selectedColumn, sourceTable }
    : undefined;
}

function exactCteRelation(value: unknown, name: string): boolean {
  const range = recordProperty(value, "RangeVar");
  return (
    range !== undefined &&
    range.relname === name &&
    range.inh === true &&
    range.relpersistence === "p" &&
    hasOnlyKeys(range, WRITE_RELATION_KEYS)
  );
}

function isLockingCteUpdate(
  statement: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): boolean {
  const payload = recordProperty(statement, "stmt");
  const update = recordProperty(payload, "UpdateStmt");
  if (
    update === undefined ||
    !hasOnlyKeys(
      update,
      new Set([
        "fromClause",
        "relation",
        "targetList",
        "whereClause",
        "withClause",
      ]),
    ) ||
    !isSupportedWritePredicate(update.whereClause) ||
    !Array.isArray(update.fromClause) ||
    update.fromClause.length !== 1
  ) {
    return false;
  }
  const targetTable = writeTargetMarker(update.relation, markers);
  const table = targetTable?.tableMetadata;
  const withClause = isRecord(update.withClause)
    ? update.withClause
    : undefined;
  const assignmentNames =
    table === undefined
      ? undefined
      : mappedWritableColumnNames(update.targetList, table, true);
  if (
    table === undefined ||
    withClause === undefined ||
    withClause.recursive === true ||
    !hasOnlyKeys(withClause, new Set(["ctes", "location", "recursive"])) ||
    !Array.isArray(withClause.ctes) ||
    withClause.ctes.length !== 1 ||
    assignmentNames === undefined
  ) {
    return false;
  }
  const cte = commonTableExpression(withClause.ctes[0]);
  const body = lockingCteBody(cte?.ctequery, markers);
  return (
    cte !== undefined &&
    body !== undefined &&
    // PostgreSQL requires an unqualified relation name after `FOR UPDATE OF`,
    // while Drizzle renders schema-backed tables as `"schema"."table"` in
    // both raw interpolation and the locking builder.
    table.schema === undefined &&
    hasTableColumnOrder(assignmentNames, table) &&
    hasNoPotentialOnUpdateColumns(table) &&
    exactCteRelation(update.fromClause[0], cte.ctename) &&
    sameMarkerSymbol(targetTable, body.sourceTable, body.lockTable) &&
    sameMarkerSymbol(body.selectedColumn, body.orderColumn) &&
    markerBelongsToTable(body.selectedColumn, table) &&
    markerBelongsToTable(body.orderColumn, table)
  );
}

function valuesRow(value: unknown): readonly unknown[] | undefined {
  const list = recordProperty(value, "List");
  return list !== undefined &&
    hasOnlyKeys(list, new Set(["items"])) &&
    Array.isArray(list.items)
    ? list.items
    : undefined;
}

function conflictColumnNames(
  value: unknown,
  table: DrizzleTableMetadata,
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const names = new Set<string>();
  for (const item of value) {
    const element = recordProperty(item, "IndexElem");
    if (
      element === undefined ||
      typeof element.name !== "string" ||
      element.ordering !== "SORTBY_DEFAULT" ||
      element.nulls_ordering !== "SORTBY_NULLS_DEFAULT" ||
      !hasOnlyKeys(element, new Set(["name", "nulls_ordering", "ordering"])) ||
      !table.columns.has(element.name) ||
      names.has(element.name)
    ) {
      return undefined;
    }
    names.add(element.name);
  }
  return [...names];
}

function isSingleRowUpsert(
  statement: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
): boolean {
  const payload = recordProperty(statement, "stmt");
  const insert = recordProperty(payload, "InsertStmt");
  if (
    insert === undefined ||
    insert.override !== "OVERRIDING_NOT_SET" ||
    !hasOnlyKeys(
      insert,
      new Set([
        "cols",
        "onConflictClause",
        "override",
        "relation",
        "selectStmt",
      ]),
    )
  ) {
    return false;
  }
  const target = writeTargetMarker(insert.relation, markers);
  const table = target?.tableMetadata;
  const insertColumns =
    table === undefined
      ? undefined
      : mappedWritableColumnNames(insert.cols, table, false);
  const select = recordProperty(insert.selectStmt, "SelectStmt");
  if (
    table === undefined ||
    insertColumns === undefined ||
    select === undefined ||
    select.limitOption !== "LIMIT_OPTION_DEFAULT" ||
    select.op !== "SETOP_NONE" ||
    !hasOnlyKeys(select, new Set(["limitOption", "op", "valuesLists"])) ||
    !Array.isArray(select.valuesLists) ||
    select.valuesLists.length !== 1
  ) {
    return false;
  }
  const values = valuesRow(select.valuesLists[0]);
  if (
    values === undefined ||
    values.length !== insertColumns.length ||
    values.some((value) => {
      return recordProperty(value, "SetToDefault") !== undefined;
    })
  ) {
    return false;
  }
  const conflict = isRecord(insert.onConflictClause)
    ? insert.onConflictClause
    : undefined;
  const inference = isRecord(conflict?.infer) ? conflict.infer : undefined;
  const updateColumns =
    conflict === undefined
      ? undefined
      : mappedWritableColumnNames(conflict.targetList, table, true);
  return (
    conflict !== undefined &&
    conflict.action === "ONCONFLICT_UPDATE" &&
    hasOnlyKeys(
      conflict,
      new Set(["action", "infer", "location", "targetList"]),
    ) &&
    inference !== undefined &&
    hasOnlyKeys(inference, new Set(["indexElems", "location"])) &&
    conflictColumnNames(inference.indexElems, table) !== undefined &&
    updateColumns !== undefined &&
    hasExactInsertColumnOrder(insertColumns, table) &&
    hasTableColumnOrder(updateColumns, table) &&
    hasNoPotentialOnUpdateColumns(table)
  );
}

function writeQueryCapability(parsed: ParsedSql): QueryCapability | undefined {
  // The parser renders each interpolation as one quoted marker. That model is
  // only sound when the runtime value cannot expand into unparsed SQL syntax.
  if (
    ![...parsed.markers.values()].every((marker) => {
      return marker.isAnalyzableWriteInterpolation;
    })
  ) {
    return undefined;
  }
  if (isSingleTargetDelete(parsed.statement, parsed.markers)) {
    return "delete";
  }
  if (isUnnestUpdate(parsed.statement, parsed.markers)) {
    return "unnest-update";
  }
  if (isLockingCteUpdate(parsed.statement, parsed.markers)) {
    return "locking-cte-update";
  }
  return isSingleRowUpsert(parsed.statement, parsed.markers)
    ? "upsert"
    : undefined;
}

function predicateExpression(statement: unknown): unknown {
  return selectStatement(statement)?.whereClause;
}

function selectedExpressions(statement: unknown): readonly unknown[] {
  const select = selectStatement(statement);
  if (!Array.isArray(select?.targetList)) {
    return [];
  }
  return select.targetList.flatMap((item) => {
    const target = recordProperty(item, "ResTarget");
    return target?.val === undefined ? [] : [target.val];
  });
}

function contextOwnsWholeExpression(
  context: "ordering" | "predicate" | "selection",
  statement: unknown,
): boolean {
  const select = selectStatement(statement);
  if (
    select === undefined ||
    select.limitOption !== "LIMIT_OPTION_DEFAULT" ||
    select.op !== "SETOP_NONE" ||
    !Array.isArray(select.targetList) ||
    select.targetList.length !== 1
  ) {
    return false;
  }
  if (context === "selection") {
    const target = recordProperty(select.targetList[0], "ResTarget");
    return (
      Object.keys(select).every((key) => {
        return ["limitOption", "op", "targetList"].includes(key);
      }) &&
      target?.val !== undefined &&
      Object.keys(target).every((key) => {
        return ["location", "val"].includes(key);
      })
    );
  }
  if (!isSelectOneTarget(select.targetList[0])) {
    return false;
  }
  if (context === "predicate") {
    return (
      select.whereClause !== undefined &&
      Object.keys(select).every((key) => {
        return ["limitOption", "op", "targetList", "whereClause"].includes(key);
      })
    );
  }
  return (
    Array.isArray(select.sortClause) &&
    select.sortClause.length === 1 &&
    Object.keys(select).every((key) => {
      return ["limitOption", "op", "sortClause", "targetList"].includes(key);
    })
  );
}

function orderingExpressions(
  statement: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
  sourceRanges: readonly SqlSourceRange[],
): readonly StructuralOrdering[] {
  const select = selectStatement(statement);
  if (!Array.isArray(select?.sortClause)) {
    return [];
  }
  return select.sortClause.flatMap((item) => {
    return structuralOrdering(item, markers, sourceRanges);
  });
}

function structuralOrdering(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
  sourceRanges: readonly SqlSourceRange[],
): readonly StructuralOrdering[] {
  const sort = recordProperty(value, "SortBy");
  if (sort?.node === undefined) {
    return [];
  }
  const expression = structuralExpression(sort.node, markers, sourceRanges);
  const direction =
    sort.sortby_dir === "SORTBY_ASC"
      ? "asc"
      : sort.sortby_dir === "SORTBY_DESC"
        ? "desc"
        : undefined;
  return [
    {
      direction,
      expression,
      hasExplicitNullOrdering:
        sort.sortby_nulls === "SORTBY_NULLS_FIRST" ||
        sort.sortby_nulls === "SORTBY_NULLS_LAST",
      sourceChunks: expression.sourceChunks,
    },
  ];
}

function collectStructuralOrderings(
  value: unknown,
  markers: ReadonlyMap<string, SqlMarker>,
  sourceRanges: readonly SqlSourceRange[],
): readonly StructuralOrdering[] {
  const orderings: StructuralOrdering[] = [];

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
    const ordering = structuralOrdering(current, markers, sourceRanges);
    if (ordering.length > 0) {
      orderings.push(...ordering);
      return;
    }
    for (const child of Object.values(current)) {
      visit(child);
    }
  }

  visit(value);
  return orderings;
}

function structuralExpressionsForContext(
  context: SqlAnalysisContext,
  parsed: ParsedSql,
): readonly StructuralExpression[] {
  if (
    context === "predicate" ||
    context === "optional-predicate" ||
    context === "source-predicate-prefix" ||
    context === "source-where-prefix"
  ) {
    const predicate = predicateExpression(parsed.statement);
    return predicate === undefined
      ? []
      : [structuralExpression(predicate, parsed.markers, parsed.sourceRanges)];
  }
  if (
    context === "selection" ||
    context === "source-selection" ||
    context === "structured-selection" ||
    context === "write-expression"
  ) {
    return selectedExpressions(parsed.statement).map((expression) => {
      return structuralExpression(
        expression,
        parsed.markers,
        parsed.sourceRanges,
      );
    });
  }
  if (context === "relation") {
    const from = selectStatement(parsed.statement)?.fromClause;
    return collectStructuralExpressions(
      from,
      parsed.markers,
      parsed.sourceRanges,
    );
  }
  if (context === "ordering") {
    return orderingExpressions(
      parsed.statement,
      parsed.markers,
      parsed.sourceRanges,
    ).map((ordering) => {
      return ordering.expression;
    });
  }
  return collectStructuralExpressions(
    parsed.statement,
    parsed.markers,
    parsed.sourceRanges,
  );
}

function sameOptionalExpression(
  left: StructuralExpression | undefined,
  right: StructuralExpression | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && sameStructuralExpression(left, right);
}

function sameStructuralExpressions(
  left: readonly StructuralExpression[],
  right: readonly StructuralExpression[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return other !== undefined && sameStructuralExpression(item, other);
    })
  );
}

function sameStructuralOrderings(
  left: readonly StructuralOrdering[],
  right: readonly StructuralOrdering[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        item.direction === other.direction &&
        item.hasExplicitNullOrdering === other.hasExplicitNullOrdering &&
        sameStructuralExpression(item.expression, other.expression)
      );
    })
  );
}

function sameStructuralExpression(
  left: StructuralExpression,
  right: StructuralExpression,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "marker" && right.kind === "marker") {
    return left.marker.chunk === right.marker.chunk;
  }
  if (left.kind === "constant" && right.kind === "constant") {
    return true;
  }
  if (left.kind === "comparison" && right.kind === "comparison") {
    return (
      left.operator === right.operator &&
      sameStructuralExpression(left.left, right.left) &&
      sameStructuralExpression(left.right, right.right)
    );
  }
  if (left.kind === "boolean" && right.kind === "boolean") {
    return (
      left.operator === right.operator &&
      sameStructuralExpressions(left.items, right.items)
    );
  }
  if (left.kind === "null" && right.kind === "null") {
    return (
      left.helper === right.helper &&
      sameStructuralExpression(left.operand, right.operand)
    );
  }
  if (left.kind === "pattern" && right.kind === "pattern") {
    return (
      left.helper === right.helper &&
      sameStructuralExpression(left.left, right.left) &&
      sameStructuralExpression(left.right, right.right) &&
      sameOptionalExpression(left.escape, right.escape)
    );
  }
  if (left.kind === "array" && right.kind === "array") {
    return (
      left.helper === right.helper &&
      sameStructuralExpression(left.left, right.left) &&
      sameStructuralExpression(left.right, right.right)
    );
  }
  if (left.kind === "membership" && right.kind === "membership") {
    return (
      left.helper === right.helper &&
      sameStructuralExpression(left.left, right.left) &&
      sameStructuralExpressions(left.values, right.values)
    );
  }
  if (left.kind === "range" && right.kind === "range") {
    return (
      left.helper === right.helper &&
      sameStructuralExpression(left.left, right.left) &&
      sameStructuralExpression(left.minimum, right.minimum) &&
      sameStructuralExpression(left.maximum, right.maximum)
    );
  }
  if (left.kind === "aggregate" && right.kind === "aggregate") {
    return (
      left.helper === right.helper &&
      left.hasInternalOrdering === right.hasInternalOrdering &&
      left.isDistinct === right.isDistinct &&
      left.isStar === right.isStar &&
      left.isVariadic === right.isVariadic &&
      left.isWindowed === right.isWindowed &&
      sameOptionalExpression(left.argument, right.argument) &&
      sameOptionalExpression(left.filter, right.filter) &&
      sameStructuralOrderings(left.orderings, right.orderings)
    );
  }
  if (left.kind === "existence" && right.kind === "existence") {
    return (
      left.isHandBuiltSelect === right.isHandBuiltSelect &&
      left.selectMarker?.chunk === right.selectMarker?.chunk &&
      sameStructuralExpressions(left.children, right.children)
    );
  }
  return (
    left.kind === "opaque" &&
    right.kind === "opaque" &&
    left.nodeKey === right.nodeKey &&
    sameStructuralExpressions(left.children, right.children)
  );
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

function isWithinCompositionRoot(
  node: TSESTree.Node,
  root: TSESTree.Expression,
): boolean {
  let current: TSESTree.Node | null | undefined = node;
  while (current !== undefined && current !== null) {
    if (current === root) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function compositionBoundariesForChunks(
  chunks: readonly SqlSourceChunk[],
  root: TSESTree.Expression,
): TSESTree.Expression[] {
  const firstChunk = chunks[0];
  if (firstChunk === undefined) {
    return [];
  }
  // A definition can feed multiple SQL contexts with different precedence.
  // Keep replacement ownership at the current use site instead of changing the
  // shared initializer or factory body.
  const commonBoundaries = [
    ...new Set(
      firstChunk.origins.filter((origin): origin is TSESTree.Expression => {
        return (
          isCompositionBoundary(origin) &&
          isWithinCompositionRoot(origin, root) &&
          chunks.every((chunk) => {
            return chunk.origins.includes(origin);
          })
        );
      }),
    ),
  ];
  const callBoundaries = commonBoundaries.filter((boundary) => {
    return boundary.type === AST_NODE_TYPES.CallExpression;
  });
  const identifierBoundaries = commonBoundaries.filter((boundary) => {
    return boundary.type === AST_NODE_TYPES.Identifier;
  });
  const prioritizedBoundaries = new Set<TSESTree.Expression>([
    ...callBoundaries,
    ...identifierBoundaries,
  ]);
  return [
    ...callBoundaries,
    ...identifierBoundaries,
    ...[...commonBoundaries].reverse().filter((boundary) => {
      return !prioritizedBoundaries.has(boundary);
    }),
  ];
}

function commonCompositionBoundaries(
  chunks: readonly SqlSourceChunk[],
  root: TSESTree.Expression,
): TSESTree.Expression[] {
  return compositionBoundariesForChunks(
    chunks.filter((chunk) => {
      return chunk.kind === "expression" || chunk.text.trim() !== "";
    }),
    root,
  );
}

function commonCompositionBoundary(
  variant: SqlSourceVariant,
  root: TSESTree.Expression,
): TSESTree.Expression | undefined {
  return commonCompositionBoundaries(variant.chunks, root)[0];
}

function literalBoundaryNode(
  chunks: ReadonlySet<SqlSourceChunk>,
  root: TSESTree.Expression,
): TSESTree.Expression {
  return commonCompositionBoundaries([...chunks], root)[0] ?? root;
}

function exactExpressionBoundary(
  expression: StructuralExpression,
  variant: SqlSourceVariant,
  root: TSESTree.Expression,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
): TSESTree.Expression | undefined {
  const candidates = commonCompositionBoundaries(
    [...expression.sourceChunks],
    root,
  );
  for (const candidate of candidates) {
    const candidateVariant = {
      chunks: variant.chunks.filter((chunk) => {
        return chunk.origins.includes(candidate);
      }),
    };
    const parsed = parseSqlVariant(
      candidateVariant,
      "selection",
      true,
      checker,
      services,
    );
    if (parsed === null) {
      continue;
    }
    if (!contextOwnsWholeExpression("selection", parsed.statement)) {
      continue;
    }
    const selected = selectedExpressions(parsed.statement);
    if (selected.length !== 1 || selected[0] === undefined) {
      continue;
    }
    const candidateExpression = structuralExpression(
      selected[0],
      parsed.markers,
      parsed.sourceRanges,
    );
    if (sameStructuralExpression(expression, candidateExpression)) {
      return candidate;
    }
  }
  return undefined;
}

function classifyOrdering(
  ordering: StructuralOrdering,
  context: ClassificationContext,
): ExpressionClassification {
  if (ordering.direction === undefined) {
    return classifyExpression(ordering.expression, context);
  }
  const node = operandAnchor(ordering.expression, "wrapper", context);
  if (node === undefined) {
    return classifyExpression(
      ordering.expression,
      nestedClassificationContext(context),
    );
  }
  return {
    anchor: node,
    findings: [
      classifiedFinding(
        ordering.direction,
        node,
        ordering.sourceChunks,
        "ordering",
        ordering.hasExplicitNullOrdering,
      ),
    ],
    isWholeReplacement: !ordering.hasExplicitNullOrdering,
  };
}

function findingSourceProvenance(
  chunks: ReadonlySet<SqlSourceChunk>,
  findingNode: TSESTree.Node,
): {
  readonly sourceKey: string;
  readonly sourceTemplateKey: string;
} {
  const sourceChunks = [...chunks];
  const firstChunk = sourceChunks[0];
  let sourceTemplate: TSESTree.TaggedTemplateExpression | undefined;
  if (firstChunk !== undefined) {
    for (let index = firstChunk.origins.length - 1; index >= 0; index -= 1) {
      const candidate = firstChunk.origins[index];
      if (
        candidate?.type === AST_NODE_TYPES.TaggedTemplateExpression &&
        sourceChunks.every((chunk) => {
          return chunk.origins.includes(candidate);
        })
      ) {
        sourceTemplate = candidate;
        break;
      }
    }
  }
  const origins = [
    ...new Set(
      sourceChunks.flatMap((chunk) => {
        let origin = chunk.origins.at(-1);
        if (sourceTemplate !== undefined) {
          for (let index = chunk.origins.length - 1; index >= 0; index -= 1) {
            const candidate = chunk.origins[index];
            if (
              candidate !== undefined &&
              candidate.range[0] >= sourceTemplate.range[0] &&
              candidate.range[1] <= sourceTemplate.range[1]
            ) {
              origin = candidate;
              break;
            }
          }
        }
        return origin === undefined ||
          origin.type === AST_NODE_TYPES.TemplateElement
          ? []
          : [origin];
      }),
    ),
  ].sort((left, right) => {
    return (
      left.range[0] - right.range[0] ||
      left.range[1] - right.range[1] ||
      left.type.localeCompare(right.type)
    );
  });
  const originKey = origins
    .map((origin) => {
      return `${origin.type}:${origin.range[0]}:${origin.range[1]}`;
    })
    .join("|");
  const sourceTemplateKey =
    sourceTemplate === undefined
      ? ""
      : `${sourceTemplate.type}:${sourceTemplate.range[0]}:${sourceTemplate.range[1]}`;
  return {
    sourceKey:
      originKey === ""
        ? `${sourceTemplateKey}:${findingNode.type}:${findingNode.range[0]}:${findingNode.range[1]}`
        : originKey,
    sourceTemplateKey,
  };
}

function publicFinding(
  finding: ClassifiedHelperFinding,
  sourceLocalEligible: boolean,
): SqlAnalysisFinding {
  const { sourceKey, sourceTemplateKey } = findingSourceProvenance(
    finding.sourceChunks,
    finding.node,
  );
  return finding.kind === "existence-predicate"
    ? {
        helper: finding.helper,
        kind: finding.kind,
        node: finding.node,
        sourceKey,
        sourceLocalEligible,
        sourceTemplateKey,
      }
    : {
        helper: finding.helper,
        kind: finding.kind,
        node: finding.node,
        sourceKey,
        sourceLocalEligible,
        sourceTemplateKey,
      };
}

function sameSourceChunks(
  left: ReadonlySet<SqlSourceChunk>,
  right: ReadonlySet<SqlSourceChunk>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every((chunk) => {
      return right.has(chunk);
    })
  );
}

function replacementBoundaryForFinding(
  finding: ClassifiedHelperFinding,
  variant: SqlSourceVariant,
  root: TSESTree.Expression,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
  capabilities: SqlCapabilityChecks,
  allowsRetainedSqlWrapper: boolean,
): TSESTree.Expression | undefined {
  // A parsed descendant can cross template boundaries because Drizzle inserts
  // nested SQL without parentheses. Reparse each editable boundary in
  // isolation before claiming either a whole replacement or a descendant
  // diagnostic at the current use site.
  const candidates = commonCompositionBoundaries(
    [...finding.sourceChunks],
    root,
  );
  let descendantBoundary: TSESTree.Expression | undefined;
  for (const candidate of candidates) {
    const candidateVariant = {
      chunks: variant.chunks.filter((chunk) => {
        return chunk.origins.includes(candidate);
      }),
    };
    const parsed = parseSqlVariant(
      candidateVariant,
      finding.isolationContext,
      true,
      checker,
      services,
    );
    if (parsed === null) {
      continue;
    }
    if (
      !contextOwnsWholeExpression(finding.isolationContext, parsed.statement)
    ) {
      continue;
    }
    const classificationContext: ClassificationContext = {
      allowsOptionalSql: true,
      allowsRetainedSqlWrapper,
      capabilities,
      checker,
      ownsResultMapping: false,
      root: candidate,
      services,
      variant: candidateVariant,
    };
    const classifications =
      finding.isolationContext === "ordering"
        ? orderingExpressions(
            parsed.statement,
            parsed.markers,
            parsed.sourceRanges,
          ).map((ordering) => {
            return classifyOrdering(ordering, classificationContext);
          })
        : structuralExpressionsForContext(finding.isolationContext, parsed).map(
            (expression) => {
              return classifyExpression(expression, classificationContext);
            },
          );
    const matchingFinding = classifications
      .flatMap((classification) => {
        return classification.findings;
      })
      .find((candidateFinding) => {
        return (
          candidateFinding.kind === finding.kind &&
          candidateFinding.helper === finding.helper &&
          candidateFinding.isolationContext === finding.isolationContext &&
          candidateFinding.isPartial === finding.isPartial &&
          sameSourceChunks(candidateFinding.sourceChunks, finding.sourceChunks)
        );
      });
    if (matchingFinding === undefined) {
      continue;
    }
    const classification = classifications[0];
    if (
      classifications.length === 1 &&
      classification?.isWholeReplacement === true &&
      classification.findings.length === 1 &&
      classification.findings[0] === matchingFinding
    ) {
      return candidate;
    }
    descendantBoundary ??= candidate;
  }
  return descendantBoundary;
}

function analyzeParsed(
  node: TSESTree.Expression,
  context: SqlAnalysisContext,
  hasLocalExpansion: boolean,
  allowsWriteQueryBuilder: boolean,
  parsed: ParsedSql,
  variant: SqlSourceVariant,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
  capabilities: SqlCapabilityChecks,
): SqlAnalysis {
  const queryCapability =
    readQueryCapability(context, hasLocalExpansion, parsed) ??
    (context === "statement" && allowsWriteQueryBuilder
      ? writeQueryCapability(parsed)
      : undefined);
  if (queryCapability !== undefined) {
    return {
      expandedTemplates: new Set(),
      findingSignatures: [
        {
          boundaryIsRoot: true,
          boundaryType: node.type,
          helper: undefined,
          isPartial: false,
          kind: "query-builder",
          ownsResultMapping: false,
          queryCapability,
        },
      ],
      findings: [{ capability: queryCapability, kind: "query-builder", node }],
      hasWholeReplacementBoundary: true,
      isTruePredicate: false,
    };
  }

  const structuralExpressions =
    context === "ordering"
      ? []
      : structuralExpressionsForContext(context, parsed);
  const orderings =
    context === "ordering"
      ? orderingExpressions(
          parsed.statement,
          parsed.markers,
          parsed.sourceRanges,
        )
      : context === "statement" || context === "source-statement"
        ? collectStructuralOrderings(
            parsed.statement,
            parsed.markers,
            parsed.sourceRanges,
          )
        : context === "selection" ||
            context === "source-selection" ||
            context === "structured-selection" ||
            context === "write-expression"
          ? selectedExpressions(parsed.statement).flatMap((expression) => {
              return collectStructuralOrderings(
                expression,
                parsed.markers,
                parsed.sourceRanges,
              );
            })
          : [];
  const ownsResultMapping =
    (context === "selection" ||
      context === "source-selection" ||
      context === "structured-selection") &&
    structuralExpressions.length === 1;
  const classificationContext: ClassificationContext = {
    allowsOptionalSql:
      context === "statement" ||
      context === "source-statement" ||
      context === "source-where-prefix" ||
      context === "optional-predicate" ||
      context === "relation" ||
      capabilities.acceptsOptionalSql(node),
    allowsRetainedSqlWrapper:
      context === "source-predicate-prefix" ||
      context === "source-selection" ||
      context === "source-statement" ||
      context === "source-where-prefix",
    capabilities,
    checker,
    ownsResultMapping,
    root: node,
    services,
    variant,
  };
  const classifications = [
    ...structuralExpressions.map((item) => {
      return classifyExpression(item, classificationContext);
    }),
    ...orderings.map((ordering) => {
      return classifyOrdering(ordering, classificationContext);
    }),
  ];
  const rootClassification =
    classifications.length === 1 ? classifications[0] : undefined;
  const rootFinding = rootClassification?.findings[0];
  const contextOwnsSourceExpression =
    (context === "ordering" ||
      context === "optional-predicate" ||
      context === "predicate" ||
      context === "selection" ||
      context === "source-selection" ||
      context === "structured-selection" ||
      context === "write-expression") &&
    contextOwnsWholeExpression(
      context === "optional-predicate"
        ? "predicate"
        : context === "structured-selection" ||
            context === "source-selection" ||
            context === "write-expression"
          ? "selection"
          : context,
      parsed.statement,
    );
  const canReplaceRoot =
    hasLocalExpansion &&
    contextOwnsSourceExpression &&
    rootClassification?.isWholeReplacement === true &&
    rootClassification.findings.length === 1 &&
    rootFinding !== undefined &&
    !rootFinding.isPartial;
  const replacementBoundary = canReplaceRoot
    ? commonCompositionBoundary(variant, node)
    : undefined;
  const hasWholeReplacementBoundary = replacementBoundary !== undefined;
  const findingEntries = deduplicateFindingEntries(
    classifications.flatMap((classification) => {
      function isSourceLocalEligible(
        finding: ClassifiedHelperFinding,
      ): boolean {
        return (
          (finding.helper !== "and" && finding.helper !== "or") ||
          !(
            contextOwnsSourceExpression &&
            classification === rootClassification &&
            classification.isWholeReplacement &&
            classification.findings.length === 1 &&
            finding === rootFinding
          )
        );
      }

      if (hasWholeReplacementBoundary) {
        return classification.findings.map((finding) => {
          const publicResult = publicFinding(
            {
              ...finding,
              node: replacementBoundary ?? node,
            },
            isSourceLocalEligible(finding),
          );
          return {
            finding: publicResult,
            signature: {
              boundaryIsRoot: publicResult.node === node,
              boundaryType: publicResult.node.type,
              helper: finding.helper,
              isPartial: finding.isPartial,
              kind: finding.kind,
              ownsResultMapping,
              queryCapability: undefined,
            },
          };
        });
      }
      return classification.findings.flatMap((finding) => {
        if (!hasLocalExpansion) {
          const publicResult = publicFinding(
            finding,
            isSourceLocalEligible(finding),
          );
          return [
            {
              finding: publicResult,
              signature: {
                boundaryIsRoot: publicResult.node === node,
                boundaryType: publicResult.node.type,
                helper: finding.helper,
                isPartial: finding.isPartial,
                kind: finding.kind,
                ownsResultMapping,
                queryCapability: undefined,
              },
            },
          ];
        }
        const boundary = replacementBoundaryForFinding(
          finding,
          variant,
          node,
          checker,
          services,
          capabilities,
          classificationContext.allowsRetainedSqlWrapper,
        );
        if (boundary === undefined) {
          return [];
        }
        const publicResult = publicFinding(
          { ...finding, node: boundary },
          isSourceLocalEligible(finding),
        );
        return [
          {
            finding: publicResult,
            signature: {
              boundaryIsRoot: boundary === node,
              boundaryType: boundary.type,
              helper: finding.helper,
              isPartial: finding.isPartial,
              kind: finding.kind,
              ownsResultMapping,
              queryCapability: undefined,
            },
          },
        ];
      });
    }),
  );
  return {
    expandedTemplates: new Set(),
    findingSignatures: findingEntries.map((entry) => {
      return entry.signature;
    }),
    findings: findingEntries.map((entry) => {
      return entry.finding;
    }),
    hasWholeReplacementBoundary,
    isTruePredicate:
      context === "predicate" &&
      contextOwnsWholeExpression(context, parsed.statement) &&
      predicateExpression(parsed.statement) !== undefined &&
      isTrueConstant(predicateExpression(parsed.statement)),
  };
}

function sameAnalysisSignature(left: SqlAnalysis, right: SqlAnalysis): boolean {
  if (
    left.isTruePredicate !== right.isTruePredicate ||
    left.hasWholeReplacementBoundary !== right.hasWholeReplacementBoundary ||
    left.findingSignatures.length !== right.findingSignatures.length
  ) {
    return false;
  }
  return left.findingSignatures.every((finding, index) => {
    const other = right.findingSignatures[index];
    return (
      other !== undefined &&
      finding.boundaryIsRoot === other.boundaryIsRoot &&
      finding.boundaryType === other.boundaryType &&
      finding.helper === other.helper &&
      finding.isPartial === other.isPartial &&
      finding.kind === other.kind &&
      finding.ownsResultMapping === other.ownsResultMapping &&
      finding.queryCapability === other.queryCapability
    );
  });
}

function emptyAnalysis(
  expandedTemplates: ReadonlySet<TSESTree.TaggedTemplateExpression>,
): SqlAnalysis {
  return {
    expandedTemplates,
    findingSignatures: [],
    findings: [],
    hasWholeReplacementBoundary: false,
    isTruePredicate: false,
  };
}

function emptyTemplateFindings(
  variants: readonly SqlSourceVariant[],
  root: TSESTree.Expression,
): readonly SqlAnalysisFinding[] | undefined {
  const boundaries: TSESTree.Expression[] = [];
  for (const variant of variants) {
    if (
      variant.chunks.length === 0 ||
      variant.chunks.some((chunk) => {
        return chunk.kind !== "literal" || chunk.text !== "";
      })
    ) {
      return undefined;
    }
    boundaries.push(
      compositionBoundariesForChunks(variant.chunks, root)[0] ?? root,
    );
  }
  return deduplicateFindings(
    boundaries.map((node) => {
      return { kind: "empty-fragment", node };
    }),
  );
}

const SQL_CAPABILITY_TOKEN =
  /(?:<>|!=|>=|<=|@>|<@|&&|(?<![-=>])=(?!=|>)|(?<![-@>])>|<(?![@=>])|\b(?:AND|ASC|AVG|BETWEEN|COUNT|DESC|EXISTS|ILIKE|IN|IS|LIKE|MAX|MIN|NOT|NULL|OR|SUM|TRUE)\b)/i;
const WRITE_CAPABILITY_TOKEN = /\b(?:DELETE|INSERT|UPDATE)\b/i;

export function sqlTagMightContainHelper(
  node: TSESTree.TaggedTemplateExpression,
): boolean {
  return node.quasi.quasis.some((quasi) => {
    return SQL_CAPABILITY_TOKEN.test(quasi.value.cooked ?? quasi.value.raw);
  });
}

function variantMightContainCapability(
  variant: SqlSourceVariant,
  context: SqlAnalysisContext,
  allowsWriteQueryBuilder: boolean,
): boolean {
  const literalSource = variant.chunks
    .map((chunk) => {
      return chunk.kind === "literal" ? chunk.text : " ";
    })
    .join("");
  return (
    SQL_CAPABILITY_TOKEN.test(literalSource) ||
    ((context === "statement" || context === "structured-selection") &&
      /\bSELECT\b/i.test(literalSource)) ||
    (allowsWriteQueryBuilder && WRITE_CAPABILITY_TOKEN.test(literalSource))
  );
}

function variantMightContainWriteCapability(
  variant: SqlSourceVariant,
): boolean {
  return variant.chunks.some((chunk) => {
    return chunk.kind === "literal" && WRITE_CAPABILITY_TOKEN.test(chunk.text);
  });
}

export function analyzeSql(
  node: TSESTree.Expression,
  context: SqlAnalysisContext,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
  composer: SqlSourceComposer,
  capabilities: SqlCapabilityChecks = NO_CAPABILITY_CHECKS,
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
    const emptyFindings = emptyTemplateFindings(source.variants, node);
    const allowsWriteQueryBuilder =
      context === "statement" &&
      source.variants.some(variantMightContainWriteCapability) &&
      capabilities.allowsWriteQueryBuilder(node, source.expandedTemplates);
    if (emptyFindings !== undefined) {
      analysis = {
        expandedTemplates: source.expandedTemplates,
        findingSignatures: emptyFindings.map((finding) => {
          return {
            boundaryIsRoot: finding.node === node,
            boundaryType: finding.node.type,
            helper: undefined,
            isPartial: false,
            kind: finding.kind,
            ownsResultMapping: false,
            queryCapability: undefined,
          };
        }),
        findings: emptyFindings,
        hasWholeReplacementBoundary: source.hasLocalExpansion,
        isTruePredicate: false,
      };
    } else if (
      !source.variants.some((variant) => {
        return variantMightContainCapability(
          variant,
          context,
          allowsWriteQueryBuilder,
        );
      })
    ) {
      analysis = emptyAnalysis(source.expandedTemplates);
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
            allowsWriteQueryBuilder,
            parsed,
            variant,
            checker,
            services,
            capabilities,
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
          findingSignatures: first.findingSignatures,
          findings: deduplicateFindings(
            variants.flatMap((variant) => {
              return variant.findings;
            }),
          ),
          hasWholeReplacementBoundary: first.hasWholeReplacementBoundary,
          isTruePredicate: first.isTruePredicate,
        };
      }
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

function sourceLocalContext(
  node: TSESTree.TaggedTemplateExpression,
): SqlAnalysisContext {
  const leadingLiteral =
    node.quasi.quasis[0]?.value.cooked ?? node.quasi.quasis[0]?.value.raw ?? "";
  if (/^\s*(?:DELETE|INSERT|SELECT|UPDATE|WITH)\b/iu.test(leadingLiteral)) {
    return "source-statement";
  }
  if (/^\s*WHERE\b/iu.test(leadingLiteral)) {
    return "source-where-prefix";
  }
  if (/^\s*(?:AND|OR)\b/iu.test(leadingLiteral)) {
    return "source-predicate-prefix";
  }
  return "source-selection";
}

export function analyzeSqlSource(
  node: TSESTree.TaggedTemplateExpression,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
  composer: SqlSourceComposer,
  capabilities: SqlCapabilityChecks = NO_CAPABILITY_CHECKS,
): readonly SqlAnalysisFinding[] {
  const context = sourceLocalContext(node);
  const sourceTemplateKey = `${node.type}:${node.range[0]}:${node.range[1]}`;
  return analyzeSql(
    node,
    context,
    checker,
    services,
    composer,
    capabilities,
  ).findings.filter((finding) => {
    if (finding.kind !== "helper" && finding.kind !== "existence-predicate") {
      return false;
    }
    if (finding.sourceTemplateKey !== sourceTemplateKey) {
      return false;
    }
    if (
      context === "source-predicate-prefix" &&
      (finding.helper === "and" || finding.helper === "or")
    ) {
      return false;
    }
    return finding.sourceLocalEligible;
  });
}
