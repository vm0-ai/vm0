import { createHmac } from "node:crypto";

import { zeroIntegrationsAgentPhoneContract } from "@vm0/api-contracts/contracts/zero-integrations-agentphone";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { agentphoneVerificationSendCooldowns } from "@vm0/db/schema/agentphone-verification-send-cooldown";
import { agentphoneUserLinks } from "@vm0/db/schema/agentphone-user-link";
import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";

import { env, optionalEnv } from "../../lib/env";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { now } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";

interface AgentPhoneConfig {
  readonly agentphoneAgentId: string | null;
  readonly agentPhoneNumber: string | null;
  readonly apiBaseUrl: string | null;
  readonly apiKey: string | null;
  readonly configured: boolean;
}

interface ConfiguredAgentPhoneConfig extends AgentPhoneConfig {
  readonly agentphoneAgentId: string;
  readonly apiBaseUrl: string;
  readonly apiKey: string;
}

const agentPhoneAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const VERIFICATION_SEND_COOLDOWN_MS = 60_000;

const startLinkBody$ = bodyResultOf(
  zeroIntegrationsAgentPhoneContract.startLink,
);

type VerificationSendCooldownScope = "phone" | "user_org";

interface VerificationSendCooldownKey {
  readonly scope: VerificationSendCooldownScope;
  readonly scopeKey: string;
}

function forbidden() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "AgentPhone app UI is not enabled",
        code: "FORBIDDEN",
      },
    },
  };
}

function notConfigured() {
  return {
    status: 503 as const,
    body: {
      error: {
        message: "AgentPhone is not configured",
        code: "NOT_CONFIGURED",
      },
    },
  };
}

function unavailable() {
  return {
    status: 503 as const,
    body: {
      error: {
        message: "AgentPhone verification text could not be sent",
        code: "PROVIDER_UNAVAILABLE",
      },
    },
  };
}

function tooManyVerificationTexts() {
  return {
    status: 429 as const,
    body: {
      error: {
        message:
          "Verification text was just sent. Wait a minute before trying again.",
        code: "TOO_MANY_REQUESTS",
      },
    },
  };
}

function getAgentPhoneConfig(): AgentPhoneConfig {
  const agentphoneAgentId = optionalEnv("AGENTPHONE_AGENT_ID") ?? null;
  const apiBaseUrl = optionalEnv("AGENTPHONE_API_BASE_URL") ?? null;
  const apiKey = optionalEnv("AGENTPHONE_API_KEY") ?? null;
  const agentPhoneNumber = optionalEnv("AGENTPHONE_PHONE_NUMBER") ?? null;

  return {
    agentphoneAgentId,
    agentPhoneNumber,
    apiBaseUrl,
    apiKey,
    configured: Boolean(
      agentphoneAgentId && apiBaseUrl && apiKey && agentPhoneNumber,
    ),
  };
}

function agentPhoneCooldownKeys(params: {
  readonly orgId: string;
  readonly userId: string;
  readonly phoneHandle: string;
}): readonly VerificationSendCooldownKey[] {
  const keys: VerificationSendCooldownKey[] = [
    {
      scope: "phone",
      scopeKey: params.phoneHandle,
    },
    {
      scope: "user_org",
      scopeKey: `${params.orgId}:${params.userId}`,
    },
  ];

  return keys.sort((left, right) => {
    return `${left.scope}:${left.scopeKey}`.localeCompare(
      `${right.scope}:${right.scopeKey}`,
    );
  });
}

function normalizePhoneHandle(value: string): string {
  return value.trim().replace(/[^\d+]/gu, "");
}

function isValidPhoneHandle(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/u.test(value);
}

function signAgentPhoneConnectParams(params: {
  readonly phoneHandle: string;
  readonly agentphoneAgentId: string;
  readonly timestamp: number;
}): string {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(
      `${params.phoneHandle}:${params.agentphoneAgentId}:${String(
        params.timestamp,
      )}`,
    )
    .digest("hex");
}

function buildAgentPhoneConnectUrl(params: {
  readonly phoneHandle: string;
  readonly agentphoneAgentId: string;
}): string {
  const timestamp = Math.floor(now() / 1000);
  const query = new URLSearchParams({
    handle: params.phoneHandle,
    agent: params.agentphoneAgentId,
    ts: String(timestamp),
    sig: signAgentPhoneConnectParams({
      phoneHandle: params.phoneHandle,
      agentphoneAgentId: params.agentphoneAgentId,
      timestamp,
    }),
  });
  return `${env("APP_URL").replace(/\/$/u, "")}/agentphone/connect?${query.toString()}`;
}

async function sendAgentPhoneMessage(params: {
  readonly config: AgentPhoneConfig & {
    readonly agentphoneAgentId: string;
    readonly apiBaseUrl: string;
    readonly apiKey: string;
  };
  readonly toNumber: string;
  readonly body: string;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const response = await fetch(`${params.config.apiBaseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent_id: params.config.agentphoneAgentId,
      to_number: params.toNumber,
      body: params.body,
    }),
    signal: params.signal,
  });

  return response.ok;
}

const requireAgentPhoneUi$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  const enabled = isFeatureEnabled(FeatureSwitchKey.AgentPhoneAppUi, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });

  if (!enabled) {
    return { ok: false as const, response: forbidden() };
  }

  return { ok: true as const, auth };
});

const getLinkStatus$ = computed(async (get) => {
  const gate = await get(requireAgentPhoneUi$);
  if (!gate.ok) {
    return gate.response;
  }

  const config = getAgentPhoneConfig();
  const [link] = await get(db$)
    .select()
    .from(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.vm0UserId, gate.auth.userId),
        eq(agentphoneUserLinks.orgId, gate.auth.orgId),
      ),
    )
    .limit(1);

  if (link) {
    return {
      status: 200 as const,
      body: {
        linked: true as const,
        phoneHandle: link.phoneHandle,
        agentPhoneNumber: config.agentPhoneNumber,
        configured: config.configured,
      },
    };
  }

  return {
    status: 200 as const,
    body: {
      linked: false as const,
      agentPhoneNumber: config.agentPhoneNumber,
      configured: config.configured,
    },
  };
});

const sendAgentPhoneVerificationText$ = command(
  async (
    { set },
    params: {
      readonly config: ConfiguredAgentPhoneConfig;
      readonly cooldownKeys: readonly VerificationSendCooldownKey[];
      readonly phoneHandle: string;
      readonly connectUrl: string;
    },
    signal: AbortSignal,
  ) => {
    const sendResult = await set(writeDb$).transaction(async (tx) => {
      const sentAt = new Date(now());
      const cooldownCutoff = sentAt.getTime() - VERIFICATION_SEND_COOLDOWN_MS;

      for (const key of params.cooldownKeys) {
        await tx
          .insert(agentphoneVerificationSendCooldowns)
          .values({
            scope: key.scope,
            scopeKey: key.scopeKey,
          })
          .onConflictDoNothing();

        const [cooldown] = await tx
          .select({
            lastSentAt: agentphoneVerificationSendCooldowns.lastSentAt,
          })
          .from(agentphoneVerificationSendCooldowns)
          .where(
            and(
              eq(agentphoneVerificationSendCooldowns.scope, key.scope),
              eq(agentphoneVerificationSendCooldowns.scopeKey, key.scopeKey),
            ),
          )
          .for("update")
          .limit(1);
        signal.throwIfAborted();

        if (
          cooldown?.lastSentAt &&
          cooldown.lastSentAt.getTime() > cooldownCutoff
        ) {
          return { ok: false as const, response: tooManyVerificationTexts() };
        }
      }

      const sent = await sendAgentPhoneMessage({
        config: params.config,
        toNumber: params.phoneHandle,
        body: `Confirm this phone number for VM0: ${params.connectUrl}`,
        signal,
      }).catch(() => {
        return false;
      });
      signal.throwIfAborted();

      if (!sent) {
        return { ok: false as const, response: unavailable() };
      }

      for (const key of params.cooldownKeys) {
        await tx
          .update(agentphoneVerificationSendCooldowns)
          .set({ lastSentAt: sentAt, updatedAt: sentAt })
          .where(
            and(
              eq(agentphoneVerificationSendCooldowns.scope, key.scope),
              eq(agentphoneVerificationSendCooldowns.scopeKey, key.scopeKey),
            ),
          );
      }

      return { ok: true as const };
    });
    signal.throwIfAborted();

    return sendResult;
  },
);

const startLink$ = command(async ({ get, set }, signal: AbortSignal) => {
  const gate = await get(requireAgentPhoneUi$);
  signal.throwIfAborted();
  if (!gate.ok) {
    return gate.response;
  }

  const bodyResult = await get(startLinkBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const phoneHandle = normalizePhoneHandle(bodyResult.data.phoneHandle);
  if (!isValidPhoneHandle(phoneHandle)) {
    return badRequestMessage(
      "Enter a phone number with country code, like +1 555 555 1212",
    );
  }

  const config = getAgentPhoneConfig();
  const agentphoneAgentId = config.agentphoneAgentId;
  const apiBaseUrl = config.apiBaseUrl;
  const apiKey = config.apiKey;
  if (!config.configured || !agentphoneAgentId || !apiBaseUrl || !apiKey) {
    return notConfigured();
  }

  const readDb = get(db$);
  const [currentLink] = await readDb
    .select()
    .from(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.vm0UserId, gate.auth.userId),
        eq(agentphoneUserLinks.orgId, gate.auth.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (currentLink) {
    return conflict(
      "Your VM0 account is already connected to a phone number in this organization. Disconnect it first.",
    );
  }

  const [existingPhoneLink] = await readDb
    .select()
    .from(agentphoneUserLinks)
    .where(eq(agentphoneUserLinks.phoneHandle, phoneHandle))
    .limit(1);
  signal.throwIfAborted();

  if (existingPhoneLink) {
    return conflict(
      "This phone number is already connected to another VM0 account or organization. Disconnect it first.",
    );
  }

  const connectUrl = buildAgentPhoneConnectUrl({
    phoneHandle,
    agentphoneAgentId,
  });

  const cooldownKeys = agentPhoneCooldownKeys({
    orgId: gate.auth.orgId,
    userId: gate.auth.userId,
    phoneHandle,
  });
  const sendResult = await set(
    sendAgentPhoneVerificationText$,
    {
      config: {
        ...config,
        agentphoneAgentId,
        apiBaseUrl,
        apiKey,
      },
      cooldownKeys,
      phoneHandle,
      connectUrl,
    },
    signal,
  );

  if (!sendResult.ok) {
    return sendResult.response;
  }

  return {
    status: 200 as const,
    body: { phoneHandle, verificationSent: true as const },
  };
});

const unlink$ = command(async ({ get, set }, signal: AbortSignal) => {
  const gate = await get(requireAgentPhoneUi$);
  signal.throwIfAborted();
  if (!gate.ok) {
    return gate.response;
  }

  const deleted = await set(writeDb$)
    .delete(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.vm0UserId, gate.auth.userId),
        eq(agentphoneUserLinks.orgId, gate.auth.orgId),
      ),
    )
    .returning({ id: agentphoneUserLinks.id });
  signal.throwIfAborted();

  if (deleted.length === 0) {
    return notFound("No linked AgentPhone account");
  }

  return { status: 204 as const, body: undefined };
});

export const zeroIntegrationsAgentPhoneRoutes: readonly RouteEntry[] = [
  {
    route: zeroIntegrationsAgentPhoneContract.getLinkStatus,
    handler: authRoute(agentPhoneAuthOptions, getLinkStatus$),
  },
  {
    route: zeroIntegrationsAgentPhoneContract.startLink,
    handler: authRoute(agentPhoneAuthOptions, startLink$),
  },
  {
    route: zeroIntegrationsAgentPhoneContract.unlink,
    handler: authRoute(agentPhoneAuthOptions, unlink$),
  },
];
