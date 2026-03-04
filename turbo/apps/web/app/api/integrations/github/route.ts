import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  extractVariableReferences,
  groupVariablesBySource,
  getConnectorProvidedSecretNames,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { getApiUrl } from "../../../../src/lib/callback";
import { githubInstallations } from "../../../../src/db/schema/github-installation";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../src/db/schema/scope";
import { listSecrets } from "../../../../src/lib/secret/secret-service";
import { listVariables } from "../../../../src/lib/variable/variable-service";
import { listConnectors } from "../../../../src/lib/connector/connector-service";
import type { AgentComposeYaml } from "../../../../src/types/agent-compose";
import {
  getScopeBySlug,
  getUserScopeByClerkId,
} from "../../../../src/lib/scope/scope-service";

/**
 * GET /api/integrations/github
 *
 * Returns GitHub App installation info for the authenticated user,
 * including current agent and environment variable status.
 * If no installation exists, returns 404 with an install URL.
 */
export async function GET(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const userId = await getUserId(authHeader ?? undefined);

  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const db = globalThis.services.db;

  // Find user's GitHub App installation
  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, userId))
    .limit(1);

  if (!installation) {
    const { GITHUB_APP_SLUG } = env();
    const baseUrl = getApiUrl();
    const installUrl = GITHUB_APP_SLUG
      ? `${baseUrl}/api/github/oauth/install?vm0UserId=${encodeURIComponent(userId)}`
      : null;

    return NextResponse.json(
      {
        error: { message: "No GitHub installation found", code: "NOT_FOUND" },
        installUrl,
      },
      { status: 404 },
    );
  }

  // Get default agent info with headVersionId for environment extraction
  const [compose] = await db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
      scopeSlug: scopes.slug,
    })
    .from(agentComposes)
    .innerJoin(scopes, eq(scopes.id, agentComposes.scopeId))
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
      const refs = extractVariableReferences(content);
      const grouped = groupVariablesBySource(refs);
      requiredSecrets = [
        ...grouped.secrets.map((s) => s.name),
        ...grouped.credentials.map((s) => s.name),
      ];
      requiredVars = grouped.vars.map((v) => v.name);
    }
  }

  // Get user's existing secrets, vars, connectors
  const [userSecrets, userVars, userConnectors] = await Promise.all([
    listSecrets(userId),
    listVariables(userId),
    listConnectors(userId),
  ]);

  const connectorProvided = getConnectorProvidedSecretNames(
    userConnectors.map((c) => c.type),
  );
  const existingSecretNames = new Set([
    ...userSecrets.map((s) => s.name),
    ...connectorProvided,
  ]);
  const existingVarNames = new Set(userVars.map((v) => v.name));

  const missingSecrets = requiredSecrets.filter(
    (name) => !existingSecretNames.has(name),
  );
  const missingVars = requiredVars.filter(
    (name) => !existingVarNames.has(name),
  );

  return NextResponse.json({
    installation: {
      id: installation.id,
      installationId: installation.installationId,
      status: installation.status,
    },
    agent: compose
      ? { id: compose.id, name: compose.name, scopeSlug: compose.scopeSlug }
      : null,
    environment: {
      requiredSecrets,
      requiredVars,
      missingSecrets,
      missingVars,
    },
  });
}

/**
 * DELETE /api/integrations/github
 *
 * Removes the authenticated user's GitHub App installation.
 * Cascades to delete all associated issue sessions.
 */
export async function DELETE(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const userId = await getUserId(authHeader ?? undefined);

  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const db = globalThis.services.db;

  // Find user's GitHub App installation
  const [installation] = await db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, userId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      { error: { message: "No GitHub installation found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Delete installation (cascades to github_issue_sessions)
  await db
    .delete(githubInstallations)
    .where(eq(githubInstallations.id, installation.id));

  return NextResponse.json({ ok: true });
}

/**
 * PATCH /api/integrations/github
 *
 * Updates the default agent for the authenticated user's GitHub installation.
 * Body: { agentName: string }
 */
export async function PATCH(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const userId = await getUserId(authHeader ?? undefined);

  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const body = (await request.json()) as { agentName?: string };
  if (!body.agentName) {
    return NextResponse.json(
      { error: { message: "agentName is required", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  const db = globalThis.services.db;

  // Find user's GitHub App installation
  const [installation] = await db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, userId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      { error: { message: "No GitHub installation found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Parse scope/agentName format (shared agents use "scopeSlug/agentName")
  const slashIndex = body.agentName.indexOf("/");
  const agentName =
    slashIndex === -1 ? body.agentName : body.agentName.slice(slashIndex + 1);
  const scopeSlug =
    slashIndex === -1 ? null : body.agentName.slice(0, slashIndex);

  // Resolve target scope
  const targetScope = scopeSlug
    ? await getScopeBySlug(scopeSlug)
    : await getUserScopeByClerkId(userId);

  if (!targetScope) {
    return NextResponse.json(
      { error: { message: "Scope not found", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  // Find agent compose by name in target scope
  const [compose] = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.scopeId, targetScope.id),
        eq(agentComposes.name, agentName),
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
    .where(eq(githubInstallations.id, installation.id));

  return NextResponse.json({ ok: true });
}
