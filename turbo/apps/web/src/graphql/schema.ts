/**
 * GraphQL Schema
 *
 * This file imports all types and resolvers to build the complete schema.
 * The order of imports matters - types must be defined before resolvers use them.
 */

// Import builder (initializes Query, Mutation, Subscription types)
import { builder } from "./builder";

// Import types (these register GraphQL types with the builder)
import "./types/enums";
import "./types/agent";
import "./types/run";
import "./types/events";
import "./types/payloads";

// Import resolvers (these add fields to Query, Mutation, Subscription)
import "./resolvers/queries/run";
import "./resolvers/mutations/createRun";
import "./resolvers/subscriptions/runEvents";

// Build and export the schema
export const schema = builder.toSchema();
