import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { integrationsGithubContract } from "@vm0/api-contracts/contracts/integrations-github";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { connectors } from "@vm0/db/schema/connector";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";

const context = testContext();
const store = createStore();
const writeDb = store.set(writeDb$);

interface GithubFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly installationRowId: string;
}

interface DefaultAgentFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
}

interface SeedGithubFixtureOptions {
  readonly admin?: "matching" | "none" | "other";
  readonly composeName?: string;
  readonly content?: Record<string, unknown>;
}

function authHeaders(): Record<string, string> {
  return { authorization: "Bearer clerk-session" };
}

function mockSession(
  userId: string,
  orgId: string | null,
  orgRole: "org:admin" | "org:member" | undefined = orgId
    ? "org:admin"
    : undefined,
): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return {
        userId,
        orgId,
        orgRole,
      };
    },
  });
}

function githubUserId(): string {
  return `gh_${randomUUID().replaceAll("-", "")}`;
}

function remoteInstallationId(): string {
  return String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);
}

function variableReference(source: "secrets" | "vars", name: string): string {
  return `$${"{{"} ${source}.${name} }}`;
}

async function seedGithubFixture(
  options: SeedGithubFixtureOptions = {},
): Promise<GithubFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const composeId = randomUUID();
  const composeName = options.composeName ?? `github-agent-${composeId}`;

  await writeDb.insert(agentComposes).values({
    id: composeId,
    orgId,
    userId,
    name: composeName,
  });

  if (options.content) {
    const versionId = randomUUID().replaceAll("-", "");
    await writeDb.insert(agentComposeVersions).values({
      id: versionId,
      composeId,
      content: options.content,
      createdBy: userId,
    });
    await writeDb
      .update(agentComposes)
      .set({ headVersionId: versionId })
      .where(eq(agentComposes.id, composeId));
  }

  const linkedGithubUserId = githubUserId();
  const adminGithubUserId =
    options.admin === "none"
      ? null
      : options.admin === "other"
        ? githubUserId()
        : linkedGithubUserId;

  const [installation] = await writeDb
    .insert(githubInstallations)
    .values({
      installationId: remoteInstallationId(),
      adminGithubUserId,
      defaultComposeId: composeId,
      targetName: "vm0-test",
      targetType: "Organization",
    })
    .returning({ id: githubInstallations.id });
  if (!installation) {
    throw new Error("Expected GitHub installation insert to return a row");
  }

  await writeDb.insert(githubUserLinks).values({
    githubUserId: linkedGithubUserId,
    installationId: installation.id,
    vm0UserId: userId,
  });

  return {
    orgId,
    userId,
    composeId,
    installationRowId: installation.id,
  };
}

async function cleanupGithubFixture(fixture: GithubFixture): Promise<void> {
  await writeDb
    .delete(connectors)
    .where(
      and(
        eq(connectors.orgId, fixture.orgId),
        eq(connectors.userId, fixture.userId),
      ),
    );
  await writeDb
    .delete(secrets)
    .where(
      and(eq(secrets.orgId, fixture.orgId), eq(secrets.userId, fixture.userId)),
    );
  await writeDb
    .delete(variables)
    .where(
      and(
        eq(variables.orgId, fixture.orgId),
        eq(variables.userId, fixture.userId),
      ),
    );
  await writeDb
    .delete(githubInstallations)
    .where(eq(githubInstallations.id, fixture.installationRowId));
  await writeDb
    .delete(agentComposeVersions)
    .where(eq(agentComposeVersions.composeId, fixture.composeId));
  await writeDb
    .delete(agentComposes)
    .where(eq(agentComposes.id, fixture.composeId));
}

async function seedDefaultAgentFixture(): Promise<DefaultAgentFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const composeId = randomUUID();

  await writeDb.insert(agentComposes).values({
    id: composeId,
    orgId,
    userId,
    name: `default-github-agent-${composeId}`,
  });
  await writeDb.insert(orgMetadata).values({
    orgId,
    defaultAgentId: composeId,
  });

  return { orgId, userId, composeId };
}

async function cleanupDefaultAgentFixture(
  fixture: DefaultAgentFixture,
): Promise<void> {
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await writeDb
    .delete(agentComposes)
    .where(eq(agentComposes.id, fixture.composeId));
}

async function seedSecret(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}): Promise<void> {
  await writeDb.insert(secrets).values({
    orgId: args.orgId,
    userId: args.userId,
    name: args.name,
    encryptedValue: "encrypted-test-value",
    type: "user",
  });
}

async function seedVariable(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly value: string;
}): Promise<void> {
  await writeDb.insert(variables).values({
    orgId: args.orgId,
    userId: args.userId,
    name: args.name,
    value: args.value,
  });
}

async function seedGithubConnector(args: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  await writeDb.insert(connectors).values({
    orgId: args.orgId,
    userId: args.userId,
    type: "github",
    authMethod: "oauth",
    externalId: githubUserId(),
    externalUsername: "octocat",
    externalEmail: "octocat@example.test",
    oauthScopes: JSON.stringify(["repo"]),
  });
}

describe("GET /api/integrations/github", () => {
  const fixtures: GithubFixture[] = [];
  const defaultAgentFixtures: DefaultAgentFixture[] = [];

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await cleanupGithubFixture(fixture);
      }
    }
    while (defaultAgentFixtures.length > 0) {
      const fixture = defaultAgentFixtures.pop();
      if (fixture) {
        await cleanupDefaultAgentFixture(fixture);
      }
    }
  });

  it("returns 401 when no user is authenticated", async () => {
    const client = setupApp({ context })(integrationsGithubContract);

    const response = await accept(
      client.getInstallation({ headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 with installUrl when the authenticated user has no GitHub installation", async () => {
    const fixture = await seedDefaultAgentFixture();
    defaultAgentFixtures.push(fixture);
    mockSession(fixture.userId, fixture.orgId);
    mockEnv("VM0_API_URL", "https://api.vm0.test");
    mockOptionalEnv("GITHUB_APP_SLUG", "vm0-test");
    const client = setupApp({ context })(integrationsGithubContract);

    const response = await accept(
      client.getInstallation({ headers: authHeaders() }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "No GitHub installation found",
        code: "NOT_FOUND",
      },
      installUrl: `https://api.vm0.test/api/github/oauth/install?vm0UserId=${encodeURIComponent(
        fixture.userId,
      )}&composeId=${fixture.composeId}`,
    });
  });

  it("returns linked installation data and agent data", async () => {
    const fixture = await seedGithubFixture({
      composeName: "github-support-agent",
    });
    fixtures.push(fixture);
    mockSession(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(integrationsGithubContract);

    const response = await accept(
      client.getInstallation({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.installation).toMatchObject({
      id: fixture.installationRowId,
      status: "active",
      targetName: "vm0-test",
      targetType: "Organization",
      isAdmin: true,
    });
    expect(response.body.installation.installationId).toBeTruthy();
    expect(response.body.agent).toStrictEqual({
      id: fixture.composeId,
      name: "github-support-agent",
    });
    expect(response.body.environment).toStrictEqual({
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    });
  });

  it("returns isAdmin false when the linked GitHub user is not the installation admin", async () => {
    const fixture = await seedGithubFixture({ admin: "other" });
    fixtures.push(fixture);
    mockSession(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(integrationsGithubContract);

    const response = await accept(
      client.getInstallation({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.installation.isAdmin).toBeFalsy();
  });

  it("returns isAdmin false when the installation has no admin GitHub user", async () => {
    const fixture = await seedGithubFixture({ admin: "none" });
    fixtures.push(fixture);
    mockSession(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(integrationsGithubContract);

    const response = await accept(
      client.getInstallation({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.installation.isAdmin).toBeFalsy();
  });

  it("reports required and missing environment values from the default agent", async () => {
    const fixture = await seedGithubFixture({
      content: {
        agents: {
          main: {
            env: {
              PRESENT_SECRET: variableReference("secrets", "PRESENT_SECRET"),
              MISSING_SECRET: variableReference("secrets", "MISSING_SECRET"),
              GITHUB_TOKEN: variableReference("secrets", "GITHUB_TOKEN"),
              PRESENT_VAR: variableReference("vars", "PRESENT_VAR"),
              MISSING_VAR: variableReference("vars", "MISSING_VAR"),
            },
          },
        },
      },
    });
    fixtures.push(fixture);
    await seedSecret({
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "PRESENT_SECRET",
    });
    await seedVariable({
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "PRESENT_VAR",
      value: "ready",
    });
    await seedGithubConnector({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    mockSession(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(integrationsGithubContract);

    const response = await accept(
      client.getInstallation({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.environment.requiredSecrets).toStrictEqual(
      expect.arrayContaining([
        "PRESENT_SECRET",
        "MISSING_SECRET",
        "GITHUB_TOKEN",
      ]),
    );
    expect(response.body.environment.requiredVars).toStrictEqual(
      expect.arrayContaining(["PRESENT_VAR", "MISSING_VAR"]),
    );
    expect(response.body.environment.missingSecrets).toStrictEqual([
      "MISSING_SECRET",
    ]);
    expect(response.body.environment.missingVars).toStrictEqual([
      "MISSING_VAR",
    ]);
  });

  it("returns 400 after installation lookup when active org context is missing", async () => {
    const fixture = await seedGithubFixture();
    fixtures.push(fixture);
    mockSession(fixture.userId, null);
    const client = setupApp({ context })(integrationsGithubContract);

    const response = await accept(
      client.getInstallation({ headers: authHeaders() }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Explicit org context required — ensure active org in session",
        code: "BAD_REQUEST",
      },
    });
  });
});
