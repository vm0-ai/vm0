import { initContract } from "@ts-rest/core";
import { computed } from "ccstate";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { contractRoute } from "../signals/route";
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
});

describe("createApp", () => {
  const context = testContext();

  it("captures unhandled errors and returns a sanitized response", async () => {
    const error = new Error("boom");
    const client = setupApp({
      context,
      contract: errorTestContract,
      routesExtend: [
        contractRoute({
          contract: errorTestContract.boom,
          handler: computed((): never => {
            throw error;
          }),
        }),
      ],
    });

    const response = await accept(client.boom(), [500]);

    expect(response.body).toEqual({ error: "Internal server error" });
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(error);
  });

  it("passes through expected HTTP client errors without capturing them", async () => {
    const error = new HTTPException(404, { message: "Missing" });
    const client = setupApp({
      context,
      contract: errorTestContract,
      routesExtend: [
        contractRoute({
          contract: errorTestContract.missing,
          handler: computed((): never => {
            throw error;
          }),
        }),
      ],
    });

    await accept(client.missing(), [404]);

    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("captures HTTP server errors while preserving their response", async () => {
    const error = new HTTPException(503, { message: "Unavailable" });
    const client = setupApp({
      context,
      contract: errorTestContract,
      routesExtend: [
        contractRoute({
          contract: errorTestContract.unavailable,
          handler: computed((): never => {
            throw error;
          }),
        }),
      ],
    });

    await accept(client.unavailable(), [503]);

    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(error);
  });
});
