# Schema Patterns

This document covers the standard patterns for defining database schemas in the vm0 project.

## Table Definition Pattern

### Basic Table Structure

```typescript
import { pgTable, uuid, timestamp, text, varchar } from "drizzle-orm/pg-core";

export const myTable = pgTable("my_table", {
  id: uuid("id").defaultRandom().primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

### Standard Column Patterns

#### UUID Primary Key
```typescript
id: uuid("id").defaultRandom().primaryKey(),
```

#### Timestamps
```typescript
createdAt: timestamp("created_at").defaultNow().notNull(),
updatedAt: timestamp("updated_at").defaultNow().notNull(),
```

#### User Reference (Clerk ID)
```typescript
userId: text("user_id").notNull(), // Clerk user ID - always text, not uuid
```

#### Foreign Key Reference
```typescript
import { agentConfigs } from "./agent-config";

agentConfigId: uuid("agent_config_id")
  .references(() => agentConfigs.id, { onDelete: "cascade" })
  .notNull(),
```

#### Optional Foreign Key
```typescript
conversationId: uuid("conversation_id")
  .references(() => conversations.id, { onDelete: "set null" }),
```

## Index Patterns

### Unique Composite Index

```typescript
import { pgTable, uniqueIndex } from "drizzle-orm/pg-core";

export const storages = pgTable(
  "storages",
  {
    // columns...
  },
  (table) => ({
    userNameIdx: uniqueIndex("idx_storages_user_name").on(
      table.userId,
      table.name,
    ),
  }),
);
```

## Enum Pattern

```typescript
import { pgEnum } from "drizzle-orm/pg-core";

export const deviceCodeStatusEnum = pgEnum("device_code_status", [
  "pending",
  "authenticated",
  "expired",
  "denied",
]);

export const deviceCodes = pgTable("device_codes", {
  status: deviceCodeStatusEnum("status").default("pending").notNull(),
});
```

## JSONB Pattern

```typescript
import { jsonb } from "drizzle-orm/pg-core";

// Typed JSONB
templateVars: jsonb("template_vars").$type<Record<string, string>>(),

// Generic JSONB
config: jsonb("config").notNull(),
```

## Common Column Types

| Use Case | Drizzle Type | PostgreSQL Type |
|----------|--------------|-----------------|
| Primary key | `uuid("id").defaultRandom().primaryKey()` | `uuid` |
| User ID (Clerk) | `text("user_id")` | `text` |
| Short strings | `varchar("name", { length: 64 })` | `varchar(64)` |
| Long text | `text("description")` | `text` |
| Timestamp | `timestamp("created_at")` | `timestamp` |
| Integer | `integer("count")` | `integer` |
| Big integer | `bigint("size", { mode: "number" })` | `bigint` |
| JSON data | `jsonb("config")` | `jsonb` |
| Boolean | `boolean("active")` | `boolean` |

## File Organization

### One Table Per File

```
src/db/schema/
├── user.ts           # users table
├── agent-config.ts   # agent_configs table
├── agent-run.ts      # agent_runs table
└── storage.ts        # storages + storage_versions tables (related)
```

### Export in db.ts

When adding a new schema file, update `src/db/db.ts`:

```typescript
import * as userSchema from "./schema/user";
import * as newTableSchema from "./schema/new-table";  // Add import

export const schema = {
  ...userSchema,
  ...newTableSchema,  // Add to schema export
};
```

## Relationship Patterns

### One-to-Many

```typescript
// Parent table
export const agentConfigs = pgTable("agent_configs", {
  id: uuid("id").defaultRandom().primaryKey(),
  // ...
});

// Child table
export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  agentConfigId: uuid("agent_config_id")
    .references(() => agentConfigs.id, { onDelete: "cascade" })
    .notNull(),
});
```

### One-to-One

```typescript
export const conversations = pgTable("conversations", {
  runId: uuid("run_id")
    .references(() => agentRuns.id, { onDelete: "cascade" })
    .notNull()
    .unique(),  // Enforces one-to-one
});
```

## Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Table name | snake_case, plural | `agent_configs` |
| Column name | snake_case | `created_at` |
| Index name | `idx_table_columns` | `idx_storages_user_name` |
| Foreign key | `table_column_ref_fk` | `agent_runs_config_id_fk` |
| Enum name | snake_case | `device_code_status` |

## Type Safety

### Export Types from Schema

```typescript
// In schema file
export const users = pgTable("users", { /* ... */ });

// Usage - infer types
import { users } from "./schema/user";
import { InferSelectModel, InferInsertModel } from "drizzle-orm";

type User = InferSelectModel<typeof users>;
type NewUser = InferInsertModel<typeof users>;
```
