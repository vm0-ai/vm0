import type { Database } from "../types/global.d";

/**
 * GraphQL context type
 * Available in all resolvers
 */
export interface GraphQLContext {
  /** Authenticated user ID (null if not authenticated) */
  userId: string | null;
  /** Drizzle database instance */
  db: Database;
}
