/**
 * ESLint rule: no-raw-msw-http
 *
 * Disallows raw `http.(get|post|put|patch|delete)(url, ...)` MSW handlers in
 * platform test files when `url` points at an internal `/api/zero/*` or
 * `/api/v1/*` route. Those routes have ts-rest contracts — tests should use
 * `mockApi(contract.route, ...)` so handler shape, path, method, params, and
 * response body are validated against the same contract the real server uses.
 *
 * If migration is genuinely impossible (e.g. simulating a status code not
 * declared in the contract's responses, or a multipart body without a
 * ts-rest contract), add a leading comment containing the marker phrase
 * `mockApi cannot be used here` on the handler call or its enclosing
 * statement — the rule treats that as an explicit, reviewable exemption.
 *
 * Good:
 *   server.use(mockApi(zeroOrgContract.get, ({ respond }) => respond(200, {...})));
 *
 * Bad:
 *   server.use(http.get("*\/api/zero/org", () => HttpResponse.json({...})));
 *
 * Exempted (via marker comment):
 *   // mockApi cannot be used here: 500 is not declared in the contract's responses.
 *   server.use(http.get("*\/api/zero/org", () => HttpResponse.json(null, { status: 500 })));
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

const EXEMPTION_MARKER = "mockApi cannot be used here";
const INTERNAL_API_RE = /\/api\/(zero|v1)\//;
const MSW_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export default createRule({
  name: "no-raw-msw-http",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw http.* MSW handlers for internal /api/zero/* or /api/v1/* routes — use mockApi(contract.route, ...) so handlers stay typed against ts-rest contracts",
    },
    schema: [],
    messages: {
      useMockApi:
        "Use mockApi(contract.route, ...) instead of raw http.{{method}} for internal /api/{{bucket}}/ paths. If migration is genuinely impossible, add a '// mockApi cannot be used here: <reason>' comment above the call explaining why.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;

    function hasExemptionComment(callNode: TSESTree.CallExpression): boolean {
      let current: TSESTree.Node = callNode;
      while (current.parent && current.parent.type !== AST_NODE_TYPES.Program) {
        const leading = sourceCode.getCommentsBefore(current);
        for (const comment of leading) {
          if (comment.value.includes(EXEMPTION_MARKER)) {
            return true;
          }
        }
        if (
          current.type === AST_NODE_TYPES.ExpressionStatement ||
          current.type === AST_NODE_TYPES.VariableDeclaration
        ) {
          return false;
        }
        current = current.parent;
      }
      const leading = sourceCode.getCommentsBefore(current);
      return leading.some((comment) => {
        return comment.value.includes(EXEMPTION_MARKER);
      });
    }

    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;
        if (callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }
        if (callee.computed) {
          return;
        }
        if (
          callee.object.type !== AST_NODE_TYPES.Identifier ||
          callee.object.name !== "http"
        ) {
          return;
        }
        if (callee.property.type !== AST_NODE_TYPES.Identifier) {
          return;
        }
        const method = callee.property.name;
        if (!MSW_METHODS.has(method)) {
          return;
        }

        const [urlArg] = node.arguments;
        if (!urlArg) {
          return;
        }
        if (
          urlArg.type !== AST_NODE_TYPES.Literal ||
          typeof urlArg.value !== "string"
        ) {
          return;
        }

        const match = INTERNAL_API_RE.exec(urlArg.value);
        if (!match) {
          return;
        }

        if (hasExemptionComment(node)) {
          return;
        }

        context.report({
          node,
          messageId: "useMockApi",
          data: { method, bucket: match[1] ?? "zero" },
        });
      },
    };
  },
});
