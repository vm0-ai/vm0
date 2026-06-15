# App Testing Patterns

This document describes the testing patterns for `turbo/apps/platform`.

## Test Category

App Vitest tests are page-level tests only:

| Type       | Location | Suffix                 | Purpose                             |
| ---------- | -------- | ---------------------- | ----------------------------------- |
| Page Tests | `views/` | `.test.tsx`/`.test.ts` | Test user interactions and UI state |

Do not add signal, parser, helper, static config, or component-only unit tests
under `turbo/apps/platform`. Cover behavior through a rendered page. If behavior
has no user-visible page surface, do not add a platform Vitest test for it.

## Page Tests

Page tests are placed in `views/` directories with `.test.tsx` or `.test.ts`
suffix. They must enter through `detachedSetupPage` and assert on page-visible
behavior. Configure test-specific mocks through `context.mocks` before setup so
mock handlers and browser mocks share the same test lifecycle signal.

```typescript
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers";
import { detachedSetupPage } from "../../../__tests__/page-helper";

const context = testContext();
const user = userEvent.setup();

describe("ComponentName", () => {
  it("should do something when user clicks button", async () => {
    detachedSetupPage({
      context,
      path: "/page-path",
    });

    // Find UI elements
    const button = screen.getByRole("button", { name: "Submit" });

    // Perform user interactions
    await user.click(button);

    // Verify UI state after interaction
    await waitFor(() => {
      expect(screen.getByText("Success")).toBeInTheDocument();
    });
  });
});
```

Setup helpers always render the page. Page setup may start long polling flows,
so tests should call `detachedSetupPage` without awaiting it and then wait for
the rendered page state that matters to the story.

## Mock Infrastructure

### Directory Structure

```
turbo/apps/platform/src/
├── mocks/
│   ├── server.ts          # MSW server setup for Node.js
│   └── handlers/
│       ├── index.ts       # Aggregates all handlers
│       ├── api-org.ts     # Org API handlers
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

export const apiOrgHandlers = [
  http.get("/api/org", () => {
    return HttpResponse.json({
      id: "org_1",
      slug: "user-12345678",
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
import {
  apiModelProvidersHandlers,
  resetMockModelProviders,
} from "./api-model-providers";
import { apiOrgHandlers } from "./api-org";

export const handlers = [...apiModelProvidersHandlers, ...apiOrgHandlers];

export function resetAllMockHandlers(): void {
  resetMockModelProviders();
  // Add other reset functions as needed
}
```

## External Network Requests

**App tests do not allow any external network requests.** This is enforced through MSW configuration.

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

Use `context.mocks.api()` or `context.mocks.http()` to override handlers for
specific test scenarios. Do not import MSW or call `server.use()` from page
tests directly.

```typescript
import { HttpResponse } from "msw";
import { apiContract } from "@vm0/api-contract";

it("should show error when API returns 404", async () => {
  context.mocks.api(apiContract.org.getOrg, () => {
    return new HttpResponse(null, { status: 404 });
  });

  detachedSetupPage({ context, path: "/" });

  expect(screen.getByText("Not found")).toBeInTheDocument();
});

it("should handle empty list", async () => {
  context.mocks.http.get("/api/items", () => {
    return HttpResponse.json({ items: [] });
  });

  detachedSetupPage({ context, path: "/items" });

  expect(screen.getByText("No items found")).toBeInTheDocument();
});
```

### Tracking Request Data

Capture request data to verify what was sent:

```typescript
it("should send correct data when saving", async () => {
  let capturedBody: unknown = null;

  context.mocks.http.put("/api/items", async ({ request }) => {
    capturedBody = await request.json();
    return HttpResponse.json({ id: "1" }, { status: 200 });
  });

  detachedSetupPage({ context, path: "/" });

  await user.type(screen.getByRole("textbox"), "New Item");
  await user.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => {
    expect(capturedBody).toEqual({ name: "New Item" });
  });
});
```

### Overriding Multiple Endpoints

Override multiple endpoints when testing complex flows:

```typescript
it("should complete onboarding flow", async () => {
  context.mocks.http.get("/api/org", () => {
    return new HttpResponse(null, { status: 404 });
  });
  context.mocks.http.post("/api/org", () => {
    return HttpResponse.json({}, { status: 201 });
  });
  context.mocks.http.put("/api/settings", () => {
    return HttpResponse.json({ success: true });
  });

  detachedSetupPage({ context, path: "/" });
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
    const { mocks, signal } = context;
    // mocks and signal are scoped to the current test lifecycle
  });
});
```

Features:

- Creates fresh store for each test
- Provides AbortSignal for cleanup
- Provides `context.mocks` for API, browser, upload, Ably, and test data mocks
- Automatically resets mock handlers after each test
- Cleans up localStorage mocks

## setupPage Options

```typescript
detachedSetupPage({
  context, // Required: test context
  path: "/dashboard", // Required: initial route

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

1. **Use `waitFor()` for async assertions** - UI updates happen asynchronously
2. **Override only what you need** - Let default handlers provide the happy path
3. **Mock through `context.mocks`** - Test mocks should share the page setup signal
4. **Use factories for complex mock data** - Create helper functions for repetitive mock responses
5. **Test user flows, not implementation** - Focus on what users see and do
6. **Capture request data when needed** - Verify correct data is sent to APIs
