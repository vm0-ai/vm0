import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESTree,
} from "@typescript-eslint/utils";
import {
  isImportDeclaration,
  isImportSpecifier,
  isNamespaceImport,
  isStringLiteral,
  type Node,
} from "typescript";

import {
  isDrizzleColumnType,
  isDrizzleSqlTag,
  isDrizzleTableType,
  isDrizzleWrapperType,
} from "../drizzle.ts";
import {
  SQL_TEMPLATE_EXPRESSION_BOUNDARY,
  sqlCodeMask,
} from "../sql-lexing.ts";
import { createRule } from "../utils.ts";

interface SqlTokenBase {
  readonly end: number;
  readonly start: number;
}

interface ExpressionToken extends SqlTokenBase {
  readonly expressionIndex: number;
  readonly kind: "expression";
}

interface NumberToken extends SqlTokenBase {
  readonly kind: "number";
  readonly value: string;
}

interface PunctuationToken extends SqlTokenBase {
  readonly kind: "punctuation";
  readonly value: "(" | ")" | "," | ";";
}

interface WordToken extends SqlTokenBase {
  readonly kind: "word";
  readonly value: string;
}

type SqlToken = ExpressionToken | NumberToken | PunctuationToken | WordToken;

interface SimpleSelectMatch {
  readonly joinConditionExpressionIndexes: readonly number[];
  readonly joinTableExpressionIndexes: readonly number[];
  readonly selectedColumnExpressionIndex: number;
  readonly sourceTableExpressionIndex: number;
}

const UNSUPPORTED_TOP_LEVEL_WHERE_KEYWORDS = new Set([
  "EXCEPT",
  "FETCH",
  "FOR",
  "GROUP",
  "HAVING",
  "INTERSECT",
  "LIMIT",
  "OFFSET",
  "ORDER",
  "QUALIFY",
  "UNION",
  "WINDOW",
]);

function quasiText(node: TSESTree.TemplateElement): string {
  return node.value.cooked ?? node.value.raw;
}

function memberName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }
  if (node.computed && node.property.type === AST_NODE_TYPES.Literal) {
    return typeof node.property.value === "string" ? node.property.value : null;
  }
  return null;
}

function importSource(node: Node): string | undefined {
  let current: Node | undefined = node;
  while (current !== undefined && !isImportDeclaration(current)) {
    current = current.parent;
  }
  return current !== undefined && isStringLiteral(current.moduleSpecifier)
    ? current.moduleSpecifier.text.replaceAll("\\", "/")
    : undefined;
}

function isRawRowsModule(source: string | undefined): boolean {
  return (
    source !== undefined &&
    /(?:^|\/)lib\/db-raw-rows(?:\.[cm]?[jt]s)?$/.test(source)
  );
}

function topLevelTokens(source: string): readonly SqlToken[] | undefined {
  const tokens: SqlToken[] = [];
  let depth = 0;
  let expressionIndex = 0;
  let offset = 0;

  while (offset < source.length) {
    const character = source[offset];
    if (character === SQL_TEMPLATE_EXPRESSION_BOUNDARY) {
      if (depth === 0) {
        tokens.push({
          kind: "expression",
          expressionIndex,
          start: offset,
          end: offset + 1,
        });
      }
      expressionIndex += 1;
      offset += 1;
      continue;
    }
    if (character === "(") {
      if (depth === 0) {
        tokens.push({
          kind: "punctuation",
          value: "(",
          start: offset,
          end: offset + 1,
        });
      }
      depth += 1;
      offset += 1;
      continue;
    }
    if (character === ")") {
      if (depth === 0) {
        return undefined;
      }
      depth -= 1;
      if (depth === 0) {
        tokens.push({
          kind: "punctuation",
          value: ")",
          start: offset,
          end: offset + 1,
        });
      }
      offset += 1;
      continue;
    }
    if (depth !== 0 || /\s/.test(character ?? "")) {
      offset += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(character ?? "")) {
      const start = offset;
      offset += 1;
      while (/[A-Za-z0-9_$]/.test(source[offset] ?? "")) {
        offset += 1;
      }
      tokens.push({
        kind: "word",
        value: source.slice(start, offset).toUpperCase(),
        start,
        end: offset,
      });
      continue;
    }
    if (/[0-9]/.test(character ?? "")) {
      const start = offset;
      offset += 1;
      while (/[0-9]/.test(source[offset] ?? "")) {
        offset += 1;
      }
      tokens.push({
        kind: "number",
        value: source.slice(start, offset),
        start,
        end: offset,
      });
      continue;
    }
    if (character === "," || character === ";") {
      tokens.push({
        kind: "punctuation",
        value: character,
        start: offset,
        end: offset + 1,
      });
    }
    offset += 1;
  }

  return depth === 0 ? tokens : undefined;
}

function isWord(token: SqlToken | undefined, value: string): boolean {
  return token?.kind === "word" && token.value === value;
}

function expressionIndex(token: SqlToken | undefined): number | undefined {
  return token?.kind === "expression" ? token.expressionIndex : undefined;
}

function simpleSelectMatch(
  source: string,
  syntaxSource: string,
): SimpleSelectMatch | undefined {
  const tokens = topLevelTokens(syntaxSource);
  if (tokens === undefined) {
    return undefined;
  }

  let cursor = 0;
  if (!isWord(tokens[cursor], "SELECT")) {
    return undefined;
  }
  cursor += 1;
  const selectedColumnExpressionIndex = expressionIndex(tokens[cursor]);
  if (selectedColumnExpressionIndex === undefined) {
    return undefined;
  }
  cursor += 1;

  if (isWord(tokens[cursor], "AS")) {
    const aliasKeyword = tokens[cursor];
    cursor += 1;
    if (tokens[cursor]?.kind === "word" && !isWord(tokens[cursor], "FROM")) {
      cursor += 1;
    } else {
      const from = tokens[cursor];
      if (
        aliasKeyword === undefined ||
        from === undefined ||
        !isWord(from, "FROM") ||
        !/^"(?:[^"]|"")+"$/s.test(
          source.slice(aliasKeyword.end, from.start).trim(),
        )
      ) {
        return undefined;
      }
    }
  }

  if (!isWord(tokens[cursor], "FROM")) {
    return undefined;
  }
  cursor += 1;
  const sourceTableExpressionIndex = expressionIndex(tokens[cursor]);
  if (sourceTableExpressionIndex === undefined) {
    return undefined;
  }
  cursor += 1;

  const joinTableExpressionIndexes: number[] = [];
  const joinConditionExpressionIndexes: number[] = [];
  while (isWord(tokens[cursor], "INNER")) {
    cursor += 1;
    if (!isWord(tokens[cursor], "JOIN")) {
      return undefined;
    }
    cursor += 1;
    const joinTableIndex = expressionIndex(tokens[cursor]);
    if (joinTableIndex === undefined) {
      return undefined;
    }
    joinTableExpressionIndexes.push(joinTableIndex);
    cursor += 1;
    if (!isWord(tokens[cursor], "ON")) {
      return undefined;
    }
    cursor += 1;
    const joinConditionIndex = expressionIndex(tokens[cursor]);
    if (joinConditionIndex === undefined) {
      return undefined;
    }
    joinConditionExpressionIndexes.push(joinConditionIndex);
    cursor += 1;
  }

  if (!isWord(tokens[cursor], "WHERE")) {
    return undefined;
  }
  cursor += 1;

  let end = tokens.length;
  const trailingToken = tokens[end - 1];
  if (trailingToken?.kind === "punctuation" && trailingToken.value === ";") {
    end -= 1;
  }
  const limitKeywordIndex = end - 2;
  const limitValue = tokens[limitKeywordIndex + 1];
  if (
    cursor >= limitKeywordIndex ||
    !isWord(tokens[limitKeywordIndex], "LIMIT") ||
    limitValue?.kind !== "number" ||
    limitValue.value !== "1"
  ) {
    return undefined;
  }
  for (let index = cursor; index < limitKeywordIndex; index += 1) {
    const token = tokens[index];
    if (
      token === undefined ||
      (token.kind === "word" &&
        UNSUPPORTED_TOP_LEVEL_WHERE_KEYWORDS.has(token.value)) ||
      (token.kind === "punctuation" && token.value === ";")
    ) {
      return undefined;
    }
  }

  return {
    joinConditionExpressionIndexes,
    joinTableExpressionIndexes,
    selectedColumnExpressionIndex,
    sourceTableExpressionIndex,
  };
}

export const preferDrizzleQueryBuilder = createRule({
  name: "prefer-drizzle-query-builder",
  defaultOptions: [],
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer Drizzle query builders for complete schema-backed simple selects",
      recommended: true,
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      queryBuilder:
        "Use a Drizzle select builder for this complete schema-backed query.",
    },
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const directRawRowsBindings = new Set<string>();
    const rawRowsNamespaces = new Set<string>();

    for (const statement of context.sourceCode.ast.body) {
      if (
        statement.type !== AST_NODE_TYPES.ImportDeclaration ||
        typeof statement.source.value !== "string" ||
        !isRawRowsModule(statement.source.value)
      ) {
        continue;
      }
      for (const specifier of statement.specifiers) {
        if (
          specifier.type === AST_NODE_TYPES.ImportSpecifier &&
          ((specifier.imported.type === AST_NODE_TYPES.Identifier &&
            specifier.imported.name === "executeRawRows") ||
            (specifier.imported.type === AST_NODE_TYPES.Literal &&
              specifier.imported.value === "executeRawRows"))
        ) {
          directRawRowsBindings.add(specifier.local.name);
        } else if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
          rawRowsNamespaces.add(specifier.local.name);
        }
      }
    }

    function isExecuteRawRowsCallee(node: TSESTree.Expression): boolean {
      if (node.type === AST_NODE_TYPES.Identifier) {
        if (!directRawRowsBindings.has(node.name)) {
          return false;
        }
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        const symbol = checker.getSymbolAtLocation(tsNode);
        return (
          symbol?.declarations?.some((declaration) => {
            return (
              isImportSpecifier(declaration) &&
              (declaration.propertyName?.text ?? declaration.name.text) ===
                "executeRawRows" &&
              isRawRowsModule(importSource(declaration))
            );
          }) === true
        );
      }
      if (
        node.type !== AST_NODE_TYPES.MemberExpression ||
        memberName(node) !== "executeRawRows" ||
        node.object.type !== AST_NODE_TYPES.Identifier ||
        !rawRowsNamespaces.has(node.object.name)
      ) {
        return false;
      }
      const tsObject = services.esTreeNodeToTSNodeMap.get(node.object);
      const symbol = checker.getSymbolAtLocation(tsObject);
      return (
        symbol?.declarations?.some((declaration) => {
          return (
            isNamespaceImport(declaration) &&
            isRawRowsModule(importSource(declaration))
          );
        }) === true
      );
    }

    function expressionType(node: TSESTree.Expression) {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return {
        location: tsNode,
        type: checker.getTypeAtLocation(tsNode),
      };
    }

    return {
      CallExpression(node: TSESTree.CallExpression): void {
        if (
          !isExecuteRawRowsCallee(node.callee) ||
          node.arguments.length !== 3 ||
          node.arguments.some((argument) => {
            return argument.type === AST_NODE_TYPES.SpreadElement;
          })
        ) {
          return;
        }
        const query = node.arguments[1];
        if (
          query === undefined ||
          query.type !== AST_NODE_TYPES.TaggedTemplateExpression ||
          !isDrizzleSqlTag(checker, services, query.tag)
        ) {
          return;
        }

        const source = query.quasi.quasis
          .map(quasiText)
          .join(SQL_TEMPLATE_EXPRESSION_BOUNDARY);
        const match = simpleSelectMatch(source, sqlCodeMask(source));
        if (match === undefined) {
          return;
        }

        const selectedColumn =
          query.quasi.expressions[match.selectedColumnExpressionIndex];
        const sourceTable =
          query.quasi.expressions[match.sourceTableExpressionIndex];
        if (selectedColumn === undefined || sourceTable === undefined) {
          return;
        }
        const selectedColumnType = expressionType(selectedColumn);
        const sourceTableType = expressionType(sourceTable);
        if (
          !isDrizzleColumnType(
            checker,
            selectedColumnType.type,
            selectedColumnType.location,
          ) ||
          !isDrizzleTableType(
            checker,
            sourceTableType.type,
            sourceTableType.location,
          ) ||
          !match.joinTableExpressionIndexes.every((index) => {
            const expression = query.quasi.expressions[index];
            if (expression === undefined) {
              return false;
            }
            const expressionValue = expressionType(expression);
            return isDrizzleTableType(
              checker,
              expressionValue.type,
              expressionValue.location,
            );
          }) ||
          !match.joinConditionExpressionIndexes.every((index) => {
            const expression = query.quasi.expressions[index];
            return (
              expression !== undefined &&
              isDrizzleWrapperType(checker, expressionType(expression).type)
            );
          })
        ) {
          return;
        }

        context.report({ node: query, messageId: "queryBuilder" });
      },
    };
  },
});
