import {
  addClientCapabilityToVersion,
  CLIENT_CAPABILITY_STRUCTURED_FEEDBACK_PARTS,
  CLIENT_VERSION_HEADER,
} from "@vm0/api-contracts/contracts/client-headers";
import { initContract } from "@vm0/api-contracts/contracts/trpc-contract";
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
  responseLike: {
    method: "GET",
    path: "/__test/response-like",
    responses: {
      200: z.object({
        ok: z.literal(true),
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
  structured: {
    method: "GET",
    path: "/__test/structured",
    responses: {
      200: z.object({
        content: z.string(),
        userMessage: z.unknown().optional(),
      }),
    },
  },
});

const userMessageFeedbackDocument = {
  version: 1,
  parts: [
    {
      type: "feedback",
      quote: "The button is hard to find",
      note: [{ type: "text", text: "Increase the contrast" }],
    },
  ],
} as const;

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

    expect(response.body).toStrictEqual({ ok: true });
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

    expect(response.body).toStrictEqual({ aborted: false, sameSignal: true });
  });

  it("returns response-like objects without contract validation", async () => {
    const handler$ = computed(() => {
      const response = Response.json(
        { ok: true as const },
        { headers: { "x-test-response": "preserved" } },
      );
      return {
        arrayBuffer: response.arrayBuffer.bind(response),
        blob: response.blob.bind(response),
        body: response.body,
        clone: response.clone.bind(response),
        formData: response.formData.bind(response),
        headers: response.headers,
        json: response.json.bind(response),
        status: response.status,
        statusText: response.statusText,
        text: response.text.bind(response),
      };
    });
    const client = setupApp({
      context,
      routes: [
        ...ROUTES,
        { route: routeTestContract.responseLike, handler: handler$ },
      ],
    })(routeTestContract);

    const response = await accept(client.responseLike(), [200]);

    expect(response.body).toStrictEqual({ ok: true });
    expect(response.headers.get("x-test-response")).toBe("preserved");
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

    expect(response.body).toStrictEqual({ ok: true });
  });

  it("hides feedback parts from clients without the capability", async () => {
    const handler$ = computed(() => {
      return {
        status: 200 as const,
        body: {
          content: "The button is hard to find\nIncrease the contrast",
          userMessage: userMessageFeedbackDocument,
        },
      };
    });
    const client = setupApp({
      context,
      routes: [
        ...ROUTES,
        { route: routeTestContract.structured, handler: handler$ },
      ],
    })(routeTestContract);

    const legacyResponse = await accept(
      client.structured({
        extraHeaders: { [CLIENT_VERSION_HEADER]: "0.636.1" },
      }),
      [200],
    );
    expect(legacyResponse.body).toStrictEqual({
      content: "The button is hard to find\nIncrease the contrast",
    });

    const capableVersion = addClientCapabilityToVersion(
      "0.636.1",
      CLIENT_CAPABILITY_STRUCTURED_FEEDBACK_PARTS,
    );
    const capableResponse = await accept(
      client.structured({
        extraHeaders: { [CLIENT_VERSION_HEADER]: capableVersion },
      }),
      [200],
    );
    expect(capableResponse.body).toStrictEqual({
      content: "The button is hard to find\nIncrease the contrast",
      userMessage: userMessageFeedbackDocument,
    });
  });
});
