import { command } from "ccstate";
import {
  githubOauthContract,
  type GithubOauthConnectQuery,
} from "@okouai/api-contracts/contracts/github-oauth";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { appUrlForPublicBrand } from "@okouai/core/public-brand";
import { connectorGrantScopes } from "@okouai/connectors/connector-auth-method";
import {
  exchangeGitHubCode,
  fetchGitHubUserInfo,
} from "@okouai/connectors/auth-providers/connectors/github/oauth";

import { requiredAuthContext$ } from "../auth/auth-context";
import { queryOf } from "../context/request";
import { publicBrand$, request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { getMemberRoleAndUpdateCache$ } from "../services/auth.service";
import {
  connectorActionResolver,
  type ConnectorActionResolver,
  type ResolvedConnectorActionMethod,
} from "../services/connector-action-resolver.service";
import { isConnectorCatalogUnavailableError } from "../services/connector-catalog-reader.service";
import {
  buildGithubAppInstallUrl,
  buildGithubUserConnectAuthorizationUrl,
  createOrActivateGithubInstallation,
  findGithubInstallationByInstallationId,
  getGithubInstallationAccessToken,
  getGithubInstallationInfo,
  getGithubOAuthAuthMethod,
  isGithubOauthStateSignatureValid,
  linkGithubUser,
  loadActiveGithubInstallationForOrg,
  loadComposeFeatureSwitchContext,
  parseGithubOauthState,
  resolveGithubOauthOrgId,
  tryLinkGithubFromLocalRecord,
  tryLinkGithubFromRemoteInstallations,
  verifyGithubConnectSignature,
} from "../services/github-oauth.service";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import { upsertConnectorTokenConnection$ } from "../services/connector-data.service";
import { settle } from "../utils";
import type { RouteEntry } from "../route-entry";
import {
  getOAuthCanonicalRedirectUrl,
  getOAuthWebOrigin,
} from "../../lib/oauth-origin";

const REDIRECT_STATUS = 307;
const GITHUB_CONNECTOR_SLUG = "github";
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

function appUrl(path: string, publicBrand: PublicBrand): string {
  return `${appUrlForPublicBrand(env("APP_URL"), publicBrand)}${path}`;
}

async function resolveGithubOauthMethod(
  resolver: ConnectorActionResolver,
): Promise<ResolvedConnectorActionMethod | null> {
  const resolved = await resolver.resolveMethod({
    connectorSlug: GITHUB_CONNECTOR_SLUG,
    authMethodId: getGithubOAuthAuthMethod(),
    expectedGrantKind: "auth-code",
  });
  return resolved.ok ? resolved : null;
}

async function resolveGithubOauthMethodForNewAction(
  resolver: ConnectorActionResolver,
): Promise<ResolvedConnectorActionMethod | null> {
  const resolved = await resolver.resolveNewActionMethod({
    connectorSlug: GITHUB_CONNECTOR_SLUG,
    authMethodId: getGithubOAuthAuthMethod(),
    expectedGrantKind: "auth-code",
  });
  return resolved.ok ? resolved : null;
}

async function githubAppInstallRequestedScopes(
  resolver: Promise<ConnectorActionResolver>,
  signal: AbortSignal,
): Promise<readonly string[] | undefined> {
  const result = await settle(
    (async () => {
      return await resolveGithubOauthMethodForNewAction(await resolver);
    })(),
    signal,
  );
  if (!result.ok) {
    if (isConnectorCatalogUnavailableError(result.error)) {
      return undefined;
    }
    throw result.error;
  }
  return result.value
    ? connectorGrantScopes(result.value.method.grant)
    : undefined;
}

const writeGithubConnectorConnection$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly method: ResolvedConnectorActionMethod;
      readonly outputs: Readonly<Record<string, string | null | undefined>>;
      readonly userInfo: {
        readonly id: string;
        readonly username: string | null;
        readonly email: string | null;
      };
      readonly oauthRequestedScopes: readonly string[];
      readonly oauthGrantedScopes: readonly string[];
      readonly extraConnectorSecrets?: Readonly<Record<string, string>>;
      readonly account: { readonly intent: "add" };
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const result = await set(
      upsertConnectorTokenConnection$,
      {
        orgId: args.orgId,
        userId: args.userId,
        runtimeMethod: args.method.runtimeMethod,
        snapshot: args.method.snapshot,
        outputs: args.outputs,
        userInfo: args.userInfo,
        oauthRequestedScopes: args.oauthRequestedScopes,
        oauthGrantedScopes: args.oauthGrantedScopes,
        extraConnectorSecrets: args.extraConnectorSecrets,
        account: args.account,
        matchExistingExternalIdentity: true,
      },
      signal,
    );
    signal.throwIfAborted();
    return result.status === "connected";
  },
);

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

function worksErrorRedirect(
  message: string,
  publicBrand: PublicBrand,
): Response {
  return redirectResponse(
    appUrl(`/works?error=${encodeURIComponent(message)}`, publicBrand),
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
      readonly publicBrand: PublicBrand;
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

function githubSetupUserConnectionError(
  message: string,
  publicBrand: PublicBrand,
): GithubSetupUserConnectionResolution {
  return { ok: false, response: worksErrorRedirect(message, publicBrand) };
}

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
  userId: string,
): {
  readonly orgId: string;
  readonly userId: string;
  readonly ghInstallationId: string | null;
  readonly installRecordId: string;
} {
  return {
    orgId: args.orgId,
    userId,
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
    const installation = await loadActiveGithubInstallationForOrg(
      {
        db,
        orgId,
      },
      signal,
    );
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
      publicBrand: "vm0",
      response: worksErrorRedirect(
        "Invalid OAuth state. Please try installing again from the Platform.",
        "vm0",
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
      publicBrand: "vm0",
      response: worksErrorRedirect(
        "Invalid state signature. Please try installing again from the Platform.",
        "vm0",
      ),
    };
  }

  if (!state.composeId) {
    return {
      ok: false,
      publicBrand: state.publicBrand,
      response: worksErrorRedirect(
        "Missing default agent. Please select an agent before connecting GitHub.",
        state.publicBrand,
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
      args.state.userId &&
      !(await set(
        isGithubInstallOrgAdmin$,
        { orgId: args.state.orgId, userId: args.state.userId },
        signal,
      ))
    ) {
      return {
        ok: false,
        response: worksErrorRedirect(
          GITHUB_INSTALL_ADMIN_REQUIRED,
          args.state.publicBrand,
        ),
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

async function linkGithubUserWithoutSetupCode(
  args: GithubSetupUserConnectionArgs,
  userId: string,
  signal: AbortSignal,
): Promise<GithubSetupUserConnectionResolution> {
  const githubUserId = await linkGithubUser(
    {
      db: args.db,
      installRecordId: args.installRecordId,
      userId,
      knownGithubUserId: args.knownGithubUserId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (githubUserId) {
    await publishUserSignal([userId], "github:changed");
    signal.throwIfAborted();
  }
  return { ok: true, connected: githubUserId !== null };
}

const connectGithubUserAfterSetup$ = command(
  async (
    { get, set },
    args: GithubSetupUserConnectionArgs,
    signal: AbortSignal,
  ): Promise<GithubSetupUserConnectionResolution> => {
    const userId = args.state.userId;
    if (!userId) {
      return { ok: true, connected: false };
    }

    const code = args.code;
    if (code) {
      const codeExchangeLogContext = githubSetupCodeExchangeLogContext(
        args,
        userId,
      );
      const credentials = githubAppUserOauthCredentials();
      if (!credentials) {
        L.warn(
          "GitHub setup code exchange skipped: App OAuth is not configured",
          {
            ...codeExchangeLogContext,
          },
        );
        return githubSetupUserConnectionError(
          "GitHub App OAuth is not configured",
          args.state.publicBrand,
        );
      }

      L.warn("Starting GitHub setup code exchange", {
        ...codeExchangeLogContext,
        client: "github_app",
        sendsRedirectUri: false,
      });

      const resolver = await get(connectorActionResolver());
      signal.throwIfAborted();
      const resolvedMethod = await resolveGithubOauthMethod(resolver);
      signal.throwIfAborted();
      if (!resolvedMethod || resolvedMethod.method.grant.kind !== "auth-code") {
        return githubSetupUserConnectionError(
          "GitHub OAuth is not available",
          args.state.publicBrand,
        );
      }
      const oauthRequestedScopes =
        args.state.oauthRequestedScopes ??
        connectorGrantScopes(resolvedMethod.method.grant);
      const authCodeGrant = {
        ...resolvedMethod.method.grant,
        scopes: [...oauthRequestedScopes],
      };
      const tokenResult = await settle(
        (async () => {
          const { accessToken, scopes } = await exchangeGitHubCode(
            authCodeGrant,
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
        return githubSetupUserConnectionError(
          errorMessageFromUnknown(tokenResult.error),
          args.state.publicBrand,
        );
      }
      const { accessToken, scopes, userInfo } = tokenResult.value;
      L.warn("GitHub setup code exchange succeeded", {
        ...codeExchangeLogContext,
        githubUserId: userInfo.id,
        githubUsername: userInfo.username,
        scopes,
      });

      const connectorConnected = await set(
        writeGithubConnectorConnection$,
        {
          orgId: args.orgId,
          userId,
          method: resolvedMethod,
          outputs: { accessToken },
          userInfo,
          oauthRequestedScopes,
          oauthGrantedScopes: scopes,
          account: { intent: "add" },
        },
        signal,
      );
      if (!connectorConnected) {
        return githubSetupUserConnectionError(
          "Connector account could not be selected",
          args.state.publicBrand,
        );
      }

      const githubUserId = await linkGithubUser(
        {
          db: args.db,
          installRecordId: args.installRecordId,
          userId,
          knownGithubUserId: userInfo.id,
        },
        signal,
      );
      signal.throwIfAborted();

      if (!githubUserId) {
        return githubSetupUserConnectionError(
          "This GitHub account is already linked to the installation",
          args.state.publicBrand,
        );
      }

      await publishUserSignal([userId], "github:changed");
      signal.throwIfAborted();

      return { ok: true, connected: true };
    }

    return await linkGithubUserWithoutSetupCode(args, userId, signal);
  },
);

function githubSetupCompleteRedirect(
  connected: boolean,
  publicBrand: PublicBrand,
): Response {
  if (connected) {
    return redirectResponse(appUrl("/workflows", publicBrand));
  }
  return redirectResponse(appUrl("/workflows", publicBrand));
}

const connectExistingGithubInstallation$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly orgId: string;
      readonly installationId: string;
      readonly state: ParsedGithubOauthState;
      readonly code: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<Response | null> => {
    const existing = await findGithubInstallationByInstallationId(
      {
        db: args.db,
        installationId: args.installationId,
        orgId: args.orgId,
      },
      signal,
    );
    if (!existing) {
      return null;
    }
    const connection = await set(
      connectGithubUserAfterSetup$,
      {
        db: args.db,
        orgId: args.orgId,
        installRecordId: existing.id,
        ghInstallationId: args.installationId,
        state: args.state,
        code: args.code,
        knownGithubUserId: null,
      },
      signal,
    );
    return connection.ok
      ? githubSetupCompleteRedirect(
          connection.connected,
          args.state.publicBrand,
        )
      : connection.response;
  },
);

async function createActiveGithubInstallationFromCallback(
  args: {
    readonly db: Db;
    readonly appId: string;
    readonly privateKey: string;
    readonly orgId: string;
    readonly composeId: string;
    readonly installationId: string;
    readonly state: ParsedGithubOauthState;
  },
  signal: AbortSignal,
): Promise<{
  readonly installRecordId: string;
  readonly adminGithubUserId: string | null;
}> {
  const installInfo = await getGithubInstallationInfo(
    {
      appId: args.appId,
      privateKey: args.privateKey,
      installationId: args.installationId,
    },
    signal,
  );
  signal.throwIfAborted();

  const { token } = await getGithubInstallationAccessToken(
    {
      appId: args.appId,
      privateKey: args.privateKey,
      installationId: args.installationId,
    },
    signal,
  );
  signal.throwIfAborted();

  const adminGithubUserId =
    installInfo.targetType === "User" ? installInfo.targetId : null;
  const featureSwitchContext = await loadComposeFeatureSwitchContext(
    {
      db: args.db,
      composeId: args.composeId,
      userId: args.state.userId,
    },
    signal,
  );
  const installRecordId = await createOrActivateGithubInstallation(
    {
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
    },
    signal,
  );

  return { installRecordId, adminGithubUserId };
}

const installGithubOauth$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$).raw;
    const publicBrand = get(publicBrand$);
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
    const userId = query.userId;
    const appId = optionalEnv("GITHUB_APP_ID");
    const privateKey = optionalEnv("GITHUB_APP_PRIVATE_KEY");

    if (
      query.orgId &&
      userId &&
      !(await set(
        isGithubInstallOrgAdmin$,
        { orgId: query.orgId, userId },
        signal,
      ))
    ) {
      return worksErrorRedirect(GITHUB_INSTALL_ADMIN_REQUIRED, publicBrand);
    }

    if (appId && privateKey && userId) {
      const db = set(writeDb$);
      const linkedFromLocal = query.orgId
        ? await tryLinkGithubFromLocalRecord(
            {
              db,
              orgId: query.orgId,
              userId,
            },
            signal,
          )
        : false;
      signal.throwIfAborted();

      if (linkedFromLocal) {
        return redirectResponse(appUrl("/workflows", publicBrand));
      }

      const linkedFromRemote = await tryLinkGithubFromRemoteInstallations(
        {
          db,
          appId,
          appSlug,
          privateKey,
          orgId: query.orgId ?? null,
          userId,
          composeId: query.composeId ?? null,
        },
        signal,
      );
      signal.throwIfAborted();

      if (linkedFromRemote) {
        return redirectResponse(appUrl("/workflows", publicBrand));
      }
    }

    const oauthRequestedScopes =
      userId && githubAppUserOauthCredentials()
        ? await githubAppInstallRequestedScopes(
            get(connectorActionResolver()),
            signal,
          )
        : undefined;
    signal.throwIfAborted();
    const installUrl = await buildGithubAppInstallUrl({
      appSlug,
      userId,
      orgId: query.orgId,
      composeId: query.composeId,
      origin,
      publicBrand,
      oauthRequestedScopes,
      secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
    });
    signal.throwIfAborted();

    return noStoreRedirect(installUrl);
  },
);

function invalidGithubConnectLinkRedirect(publicBrand: PublicBrand): Response {
  return worksErrorRedirect(
    "Invalid or expired GitHub connect link. Ask the bot for a new link.",
    publicBrand,
  );
}

function signInRedirect(
  requestUrl: string,
  publicBrand: PublicBrand,
): Response {
  const signInUrl = new URL(
    "/sign-in",
    appUrlForPublicBrand(env("APP_URL"), publicBrand),
  );
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
    const publicBrand = query.publicBrand ?? get(publicBrand$);
    const auth = await set(
      requiredAuthContext$,
      { requireOrganization: true },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in auth) {
      return auth.status === 401
        ? signInRedirect(request.url, publicBrand)
        : worksErrorRedirect(auth.body.error.message, publicBrand);
    }
    if (!auth.orgId) {
      return worksErrorRedirect("Explicit org context required", publicBrand);
    }
    const orgId = auth.orgId;

    if (hasGithubConnectSignatureQuery(query)) {
      if (!query.installation || !query.ghUser || !query.ts || !query.sig) {
        return invalidGithubConnectLinkRedirect(publicBrand);
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
        return invalidGithubConnectLinkRedirect(publicBrand);
      }

      const db = set(writeDb$);
      const installation = await findGithubInstallationByInstallationId(
        {
          db,
          installationId: query.installation,
          orgId,
        },
        signal,
      );
      signal.throwIfAborted();

      if (!installation) {
        return worksErrorRedirect(
          "No GitHub installation found for this workspace",
          publicBrand,
        );
      }

      const githubUserId = await linkGithubUser(
        {
          db,
          installRecordId: installation.id,
          userId: auth.userId,
          knownGithubUserId: query.ghUser,
        },
        signal,
      );
      signal.throwIfAborted();

      if (!githubUserId) {
        return worksErrorRedirect(
          "This GitHub account is already linked to the installation",
          publicBrand,
        );
      }

      await publishUserSignal([auth.userId], "github:changed");
      signal.throwIfAborted();

      return redirectResponse(appUrl("/workflows", publicBrand));
    }

    const origin = getOAuthWebOrigin(request);
    const db = set(writeDb$);
    const resolver = await get(connectorActionResolver());
    signal.throwIfAborted();
    const resolvedMethod = await resolveGithubOauthMethodForNewAction(resolver);
    signal.throwIfAborted();
    if (!resolvedMethod) {
      return worksErrorRedirect("GitHub OAuth is not available", publicBrand);
    }
    const authorizationUrl = await buildGithubUserConnectAuthorizationUrl(
      {
        db,
        userId: auth.userId,
        orgId,
        origin,
        publicBrand,
        authMethodId: resolvedMethod.authMethodId,
        method: resolvedMethod.method,
        readEnv: optionalEnv,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!authorizationUrl) {
      return worksErrorRedirect("GitHub OAuth is not configured", publicBrand);
    }

    return noStoreRedirect(authorizationUrl);
  },
);

const callbackGithubOauth$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$).raw;
    const canonicalRedirectUrl = getOAuthCanonicalRedirectUrl(request);
    if (canonicalRedirectUrl) {
      return noStoreRedirect(canonicalRedirectUrl);
    }

    const query = get(queryOf(githubOauthContract.setupCallback));
    const secretsEncryptionKey = env("SECRETS_ENCRYPTION_KEY");
    const stateResolution = await resolveGithubCallbackState({
      stateString: query.state,
      secretsEncryptionKey,
    });
    signal.throwIfAborted();
    const callbackPublicBrand = stateResolution.ok
      ? stateResolution.state.publicBrand
      : stateResolution.publicBrand;
    const appId = optionalEnv("GITHUB_APP_ID");
    const privateKey = optionalEnv("GITHUB_APP_PRIVATE_KEY");

    if (!appId || !privateKey) {
      return worksErrorRedirect(
        "GitHub App integration is not configured",
        callbackPublicBrand,
      );
    }

    if (query.error) {
      return worksErrorRedirect(
        query.error_description || query.error || "GitHub authorization failed",
        callbackPublicBrand,
      );
    }
    if (query.setup_action === "update") {
      return redirectResponse(appUrl("/workflows", callbackPublicBrand));
    }

    signal.throwIfAborted();
    if (!stateResolution.ok) {
      return stateResolution.response;
    }
    const { state, composeId } = stateResolution;

    const db = set(writeDb$);
    const orgId = await resolveGithubOauthOrgId(
      {
        db,
        orgId: state.orgId,
        composeId,
      },
      signal,
    );
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
      return worksErrorRedirect(
        GITHUB_INSTALL_GITHUB_ADMIN_REQUIRED,
        state.publicBrand,
      );
    }

    const installationId = query.installation_id;
    if (!installationId) {
      return worksErrorRedirect(
        "Missing installation ID from GitHub",
        state.publicBrand,
      );
    }

    const existingResponse = await set(
      connectExistingGithubInstallation$,
      {
        db,
        installationId,
        orgId,
        state,
        code: query.code,
      },
      signal,
    );
    if (existingResponse) {
      return existingResponse;
    }

    if (access.orgAlreadyHasActiveInstallation) {
      return worksErrorRedirect(
        GITHUB_SINGLE_INSTALLATION_REQUIRED,
        state.publicBrand,
      );
    }

    const installation = await createActiveGithubInstallationFromCallback(
      {
        db,
        appId,
        privateKey,
        orgId,
        composeId,
        installationId,
        state,
      },
      signal,
    );
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

    return githubSetupCompleteRedirect(connection.connected, state.publicBrand);
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
    route: githubOauthContract.setupCallback,
    handler: callbackGithubOauth$,
  },
];
