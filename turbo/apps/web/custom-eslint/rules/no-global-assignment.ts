/**
 * ESLint rule: no-global-assignment
 *
 * Disallows attaching new properties to the runtime global object. Runtime
 * globals escape the serverless lifecycle guarantees we rely on and create
 * state that outlives a single request.
 *
 * Flags:
 *   - globalThis.X = v  /  global.X = v
 *   - globalThis["X"] = v  /  global["X"] = v
 *   - Object.defineProperty(globalThis, ...) / Reflect.defineProperty(globalThis, ...)
 *   - Object.assign(globalThis, ...)
 *   - declare global { ... } blocks
 *
 * The rule targets `globalThis` and `global` (Node aliases of the same
 * object). `window` and `self` are intentionally NOT covered — browser code
 * mutates `window.location`, installs DOM polyfills via
 * `Object.defineProperty(window, ...)`, etc., which are not the same class
 * of problem.
 *
 * Only direct-child writes are flagged. `globalThis.cache.value = x` mutates
 * a property on `cache`, not on the global, and is out of scope for this rule.
 *
 * Exempt files (file-suffix match, Posix-normalized):
 *   - src/types/global.d.ts          (ambient browser declarations)
 *
 * Good:
 *   window.location.href = "/";
 *
 * Bad:
 *   globalThis.myCache = new Map();
 *   Object.defineProperty(globalThis, "myHook", { value: fn });
 *   declare global { var myCache: Map<string, unknown>; }
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

const GLOBAL_ROOT_NAMES = new Set(["globalThis", "global"]);

const ALLOWED_FILE_SUFFIXES = ["src/types/global.d.ts"];

function isAllowedFile(filename: string): boolean {
  const posix = filename.replace(/\\/g, "/");
  return ALLOWED_FILE_SUFFIXES.some((suffix) => {
    return posix.endsWith(suffix);
  });
}

function unwrapTypeAssertions(node: TSESTree.Node): TSESTree.Node {
  let current = node;
  while (
    current.type === AST_NODE_TYPES.TSAsExpression ||
    current.type === AST_NODE_TYPES.TSTypeAssertion ||
    current.type === AST_NODE_TYPES.TSNonNullExpression ||
    current.type === AST_NODE_TYPES.TSSatisfiesExpression
  ) {
    current = current.expression;
  }
  return current;
}

function globalRootName(node: TSESTree.Node): string | undefined {
  const unwrapped = unwrapTypeAssertions(node);
  if (
    unwrapped.type === AST_NODE_TYPES.Identifier &&
    GLOBAL_ROOT_NAMES.has(unwrapped.name)
  ) {
    return unwrapped.name;
  }
  return undefined;
}

export default createRule({
  name: "no-global-assignment",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Disallow attaching new properties to globalThis/global.",
      recommended: true,
    },
    schema: [],
    messages: {
      noGlobalAssignment:
        "Do not assign to `{{root}}.*`. Runtime globals are banned; keep state request-scoped or module-local.",
      noGlobalDefineProperty:
        "Do not call `{{method}}` on `{{root}}`. Runtime globals are banned; keep state request-scoped or module-local.",
      noGlobalAssign:
        "Do not use `Object.assign` to attach properties to `{{root}}`. Runtime globals are banned.",
      noDeclareGlobal:
        "Do not add `declare global` blocks. Add browser-only declarations to `src/types/global.d.ts` only when necessary.",
    },
  },
  create(context) {
    if (isAllowedFile(context.filename)) {
      return {};
    }

    return {
      AssignmentExpression(node: TSESTree.AssignmentExpression) {
        if (node.left.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }
        const root = globalRootName(node.left.object);
        if (!root) {
          return;
        }
        context.report({
          node,
          messageId: "noGlobalAssignment",
          data: { root },
        });
      },

      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;
        if (
          callee.type !== AST_NODE_TYPES.MemberExpression ||
          callee.object.type !== AST_NODE_TYPES.Identifier ||
          callee.property.type !== AST_NODE_TYPES.Identifier
        ) {
          return;
        }
        const firstArg = node.arguments[0];
        if (!firstArg) {
          return;
        }
        const root = globalRootName(firstArg);
        if (!root) {
          return;
        }

        const isDefineProperty =
          (callee.object.name === "Object" ||
            callee.object.name === "Reflect") &&
          callee.property.name === "defineProperty";
        if (isDefineProperty) {
          context.report({
            node,
            messageId: "noGlobalDefineProperty",
            data: {
              root,
              method: `${callee.object.name}.defineProperty`,
            },
          });
          return;
        }

        const isObjectAssign =
          callee.object.name === "Object" && callee.property.name === "assign";
        if (isObjectAssign) {
          context.report({
            node,
            messageId: "noGlobalAssign",
            data: { root },
          });
        }
      },

      TSModuleDeclaration(node: TSESTree.TSModuleDeclaration) {
        if (node.global === true) {
          context.report({
            node,
            messageId: "noDeclareGlobal",
          });
        }
      },
    };
  },
});
