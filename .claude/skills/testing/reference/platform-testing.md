# Platform Testing Patterns

This document describes the testing patterns for `turbo/apps/platform`.

## Test Categories

Platform has two main types of tests:

| Type | Location | Suffix | Purpose |
|------|----------|--------|---------|
| UI Tests | `views/` | `.test.tsx` | Test user interactions and UI state |
| State Tests | `signals/` | `.test.ts` | Test state management logic |

## UI Tests

UI tests are placed in `views/` directories with `.test.tsx` suffix.

```typescript
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers";
import { setupPage } from "../../../__tests__/helper";

const context = testContext();
const user = userEvent.setup();

describe("ComponentName", () => {
  it("should do something when user clicks button", async () => {
    await setupPage({
      context,
      path: "/page-path",
    });

    // Find UI elements
    const button = screen.getByRole("button", { name: "Submit" });

    // Perform user interactions
    await user.click(button);

    // Verify UI state after interaction
    await vi.waitFor(() => {
      expect(screen.getByText("Success")).toBeInTheDocument();
    });
  });
});
```

## State Tests

State tests are placed in `signals/` directories with `.test.ts` suffix.

```typescript
import { describe, expect, it } from "vitest";
import { testContext } from "../test-helpers";
import { setupPage } from "../../../__tests__/helper";
import { someCommand$, someComputed$ } from "../some-signal";

const context = testContext();

describe("someSignal", () => {
  it("should update state when command is called", async () => {
    const { store, signal } = context;

    await setupPage({
      context,
      path: "/",
    });

    // Call command
    await store.set(someCommand$, { arg: "value" }, signal);

    // Verify state
    expect(store.get(someComputed$)).toBe("expected-value");
  });
});
```

## Mock Infrastructure

### Directory Structure

```
turbo/apps/platform/src/
├── mocks/
│   ├── server.ts          # MSW server setup for Node.js
│   └── handlers/
│       ├── index.ts       # Aggregates all handlers
│       ├── api-scope.ts   # Scope API handlers
│       ├── api-model-providers.ts  # Model provider handlers
│       └── ...            # Other API handlers
├── test/
│   ├── setup.ts           # Global test setup
│   └── mocks/             # Module mocks (e.g., Clerk)
└── __tests__/
    ├── helper.ts          # setupPage and utilities
    └── mock-auth.ts       # Authentication mocks
```

### Handler Patterns

#### Simple Static Handler

For endpoints that return constant data:

```typescript
import { http, HttpResponse } from "msw";

export const apiScopeHandlers = [
  http.get("/api/scope", () => {
    return HttpResponse.json({
      id: "scope_1",
      slug: "user-12345678",
      type: "personal",
    });
  }),
];
```

#### Stateful Handler with Reset

For endpoints that need to track state across requests:

```typescript
import { http, HttpResponse } from "msw";

let mockItems: Item[] = [{ id: "1", name: "Default" }];

export function resetMockItems(): void {
  mockItems = [{ id: "1", name: "Default" }];
}

export const itemHandlers = [
  http.get("/api/items", () => {
    return HttpResponse.json({ items: mockItems });
  }),

  http.post("/api/items", async ({ request }) => {
    const body = (await request.json()) as { name: string };
    const newItem = { id: crypto.randomUUID(), name: body.name };
    mockItems.push(newItem);
    return HttpResponse.json(newItem, { status: 201 });
  }),

  http.delete("/api/items/:id", ({ params }) => {
    const { id } = params;
    mockItems = mockItems.filter((item) => item.id !== id);
    return new HttpResponse(null, { status: 204 });
  }),
];
```

#### Handler with Request Inspection

For endpoints that need to check query params or request body:

```typescript
http.get("*/api/logs", ({ request }) => {
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");

  if (!cursor) {
    return HttpResponse.json({
      data: [{ id: "run_1" }],
      pagination: { hasMore: true, nextCursor: "run_1" },
    });
  }
  return HttpResponse.json({
    data: [{ id: "run_2" }],
    pagination: { hasMore: false, nextCursor: null },
  });
});
```

### Handler Aggregation

All handlers are collected in `handlers/index.ts`:

```typescript
import { apiModelProvidersHandlers, resetMockModelProviders } from "./api-model-providers";
import { apiScopeHandlers } from "./api-scope";

export const handlers = [
  ...apiModelProvidersHandlers,
  ...apiScopeHandlers,
];

export function resetAllMockHandlers(): void {
  resetMockModelProviders();
  // Add other reset functions as needed
}
```

## External Network Requests

**Platform tests do not allow any external network requests.** This is enforced through MSW configuration.

### Default Configuration

The global test setup (`test/setup.ts`) configures MSW to handle unmatched requests:

```typescript
beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});

afterEach(() => server.resetHandlers());

afterAll(() => server.close());
```

### Shared Happy Path Handlers

Default handlers in `mocks/handlers/` provide working responses for most tests. These represent the "happy path" - a typical user with valid data.

### Overriding API Behavior in Tests

Use `server.use()` to override handlers for specific test scenarios:

```typescript
import { server } from "../../../mocks/server";
import { http, HttpResponse } from "msw";

it("should show error when API returns 404", async () => {
  // Override the default handler for this test only
  server.use(
    http.get("/api/scope", () => {
      return new HttpResponse(null, { status: 404 });
    }),
  );

  await setupPage({ context, path: "/" });

  expect(screen.getByText("Not found")).toBeInTheDocument();
});

it("should handle empty list", async () => {
  server.use(
    http.get("/api/items", () => {
      return HttpResponse.json({ items: [] });
    }),
  );

  await setupPage({ context, path: "/items" });

  expect(screen.getByText("No items found")).toBeInTheDocument();
});
```

### Tracking Request Data

Capture request data to verify what was sent:

```typescript
it("should send correct data when saving", async () => {
  let capturedBody: unknown = null;

  server.use(
    http.put("/api/items", async ({ request }) => {
      capturedBody = await request.json();
      return HttpResponse.json({ id: "1" }, { status: 200 });
    }),
  );

  await setupPage({ context, path: "/" });

  await user.type(screen.getByRole("textbox"), "New Item");
  await user.click(screen.getByRole("button", { name: "Save" }));

  await vi.waitFor(() => {
    expect(capturedBody).toEqual({ name: "New Item" });
  });
});
```

### Overriding Multiple Endpoints

Override multiple endpoints when testing complex flows:

```typescript
it("should complete onboarding flow", async () => {
  server.use(
    http.get("/api/scope", () => {
      return new HttpResponse(null, { status: 404 });
    }),
    http.post("/api/scope", () => {
      return HttpResponse.json({}, { status: 201 });
    }),
    http.put("/api/settings", () => {
      return HttpResponse.json({ success: true });
    }),
  );

  await setupPage({ context, path: "/" });
  // Test onboarding flow...
});
```

## Test Context

The `testContext()` function provides automatic cleanup and isolation:

```typescript
import { testContext } from "../signals/__tests__/test-helpers";

const context = testContext();

describe("MyFeature", () => {
  it("test case", async () => {
    const { store, signal } = context;
    // store and signal are fresh for each test
  });
});
```

Features:
- Creates fresh store for each test
- Provides AbortSignal for cleanup
- Automatically resets mock handlers after each test
- Cleans up localStorage mocks

## setupPage Options

```typescript
await setupPage({
  context,                    // Required: test context
  path: "/dashboard",         // Required: initial route

  // Optional: override authenticated user
  user: { id: "user-1", fullName: "Test User" },
  session: { token: "test-token" },

  // Optional: set user to null for unauthenticated tests
  user: null,

  // Optional: enable debug loggers
  debugLoggers: ["router", "api"],

  // Optional: feature flags
  featureSwitches: { newFeature: true },
});
```

## Best Practices

1. **Use `vi.waitFor()` for async assertions** - UI updates happen asynchronously
2. **Override only what you need** - Let default handlers provide the happy path
3. **Reset handlers automatically** - `afterEach(() => server.resetHandlers())` is in global setup
4. **Use factories for complex mock data** - Create helper functions for repetitive mock responses
5. **Test user flows, not implementation** - Focus on what users see and do
6. **Capture request data when needed** - Verify correct data is sent to APIs
