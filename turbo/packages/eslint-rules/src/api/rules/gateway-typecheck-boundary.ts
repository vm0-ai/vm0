/**
 * ESLint rule: gateway-typecheck-boundary
 *
 * Guards the `tsconfig.gateways.json` type-check program. That project exists
 * so an expensive third-party declaration surface (today `@aws-sdk/*` and
 * `@smithy/*`) is parsed once in a small program instead of inside
 * `tsconfig.core.json`, which is what sets the CI peak RSS for apps/api.
 *
 * Three things silently undo that isolation, so each one is an error here:
 *
 * 1. A gateway module importing a module outside the project. The project must
 *    stay a leaf: every relative import has to resolve to another member, or
 *    the importee gets pulled in and has to move too.
 * 2. A module outside the project importing the isolated dependency directly.
 *    One such import puts the whole SDK declaration surface back into the core
 *    program.
 * 3. A gateway module naming an isolated dependency's type in its own exported
 *    signature. The emitted `.d.ts` then references the SDK, so every consumer
 *    of that declaration loads it anyway.
 *
 * Good (inside a gateway module):
 *   export function decrypt(request: SecretKmsDecryptRequest): Promise<Uint8Array>
 *
 * Bad (inside a gateway module):
 *   export function getClient(): KMSClient
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../utils.ts";

interface GatewayTypecheckBoundaryOptions {
  /** Absolute paths of the files listed in the gateway project. */
  modules?: string[];
  /** Package names or scopes the gateway project isolates. */
  isolatedDependencies?: string[];
}

type MessageId = "outboundImport" | "isolatedDependency" | "exportedSdkType";

function isRelative(specifier: string): boolean {
  return specifier.startsWith(".");
}

function directoryOf(filePath: string): string {
  const separator = filePath.lastIndexOf("/");
  return separator === -1 ? "" : filePath.slice(0, separator);
}

function normalize(filePath: string): string {
  const segments: string[] = [];
  for (const segment of filePath.split("/")) {
    if (segment === "." || segment === "") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `${filePath.startsWith("/") ? "/" : ""}${segments.join("/")}`;
}

function resolvesToModule(
  importer: string,
  specifier: string,
  modules: ReadonlySet<string>,
): boolean {
  const target = normalize(`${directoryOf(importer)}/${specifier}`);
  return (
    modules.has(target) ||
    modules.has(`${target}.ts`) ||
    modules.has(`${target}.tsx`) ||
    modules.has(`${target}/index.ts`)
  );
}

function matchesIsolatedDependency(
  specifier: string,
  isolatedDependencies: readonly string[],
): string | undefined {
  return isolatedDependencies.find((dependency) => {
    return specifier === dependency || specifier.startsWith(`${dependency}/`);
  });
}

/**
 * Whether a type reference reaches the emitted `.d.ts`. Anything inside a
 * function body is an implementation detail that declaration emit drops, so
 * only annotations on the exported declaration itself count.
 */
function isEmittedSignature(node: TSESTree.Node): boolean {
  let current: TSESTree.Node | undefined = node;
  while (current) {
    if (current.type === AST_NODE_TYPES.BlockStatement) {
      return false;
    }
    if (
      current.type === AST_NODE_TYPES.ExportNamedDeclaration ||
      current.type === AST_NODE_TYPES.ExportDefaultDeclaration
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function rootIdentifier(
  typeName: TSESTree.EntityName,
): TSESTree.Identifier | undefined {
  if (typeName.type === AST_NODE_TYPES.Identifier) {
    return typeName;
  }
  if (typeName.type === AST_NODE_TYPES.TSQualifiedName) {
    return rootIdentifier(typeName.left);
  }
  return undefined;
}

export const gatewayTypecheckBoundary = createRule<
  [GatewayTypecheckBoundaryOptions] | [],
  MessageId
>({
  name: "gateway-typecheck-boundary",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep the gateway type-check project a leaf and its isolated dependencies out of every other program",
      recommended: true,
      requiresTypeChecking: false,
    },
    schema: [
      {
        type: "object",
        properties: {
          modules: {
            type: "array",
            items: { type: "string" },
          },
          isolatedDependencies: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      outboundImport:
        "{{module}} belongs to the gateway type-check project, so it must not import '{{specifier}}'. Either keep the gateway module self-contained or move the importee into tsconfig.gateways.json as well.",
      isolatedDependency:
        "'{{dependency}}' is isolated in the gateway type-check project. Importing it here loads its whole declaration surface into this program; call the wrapper in the gateway module instead.",
      exportedSdkType:
        "'{{name}}' comes from the isolated dependency '{{dependency}}' and must not appear in an exported signature. The emitted .d.ts would reference the SDK, which defeats the gateway boundary; map it to a type this module owns.",
    },
  },
  create(context) {
    const options = context.options[0];
    const modules = new Set(options?.modules ?? []);
    const isolatedDependencies = options?.isolatedDependencies ?? [];
    const isGatewayModule = modules.has(context.filename);
    const sdkTypeNames = new Map<string, string>();
    const exportedTypeReferences: {
      node: TSESTree.TSTypeReference;
      name: string;
    }[] = [];

    function reportSource(
      node: TSESTree.Node,
      specifier: string,
      onGatewaySpecifiers: () => void,
    ): void {
      const dependency = matchesIsolatedDependency(
        specifier,
        isolatedDependencies,
      );
      if (!dependency) {
        return;
      }
      if (!isGatewayModule) {
        context.report({
          node,
          messageId: "isolatedDependency",
          data: { dependency },
        });
        return;
      }
      onGatewaySpecifiers();
    }

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        const specifier = node.source.value;

        if (isRelative(specifier)) {
          if (
            isGatewayModule &&
            !resolvesToModule(context.filename, specifier, modules)
          ) {
            context.report({
              node,
              messageId: "outboundImport",
              data: { module: context.filename, specifier },
            });
          }
          return;
        }

        reportSource(node, specifier, () => {
          const dependency = matchesIsolatedDependency(
            specifier,
            isolatedDependencies,
          );
          for (const imported of node.specifiers) {
            sdkTypeNames.set(imported.local.name, dependency ?? specifier);
          }
        });
      },

      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration) {
        if (!node.source) {
          return;
        }
        reportSource(node, node.source.value, () => {
          context.report({
            node,
            messageId: "exportedSdkType",
            data: {
              name: node.source?.value ?? "",
              dependency: node.source?.value ?? "",
            },
          });
        });
      },

      ExportAllDeclaration(node: TSESTree.ExportAllDeclaration) {
        reportSource(node, node.source.value, () => {
          context.report({
            node,
            messageId: "exportedSdkType",
            data: { name: node.source.value, dependency: node.source.value },
          });
        });
      },

      TSImportType(node: TSESTree.TSImportType) {
        const specifier = node.source.value;
        const dependency = matchesIsolatedDependency(
          specifier,
          isolatedDependencies,
        );
        if (!dependency) {
          return;
        }
        if (!isGatewayModule) {
          context.report({
            node,
            messageId: "isolatedDependency",
            data: { dependency },
          });
          return;
        }
        if (isEmittedSignature(node)) {
          context.report({
            node,
            messageId: "exportedSdkType",
            data: { name: specifier, dependency },
          });
        }
      },

      TSTypeReference(node: TSESTree.TSTypeReference) {
        if (!isGatewayModule || !isEmittedSignature(node)) {
          return;
        }
        const identifier = rootIdentifier(node.typeName);
        if (identifier) {
          exportedTypeReferences.push({ node, name: identifier.name });
        }
      },

      "Program:exit"() {
        for (const reference of exportedTypeReferences) {
          const dependency = sdkTypeNames.get(reference.name);
          if (!dependency) {
            continue;
          }
          context.report({
            node: reference.node,
            messageId: "exportedSdkType",
            data: { name: reference.name, dependency },
          });
        }
      },
    };
  },
});
