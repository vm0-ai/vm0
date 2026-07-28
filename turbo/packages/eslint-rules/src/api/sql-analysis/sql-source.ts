import {
  AST_NODE_TYPES,
  type ParserServicesWithTypeInformation,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";
import {
  canHaveModifiers,
  forEachChild,
  getModifiers,
  isArrayLiteralExpression,
  isAsExpression,
  isCallExpression,
  isConditionalExpression,
  isFunctionDeclaration,
  isIdentifier,
  isNonNullExpression,
  isParenthesizedExpression,
  isReturnStatement,
  isSatisfiesExpression,
  isTemplateSpan,
  isTypeAssertionExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  NodeFlags,
  SyntaxKind,
  type Node,
  type Symbol as TypeScriptSymbol,
  type TypeChecker,
  type VariableDeclaration,
} from "typescript";

import {
  isDrizzleSqlType,
  isDrizzleSqlTag,
  isDrizzleSymbol,
  isStableDrizzleSqlTag,
  resolvedSymbol,
} from "../drizzle.ts";

const MAX_SOURCE_VARIANTS = 16;
const MAX_COMPOSITION_STEPS = 256;

interface SqlLiteralSourceChunk {
  readonly depth: number;
  readonly kind: "literal";
  readonly origins: readonly TSESTree.Node[];
  readonly text: string;
}

interface SqlExpressionSourceChunk {
  readonly depth: number;
  readonly expression: TSESTree.Expression;
  readonly kind: "expression";
  readonly origins: readonly TSESTree.Node[];
}

export type SqlSourceChunk = SqlExpressionSourceChunk | SqlLiteralSourceChunk;

export interface SqlSourceVariant {
  readonly chunks: readonly SqlSourceChunk[];
}

export interface SqlSource {
  readonly expandedTemplates: ReadonlySet<TSESTree.TaggedTemplateExpression>;
  readonly hasLocalExpansion: boolean;
  readonly variants: readonly SqlSourceVariant[];
}

export interface SqlSourceComposer {
  couldCompose(node: TSESTree.Expression): boolean;
  compose(node: TSESTree.Expression): SqlSource | null;
}

interface MutableCompositionState {
  readonly activeDeclarations: Set<Node>;
  steps: number;
  substitutions: ReadonlyMap<TypeScriptSymbol, BoundExpression>;
}

interface MutableCompositionCandidateState {
  readonly activeDeclarations: Set<TSESTree.Node>;
  budgetExceeded: boolean;
  steps: number;
}

interface BoundExpression {
  readonly expression: TSESTree.Expression;
  readonly origins: readonly TSESTree.Node[];
}

interface LocalFunction {
  readonly declaration: Node;
  readonly parameters: readonly TypeScriptSymbol[];
  readonly returned: TSESTree.Expression;
}

type SafeTerminalUse = (node: TSESTree.Expression) => boolean;

function quasiText(node: TSESTree.TemplateElement): string {
  return node.value.cooked ?? node.value.raw;
}

function transparentExpression(
  node: TSESTree.Node,
): TSESTree.Expression | null {
  if (
    node.type === AST_NODE_TYPES.TSAsExpression ||
    node.type === AST_NODE_TYPES.TSTypeAssertion ||
    node.type === AST_NODE_TYPES.TSSatisfiesExpression ||
    node.type === AST_NODE_TYPES.TSNonNullExpression ||
    node.type === AST_NODE_TYPES.ChainExpression
  ) {
    return node.expression;
  }
  return null;
}

function transparentParent(
  node: TSESTree.Expression,
): TSESTree.Expression | null {
  const parent = node.parent;
  if (
    (parent.type === AST_NODE_TYPES.TSAsExpression ||
      parent.type === AST_NODE_TYPES.TSTypeAssertion ||
      parent.type === AST_NODE_TYPES.TSSatisfiesExpression ||
      parent.type === AST_NODE_TYPES.TSNonNullExpression ||
      parent.type === AST_NODE_TYPES.ChainExpression) &&
    parent.expression === node
  ) {
    return parent;
  }
  return null;
}

function isComposableExpression(
  node: TSESTree.Node,
): node is TSESTree.Expression {
  return (
    node.type === AST_NODE_TYPES.ArrayExpression ||
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

function outerTransparentExpression(
  node: TSESTree.Expression,
): TSESTree.Expression {
  let current = node;
  let parent = transparentParent(current);
  while (parent !== null) {
    current = parent;
    parent = transparentParent(current);
  }
  return current;
}

function hasExportModifier(node: Node): boolean {
  return (
    canHaveModifiers(node) &&
    getModifiers(node)?.some((modifier) => {
      return modifier.kind === SyntaxKind.ExportKeyword;
    }) === true
  );
}

function isConstVariable(declaration: VariableDeclaration): boolean {
  return (
    isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & NodeFlags.Const) !== 0
  );
}

function variableIsExported(declaration: VariableDeclaration): boolean {
  return hasExportModifier(declaration.parent.parent);
}

function mergeTemplates(
  left: ReadonlySet<TSESTree.TaggedTemplateExpression>,
  right: ReadonlySet<TSESTree.TaggedTemplateExpression>,
): ReadonlySet<TSESTree.TaggedTemplateExpression> {
  return new Set([...left, ...right]);
}

function emptySource(): SqlSource {
  return {
    expandedTemplates: new Set(),
    hasLocalExpansion: false,
    variants: [{ chunks: [] }],
  };
}

function concatenateSources(
  left: SqlSource,
  right: SqlSource,
): SqlSource | null {
  if (left.variants.length * right.variants.length > MAX_SOURCE_VARIANTS) {
    return null;
  }
  return {
    expandedTemplates: mergeTemplates(
      left.expandedTemplates,
      right.expandedTemplates,
    ),
    hasLocalExpansion: left.hasLocalExpansion || right.hasLocalExpansion,
    variants: left.variants.flatMap((leftVariant) => {
      return right.variants.map((rightVariant) => {
        return {
          chunks: [...leftVariant.chunks, ...rightVariant.chunks],
        };
      });
    }),
  };
}

function combineChoices(left: SqlSource, right: SqlSource): SqlSource | null {
  if (left.variants.length + right.variants.length > MAX_SOURCE_VARIANTS) {
    return null;
  }
  return {
    expandedTemplates: mergeTemplates(
      left.expandedTemplates,
      right.expandedTemplates,
    ),
    hasLocalExpansion: true,
    variants: [...left.variants, ...right.variants],
  };
}

function withLocalExpansion(source: SqlSource): SqlSource {
  return source.hasLocalExpansion
    ? source
    : { ...source, hasLocalExpansion: true };
}

function prependOrigin(source: SqlSource, origin: TSESTree.Node): SqlSource {
  return {
    ...source,
    variants: source.variants.map((variant) => {
      return {
        chunks: variant.chunks.map((chunk) => {
          return { ...chunk, origins: [origin, ...chunk.origins] };
        }),
      };
    }),
  };
}

function incrementDepth(source: SqlSource): SqlSource {
  return {
    ...source,
    variants: source.variants.map((variant) => {
      return {
        chunks: variant.chunks.map((chunk) => {
          return { ...chunk, depth: chunk.depth + 1 };
        }),
      };
    }),
  };
}

function literalChunk(node: TSESTree.TemplateElement): SqlLiteralSourceChunk {
  return {
    depth: 0,
    kind: "literal",
    origins: [node],
    text: quasiText(node),
  };
}

function expressionSource(
  expression: TSESTree.Expression,
  origins: readonly TSESTree.Node[],
): SqlSource {
  return {
    expandedTemplates: new Set(),
    hasLocalExpansion: false,
    variants: [
      {
        chunks: [{ depth: 0, expression, kind: "expression", origins }],
      },
    ],
  };
}

export function createSqlSourceComposer(
  sourceCode: TSESLint.SourceCode,
  checker: TypeChecker,
  services: ParserServicesWithTypeInformation,
  isSafeTerminalUse: SafeTerminalUse,
): SqlSourceComposer {
  const cache = new WeakMap<TSESTree.Expression, SqlSource | null>();
  const compositionCandidateCache = new WeakMap<TSESTree.Expression, boolean>();

  function symbolAt(node: TSESTree.Node): TypeScriptSymbol | undefined {
    const tsNode = services.esTreeNodeToTSNodeMap.get(node);
    return resolvedSymbol(checker, checker.getSymbolAtLocation(tsNode));
  }

  function expressionIsDrizzleSql(node: TSESTree.Expression): boolean {
    const tsNode = services.esTreeNodeToTSNodeMap.get(node);
    return isDrizzleSqlType(checker, checker.getTypeAtLocation(tsNode), tsNode);
  }

  function couldComposeExpression(
    node: TSESTree.Expression,
    state: MutableCompositionCandidateState,
  ): boolean {
    const cached = compositionCandidateCache.get(node);
    if (cached !== undefined) {
      return cached;
    }
    state.steps += 1;
    if (state.steps > MAX_COMPOSITION_STEPS) {
      state.budgetExceeded = true;
      return false;
    }
    const transparent = transparentExpression(node);
    if (transparent !== null) {
      const result = couldComposeExpression(transparent, state);
      if (!state.budgetExceeded) {
        compositionCandidateCache.set(node, result);
      }
      return result;
    }
    if (node.type === AST_NODE_TYPES.TaggedTemplateExpression) {
      compositionCandidateCache.set(node, true);
      return true;
    }
    if (node.type === AST_NODE_TYPES.ConditionalExpression) {
      const result =
        couldComposeExpression(node.consequent, state) ||
        couldComposeExpression(node.alternate, state);
      if (!state.budgetExceeded) {
        compositionCandidateCache.set(node, result);
      }
      return result;
    }
    if (node.type === AST_NODE_TYPES.CallExpression) {
      const localFunctionVariable =
        node.callee.type === AST_NODE_TYPES.Identifier
          ? variableInScope(node.callee)
          : null;
      const result =
        (node.callee.type === AST_NODE_TYPES.MemberExpression &&
          !node.callee.computed &&
          node.callee.property.type === AST_NODE_TYPES.Identifier &&
          (node.callee.property.name === "empty" ||
            node.callee.property.name === "join")) ||
        localFunctionVariable?.defs.some((definition) => {
          return definition.node.type === AST_NODE_TYPES.FunctionDeclaration;
        }) === true;
      if (!state.budgetExceeded) {
        compositionCandidateCache.set(node, result);
      }
      return result;
    }
    if (node.type !== AST_NODE_TYPES.Identifier) {
      compositionCandidateCache.set(node, false);
      return false;
    }
    const variable = variableInScope(node);
    const declaration = variable?.defs.find((definition) => {
      return definition.node.type === AST_NODE_TYPES.VariableDeclarator;
    })?.node;
    if (
      declaration?.type !== AST_NODE_TYPES.VariableDeclarator ||
      declaration.init === null ||
      state.activeDeclarations.has(declaration)
    ) {
      compositionCandidateCache.set(node, false);
      return false;
    }
    const initializer = declaration.init;
    if (!isComposableExpression(initializer)) {
      compositionCandidateCache.set(node, false);
      return false;
    }
    state.activeDeclarations.add(declaration);
    const result = couldComposeExpression(initializer, state);
    state.activeDeclarations.delete(declaration);
    if (!state.budgetExceeded) {
      compositionCandidateCache.set(node, result);
    }
    return result;
  }

  function isCompositionCandidate(node: TSESTree.Expression): boolean {
    const state: MutableCompositionCandidateState = {
      activeDeclarations: new Set(),
      budgetExceeded: false,
      steps: 0,
    };
    return couldComposeExpression(node, state) && !state.budgetExceeded;
  }

  function variableInScope(
    node: TSESTree.Identifier,
  ): TSESLint.Scope.Variable | null {
    let scope: TSESLint.Scope.Scope | null = sourceCode.getScope(node);
    while (scope !== null) {
      const variable = scope.variables.find((candidate) => {
        return candidate.name === node.name;
      });
      if (variable !== undefined) {
        return variable;
      }
      scope = scope.upper;
    }
    return null;
  }

  function drizzleSqlMember(
    node: TSESTree.CallExpression,
    name: "empty" | "join",
  ): boolean {
    if (
      node.callee.type !== AST_NODE_TYPES.MemberExpression ||
      node.callee.computed ||
      node.callee.property.type !== AST_NODE_TYPES.Identifier ||
      node.callee.property.name !== name ||
      !isStableDrizzleSqlTag(checker, services, node.callee.object)
    ) {
      return false;
    }
    const tsProperty = services.esTreeNodeToTSNodeMap.get(node.callee.property);
    return isDrizzleSymbol(checker, checker.getSymbolAtLocation(tsProperty));
  }

  function directCallUse(node: TSESTree.Identifier): boolean {
    const use = outerTransparentExpression(node);
    return (
      use.parent?.type === AST_NODE_TYPES.CallExpression &&
      use.parent.callee === use
    );
  }

  function hasOnlyDirectCallReferences(node: TSESTree.Identifier): boolean {
    const variable = variableInScope(node);
    return (
      variable !== null &&
      variable.references.every((reference) => {
        return (
          reference.init === true ||
          (reference.identifier.type === AST_NODE_TYPES.Identifier &&
            !reference.isWrite() &&
            directCallUse(reference.identifier))
        );
      })
    );
  }

  function hasOnlySubstitutableParameterReferences(
    root: Node,
    parameters: ReadonlySet<TypeScriptSymbol>,
  ): boolean {
    let safe = true;

    function referenceIsSubstitutable(node: Node): boolean {
      let current = node;
      while (
        (isParenthesizedExpression(current.parent) ||
          isAsExpression(current.parent) ||
          isSatisfiesExpression(current.parent) ||
          isTypeAssertionExpression(current.parent) ||
          isNonNullExpression(current.parent)) &&
        current.parent.expression === current
      ) {
        current = current.parent;
      }
      const parent = current.parent;
      return (
        current === root ||
        (isTemplateSpan(parent) && parent.expression === current) ||
        (isCallExpression(parent) &&
          parent.arguments.some((argument) => {
            return argument === current;
          })) ||
        (isArrayLiteralExpression(parent) &&
          parent.elements.some((element) => {
            return element === current;
          })) ||
        (isConditionalExpression(parent) &&
          (parent.whenTrue === current || parent.whenFalse === current))
      );
    }

    function visit(node: Node): void {
      if (!safe) {
        return;
      }
      if (isIdentifier(node)) {
        const symbol = resolvedSymbol(
          checker,
          checker.getSymbolAtLocation(node),
        );
        if (
          symbol !== undefined &&
          parameters.has(symbol) &&
          !referenceIsSubstitutable(node)
        ) {
          safe = false;
          return;
        }
      }
      forEachChild(node, visit);
    }

    visit(root);
    return safe;
  }

  function localFunction(node: TSESTree.CallExpression): LocalFunction | null {
    if (
      node.callee.type !== AST_NODE_TYPES.Identifier ||
      node.arguments.some((argument) => {
        return argument.type === AST_NODE_TYPES.SpreadElement;
      })
    ) {
      return null;
    }
    const tsCallee = services.esTreeNodeToTSNodeMap.get(node.callee);
    const declaration = symbolAt(node.callee)?.valueDeclaration;
    if (
      declaration === undefined ||
      !isFunctionDeclaration(declaration) ||
      declaration.getSourceFile() !== tsCallee.getSourceFile() ||
      declaration.body === undefined ||
      declaration.body.statements.length !== 1 ||
      hasExportModifier(declaration) ||
      declaration.parameters.length !== node.arguments.length
    ) {
      return null;
    }
    if (!hasOnlyDirectCallReferences(node.callee)) {
      return null;
    }
    const parameters: TypeScriptSymbol[] = [];
    for (const parameter of declaration.parameters) {
      if (
        parameter.dotDotDotToken !== undefined ||
        parameter.initializer !== undefined ||
        !isIdentifier(parameter.name)
      ) {
        return null;
      }
      const symbol = resolvedSymbol(
        checker,
        checker.getSymbolAtLocation(parameter.name),
      );
      if (symbol === undefined) {
        return null;
      }
      parameters.push(symbol);
    }
    const statement = declaration.body.statements[0];
    if (
      statement === undefined ||
      !isReturnStatement(statement) ||
      statement.expression === undefined
    ) {
      return null;
    }
    if (
      !hasOnlySubstitutableParameterReferences(
        statement.expression,
        new Set(parameters),
      )
    ) {
      return null;
    }
    const returned = services.tsNodeToESTreeNodeMap.get(statement.expression);
    if (!isComposableExpression(returned) || !expressionIsDrizzleSql(node)) {
      return null;
    }
    return {
      declaration,
      parameters,
      returned,
    };
  }

  function joinCallUsing(
    node: TSESTree.Expression,
  ): TSESTree.CallExpression | null {
    const use = outerTransparentExpression(node);
    const parent = use.parent;
    return parent.type === AST_NODE_TYPES.CallExpression &&
      parent.arguments[0] === use &&
      drizzleSqlMember(parent, "join")
      ? parent
      : null;
  }

  function arrayHasOnlySafeJoinUses(
    node: TSESTree.ArrayExpression,
    activeVariables: Set<TypeScriptSymbol>,
    activeExpressions: Set<TSESTree.Expression>,
  ): boolean {
    const directJoin = joinCallUsing(node);
    if (directJoin !== null) {
      return isSafeComposedValueUse(
        directJoin,
        activeVariables,
        activeExpressions,
      );
    }
    const use = outerTransparentExpression(node);
    if (
      use.parent.type !== AST_NODE_TYPES.VariableDeclarator ||
      use.parent.init !== use ||
      use.parent.id.type !== AST_NODE_TYPES.Identifier
    ) {
      return false;
    }
    const declaration = symbolAt(use.parent.id)?.valueDeclaration;
    if (
      declaration === undefined ||
      !isVariableDeclaration(declaration) ||
      !isConstVariable(declaration) ||
      variableIsExported(declaration)
    ) {
      return false;
    }
    const variable = variableInScope(use.parent.id);
    return (
      variable !== null &&
      variable.references.every((reference) => {
        if (reference.init === true) {
          return true;
        }
        const identifier = reference.identifier;
        if (
          identifier.type !== AST_NODE_TYPES.Identifier ||
          reference.isWrite()
        ) {
          return false;
        }
        const join = joinCallUsing(identifier);
        return (
          join !== null &&
          isSafeComposedValueUse(join, activeVariables, activeExpressions)
        );
      })
    );
  }

  function isSafeComposedValueUse(
    node: TSESTree.Expression,
    activeVariables: Set<TypeScriptSymbol>,
    activeExpressions: Set<TSESTree.Expression>,
  ): boolean {
    const use = outerTransparentExpression(node);
    if (activeExpressions.has(use)) {
      return false;
    }
    activeExpressions.add(use);
    let safe = false;
    if (isSafeTerminalUse(use)) {
      safe = true;
    } else {
      const parent = use.parent;
      if (
        parent.type === AST_NODE_TYPES.TemplateLiteral &&
        parent.expressions.includes(use) &&
        parent.parent.type === AST_NODE_TYPES.TaggedTemplateExpression &&
        isDrizzleSqlTag(checker, services, parent.parent.tag)
      ) {
        safe = isSafeComposedValueUse(
          parent.parent,
          activeVariables,
          activeExpressions,
        );
      } else if (
        parent.type === AST_NODE_TYPES.ConditionalExpression &&
        (parent.consequent === use || parent.alternate === use)
      ) {
        safe = isSafeComposedValueUse(
          parent,
          activeVariables,
          activeExpressions,
        );
      } else if (
        parent.type === AST_NODE_TYPES.ArrayExpression &&
        parent.elements.includes(use)
      ) {
        safe = arrayHasOnlySafeJoinUses(
          parent,
          activeVariables,
          activeExpressions,
        );
      } else if (
        parent.type === AST_NODE_TYPES.CallExpression &&
        parent.arguments.includes(use) &&
        (drizzleSqlMember(parent, "join") || localFunction(parent) !== null)
      ) {
        safe = isSafeComposedValueUse(
          parent,
          activeVariables,
          activeExpressions,
        );
      } else if (
        parent.type === AST_NODE_TYPES.VariableDeclarator &&
        parent.init === use &&
        parent.id.type === AST_NODE_TYPES.Identifier
      ) {
        const declaration = symbolAt(parent.id)?.valueDeclaration;
        safe =
          declaration !== undefined &&
          isVariableDeclaration(declaration) &&
          isConstVariable(declaration) &&
          !variableIsExported(declaration) &&
          hasOnlySafeConstReferences(parent.id, activeVariables);
      }
    }
    activeExpressions.delete(use);
    return safe;
  }

  function isSafeCompositionReference(
    node: TSESTree.Identifier,
    activeVariables: Set<TypeScriptSymbol>,
  ): boolean {
    return isSafeComposedValueUse(node, activeVariables, new Set());
  }

  function hasOnlySafeConstReferences(
    node: TSESTree.Identifier,
    activeVariables: Set<TypeScriptSymbol> = new Set(),
  ): boolean {
    const symbol = symbolAt(node);
    if (symbol === undefined || activeVariables.has(symbol)) {
      return false;
    }
    const variable = variableInScope(node);
    activeVariables.add(symbol);
    const safe =
      variable !== null &&
      variable.references.every((reference) => {
        return (
          reference.init === true ||
          (reference.identifier.type === AST_NODE_TYPES.Identifier &&
            !reference.isWrite() &&
            (reference.identifier === node ||
              isSafeCompositionReference(
                reference.identifier,
                activeVariables,
              )))
        );
      });
    activeVariables.delete(symbol);
    return safe;
  }

  function localConstInitializer(node: TSESTree.Identifier): {
    readonly declaration: Node;
    readonly initializer: TSESTree.Expression;
  } | null {
    const tsNode = services.esTreeNodeToTSNodeMap.get(node);
    const declaration = symbolAt(node)?.valueDeclaration;
    if (
      declaration === undefined ||
      !isVariableDeclaration(declaration) ||
      declaration.getSourceFile() !== tsNode.getSourceFile() ||
      !isConstVariable(declaration) ||
      variableIsExported(declaration) ||
      declaration.initializer === undefined ||
      !hasOnlySafeConstReferences(node)
    ) {
      return null;
    }
    const initializer = services.tsNodeToESTreeNodeMap.get(
      declaration.initializer,
    );
    return isComposableExpression(initializer)
      ? { declaration, initializer }
      : null;
  }

  function consumeStep(state: MutableCompositionState): boolean {
    state.steps += 1;
    return state.steps <= MAX_COMPOSITION_STEPS;
  }

  function resolvedExpression(
    node: TSESTree.Expression,
    state: MutableCompositionState,
  ): BoundExpression {
    let expression = node;
    const origins: TSESTree.Node[] = [node];
    const visited = new Set<TypeScriptSymbol>();
    while (expression.type === AST_NODE_TYPES.Identifier) {
      const symbol = symbolAt(expression);
      if (symbol === undefined || visited.has(symbol)) {
        break;
      }
      const substitution = state.substitutions.get(symbol);
      if (substitution === undefined) {
        break;
      }
      visited.add(symbol);
      origins.push(...substitution.origins);
      expression = substitution.expression;
    }
    return { expression, origins };
  }

  function composeInterpolation(
    node: TSESTree.Expression,
    state: MutableCompositionState,
  ): SqlSource | null {
    const resolved = resolvedExpression(node, state);
    const nested = composeExpression(resolved.expression, state);
    if (nested !== null) {
      return withLocalExpansion(prependOrigin(incrementDepth(nested), node));
    }
    return expressionSource(resolved.expression, resolved.origins);
  }

  function composeJoinedChunk(
    node: TSESTree.Expression,
    state: MutableCompositionState,
  ): SqlSource | null {
    const resolved = resolvedExpression(node, state);
    const nested = composeExpression(resolved.expression, state);
    return nested === null
      ? expressionSource(resolved.expression, resolved.origins)
      : withLocalExpansion(prependOrigin(nested, node));
  }

  function composeTemplate(
    node: TSESTree.TaggedTemplateExpression,
    state: MutableCompositionState,
  ): SqlSource | null {
    if (!isDrizzleSqlTag(checker, services, node.tag)) {
      return null;
    }
    const first = node.quasi.quasis[0];
    if (first === undefined) {
      return null;
    }
    const expandedTemplates = new Set<TSESTree.TaggedTemplateExpression>([
      node,
    ]);
    let hasLocalExpansion = false;
    let variantChunks: SqlSourceChunk[][] = [[literalChunk(first)]];
    for (let index = 0; index < node.quasi.expressions.length; index += 1) {
      const expression = node.quasi.expressions[index];
      const following = node.quasi.quasis[index + 1];
      if (expression === undefined || following === undefined) {
        return null;
      }
      const interpolation = composeInterpolation(expression, state);
      if (interpolation === null) {
        return null;
      }
      if (
        variantChunks.length * interpolation.variants.length >
        MAX_SOURCE_VARIANTS
      ) {
        return null;
      }
      for (const template of interpolation.expandedTemplates) {
        expandedTemplates.add(template);
      }
      hasLocalExpansion ||= interpolation.hasLocalExpansion;
      const followingChunk = literalChunk(following);
      const onlyChunks = variantChunks[0];
      const onlyInterpolation = interpolation.variants[0];
      if (
        variantChunks.length === 1 &&
        interpolation.variants.length === 1 &&
        onlyChunks !== undefined &&
        onlyInterpolation !== undefined
      ) {
        onlyChunks.push(...onlyInterpolation.chunks, followingChunk);
      } else {
        variantChunks = variantChunks.flatMap((chunks) => {
          return interpolation.variants.map((variant) => {
            return [...chunks, ...variant.chunks, followingChunk];
          });
        });
      }
    }
    return prependOrigin(
      {
        expandedTemplates,
        hasLocalExpansion,
        variants: variantChunks.map((chunks) => {
          return { chunks };
        }),
      },
      node,
    );
  }

  function staticArray(node: TSESTree.Expression): {
    readonly declaration: Node | undefined;
    readonly node: TSESTree.ArrayExpression;
  } | null {
    let current = node;
    let transparent = transparentExpression(current);
    while (transparent !== null) {
      current = transparent;
      transparent = transparentExpression(current);
    }
    if (current.type === AST_NODE_TYPES.ArrayExpression) {
      return { declaration: undefined, node: current };
    }
    if (current.type !== AST_NODE_TYPES.Identifier) {
      return null;
    }
    const initializer = localConstInitializer(current);
    if (initializer === null) {
      return null;
    }
    let value = initializer.initializer;
    let wrapper = transparentExpression(value);
    while (wrapper !== null) {
      value = wrapper;
      wrapper = transparentExpression(value);
    }
    return value.type === AST_NODE_TYPES.ArrayExpression
      ? { declaration: initializer.declaration, node: value }
      : null;
  }

  function composeJoin(
    node: TSESTree.CallExpression,
    state: MutableCompositionState,
  ): SqlSource | null {
    if (
      !drizzleSqlMember(node, "join") ||
      (node.arguments.length !== 1 && node.arguments.length !== 2) ||
      node.arguments.some((argument) => {
        return argument.type === AST_NODE_TYPES.SpreadElement;
      })
    ) {
      return null;
    }
    const itemsArgument = node.arguments[0];
    if (
      itemsArgument === undefined ||
      itemsArgument.type === AST_NODE_TYPES.SpreadElement
    ) {
      return null;
    }
    const array = staticArray(itemsArgument);
    if (
      array === null ||
      array.node.elements.some((element) => {
        return (
          element === null || element.type === AST_NODE_TYPES.SpreadElement
        );
      }) ||
      (array.declaration !== undefined &&
        state.activeDeclarations.has(array.declaration))
    ) {
      return null;
    }

    if (array.declaration !== undefined) {
      state.activeDeclarations.add(array.declaration);
    }
    const separatorArgument = node.arguments[1];
    if (separatorArgument?.type === AST_NODE_TYPES.SpreadElement) {
      if (array.declaration !== undefined) {
        state.activeDeclarations.delete(array.declaration);
      }
      return null;
    }
    const separator =
      separatorArgument === undefined
        ? emptySource()
        : composeJoinedChunk(separatorArgument, state);
    if (separator === null) {
      if (array.declaration !== undefined) {
        state.activeDeclarations.delete(array.declaration);
      }
      return null;
    }

    let result = emptySource();
    for (let index = 0; index < array.node.elements.length; index += 1) {
      const element = array.node.elements[index];
      if (element === null || element.type === AST_NODE_TYPES.SpreadElement) {
        if (array.declaration !== undefined) {
          state.activeDeclarations.delete(array.declaration);
        }
        return null;
      }
      if (index > 0) {
        const withSeparator = concatenateSources(result, separator);
        if (withSeparator === null) {
          if (array.declaration !== undefined) {
            state.activeDeclarations.delete(array.declaration);
          }
          return null;
        }
        result = withSeparator;
      }
      const item = composeJoinedChunk(element, state);
      if (item === null) {
        if (array.declaration !== undefined) {
          state.activeDeclarations.delete(array.declaration);
        }
        return null;
      }
      const withItem = concatenateSources(result, item);
      if (withItem === null) {
        if (array.declaration !== undefined) {
          state.activeDeclarations.delete(array.declaration);
        }
        return null;
      }
      result = withItem;
    }
    if (array.declaration !== undefined) {
      state.activeDeclarations.delete(array.declaration);
    }
    return withLocalExpansion(prependOrigin(result, node));
  }

  function composeFactory(
    node: TSESTree.CallExpression,
    state: MutableCompositionState,
  ): SqlSource | null {
    const factory = localFunction(node);
    if (factory === null || state.activeDeclarations.has(factory.declaration)) {
      return null;
    }
    const substitutions = new Map(state.substitutions);
    for (let index = 0; index < factory.parameters.length; index += 1) {
      const parameter = factory.parameters[index];
      const argument = node.arguments[index];
      if (
        parameter === undefined ||
        argument === undefined ||
        argument.type === AST_NODE_TYPES.SpreadElement
      ) {
        return null;
      }
      substitutions.set(parameter, {
        expression: argument,
        origins: [node, argument],
      });
    }
    state.activeDeclarations.add(factory.declaration);
    const previousSubstitutions = state.substitutions;
    state.substitutions = substitutions;
    const result = composeExpression(factory.returned, state);
    state.substitutions = previousSubstitutions;
    state.activeDeclarations.delete(factory.declaration);
    return result === null
      ? null
      : withLocalExpansion(prependOrigin(result, node));
  }

  function composeAlias(
    node: TSESTree.Identifier,
    state: MutableCompositionState,
  ): SqlSource | null {
    if (!expressionIsDrizzleSql(node)) {
      return null;
    }
    const local = localConstInitializer(node);
    if (local === null || state.activeDeclarations.has(local.declaration)) {
      return null;
    }
    state.activeDeclarations.add(local.declaration);
    const result = composeExpression(local.initializer, state);
    state.activeDeclarations.delete(local.declaration);
    return result === null
      ? null
      : withLocalExpansion(prependOrigin(result, node));
  }

  function composeExpression(
    node: TSESTree.Expression,
    state: MutableCompositionState,
  ): SqlSource | null {
    if (!consumeStep(state)) {
      return null;
    }
    const resolved = resolvedExpression(node, state);
    if (resolved.expression !== node) {
      const substituted = composeExpression(resolved.expression, state);
      return substituted === null ? null : prependOrigin(substituted, node);
    }
    const transparent = transparentExpression(node);
    if (transparent !== null) {
      const result = composeExpression(transparent, state);
      return result === null ? null : prependOrigin(result, node);
    }
    if (state.substitutions.size === 0 && !isCompositionCandidate(node)) {
      return null;
    }
    if (node.type === AST_NODE_TYPES.TaggedTemplateExpression) {
      return composeTemplate(node, state);
    }
    if (node.type === AST_NODE_TYPES.Identifier) {
      return composeAlias(node, state);
    }
    if (node.type === AST_NODE_TYPES.ConditionalExpression) {
      const consequent = composeExpression(node.consequent, state);
      const alternate = composeExpression(node.alternate, state);
      if (consequent === null || alternate === null) {
        return null;
      }
      const choices = combineChoices(
        prependOrigin(consequent, node.consequent),
        prependOrigin(alternate, node.alternate),
      );
      return choices === null ? null : prependOrigin(choices, node);
    }
    if (node.type !== AST_NODE_TYPES.CallExpression) {
      return null;
    }
    if (drizzleSqlMember(node, "empty") && node.arguments.length === 0) {
      return withLocalExpansion(prependOrigin(emptySource(), node));
    }
    return composeJoin(node, state) ?? composeFactory(node, state);
  }

  return {
    couldCompose(node: TSESTree.Expression): boolean {
      return isCompositionCandidate(node);
    },
    compose(node: TSESTree.Expression): SqlSource | null {
      if (cache.has(node)) {
        return cache.get(node) ?? null;
      }
      const state: MutableCompositionState = {
        activeDeclarations: new Set(),
        steps: 0,
        substitutions: new Map(),
      };
      const source = composeExpression(node, state);
      cache.set(node, source);
      return source;
    },
  };
}
