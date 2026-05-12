import { command } from "ccstate";
import { githubOauthContract } from "@vm0/api-contracts/contracts/github-oauth";

import { queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { env, optionalEnv } from "../../lib/env";
import {
  buildGithubOauthState,
  createOrActivateGithubInstallation,
  createPendingGithubInstallation,
  findGithubInstallationByInstallationId,
  getGithubInstallationAccessToken,
  getGithubInstallationInfo,
  isGithubOauthStateSignatureValid,
  linkGithubVm0User,
  parseGithubOauthState,
  tryLinkGithubFromLocalRecord,
  tryLinkGithubFromRemoteInstallations,
} from "../services/github-oauth.service";
import { encryptSecretValue } from "../services/crypto.utils";
import type { RouteEntry } from "../route";

const REDIRECT_STATUS = 307;

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url },
  });
}

function jsonErrorResponse(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function appUrl(path: string): string {
  return `${env("VM0_WEB_URL")}${path}`;
}

function callbackRedirectUri(): string {
  return `${env("VM0_API_URL")}/api/github/oauth/callback`;
}

function worksErrorRedirect(message: string): Response {
  return redirectResponse(
    appUrl(`/works?error=${encodeURIComponent(message)}`),
  );
}

const installGithubOauth$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const appSlug = optionalEnv("GITHUB_APP_SLUG");
    if (!appSlug) {
      return jsonErrorResponse("GitHub App integration is not configured", 503);
    }

    const query = get(queryOf(githubOauthContract.install));
    const appId = optionalEnv("GITHUB_APP_ID");
    const privateKey = optionalEnv("GITHUB_APP_PRIVATE_KEY");

    if (appId && privateKey && query.vm0UserId) {
      const db = set(writeDb$);
      const linkedFromLocal = await tryLinkGithubFromLocalRecord({
        db,
        vm0UserId: query.vm0UserId,
        signal,
      });
      signal.throwIfAborted();

      if (linkedFromLocal) {
        return redirectResponse(appUrl("/settings?tab=integrations"));
      }

      const linkedFromRemote = await tryLinkGithubFromRemoteInstallations({
        db,
        appId,
        privateKey,
        vm0UserId: query.vm0UserId,
        composeId: query.composeId ?? null,
        signal,
      });
      signal.throwIfAborted();

      if (linkedFromRemote) {
        return redirectResponse(appUrl("/settings?tab=integrations"));
      }
    }

    const state = await buildGithubOauthState({
      vm0UserId: query.vm0UserId,
      composeId: query.composeId,
      secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
    });
    signal.throwIfAborted();

    const installUrl = new URL(
      `https://github.com/apps/${appSlug}/installations/new`,
    );
    if (state) {
      installUrl.searchParams.set("state", state);
    }
    installUrl.searchParams.set("redirect_uri", callbackRedirectUri());

    return redirectResponse(installUrl.toString());
  },
);

const callbackGithubOauth$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const appId = optionalEnv("GITHUB_APP_ID");
    const privateKey = optionalEnv("GITHUB_APP_PRIVATE_KEY");

    if (!appId || !privateKey) {
      return worksErrorRedirect("GitHub App integration is not configured");
    }

    const query = get(queryOf(githubOauthContract.callback));

    if (query.setup_action === "update") {
      return redirectResponse(appUrl("/works"));
    }

    const secretsEncryptionKey = env("SECRETS_ENCRYPTION_KEY");
    const state = parseGithubOauthState(query.state);
    if (!state) {
      return worksErrorRedirect(
        "Invalid OAuth state. Please try installing again from the Platform.",
      );
    }

    if (
      !(await isGithubOauthStateSignatureValid({
        state,
        secretsEncryptionKey,
      }))
    ) {
      return worksErrorRedirect(
        "Invalid state signature. Please try installing again from the Platform.",
      );
    }

    const composeId = state.composeId;
    if (!composeId) {
      return worksErrorRedirect(
        "Missing default agent. Please select an agent before connecting GitHub.",
      );
    }

    const db = set(writeDb$);

    if (query.setup_action === "request") {
      await createPendingGithubInstallation({
        db,
        targetId: query.target_id ?? null,
        targetType: query.target_type ?? "Organization",
        composeId,
        signal,
      });

      return redirectResponse(appUrl("/works?pending=true"));
    }

    const installationId = query.installation_id;
    if (!installationId) {
      return worksErrorRedirect("Missing installation ID from GitHub");
    }

    const existing = await findGithubInstallationByInstallationId({
      db,
      installationId,
      signal,
    });
    if (existing) {
      if (state.vm0UserId) {
        await linkGithubVm0User({
          db,
          installRecordId: existing.id,
          vm0UserId: state.vm0UserId,
          signal,
        });
      }
      return redirectResponse(appUrl("/works"));
    }

    const installInfo = await getGithubInstallationInfo({
      appId,
      privateKey,
      installationId,
      signal,
    });
    signal.throwIfAborted();

    const { token } = await getGithubInstallationAccessToken({
      appId,
      privateKey,
      installationId,
      signal,
    });
    signal.throwIfAborted();

    const adminGithubUserId =
      installInfo.targetType === "User" ? installInfo.targetId : null;
    const installRecordId = await createOrActivateGithubInstallation({
      db,
      installationId,
      installInfo,
      encryptedAccessToken: encryptSecretValue(token),
      adminGithubUserId,
      composeId,
      signal,
    });

    if (state.vm0UserId) {
      await linkGithubVm0User({
        db,
        installRecordId,
        vm0UserId: state.vm0UserId,
        knownGithubUserId: adminGithubUserId,
        signal,
      });
    }

    return redirectResponse(appUrl("/works"));
  },
);

export const githubOauthRoutes: readonly RouteEntry[] = [
  {
    route: githubOauthContract.install,
    handler: installGithubOauth$,
  },
  {
    route: githubOauthContract.callback,
    handler: callbackGithubOauth$,
  },
];
