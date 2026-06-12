import { createHmac, randomInt, randomUUID } from "node:crypto";

import {
  integrationsPhoneUploadCompleteContract,
  integrationsPhoneUploadInitContract,
  type PhoneUploadCompleteBody,
  type PhoneUploadInitBody,
} from "@vm0/api-contracts/contracts/integrations";
import { internalEventConsumerAgentPhoneTypingContract } from "@vm0/api-contracts/contracts/internal-event-consumers";
import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import { HttpResponse, http } from "msw";
import type { z } from "zod";

import { createApp } from "../../../../app-factory";
import { env } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import { server } from "../../../../mocks/server";
import type { ApiTestUser } from "./api-bdd";
import {
  agentPhoneBddWebhookSecret,
  createBddIntegrationApi,
} from "./api-bdd-integrations";
import { createZeroRouteMocks } from "./zero-route-test";

export const AGENTPHONE_BDD_AGENT_ID = "agt-bdd-agentphone";
export const AGENTPHONE_BDD_PHONE_NUMBER = "+19039853128";
const AGENTPHONE_API_BASE_URL = "https://api.agentphone.test";
const AGENTPHONE_CALLBACK_URL =
  "http://localhost:3000/api/internal/callbacks/agentphone";

type OrgModelPolicyUpdateBody = z.infer<
  (typeof zeroModelPoliciesMainContract.update)["body"]
>;

export interface AgentPhoneProviderSend {
  readonly agentId: string | undefined;
  readonly toNumber: string | undefined;
  readonly conversationId: string | undefined;
  readonly replyToMessageId: string | undefined;
  readonly body: string | undefined;
  readonly mediaUrl: string | undefined;
}

export interface AgentPhoneSendCapture {
  readonly messages: readonly AgentPhoneProviderSend[];
  readonly typing: readonly string[];
}

interface AgentPhoneInboundMessage {
  readonly channel: "imessage" | "sms" | "mms";
  readonly from: string;
  readonly body: string;
  readonly messageId?: string;
  readonly conversationId?: string;
  readonly isGroup?: boolean;
  readonly mediaUrl?: string;
  readonly recentHistory?: readonly Readonly<Record<string, unknown>>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function agentPhoneWebhookHeaders(
  body: string,
  webhookId: string,
): {
  readonly "x-webhook-signature": string;
  readonly "x-webhook-timestamp": string;
  readonly "x-webhook-event": string;
  readonly "x-webhook-id": string;
} {
  const timestamp = String(Math.floor(now() / 1000));
  return {
    "x-webhook-signature": `sha256=${createHmac(
      "sha256",
      agentPhoneBddWebhookSecret(),
    )
      .update(`${timestamp}.${body}`)
      .digest("hex")}`,
    "x-webhook-timestamp": timestamp,
    "x-webhook-event": "agent.message",
    "x-webhook-id": webhookId,
  };
}

export function uniquePhoneHandle(): string {
  return `+1555${randomInt(1_000_000, 9_999_999)}`;
}

export function uniqueConversationId(): string {
  return `conv-bdd-${randomUUID().slice(0, 13)}`;
}

function authenticate(
  context: TestContext,
  actor: ApiTestUser,
): { readonly authorization: string } {
  createZeroRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const emailId = `email_${actor.userId}`;
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [
      {
        id: actor.userId,
        emailAddresses: [{ id: emailId, emailAddress: actor.email }],
        primaryEmailAddressId: emailId,
        firstName: "BDD",
        lastName: "AgentPhone",
      },
    ],
  });
  return { authorization: "Bearer clerk-session" };
}

export function createAgentPhoneBddApi(context: TestContext) {
  const integrations = createBddIntegrationApi(context);

  function harvestConnectBody(capture: AgentPhoneSendCapture): {
    readonly phoneHandle: string;
    readonly agentphoneAgentId: string;
    readonly timestamp: number;
    readonly signature: string;
    readonly channel: string | undefined;
  } {
    const prompt = [...capture.messages].reverse().find((message) => {
      return message.body?.includes("/agentphone/connect?") ?? false;
    });
    const url = prompt?.body?.match(/https?:\/\/\S+/u)?.[0];
    if (!url) {
      throw new Error(
        "Expected a captured AgentPhone connect prompt with a connect URL",
      );
    }
    const params = new URL(url).searchParams;
    const timestamp = Number(params.get("ts") ?? "");
    if (!Number.isFinite(timestamp)) {
      throw new Error("Expected the AgentPhone connect URL to carry ts");
    }
    return {
      phoneHandle: params.get("handle") ?? "",
      agentphoneAgentId: params.get("agent") ?? "",
      timestamp,
      signature: params.get("sig") ?? "",
      channel: params.get("channel") ?? undefined,
    };
  }

  async function postAgentPhoneInboundMessage(
    message: AgentPhoneInboundMessage,
  ): Promise<string> {
    const messageId = message.messageId ?? `ap-msg-${randomUUID()}`;
    const rawBody = JSON.stringify({
      event: "agent.message",
      channel: message.channel,
      ...(message.recentHistory
        ? { recentHistory: message.recentHistory }
        : {}),
      data: {
        id: messageId,
        agentId: AGENTPHONE_BDD_AGENT_ID,
        from: message.from,
        to: AGENTPHONE_BDD_PHONE_NUMBER,
        body: message.body,
        ...(message.conversationId
          ? { conversationId: message.conversationId }
          : {}),
        ...(message.isGroup === undefined ? {} : { isGroup: message.isGroup }),
        ...(message.mediaUrl ? { mediaUrl: message.mediaUrl } : {}),
      },
    });
    await integrations.requestAgentPhoneWebhook(
      rawBody,
      agentPhoneWebhookHeaders(rawBody, `evt-bdd-agentphone-${randomUUID()}`),
      [200],
    );
    // Webhook handling is waitUntil-detached; callers synchronize on the
    // observable side effect they care about.
    return messageId;
  }

  return {
    postAgentPhoneInboundMessage,

    captureAgentPhoneSends(): AgentPhoneSendCapture {
      const messages: AgentPhoneProviderSend[] = [];
      const typing: string[] = [];
      server.use(
        http.post(
          `${AGENTPHONE_API_BASE_URL}/v1/messages`,
          async ({ request }) => {
            const raw: unknown = await request.json();
            const record = isRecord(raw) ? raw : {};
            const send: AgentPhoneProviderSend = {
              agentId: stringField(record, "agent_id"),
              toNumber: stringField(record, "to_number"),
              conversationId: stringField(record, "conversation_id"),
              replyToMessageId: stringField(record, "reply_to_message_id"),
              body: stringField(record, "body"),
              mediaUrl: stringField(record, "media_url"),
            };
            messages.push(send);
            return HttpResponse.json({
              id: `apmsg_${randomUUID()}`,
              status: "sent",
              channel: "sms",
              from_number: AGENTPHONE_BDD_PHONE_NUMBER,
              to_number: send.toNumber ?? null,
              media_urls: send.mediaUrl ? [send.mediaUrl] : [],
            });
          },
        ),
        http.post(
          `${AGENTPHONE_API_BASE_URL}/v1/conversations/:id/typing`,
          ({ params }) => {
            typing.push(typeof params.id === "string" ? params.id : "");
            return HttpResponse.json({ status: "typing indicator sent" });
          },
        ),
      );
      return { messages, typing };
    },

    proxyAgentPhoneCallbackToApp(): void {
      server.use(
        http.post(AGENTPHONE_CALLBACK_URL, async ({ request }) => {
          const app = createApp({ signal: context.signal });
          return await app.request("/api/internal/callbacks/agentphone", {
            method: "POST",
            headers: request.headers,
            body: await request.text(),
          });
        }),
      );
    },

    /**
     * Route the run-output Axiom query to a fixed assistant result so the
     * AgentPhone completion callback resolves `text` as the run output.
     * Restore with `restoreCompletionRunOutput` before completing runs that
     * should fall back to "Task completed successfully.".
     */
    mockCompletionRunOutput(text: string): void {
      context.mocks.axiom.query.mockImplementation((...args: unknown[]) => {
        const apl = typeof args[0] === "string" ? args[0] : "";
        return Promise.resolve(
          apl.includes("agent-run-events")
            ? [{ eventType: "result", eventData: { result: text } }]
            : [],
        );
      });
    },

    restoreCompletionRunOutput(): void {
      context.mocks.axiom.query.mockReset();
      context.mocks.axiom.query.mockResolvedValue([]);
    },

    async linkViaWebhookConnectPrompt(
      actor: ApiTestUser,
      phone: string,
      capture: AgentPhoneSendCapture,
    ): Promise<void> {
      await postAgentPhoneInboundMessage({
        channel: "sms",
        from: phone,
        body: "hi",
      });
      const connectBody = harvestConnectBody(capture);
      await integrations.requestConnectAgentPhone(actor, connectBody, [200]);
      const welcome = capture.messages.at(-1);
      if (
        welcome?.toNumber !== phone ||
        welcome.agentId !== AGENTPHONE_BDD_AGENT_ID
      ) {
        throw new Error(
          "Expected the AgentPhone connect welcome text to reach the linked phone",
        );
      }
      const status = await integrations.getAgentPhoneLinkStatus(actor);
      if (!status.linked || status.phoneHandle !== phone) {
        throw new Error(
          `Expected AgentPhone link status to show ${phone} as linked`,
        );
      }
    },

    async requestAgentPhoneTypingEventConsumer(
      body: { readonly runId: string } & Record<string, unknown>,
      headers: {
        readonly "x-vm0-signature"?: string;
        readonly "x-vm0-timestamp"?: string;
      },
      statuses: readonly (200 | 401)[],
    ) {
      const client = setupApp({ context })(
        internalEventConsumerAgentPhoneTypingContract,
      );
      return await accept(client.refresh({ headers, body }), statuses);
    },

    async requestPhoneUploadInitWithToken<Status extends 200 | 400 | 401 | 403>(
      token: string,
      body: PhoneUploadInitBody,
      statuses: readonly Status[],
    ) {
      const client = setupApp({ context })(integrationsPhoneUploadInitContract);
      return await accept(
        client.init({
          headers: { authorization: `Bearer ${token}` },
          body,
        }),
        statuses,
      );
    },

    async requestPhoneUploadCompleteWithToken<
      Status extends 200 | 400 | 401 | 403 | 404 | 502,
    >(
      token: string,
      body: PhoneUploadCompleteBody,
      statuses: readonly Status[],
    ) {
      const client = setupApp({ context })(
        integrationsPhoneUploadCompleteContract,
      );
      return await accept(
        client.complete({
          headers: { authorization: `Bearer ${token}` },
          body,
        }),
        statuses,
      );
    },

    /**
     * Read a run's agent session id through the public activity-detail API
     * (GET /api/zero/logs/:id) — the only session projection visible without
     * checkpoints.
     */
    async readRunSessionId(actor: ApiTestUser, runId: string): Promise<string> {
      const client = setupApp({ context })(logsByIdContract);
      const response = await accept(
        client.getById({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        [200],
      );
      if (!response.body.sessionId) {
        throw new Error(`Expected run ${runId} to expose a session id`);
      }
      return response.body.sessionId;
    },

    async downloadPhoneFileRaw(
      token: string,
      fileId: string,
    ): Promise<{
      readonly status: number;
      readonly headers: Headers;
      readonly text: string;
    }> {
      const response = await createApp({ signal: context.signal }).request(
        `/api/zero/integrations/phone/download-file?file_id=${encodeURIComponent(fileId)}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
        },
      );
      return {
        status: response.status,
        headers: response.headers,
        text: await response.text(),
      };
    },

    /**
     * Object-storage fake for AgentPhone chains: session-history blobs
     * download with deterministic content (so checkpointed sessions resume
     * end to end), registered upload objects appear in prefix listings
     * (phone upload-complete), and every other command acks like the plain
     * storage-write mock.
     */
    acceptAgentPhoneObjectStorage(): {
      addArtifactObject(object: {
        readonly userId: string;
        readonly uploadId: string;
        readonly filename: string;
        readonly size: number;
      }): void;
    } {
      const objects: {
        readonly bucket: string;
        readonly key: string;
        readonly size: number;
      }[] = [];
      context.mocks.s3.send.mockImplementation((...args: unknown[]) => {
        const input = commandInput(args[0]);
        const key = typeof input.Key === "string" ? input.Key : "";
        if (key.startsWith("blobs/") && key.endsWith(".blob")) {
          return Promise.resolve({
            Body: {
              async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
                yield Buffer.from(`bdd agentphone history ${key}`, "utf8");
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
                LastModified: new Date("2026-01-01T00:00:00.000Z"),
              };
            });
          return Promise.resolve({ Contents: contents });
        }
        return Promise.resolve({});
      });
      return {
        addArtifactObject(object): void {
          objects.push({
            bucket: env("R2_USER_ARTIFACTS_BUCKET_NAME"),
            key: `artifacts/${object.userId}/${object.uploadId}/${object.filename}`,
            size: object.size,
          });
        },
      };
    },

    async switchDefaultModelRouteToOpenRouter(
      actor: ApiTestUser,
    ): Promise<void> {
      const providers = setupApp({ context })(zeroModelProvidersMainContract);
      const upserted = await accept(
        providers.upsert({
          headers: authenticate(context, actor),
          body: { type: "openrouter-api-key", secret: "test-openrouter-key" },
        }),
        [200, 201],
      );
      const policies: OrgModelPolicyUpdateBody["policies"] = [
        {
          model: "claude-sonnet-4-6",
          isDefault: true,
          defaultProviderType: "openrouter-api-key",
          credentialScope: "org",
          modelProviderId: upserted.body.provider.id,
        },
      ];
      await accept(
        setupApp({ context })(zeroModelPoliciesMainContract).update({
          headers: authenticate(context, actor),
          body: { policies },
        }),
        [200],
      );
    },
  };
}
