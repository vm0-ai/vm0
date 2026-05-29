import { command } from "ccstate";
import {
  githubOauthContract,
  type GithubOauthConnectQuery,
} from "@vm0/api-contracts/contracts/github-oauth";
import type { AuthCodeGrantConnectorType } from "@vm0/connectors/connectors";
import {
  getConnectorAuthMethodGrantScopes,
  resolveConnectorAuthClientForMethod,
  isStaticConfidentialConnectorAuthClient,
  type StaticConfidentialConnectorAuthClient,
} from "@vm0/connectors/connector-utils";
import { exchangeConnectorAuthCode } from "@vm0/connectors/auth-providers";
import {
  exchangeGitHubCode,
  fetchGitHubUserInfo,
} from "@vm0/connectors/auth-providers/oauth/providers/github";

import { requiredAuthContext$ } from "../auth/auth-context";
import { queryOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { getMemberRoleAndUpdateCache$ } from "../services/auth.service";
import {
  buildGithubOauthState,
  buildGithubUserConnectAuthorizationUrl,
  createOrActivateGithubInstallation,
  findGithubInstallationByInstallationId,
  getGithubInstallationAccessToken,
  getGithubInstallationInfo,
  githubUserConnectCallbackRedirectUri,
  isGithubOauthStateSignatureValid,
  linkGithubVm0User,
  loadActiveGithubInstallationForOrg,
  loadComposeFeatureSwitchContext,
  parseGithubOauthState,
  resolveGithubOauthOrgId,
  tryLinkGithubFromLocalRecord,
  tryLinkGithubFromRemoteInstallations,
  verifyGithubConnectSignature,
} from "../services/github-oauth.service";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import { upsertConnectorTokenConnection$ } from "../services/zero-connector-data.service";
import { settle } from "../utils";
import type { RouteEntry } from "../route";
import {
  getOAuthCanonicalRedirectUrl,
  getOAuthWebOrigin,
} from "./oauth-web-origin";

const REDIRECT_STATUS = 307;
const GITHUB_CONNECTOR_TYPE = "github" satisfies AuthCodeGrantConnectorType;
const GITHUB_CONNECTOR_AUTH_METHOD = "oauth";
const GITHUB_APP_SETUP_CALLBACK_PATH = "/api/github/app/setup/callback";
const L = logger("GithubOAuthRoute");

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url },
  });
}

function noStoreRedirect(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url, "Cache-Control": "no-store" },
  });
}

function jsonErrorResponse(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function appUrl(path: string): string {
  return `${env("APP_URL").replace(/\/$/u, "")}${path}`;
}

function githubAppSetupCallbackRedirectUri(origin: string): string {
  return `${origin}${GITHUB_APP_SETUP_CALLBACK_PATH}`;
}

function githubUserOauthClient():
  | StaticConfidentialConnectorAuthClient
  | undefined {
  const authClient = resolveConnectorAuthClientForMethod(
    GITHUB_CONNECTOR_TYPE,
    GITHUB_CONNECTOR_AUTH_METHOD,
    optionalEnv,
  );
  if (!authClient) {
    return undefined;
  }
  if (!isStaticConfidentialConnectorAuthClient(authClient)) {
    return undefined;
  }
  return authClient;
}

function githubAppUserOauthCredentials():
  | { readonly clientId: string; readonly clientSecret: string }
  | undefined {
  const clientId = optionalEnv("GITHUB_APP_CLIENT_ID");
  const clientSecret = optionalEnv("GITHUB_APP_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return undefined;
  }
  return { clientId, clientSecret };
}

function worksErrorRedirect(message: string): Response {
  return redirectResponse(
    appUrl(`/works?error=${encodeURIComponent(message)}`),
  );
}

function hasGithubConnectSignatureQuery(
  query: GithubOauthConnectQuery,
): boolean {
  return Boolean(query.installation || query.ghUser || query.ts || query.sig);
}

function errorMessageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : "GitHub authorization failed";
}

const GITHUB_INSTALL_ADMIN_REQUIRED =
  "Only organization admins can install GitHub";

const GITHUB_SINGLE_INSTALLATION_REQUIRED =
  "GitHub is already installed for this organization";

const GITHUB_INSTALL_GITHUB_ADMIN_REQUIRED =
  "You don't have permission to install this GitHub App. Ask a GitHub organization owner to install it, then try again.";

type ParsedGithubOauthState = NonNullable<
  ReturnType<typeof parseGithubOauthState>
>;

type GithubCallbackStateResolution =
  | {
      readonly ok: true;
      readonly state: ParsedGithubOauthState;
      readonly composeId: string;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

type GithubCallbackAccessResolution =
  | {
      readonly ok: true;
      readonly orgAlreadyHasActiveInstallation: boolean;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

type GithubSetupUserConnectionResolution =
  | {
      readonly ok: true;
      readonly connected: boolean;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

type GithubSetupUserConnectionArgs = {
  readonly db: Db;
  readonly orgId: string;
  readonly installRecordId: string;
  readonly ghInstallationId: string | null;
  readonly state: ParsedGithubOauthState;
  readonly code: string | undefined;
  readonly knownGithubUserId: string | null;
};

function githubSetupCodeExchangeLogContext(
  args: GithubSetupUserConnectionArgs,
  vm0UserId: string,
): {
  readonly orgId: string;
  readonly vm0UserId: string;
  readonly ghInstallationId: string | null;
  readonly installRecordId: string;
} {
  return {
    orgId: args.orgId,
    vm0UserId,
    ghInstallationId: args.ghInstallationId,
    installRecordId: args.installRecordId,
  };
}

const isGithubInstallOrgAdmin$ = command(
  async (
    { set },
    args: { readonly orgId: string | null; readonly userId: string | null },
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!args.orgId || !args.userId) {
      return false;
    }
    const membership = await set(
      getMemberRoleAndUpdateCache$,
      args.orgId,
      args.userId,
      signal,
    );
    signal.throwIfAborted();
    return membership?.role === "admin";
  },
);

const hasActiveGithubInstallationForOrg$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<boolean> => {
    const db = set(writeDb$);
    const installation = await loadActiveGithubInstallationForOrg({
      db,
      orgId,
      signal,
    });
    return installation !== null;
  },
);

async function resolveGithubCallbackState(args: {
  readonly stateString: string | undefined;
  readonly secretsEncryptionKey: string;
}): Promise<GithubCallbackStateResolution> {
  const state = parseGithubOauthState(args.stateString);
  if (!state) {
    return {
      ok: false,
      response: worksErrorRedirect(
        "Invalid OAuth state. Please try installing again from the Platform.",
      ),
    };
  }

  if (
    !(await isGithubOauthStateSignatureValid({
      state,
      secretsEncryptionKey: args.secretsEncryptionKey,
    }))
  ) {
    return {
      ok: false,
      response: worksErrorRedirect(
        "Invalid state signature. Please try installing again from the Platform.",
      ),
    };
  }

  if (!state.composeId) {
    return {
      ok: false,
      response: worksErrorRedirect(
        "Missing default agent. Please select an agent before connecting GitHub.",
      ),
    };
  }

  return { ok: true, state, composeId: state.composeId };
}

const resolveGithubCallbackAccess$ = command(
  async (
    { set },
    args: {
      readonly state: ParsedGithubOauthState;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<GithubCallbackAccessResolution> => {
    if (
      args.state.orgId &&
      args.state.vm0UserId &&
      !(await set(
        isGithubInstallOrgAdmin$,
        { orgId: args.state.orgId, userId: args.state.vm0UserId },
        signal,
      ))
    ) {
      return {
        ok: false,
        response: worksErrorRedirect(GITHUB_INSTALL_ADMIN_REQUIRED),
      };
    }

    const orgAlreadyHasActiveInstallation = await set(
      hasActiveGithubInstallationForOrg$,
      args.orgId,
      signal,
    );
    signal.throwIfAborted();

    return { ok: true, orgAlreadyHasActiveInstallation };
  },
);

const connectGithubUserAfterSetup$ = command(
  async (
    { set },
    args: GithubSetupUserConnectionArgs,
    signal: AbortSignal,
  ): Promise<GithubSetupUserConnectionResolution> => {
    const vm0UserId = args.state.vm0UserId;
    if (!vm0UserId) {
      return { ok: true, connected: false };
    }

    const code = args.code;
    if (code) {
      const codeExchangeLogContext = githubSetupCodeExchangeLogContext(
        args,
        vm0UserId,
      );
      const credentials = githubAppUserOauthCredentials();
      if (!credentials) {
        L.warn(
          "GitHub setup code exchange skipped: App OAuth is not configured",
          {
            ...codeExchangeLogContext,
          },
        );
        return {
          ok: false,
          response: worksErrorRedirect("GitHub App OAuth is not configured"),
        };
      }

      L.warn("Starting GitHub setup code exchange", {
        ...codeExchangeLogContext,
        client: "github_app",
        sendsRedirectUri: false,
      });

      const tokenResult = await settle(
        (async () => {
          const { accessToken, scopes } = await exchangeGitHubCode(
            credentials.clientId,
            credentials.clientSecret,
            code,
          );
          signal.throwIfAborted();
          const userInfo = await fetchGitHubUserInfo(accessToken);
          signal.throwIfAborted();
          return { accessToken, scopes, userInfo };
        })(),
        signal,
      );
      signal.throwIfAborted();
      if (!tokenResult.ok) {
        L.warn("GitHub setup code exchange failed", {
          ...codeExchangeLogContext,
          error: errorMessageFromUnknown(tokenResult.error),
        });
        return {
          ok: false,
          response: worksErrorRedirect(
            errorMessageFromUnknown(tokenResult.error),
          ),
        };
      }
      const { accessToken, scopes, userInfo } = tokenResult.value;
      L.warn("GitHub setup code exchange succeeded", {
        ...codeExchangeLogContext,
        githubUserId: userInfo.id,
        githubUsername: userInfo.username,
        scopes,
      });

      await set(
        upsertConnectorTokenConnection$,
        {
          orgId: args.orgId,
          userId: vm0UserId,
          type: GITHUB_CONNECTOR_TYPE,
          authMethod: GITHUB_CONNECTOR_AUTH_METHOD,
          accessToken,
          userInfo,
          oauthScopes:
            scopes.length > 0
              ? scopes
              : getConnectorAuthMethodGrantScopes(
                  GITHUB_CONNECTOR_TYPE,
                  GITHUB_CONNECTOR_AUTH_METHOD,
                ),
        },
        signal,
      );
      signal.throwIfAborted();

      const githubUserId = await linkGithubVm0User({
        db: args.db,
        installRecordId: args.installRecordId,
        vm0UserId,
        knownGithubUserId: userInfo.id,
        signal,
      });
      signal.throwIfAborted();

      if (!githubUserId) {
        return {
          ok: false,
          response: worksErrorRedirect(
            "This GitHub account is already linked to the installation",
          ),
        };
      }

      await publishUserSignal([vm0UserId], "github:changed");
      signal.throwIfAborted();

      return { ok: true, connected: true };
    }

    const githubUserId = await linkGithubVm0User({
      db: args.db,
      installRecordId: args.installRecordId,
      vm0UserId,
      knownGithubUserId: args.knownGithubUserId,
      signal,
    });
    signal.throwIfAborted();

    if (githubUserId) {
      await publishUserSignal([vm0UserId], "github:changed");
      signal.throwIfAborted();
    }

    return { ok: true, connected: githubUserId !== null };
  },
);

function githubSetupCompleteRedirect(connected: boolean): Response {
  if (connected) {
    return redirectResponse(appUrl("/works?github=connected"));
  }
  return redirectResponse(appUrl("/works?github=installed"));
}

async function createActiveGithubInstallationFromCallback(args: {
  readonly db: Db;
  readonly appId: string;
  readonly privateKey: string;
  readonly orgId: string;
  readonly composeId: string;
  readonly installationId: string;
  readonly state: ParsedGithubOauthState;
  readonly signal: AbortSignal;
}): Promise<{
  readonly installRecordId: string;
  readonly adminGithubUserId: string | null;
}> {
  const installInfo = await getGithubInstallationInfo({
    appId: args.appId,
    privateKey: args.privateKey,
    installationId: args.installationId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  const { token } = await getGithubInstallationAccessToken({
    appId: args.appId,
    privateKey: args.privateKey,
    installationId: args.installationId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  const adminGithubUserId =
    installInfo.targetType === "User" ? installInfo.targetId : null;
  const featureSwitchContext = await loadComposeFeatureSwitchContext({
    db: args.db,
    composeId: args.composeId,
    userId: args.state.vm0UserId,
    signal: args.signal,
  });
  const installRecordId = await createOrActivateGithubInstallation({
    db: args.db,
    orgId: args.orgId,
    installationId: args.installationId,
    installInfo,
    encryptedAccessToken: await encryptPersistentSecretValue(
      token,
      featureSwitchContext,
    ),
    adminGithubUserId,
    composeId: args.composeId,
    signal: args.signal,
  });

  return { installRecordId, adminGithubUserId };
}

const installGithubOauth$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$).raw;
    const canonicalRedirectUrl = getOAuthCanonicalRedirectUrl(request);
    if (canonicalRedirectUrl) {
      return noStoreRedirect(canonicalRedirectUrl);
    }
    const origin = getOAuthWebOrigin(request);
    const appSlug = optionalEnv("GITHUB_APP_SLUG");
    if (!appSlug) {
      return jsonErrorResponse("GitHub App integration is not configured", 503);
    }

    const query = get(queryOf(githubOauthContract.install));
    const appId = optionalEnv("GITHUB_APP_ID");
    const privateKey = optionalEnv("GITHUB_APP_PRIVATE_KEY");

    if (
      query.orgId &&
      query.vm0UserId &&
      !(await set(
        isGithubInstallOrgAdmin$,
        { orgId: query.orgId, userId: query.vm0UserId },
        signal,
      ))
    ) {
      return worksErrorRedirect(GITHUB_INSTALL_ADMIN_REQUIRED);
    }

    if (appId && privateKey && query.vm0UserId) {
      const db = set(writeDb$);
      const linkedFromLocal = query.orgId
        ? await tryLinkGithubFromLocalRecord({
            db,
            orgId: query.orgId,
            vm0UserId: query.vm0UserId,
            signal,
          })
        : false;
      signal.throwIfAborted();

      if (linkedFromLocal) {
        return redirectResponse(appUrl("/works?github=connected"));
      }

      const linkedFromRemote = await tryLinkGithubFromRemoteInstallations({
        db,
        appId,
        privateKey,
        orgId: query.orgId ?? null,
        vm0UserId: query.vm0UserId,
        composeId: query.composeId ?? null,
        signal,
      });
      signal.throwIfAborted();

      if (linkedFromRemote) {
        return redirectResponse(appUrl("/works?github=connected"));
      }
    }

    const state = await buildGithubOauthState({
      vm0UserId: query.vm0UserId,
      orgId: query.orgId,
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
    installUrl.searchParams.set(
      "redirect_uri",
      githubAppSetupCallbackRedirectUri(origin),
    );

    return noStoreRedirect(installUrl.toString());
  },
);

function invalidGithubConnectLinkRedirect(): Response {
  return worksErrorRedirect(
    "Invalid or expired GitHub connect link. Ask the bot for a new link.",
  );
}

function signInRedirect(requestUrl: string): Response {
  const signInUrl = new URL("/sign-in", requestUrl);
  signInUrl.searchParams.set("redirect_url", requestUrl);
  return redirectResponse(signInUrl.toString());
}

const connectGithubUserOauth$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$).raw;
    const canonicalRedirectUrl = getOAuthCanonicalRedirectUrl(request);
    if (canonicalRedirectUrl) {
      return noStoreRedirect(canonicalRedirectUrl);
    }

    const query = get(queryOf(githubOauthContract.connect));
    const auth = await set(
      requiredAuthContext$,
      { requireOrganization: true },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in auth) {
      return auth.status === 401
        ? signInRedirect(request.url)
        : worksErrorRedirect(auth.body.error.message);
    }
    if (!auth.orgId) {
      return worksErrorRedirect("Explicit org context required");
    }
    const orgId = auth.orgId;

    if (hasGithubConnectSignatureQuery(query)) {
      if (!query.installation || !query.ghUser || !query.ts || !query.sig) {
        return invalidGithubConnectLinkRedirect();
      }

      if (
        !verifyGithubConnectSignature({
          installationId: query.installation,
          githubUserId: query.ghUser,
          githubUsername: query.ghLogin,
          timestamp: query.ts,
          signature: query.sig,
          secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
        })
      ) {
        return invalidGithubConnectLinkRedirect();
      }

      const db = set(writeDb$);
      const installation = await findGithubInstallationByInstallationId({
        db,
        installationId: query.installation,
        orgId,
        signal,
      });
      signal.throwIfAborted();

      if (!installation) {
        return worksErrorRedirect(
          "No GitHub installation found for this workspace",
        );
      }

      const githubUserId = await linkGithubVm0User({
        db,
        installRecordId: installation.id,
        vm0UserId: auth.userId,
        knownGithubUserId: query.ghUser,
        signal,
      });
      signal.throwIfAborted();

      if (!githubUserId) {
        return worksErrorRedirect(
          "This GitHub account is already linked to the installation",
        );
      }

      await publishUserSignal([auth.userId], "github:changed");
      signal.throwIfAborted();

      return redirectResponse(appUrl("/works?github=connected"));
    }

    const origin = getOAuthWebOrigin(request);
    const db = set(writeDb$);
    const authorizationUrl = await buildGithubUserConnectAuthorizationUrl({
      db,
      vm0UserId: auth.userId,
      orgId,
      origin,
      readEnv: optionalEnv,
      signal,
    });
    signal.throwIfAborted();

    if (!authorizationUrl) {
      return worksErrorRedirect("GitHub OAuth is not configured");
    }

    return noStoreRedirect(authorizationUrl);
  },
);

const callbackGithubUserOauth$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$).raw;
    const canonicalRedirectUrl = getOAuthCanonicalRedirectUrl(request);
    if (canonicalRedirectUrl) {
      return noStoreRedirect(canonicalRedirectUrl);
    }

    const query = get(queryOf(githubOauthContract.connectCallback));
    if (query.error) {
      return worksErrorRedirect(
        query.error_description || query.error || "GitHub authorization failed",
      );
    }
    if (!query.code) {
      return worksErrorRedirect("Missing authorization code from GitHub");
    }

    const state = parseGithubOauthState(query.state);
    if (!state?.vm0UserId || !state.orgId) {
      return worksErrorRedirect(
        "Invalid OAuth state. Please try connecting again from the Platform.",
      );
    }

    if (
      !(await isGithubOauthStateSignatureValid({
        state,
        secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
      }))
    ) {
      return worksErrorRedirect(
        "Invalid state signature. Please try connecting again from the Platform.",
      );
    }

    const authClient = githubUserOauthClient();
    if (!authClient) {
      return worksErrorRedirect("GitHub OAuth is not configured");
    }

    const origin = getOAuthWebOrigin(request);
    const redirectUri = githubUserConnectCallbackRedirectUri(origin);
    const token = await exchangeConnectorAuthCode({
      type: "github",
      authClient,
      code: query.code,
      redirectUri,
      state: query.state,
      codeVerifier: undefined,
      oauthContext: undefined,
    });
    signal.throwIfAborted();

    const db = set(writeDb$);
    const installation = await loadActiveGithubInstallationForOrg({
      db,
      orgId: state.orgId,
      signal,
    });
    if (!installation) {
      return worksErrorRedirect("No GitHub installation found");
    }

    await set(
      upsertConnectorTokenConnection$,
      {
        orgId: state.orgId,
        userId: state.vm0UserId,
        type: GITHUB_CONNECTOR_TYPE,
        authMethod: GITHUB_CONNECTOR_AUTH_METHOD,
        accessToken: token.accessToken,
        userInfo: token.userInfo,
        oauthScopes: getConnectorAuthMethodGrantScopes(
          GITHUB_CONNECTOR_TYPE,
          GITHUB_CONNECTOR_AUTH_METHOD,
        ),
        extraConnectorSecrets: token.extraConnectorSecrets,
      },
      signal,
    );
    signal.throwIfAborted();

    const githubUserId = await linkGithubVm0User({
      db,
      installRecordId: installation.id,
      vm0UserId: state.vm0UserId,
      knownGithubUserId: token.userInfo.id,
      signal,
    });
    signal.throwIfAborted();

    if (!githubUserId) {
      return worksErrorRedirect(
        "This GitHub account is already linked to the installation",
      );
    }

    await publishUserSignal([state.vm0UserId], "github:changed");
    signal.throwIfAborted();

    return redirectResponse(appUrl("/works?github=connected"));
  },
);

const callbackGithubOauth$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$).raw;
    const canonicalRedirectUrl = getOAuthCanonicalRedirectUrl(request);
    if (canonicalRedirectUrl) {
      return noStoreRedirect(canonicalRedirectUrl);
    }

    const appId = optionalEnv("GITHUB_APP_ID");
    const privateKey = optionalEnv("GITHUB_APP_PRIVATE_KEY");

    if (!appId || !privateKey) {
      return worksErrorRedirect("GitHub App integration is not configured");
    }

    const query = get(queryOf(githubOauthContract.setupCallback));
    if (query.error) {
      return worksErrorRedirect(
        query.error_description || query.error || "GitHub authorization failed",
      );
    }
    if (query.setup_action === "update") {
      return redirectResponse(appUrl("/works?github=installed"));
    }

    const stateResolution = await resolveGithubCallbackState({
      stateString: query.state,
      secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
    });
    signal.throwIfAborted();
    if (!stateResolution.ok) {
      return stateResolution.response;
    }
    const { state, composeId } = stateResolution;

    const db = set(writeDb$);
    const orgId = await resolveGithubOauthOrgId({
      db,
      orgId: state.orgId,
      composeId,
      signal,
    });
    signal.throwIfAborted();

    const access = await set(
      resolveGithubCallbackAccess$,
      { state, orgId },
      signal,
    );
    if (!access.ok) {
      return access.response;
    }

    if (query.setup_action === "request") {
      return worksErrorRedirect(GITHUB_INSTALL_GITHUB_ADMIN_REQUIRED);
    }

    const installationId = query.installation_id;
    if (!installationId) {
      return worksErrorRedirect("Missing installation ID from GitHub");
    }

    const existing = await findGithubInstallationByInstallationId({
      db,
      installationId,
      orgId,
      signal,
    });
    if (existing) {
      const connection = await set(
        connectGithubUserAfterSetup$,
        {
          db,
          orgId,
          installRecordId: existing.id,
          ghInstallationId: installationId,
          state,
          code: query.code,
          knownGithubUserId: null,
        },
        signal,
      );
      if (!connection.ok) {
        return connection.response;
      }

      return githubSetupCompleteRedirect(connection.connected);
    }

    if (access.orgAlreadyHasActiveInstallation) {
      return worksErrorRedirect(GITHUB_SINGLE_INSTALLATION_REQUIRED);
    }

    const installation = await createActiveGithubInstallationFromCallback({
      db,
      appId,
      privateKey,
      orgId,
      composeId,
      installationId,
      state,
      signal,
    });
    signal.throwIfAborted();

    const connection = await set(
      connectGithubUserAfterSetup$,
      {
        db,
        orgId,
        installRecordId: installation.installRecordId,
        ghInstallationId: installationId,
        state,
        code: query.code,
        knownGithubUserId: installation.adminGithubUserId,
      },
      signal,
    );
    if (!connection.ok) {
      return connection.response;
    }

    return githubSetupCompleteRedirect(connection.connected);
  },
);

export const githubOauthRoutes: readonly RouteEntry[] = [
  {
    route: githubOauthContract.install,
    handler: installGithubOauth$,
  },
  {
    route: githubOauthContract.connect,
    handler: connectGithubUserOauth$,
  },
  {
    route: githubOauthContract.connectCallback,
    handler: callbackGithubUserOauth$,
  },
  {
    route: githubOauthContract.setupCallback,
    handler: callbackGithubOauth$,
  },
];
