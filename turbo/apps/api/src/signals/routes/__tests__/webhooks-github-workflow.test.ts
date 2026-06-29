import { createHmac } from "node:crypto";

import { zeroWorkflowTriggersContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import {
  zeroWorkflowGithubProcessedEvents,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { createStore } from "ccstate";
import { and, asc, eq } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  setGithubWorkflowRunStarterForTests,
  type GithubWorkflowRunStartTestInput,
} from "../../services/github-workflow-event.service";
import {
  deleteWorkflowsForFixture$,
  seedAgentForInstructions$,
  seedWorkflowsFixture$,
  type WorkflowsFixture,
} from "./helpers/zero-workflows";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const WORKFLOW_NAME = "github-webhook-workflow";
const GITHUB_WEBHOOK_SECRET = "github-webhook-secret";
const GITHUB_INSTALLATION_REMOTE_ID = "123456";

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function triggersClient() {
  return setupApp({ context })(zeroWorkflowTriggersContract);
}

async function enableGithubWorkflowTriggers(
  fixture: WorkflowsFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.WorkflowGithubLabelEventTriggers]: true,
  });
}

async function seedGithubInstallation(args: {
  readonly fixture: WorkflowsFixture;
  readonly composeId: string;
}): Promise<string> {
  const [installation] = await store
    .set(writeDb$)
    .insert(githubInstallations)
    .values({
      installationId: GITHUB_INSTALLATION_REMOTE_ID,
      status: "active",
      orgId: args.fixture.orgId,
      targetType: "Organization",
      targetId: "12345",
      targetName: "vm0-ai",
      defaultComposeId: args.composeId,
    })
    .returning({ id: githubInstallations.id });
  if (!installation) {
    throw new Error("Expected GitHub installation to be created");
  }
  return installation.id;
}

async function seedGithubUserLink(args: {
  readonly installationId: string;
  readonly userId: string;
}): Promise<void> {
  await store.set(writeDb$).insert(githubUserLinks).values({
    installationId: args.installationId,
    vm0UserId: args.userId,
    githubUserId: "101",
  });
}

async function setupFixture(): Promise<{
  readonly fixture: WorkflowsFixture;
  readonly agentId: string;
  readonly workflowId: string;
}> {
  const fixture = await store.set(
    seedWorkflowsFixture$,
    undefined,
    context.signal,
  );
  context.mocks.s3.send.mockResolvedValue({});
  const { agentId } = await store.set(
    seedAgentForInstructions$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "github-webhook-agent",
      workflowNames: [WORKFLOW_NAME],
    },
    context.signal,
  );
  const [workflow] = await store
    .set(writeDb$)
    .select({ id: zeroWorkflows.id })
    .from(zeroWorkflows)
    .where(
      and(
        eq(zeroWorkflows.orgId, fixture.orgId),
        eq(zeroWorkflows.agentId, agentId),
        eq(zeroWorkflows.name, WORKFLOW_NAME),
      ),
    );
  if (!workflow) {
    throw new Error("Expected the agent to own the seeded workflow");
  }
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
  return { fixture, agentId, workflowId: workflow.id };
}

function githubPayload(action: "labeled" | "opened"): string {
  return JSON.stringify({
    action,
    issue: {
      number: 42,
      title: "Needs triage",
      body: null,
      labels: [{ id: 1001, name: "triage" }],
      user: { id: 202, login: "issue-author", type: "User" },
    },
    ...(action === "labeled" ? { label: { id: 1001, name: "triage" } } : {}),
    repository: { full_name: "vm0-ai/vm0" },
    installation: { id: Number(GITHUB_INSTALLATION_REMOTE_ID) },
    sender: { id: 101, login: "lancy", type: "User" },
  });
}

async function postGithubWebhook(args: {
  readonly event: "issues" | "pull_request";
  readonly deliveryId: string;
  readonly rawBody: string;
}): Promise<{ readonly status: number; readonly text: string }> {
  const signature = `sha256=${createHmac("sha256", GITHUB_WEBHOOK_SECRET)
    .update(args.rawBody)
    .digest("hex")}`;
  const response = await createApp({ signal: context.signal }).request(
    "/api/webhooks/github",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": args.event,
        "x-github-delivery": args.deliveryId,
        "x-hub-signature-256": signature,
      },
      body: args.rawBody,
    },
  );
  return {
    status: response.status,
    text: await response.text(),
  };
}

describe("POST /api/webhooks/github for workflow triggers", () => {
  const track = createFixtureTracker<WorkflowsFixture>(async (fixture) => {
    const db = store.set(writeDb$);
    await deleteFeatureSwitchesForUser(context, fixture);
    await db
      .delete(githubInstallations)
      .where(eq(githubInstallations.orgId, fixture.orgId));
    await store.set(deleteWorkflowsForFixture$, fixture, context.signal);
  });

  it("dispatches matching label events and de-duplicates deliveries", async () => {
    mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", GITHUB_WEBHOOK_SECRET);
    const { fixture, agentId, workflowId } = await setupFixture();
    await track(Promise.resolve(fixture));
    await enableGithubWorkflowTriggers(fixture);
    const installationId = await seedGithubInstallation({
      fixture,
      composeId: agentId,
    });
    await seedGithubUserLink({ installationId, userId: fixture.userId });

    const runCalls: GithubWorkflowRunStartTestInput[] = [];
    const restoreRunStarter = setGithubWorkflowRunStarterForTests((input) => {
      runCalls.push(input);
      return Promise.resolve("ok");
    });
    onTestFinished(() => {
      restoreRunStarter();
    });

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "github-label-applied",
          eventConfig: {
            provider: "github",
            event: "label_applied",
            labelName: "TriAge",
            filters: {
              subject: "both",
              actor: { type: "me" },
            },
          },
        },
      }),
      [201],
    );

    const labeled = await postGithubWebhook({
      event: "issues",
      deliveryId: "delivery-1",
      rawBody: githubPayload("labeled"),
    });
    expect(labeled).toStrictEqual({ status: 200, text: "OK" });
    await flushWaitUntilForTest();

    const duplicate = await postGithubWebhook({
      event: "issues",
      deliveryId: "delivery-1",
      rawBody: githubPayload("labeled"),
    });
    expect(duplicate).toStrictEqual({ status: 200, text: "OK" });
    await flushWaitUntilForTest();

    const opened = await postGithubWebhook({
      event: "issues",
      deliveryId: "delivery-2",
      rawBody: githubPayload("opened"),
    });
    expect(opened).toStrictEqual({ status: 200, text: "OK" });
    await flushWaitUntilForTest();

    expect(runCalls).toStrictEqual([
      {
        triggerId: created.body.id,
        workflowName: WORKFLOW_NAME,
        deliveryId: "delivery-1",
        repo: "vm0-ai/vm0",
        subjectType: "issue",
        subjectNumber: 42,
        action: "labeled",
        labelName: "triage",
        actorLogin: "lancy",
      },
      {
        triggerId: created.body.id,
        workflowName: WORKFLOW_NAME,
        deliveryId: "delivery-2",
        repo: "vm0-ai/vm0",
        subjectType: "issue",
        subjectNumber: 42,
        action: "opened",
        labelName: "triage",
        actorLogin: "lancy",
      },
    ]);

    const processed = await store
      .set(writeDb$)
      .select({
        githubDeliveryId: zeroWorkflowGithubProcessedEvents.githubDeliveryId,
        action: zeroWorkflowGithubProcessedEvents.action,
        labelNameNormalized:
          zeroWorkflowGithubProcessedEvents.labelNameNormalized,
      })
      .from(zeroWorkflowGithubProcessedEvents)
      .where(eq(zeroWorkflowGithubProcessedEvents.triggerId, created.body.id))
      .orderBy(asc(zeroWorkflowGithubProcessedEvents.githubDeliveryId));
    expect(processed).toStrictEqual([
      {
        githubDeliveryId: "delivery-1",
        action: "labeled",
        labelNameNormalized: "triage",
      },
      {
        githubDeliveryId: "delivery-2",
        action: "opened",
        labelNameNormalized: "triage",
      },
    ]);
  });
});
