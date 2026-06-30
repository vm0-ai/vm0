import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";

import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./zero-route-test";

type ClerkOrgRole = "org:admin" | "org:member";

interface FeatureSwitchActor {
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole?: ClerkOrgRole;
}

function featureSwitchesClient(context: TestContext) {
  return setupApp({ context })(zeroFeatureSwitchesContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function authenticateFeatureSwitchActor(
  context: TestContext,
  actor: FeatureSwitchActor,
): void {
  createZeroRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
}

export async function updateFeatureSwitchesForUser(
  context: TestContext,
  actor: FeatureSwitchActor,
  switches: Readonly<Record<string, boolean>>,
): Promise<void> {
  authenticateFeatureSwitchActor(context, actor);
  await accept(
    featureSwitchesClient(context).update({
      headers: authHeaders(),
      body: { switches },
    }),
    [200],
  );
}

export async function deleteFeatureSwitchesForUser(
  context: TestContext,
  actor: FeatureSwitchActor,
): Promise<void> {
  authenticateFeatureSwitchActor(context, actor);
  await accept(
    featureSwitchesClient(context).delete({ headers: authHeaders() }),
    [200],
  );
}
