import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { mockOptionalEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-helpers";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import {
  createChatFilesBddApi,
  hostedTextFile,
} from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGoogleDriveConnectorOAuth,
  mockGoogleDriveFilesList,
} from "./helpers/api-bdd-connectors";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsAutomationsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const connectorsApi = createConnectorBddApi(context);
const webhooks = createWebhookCallbackApi(context);

type RunnerClaim = Awaited<ReturnType<typeof api.claimRunnerJob>>;

interface ArtifactActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
}

function stateFromAuthorizationUrl(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected connector authorization URL to include state");
  }
  return state;
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
      googleDriveSync: { status: "disconnected" },
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
    expect(response.nextCursor).toBeNull();
  }, 120_000);

  it("supports agent, search, artifact kind filters, and cursor pagination", async () => {
    const first = await artifactActor("Artifacts API first agent");
    const secondAgent = await bdd.createAgent(first.actor, {
      displayName: "Artifacts API second agent",
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

    const agentFiltered = await chat.listArtifacts(first.actor, {
      agentId: first.agentId,
    });
    expect(
      agentFiltered.artifacts.map((artifact) => {
        return artifact.fileId;
      }),
    ).toStrictEqual(
      expect.arrayContaining([firstArtifact.fileId, thirdArtifact.fileId]),
    );
    expect(
      agentFiltered.artifacts.some((artifact) => {
        return artifact.fileId === secondArtifact.fileId;
      }),
    ).toBeFalsy();

    const filenameSearch = await chat.listArtifacts(first.actor, {
      query: "alpha-artifact",
    });
    expect(
      filenameSearch.artifacts.map((artifact) => {
        return artifact.fileId;
      }),
    ).toStrictEqual([firstArtifact.fileId]);

    const contentTypeSearch = await chat.listArtifacts(first.actor, {
      query: "text/html",
    });
    expect(contentTypeSearch.artifacts).toHaveLength(3);

    const kindSearch = await chat.listArtifacts(first.actor, {
      query: "presentation-html",
    });
    expect(
      kindSearch.artifacts.map((artifact) => {
        return artifact.fileId;
      }),
    ).toStrictEqual([secondArtifact.fileId]);

    const kindFiltered = await chat.listArtifacts(first.actor, {
      artifactKind: "presentation-html",
    });
    expect(
      kindFiltered.artifacts.map((artifact) => {
        return artifact.fileId;
      }),
    ).toStrictEqual([secondArtifact.fileId]);

    const firstPage = await chat.listArtifacts(first.actor, { limit: 2 });
    expect(firstPage.artifacts).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await chat.listArtifacts(first.actor, {
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.artifacts).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    const pagedIds = [...firstPage.artifacts, ...secondPage.artifacts].map(
      (artifact) => {
        return artifact.fileId;
      },
    );
    expect(new Set(pagedIds)).toStrictEqual(
      new Set([
        firstArtifact.fileId,
        secondArtifact.fileId,
        thirdArtifact.fileId,
      ]),
    );

    const invalidCursor = await chat.requestListArtifacts(
      first.actor,
      { cursor: "not-a-valid-cursor" },
      [400],
    );
    expectApiError(invalidCursor.body);
    expect(invalidCursor.body.error.code).toBe("BAD_REQUEST");
  }, 120_000);

  it("includes google drive sync metadata", async () => {
    const fixture = await artifactActor("Artifacts API drive agent");
    const artifact = await createHostedArtifact({
      actor: fixture.actor,
      agentId: fixture.agentId,
      runnerGroup: fixture.runnerGroup,
      site: `drive-artifact-${randomUUID().slice(0, 8)}`,
    });

    mockGoogleDriveConnectorOAuth();
    const start = await connectorsApi.startOauth(
      fixture.actor,
      "google-drive",
      "oauth",
    );
    await connectorsApi.completeOauthCallback("google-drive", {
      code: "drive-ok",
      state: stateFromAuthorizationUrl(start.authorizationUrl),
    });
    await api.enableAgentConnectors(fixture.actor, fixture.agentId, [
      "google-drive",
    ]);
    const listRecorder = mockGoogleDriveFilesList(() => {
      return {
        status: 200,
        files: [
          {
            id: "drive-artifact-file",
            name: "drive artifact",
            webViewLink:
              "https://drive.google.com/file/d/drive-artifact-file/view",
            appProperties: {
              vm0Artifact: "true",
              vm0ThreadId: artifact.threadId,
              vm0RunId: artifact.runId,
              vm0FileId: artifact.fileId,
            },
          },
        ],
      };
    });

    const response = await chat.listArtifacts(fixture.actor);
    expect(response.artifacts).toHaveLength(1);
    expect(response.artifacts[0]?.googleDriveSync).toStrictEqual({
      status: "synced",
      id: "drive-artifact-file",
      name: "drive artifact",
      webViewLink: "https://drive.google.com/file/d/drive-artifact-file/view",
    });
    expect(listRecorder.queries[0]).toContain("vm0Artifact");
    expect(listRecorder.queries[0]).toContain(artifact.threadId);
  }, 120_000);
});
