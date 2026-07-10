import { zeroImageShareXContract } from "@vm0/api-contracts/contracts/zero-image-share-x";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import {
  seedOrgMetadata,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { seedConnectedXConnector } from "../../../test-fixtures/x-connector";
import { createBddApi } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const routeMocks = createZeroRouteMocks(context);
const X_ACCESS_TOKEN = "x-access-token";
const IMAGE_URL = "https://cdn.vm7.io/artifacts/user-image/share.png";
const IMAGE_BYTES = [137, 80, 78, 71] as const;
const X_MEDIA_UPLOAD_URL = "https://api.x.com/2/media/upload";
const X_CREATE_POST_URL = "https://api.x.com/2/tweets";

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroImageShareXContract);
}

function mockXImageShareProvider(): {
  readonly mediaUploadBodies: unknown[];
  readonly createPostBodies: unknown[];
} {
  const mediaUploadBodies: unknown[] = [];
  const createPostBodies: unknown[] = [];

  server.use(
    http.get(IMAGE_URL, () => {
      return new HttpResponse(new Uint8Array(IMAGE_BYTES), {
        headers: {
          "content-length": String(IMAGE_BYTES.length),
          "content-type": "image/png",
        },
      });
    }),
    http.post(X_MEDIA_UPLOAD_URL, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        `Bearer ${X_ACCESS_TOKEN}`,
      );
      mediaUploadBodies.push(await request.json());
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

describe("POST /api/zero/image-share/x", () => {
  it("posts an image to X and records connector usage billing", async () => {
    const bdd = createBddApi(context);
    const billing = createBillingMediaApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected actor to have an org");
    }
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits: 1000 });
    await seedUsagePricingRows([
      {
        kind: "connector",
        provider: "x",
        category: "content.create",
        unitPrice: 15,
        unitSize: 1,
      },
    ]);
    await seedConnectedXConnector({
      accessToken: X_ACCESS_TOKEN,
      orgId: actor.orgId,
      userId: actor.userId,
    });
    const provider = mockXImageShareProvider();

    const response = await accept(
      client().post({
        headers: authHeaders(),
        body: {
          caption: "Edited with Zero",
          imageUrl: IMAGE_URL,
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
});
