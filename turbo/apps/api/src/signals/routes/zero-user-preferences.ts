import { command, computed } from "ccstate";
import {
  clientVersionSupportsCapability,
  CLIENT_CAPABILITY_JA_JP_LOCALE,
  CLIENT_CAPABILITY_PT_BR_LOCALE,
  CLIENT_VERSION_HEADER,
} from "@vm0/api-contracts/contracts/client-headers";
import {
  type UserLocale,
  type UserPreferencesResponse,
  zeroUserPreferencesContract,
} from "@vm0/api-contracts/contracts/zero-user-preferences";

import { isBrazilianPortugueseLocaleRolloutEnabled } from "../../lib/brazilian-portuguese-locale-rollout";
import { badRequestMessage } from "../../lib/error";
import { isJapaneseLocaleRolloutEnabled } from "../../lib/japanese-locale-rollout";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  updateUserPreferences$,
  userPreferences,
} from "../services/zero-user-data.service";

const updateUserPreferencesBody$ = bodyResultOf(
  zeroUserPreferencesContract.update,
);

interface LocaleRollout {
  readonly clientSupportsBrazilianPortuguese: boolean;
  readonly clientSupportsJapanese: boolean;
  readonly brazilianPortugueseEnabled: boolean;
  readonly japaneseEnabled: boolean;
}

const localeRollout$ = computed((get): LocaleRollout => {
  const clientVersion = get(request$).raw.headers.get(CLIENT_VERSION_HEADER);
  const clientSupportsBrazilianPortuguese = clientVersionSupportsCapability(
    clientVersion,
    CLIENT_CAPABILITY_PT_BR_LOCALE,
  );
  const clientSupportsJapanese = clientVersionSupportsCapability(
    clientVersion,
    CLIENT_CAPABILITY_JA_JP_LOCALE,
  );

  return {
    clientSupportsBrazilianPortuguese,
    clientSupportsJapanese,
    brazilianPortugueseEnabled:
      clientSupportsBrazilianPortuguese &&
      isBrazilianPortugueseLocaleRolloutEnabled(),
    japaneseEnabled: clientSupportsJapanese && isJapaneseLocaleRolloutEnabled(),
  };
});

function supportedLocalesForRollout(rollout: LocaleRollout): UserLocale[] {
  const supportedLocales: UserLocale[] = ["en-US"];
  if (rollout.brazilianPortugueseEnabled) {
    supportedLocales.push("pt-BR");
  }
  if (rollout.japaneseEnabled) {
    supportedLocales.push("ja-JP");
  }
  return supportedLocales;
}

function projectUserPreferences(
  preferences: UserPreferencesResponse,
  rollout: LocaleRollout,
): UserPreferencesResponse {
  // TODO(#23508): remove projection after legacy browser clients expire.
  const supportedLocales = supportedLocalesForRollout(rollout);
  const locale =
    preferences.locale === undefined ||
    preferences.locale === null ||
    supportedLocales.includes(preferences.locale)
      ? preferences.locale
      : "en-US";

  return {
    ...preferences,
    locale,
    ...((rollout.clientSupportsBrazilianPortuguese ||
      rollout.clientSupportsJapanese) && {
      supportedLocales,
    }),
  };
}

const getUserPreferencesInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const preferences = await get(
    userPreferences({ orgId: auth.orgId, userId: auth.userId }),
  );
  const rollout = await get(localeRollout$);
  return {
    status: 200 as const,
    body: projectUserPreferences(preferences, rollout),
  };
});

const updateUserPreferencesInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const rollout = await get(localeRollout$);
    signal.throwIfAborted();
    const body = await get(updateUserPreferencesBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await set(
      updateUserPreferences$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        preferences: body.data,
        allowBrazilianPortuguese: rollout.brazilianPortugueseEnabled,
        allowJapanese: rollout.japaneseEnabled,
      },
      signal,
    );
    if (!result.ok) {
      return badRequestMessage(result.message);
    }

    return {
      status: 200 as const,
      body: projectUserPreferences(result.data, rollout),
    };
  },
);

export const zeroUserPreferencesRoutes: readonly RouteEntry[] = [
  {
    route: zeroUserPreferencesContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUserPreferencesInner$,
    ),
  },
  {
    route: zeroUserPreferencesContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateUserPreferencesInner$,
    ),
  },
];
