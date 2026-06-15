import { githubInstallations } from "@vm0/db/schema/github-installation";
import { and, eq } from "drizzle-orm";

import { optionalEnv } from "../../lib/env";
import type { ReadonlyDb } from "../external/db";
import { getGithubInstallationAccessToken } from "./github-app.service";

type ActiveGithubInstallation = typeof githubInstallations.$inferSelect;

export async function loadActiveGithubInstallationForOrg(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
}): Promise<ActiveGithubInstallation | null> {
  const [installation] = await args.db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.orgId, args.orgId),
        eq(githubInstallations.status, "active"),
      ),
    )
    .limit(1);

  return installation ?? null;
}

export async function getGithubIntegrationAccessToken(args: {
  readonly installation: ActiveGithubInstallation;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  if (!args.installation.installationId) {
    return null;
  }

  const appId = optionalEnv("GITHUB_APP_ID");
  const privateKey = optionalEnv("GITHUB_APP_PRIVATE_KEY");
  if (!appId || !privateKey) {
    throw new Error("GitHub App credentials are not configured");
  }

  const { token } = await getGithubInstallationAccessToken({
    appId,
    privateKey,
    installationId: args.installation.installationId,
    signal: args.signal,
  });
  return token;
}
