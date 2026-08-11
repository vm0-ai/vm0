import {
  testCustomConnectorSkillCleanupStateContract,
  type TestCustomConnectorSkillCleanupStateResponse,
} from "@vm0/api-contracts/contracts/test-custom-connector-skill-cleanup-state";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { testCustomConnectorSkillCleanupStateRoutes } from "../../test-custom-connector-skill-cleanup-state";
import type { ApiTestUser } from "./api-bdd";

type CleanupStateReadResponse = Extract<
  TestCustomConnectorSkillCleanupStateResponse,
  { readonly action: "read" }
>;

function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Custom connector skill cleanup state requires an org");
  }
  return actor.orgId;
}

function client(context: TestContext) {
  return setupApp({
    context,
    routes: testCustomConnectorSkillCleanupStateRoutes,
  })(testCustomConnectorSkillCleanupStateContract);
}

export async function readCustomConnectorSkillCleanupState(
  context: TestContext,
  actor: ApiTestUser,
  connectorId: string,
): Promise<CleanupStateReadResponse> {
  const response = await accept(
    client(context).action({
      body: {
        action: "read",
        orgId: requireOrgId(actor),
        connectorId,
      },
    }),
    [200],
  );
  if (response.body.action !== "read") {
    throw new Error("Expected Custom connector skill cleanup read response");
  }
  return response.body;
}

export async function claimCustomConnectorSkillPublication(
  context: TestContext,
  actor: ApiTestUser,
  connectorId: string,
  versionId: string,
): Promise<boolean> {
  const response = await accept(
    client(context).action({
      body: {
        action: "claim",
        orgId: requireOrgId(actor),
        connectorId,
        versionId,
      },
    }),
    [200],
  );
  if (response.body.action !== "claim") {
    throw new Error("Expected Custom connector skill cleanup claim response");
  }
  return response.body.claimed;
}
