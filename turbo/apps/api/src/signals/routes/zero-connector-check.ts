import {
  clientVersionSupportsCapability,
  CLIENT_CAPABILITY_CONNECTOR_SLUG_IDENTITIES,
  CLIENT_VERSION_HEADER,
} from "@vm0/api-contracts/contracts/client-headers";
import {
  type ConnectorCheckDiagnosticResult,
  zeroConnectorCheckContract,
} from "@vm0/api-contracts/contracts/zero-connector-check";
import { command } from "ccstate";

import {
  organizationAuthContext$,
  type AuthErrorResponse,
} from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { resolveConnectorCheck$ } from "../services/connector-check.service";
import { notFound } from "../../lib/error";

function missingAgentRunReadCapability(): AuthErrorResponse {
  return {
    status: 403,
    body: {
      error: {
        message: "Missing required capability: agent-run:read",
        code: "FORBIDDEN",
      },
    },
  };
}

type ConnectorCheckIdentity = Extract<
  ConnectorCheckDiagnosticResult,
  { readonly connector: unknown }
>["connector"];

type ConnectorCheckCandidate = Extract<
  ConnectorCheckDiagnosticResult,
  { readonly outcome: "ambiguous" }
>["candidates"][number];

function legacyConnectorCheckIdentity(
  identity: ConnectorCheckIdentity,
): ConnectorCheckIdentity {
  return {
    connectorRef: identity.connectorRef,
    label: identity.label,
    visibility: identity.visibility,
    credentialResolution: identity.credentialResolution,
  };
}

function legacyConnectorCheckCandidate(
  candidate: ConnectorCheckCandidate,
): ConnectorCheckCandidate {
  return {
    connectorRef: candidate.connectorRef,
    label: candidate.label,
  };
}

function projectConnectorCheckDiagnostic(
  diagnostic: ConnectorCheckDiagnosticResult,
  supportsCanonicalIdentity: boolean,
): ConnectorCheckDiagnosticResult {
  if (supportsCanonicalIdentity) {
    return diagnostic;
  }
  // TODO(#23821): Remove this projection after strict legacy CLI clients expire.
  if (diagnostic.outcome === "ambiguous") {
    return {
      ...diagnostic,
      candidates: diagnostic.candidates.map(legacyConnectorCheckCandidate),
    };
  }
  if ("connector" in diagnostic) {
    return {
      ...diagnostic,
      connector: legacyConnectorCheckIdentity(diagnostic.connector),
    };
  }
  return diagnostic;
}

const checkInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const supportsCanonicalIdentity = clientVersionSupportsCapability(
    get(request$).raw.headers.get(CLIENT_VERSION_HEADER),
    CLIENT_CAPABILITY_CONNECTOR_SLUG_IDENTITIES,
  );
  const bodyResult = await get(bodyResultOf(zeroConnectorCheckContract.check));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  if (
    auth.tokenType === "zero" &&
    !auth.capabilities.includes("agent-run:read")
  ) {
    return missingAgentRunReadCapability();
  }

  const result = await set(
    resolveConnectorCheck$,
    {
      request: bodyResult.data,
      orgId: auth.orgId,
      userId: auth.userId,
      stateSource:
        auth.tokenType === "zero"
          ? { kind: "run", runId: auth.runId }
          : { kind: "stored" },
    },
    signal,
  );
  signal.throwIfAborted();
  if (result.kind === "not-found") {
    return notFound("Agent run not found");
  }
  return {
    status: 200 as const,
    body: projectConnectorCheckDiagnostic(
      result.diagnostic,
      supportsCanonicalIdentity,
    ),
  };
});

export const zeroConnectorCheckRoutes: readonly RouteEntry[] = [
  {
    route: zeroConnectorCheckContract.check,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:read",
      },
      checkInner$,
    ),
  },
];
