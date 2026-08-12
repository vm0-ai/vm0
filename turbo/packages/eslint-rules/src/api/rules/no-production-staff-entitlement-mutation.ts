import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import {
  importReference,
  memberName,
  propertyName,
  unwrapExpression,
  variableInScope,
} from "../syntax.ts";
import { createRule } from "../utils.ts";

type FunctionNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression;
type MutationKind = "delete" | "grant" | "upsert";

const PRODUCTION_STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";

function enclosingFunction(node: TSESTree.Node): FunctionNode | null {
  let current = node.parent;
  while (current) {
    if (
      current.type === AST_NODE_TYPES.ArrowFunctionExpression ||
      current.type === AST_NODE_TYPES.FunctionDeclaration ||
      current.type === AST_NODE_TYPES.FunctionExpression
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function functionName(node: FunctionNode): string | null {
  if (node.type === AST_NODE_TYPES.FunctionDeclaration) {
    return node.id?.name ?? null;
  }
  if (node.id) {
    return node.id.name;
  }
  if (
    node.parent.type === AST_NODE_TYPES.VariableDeclarator &&
    node.parent.id.type === AST_NODE_TYPES.Identifier
  ) {
    return node.parent.id.name;
  }
  return null;
}

function parameterIndex(node: FunctionNode, name: string): number {
  return node.params.findIndex((parameter) => {
    return (
      parameter.type === AST_NODE_TYPES.Identifier && parameter.name === name
    );
  });
}

function isEntitlementFixtureModule(source: string): boolean {
  return (
    source.endsWith("/test-fixtures/org-plan-entitlement") ||
    source.endsWith("/test-fixtures/org-plan-entitlement.ts")
  );
}

export const noProductionStaffEntitlementMutation = createRule({
  name: "no-production-staff-entitlement-mutation",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep the fixed production staff organization identity read-only in API tests",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      productionStaffMutation:
        "Do not mutate entitlements for the fixed production staff organization. Use createUniqueStaffOrgIdFixture() or another test-owned organization.",
    },
  },
  create(context) {
    const calls: TSESTree.CallExpression[] = [];
    const functionReturns = new Map<FunctionNode, TSESTree.Expression[]>();

    function callsTo(node: FunctionNode): readonly TSESTree.CallExpression[] {
      const name = functionName(node);
      if (!name) {
        return [];
      }
      return calls.filter((call) => {
        return (
          call.callee.type === AST_NODE_TYPES.Identifier &&
          call.callee.name === name
        );
      });
    }

    function expressionProperty(
      expression: TSESTree.Expression,
      name: string,
      seen: ReadonlySet<TSESTree.Node>,
    ): TSESTree.Expression | null {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return null;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.ObjectExpression) {
        for (const property of current.properties) {
          if (
            property.type === AST_NODE_TYPES.Property &&
            propertyName(property) === name &&
            property.value.type !== AST_NODE_TYPES.AssignmentPattern
          ) {
            return property.value as TSESTree.Expression;
          }
          if (property.type === AST_NODE_TYPES.SpreadElement) {
            const nested = expressionProperty(
              property.argument,
              name,
              nextSeen,
            );
            if (nested) {
              return nested;
            }
          }
        }
      }
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init
        ) {
          return expressionProperty(definition.node.init, name, nextSeen);
        }
      }
      return null;
    }

    function parameterResolvesToStaff(
      identifier: TSESTree.Identifier,
      property: "actor" | "orgId",
      seen: ReadonlySet<TSESTree.Node>,
    ): boolean {
      const owner = enclosingFunction(identifier);
      if (!owner) {
        return false;
      }
      const index = parameterIndex(owner, identifier.name);
      if (index < 0) {
        return false;
      }
      return callsTo(owner).some((call) => {
        const argument = call.arguments[index];
        if (!argument || argument.type === AST_NODE_TYPES.SpreadElement) {
          return false;
        }
        return property === "actor"
          ? isStaffActor(argument, seen)
          : isStaffOrgId(argument, seen);
      });
    }

    function objectPropertyResolvesToStaff(
      expression: TSESTree.Expression,
      name: string,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      const property = expressionProperty(current, name, seen);
      if (property) {
        return isStaffOrgId(property, nextSeen);
      }
      if (current.type !== AST_NODE_TYPES.Identifier) {
        return false;
      }
      const definition = variableInScope(context.sourceCode, current)?.defs[0];
      if (definition?.type !== "Parameter") {
        return false;
      }
      const owner = enclosingFunction(current);
      if (!owner) {
        return false;
      }
      const index = parameterIndex(owner, current.name);
      if (index < 0) {
        return false;
      }
      return callsTo(owner).some((call) => {
        const argument = call.arguments[index];
        return Boolean(
          argument &&
          argument.type !== AST_NODE_TYPES.SpreadElement &&
          objectPropertyResolvesToStaff(argument, name, nextSeen),
        );
      });
    }

    function isStaffOrgId(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (
        current.type === AST_NODE_TYPES.Literal &&
        current.value === PRODUCTION_STAFF_ORG_ID
      ) {
        return true;
      }
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init
        ) {
          return isStaffOrgId(definition.node.init, nextSeen);
        }
        if (definition?.type === "Parameter") {
          return parameterResolvesToStaff(current, "orgId", nextSeen);
        }
        return false;
      }
      if (
        current.type === AST_NODE_TYPES.MemberExpression &&
        memberName(current) === "orgId"
      ) {
        return isStaffActor(current.object, nextSeen);
      }
      if (current.type === AST_NODE_TYPES.ConditionalExpression) {
        return (
          isStaffOrgId(current.consequent, nextSeen) ||
          isStaffOrgId(current.alternate, nextSeen)
        );
      }
      return false;
    }

    function isStaffActor(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.ObjectExpression) {
        const orgId = expressionProperty(current, "orgId", seen);
        return orgId ? isStaffOrgId(orgId, nextSeen) : false;
      }
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init
        ) {
          return isStaffActor(definition.node.init, nextSeen);
        }
        if (definition?.type === "Parameter") {
          return parameterResolvesToStaff(current, "actor", nextSeen);
        }
        return false;
      }
      if (current.type === AST_NODE_TYPES.CallExpression) {
        const calleeName =
          current.callee.type === AST_NODE_TYPES.Identifier
            ? current.callee.name
            : current.callee.type === AST_NODE_TYPES.MemberExpression
              ? memberName(current.callee)
              : null;
        if (calleeName === "user") {
          const options = current.arguments[0];
          if (!options || options.type === AST_NODE_TYPES.SpreadElement) {
            return false;
          }
          const orgId = expressionProperty(options, "orgId", nextSeen);
          return orgId ? isStaffOrgId(orgId, nextSeen) : false;
        }
        if (current.callee.type === AST_NODE_TYPES.Identifier) {
          const calleeName = current.callee.name;
          const localFunction = [...functionReturns.keys()].find(
            (candidate) => {
              return functionName(candidate) === calleeName;
            },
          );
          if (!localFunction) {
            return false;
          }
          return (functionReturns.get(localFunction) ?? []).some((returned) => {
            return isStaffActor(returned, nextSeen);
          });
        }
      }
      return false;
    }

    function mutationKind(
      callee: TSESTree.CallExpression["callee"],
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): MutationKind | null {
      if (seen.has(callee)) {
        return null;
      }
      const nextSeen = new Set(seen).add(callee);
      if (callee.type === AST_NODE_TYPES.MemberExpression) {
        return memberName(callee) === "grantProEntitlement" ? "grant" : null;
      }
      if (callee.type !== AST_NODE_TYPES.Identifier) {
        return null;
      }
      const imported = importReference(context.sourceCode, callee);
      if (imported && isEntitlementFixtureModule(imported.source)) {
        if (imported.importedName === "upsertOrgPlanEntitlementFixture") {
          return "upsert";
        }
        if (imported.importedName === "deleteOrgPlanEntitlementFixture") {
          return "delete";
        }
      }
      const definition = variableInScope(context.sourceCode, callee)?.defs[0];
      if (
        definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
        definition.node.init
      ) {
        return mutationKind(definition.node.init, nextSeen);
      }
      return null;
    }

    function checkMutation(call: TSESTree.CallExpression): void {
      const kind = mutationKind(call.callee);
      if (!kind) {
        return;
      }
      const first = call.arguments[0];
      if (!first || first.type === AST_NODE_TYPES.SpreadElement) {
        return;
      }
      let mutatesStaff = false;
      if (kind === "upsert") {
        mutatesStaff = objectPropertyResolvesToStaff(first, "orgId");
      } else if (kind === "delete") {
        mutatesStaff = isStaffOrgId(first);
      } else {
        mutatesStaff = isStaffActor(first);
      }
      if (mutatesStaff) {
        context.report({ node: call, messageId: "productionStaffMutation" });
      }
    }

    function registerFunction(node: FunctionNode): void {
      if (!functionReturns.has(node)) {
        functionReturns.set(node, []);
      }
      if (
        node.type === AST_NODE_TYPES.ArrowFunctionExpression &&
        node.body.type !== AST_NODE_TYPES.BlockStatement
      ) {
        functionReturns.get(node)?.push(node.body);
      }
    }

    return {
      ArrowFunctionExpression: registerFunction,
      FunctionDeclaration: registerFunction,
      FunctionExpression: registerFunction,
      ReturnStatement(node: TSESTree.ReturnStatement) {
        const owner = enclosingFunction(node);
        if (owner && node.argument) {
          functionReturns.get(owner)?.push(node.argument);
        }
      },
      CallExpression(node: TSESTree.CallExpression) {
        calls.push(node);
      },
      "Program:exit"() {
        for (const call of calls) {
          checkMutation(call);
        }
      },
    };
  },
});
