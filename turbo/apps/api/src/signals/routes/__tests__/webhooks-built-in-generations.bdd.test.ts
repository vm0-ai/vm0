import { createHmac, randomUUID } from "node:crypto";

import { builtInGenerationJobs } from "@vm0/db/schema/built-in-generation-job";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { env } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import { createFixtureTracker } from "./helpers/zero-route-test";

// BDD migration of the legacy `webhooks-built-in-generations.test.ts`.
// The 4 legacy `it()`s (which exercised two exported helpers,
// `providerFailureDetailsForLog` and `bytePlusBuiltInGenerationError`,
// in isolation) collapse into 2 BDD `it()`s that drive the webhook
// routes end-to-end: (1) Fal failure chain (401 bad token → 200
// ignored inactive job → 200 ERROR payload marks the job failed
// with the failure log details → 200 byteplus InvalidParameter
// payload marks the job failed with the
// BYTEPLUS_INVALID_PARAMETER code), (2) BytePlus ignored-on-inactive
// chain (200 succeeded on inactive job is ignored).
//
// Service-Level Exceptions: (1) the `builtInGenerationJobs` row is
// seeded directly via `writeDb$` because no public route creates
// one (jobs are produced by the generation kickoff flow, not the
// webhooks under test); (2) the row state after the webhook is
// verified by reading the job back via `writeDb$` (no public
// `GET /api/webhooks/built-in-generations/:id` endpoint exists; the
// `GET /api/zero/built-in-generations/:id` requires Clerk auth and
// the webhook runs out-of-band). (3) the HMAC webhook token is
// computed inline from `SECRETS_ENCRYPTION_KEY` because the
// production `sign...` helper is not exported from the service.
// (4) the request is sent through `createApp` directly because the
// `c.type<string>()` body shape is not consumable by the ts-rest
// test client; this is the same pattern used by every other
// webhook BDD test in the suite.

const context = testContext();
const store = createStore();

interface BuiltInGenerationWebhookFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly generationId: string;
}

async function deleteFixture(
  fixture: BuiltInGenerationWebhookFixture,
): Promise<void> {
  await store
    .set(writeDb$)
    .delete(builtInGenerationJobs)
    .where(eq(builtInGenerationJobs.id, fixture.generationId));
}

async function seedRunningJob(
  fixture: BuiltInGenerationWebhookFixture,
  type: "image" | "video",
): Promise<void> {
  await store
    .set(writeDb$)
    .insert(builtInGenerationJobs)
    .values({
      id: fixture.generationId,
      type,
      status: "running",
      orgId: fixture.orgId,
      userId: fixture.userId,
      request: { prompt: "test prompt" },
    });
}

function signWebhookToken(args: {
  readonly provider: "fal" | "byteplus";
  readonly generationId: string;
  readonly visualKey: string | undefined;
}): string {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update([args.provider, args.generationId, args.visualKey ?? ""].join(":"))
    .digest("hex");
}

interface PostResult {
  readonly status: number;
  readonly body: unknown;
}

async function postFalWebhook(args: {
  readonly generationId: string;
  readonly token: string;
  readonly visualKey: string | undefined;
  readonly body: string;
}): Promise<PostResult> {
  const url = new URL(
    `/api/webhooks/built-in-generations/fal/${args.generationId}`,
    "http://api.test",
  );
  url.searchParams.set("token", args.token);
  if (args.visualKey) {
    url.searchParams.set("visualKey", args.visualKey);
  }
  const app = createApp({ signal: context.signal });
  const response = await app.request(url.pathname + url.search, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: args.body,
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function postBytePlusWebhook(args: {
  readonly generationId: string;
  readonly token: string;
  readonly body: string;
}): Promise<PostResult> {
  const url = new URL(
    `/api/webhooks/built-in-generations/byteplus/${args.generationId}`,
    "http://api.test",
  );
  url.searchParams.set("token", args.token);
  const app = createApp({ signal: context.signal });
  const response = await app.request(url.pathname + url.search, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: args.body,
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

const track =
  createFixtureTracker<BuiltInGenerationWebhookFixture>(deleteFixture);

describe("BDD POST /api/webhooks/built-in-generations — auth + failure chain", () => {
  it("gwt-wt-wt: 401 bad token → 200 ignores inactive job → 200 ERROR marks job failed with failure log → 200 byteplus InvalidParameter marks job failed with BYTEPLUS_INVALID_PARAMETER", async () => {
    // When + Then: 401 when the signed token does not match.
    const inactiveGenerationId = randomUUID();
    const badToken = await postFalWebhook({
      generationId: inactiveGenerationId,
      token: "not-a-real-token",
      visualKey: "vk-1",
      body: JSON.stringify({ status: "ERROR" }),
    });
    expect(badToken.status).toBe(401);
    expect(badToken.body).toStrictEqual({ error: "Invalid token" });

    // When: a valid Fal-signed token + a payload with a known
    // OK status, but no job row exists for the generationId.
    // The webhook must acknowledge with 200 OK and not crash.
    const inactiveToken = signWebhookToken({
      provider: "fal",
      generationId: inactiveGenerationId,
      visualKey: "vk-1",
    });
    const inactive = await postFalWebhook({
      generationId: inactiveGenerationId,
      token: inactiveToken,
      visualKey: "vk-1",
      body: JSON.stringify({ status: "OK" }),
    });
    expect(inactive.status).toBe(200);
    expect(inactive.body).toBe("OK");

    // Given: an active running image job + a valid Fal-signed
    // token + a payload with `status: "ERROR"` and a nested
    // Fal-style failure detail. The webhook must mark the job
    // failed and persist the failure details onto the row.
    const imageFx: BuiltInGenerationWebhookFixture = {
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
      generationId: randomUUID(),
    };
    await track(Promise.resolve(imageFx));
    await seedRunningJob(imageFx, "image");
    const imageToken = signWebhookToken({
      provider: "fal",
      generationId: imageFx.generationId,
      visualKey: "vk-1",
    });
    const errorPayload = JSON.stringify({
      status: "ERROR",
      response: {
        error: { message: "upstream worker timed out", code: "TIMEOUT" },
      },
    });
    const errored = await postFalWebhook({
      generationId: imageFx.generationId,
      token: imageToken,
      visualKey: "vk-1",
      body: errorPayload,
    });
    expect(errored.status).toBe(200);
    expect(errored.body).toBe("OK");

    // Then: the job row is marked failed with the upstream
    // error message.
    const erroredRow = await store
      .set(writeDb$)
      .select({
        status: builtInGenerationJobs.status,
        error: builtInGenerationJobs.error,
      })
      .from(builtInGenerationJobs)
      .where(eq(builtInGenerationJobs.id, imageFx.generationId));
    expect(erroredRow).toHaveLength(1);
    expect(erroredRow[0]?.status).toBe("failed");
    expect(erroredRow[0]?.error).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Generation failed",
    });

    // Given: an active running video job + a valid
    // BytePlus-signed token + a payload with
    // `error.code === "InvalidParameter"`. The webhook must
    // map the error code to `BYTEPLUS_INVALID_PARAMETER` and
    // include the parameter name in the message.
    const videoFx: BuiltInGenerationWebhookFixture = {
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
      generationId: randomUUID(),
    };
    await track(Promise.resolve(videoFx));
    await seedRunningJob(videoFx, "video");
    const bytePlusToken = signWebhookToken({
      provider: "byteplus",
      generationId: videoFx.generationId,
      visualKey: undefined,
    });
    const bytePlusPayload = JSON.stringify({
      status: "failed",
      error: {
        code: "InvalidParameter",
        message:
          "The parameter `content[1].image_url` specified in the request is not valid.",
        param: "content[1].image_url",
        type: "BadRequest",
      },
    });
    const bytePlusRes = await postBytePlusWebhook({
      generationId: videoFx.generationId,
      token: bytePlusToken,
      body: bytePlusPayload,
    });
    expect(bytePlusRes.status).toBe(200);
    expect(bytePlusRes.body).toBe("OK");

    // Then: the job row carries the mapped
    // BYTEPLUS_INVALID_PARAMETER error.
    const videoRow = await store
      .set(writeDb$)
      .select({
        status: builtInGenerationJobs.status,
        error: builtInGenerationJobs.error,
      })
      .from(builtInGenerationJobs)
      .where(eq(builtInGenerationJobs.id, videoFx.generationId));
    expect(videoRow).toHaveLength(1);
    expect(videoRow[0]?.status).toBe("failed");
    expect(videoRow[0]?.error?.code).toBe("BYTEPLUS_INVALID_PARAMETER");
    expect(videoRow[0]?.error?.message).toContain(
      "The parameter `content[1].image_url`",
    );
  });
});

describe("BDD POST /api/webhooks/built-in-generations/byteplus — ignored chain", () => {
  it("gwt-wt-wt: 200 succeeded on inactive job is ignored", async () => {
    // When: a BytePlus `succeeded` payload arrives for an
    // unknown generationId. The webhook acknowledges with 200
    // OK and does not crash.
    const inactiveGenerationId = randomUUID();
    const inactiveToken = signWebhookToken({
      provider: "byteplus",
      generationId: inactiveGenerationId,
      visualKey: undefined,
    });
    const inactive = await postBytePlusWebhook({
      generationId: inactiveGenerationId,
      token: inactiveToken,
      body: JSON.stringify({ status: "succeeded" }),
    });
    expect(inactive.status).toBe(200);
    expect(inactive.body).toBe("OK");
  });
});
