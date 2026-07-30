import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { pushSubscriptionsContract } from "@vm0/api-contracts/contracts/push-subscriptions";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import { z } from "zod";

import { mockOptionalEnv } from "../../../../lib/env";
import { nowDate } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { zeroModelPoliciesRoutes } from "../../zero-model-policies";
import { zeroPushSubscriptionsRoutes } from "../../zero-push-subscriptions";
import { sessionHistoryBlobBodyForKey } from "./api-bdd-session-history";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";
import type { AgentEvent } from "../../../../lib/event-consumer/verify";

const CHAT_CALLBACK_URL = "http://localhost:3000/api/internal/callbacks/chat";
const OPENROUTER_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";

type OrgModelPolicies = z.infer<
  (typeof zeroModelPoliciesMainContract.update)["body"]
>["policies"];

const openRouterCompletionBodySchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

type OpenRouterCompletionBody = z.infer<typeof openRouterCompletionBodySchema>;

interface StoredS3Object {
  readonly bucket: string;
  readonly body?: Uint8Array;
  readonly contentType?: string;
  readonly key: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly size: number;
}

interface CapturedS3Put {
  readonly bucket: string;
  readonly cacheControl: string | null;
  readonly ifNoneMatch: string | null;
  readonly key: string;
  readonly contentType: string | null;
  readonly metadata: Readonly<Record<string, string>> | null;
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

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => {
      return typeof entry === "string";
    })
  );
}

function webhookEventFromAxiomFixture(
  event: Readonly<Record<string, unknown>>,
): AgentEvent {
  const type =
    typeof event.type === "string"
      ? event.type
      : typeof event.eventType === "string"
        ? event.eventType
        : null;
  const sequenceNumber = event.sequenceNumber;
  if (type === null || typeof sequenceNumber !== "number") {
    throw new Error("Chat output fixture requires an event type and sequence");
  }
  return {
    ...(isRecord(event.eventData) ? event.eventData : event),
    type,
    sequenceNumber,
  };
}

function commandInput(command: unknown): Record<string, unknown> {
  if (isRecord(command) && isRecord(command.input)) {
    return command.input;
  }
  return {};
}

function commandName(command: unknown): string {
  return typeof command === "object" && command !== null
    ? command.constructor.name
    : "";
}

function storedS3ObjectResponse(
  objects: readonly StoredS3Object[],
  bucket: string,
  key: string,
) {
  const object = objects.find((candidate) => {
    return candidate.bucket === bucket && candidate.key === key;
  });
  const body =
    object?.body ?? (object ? new Uint8Array(object.size) : undefined);
  return {
    ContentLength: object?.size,
    ContentType: object?.contentType,
    LastModified: object ? nowDate() : undefined,
    Metadata: object?.metadata,
    Body: body
      ? {
          async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
            yield body;
          },
        }
      : undefined,
  };
}

function deleteStoredS3Objects(
  objects: StoredS3Object[],
  deletedKeys: string[],
  bucket: string,
  input: Record<string, unknown>,
): void {
  const deletion = isRecord(input.Delete) ? input.Delete : {};
  const deletionObjects = Array.isArray(deletion.Objects)
    ? deletion.Objects
    : [];
  for (const deletionObject of deletionObjects) {
    if (!isRecord(deletionObject)) {
      continue;
    }
    const deletionKey = deletionObject.Key;
    if (typeof deletionKey !== "string") {
      continue;
    }
    deletedKeys.push(deletionKey);
    const index = objects.findIndex((candidate) => {
      return candidate.bucket === bucket && candidate.key === deletionKey;
    });
    if (index !== -1) {
      objects.splice(index, 1);
    }
  }
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
  let stagedOutputEvents: AgentEvent[] = [];

  function mockOutputEventQuery(
    events: readonly Record<string, unknown>[],
  ): void {
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
  }

  function pushSubscriptionsClient() {
    return setupAppWithRoutes({
      context,
      routes: zeroPushSubscriptionsRoutes,
    })(pushSubscriptionsContract);
  }

  function modelPoliciesClient() {
    return setupAppWithRoutes({
      context,
      routes: zeroModelPoliciesRoutes,
    })(zeroModelPoliciesMainContract);
  }

  return {
    failIfChatCallbackRouteIsFetched(): () => number {
      let requests = 0;
      server.use(
        http.post(CHAT_CALLBACK_URL, () => {
          requests += 1;
          return HttpResponse.text(
            "chat callback route should not be fetched",
            {
              status: 500,
            },
          );
        }),
      );
      return () => {
        return requests;
      };
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
      handler: (body: OpenRouterCompletionBody) => string | Promise<string>,
    ): void {
      server.use(
        http.post(OPENROUTER_COMPLETIONS_URL, async ({ request }) => {
          const body = openRouterCompletionBodySchema.parse(
            await request.json(),
          );
          return HttpResponse.json({
            choices: [{ message: { content: await handler(body) } }],
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
     * Stages output for the current /events DB projection and keeps the Axiom
     * query fake available for the temporary previous-writer compatibility
     * path. Run-context queries replay the snapshot the API itself ingested at
     * run creation.
     */
    mockChatOutputEvents(events: readonly Record<string, unknown>[]): void {
      stagedOutputEvents = events.map(webhookEventFromAxiomFixture);
      mockOutputEventQuery(events);
    },

    /**
     * Reproduces output already acknowledged by the previous API writer:
     * queryable from its required Axiom ingest, but not staged for the current
     * /events route and therefore absent from the new DB text projection.
     */
    mockPreviousApiChatOutputEvents(
      events: readonly Record<string, unknown>[],
    ): void {
      stagedOutputEvents = [];
      mockOutputEventQuery(events);
    },

    consumeMockChatOutputEvents(): AgentEvent[] {
      const events = stagedOutputEvents;
      stagedOutputEvents = [];
      return events;
    },

    /**
     * Object-storage fake for chat chains: session-history blobs download
     * with deterministic content (so session resume works end to end),
     * registered upload objects appear in prefix listings (upload complete),
     * and every other command acks like the plain storage-write mock.
     */
    acceptChatObjectStorage(): {
      addObject(object: StoredS3Object): void;
      readonly deletedKeys: readonly string[];
      readonly puts: readonly CapturedS3Put[];
      rejectNextImmutablePutAsExisting(): void;
    } {
      const objects: StoredS3Object[] = [];
      const deletedKeys: string[] = [];
      const puts: CapturedS3Put[] = [];
      let rejectNextImmutablePut = false;
      context.mocks.s3.send.mockImplementation((...args: unknown[]) => {
        const input = commandInput(args[0]);
        const key = typeof input.Key === "string" ? input.Key : "";
        if (key.startsWith("blobs/") && key.endsWith(".blob")) {
          const body = sessionHistoryBlobBodyForKey(context, key);
          return Promise.resolve({
            Body: {
              async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
                if (body) {
                  yield body;
                }
              },
            },
          });
        }
        const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
        const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
        const name = commandName(args[0]);
        if (name === "PutObjectCommand") {
          puts.push({
            bucket,
            cacheControl:
              typeof input.CacheControl === "string"
                ? input.CacheControl
                : null,
            ifNoneMatch:
              typeof input.IfNoneMatch === "string" ? input.IfNoneMatch : null,
            key,
            contentType:
              typeof input.ContentType === "string" ? input.ContentType : null,
            metadata: isStringRecord(input.Metadata) ? input.Metadata : null,
          });
          if (rejectNextImmutablePut && input.IfNoneMatch === "*") {
            rejectNextImmutablePut = false;
            return Promise.reject(
              Object.assign(new Error("immutable object already exists"), {
                name: "PreconditionFailed",
                $metadata: { httpStatusCode: 412 },
              }),
            );
          }
        }
        if (name === "HeadObjectCommand") {
          return Promise.resolve(storedS3ObjectResponse(objects, bucket, key));
        }
        if (name === "GetObjectCommand") {
          return Promise.resolve(storedS3ObjectResponse(objects, bucket, key));
        }
        if (name === "DeleteObjectsCommand") {
          deleteStoredS3Objects(objects, deletedKeys, bucket, input);
          return Promise.resolve({});
        }
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
        deletedKeys,
        puts,
        rejectNextImmutablePutAsExisting(): void {
          rejectNextImmutablePut = true;
        },
      };
    },
  };
}
