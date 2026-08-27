import { imageShareXContract } from "@okouai/api-contracts/contracts/image-share-x";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
  type UsagePricingFixture,
  type UsagePricingRow,
} from "../../../test-fixtures/system-config-seeds";
import { seedConnectedXConnector } from "../../../test-fixtures/x-connector";
import { createBddApi } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createRouteMocks } from "./helpers/route-test";
import { imageShareXRoutes } from "../image-share-x";

const context = testContext();
const routeMocks = createRouteMocks(context);
const X_ACCESS_TOKEN = "x-access-token";
const IMAGE_URL = "https://cdn.vm7.io/artifacts/user-image/share.png";
const OKOU_IMAGE_URL = "https://cdn.okou.io/artifacts/user-image/share.png";
const IMAGE_BYTES = [137, 80, 78, 71] as const;
const MAX_X_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const X_MEDIA_UPLOAD_URL = "https://api.x.com/2/media/upload";
const X_CREATE_POST_URL = "https://api.x.com/2/tweets";
const X_IMAGE_SHARE_PRICING_ROWS = [
  {
    kind: "connector",
    provider: "x",
    category: "content.create",
    unitPrice: 15,
    unitSize: 1,
  },
] as const satisfies readonly UsagePricingRow[];

class OversizedImageChunk extends Uint8Array {
  override get byteLength(): number {
    return MAX_X_IMAGE_SIZE_BYTES + 1;
  }
}

function oversizedImageBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      // Keep the integration test fast while exercising the response-stream
      // byte counter independently of Content-Length.
      controller.enqueue(new OversizedImageChunk(1));
      controller.close();
    },
  });
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function client(usagePricingResolution?: UsagePricingFixture["resolution"]) {
  return setupApp({
    context,
    routes: imageShareXRoutes,
    usagePricingResolution,
  })(imageShareXContract);
}

function mockXImageShareProvider(options?: {
  readonly contentLength?: string | null;
  readonly imageBody?: ReadableStream<Uint8Array> | Uint8Array;
  readonly imageBytes?: Uint8Array;
  readonly imageUrl?: string;
  readonly mediaStatus?: number;
}): {
  readonly mediaUploadBodies: unknown[];
  readonly createPostBodies: unknown[];
} {
  const mediaUploadBodies: unknown[] = [];
  const createPostBodies: unknown[] = [];
  const imageBytes = options?.imageBytes ?? new Uint8Array(IMAGE_BYTES);
  const imageBody = options?.imageBody ?? imageBytes;
  const contentLength =
    options?.contentLength === undefined
      ? String(imageBytes.byteLength)
      : options.contentLength;

  server.use(
    http.get(options?.imageUrl ?? IMAGE_URL, () => {
      return new HttpResponse(imageBody, {
        headers: {
          ...(contentLength === null
            ? {}
            : { "content-length": contentLength }),
          "content-type": "image/png",
        },
      });
    }),
    http.post(X_MEDIA_UPLOAD_URL, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        `Bearer ${X_ACCESS_TOKEN}`,
      );
      mediaUploadBodies.push(await request.json());
      if (options?.mediaStatus !== undefined) {
        return HttpResponse.json(
          {
            title: "Forbidden",
            detail: "This account cannot upload media",
            type: "https://api.x.com/2/problems/not-authorized-for-resource",
          },
          { status: options.mediaStatus },
        );
      }
      return HttpResponse.json({ data: { id: "media-123" } });
    }),
    http.post(X_CREATE_POST_URL, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        `Bearer ${X_ACCESS_TOKEN}`,
      );
      createPostBodies.push(await request.json());
      return HttpResponse.json({ data: { id: "tweet-123" } });
    }),
  );

  return { mediaUploadBodies, createPostBodies };
}

async function setupAuthenticatedXActor(
  oauthGrantedScopes: readonly string[] | null = null,
) {
  const bdd = createBddApi(context);
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected actor to have an org");
  }
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  await seedConnectedXConnector({
    accessToken: X_ACCESS_TOKEN,
    oauthGrantedScopes,
    orgId: actor.orgId,
    userId: actor.userId,
  });
  return { ...actor, orgId: actor.orgId };
}

describe("POST /api/image-share/x", () => {
  it("rejects a known-insufficient grant before X provider access", async () => {
    await setupAuthenticatedXActor(["tweet.write"]);
    const provider = mockXImageShareProvider();

    const response = await accept(
      client().post({
        headers: authHeaders(),
        body: { imageUrl: IMAGE_URL },
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "CONFLICT",
        message: "Reconnect X to post images",
      },
    });
    expect(provider.mediaUploadBodies).toStrictEqual([]);
    expect(provider.createPostBodies).toStrictEqual([]);
  });

  it("reports provider permission denial for an unknown grant", async () => {
    await setupAuthenticatedXActor();
    const provider = mockXImageShareProvider({ mediaStatus: 403 });

    const response = await accept(
      client().post({
        headers: authHeaders(),
        body: { imageUrl: IMAGE_URL },
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "CONFLICT",
        message: "X did not authorize this account to post images",
      },
    });
    expect(provider.mediaUploadBodies).toHaveLength(1);
    expect(provider.createPostBodies).toStrictEqual([]);
  });

  it("preserves an explicit caption for an Okou request and records connector usage billing", async () => {
    const billing = createBillingMediaApi(context);
    const actor = await setupAuthenticatedXActor();
    await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits: 1000 });
    const pricing = await createUsagePricingFixture({
      configured: X_IMAGE_SHARE_PRICING_ROWS,
    });
    onTestFinished(pricing.cleanup);
    const provider = mockXImageShareProvider({ imageUrl: OKOU_IMAGE_URL });

    const response = await accept(
      client(pricing.resolution).post({
        headers: authHeaders(),
        extraHeaders: { origin: "https://app.okou.ai" },
        body: {
          caption: "Edited with Zero",
          imageUrl: OKOU_IMAGE_URL,
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      tweetId: "tweet-123",
      tweetUrl: "https://x.com/i/web/status/tweet-123",
    });
    expect(provider.mediaUploadBodies).toStrictEqual([
      {
        media: Buffer.from(IMAGE_BYTES).toString("base64"),
        media_category: "tweet_image",
        media_type: "image/png",
        shared: false,
      },
    ]);
    expect(provider.createPostBodies).toStrictEqual([
      {
        text: "Edited with Zero",
        media: { media_ids: ["media-123"] },
      },
    ]);
    await expect(billing.readBillingStatus(actor)).resolves.toMatchObject({
      credits: 985,
    });
  });

  it.each([
    {
      brand: "Okou",
      caption: undefined,
      expectedCaption: "Made with Okou",
      origin: "https://app.okou.ai",
    },
    {
      brand: "VM0",
      caption: "   ",
      expectedCaption: "Made with Zero",
      origin: undefined,
    },
  ] as const)(
    "uses the $brand default caption when the caption is missing or blank",
    async ({ caption, expectedCaption, origin }) => {
      const actor = await setupAuthenticatedXActor();
      await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits: 1000 });
      const pricing = await createUsagePricingFixture({
        configured: X_IMAGE_SHARE_PRICING_ROWS,
      });
      onTestFinished(pricing.cleanup);
      const provider = mockXImageShareProvider();

      const response = await accept(
        client(pricing.resolution).post({
          headers: authHeaders(),
          ...(origin === undefined ? {} : { extraHeaders: { origin } }),
          body: {
            ...(caption === undefined ? {} : { caption }),
            imageUrl: IMAGE_URL,
          },
        }),
        [200],
      );

      expect(response.body).toStrictEqual({
        tweetId: "tweet-123",
        tweetUrl: "https://x.com/i/web/status/tweet-123",
      });
      expect(provider.createPostBodies).toStrictEqual([
        {
          text: expectedCaption,
          media: { media_ids: ["media-123"] },
        },
      ]);
    },
  );

  it("rejects an oversized image without a content-length header", async () => {
    await setupAuthenticatedXActor();
    const provider = mockXImageShareProvider({
      contentLength: null,
      imageBody: oversizedImageBody(),
    });

    const response = await accept(
      client().post({
        headers: authHeaders(),
        body: { imageUrl: IMAGE_URL },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "BAD_REQUEST",
        message: "X supports images up to 5 MB",
      },
    });
    expect(provider.mediaUploadBodies).toStrictEqual([]);
    expect(provider.createPostBodies).toStrictEqual([]);
  });

  it("rejects an oversized image with a lying content-length header", async () => {
    await setupAuthenticatedXActor();
    const provider = mockXImageShareProvider({
      contentLength: "1",
      imageBody: oversizedImageBody(),
    });

    const response = await accept(
      client().post({
        headers: authHeaders(),
        body: { imageUrl: IMAGE_URL },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "BAD_REQUEST",
        message: "X supports images up to 5 MB",
      },
    });
    expect(provider.mediaUploadBodies).toStrictEqual([]);
    expect(provider.createPostBodies).toStrictEqual([]);
  });
});
