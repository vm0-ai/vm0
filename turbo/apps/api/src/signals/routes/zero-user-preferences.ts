import { command, computed } from "ccstate";
import {
  clientVersionSupportsCapability,
  CLIENT_CAPABILITY_JA_JP_LOCALE,
  CLIENT_CAPABILITY_KO_KR_LOCALE,
  CLIENT_CAPABILITY_ID_ID_LOCALE,
  CLIENT_CAPABILITY_DE_DE_LOCALE,
  CLIENT_CAPABILITY_PT_BR_LOCALE,
  CLIENT_VERSION_HEADER,
} from "@vm0/api-contracts/contracts/client-headers";
import {
  type UserLocale,
  type UserPreferencesResponse,
  zeroUserPreferencesContract,
} from "@vm0/api-contracts/contracts/zero-user-preferences";

import { isBrazilianPortugueseLocaleRolloutEnabled } from "../../lib/brazilian-portuguese-locale-rollout";
import { isGermanLocaleRolloutEnabled } from "../../lib/german-locale-rollout";
import { isIndonesianLocaleRolloutEnabled } from "../../lib/indonesian-locale-rollout";
import { badRequestMessage } from "../../lib/error";
import { isJapaneseLocaleRolloutEnabled } from "../../lib/japanese-locale-rollout";
import { isKoreanLocaleRolloutEnabled } from "../../lib/korean-locale-rollout";
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
  readonly clientSupportsKorean: boolean;
  readonly clientSupportsIndonesian: boolean;
  readonly clientSupportsGerman: boolean;
  readonly brazilianPortugueseEnabled: boolean;
  readonly japaneseEnabled: boolean;
  readonly koreanEnabled: boolean;
  readonly indonesianEnabled: boolean;
  readonly germanEnabled: boolean;
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
  const clientSupportsKorean = clientVersionSupportsCapability(
    clientVersion,
    CLIENT_CAPABILITY_KO_KR_LOCALE,
  );
  const clientSupportsIndonesian = clientVersionSupportsCapability(
    clientVersion,
    CLIENT_CAPABILITY_ID_ID_LOCALE,
  );
  const clientSupportsGerman = clientVersionSupportsCapability(
    clientVersion,
    CLIENT_CAPABILITY_DE_DE_LOCALE,
  );

  return {
    clientSupportsBrazilianPortuguese,
    clientSupportsJapanese,
    clientSupportsKorean,
    clientSupportsIndonesian,
    clientSupportsGerman,
    brazilianPortugueseEnabled:
      clientSupportsBrazilianPortuguese &&
      isBrazilianPortugueseLocaleRolloutEnabled(),
    japaneseEnabled: clientSupportsJapanese && isJapaneseLocaleRolloutEnabled(),
    koreanEnabled: clientSupportsKorean && isKoreanLocaleRolloutEnabled(),
    indonesianEnabled:
      clientSupportsIndonesian && isIndonesianLocaleRolloutEnabled(),
    germanEnabled: clientSupportsGerman && isGermanLocaleRolloutEnabled(),
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
  if (rollout.koreanEnabled) {
    supportedLocales.push("ko-KR");
  }
  if (rollout.indonesianEnabled) {
    supportedLocales.push("id-ID");
  }
  if (rollout.germanEnabled) {
    supportedLocales.push("de-DE");
  }
  return supportedLocales;
}

function projectUserPreferences(
  preferences: UserPreferencesResponse,
  rollout: LocaleRollout,
): UserPreferencesResponse {
  const supportedLocales = supportedLocalesForRollout(rollout);
  // Remove this projection after stale browser clients and rollback candidates
  // that reject optional locales have expired.
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
      rollout.clientSupportsJapanese ||
      rollout.clientSupportsKorean ||
      rollout.clientSupportsIndonesian ||
      rollout.clientSupportsGerman) && {
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
        allowKorean: rollout.koreanEnabled,
        allowIndonesian: rollout.indonesianEnabled,
        allowGerman: rollout.germanEnabled,
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
