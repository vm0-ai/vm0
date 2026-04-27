import { initContract } from "@ts-rest/core";
import { command, computed } from "ccstate";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { ROUTES } from "../../route";

const context = testContext();
const c = initContract();

const routeTestContract = c.router({
  computed: {
    method: "GET",
    path: "/__test/computed",
    responses: {
      200: z.object({ ok: z.literal(true) }),
    },
  },
  command: {
    method: "GET",
    path: "/__test/command",
    responses: {
      200: z.object({
        aborted: z.boolean(),
        sameSignal: z.boolean(),
      }),
    },
  },
  post: {
    method: "POST",
    path: "/__test/post",
    body: z.object({
      enabled: z.boolean(),
    }),
    responses: {
      200: z.object({
        ok: z.literal(true),
      }),
    },
  },
});

describe("honoSignalHandler", () => {
  it("reads computed handlers", async () => {
    const handler$ = computed(() => {
      return { status: 200 as const, body: { ok: true as const } };
    });
    const client = setupApp({
      context,
      routes: [
        ...ROUTES,
        { route: routeTestContract.computed, handler: handler$ },
      ],
    })(routeTestContract);

    const response = await accept(client.computed(), [200]);

    expect(response.body).toEqual({ ok: true });
  });

  it("sets command handlers with the instance signal", async () => {
    const handler$ = command((_visitor, signal: AbortSignal) => {
      return {
        status: 200 as const,
        body: {
          aborted: signal.aborted,
          sameSignal: signal === context.signal,
        },
      };
    });
    const client = setupApp({
      context,
      routes: [
        ...ROUTES,
        { route: routeTestContract.command, handler: handler$ },
      ],
    })(routeTestContract);

    const response = await accept(client.command(), [200]);

    expect(response.body).toEqual({ aborted: false, sameSignal: true });
  });

  it("registers non-GET handlers", async () => {
    const handler$ = computed(() => {
      return { status: 200 as const, body: { ok: true as const } };
    });
    const client = setupApp({
      context,
      routes: [...ROUTES, { route: routeTestContract.post, handler: handler$ }],
    })(routeTestContract);

    const response = await accept(
      client.post({ body: { enabled: true } }),
      [200],
    );

    expect(response.body).toEqual({ ok: true });
  });
});
