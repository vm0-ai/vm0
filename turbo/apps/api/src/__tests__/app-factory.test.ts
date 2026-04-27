import { initContract } from "@ts-rest/core";
import { computed } from "ccstate";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { ROUTES } from "../signals/route";
import { accept, setupApp, testContext } from "./test-helpers";

const c = initContract();

const errorTestContract = c.router({
  boom: {
    method: "GET",
    path: "/__test/boom",
    responses: {
      500: z.object({ error: z.string() }),
    },
  },
  missing: {
    method: "GET",
    path: "/__test/missing",
    responses: {
      404: z.string(),
    },
  },
  unavailable: {
    method: "GET",
    path: "/__test/unavailable",
    responses: {
      503: z.string(),
    },
  },
  aborted: {
    method: "GET",
    path: "/__test/aborted",
    responses: {
      500: z.object({ error: z.string() }),
    },
  },
});

describe("createApp", () => {
  const context = testContext();

  it("captures unhandled errors and returns a sanitized response", async () => {
    const error = new Error("boom");
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [...ROUTES, { route: errorTestContract.boom, handler: handler$ }],
    })(errorTestContract);

    const response = await accept(client.boom(), [500]);

    expect(response.body).toEqual({ error: "Internal server error" });
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(error);
  });

  it("passes through expected HTTP client errors without capturing them", async () => {
    const error = new HTTPException(404, { message: "Missing" });
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...ROUTES,
        { route: errorTestContract.missing, handler: handler$ },
      ],
    })(errorTestContract);

    await accept(client.missing(), [404]);

    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("does not capture AbortError", async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...ROUTES,
        { route: errorTestContract.aborted, handler: handler$ },
      ],
    })(errorTestContract);

    await accept(client.aborted(), [500]);

    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("captures HTTP server errors while preserving their response", async () => {
    const error = new HTTPException(503, { message: "Unavailable" });
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...ROUTES,
        { route: errorTestContract.unavailable, handler: handler$ },
      ],
    })(errorTestContract);

    await accept(client.unavailable(), [503]);

    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(error);
  });
});
