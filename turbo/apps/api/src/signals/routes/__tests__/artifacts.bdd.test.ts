import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { mockOptionalEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-helpers";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import {
  createChatFilesBddApi,
  hostedTextFile,
} from "./helpers/api-bdd-chat-files";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsAutomationsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);

type RunnerClaim = Awaited<ReturnType<typeof api.claimRunnerJob>>;

interface ArtifactActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
}

async function artifactActor(
  displayName: string,
  actor: ApiTestUser = bdd.user(),
): Promise<ArtifactActor> {
  chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName,
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup };
}

async function sendChatRun(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly prompt: string;
    readonly threadId?: string;
  },
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.requestSendMessage(actor, body, [201]);
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected chat send to create a run");
  }
  return { runId: sent.body.runId, threadId: sent.body.threadId };
}

async function claimChatRun(
  runnerGroup: string,
  runId: string,
): Promise<{
  readonly claim: RunnerClaim;
  readonly sandboxHeaders: { readonly authorization: string };
}> {
  await api.heartbeatRunner(runnerGroup);
  const claim = await api.claimRunnerJob(runId);
  return {
    claim,
    sandboxHeaders: { authorization: `Bearer ${claim.sandboxToken}` },
  };
}

function zeroTokenFromClaim(claim: RunnerClaim): string {
  const token = claim.environment?.ZERO_TOKEN;
  if (!token || !token.startsWith("vm0_sandbox_")) {
    throw new Error("Expected the claim environment to carry a ZERO_TOKEN");
  }
  return token;
}

async function completeChatRunOk(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
): Promise<void> {
  const historyHash = createHash("sha256")
    .update(`bdd artifacts history ${runId}`)
    .digest("hex");
  await webhooks.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `bdd-cli-${runId}`,
      cliAgentSessionHistoryHash: historyHash,
    },
    sandboxHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    { runId, exitCode: 0 },
    sandboxHeaders,
    [200],
  );
}

async function createHostedArtifact(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly site: string;
  readonly artifactKind?: "hosted-site" | "presentation-html";
}): Promise<{
  readonly runId: string;
  readonly threadId: string;
  readonly fileId: string;
  readonly url: string;
}> {
  const run = await sendChatRun(args.actor, {
    agentId: args.agentId,
    prompt: `create ${args.site}`,
  });
  const { claim, sandboxHeaders } = await claimChatRun(
    args.runnerGroup,
    run.runId,
  );
  const bearer = `Bearer ${zeroTokenFromClaim(claim)}`;
  const prepared = await chat.prepareHostedSiteWithBearer(bearer, {
    site: args.site,
    artifactKind: args.artifactKind ?? "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", `<main>${args.site}</main>`)],
  });
  await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);
  await completeChatRunOk(run.runId, sandboxHeaders);
  return {
    runId: run.runId,
    threadId: run.threadId,
    fileId: prepared.url,
    url: prepared.url,
  };
}

describe("GET /api/zero/artifacts", () => {
  it("lists generated artifacts for the active organization and excludes ordinary uploads", async () => {
    const userId = `user_${randomUUID()}`;
    const actor = bdd.user({ userId, orgId: `org_${randomUUID()}` });
    const otherOrgActor = bdd.user({
      userId,
      orgId: `org_${randomUUID()}`,
    });
    const current = await artifactActor("Artifacts API org agent", actor);
    const otherOrg = await artifactActor(
      "Artifacts API other org agent",
      otherOrgActor,
    );
    const objectStore = chatCallbacks.acceptChatObjectStorage();

    const run = await sendChatRun(actor, {
      agentId: current.agentId,
      prompt: "create artifact with ordinary upload",
    });
    const { claim } = await claimChatRun(current.runnerGroup, run.runId);
    const bearer = `Bearer ${zeroTokenFromClaim(claim)}`;
    const ordinaryUploadId = randomUUID();
    objectStore.addObject({
      bucket: "test-user-artifacts",
      key: `artifacts/${actor.userId}/${ordinaryUploadId}/notes.txt`,
      size: 128,
    });
    await chat.completeUploadWithBearer(
      bearer,
      { id: ordinaryUploadId, contentType: "text/plain" },
      [200],
    );
    const prepared = await chat.prepareHostedSiteWithBearer(bearer, {
      site: `active-org-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>active org</main>")],
    });
    await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);

    const otherOrgArtifact = await createHostedArtifact({
      actor: otherOrg.actor,
      agentId: otherOrg.agentId,
      runnerGroup: otherOrg.runnerGroup,
      site: `other-org-${randomUUID().slice(0, 8)}`,
    });

    const response = await chat.listArtifacts(actor);
    expect(response.artifacts).toHaveLength(1);
    expect(response.artifacts[0]).toMatchObject({
      threadId: run.threadId,
      runId: run.runId,
      fileId: prepared.url,
      url: prepared.url,
      artifactKind: "hosted-site",
    });
    expect(
      response.artifacts.some((artifact) => {
        return artifact.fileId === ordinaryUploadId;
      }),
    ).toBeFalsy();
    expect(
      response.artifacts.some((artifact) => {
        return artifact.fileId === otherOrgArtifact.fileId;
      }),
    ).toBeFalsy();
    expect(response.truncated).toBeFalsy();
  }, 120_000);

  it("returns every generated artifact for the org in one bulk response", async () => {
    const first = await artifactActor("Artifacts API bulk agent");
    const secondAgent = await bdd.createAgent(first.actor, {
      displayName: "Artifacts API bulk second agent",
      visibility: "private",
    });

    const firstArtifact = await createHostedArtifact({
      actor: first.actor,
      agentId: first.agentId,
      runnerGroup: first.runnerGroup,
      site: `alpha-artifact-${randomUUID().slice(0, 8)}`,
    });
    const secondArtifact = await createHostedArtifact({
      actor: first.actor,
      agentId: secondAgent.agentId,
      runnerGroup: first.runnerGroup,
      site: `deck-artifact-${randomUUID().slice(0, 8)}`,
      artifactKind: "presentation-html",
    });
    const thirdArtifact = await createHostedArtifact({
      actor: first.actor,
      agentId: first.agentId,
      runnerGroup: first.runnerGroup,
      site: `beta-artifact-${randomUUID().slice(0, 8)}`,
    });

    const response = await chat.listArtifacts(first.actor);
    expect(response.truncated).toBeFalsy();
    expect(
      new Set(
        response.artifacts.map((artifact) => {
          return artifact.fileId;
        }),
      ),
    ).toStrictEqual(
      new Set([
        firstArtifact.fileId,
        secondArtifact.fileId,
        thirdArtifact.fileId,
      ]),
    );
  }, 120_000);

  it("walks the full set via keyset pagination with a small page size", async () => {
    const owner = await artifactActor("Artifacts API paging agent");

    const created: string[] = [];
    for (const label of ["one", "two", "three"]) {
      const artifact = await createHostedArtifact({
        actor: owner.actor,
        agentId: owner.agentId,
        runnerGroup: owner.runnerGroup,
        site: `page-${label}-${randomUUID().slice(0, 8)}`,
      });
      created.push(artifact.fileId);
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await chat.listArtifacts(owner.actor, { limit: 1, cursor });
      expect(page.artifacts.length).toBeLessThanOrEqual(1);
      for (const artifact of page.artifacts) {
        collected.push(artifact.fileId);
      }
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(10);
    } while (cursor);

    // Every artifact surfaced exactly once across pages — no cursor-drift dups,
    // no skips — proving keyset walks the deduped winner set correctly.
    expect(collected).toHaveLength(created.length);
    expect(new Set(collected)).toStrictEqual(new Set(created));
  }, 120_000);
});
