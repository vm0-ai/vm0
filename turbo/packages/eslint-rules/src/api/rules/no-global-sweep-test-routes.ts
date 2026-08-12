import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import {
  importReference,
  memberName,
  propertyName,
  unwrapExpression,
  variableInScope,
} from "../syntax.ts";
import { createRule } from "../utils.ts";

interface GlobalSweepBoundary {
  readonly exportName: string;
  readonly moduleName: string;
  readonly path: string;
}

const GLOBAL_SWEEP_BOUNDARIES: readonly GlobalSweepBoundary[] = [
  {
    exportName: "cronCleanupSandboxesRoutes",
    moduleName: "cron-cleanup-sandboxes",
    path: "/api/cron/cleanup-sandboxes",
  },
  {
    exportName: "cronReconcileBillingEntitlementsRoutes",
    moduleName: "cron-reconcile-billing-entitlements",
    path: "/api/cron/reconcile-billing-entitlements",
  },
  {
    exportName: "cronDrainEmailOutboxRoutes",
    moduleName: "cron-drain-email-outbox",
    path: "/api/cron/drain-email-outbox",
  },
  {
    exportName: "cronBrowserReconcileRoutes",
    moduleName: "cron-browser-reconcile",
    path: "/api/cron/reconcile-browsers",
  },
  {
    exportName: "cronConnectorOauthStateCleanupRoutes",
    moduleName: "cron-connector-oauth-state-cleanup",
    path: "/api/cron/connector-oauth-state-cleanup",
  },
  {
    exportName: "cronComputerUseScreenshotCleanupRoutes",
    moduleName: "cron-computer-use-screenshot-cleanup",
    path: "/api/cron/computer-use-screenshot-cleanup",
  },
  {
    exportName: "modelStatsRoutes",
    moduleName: "model-stats",
    path: "/api/cron/aggregate-model-stats",
  },
  {
    exportName: "cronSyncSkillsRoutes",
    moduleName: "cron-sync-skills",
    path: "/api/cron/sync-skills",
  },
  {
    exportName: "cronExecuteWorkflowAutomationsRoutes",
    moduleName: "cron-execute-workflow-automations",
    path: "/api/cron/execute-workflow-automations",
  },
];

const CONTRACT_HARNESS_SUFFIX =
  "/src/signals/routes/__tests__/global-sweep-contracts.test.ts";
const PRODUCTION_ROUTE_SUFFIX = "/src/signals/route.ts";
const CONTRACT_HELPER_SUFFIX =
  "/signals/routes/__tests__/helpers/global-sweep-contract";
const CONTRACT_HELPER_RELATIVE = "./helpers/global-sweep-contract";
const UNAUTHORIZED_HELPERS = new Set([
  "expectGlobalSweepMissingAuth",
  "expectGlobalSweepWrongAuth",
]);
const APP_FACTORIES = new Set(["createApp", "createAppWithRoutes", "setupApp"]);

function normalizedFilename(filename: string): string {
  return filename.replaceAll("\\", "/");
}

function resolvesToProductionRoute(filename: string, source: string): boolean {
  const normalizedSource = source.replace(/\.(?:[cm]?[jt]s)$/u, "");
  if (!normalizedSource.startsWith(".")) {
    return normalizedSource.endsWith("/src/signals/route");
  }
  const segments = normalizedFilename(filename).split("/");
  segments.pop();
  for (const segment of normalizedSource.split("/")) {
    if (segment === "." || segment === "") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/").endsWith("/src/signals/route");
}

function moduleName(source: string): string {
  const finalSegment = source.split("/").at(-1) ?? source;
  return finalSegment.replace(/\.(?:[cm]?[jt]s)$/, "");
}

function boundaryForImport(
  source: string,
  importedName: string,
): GlobalSweepBoundary | undefined {
  const importedModule = moduleName(source);
  return GLOBAL_SWEEP_BOUNDARIES.find((boundary) => {
    return (
      boundary.moduleName === importedModule &&
      boundary.exportName === importedName
    );
  });
}

function boundariesForModule(source: string): readonly GlobalSweepBoundary[] {
  const importedModule = moduleName(source);
  return GLOBAL_SWEEP_BOUNDARIES.filter((boundary) => {
    return boundary.moduleName === importedModule;
  });
}

function staticString(
  expression: TSESTree.CallExpressionArgument,
): string | null {
  if (
    expression.type === AST_NODE_TYPES.Literal &&
    typeof expression.value === "string"
  ) {
    return expression.value;
  }
  if (
    expression.type === AST_NODE_TYPES.TemplateLiteral &&
    expression.expressions.length === 0
  ) {
    return expression.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function isApprovedHarnessReference(
  identifier: TSESTree.Identifier,
  boundary: GlobalSweepBoundary,
  context: Readonly<{ sourceCode: Parameters<typeof importReference>[0] }>,
): boolean {
  const call = identifier.parent;
  if (
    call.type !== AST_NODE_TYPES.CallExpression ||
    call.arguments.length !== 3 ||
    call.arguments[1] !== identifier ||
    call.callee.type !== AST_NODE_TYPES.Identifier
  ) {
    return false;
  }
  const helper = importReference(context.sourceCode, call.callee);
  if (
    !helper ||
    (helper.source !== CONTRACT_HELPER_RELATIVE &&
      !helper.source.endsWith(CONTRACT_HELPER_SUFFIX)) ||
    helper.importedName === "default"
  ) {
    return false;
  }
  const pathArgument = call.arguments[2];
  if (!pathArgument || pathArgument.type === AST_NODE_TYPES.SpreadElement) {
    return false;
  }
  const path = staticString(pathArgument);
  return (
    UNAUTHORIZED_HELPERS.has(helper.importedName) && path === boundary.path
  );
}

export const noGlobalSweepTestRoutes = createRule({
  name: "no-global-sweep-test-routes",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep API test correctness on fixture-scoped state routes instead of production-global sweeps",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      globalSweep:
        "Production-global route '{{ routeName }}' is not an approved correctness boundary. Use a fixture-scoped test route; contract coverage may pass it directly only to the fixed no-auth helper.",
    },
  },
  create(context) {
    const filename = normalizedFilename(context.filename);
    const isProductionRoute = filename.endsWith(PRODUCTION_ROUTE_SUFFIX);
    const isContractHarness = filename.endsWith(CONTRACT_HARNESS_SUFFIX);
    const harnessBindings: {
      readonly boundary: GlobalSweepBoundary;
      readonly specifier: TSESTree.ImportSpecifier;
    }[] = [];
    const calls: TSESTree.CallExpression[] = [];

    function report(node: TSESTree.Node, boundary: GlobalSweepBoundary): void {
      context.report({
        node,
        messageId: "globalSweep",
        data: { routeName: boundary.exportName },
      });
    }

    function isAggregateRoutes(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.Identifier) {
        const imported = importReference(context.sourceCode, current);
        if (
          imported?.importedName === "ROUTES" &&
          resolvesToProductionRoute(filename, imported.source)
        ) {
          return true;
        }
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        return Boolean(
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init &&
          isAggregateRoutes(definition.node.init, nextSeen),
        );
      }
      if (
        current.type === AST_NODE_TYPES.MemberExpression &&
        memberName(current) === "ROUTES" &&
        current.object.type === AST_NODE_TYPES.Identifier
      ) {
        const imported = importReference(context.sourceCode, current.object);
        return Boolean(
          imported?.importedName === "*" &&
          resolvesToProductionRoute(filename, imported.source),
        );
      }
      if (current.type === AST_NODE_TYPES.ArrayExpression) {
        return current.elements.some((element) => {
          return Boolean(
            element &&
            isAggregateRoutes(
              element.type === AST_NODE_TYPES.SpreadElement
                ? element.argument
                : element,
              nextSeen,
            ),
          );
        });
      }
      return false;
    }

    function isAppFactory(
      expression: TSESTree.CallExpression["callee"],
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      if (
        seen.has(expression) ||
        expression.type !== AST_NODE_TYPES.Identifier
      ) {
        return false;
      }
      const nextSeen = new Set(seen).add(expression);
      const imported = importReference(context.sourceCode, expression);
      if (
        (imported && APP_FACTORIES.has(imported.importedName)) ||
        APP_FACTORIES.has(expression.name)
      ) {
        return true;
      }
      const definition = variableInScope(context.sourceCode, expression)
        ?.defs[0];
      return Boolean(
        definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
        definition.node.init &&
        isAppFactory(definition.node.init, nextSeen),
      );
    }

    function mountedAggregateRoutes(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        return Boolean(
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init &&
          mountedAggregateRoutes(definition.node.init, nextSeen),
        );
      }
      if (current.type !== AST_NODE_TYPES.CallExpression) {
        return false;
      }
      if (isAppFactory(current.callee)) {
        const options = current.arguments[0];
        if (!options || options.type !== AST_NODE_TYPES.ObjectExpression) {
          return false;
        }
        return options.properties.some((property) => {
          return (
            property.type === AST_NODE_TYPES.Property &&
            propertyName(property) === "routes" &&
            property.value.type !== AST_NODE_TYPES.AssignmentPattern &&
            isAggregateRoutes(property.value as TSESTree.Expression)
          );
        });
      }
      return (
        current.callee.type === AST_NODE_TYPES.CallExpression &&
        mountedAggregateRoutes(current.callee, nextSeen)
      );
    }

    function aggregateSweepBoundary(
      call: TSESTree.CallExpression,
    ): GlobalSweepBoundary | null {
      if (
        call.callee.type !== AST_NODE_TYPES.MemberExpression ||
        memberName(call.callee) !== "request" ||
        call.callee.object.type === AST_NODE_TYPES.Super ||
        !mountedAggregateRoutes(call.callee.object)
      ) {
        return null;
      }
      const pathArgument = call.arguments[0];
      if (!pathArgument || pathArgument.type === AST_NODE_TYPES.SpreadElement) {
        return null;
      }
      const path = staticString(pathArgument);
      return (
        GLOBAL_SWEEP_BOUNDARIES.find((boundary) => {
          return (
            path === boundary.path || path?.startsWith(`${boundary.path}?`)
          );
        }) ?? null
      );
    }

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        if (typeof node.source.value !== "string") {
          return;
        }
        const moduleBoundaries = boundariesForModule(node.source.value);
        if (moduleBoundaries.length === 0 || isProductionRoute) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type !== AST_NODE_TYPES.ImportSpecifier) {
            const boundary = moduleBoundaries[0];
            if (boundary) {
              report(specifier, boundary);
            }
            continue;
          }
          const importedName =
            specifier.imported.type === AST_NODE_TYPES.Identifier
              ? specifier.imported.name
              : String(specifier.imported.value);
          const boundary = boundaryForImport(node.source.value, importedName);
          if (!boundary) {
            continue;
          }
          if (
            !isContractHarness ||
            specifier.local.name !== boundary.exportName
          ) {
            report(specifier, boundary);
            continue;
          }
          harnessBindings.push({ boundary, specifier });
        }
      },
      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration) {
        if (!node.source || typeof node.source.value !== "string") {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type !== AST_NODE_TYPES.ExportSpecifier) {
            continue;
          }
          const localName =
            specifier.local.type === AST_NODE_TYPES.Identifier
              ? specifier.local.name
              : String(specifier.local.value);
          const boundary = boundaryForImport(node.source.value, localName);
          if (boundary && !isProductionRoute) {
            report(specifier, boundary);
          }
        }
      },
      ExportAllDeclaration(node: TSESTree.ExportAllDeclaration) {
        if (typeof node.source.value !== "string" || isProductionRoute) {
          return;
        }
        const boundary = boundariesForModule(node.source.value)[0];
        if (boundary) {
          report(node, boundary);
        }
      },
      ImportExpression(node: TSESTree.ImportExpression) {
        if (
          node.source.type !== AST_NODE_TYPES.Literal ||
          typeof node.source.value !== "string" ||
          isProductionRoute
        ) {
          return;
        }
        const boundary = boundariesForModule(node.source.value)[0];
        if (boundary) {
          report(node, boundary);
        }
      },
      CallExpression(node: TSESTree.CallExpression) {
        calls.push(node);
      },
      "Program:exit"() {
        for (const call of calls) {
          const boundary = aggregateSweepBoundary(call);
          if (boundary) {
            report(call, boundary);
          }
        }
        for (const { boundary, specifier } of harnessBindings) {
          const variables = context.sourceCode.getDeclaredVariables(specifier);
          for (const variable of variables) {
            for (const reference of variable.references) {
              const identifier = reference.identifier;
              if (
                identifier.type === AST_NODE_TYPES.Identifier &&
                !isApprovedHarnessReference(identifier, boundary, context)
              ) {
                report(identifier, boundary);
              }
            }
          }
        }
      },
    };
  },
});
