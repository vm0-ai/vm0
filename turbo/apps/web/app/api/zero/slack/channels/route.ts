import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { slackOrgInstallations } from "../../../../../src/db/schema/slack-org-installation";
import { createSlackClient } from "../../../../../src/lib/slack";
import { decryptSecretValue } from "../../../../../src/lib/crypto/secrets-encryption";

/**
 * GET /api/zero/slack/channels
 *
 * Returns Slack channels where the bot is a member for the authenticated user's org.
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

  const orgSlug = new URL(request.url).searchParams.get("org");
  const { org } = await resolveOrg(authCtx, orgSlug);

  const db = globalThis.services.db;

  const [installation] = await db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, org.orgId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      {
        error: {
          message: "No Slack installation found for this org",
          code: "NOT_FOUND",
        },
      },
      { status: 404 },
    );
  }

  const { SECRETS_ENCRYPTION_KEY } = env();
  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  const channels: { id: string; name: string }[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor,
    });

    for (const ch of result.channels ?? []) {
      if (ch.is_member && ch.id && ch.name) {
        channels.push({ id: ch.id, name: ch.name });
      }
    }

    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  channels.sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ channels });
}
