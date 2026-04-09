import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { createPlainSupportThread } from "../plain-service";
import { server } from "../../../../mocks/server";
import { http } from "../../../../__tests__/msw";
import { reloadEnv } from "../../../../env";

const PLAIN_API_URL = "https://core-api.uk.plain.com/graphql/v1";

const defaultParams = {
  userId: "user-123",
  userEmail: "user@example.com",
  orgId: "org-456",
  orgName: "Acme Corp",
  runId: "run-789",
  title: "App is crashing",
  description: "Here is what happened",
  reference: "ds-abc123",
  downloadUrl: "https://s3.example.com/bundle.zip",
  expiresAt: "2026-05-09",
  emailSubjectPrefix: "[DS]",
};

// Helper: build a successful GraphQL mutation response for each step
function tenantSuccess() {
  return HttpResponse.json({
    data: {
      upsertTenant: {
        tenant: { id: "tenant-1", externalId: "org-456", name: "Acme Corp" },
        error: null,
      },
    },
  });
}

function customerSuccess() {
  return HttpResponse.json({
    data: {
      upsertCustomer: {
        customer: { id: "customer-1", externalId: "user-123" },
        result: "CREATED",
        error: null,
      },
    },
  });
}

function threadSuccess() {
  return HttpResponse.json({
    data: {
      createThread: {
        thread: { id: "thread-1", externalId: "ds-abc123" },
        error: null,
      },
    },
  });
}

function threadEventSuccess() {
  return HttpResponse.json({
    data: {
      createThreadEvent: {
        threadEvent: { id: "event-1" },
        error: null,
      },
    },
  });
}

// Helper: build a mutation-level error response (matches PlainMutationResponse Zod schema)
function mutationError(operationKey: string) {
  return HttpResponse.json({
    data: {
      [operationKey]: {
        error: {
          __typename: "MutationError",
          type: "FORBIDDEN",
          code: "forbidden",
          message: "You are not authorized to perform this action",
          fields: [],
        },
      },
    },
  });
}

// Stub PLAIN_API_KEY before each test and reload env cache so env() picks it up
beforeEach(() => {
  vi.stubEnv("PLAIN_API_KEY", "plainkey_test_123");
  reloadEnv();
});

describe("createPlainSupportThread", () => {
  it("returns false when PLAIN_API_KEY is not set", async () => {
    vi.stubEnv("PLAIN_API_KEY", "");
    reloadEnv();

    const result = await createPlainSupportThread(defaultParams);

    expect(result).toBe(false);
  });

  it("returns true and creates all four Plain API steps on success", async () => {
    let callCount = 0;
    const handler = http.post(PLAIN_API_URL, () => {
      callCount++;
      if (callCount === 1) return tenantSuccess();
      if (callCount === 2) return customerSuccess();
      if (callCount === 3) return threadSuccess();
      return threadEventSuccess();
    });
    server.use(handler.handler);

    const result = await createPlainSupportThread(defaultParams);

    expect(result).toBe(true);
    expect(callCount).toBe(4);
  });

  it("returns false when upsertTenant fails with mutation error", async () => {
    const handler = http.post(PLAIN_API_URL, () => {
      return mutationError("upsertTenant");
    });
    server.use(handler.handler);

    const result = await createPlainSupportThread(defaultParams);

    expect(result).toBe(false);
  });

  it("returns false when upsertCustomer fails with mutation error", async () => {
    let callCount = 0;
    const handler = http.post(PLAIN_API_URL, () => {
      callCount++;
      if (callCount === 1) return tenantSuccess();
      return mutationError("upsertCustomer");
    });
    server.use(handler.handler);

    const result = await createPlainSupportThread(defaultParams);

    expect(result).toBe(false);
  });

  it("returns false when createThread fails with mutation error", async () => {
    let callCount = 0;
    const handler = http.post(PLAIN_API_URL, () => {
      callCount++;
      if (callCount === 1) return tenantSuccess();
      if (callCount === 2) return customerSuccess();
      return mutationError("createThread");
    });
    server.use(handler.handler);

    const result = await createPlainSupportThread(defaultParams);

    expect(result).toBe(false);
  });

  it("returns false when createThreadEvent fails with mutation error", async () => {
    let callCount = 0;
    const handler = http.post(PLAIN_API_URL, () => {
      callCount++;
      if (callCount === 1) return tenantSuccess();
      if (callCount === 2) return customerSuccess();
      if (callCount === 3) return threadSuccess();
      return mutationError("createThreadEvent");
    });
    server.use(handler.handler);

    const result = await createPlainSupportThread(defaultParams);

    expect(result).toBe(false);
  });

  it("returns false when the API returns a 401 forbidden response", async () => {
    const handler = http.post(PLAIN_API_URL, () => {
      return HttpResponse.json(
        {
          errors: [
            {
              message: "Authentication failed",
              locations: [],
              extensions: { code: "UNAUTHENTICATED" },
            },
          ],
        },
        { status: 401 },
      );
    });
    server.use(handler.handler);

    const result = await createPlainSupportThread(defaultParams);

    expect(result).toBe(false);
  });

  it("includes description as first event component when provided", async () => {
    const capturedBodies: unknown[] = [];
    let callCount = 0;
    const handler = http.post(PLAIN_API_URL, async ({ request }) => {
      callCount++;
      const body = await request.json();
      capturedBodies.push(body);
      if (callCount === 1) return tenantSuccess();
      if (callCount === 2) return customerSuccess();
      if (callCount === 3) return threadSuccess();
      return threadEventSuccess();
    });
    server.use(handler.handler);

    await createPlainSupportThread({
      ...defaultParams,
      description: "This is the description",
    });

    // The 4th call is createThreadEvent — its components should start with the description.
    // uiComponent.text() returns { componentText: { text, textColor, textSize } }
    const eventBody = capturedBodies[3] as {
      variables: {
        input: { components: Array<{ componentText?: { text: string } }> };
      };
    };
    expect(eventBody.variables.input.components[0]?.componentText?.text).toBe(
      "This is the description",
    );
  });

  it("starts event components with Context header when description is undefined", async () => {
    const capturedBodies: unknown[] = [];
    let callCount = 0;
    const handler = http.post(PLAIN_API_URL, async ({ request }) => {
      callCount++;
      const body = await request.json();
      capturedBodies.push(body);
      if (callCount === 1) return tenantSuccess();
      if (callCount === 2) return customerSuccess();
      if (callCount === 3) return threadSuccess();
      return threadEventSuccess();
    });
    server.use(handler.handler);

    await createPlainSupportThread({
      ...defaultParams,
      description: undefined,
    });

    // Without description, first component is the "Context" section header.
    // uiComponent.text() returns { componentText: { text, textColor, textSize } }
    const eventBody = capturedBodies[3] as {
      variables: {
        input: { components: Array<{ componentText?: { text: string } }> };
      };
    };
    expect(eventBody.variables.input.components[0]?.componentText?.text).toBe(
      "Context",
    );
  });
});
