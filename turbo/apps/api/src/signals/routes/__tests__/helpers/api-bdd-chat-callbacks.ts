import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { pushSubscriptionsContract } from "@vm0/api-contracts/contracts/push-subscriptions";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { z } from "zod";

import { createApp } from "../../../../app-factory";
import { mockOptionalEnv } from "../../../../lib/env";
import { nowDate } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

const CHAT_CALLBACK_PATH = "/api/internal/callbacks/chat";
const CHAT_CALLBACK_URL = `http://localhost:3000${CHAT_CALLBACK_PATH}`;
const OPENROUTER_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";

type OrgModelPolicies = z.infer<
  (typeof zeroModelPoliciesMainContract.update)["body"]
>["policies"];

interface CapturedChatCallbackDelivery {
  readonly body: string;
  readonly headers: Record<string, string>;
}

const openRouterCompletionBodySchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

type OpenRouterCompletionBody = z.infer<typeof openRouterCompletionBodySchema>;

interface StoredS3Object {
  readonly bucket: string;
  readonly key: string;
  readonly size: number;
}

interface AuthHeaders {
  readonly authorization?: string;
}

function authenticate(
  context: TestContext,
  actor: ApiTestUser | null,
): AuthHeaders {
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }

  createZeroRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandInput(command: unknown): Record<string, unknown> {
  if (isRecord(command) && isRecord(command.input)) {
    return command.input;
  }
  return {};
}

/**
 * Latest run-context snapshot the API ingested into the (mocked) Axiom
 * boundary for a run. The run-context read route queries this dataset back,
 * so replaying the captured ingest keeps the read API working without
 * fabricating snapshot data in tests.
 */
function capturedRunContextSnapshot(
  context: TestContext,
  runId: string,
): readonly Record<string, unknown>[] {
  const calls = context.mocks.axiom.ingest.mock.calls;
  for (let index = calls.length - 1; index >= 0; index--) {
    const call = calls[index];
    if (!call || call[0] !== "run-context" || !Array.isArray(call[1])) {
      continue;
    }
    const events: readonly unknown[] = call[1];
    const snapshot = events.find((entry): entry is Record<string, unknown> => {
      return isRecord(entry) && entry.runId === runId;
    });
    if (snapshot) {
      return [snapshot];
    }
  }
  return [];
}

export function createChatCallbacksApi(context: TestContext) {
  function featureSwitchesClient() {
    return setupApp({ context })(zeroFeatureSwitchesContract);
  }

  function pushSubscriptionsClient() {
    return setupApp({ context })(pushSubscriptionsContract);
  }

  function modelPoliciesClient() {
    return setupApp({ context })(zeroModelPoliciesMainContract);
  }

  return {
    /**
     * Forwards real dispatcher deliveries of the chat callback into the Hono
     * app and records every delivery so chains can assert what the dispatcher
     * actually sent (status, payload, signature headers).
     */
    proxyChatCallbackToApp(): readonly CapturedChatCallbackDelivery[] {
      const deliveries: CapturedChatCallbackDelivery[] = [];
      server.use(
        http.post(CHAT_CALLBACK_URL, async ({ request }) => {
          const body = await request.text();
          deliveries.push({
            body,
            headers: Object.fromEntries(request.headers.entries()),
          });
          const app = createApp({ signal: context.signal });
          return await app.request(CHAT_CALLBACK_PATH, {
            method: "POST",
            headers: request.headers,
            body,
          });
        }),
      );
      return deliveries;
    },

    /**
     * Records dispatcher deliveries without letting them reach the route
     * (responds 500, marking the callback row failed). The captured raw body
     * and headers form a legitimately signed request that tests replay into
     * the app any number of times.
     */
    captureChatCallbackDeliveries(): readonly CapturedChatCallbackDelivery[] {
      const deliveries: CapturedChatCallbackDelivery[] = [];
      server.use(
        http.post(CHAT_CALLBACK_URL, async ({ request }) => {
          deliveries.push({
            body: await request.text(),
            headers: Object.fromEntries(request.headers.entries()),
          });
          return HttpResponse.json(
            { error: "captured for replay" },
            { status: 500 },
          );
        }),
      );
      return deliveries;
    },

    /**
     * Re-POSTs a captured delivery into the app verbatim. Callers drain
     * detached work themselves so parallel replays can race before draining.
     */
    async replayChatCallback(
      delivery: CapturedChatCallbackDelivery,
      overrides: { readonly signature?: string } = {},
    ): Promise<Response> {
      const headers: Record<string, string> = { ...delivery.headers };
      if (overrides.signature !== undefined) {
        headers["x-vm0-signature"] = overrides.signature;
      }
      const app = createApp({ signal: context.signal });
      return await app.request(CHAT_CALLBACK_PATH, {
        method: "POST",
        headers,
        body: delivery.body,
      });
    },

    /** Captured signature with one flipped hex character. */
    tamperedSignature(delivery: CapturedChatCallbackDelivery): string {
      const signature = delivery.headers["x-vm0-signature"] ?? "";
      const flipped = signature.startsWith("a") ? "b" : "a";
      return `${flipped}${signature.slice(1)}`;
    },

    async registerPushSubscription(actor: ApiTestUser): Promise<string> {
      const endpoint = `https://push.example.test/send/${randomUUID()}`;
      await accept(
        pushSubscriptionsClient().register({
          headers: authenticate(context, actor),
          body: {
            endpoint,
            keys: { p256dh: "bdd-p256dh", auth: "bdd-auth" },
          },
        }),
        [201],
      );
      return endpoint;
    },

    enableVapid(): void {
      mockOptionalEnv("VAPID_PUBLIC_KEY", "bdd-vapid-public-key");
      mockOptionalEnv("VAPID_PRIVATE_KEY", "bdd-vapid-private-key");
    },

    disableVapid(): void {
      mockOptionalEnv("VAPID_PUBLIC_KEY", undefined);
      mockOptionalEnv("VAPID_PRIVATE_KEY", undefined);
    },

    async enableChatRecommendedFollowups(actor: ApiTestUser): Promise<void> {
      await accept(
        featureSwitchesClient().update({
          headers: authenticate(context, actor),
          body: {
            switches: { [FeatureSwitchKey.ChatRecommendedFollowups]: true },
          },
        }),
        [200],
      );
    },

    /** Replaces the org model-first policy set through the public route. */
    async updateOrgModelPolicies(
      actor: ApiTestUser,
      policies: OrgModelPolicies,
    ): Promise<void> {
      await accept(
        modelPoliciesClient().update({
          headers: authenticate(context, actor),
          body: { policies },
        }),
        [200],
      );
    },

    /**
     * Single OpenRouter completions endpoint serving title, follow-up, run
     * summary, and notification summary prompts. The handler branches on the
     * system prompt and returns the completion text.
     */
    mockOpenRouterCompletions(
      handler: (body: OpenRouterCompletionBody) => string,
    ): void {
      server.use(
        http.post(OPENROUTER_COMPLETIONS_URL, async ({ request }) => {
          const body = openRouterCompletionBodySchema.parse(
            await request.json(),
          );
          return HttpResponse.json({
            choices: [{ message: { content: handler(body) } }],
          });
        }),
      );
    },

    mockOpenRouterFailure(): void {
      server.use(
        http.post(OPENROUTER_COMPLETIONS_URL, () => {
          return new HttpResponse("Internal Server Error", { status: 500 });
        }),
      );
    },

    /**
     * Persistent Axiom query fake: agent-run-event queries (the visibility
     * barrier and the chat output read) resolve to `events`; run-context
     * queries replay the snapshot the API itself ingested at run creation.
     * Give events top-level contiguous `sequenceNumber` 0..lastEventSequence
     * or the barrier burns its 2s poll window per callback.
     */
    mockChatOutputEvents(events: readonly Record<string, unknown>[]): void {
      const snapshot = [...events];
      context.mocks.axiom.query.mockImplementation((...args: unknown[]) => {
        const apl = typeof args[0] === "string" ? args[0] : "";
        if (apl.includes("['run-context']")) {
          const runId = /runId == "([^"]+)"/.exec(apl)?.[1];
          return Promise.resolve(
            runId ? capturedRunContextSnapshot(context, runId) : [],
          );
        }
        return Promise.resolve(snapshot);
      });
    },

    /**
     * Object-storage fake for chat chains: session-history blobs download
     * with deterministic content (so session resume works end to end),
     * registered upload objects appear in prefix listings (upload complete),
     * and every other command acks like the plain storage-write mock.
     */
    acceptChatObjectStorage(): {
      addObject(object: StoredS3Object): void;
    } {
      const objects: StoredS3Object[] = [];
      context.mocks.s3.send.mockImplementation((...args: unknown[]) => {
        const input = commandInput(args[0]);
        const key = typeof input.Key === "string" ? input.Key : "";
        if (key.startsWith("blobs/") && key.endsWith(".blob")) {
          return Promise.resolve({
            Body: {
              async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
                yield Buffer.from(`bdd session history ${key}`, "utf8");
              },
            },
          });
        }
        const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
        const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
        if (prefix !== "") {
          const contents = objects
            .filter((object) => {
              return object.bucket === bucket && object.key.startsWith(prefix);
            })
            .map((object) => {
              return {
                Key: object.key,
                Size: object.size,
                LastModified: nowDate(),
              };
            });
          return Promise.resolve({ Contents: contents });
        }
        return Promise.resolve({});
      });
      return {
        addObject(object: StoredS3Object): void {
          objects.push(object);
        },
      };
    },
  };
}
