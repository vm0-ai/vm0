# API Mocking with MSW

This app uses [Mock Service Worker (MSW)](https://mswjs.io/) for API mocking in tests and development.

## Overview

MSW intercepts HTTP requests at the network level, providing realistic API mocking without changing application code. This enables:

- **Testing**: Mock API responses in unit and integration tests
- **Development**: Work offline or with unstable backend services
- **Prototyping**: Build features before APIs are ready

## Directory Structure

```
src/mocks/
├── browser.ts          # Browser (Service Worker) setup for development
├── server.ts           # Node.js server setup for testing
└── handlers/
    ├── index.ts        # Aggregates all handlers
    └── example.ts      # Example API handlers
```

## Usage in Tests

MSW is automatically configured in `src/test/setup.ts`. All tests have access to mocked APIs without additional setup.

### Using Default Handlers

```typescript
import { describe, it, expect } from "vitest";

describe("API tests", () => {
  it("should fetch users", async () => {
    const response = await fetch("/api/users");
    const users = await response.json();

    expect(users).toHaveLength(2);
  });
});
```

### Overriding Handlers for Specific Tests

Use `server.use()` to override handlers for specific test cases:

```typescript
import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server.ts";

describe("Error handling", () => {
  it("should handle server errors", async () => {
    // Override the default handler for this test only
    server.use(
      http.get("/api/users", () => {
        return HttpResponse.json(
          { error: "internal_error", message: "Database unavailable" },
          { status: 500 },
        );
      }),
    );

    const response = await fetch("/api/users");

    expect(response.status).toBe(500);
  });
});
```

## Usage in Development (Optional)

To enable API mocking in the browser during development:

### 1. Generate Service Worker

Run this once to create the service worker file:

```bash
npx msw init ./public --save
```

### 2. Start the Worker

Update `src/main.ts` to conditionally start MSW in development:

```typescript
async function enableMocking() {
  if (import.meta.env.DEV) {
    const { worker } = await import("./mocks/browser.ts");
    return worker.start({
      onUnhandledRequest: "bypass", // Don't warn about unhandled requests
    });
  }
}

enableMocking().then(() => {
  // Your app initialization code
});
```

## Creating New Handlers

### 1. Create Handler File

Create a new file in `src/mocks/handlers/`:

```typescript
// src/mocks/handlers/products.ts
import { http, HttpResponse } from "msw";

export interface Product {
  id: string;
  name: string;
  price: number;
}

const mockProducts: Product[] = [
  { id: "1", name: "Widget", price: 9.99 },
  { id: "2", name: "Gadget", price: 19.99 },
];

export const productHandlers = [
  http.get("/api/products", () => {
    return HttpResponse.json(mockProducts);
  }),

  http.get("/api/products/:id", ({ params }) => {
    const product = mockProducts.find((p) => p.id === params.id);
    if (!product) {
      return HttpResponse.json({ error: "not_found" }, { status: 404 });
    }
    return HttpResponse.json(product);
  }),
];
```

### 2. Register Handlers

Add handlers to `src/mocks/handlers/index.ts`:

```typescript
import { exampleHandlers } from "./example.ts";
import { productHandlers } from "./products.ts";

export const handlers = [...exampleHandlers, ...productHandlers];
```

## Best Practices

1. **Keep handlers realistic**: Return data structures that match your actual API
2. **Test error scenarios**: Create handlers for 400, 404, 500 responses
3. **Use TypeScript**: Define types for request/response bodies
4. **Isolate test data**: Override handlers in tests rather than mutating shared mock data
5. **Don't mock everything**: Use `onUnhandledRequest: "bypass"` to let real requests through

## API Reference

See the [MSW documentation](https://mswjs.io/docs/) for:

- [Request matching](https://mswjs.io/docs/concepts/request-matching)
- [Response resolvers](https://mswjs.io/docs/concepts/response-resolver)
- [Network behavior](https://mswjs.io/docs/recipes/network-behavior)
