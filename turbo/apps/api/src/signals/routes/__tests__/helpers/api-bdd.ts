import { randomUUID } from "node:crypto";

import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
  zeroSkillsCollectionContract,
} from "@vm0/api-contracts/contracts/zero-agents";

import { setupApp, type TestContext } from "../../../../__tests__/test-helpers";
import { now } from "../../../../lib/time";
import { signSandboxJwtForTests } from "../../../auth/tokens";
import { createZeroRouteMocks } from "./zero-route-test";

/**
 * API-first BDD harness for route tests. Every interaction goes through a real
 * HTTP request via `setupApp`; the only thing mocked here are external services
 * (Clerk session resolution, S3 uploads) through `context.mocks`. There are no
 * database writers or readers — preconditions and assertions must be expressed
 * as real API calls by the test, per the migration plan in `api.bdd.md`.
 */
export const SESSION_AUTH = {
  authorization: "Bearer clerk-session",
} as const;

interface BddActor {
  readonly userId: string;
  readonly orgId: string;
}

function newOrgId(): string {
  return `org_${randomUUID()}`;
}

function newUserId(): string {
  return `user_${randomUUID()}`;
}

export function createBddApi(context: TestContext) {
  const mocks = createZeroRouteMocks(context);

  return {
    /** ts-rest client for `/api/zero/agents` (create + list). */
    agents: setupApp({ context })(zeroAgentsMainContract),
    /** ts-rest client for `/api/zero/agents/:id` (get/update/patch/delete). */
    agentsById: setupApp({ context })(zeroAgentsByIdContract),
    /** ts-rest client for `/api/zero/skills` (create), used to build the
     * `customSkills` precondition through the public API. */
    skills: setupApp({ context })(zeroSkillsCollectionContract),

    /** Authorization header for the active Clerk session actor. */
    auth: SESSION_AUTH,

    /** Mock a Clerk admin session and return the acting identity. */
    actAsAdmin(actor: Partial<BddActor> = {}): BddActor {
      const identity: BddActor = {
        userId: actor.userId ?? newUserId(),
        orgId: actor.orgId ?? newOrgId(),
      };
      mocks.clerk.session(identity.userId, identity.orgId, "org:admin");
      return identity;
    },

    /** Mock a Clerk session for a non-admin member of `actor.orgId`. */
    actAsMember(actor: BddActor): BddActor {
      mocks.clerk.session(actor.userId, actor.orgId, "org:member");
      return actor;
    },

    /** Mock a Clerk session with no active organization. */
    actAsNoOrg(userId: string = newUserId()): void {
      mocks.clerk.session(userId, null);
    },

    /** Build an `Authorization` header for a sandbox "zero" token carrying the
     * given capabilities — used to exercise capability-gated 403 branches. */
    zeroAuth(capabilities: readonly ZeroCapability[]): {
      readonly authorization: string;
    } {
      const seconds = Math.floor(now() / 1000);
      const token = signSandboxJwtForTests({
        scope: "zero",
        userId: newUserId(),
        orgId: newOrgId(),
        runId: `run_${randomUUID()}`,
        capabilities: [...capabilities],
        iat: seconds,
        exp: seconds + 60,
      });
      return { authorization: `Bearer ${token}` };
    },

    /** Stub S3 so the instructions-storage upload during agent creation
     * succeeds (the only external dependency the create path touches). */
    allowInstructionsStorage(): void {
      context.mocks.s3.send.mockResolvedValue({});
    },
  };
}
