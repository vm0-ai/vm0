import { randomUUID } from "node:crypto";

import { OFFICIAL_TELEGRAM_BOT_ID } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
// GitHub chat routing has no in-process public setup API, so this fixture is
// the narrow internal exception needed to exercise its reply footer.
// eslint-disable-next-line no-restricted-imports
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
// Telegram and GitHub replies are internal callback boundaries. The DB handle
// is passed only to those boundaries; run creation and assertions remain at
// API and provider-facing surfaces.
// eslint-disable-next-line no-restricted-imports
import { writeDb$ } from "../../external/db";
// eslint-disable-next-line no-restricted-imports
import { resolveGithubAgentReplyFooterText } from "../../services/zero-github-footer.service";
// eslint-disable-next-line no-restricted-imports
import { resolveTelegramAgentReplyFooterText } from "../../services/zero-telegram-footer.service";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateZeroRunModelSelection$ } from "./helpers/zero-telegram";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const runs = createRunsApi(context);

async function seedFastRun(): Promise<{
  readonly agentId: string;
  readonly orgId: string;
  readonly runId: string;
}> {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped footer actor");
  }
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Fast Reply Agent",
  });
  const run = await runs.createRun(actor, {
    agentId: agent.agentId,
    prompt: "reply with the run model",
    modelProvider: "anthropic-api-key",
  });
  await store.set(
    updateZeroRunModelSelection$,
    {
      runId: run.runId,
      selectedModel: "gpt-5.6-sol",
      codexServiceTier: "fast",
    },
    context.signal,
  );
  return { agentId: agent.agentId, orgId: actor.orgId, runId: run.runId };
}

describe("integration reply run-model footers", () => {
  it("renders Fast from the originating run in Telegram replies", async () => {
    const fixture = await seedFastRun();
    const footer = await resolveTelegramAgentReplyFooterText({
      db: store.set(writeDb$),
      orgId: fixture.orgId,
      runId: fixture.runId,
      installationId: String(OFFICIAL_TELEGRAM_BOT_ID),
      agentId: fixture.agentId,
    });

    expect(footer).toBe("GPT 5.6 Sol Fast");
  });

  it("renders Fast from the originating run in GitHub replies", async () => {
    const fixture = await seedFastRun();
    const db = store.set(writeDb$);
    const [installation] = await db
      .insert(githubInstallations)
      .values({
        installationId: `bdd-${randomUUID()}`,
        orgId: fixture.orgId,
        defaultComposeId: fixture.agentId,
      })
      .returning({ id: githubInstallations.id });
    if (!installation) {
      throw new Error("Expected a GitHub installation fixture");
    }

    const footer = await resolveGithubAgentReplyFooterText({
      db,
      orgId: fixture.orgId,
      runId: fixture.runId,
      installationId: installation.id,
      agentId: fixture.agentId,
    });

    expect(footer).toBe("GPT 5.6 Sol Fast");
  });
});
