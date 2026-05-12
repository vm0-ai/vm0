import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { extractAndGroupVariables } from "@vm0/core/variable-expander";
import { getConnectorProvidedSecretNames } from "@vm0/connectors/connector-utils";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { getApiUrl } from "../../../../src/lib/infra/callback";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { listSecrets } from "../../../../src/lib/zero/secret/secret-service";
import { listVariables } from "../../../../src/lib/zero/variable/variable-service";
import { listConnectors } from "../../../../src/lib/zero/connector/connector-service";
import type { AgentComposeYaml } from "../../../../src/lib/infra/agent-compose/types";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { deleteInstallation } from "../../../../src/lib/zero/github/github-app";
import { logger } from "../../../../src/lib/shared/logger";

const patchGithubBodySchema = z.object({ agentName: z.string().min(1) });

/**
 * GET /api/integrations/github
 *
 * Returns GitHub App installation info for the authenticated user.
 * Finds installations via github_user_links join.
 * If no installation exists, returns 404 with an install URL.
 */
export async function GET(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);

  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  const { userId } = authCtx;

  const db = globalThis.services.db;

  // Find user's GitHub App installation via user link
  const [result] = await db
    .select({
      installation: githubInstallations,
      link: githubUserLinks,
    })
    .from(githubUserLinks)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.id, githubUserLinks.installationId),
    )
    .where(eq(githubUserLinks.vm0UserId, userId))
    .limit(1);

  if (!result) {
    const { GITHUB_APP_SLUG } = env();
    const baseUrl = getApiUrl();
    const { org } = await resolveOrg(authCtx);
    const installUrl = GITHUB_APP_SLUG
      ? githubInstallUrl(baseUrl, userId, org.defaultAgentId)
      : null;

    return NextResponse.json(
      {
        error: { message: "No GitHub installation found", code: "NOT_FOUND" },
        installUrl,
      },
      { status: 404 },
    );
  }

  const { installation } = result;

  // Determine if current user is the admin (both must be non-null)
  const isAdmin =
    !!installation.adminGithubUserId &&
    result.link.githubUserId === installation.adminGithubUserId;

  // Get default agent info with headVersionId for environment extraction
  const [compose] = await db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, installation.defaultComposeId))
    .limit(1);

  // Extract required secrets/vars from agent compose
  let requiredSecrets: string[] = [];
  let requiredVars: string[] = [];

  if (compose?.headVersionId) {
    const [version] = await db
      .select({ content: agentComposeVersions.content })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, compose.headVersionId))
      .limit(1);

    if (version) {
      const content = version.content as AgentComposeYaml;
      const grouped = extractAndGroupVariables(content);
      requiredSecrets = grouped.secrets.map((s) => {
        return s.name;
      });
      requiredVars = grouped.vars.map((v) => {
        return v.name;
      });
    }
  }

  // Resolve user's org for resource queries
  const { org } = await resolveOrg(authCtx);

  // Get user's existing secrets, vars, connectors
  const [userSecrets, userVars, userConnectors] = await Promise.all([
    listSecrets(org.orgId, userId),
    listVariables(org.orgId, userId),
    listConnectors(org.orgId, userId),
  ]);

  const connectorProvided = getConnectorProvidedSecretNames(
    userConnectors.map((c) => {
      return c.type;
    }),
  );
  const existingSecretNames = new Set([
    ...userSecrets.map((s) => {
      return s.name;
    }),
    ...connectorProvided,
  ]);
  const existingVarNames = new Set(
    userVars.map((v) => {
      return v.name;
    }),
  );

  const missingSecrets = requiredSecrets.filter((name) => {
    return !existingSecretNames.has(name);
  });
  const missingVars = requiredVars.filter((name) => {
    return !existingVarNames.has(name);
  });

  return NextResponse.json({
    installation: {
      id: installation.id,
      installationId: installation.installationId,
      status: installation.status,
      targetName: installation.targetName,
      targetType: installation.targetType,
      isAdmin,
    },
    agent: compose ? { id: compose.id, name: compose.name } : null,
    environment: {
      requiredSecrets,
      requiredVars,
      missingSecrets,
      missingVars,
    },
  });
}

function githubInstallUrl(
  baseUrl: string,
  userId: string,
  composeId: string | null,
): string {
  const url = new URL("/api/github/oauth/install", baseUrl);
  url.searchParams.set("vm0UserId", userId);
  if (composeId) {
    url.searchParams.set("composeId", composeId);
  }
  return url.toString();
}

/**
 * DELETE /api/integrations/github
 *
 * Removes the GitHub App installation. Only the admin can uninstall.
 * Cascades to delete all associated issue sessions and user links.
 */
export async function DELETE(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);

  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  const { userId } = authCtx;

  const db = globalThis.services.db;

  const log = logger("github:uninstall");

  // Find user's GitHub App installation via user link
  const [result] = await db
    .select({
      id: githubInstallations.id,
      ghInstallationId: githubInstallations.installationId,
      adminGithubUserId: githubInstallations.adminGithubUserId,
      githubUserId: githubUserLinks.githubUserId,
    })
    .from(githubUserLinks)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.id, githubUserLinks.installationId),
    )
    .where(eq(githubUserLinks.vm0UserId, userId))
    .limit(1);

  if (!result) {
    return NextResponse.json(
      { error: { message: "No GitHub installation found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Only admin can delete — also reject when adminGithubUserId is unset
  if (
    !result.adminGithubUserId ||
    result.githubUserId !== result.adminGithubUserId
  ) {
    return NextResponse.json(
      {
        error: {
          message: "Only the installation admin can uninstall",
          code: "FORBIDDEN",
        },
      },
      { status: 403 },
    );
  }

  // Uninstall from GitHub so reinstallation triggers a fresh callback
  const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY } = env();
  if (GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY && result.ghInstallationId) {
    try {
      await deleteInstallation(
        GITHUB_APP_ID,
        GITHUB_APP_PRIVATE_KEY,
        result.ghInstallationId,
      );
    } catch (err) {
      log.error("Failed to delete GitHub installation", { error: err });
      // Continue with local deletion even if GitHub API fails
    }
  }

  // Delete local installation record (cascades to github_issue_sessions and github_user_links)
  await db
    .delete(githubInstallations)
    .where(eq(githubInstallations.id, result.id));

  return NextResponse.json({ ok: true });
}

/**
 * PATCH /api/integrations/github
 *
 * Updates the default agent for the GitHub installation.
 * Only the admin can change the default agent.
 * Body: { agentName: string }
 */
export async function PATCH(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);

  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  const { userId } = authCtx;

  const parseResult = patchGithubBodySchema.safeParse(
    await request.json().catch(() => {
      return undefined;
    }),
  );
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { message: "agentName is required", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }
  const body = parseResult.data;

  const db = globalThis.services.db;

  // Find user's GitHub App installation via user link
  const [result] = await db
    .select({
      installationId: githubInstallations.id,
      adminGithubUserId: githubInstallations.adminGithubUserId,
      githubUserId: githubUserLinks.githubUserId,
    })
    .from(githubUserLinks)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.id, githubUserLinks.installationId),
    )
    .where(eq(githubUserLinks.vm0UserId, userId))
    .limit(1);

  if (!result) {
    return NextResponse.json(
      { error: { message: "No GitHub installation found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Only admin can change default agent — also reject when adminGithubUserId is unset
  if (
    !result.adminGithubUserId ||
    result.githubUserId !== result.adminGithubUserId
  ) {
    return NextResponse.json(
      {
        error: {
          message: "Only the installation admin can change the default agent",
          code: "FORBIDDEN",
        },
      },
      { status: 403 },
    );
  }

  // Resolve org from authenticated user's context
  const { org } = await resolveOrg(authCtx);

  // Find agent compose by name in user's org
  const [compose] = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.orgId, org.orgId),
        eq(agentComposes.name, body.agentName),
      ),
    )
    .limit(1);

  if (!compose) {
    return NextResponse.json(
      { error: { message: "Agent not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Update installation's default agent
  await db
    .update(githubInstallations)
    .set({ defaultComposeId: compose.id, updatedAt: new Date() })
    .where(eq(githubInstallations.id, result.installationId));

  return NextResponse.json({ ok: true });
}
