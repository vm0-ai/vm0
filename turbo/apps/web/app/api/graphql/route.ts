import { createYoga } from "graphql-yoga";
import { schema } from "../../../src/graphql/schema";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import type { GraphQLContext } from "../../../src/graphql/context";

/**
 * GraphQL Yoga server instance
 *
 * Configured with:
 * - Schema from Pothos builder
 * - Context with authentication and database
 * - GraphiQL playground (in development)
 */
const { handleRequest } = createYoga<object, GraphQLContext>({
  schema,
  graphqlEndpoint: "/api/graphql",
  graphiql: process.env.NODE_ENV !== "production",
  fetchAPI: { Response },
  context: async () => {
    // Initialize services (database connection, etc.)
    initServices();

    // Get authenticated user ID
    const userId = await getUserId();

    return {
      userId,
      db: globalThis.services.db,
    };
  },
});

// Export handlers for Next.js App Router
// Wrap handleRequest to fix Next.js 15 type compatibility
export const GET = (req: Request) => handleRequest(req, {});
export const POST = (req: Request) => handleRequest(req, {});
