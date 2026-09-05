import { voiceIoPolishContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { createBddApi } from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { voiceIoPolishRoutes } from "../voice-io-polish";

const context = testContext();
const mocks = createRouteMocks(context);
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function client() {
  return setupApp({ context, routes: voiceIoPolishRoutes })(
    voiceIoPolishContract,
  );
}

describe("POST /api/voice-io/polish", () => {
  it("turns raw dictation into send-ready text without charging usage", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const actor = createBddApi(context).user({
      orgId: createUniqueStaffOrgIdFixture(),
    });
    if (!actor.orgId) {
      throw new Error("Voice draft tests require an organization");
    }
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId: actor.orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.VoiceInputV2]: true },
    );
    let requestBody: unknown;
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "Ship the release on Monday." },
            },
          ],
        });
      }),
    );

    const response = await accept(
      client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          text: "um ship the nebula release Friday no Monday",
          lastAssistantMessage:
            "The Project Nebula release is scheduled for Friday.",
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      text: "Ship the release on Monday.",
    });
    expect(requestBody).toMatchObject({
      model: "google/gemini-3.8-flash",
      max_tokens: 65_536,
      temperature: 0,
      reasoning: { effort: "none" },
      messages: [
        {
          role: "system",
          content: expect.stringContaining(
            "provides conversational context for resolving vocabulary",
          ),
        },
        {
          role: "user",
          content: JSON.stringify({
            text: "um ship the nebula release Friday no Monday",
            lastAssistantMessage:
              "The Project Nebula release is scheduled for Friday.",
          }),
        },
      ],
    });
  });

  it("requires session auth and the voice draft switch for staff", async () => {
    const unauthenticated = await client().post({
      headers: {},
      body: { text: "Hello" },
    });
    expect(unauthenticated.status).toBe(401);

    const actor = createBddApi(context).user({
      orgId: createUniqueStaffOrgIdFixture(),
    });
    if (!actor.orgId) {
      throw new Error("Voice draft tests require an organization");
    }
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId: actor.orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.VoiceInputV2]: false },
    );
    const disabled = await client().post({
      headers: { authorization: "Bearer clerk-session" },
      body: { text: "Hello" },
    });
    expect(disabled.status).toBe(403);
  });

  it("rejects non-staff users with a voice draft override", async () => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("Voice draft tests require an organization");
    }
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId: actor.orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.VoiceInputV2]: true },
    );
    let providerRequests = 0;
    server.use(
      http.post(OPENROUTER_URL, () => {
        providerRequests += 1;
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "Should not be returned." },
            },
          ],
        });
      }),
    );

    const response = await client().post({
      headers: { authorization: "Bearer clerk-session" },
      body: { text: "Hello" },
    });

    expect(response.status).toBe(403);
    expect(providerRequests).toBe(0);
  });
});
