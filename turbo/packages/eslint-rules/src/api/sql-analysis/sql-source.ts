import {
  AST_NODE_TYPES,
  type ParserServicesWithTypeInformation,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";
import {
  forEachChild,
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
  isVariableStatement,
  NodeFlags,
  TypeFlags,
  type Node,
  type Symbol as TypeScriptSymbol,
  type Type,
  type TypeChecker,
  type VariableDeclaration,
} from "typescript";

import {
  isDefinitelyPresentDrizzleBooleanHelper,
  isDrizzleSqlType,
  isDrizzleSqlTag,
  isDrizzleSymbol,
  resolvedSymbol,
} from "../drizzle.ts";

// These limits protect ESLint termination; they do not expand the supported
// syntax beyond the conventional composition forms modeled below.
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

interface StaticArray {
  readonly declarations: ReadonlySet<Node>;
  readonly node: TSESTree.ArrayExpression;
}

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

function isConstVariable(declaration: VariableDeclaration): boolean {
  return (
    isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & NodeFlags.Const) !== 0
  );
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
      !isDrizzleSqlTag(checker, services, node.callee.object)
    ) {
      return false;
    }
    const tsProperty = services.esTreeNodeToTSNodeMap.get(node.callee.property);
    return isDrizzleSymbol(checker, checker.getSymbolAtLocation(tsProperty));
  }

  function parametersAppearInComposablePositions(
    root: Node,
    parameters: ReadonlySet<TypeScriptSymbol>,
  ): boolean {
    let composable = true;

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
      if (!composable) {
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
          composable = false;
          return;
        }
      }
      forEachChild(node, visit);
    }

    visit(root);
    return composable;
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
      declaration.body.statements.length === 0 ||
      declaration.parameters.length !== node.arguments.length
    ) {
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
    const statements = declaration.body.statements;
    const statement = statements[statements.length - 1];
    if (
      statement === undefined ||
      !isReturnStatement(statement) ||
      statement.expression === undefined
    ) {
      return null;
    }
    // Model only the conventional straight-line helper shape. Mutation,
    // control flow, destructuring, and non-final returns remain opaque.
    const localInitializers: Node[] = [];
    for (const leadingStatement of statements.slice(0, -1)) {
      if (
        !isVariableStatement(leadingStatement) ||
        (leadingStatement.declarationList.flags & NodeFlags.Const) === 0 ||
        leadingStatement.declarationList.declarations.length === 0
      ) {
        return null;
      }
      for (const localDeclaration of leadingStatement.declarationList
        .declarations) {
        if (
          !isIdentifier(localDeclaration.name) ||
          localDeclaration.initializer === undefined
        ) {
          return null;
        }
        const initializer = services.tsNodeToESTreeNodeMap.get(
          localDeclaration.initializer,
        );
        if (!isComposableExpression(initializer)) {
          return null;
        }
        localInitializers.push(localDeclaration.initializer);
      }
    }
    const parameterSet = new Set(parameters);
    if (
      [...localInitializers, statement.expression].some((expression) => {
        return !parametersAppearInComposablePositions(expression, parameterSet);
      })
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

  function localStaticArrayFactory(node: TSESTree.CallExpression): {
    readonly declaration: Node;
    readonly returned: TSESTree.ArrayExpression;
  } | null {
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
      declaration.parameters.length !== node.arguments.length ||
      declaration.parameters.some((parameter) => {
        return (
          parameter.dotDotDotToken !== undefined ||
          parameter.initializer !== undefined ||
          !isIdentifier(parameter.name)
        );
      })
    ) {
      return null;
    }
    const statement = declaration.body.statements[0];
    if (
      statement === undefined ||
      !isReturnStatement(statement) ||
      statement.expression === undefined
    ) {
      return null;
    }
    let returned = services.tsNodeToESTreeNodeMap.get(statement.expression);
    let transparent = transparentExpression(returned);
    while (transparent !== null) {
      returned = transparent;
      transparent = transparentExpression(returned);
    }
    return returned.type === AST_NODE_TYPES.ArrayExpression
      ? { declaration, returned }
      : null;
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
      declaration.initializer === undefined
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

  function typeMayBeUndefined(type: Type): boolean {
    if ((type.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0) {
      return true;
    }
    if ((type.flags & TypeFlags.TypeParameter) !== 0) {
      const constraint = checker.getBaseConstraintOfType(type);
      return constraint === undefined || typeMayBeUndefined(constraint);
    }
    if (type.isUnion()) {
      return type.types.some(typeMayBeUndefined);
    }
    return (type.flags & (TypeFlags.Undefined | TypeFlags.Void)) !== 0;
  }

  function expressionIsDefinitelyPresent(
    node: TSESTree.Expression,
    state: MutableCompositionState,
  ): boolean {
    const resolved = resolvedExpression(node, state);
    let expression = resolved.expression;
    let transparent = transparentExpression(expression);
    while (transparent !== null) {
      expression = transparent;
      transparent = transparentExpression(expression);
    }
    const tsNode = services.esTreeNodeToTSNodeMap.get(expression);
    if (!typeMayBeUndefined(checker.getTypeAtLocation(tsNode))) {
      return true;
    }
    return isDefinitelyPresentDrizzleBooleanHelper(
      checker,
      services,
      expression,
    );
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

  function staticArray(
    node: TSESTree.Expression,
    state: MutableCompositionState,
    visited: ReadonlySet<Node> = new Set(),
  ): StaticArray | null {
    if (!consumeStep(state)) {
      return null;
    }
    let current = node;
    let transparent = transparentExpression(current);
    while (transparent !== null) {
      current = transparent;
      transparent = transparentExpression(current);
    }
    if (current.type === AST_NODE_TYPES.ArrayExpression) {
      return { declarations: new Set(), node: current };
    }
    if (current.type === AST_NODE_TYPES.Identifier) {
      const initializer = localConstInitializer(current);
      if (initializer === null || visited.has(initializer.declaration)) {
        return null;
      }
      const nested = staticArray(
        initializer.initializer,
        state,
        new Set([...visited, initializer.declaration]),
      );
      return nested === null
        ? null
        : {
            declarations: new Set([
              initializer.declaration,
              ...nested.declarations,
            ]),
            node: nested.node,
          };
    }
    if (current.type !== AST_NODE_TYPES.CallExpression) {
      return null;
    }
    const factory = localStaticArrayFactory(current);
    return factory === null || visited.has(factory.declaration)
      ? null
      : {
          declarations: new Set([factory.declaration]),
          node: factory.returned,
        };
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
    const array = staticArray(itemsArgument, state);
    if (array === null) {
      return null;
    }
    const elements = array.node.elements;
    if (
      elements.some((element) => {
        return (
          element === null ||
          element.type === AST_NODE_TYPES.SpreadElement ||
          !expressionIsDefinitelyPresent(element, state)
        );
      }) ||
      [...array.declarations].some((declaration) => {
        return state.activeDeclarations.has(declaration);
      })
    ) {
      return null;
    }
    const separatorArgument = node.arguments[1];
    if (
      separatorArgument?.type === AST_NODE_TYPES.SpreadElement ||
      (separatorArgument !== undefined &&
        !expressionIsDefinitelyPresent(separatorArgument, state))
    ) {
      return null;
    }
    for (const declaration of array.declarations) {
      state.activeDeclarations.add(declaration);
    }

    try {
      const separator =
        separatorArgument === undefined
          ? emptySource()
          : composeJoinedChunk(separatorArgument, state);
      if (separator === null) {
        return null;
      }

      let result = emptySource();
      for (let index = 0; index < elements.length; index += 1) {
        const element = elements[index];
        if (element === null || element.type === AST_NODE_TYPES.SpreadElement) {
          return null;
        }
        if (index > 0) {
          const withSeparator = concatenateSources(result, separator);
          if (withSeparator === null) {
            return null;
          }
          result = withSeparator;
        }
        const item = composeJoinedChunk(element, state);
        if (item === null) {
          return null;
        }
        const withItem = concatenateSources(result, item);
        if (withItem === null) {
          return null;
        }
        result = withItem;
      }
      return withLocalExpansion(prependOrigin(result, node));
    } finally {
      for (const declaration of array.declarations) {
        state.activeDeclarations.delete(declaration);
      }
    }
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
