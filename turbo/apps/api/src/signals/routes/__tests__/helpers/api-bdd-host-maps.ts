import {
  zeroHostContract,
  type GeneratePresentationSpeakerNotesRequest,
  type HostedSiteCompleteResponse,
  type HostedSiteFilesResponse,
  type HostedSitePrepareRequest,
  type HostedSitePrepareResponse,
  type HostedSiteRedeployPresentationHtmlRequest,
} from "@vm0/api-contracts/contracts/zero-host";
import { zeroMapsContract } from "@vm0/api-contracts/contracts/zero-maps";

import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

interface AuthHeaders {
  readonly authorization?: string;
}

/**
 * Host routes accept both browser sessions and run-scoped zero tokens, so the
 * host helpers take either a Clerk-backed test user or a raw bearer token.
 */
interface BearerActor {
  readonly bearerToken: string;
}

type HostActor = ApiTestUser | BearerActor;

type HostPrepareStatus = 200 | 400 | 401 | 402 | 403 | 409 | 500;
type HostCompleteStatus = 200 | 400 | 401 | 402 | 403 | 404 | 409 | 500;
type HostFilesStatus = 200 | 400 | 401 | 403 | 404 | 409 | 500;
type HostRedeployStatus = 200 | 400 | 401 | 402 | 403 | 404 | 409 | 500;
type HostSpeakerNotesStatus = 200 | 400 | 401 | 402 | 403 | 500;
type MapsStatus = 200 | 400 | 401 | 402 | 403 | 502 | 503;

interface HostedSitesS3Capture {
  readonly puts: { readonly key: string; readonly body: string }[];
  readonly copies: { readonly key: string; readonly copySource: string }[];
  readonly missingKeys: Set<string>;
}

function isBearerActor(actor: HostActor): actor is BearerActor {
  return "bearerToken" in actor;
}

function authenticate(
  context: TestContext,
  actor: HostActor | null,
): AuthHeaders {
  if (actor && isBearerActor(actor)) {
    return { authorization: `Bearer ${actor.bearerToken}` };
  }
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }
  createZeroRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function commandName(command: unknown): string {
  return typeof command === "object" && command !== null
    ? command.constructor.name
    : "";
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

function bodyText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}

function notFoundS3Error(key: string): Error {
  const error = new Error(`Not found: ${key}`) as Error & {
    $metadata: { httpStatusCode: number };
  };
  error.name = "NotFound";
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

export function createHostMapsBddApi(context: TestContext) {
  function hostClient() {
    return setupApp({ context })(zeroHostContract);
  }

  function mapsClient() {
    return setupApp({ context })(zeroMapsContract);
  }

  return {
    /**
     * Install an explicit hosted-sites S3 boundary: presigned upload URLs
     * resolve, HeadObject reports every key uploaded except `missingKeys`,
     * and Put/Copy commands are recorded for boundary-contract assertions.
     * Context mocks are reset in the global afterEach, so no teardown is
     * needed.
     */
    captureHostedSitesS3(): HostedSitesS3Capture {
      const capture: HostedSitesS3Capture = {
        puts: [],
        copies: [],
        missingKeys: new Set<string>(),
      };
      context.mocks.s3.getSignedUrl.mockResolvedValue(
        "https://r2.example.com/hosted-sites/upload?sig=bdd",
      );
      context.mocks.s3.send.mockImplementation((command: unknown) => {
        const name = commandName(command);
        const input = commandInput(command);
        const key = typeof input.Key === "string" ? input.Key : "";
        if (name === "HeadObjectCommand" && capture.missingKeys.has(key)) {
          return Promise.reject(notFoundS3Error(key));
        }
        if (name === "PutObjectCommand") {
          capture.puts.push({ key, body: bodyText(input.Body) });
        }
        if (name === "CopyObjectCommand") {
          capture.copies.push({
            key,
            copySource:
              typeof input.CopySource === "string" ? input.CopySource : "",
          });
        }
        return Promise.resolve({});
      });
      return capture;
    },

    async prepareHostedSite(
      actor: HostActor,
      body: HostedSitePrepareRequest,
    ): Promise<HostedSitePrepareResponse> {
      const response = await accept(
        hostClient().prepare({
          headers: authenticate(context, actor),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async requestPrepareHostedSite(
      actor: HostActor | null,
      body: HostedSitePrepareRequest,
      statuses: readonly HostPrepareStatus[],
    ) {
      return await accept(
        hostClient().prepare({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    async completeHostedSite(
      actor: HostActor,
      deploymentId: string,
    ): Promise<HostedSiteCompleteResponse> {
      const response = await accept(
        hostClient().complete({
          headers: authenticate(context, actor),
          params: { deploymentId },
          body: {},
        }),
        [200],
      );
      return response.body;
    },

    async requestCompleteHostedSite(
      actor: HostActor | null,
      deploymentId: string,
      statuses: readonly HostCompleteStatus[],
    ) {
      return await accept(
        hostClient().complete({
          headers: authenticate(context, actor),
          params: { deploymentId },
          body: {},
        }),
        statuses,
      );
    },

    async readHostedSiteFiles(
      actor: ApiTestUser,
      publicSlug: string,
    ): Promise<HostedSiteFilesResponse> {
      const response = await accept(
        hostClient().files({
          headers: authenticate(context, actor),
          params: { publicSlug },
        }),
        [200],
      );
      return response.body;
    },

    async requestHostedSiteFiles(
      actor: ApiTestUser | null,
      publicSlug: string,
      statuses: readonly HostFilesStatus[],
    ) {
      return await accept(
        hostClient().files({
          headers: authenticate(context, actor),
          params: { publicSlug },
        }),
        statuses,
      );
    },

    async redeployPresentationHtml(
      actor: ApiTestUser,
      body: HostedSiteRedeployPresentationHtmlRequest,
    ): Promise<HostedSiteCompleteResponse> {
      const response = await accept(
        hostClient().redeployPresentationHtml({
          headers: authenticate(context, actor),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async requestRedeployPresentationHtml(
      actor: ApiTestUser,
      body: HostedSiteRedeployPresentationHtmlRequest,
      statuses: readonly HostRedeployStatus[],
    ) {
      return await accept(
        hostClient().redeployPresentationHtml({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    async requestGenerateSpeakerNotes(
      actor: ApiTestUser,
      body: GeneratePresentationSpeakerNotesRequest,
      statuses: readonly HostSpeakerNotesStatus[],
    ) {
      return await accept(
        hostClient().generatePresentationSpeakerNotes({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    async requestMapsGeocodeWithBearer(
      token: string,
      body: { readonly address: string; readonly region?: string },
      statuses: readonly MapsStatus[],
    ) {
      return await accept(
        mapsClient().geocode({
          headers: { authorization: `Bearer ${token}` },
          body,
        }),
        statuses,
      );
    },
  };
}
