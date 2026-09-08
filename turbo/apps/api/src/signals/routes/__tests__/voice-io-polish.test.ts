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
import { openRouterModelContractError } from "./helpers/openrouter-model-contract";
import { createDeferredPromise } from "../../utils";
import { voiceIoPolishRoutes } from "../voice-io-polish";

const context = testContext();
const mocks = createRouteMocks(context);
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function client() {
  return setupApp({ context, routes: voiceIoPolishRoutes })(
    voiceIoPolishContract,
  );
}

async function enableVoicePolish() {
  mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
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
}

describe("POST /api/voice-io/polish", () => {
  it("preserves public provider errors and rejects incomplete polish", async () => {
    await enableVoicePolish();
    const cases = [
      {
        status: 400,
        body: {
          error: {
            code: "unsupported_value",
            param: "reasoning.effort",
            message: "private-provider-detail",
          },
        },
        expectedStatus: 502,
        code: "VOICE_POLISH_FAILED",
      },
      {
        status: 429,
        body: { error: { message: "private-provider-detail" } },
        expectedStatus: 503,
        code: "PROVIDER_UNAVAILABLE",
      },
      {
        status: 503,
        body: { error: { message: "private-provider-detail" } },
        expectedStatus: 503,
        code: "PROVIDER_UNAVAILABLE",
      },
      {
        status: 200,
        body: {
          error: {
            code: "invalid_request_error",
            param: "max_tokens",
            message: "private-provider-detail",
          },
        },
        expectedStatus: 503,
        code: "PROVIDER_UNAVAILABLE",
      },
      {
        status: 200,
        body: {
          choices: [
            {
              finish_reason: "error",
              error: {
                code: "invalid_request_error",
                message: "private-provider-detail",
              },
            },
          ],
        },
        expectedStatus: 503,
        code: "PROVIDER_UNAVAILABLE",
      },
      {
        status: 200,
        body: {
          choices: [
            {
              finish_reason: "length",
              native_finish_reason: "MAX_TOKENS",
              message: { content: "Truncated dictation" },
            },
          ],
        },
        expectedStatus: 502,
        code: "VOICE_POLISH_FAILED",
      },
      {
        status: 200,
        body: {
          choices: [{ finish_reason: "stop", message: { content: " " } }],
        },
        expectedStatus: 502,
        code: "VOICE_POLISH_FAILED",
      },
    ];
    for (const testCase of cases) {
      server.use(
        http.post(OPENROUTER_URL, () => {
          return HttpResponse.json(testCase.body, { status: testCase.status });
        }),
      );
      const response = await client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: { text: "um prepare the update" },
      });
      expect(response.status).toBe(testCase.expectedStatus);
      expect(response.body).toStrictEqual({
        error: {
          code: testCase.code,
          message:
            testCase.expectedStatus === 503
              ? "Voice draft cleanup is temporarily unavailable"
              : "Voice draft cleanup failed to produce a usable response",
        },
      });
    }
  });

  it("cancels the provider request when the client disconnects", async () => {
    await enableVoicePolish();
    const controller = new AbortController();
    context.signal.addEventListener(
      "abort",
      () => {
        controller.abort();
      },
      { once: true },
    );
    const entered = createDeferredPromise<void>(context.signal);
    const aborted = createDeferredPromise<void>(context.signal);
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        request.signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
          },
          { once: true },
        );
        entered.resolve();
        await aborted.promise;
        return HttpResponse.json({});
      }),
    );
    const result = setupApp({
      context,
      routes: voiceIoPolishRoutes,
      rethrowErrors: true,
    })(voiceIoPolishContract).post({
      headers: { authorization: "Bearer clerk-session" },
      body: { text: "um prepare the update" },
      fetchOptions: { signal: controller.signal },
    });
    await entered.promise;
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    await aborted.promise;
  });

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
        const contractError = openRouterModelContractError(requestBody);
        if (contractError) {
          return contractError;
        }
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
      reasoning: { effort: "low" },
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

  it("lets non-staff users enable polishing through their Lab override", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
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
    server.use(
      http.post(OPENROUTER_URL, () => {
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "Hello." },
            },
          ],
        });
      }),
    );

    const response = await accept(
      client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: { text: "Hello" },
      }),
      [200],
    );

    expect(response.body.text).toBe("Hello.");
  });
});
