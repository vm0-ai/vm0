import { command } from "ccstate";
import type {
  TestTelegramStateActionBody,
  TestTelegramStateActionResponse,
} from "@vm0/api-contracts/contracts/test-telegram-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { testTelegramStateRoutes } from "../../test-telegram-state";

const TELEGRAM_STATE_ACTION_ROUTE = "/api/test/telegram-state/action";

export interface TelegramFixture {
  readonly orgId: string;
  readonly composeIds: readonly string[];
  readonly telegramBotIds: readonly string[];
  readonly userIds: readonly string[];
}

interface TelegramFixtureBuilder {
  readonly orgId: string;
  readonly composeIds: string[];
  readonly telegramBotIds: string[];
  readonly userIds: string[];
}

interface SeedTelegramInstallationValues {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly telegramBotId: string;
  readonly botUsername?: string | null;
  readonly defaultComposeId?: string;
  readonly composeUserId?: string;
  readonly composeName?: string;
  readonly agentName?: string;
}

interface SeedOrgDefaultAgentValues {
  readonly orgId: string;
  readonly userId: string;
  readonly composeName?: string;
  readonly agentName?: string;
}

interface SeedOfficialUserLinkValues {
  readonly orgId: string;
  readonly userId: string;
  readonly telegramUserId: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
}

interface SeedTelegramUserLinkValues {
  readonly installationId: string;
  readonly telegramUserId: string;
  readonly vm0UserId: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
}

interface SeedUserAgentPreferenceValues {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
}

function requestTelegramStateAction(
  signal: AbortSignal,
  body: TestTelegramStateActionBody,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal,
    routes: testTelegramStateRoutes,
  });
  return Promise.resolve(
    app.request(TELEGRAM_STATE_ACTION_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function expectOk(response: Response, operation: string): Promise<void> {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postAction(
  signal: AbortSignal,
  body: TestTelegramStateActionBody,
): Promise<TestTelegramStateActionResponse> {
  const response = await requestTelegramStateAction(signal, body);
  signal.throwIfAborted();
  await expectOk(response, `telegram state action ${body.action}`);
  signal.throwIfAborted();
  return await readJson<TestTelegramStateActionResponse>(response);
}

export const seedTelegramInstallation$ = command(
  async (
    _,
    values: SeedTelegramInstallationValues,
    signal: AbortSignal,
  ): Promise<{
    readonly composeId: string;
    readonly telegramBotId: string;
  }> => {
    const response = await postAction(signal, {
      action: "seed-installation",
      org_id: values.orgId,
      owner_user_id: values.ownerUserId,
      telegram_bot_id: values.telegramBotId,
      bot_username: values.botUsername,
      default_compose_id: values.defaultComposeId,
      compose_user_id: values.composeUserId,
      compose_name: values.composeName,
      agent_name: values.agentName,
    });
    const composeId =
      typeof response.compose_id === "string" ? response.compose_id : null;
    const telegramBotId =
      typeof response.telegram_bot_id === "string"
        ? response.telegram_bot_id
        : null;
    if (!composeId || !telegramBotId) {
      throw new Error("seedTelegramInstallation$: response missing ids");
    }

    return { composeId, telegramBotId };
  },
);

export const seedOrgDefaultAgent$ = command(
  async (
    _,
    values: SeedOrgDefaultAgentValues,
    signal: AbortSignal,
  ): Promise<{ readonly composeId: string }> => {
    const response = await postAction(signal, {
      action: "seed-org-default-agent",
      org_id: values.orgId,
      user_id: values.userId,
      compose_name: values.composeName,
      agent_name: values.agentName,
    });
    const composeId =
      typeof response.compose_id === "string" ? response.compose_id : null;
    if (!composeId) {
      throw new Error("seedOrgDefaultAgent$: response missing compose_id");
    }

    return { composeId };
  },
);

export const seedOfficialUserLink$ = command(
  async (
    _,
    values: SeedOfficialUserLinkValues,
    signal: AbortSignal,
  ): Promise<{ readonly userLinkId: string | null }> => {
    const response = await postAction(signal, {
      action: "seed-official-user-link",
      org_id: values.orgId,
      user_id: values.userId,
      telegram_user_id: values.telegramUserId,
      telegram_username: values.telegramUsername,
      telegram_display_name: values.telegramDisplayName,
    });
    return {
      userLinkId:
        typeof response.user_link_id === "string"
          ? response.user_link_id
          : null,
    };
  },
);

export const seedTelegramUserLink$ = command(
  async (
    _,
    values: SeedTelegramUserLinkValues,
    signal: AbortSignal,
  ): Promise<{ readonly userLinkId: string | null }> => {
    const response = await postAction(signal, {
      action: "seed-user-link",
      installation_id: values.installationId,
      telegram_user_id: values.telegramUserId,
      vm0_user_id: values.vm0UserId,
      telegram_username: values.telegramUsername,
      telegram_display_name: values.telegramDisplayName,
    });
    return {
      userLinkId:
        typeof response.user_link_id === "string"
          ? response.user_link_id
          : null,
    };
  },
);

export const seedUserAgentPreference$ = command(
  async (
    _,
    values: SeedUserAgentPreferenceValues,
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "seed-user-agent-preference",
      org_id: values.orgId,
      user_id: values.userId,
      compose_id: values.composeId,
    });
  },
);

export const deleteTelegramFixture$ = command(
  async (_, fixture: TelegramFixture, signal: AbortSignal): Promise<void> => {
    await postAction(signal, {
      action: "delete-fixture",
      org_id: fixture.orgId,
      compose_ids: [...fixture.composeIds],
      telegram_bot_ids: [...fixture.telegramBotIds],
    });
  },
);

export function makeTelegramFixtureBuilder(
  orgId: string,
): TelegramFixtureBuilder {
  return {
    orgId,
    composeIds: [],
    telegramBotIds: [],
    userIds: [],
  };
}

export function freezeTelegramFixture(
  builder: TelegramFixtureBuilder,
): TelegramFixture {
  return {
    orgId: builder.orgId,
    composeIds: [...builder.composeIds],
    telegramBotIds: [...builder.telegramBotIds],
    userIds: [...builder.userIds],
  };
}
