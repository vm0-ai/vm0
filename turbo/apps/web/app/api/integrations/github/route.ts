import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { githubInstallations } from "../../../../src/db/schema/github-installation";
import { agentComposes } from "../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../src/db/schema/scope";

/**
 * GET /api/integrations/github
 *
 * Returns GitHub App installation info for the authenticated user.
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
    const reqUrl = new URL(request.url);
    const baseUrl = `${reqUrl.protocol}//${reqUrl.host}`;
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

  // Get default agent info
  const [compose] = await db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      scopeSlug: scopes.slug,
    })
    .from(agentComposes)
    .innerJoin(scopes, eq(scopes.id, agentComposes.scopeId))
    .where(eq(agentComposes.id, installation.defaultComposeId))
    .limit(1);

  return NextResponse.json({
    installation: {
      id: installation.id,
      installationId: installation.installationId,
    },
    agent: compose
      ? { id: compose.id, name: compose.name, scopeSlug: compose.scopeSlug }
      : null,
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
