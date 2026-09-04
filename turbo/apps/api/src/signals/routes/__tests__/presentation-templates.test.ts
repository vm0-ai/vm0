import { randomUUID } from "node:crypto";

import { presentationTemplatesContract } from "@okouai/api-contracts/contracts/presentation-templates";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { presentationTemplatesRoutes } from "../presentation-templates";

const context = testContext();
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);

function webHeaders() {
  return { authorization: "Bearer clerk-session" };
}

async function enablePresentationTemplates(actor: ApiTestUser): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Presentation template tests require an organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    { [FeatureSwitchKey.PresentationTemplates]: true },
  );
}

function templateClient() {
  return setupApp({ context, routes: presentationTemplatesRoutes })(
    presentationTemplatesContract,
  );
}

beforeEach(() => {
  mockEnv("R2_USER_ARTIFACTS_BUCKET_NAME", "test-user-artifacts");
});

describe("presentation template owner routes", () => {
  it("keeps the owner collection behind the feature switch", async () => {
    const actor = bdd.user();
    mocks.clerk.session(actor.userId, actor.orgId);
    const client = templateClient();

    await accept(client.list({ headers: webHeaders() }), [403]);

    await enablePresentationTemplates(actor);
    const response = await accept(
      client.list({ headers: webHeaders() }),
      [200],
    );
    expect(response.body).toStrictEqual([]);
  });

  it("does not expose an unknown template through owner routes", async () => {
    const actor = bdd.user();
    await enablePresentationTemplates(actor);
    mocks.clerk.session(actor.userId, actor.orgId);
    const client = templateClient();
    const templateId = randomUUID();

    const readResponse = await accept(
      client.get({ headers: webHeaders(), params: { templateId } }),
      [404],
    );
    const updateResponse = await accept(
      client.update({
        headers: webHeaders(),
        params: { templateId },
        body: { title: "Renamed" },
      }),
      [404],
    );
    const deleteResponse = await accept(
      client.delete({ headers: webHeaders(), params: { templateId } }),
      [404],
    );

    const notFoundBody = {
      error: {
        message: `Presentation template not found: ${templateId}`,
        code: "NOT_FOUND",
      },
    };
    expect([
      readResponse.body,
      updateResponse.body,
      deleteResponse.body,
    ]).toStrictEqual([notFoundBody, notFoundBody, notFoundBody]);
  });
});
