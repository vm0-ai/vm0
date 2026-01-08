import SchemaBuilder from "@pothos/core";
import ScopeAuthPlugin from "@pothos/plugin-scope-auth";
import ValidationPlugin from "@pothos/plugin-validation";
import type { GraphQLContext } from "./context";

/**
 * Pothos Schema Builder
 *
 * Configured with:
 * - Scope Auth: Requires authentication for queries/mutations
 * - Validation: Input validation with Zod
 */
export const builder = new SchemaBuilder<{
  Context: GraphQLContext;
  AuthScopes: {
    authenticated: boolean;
  };
  Scalars: {
    JSON: {
      Input: unknown;
      Output: unknown;
    };
    DateTime: {
      Input: Date;
      Output: Date;
    };
  };
}>({
  plugins: [ScopeAuthPlugin, ValidationPlugin],
  scopeAuth: {
    authScopes: (context) => ({
      authenticated: context.userId !== null,
    }),
    unauthorizedError: () => new Error("Not authenticated"),
  },
});

// Register custom scalar types
builder.scalarType("JSON", {
  serialize: (value) => value,
  parseValue: (value) => value,
});

builder.scalarType("DateTime", {
  serialize: (date) => date.toISOString(),
  parseValue: (value) => new Date(value as string),
});

// Initialize Query, Mutation, and Subscription types
builder.queryType({});
builder.mutationType({});
builder.subscriptionType({});
