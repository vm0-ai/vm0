import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/nextjs";
import type { TsRestRequest } from "@ts-rest/serverless";
import type { AppRouter } from "@ts-rest/core";

vi.mock("@sentry/nextjs", () => {
  return {
    captureException: vi.fn(),
    flush: vi.fn().mockResolvedValue(true),
  };
});

// Capture the errorHandler passed to createNextHandler so tests can invoke it
// directly without spinning up a real Next.js server. Return type mirrors the
// real resolver so tests can access `.status` / `.json()` without casts.
type ResolvedErrorHandler = (
  err: unknown,
  req: TsRestRequest,
) =>
  | InstanceType<typeof TsRestResponse>
  | void
  | Promise<InstanceType<typeof TsRestResponse> | void>;
let capturedErrorHandler: ResolvedErrorHandler | undefined;

vi.mock("@ts-rest/serverless/next", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@ts-rest/serverless/next")>();
  return {
    ...original,
    createNextHandler: (
      _contract: AppRouter,
      _router: unknown,
      options: { errorHandler?: ResolvedErrorHandler },
    ) => {
      capturedErrorHandler = options.errorHandler;
      // Return a no-op handler — tests only exercise the errorHandler
      return () => {
        return Promise.resolve(new Response());
      };
    },
  };
});

import { initContract } from "@ts-rest/core";
import { z } from "zod";
import {
  createSafeErrorHandler,
  createHandler,
  tsr,
  TsRestResponse,
} from "../ts-rest-handler";
import {
  badRequest,
  notFound,
  forbidden,
  providerIncompatible,
} from "../shared/errors";

describe("createSafeErrorHandler", () => {
  const handler = createSafeErrorHandler("test-route");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return correct status for BadRequestError", async () => {
    const response = handler(badRequest("Missing org context"));
    expect(response).toBeDefined();
    expect(response!.status).toBe(400);
    const body = await response!.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Missing org context");
  });

  it("should return correct status for NotFoundError", async () => {
    const response = handler(notFound("Resource not found"));
    expect(response).toBeDefined();
    expect(response!.status).toBe(404);
    const body = await response!.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Resource not found");
  });

  it("should return correct status for ForbiddenError", async () => {
    const response = handler(forbidden("Access denied"));
    expect(response).toBeDefined();
    expect(response!.status).toBe(403);
    const body = await response!.json();
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Access denied");
  });

  it("should return correct status for ProviderIncompatibleError (required-message factory)", async () => {
    const response = handler(providerIncompatible("Provider mismatch"));
    expect(response).toBeDefined();
    expect(response!.status).toBe(400);
    const body = await response!.json();
    expect(body.error.code).toBe("PROVIDER_INCOMPATIBLE");
    expect(body.error.message).toBe("Provider mismatch");
  });

  it("should return 500 with generic message for unknown errors", async () => {
    const response = handler(new Error("database connection failed"));
    expect(response).toBeDefined();
    expect(response!.status).toBe(500);
    const body = await response!.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).not.toContain("database");
  });

  it("does not report typed ApiError (4xx) to Sentry", async () => {
    const response = handler(badRequest("invalid input"));
    expect(response).toBeDefined();
    expect(response!.status).toBe(400);
    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
  });

  it("reports unknown 5xx errors to Sentry with route tag and returns 500", async () => {
    const err = new Error("db timeout");
    const response = handler(err);
    expect(response).toBeDefined();
    expect(response!.status).toBe(500);
    const body = await response!.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(err, {
      mechanism: { type: "ts-rest-handler", handled: true },
      captureContext: { tags: { route: "test-route" } },
    });
  });

  it("maps malformed JSON body SyntaxError to 400 without Sentry", async () => {
    const err = new SyntaxError("Bad escaped character in JSON at position 18");
    const response = handler(err);
    expect(response).toBeDefined();
    expect(response!.status).toBe(400);
    const body = await response!.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Invalid JSON in request body");
    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
  });
});

describe("createHandler per-operation dispatch", () => {
  // Minimal two-operation contract: one GET (list) and one POST (create).
  const c = initContract();
  const twoOpContract = c.router({
    list: {
      method: "GET",
      path: "/api/test",
      responses: { 200: z.object({ items: z.array(z.string()) }) },
    },
    create: {
      method: "POST",
      path: "/api/test",
      body: z.object({ name: z.string() }),
      responses: { 201: z.object({ id: z.string() }) },
    },
  });

  // Minimal router stubs — createNextHandler is mocked so these are never called.
  const router = tsr.router(twoOpContract, {
    list: async () => {
      return { status: 200 as const, body: { items: [] } };
    },
    create: async () => {
      return { status: 201 as const, body: { id: "x" } };
    },
  });

  beforeEach(() => {
    capturedErrorHandler = undefined;
  });

  it("routes GET errors to the list operation handler", async () => {
    createHandler(twoOpContract, router, { routeName: "test" });
    expect(capturedErrorHandler).toBeDefined();

    const fakeReq = { method: "GET", route: "/api/test" } as TsRestRequest;
    const err = new Error("list failure");
    const response = await capturedErrorHandler!(err, fakeReq);
    expect(response).toBeDefined();
    // Sentry tag should carry the per-operation route name
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(err, {
      mechanism: { type: "ts-rest-handler", handled: true },
      captureContext: { tags: { route: "test.list" } },
    });
  });

  it("routes POST errors to the create operation handler", async () => {
    createHandler(twoOpContract, router, { routeName: "test" });
    expect(capturedErrorHandler).toBeDefined();

    const fakeReq = { method: "POST", route: "/api/test" } as TsRestRequest;
    const err = new Error("create failure");
    const response = await capturedErrorHandler!(err, fakeReq);
    expect(response).toBeDefined();
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(err, {
      mechanism: { type: "ts-rest-handler", handled: true },
      captureContext: { tags: { route: "test.create" } },
    });
  });

  it("falls back to base routeName when operation is not found in the map", async () => {
    createHandler(twoOpContract, router, { routeName: "test" });
    expect(capturedErrorHandler).toBeDefined();

    const fakeReq = {
      method: "DELETE",
      route: "/api/unknown",
    } as TsRestRequest;
    const err = new Error("unknown failure");
    await capturedErrorHandler!(err, fakeReq);
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(err, {
      mechanism: { type: "ts-rest-handler", handled: true },
      captureContext: { tags: { route: "test" } },
    });
  });

  it("uses custom errorHandler response as-is when it returns a response", async () => {
    const fakeResponse = TsRestResponse.fromJson(
      { error: { message: "custom", code: "CUSTOM" } },
      { status: 418 },
    );
    const customHandler = vi.fn().mockReturnValue(fakeResponse);
    createHandler(twoOpContract, router, {
      routeName: "test",
      errorHandler: customHandler,
    });
    expect(capturedErrorHandler).toBeDefined();

    const fakeReq = { method: "GET", route: "/api/test" } as TsRestRequest;
    const err = new Error("custom error");
    const response = await capturedErrorHandler!(err, fakeReq);
    expect(customHandler).toHaveBeenCalledWith(err);
    expect(response).toBe(fakeResponse);
    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
  });
});

describe("createHandler custom errorHandler fall-through", () => {
  const c2 = initContract();
  const singleOpContract = c2.router({
    show: {
      method: "GET",
      path: "/api/thing/:id",
      pathParams: z.object({ id: z.string() }),
      responses: { 200: z.object({ id: z.string() }) },
    },
  });

  const singleOpRouter = tsr.router(singleOpContract, {
    show: async ({ params }) => {
      return { status: 200 as const, body: { id: params.id } };
    },
  });

  // Simulates the pattern used in all 28 real routes: handle pathParamsError,
  // otherwise return undefined (the "delegate to default" signal).
  const validationOnlyHandler = (err: unknown): TsRestResponse | void => {
    if (err && typeof err === "object" && "pathParamsError" in err) {
      return TsRestResponse.fromJson(
        { error: { message: "bad id", code: "BAD_REQUEST" } },
        { status: 400 },
      );
    }
    return undefined;
  };

  beforeEach(() => {
    capturedErrorHandler = undefined;
    vi.clearAllMocks();
  });

  it("delegates ApiError to defaultHandler (404 with proper code, no Sentry)", async () => {
    createHandler(singleOpContract, singleOpRouter, {
      routeName: "thing.show",
      errorHandler: validationOnlyHandler,
    });
    expect(capturedErrorHandler).toBeDefined();

    const fakeReq = {
      method: "GET",
      route: "/api/thing/:id",
    } as TsRestRequest;
    const err = notFound("Agent compose not found");

    const response = await capturedErrorHandler!(err, fakeReq);

    expect(response).toBeDefined();
    expect(response!.status).toBe(404);
    const body = await response!.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Agent compose not found");
    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
  });

  it("delegates raw Error to defaultHandler (500 + Sentry capture)", async () => {
    createHandler(singleOpContract, singleOpRouter, {
      routeName: "thing.show",
      errorHandler: validationOnlyHandler,
    });
    expect(capturedErrorHandler).toBeDefined();

    const fakeReq = {
      method: "GET",
      route: "/api/thing/:id",
    } as TsRestRequest;
    const err = new Error("db connection lost");

    const response = await capturedErrorHandler!(err, fakeReq);

    expect(response).toBeDefined();
    expect(response!.status).toBe(500);
    const body = await response!.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(err, {
      mechanism: { type: "ts-rest-handler", handled: true },
      captureContext: { tags: { route: "thing.show" } },
    });
  });

  it("custom handler still wins when it returns a response (validation errors)", async () => {
    createHandler(singleOpContract, singleOpRouter, {
      routeName: "thing.show",
      errorHandler: validationOnlyHandler,
    });
    expect(capturedErrorHandler).toBeDefined();

    const fakeReq = {
      method: "GET",
      route: "/api/thing/:id",
    } as TsRestRequest;
    const validationErr = {
      pathParamsError: {
        issues: [{ path: ["id"], message: "required" }],
      },
    };

    const response = await capturedErrorHandler!(validationErr, fakeReq);

    expect(response).toBeDefined();
    expect(response!.status).toBe(400);
    const body = await response!.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("bad id");
    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
  });
});
