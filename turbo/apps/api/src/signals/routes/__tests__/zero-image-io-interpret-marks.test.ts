import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now } from "../../external/time";
import { zeroImageIoInterpretMarksRoutes } from "../zero-image-io-interpret-marks";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";

const context = testContext();
const store = createStore();
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MARKED_IMAGE = "data:image/png;base64,bWFya2Vk";

function createApp() {
  return createAppWithRoutes({
    signal: context.signal,
    routes: [...zeroImageIoInterpretMarksRoutes],
  });
}

function zeroToken(userId: string, orgId: string): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId,
    orgId,
    runId: randomUUID(),
    capabilities: ["file:write"],
    iat: seconds,
    exp: seconds + 60,
  });
}

async function seedActor(): Promise<{ orgId: string; userId: string }> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );
  return { orgId, userId };
}

function requestInterpret(
  app: ReturnType<typeof createApp>,
  token: string,
  body: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request("/api/zero/image-io/interpret-marks", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/zero/image-io/interpret-marks", () => {
  it("resolves each mark into a targeted edit instruction", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    let requestBody = "";
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-openrouter-key",
        );
        requestBody = await request.text();
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  regions: [
                    {
                      id: "region-comment-1",
                      target: "the dog's black nose (not the tongue below it)",
                      edit: "recolor the nose yellow",
                      confidence: 88,
                    },
                  ],
                }),
              },
            },
          ],
        });
      }),
    );
    const { orgId, userId } = await seedActor();
    const app = createApp();

    const response = await requestInterpret(app, zeroToken(userId, orgId), {
      imageUrl: MARKED_IMAGE,
      regions: [
        {
          id: "region-comment-1",
          mark: 1,
          instruction: "make it yellow",
          location: "center",
        },
      ],
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      regions: readonly unknown[];
    };
    expect(body.regions).toStrictEqual([
      {
        id: "region-comment-1",
        target: "the dog's black nose (not the tongue below it)",
        edit: "recolor the nose yellow",
        confidence: 88,
      },
    ]);
    // The marked image is sent to the model as an image content part.
    expect(requestBody).toContain(MARKED_IMAGE);
    expect(requestBody).toContain("image_url");
  });

  it("falls back to the raw instruction when the LLM is not configured", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    const { orgId, userId } = await seedActor();
    const app = createApp();

    const response = await requestInterpret(app, zeroToken(userId, orgId), {
      imageUrl: MARKED_IMAGE,
      regions: [
        { id: "region-comment-1", mark: 1, instruction: "make it yellow" },
      ],
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      regions: readonly unknown[];
    };
    expect(body.regions).toStrictEqual([
      {
        id: "region-comment-1",
        target: "",
        edit: "make it yellow",
        confidence: 0,
      },
    ]);
  });
});
