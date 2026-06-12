import { Buffer } from "node:buffer";
import {
  createHmac,
  generateKeyPairSync,
  randomInt,
  randomUUID,
} from "node:crypto";

import {
  composesByIdContract,
  composesMainContract,
  agentComposeApiContentSchema,
  type ZeroCapability,
} from "@vm0/api-contracts/contracts/composes";
import {
  integrationsGithubContract,
  type CreateGithubLabelListenerBody,
  type GithubConnectUserBody,
  type GithubInstallationResponse,
  type UpdateGithubLabelListenerBody,
} from "@vm0/api-contracts/contracts/integrations-github";
import { orgDefaultAgentContract } from "@vm0/api-contracts/contracts/orgs";
import { zeroConnectorsByTypeContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import {
  zeroSecretsContract,
  zeroVariablesContract,
} from "@vm0/api-contracts/contracts/zero-secrets";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse, http } from "msw";
import { z } from "zod";

import { createApp } from "../../../../app-factory";
import { env, mockOptionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../../auth/tokens";
import { signGithubConnectParams } from "../../../services/github-oauth.service";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

export const GITHUB_APP_SLUG = "vm0-test";
export const GITHUB_APP_CLIENT_ID = "github-app-client-id";
export const GITHUB_APP_CLIENT_SECRET = "github-app-client-secret";
export const GH_OAUTH_CLIENT_ID = "github-oauth-client-id";
export const GH_OAUTH_CLIENT_SECRET = "github-oauth-client-secret";

const GITHUB_APP_ID = "123456";
const DEFAULT_TEST_ORIGIN = "http://localhost:3000";
const GITHUB_ISSUES_CALLBACK_PATH = "/api/internal/callbacks/github/issues";
const GITHUB_ISSUES_CALLBACK_URL = `${DEFAULT_TEST_ORIGIN}${GITHUB_ISSUES_CALLBACK_PATH}`;
const CHAT_CALLBACK_URL = `${DEFAULT_TEST_ORIGIN}/api/internal/callbacks/chat`;

type ComposeContent = z.infer<typeof agentComposeApiContentSchema>;

interface GithubBearerAuth {
  readonly bearer: string;
}

type GithubActorAuth = ApiTestUser | GithubBearerAuth | null;

export interface RawRouteResponse {
  readonly status: number;
  readonly location: string | null;
  readonly cacheControl: string | null;
  readonly body: unknown;
}

interface RecordedTokenExchange {
  clientId: string | null;
  clientSecret: string | null;
  code: string | null;
  redirectUri: string | null;
  hasRedirectUri: boolean;
  calls: number;
}

interface RecordedRemoteUninstall {
  installationId: string | null;
  authorization: string | null;
}

interface CapturedIssueComment {
  readonly repo: string;
  readonly issueNumber: string;
  readonly id: string;
  readonly body: string;
}

interface CapturedReactionDelete {
  readonly commentId: string;
  readonly reactionId: string;
}

interface GithubIssueApiCapture {
  readonly comments: CapturedIssueComment[];
  readonly reactionDeletes: CapturedReactionDelete[];
  lastCommentId(): string;
}

interface GithubIssueHistoryComment {
  readonly id: number;
  readonly login: string;
  readonly body: string;
}

interface RecordedCallbackDelivery {
  readonly body: string;
  readonly signature: string | null;
  readonly timestamp: string | null;
}

interface SignedConnectLink {
  readonly installationId: string;
  readonly githubUserId: string;
  readonly githubUsername: string;
  readonly timestamp: number;
  readonly signature: string;
}

interface ClerkUserProfile {
  readonly id: string;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
  readonly primaryEmailAddressId: string;
  readonly firstName: string;
  readonly lastName: string;
}

const issueCommentRequestSchema = z.object({ body: z.string() });

function clerkUserProfile(actor: ApiTestUser): ClerkUserProfile {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "GitHub",
  };
}

function isBearerAuth(auth: GithubActorAuth): auth is GithubBearerAuth {
  return auth !== null && "bearer" in auth;
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

/**
 * Object-storage fake for GitHub run chains: checkpointed session-history
 * blobs download with deterministic content (so issue-session resume works
 * end to end) and every other storage command acks like the plain
 * storage-write mock.
 */
export function acceptGithubRunObjectStorage(context: TestContext): void {
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = commandInput(command);
    const key = typeof input.Key === "string" ? input.Key : "";
    if (key.startsWith("blobs/") && key.endsWith(".blob")) {
      return Promise.resolve({
        Body: {
          async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
            yield Buffer.from(`bdd github session history ${key}`, "utf8");
          },
        },
      });
    }
    return Promise.resolve({});
  });
}

function newPrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return Buffer.from(pem).toString("base64");
}

export function newRemoteInstallationId(): string {
  return String(randomInt(1_000_000_000, 9_999_999_999));
}

export function newGithubUserId(): string {
  return String(randomInt(1_000_000_000, 9_999_999_999));
}

export function mockGithubAppEnv(
  args: {
    readonly slug?: boolean;
    readonly credentials?: boolean;
    readonly oauthCredentials?: boolean;
  } = {},
): void {
  mockOptionalEnv(
    "GITHUB_APP_SLUG",
    args.slug === false ? undefined : GITHUB_APP_SLUG,
  );
  if (args.credentials === false) {
    mockOptionalEnv("GITHUB_APP_ID", undefined);
    mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", undefined);
  } else {
    mockOptionalEnv("GITHUB_APP_ID", GITHUB_APP_ID);
    mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", newPrivateKeyBase64());
  }
  if (args.oauthCredentials === false) {
    mockOptionalEnv("GITHUB_APP_CLIENT_ID", undefined);
    mockOptionalEnv("GITHUB_APP_CLIENT_SECRET", undefined);
  } else {
    mockOptionalEnv("GITHUB_APP_CLIENT_ID", GITHUB_APP_CLIENT_ID);
    mockOptionalEnv("GITHUB_APP_CLIENT_SECRET", GITHUB_APP_CLIENT_SECRET);
  }
}

export function mockGithubUserOauthEnv(): void {
  mockOptionalEnv("GH_OAUTH_CLIENT_ID", GH_OAUTH_CLIENT_ID);
  mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", GH_OAUTH_CLIENT_SECRET);
}

/**
 * Membership reads for routes that resolve org roles outside the Clerk
 * session (the unauthenticated install/setup-callback admin check and
 * zero-token auth both fall back to `membershipsByUserId`). The role for a
 * given (user, org) pair is cached for 60 seconds after the first read, so
 * tests must use a distinct user per role scenario.
 */
export function mockClerkMembership(
  context: TestContext,
  actor: ApiTestUser,
  role: "org:admin" | "org:member",
): void {
  if (!actor.orgId) {
    throw new Error("Cannot mock memberships for a no-org actor");
  }
  const memberships = {
    data: [
      {
        role,
        organization: { id: actor.orgId },
        publicUserData: { userId: actor.userId },
      },
    ],
  };
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
    memberships,
  );
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    memberships,
  );
}

export function mockGithubInstallationsList(
  installations: readonly {
    readonly id: string;
    readonly targetId: string;
    readonly login?: string;
    readonly type?: string;
  }[],
): void {
  server.use(
    http.get("https://api.github.com/app/installations", () => {
      return HttpResponse.json(
        installations.map((installation) => {
          return {
            id: Number(installation.id),
            account: {
              id: Number(installation.targetId),
              login: installation.login ?? "bdd-org",
              type: installation.type ?? "Organization",
            },
          };
        }),
      );
    }),
  );
}

export function mockGithubInstallationApi(args: {
  readonly installationId: string;
  readonly targetId: string;
  readonly login?: string;
  readonly type?: string;
  readonly token?: string;
}): void {
  server.use(
    http.get(
      `https://api.github.com/app/installations/${args.installationId}`,
      () => {
        return HttpResponse.json({
          id: Number(args.installationId),
          account: {
            id: Number(args.targetId),
            login: args.login ?? "bdd-org",
            type: args.type ?? "Organization",
          },
        });
      },
    ),
    http.post(
      `https://api.github.com/app/installations/${args.installationId}/access_tokens`,
      () => {
        return HttpResponse.json({
          token: args.token ?? "ghs_bdd_installation_token",
          expires_at: "2099-01-01T00:00:00Z",
        });
      },
    ),
  );
}

export function mockGithubInstallationInfoFailure(status: number): void {
  server.use(
    http.get("https://api.github.com/app/installations/:installationId", () => {
      return HttpResponse.json({ message: "Bad credentials" }, { status });
    }),
  );
}

export function mockGithubUserOAuthExchange(args: {
  readonly code: string;
  readonly githubUserId: string;
  readonly accessToken?: string;
  readonly login?: string;
}): RecordedTokenExchange {
  const recorded: RecordedTokenExchange = {
    clientId: null,
    clientSecret: null,
    code: null,
    redirectUri: null,
    hasRedirectUri: false,
    calls: 0,
  };
  const accessToken = args.accessToken ?? `gho_bdd_${args.code}`;

  server.use(
    http.post("https://github.com/login/oauth/access_token", async (info) => {
      const body = new URLSearchParams(await info.request.text());
      recorded.calls += 1;
      recorded.clientId = body.get("client_id");
      recorded.clientSecret = body.get("client_secret");
      recorded.code = body.get("code");
      recorded.redirectUri = body.get("redirect_uri");
      recorded.hasRedirectUri = body.has("redirect_uri");
      if (body.get("code") !== args.code) {
        return HttpResponse.json(
          { error: "bad_verification_code" },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        access_token: accessToken,
        scope: "repo,project,workflow",
      });
    }),
    http.get("https://api.github.com/user", ({ request }) => {
      if (request.headers.get("authorization") !== `Bearer ${accessToken}`) {
        return HttpResponse.json(
          { message: "Bad credentials" },
          { status: 401 },
        );
      }
      return HttpResponse.json({
        id: Number(args.githubUserId),
        login: args.login ?? "octocat",
        email: null,
      });
    }),
  );

  return recorded;
}

export function mockGithubRemoteUninstall(): RecordedRemoteUninstall {
  const recorded: RecordedRemoteUninstall = {
    installationId: null,
    authorization: null,
  };
  server.use(
    http.delete(
      "https://api.github.com/app/installations/:installationId",
      ({ params, request }) => {
        recorded.installationId = String(params.installationId);
        recorded.authorization = request.headers.get("authorization");
        return HttpResponse.text("boom", { status: 500 });
      },
    ),
  );
  return recorded;
}

/**
 * GitHub issue API surface used by webhook-created runs: installation access
 * tokens, comment history, posted comments (with incrementing ids), and
 * reaction add/remove. All issue comments observed by the test flow through
 * the returned capture arrays.
 */
export function captureGithubIssueApi(
  remoteInstallationId: string,
  options: {
    readonly commentHistory?: readonly GithubIssueHistoryComment[];
  } = {},
): GithubIssueApiCapture {
  const comments: CapturedIssueComment[] = [];
  const reactionDeletes: CapturedReactionDelete[] = [];
  let nextCommentId = randomInt(10_000, 99_999);
  let nextReactionId = randomInt(1000, 9999);

  server.use(
    http.post(
      `https://api.github.com/app/installations/${remoteInstallationId}/access_tokens`,
      () => {
        return HttpResponse.json({
          token: "ghs_bdd_issue_token",
          expires_at: "2099-01-01T00:00:00Z",
        });
      },
    ),
    http.get(
      "https://api.github.com/repos/:owner/:repo/issues/:issueNumber/comments",
      () => {
        return HttpResponse.json(
          (options.commentHistory ?? []).map((comment) => {
            return {
              id: comment.id,
              user: { login: comment.login, type: "User" },
              body: comment.body,
              created_at: "2026-05-20T00:00:00Z",
            };
          }),
        );
      },
    ),
    http.post(
      "https://api.github.com/repos/:owner/:repo/issues/:issueNumber/comments",
      async ({ params, request }) => {
        const payload = issueCommentRequestSchema.parse(await request.json());
        const id = nextCommentId;
        nextCommentId += 1;
        comments.push({
          repo: `${String(params.owner)}/${String(params.repo)}`,
          issueNumber: String(params.issueNumber),
          id: String(id),
          body: payload.body,
        });
        return HttpResponse.json({ id });
      },
    ),
    http.post(
      "https://api.github.com/repos/:owner/:repo/issues/comments/:commentId/reactions",
      () => {
        const id = nextReactionId;
        nextReactionId += 1;
        return HttpResponse.json({ id });
      },
    ),
    http.delete(
      "https://api.github.com/repos/:owner/:repo/issues/comments/:commentId/reactions/:reactionId",
      ({ params }) => {
        reactionDeletes.push({
          commentId: String(params.commentId),
          reactionId: String(params.reactionId),
        });
        return HttpResponse.json({});
      },
    ),
  );

  return {
    comments,
    reactionDeletes,
    lastCommentId(): string {
      const lastComment = comments[comments.length - 1];
      if (!lastComment) {
        throw new Error("No GitHub issue comment captured yet");
      }
      return lastComment.id;
    },
  };
}

/**
 * Forward internal GitHub-issues callback dispatches back into the app so
 * detached terminal transitions deliver their callbacks for real.
 */
export function proxyGithubIssuesCallbackToApp(context: TestContext): void {
  server.use(
    http.post(GITHUB_ISSUES_CALLBACK_URL, async ({ request }) => {
      const app = createApp({ signal: context.signal });
      return await app.request(GITHUB_ISSUES_CALLBACK_PATH, {
        method: "POST",
        headers: request.headers,
        body: await request.text(),
      });
    }),
  );
}

/**
 * Like {@link proxyGithubIssuesCallbackToApp} but also records every signed
 * delivery (raw body plus signature headers) so tests can replay it later
 * under mutated server state.
 */
export function captureGithubIssuesCallbackDeliveries(
  context: TestContext,
): RecordedCallbackDelivery[] {
  const deliveries: RecordedCallbackDelivery[] = [];
  server.use(
    http.post(GITHUB_ISSUES_CALLBACK_URL, async ({ request }) => {
      const body = await request.text();
      deliveries.push({
        body,
        signature: request.headers.get("x-vm0-signature"),
        timestamp: request.headers.get("x-vm0-timestamp"),
      });
      const app = createApp({ signal: context.signal });
      return await app.request(GITHUB_ISSUES_CALLBACK_PATH, {
        method: "POST",
        headers: request.headers,
        body,
      });
    }),
  );
  return deliveries;
}

/**
 * Record signed chat-callback deliveries without proxying them, so a chat
 * run's delivery can be replayed against the GitHub issues callback route
 * (per-callback signature verifies, payload schema does not).
 */
export function captureChatCallbackDeliveries(): RecordedCallbackDelivery[] {
  const deliveries: RecordedCallbackDelivery[] = [];
  server.use(
    http.post(CHAT_CALLBACK_URL, async ({ request }) => {
      deliveries.push({
        body: await request.text(),
        signature: request.headers.get("x-vm0-signature"),
        timestamp: request.headers.get("x-vm0-timestamp"),
      });
      return HttpResponse.json({ ok: true });
    }),
  );
  return deliveries;
}

export function buildLegacySignedState(args: {
  readonly userId: string;
  readonly composeId: string;
}): string {
  const sig = createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`${args.userId}:${args.composeId}`)
    .digest("hex");
  return JSON.stringify({
    vm0UserId: args.userId,
    composeId: args.composeId,
    sig,
  });
}

export function buildUserConnectState(args: {
  readonly userId: string;
  readonly orgId: string;
}): string {
  const sig = createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`${args.userId}:${args.orgId}:`)
    .digest("hex");
  return JSON.stringify({
    vm0UserId: args.userId,
    orgId: args.orgId,
    sig,
  });
}

export function signedConnectLink(args: {
  readonly installationId: string;
  readonly githubUserId: string;
  readonly githubUsername?: string;
  readonly ageSeconds?: number;
}): SignedConnectLink {
  const timestamp = Math.floor(now() / 1000) - (args.ageSeconds ?? 0);
  const githubUsername = args.githubUsername ?? "octocat";
  return {
    installationId: args.installationId,
    githubUserId: args.githubUserId,
    githubUsername,
    timestamp,
    signature: signGithubConnectParams({
      installationId: args.installationId,
      githubUserId: args.githubUserId,
      githubUsername,
      timestamp,
      secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
    }),
  };
}

export function connectLinkQuery(link: SignedConnectLink): string {
  return new URLSearchParams({
    installation: link.installationId,
    ghUser: link.githubUserId,
    ghLogin: link.githubUsername,
    ts: String(link.timestamp),
    sig: link.signature,
  }).toString();
}

export function zeroCapabilityToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly ZeroCapability[];
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: randomUUID(),
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 300,
  });
}

export function createGithubBddApi(context: TestContext) {
  const routeMocks = createZeroRouteMocks(context);

  function authenticate(auth: GithubActorAuth): {
    readonly authorization?: string;
  } {
    if (auth === null) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }
    if (isBearerAuth(auth)) {
      return { authorization: `Bearer ${auth.bearer}` };
    }
    routeMocks.clerk.session(auth.userId, auth.orgId, auth.orgRole);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [clerkUserProfile(auth)],
    });
    return { authorization: "Bearer clerk-session" };
  }

  function githubClient() {
    return setupApp({ context })(integrationsGithubContract);
  }

  async function rawRequest(
    path: string,
    init: {
      readonly method: string;
      readonly origin?: string;
      readonly headers?: Record<string, string>;
      readonly body?: string;
    },
  ): Promise<RawRouteResponse> {
    const app = createApp({ signal: context.signal });
    const response = await app.request(
      `${init.origin ?? DEFAULT_TEST_ORIGIN}${path}`,
      {
        method: init.method,
        headers: init.headers,
        body: init.body,
      },
    );
    const contentType = response.headers.get("content-type") ?? "";
    const body: unknown = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    return {
      status: response.status,
      location: response.headers.get("location"),
      cacheControl: response.headers.get("cache-control"),
      body,
    };
  }

  async function requestInstall(
    query: string,
    options: {
      readonly origin?: string;
      readonly webOriginHeader?: string;
    } = {},
  ): Promise<RawRouteResponse> {
    return await rawRequest(
      `/api/github/oauth/install${query ? `?${query}` : ""}`,
      {
        method: "GET",
        origin: options.origin,
        headers: options.webOriginHeader
          ? { "x-vm0-web-origin": options.webOriginHeader }
          : undefined,
      },
    );
  }

  async function requestConnect(
    actor: ApiTestUser | null,
    query: string,
    options: { readonly origin?: string } = {},
  ): Promise<RawRouteResponse> {
    const headers = authenticate(actor);
    return await rawRequest(
      `/api/zero/github/oauth/connect${query ? `?${query}` : ""}`,
      {
        method: "GET",
        origin: options.origin,
        headers: headers.authorization
          ? { authorization: headers.authorization }
          : undefined,
      },
    );
  }

  async function requestConnectCallback(
    query: string,
  ): Promise<RawRouteResponse> {
    return await rawRequest(
      `/api/zero/github/oauth/connect/callback${query ? `?${query}` : ""}`,
      { method: "GET" },
    );
  }

  async function requestSetupCallback(
    query: string,
    options: { readonly origin?: string } = {},
  ): Promise<RawRouteResponse> {
    return await rawRequest(
      `/api/github/app/setup/callback${query ? `?${query}` : ""}`,
      { method: "GET", origin: options.origin },
    );
  }

  return {
    requestInstall,
    requestConnect,
    requestConnectCallback,
    requestSetupCallback,

    async readInstallation(
      auth: GithubActorAuth,
    ): Promise<GithubInstallationResponse> {
      const response = await accept(
        githubClient().getInstallation({ headers: authenticate(auth) }),
        [200],
      );
      return response.body;
    },

    async requestReadInstallation<
      TStatus extends 200 | 400 | 401 | 403 | 404 | 500,
    >(
      auth: GithubActorAuth,
      statuses: readonly TStatus[],
      options: { readonly webOriginHeader?: string } = {},
    ) {
      return await accept(
        githubClient().getInstallation({
          headers: authenticate(auth),
          ...(options.webOriginHeader
            ? { extraHeaders: { "x-vm0-web-origin": options.webOriginHeader } }
            : {}),
        }),
        statuses,
      );
    },

    async connectUser<TStatus extends 200 | 400 | 401 | 404 | 409 | 500>(
      auth: GithubActorAuth,
      body: GithubConnectUserBody,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        githubClient().connectUser({ headers: authenticate(auth), body }),
        statuses,
      );
    },

    async disconnectUser<TStatus extends 200 | 401 | 404 | 500>(
      auth: GithubActorAuth,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        githubClient().disconnectUser({ headers: authenticate(auth) }),
        statuses,
      );
    },

    async deleteInstallation<TStatus extends 200 | 401 | 403 | 404 | 500>(
      auth: GithubActorAuth,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        githubClient().deleteInstallation({ headers: authenticate(auth) }),
        statuses,
      );
    },

    async updateInstallation<TStatus extends 200 | 400 | 401 | 403 | 404 | 500>(
      auth: GithubActorAuth,
      agentName: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        githubClient().updateInstallation({
          headers: authenticate(auth),
          body: { agentName },
        }),
        statuses,
      );
    },

    async rawUpdateInstallation(
      actor: ApiTestUser,
      rawBody: string,
    ): Promise<RawRouteResponse> {
      const headers = authenticate(actor);
      return await rawRequest("/api/integrations/github", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...(headers.authorization
            ? { authorization: headers.authorization }
            : {}),
        },
        body: rawBody,
      });
    },

    async createLabelListener<
      TStatus extends 201 | 400 | 401 | 403 | 404 | 409 | 500,
    >(
      auth: GithubActorAuth,
      body: CreateGithubLabelListenerBody,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        githubClient().createLabelListener({
          headers: authenticate(auth),
          body,
        }),
        statuses,
      );
    },

    async updateLabelListener<
      TStatus extends 200 | 400 | 401 | 403 | 404 | 409 | 500,
    >(
      auth: GithubActorAuth,
      listenerId: string,
      body: UpdateGithubLabelListenerBody,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        githubClient().updateLabelListener({
          headers: authenticate(auth),
          params: { listenerId },
          body,
        }),
        statuses,
      );
    },

    async deleteLabelListener<TStatus extends 200 | 401 | 403 | 404 | 500>(
      auth: GithubActorAuth,
      listenerId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        githubClient().deleteLabelListener({
          headers: authenticate(auth),
          params: { listenerId },
        }),
        statuses,
      );
    },

    async readGithubConnector(actor: ApiTestUser) {
      const client = setupApp({ context })(zeroConnectorsByTypeContract);
      const response = await accept(
        client.get({
          headers: authenticate(actor),
          params: { type: "github" },
        }),
        [200],
      );
      return response.body;
    },

    async enableAuditLink(actor: ApiTestUser): Promise<void> {
      const client = setupApp({ context })(zeroFeatureSwitchesContract);
      await accept(
        client.update({
          headers: authenticate(actor),
          body: { switches: { [FeatureSwitchKey.AuditLink]: true } },
        }),
        [200],
      );
    },

    async createCompose(
      actor: ApiTestUser,
      content: ComposeContent,
    ): Promise<{ readonly composeId: string; readonly name: string }> {
      const client = setupApp({ context })(composesMainContract);
      const response = await accept(
        client.create({ headers: authenticate(actor), body: { content } }),
        [200, 201],
      );
      return { composeId: response.body.composeId, name: response.body.name };
    },

    async readComposeName(
      actor: ApiTestUser,
      composeId: string,
    ): Promise<string> {
      const client = setupApp({ context })(composesByIdContract);
      const response = await accept(
        client.getById({
          headers: authenticate(actor),
          params: { id: composeId },
        }),
        [200],
      );
      return response.body.name;
    },

    async setSecret(actor: ApiTestUser, name: string, value: string) {
      const client = setupApp({ context })(zeroSecretsContract);
      await accept(
        client.set({ headers: authenticate(actor), body: { name, value } }),
        [200, 201],
      );
    },

    async setVariable(actor: ApiTestUser, name: string, value: string) {
      const client = setupApp({ context })(zeroVariablesContract);
      await accept(
        client.set({ headers: authenticate(actor), body: { name, value } }),
        [200, 201],
      );
    },

    async setDefaultAgent(actor: ApiTestUser, agentId: string): Promise<void> {
      const client = setupApp({ context })(orgDefaultAgentContract);
      await accept(
        client.setDefaultAgent({
          headers: authenticate(actor),
          query: {},
          body: { agentId },
        }),
        [200],
      );
    },

    async requestGithubIssuesCallback(
      rawBody: string,
      headers: Record<string, string>,
      statuses: readonly number[],
    ): Promise<{ readonly status: number; readonly body: unknown }> {
      const app = createApp({ signal: context.signal });
      const response = await app.request(GITHUB_ISSUES_CALLBACK_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: rawBody,
      });
      const body: unknown = await response.json();
      if (!statuses.includes(response.status)) {
        throw new Error(
          `Expected GitHub issues callback status in [${statuses.join(", ")}], received ${response.status}: ${JSON.stringify(body)}`,
        );
      }
      return { status: response.status, body };
    },

    /**
     * Composite Given: full GitHub App install through the real install
     * redirect and setup callback. With `oauthCode` set the setup callback
     * exchanges the code against the GitHub App OAuth client and links the
     * installing admin (`github=connected`); without it the install stays
     * unlinked (`github=installed`).
     */
    async installGithubApp(
      actor: ApiTestUser,
      composeId: string,
      options: {
        readonly oauthCode?: {
          readonly code: string;
          readonly githubUserId: string;
          readonly login?: string;
        };
        readonly targetType?: string;
        readonly targetLogin?: string;
      } = {},
    ): Promise<{
      readonly remoteInstallationId: string;
      readonly targetId: string;
      readonly state: string;
    }> {
      if (!actor.orgId) {
        throw new Error("GitHub installs require an org-scoped actor");
      }
      mockGithubAppEnv();
      mockClerkMembership(context, actor, "org:admin");
      mockGithubInstallationsList([]);

      const installQuery = new URLSearchParams({
        vm0UserId: actor.userId,
        orgId: actor.orgId,
        composeId,
      }).toString();
      const install = await requestInstall(installQuery);
      if (install.status !== 307 || !install.location) {
        throw new Error(
          `Expected GitHub install redirect, received ${install.status}`,
        );
      }
      const installUrl = new URL(install.location);
      if (installUrl.origin !== "https://github.com") {
        throw new Error(
          `Unexpected install redirect target: ${install.location}`,
        );
      }
      const state = installUrl.searchParams.get("state");
      if (!state) {
        throw new Error(
          "Expected the install redirect to carry a signed state",
        );
      }

      const remoteInstallationId = newRemoteInstallationId();
      const targetId = newGithubUserId();
      mockGithubInstallationApi({
        installationId: remoteInstallationId,
        targetId,
        login: options.targetLogin ?? "bdd-org",
        type: options.targetType ?? "Organization",
      });
      if (options.oauthCode) {
        mockGithubUserOAuthExchange({
          code: options.oauthCode.code,
          githubUserId: options.oauthCode.githubUserId,
          login: options.oauthCode.login,
        });
      }

      const callbackQuery = new URLSearchParams({
        installation_id: remoteInstallationId,
        setup_action: "install",
        state,
        ...(options.oauthCode ? { code: options.oauthCode.code } : {}),
      }).toString();
      const callback = await requestSetupCallback(callbackQuery);
      if (callback.status !== 307 || !callback.location) {
        throw new Error(
          `Expected GitHub setup callback redirect, received ${callback.status}`,
        );
      }
      const works = new URL(callback.location);
      const expected = options.oauthCode ? "connected" : "installed";
      if (
        works.pathname !== "/works" ||
        works.searchParams.get("github") !== expected
      ) {
        throw new Error(
          `Expected GitHub setup to finish with github=${expected}: ${callback.location}`,
        );
      }

      return { remoteInstallationId, targetId, state };
    },
  };
}
