import { command, computed } from "ccstate";
import {
  clientVersionSupportsCapability,
  CLIENT_CAPABILITY_ES_ES_LOCALE,
  CLIENT_CAPABILITY_FR_FR_LOCALE,
  CLIENT_CAPABILITY_HI_IN_LOCALE,
  CLIENT_CAPABILITY_IT_IT_LOCALE,
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
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { isBrazilianPortugueseLocaleRolloutEnabled } from "../../lib/brazilian-portuguese-locale-rollout";
import { isFrenchLocaleRolloutEnabled } from "../../lib/french-locale-rollout";
import { isGermanLocaleRolloutEnabled } from "../../lib/german-locale-rollout";
import { isHindiLocaleRolloutEnabled } from "../../lib/hindi-locale-rollout";
import { isIndonesianLocaleRolloutEnabled } from "../../lib/indonesian-locale-rollout";
import { badRequestMessage } from "../../lib/error";
import { isItalianLocaleRolloutEnabled } from "../../lib/italian-locale-rollout";
import { isJapaneseLocaleRolloutEnabled } from "../../lib/japanese-locale-rollout";
import { isKoreanLocaleRolloutEnabled } from "../../lib/korean-locale-rollout";
import { isSpanishLocaleRolloutEnabled } from "../../lib/spanish-locale-rollout";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  updateUserPreferences$,
  userPreferences,
} from "../services/zero-user-data.service";

const updateUserPreferencesBody$ = bodyResultOf(
  zeroUserPreferencesContract.update,
);

interface LocaleRollout {
  readonly clientSupportsLocaleNegotiation: boolean;
  readonly supportedLocales: readonly UserLocale[];
}

function addSupportedLocale(
  supportedLocales: UserLocale[],
  locale: UserLocale,
  clientSupportsLocale: boolean,
  rolloutEnabled: boolean,
): void {
  if (clientSupportsLocale && rolloutEnabled) {
    supportedLocales.push(locale);
  }
}

const localeRollout$ = computed(async (get): Promise<LocaleRollout> => {
  const auth = get(organizationAuthContext$);
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
  const clientSupportsSpanish = clientVersionSupportsCapability(
    clientVersion,
    CLIENT_CAPABILITY_ES_ES_LOCALE,
  );
  const clientSupportsItalian = clientVersionSupportsCapability(
    clientVersion,
    CLIENT_CAPABILITY_IT_IT_LOCALE,
  );
  const clientSupportsFrench = clientVersionSupportsCapability(
    clientVersion,
    CLIENT_CAPABILITY_FR_FR_LOCALE,
  );
  const clientSupportsHindi = clientVersionSupportsCapability(
    clientVersion,
    CLIENT_CAPABILITY_HI_IN_LOCALE,
  );
  const japaneseEnabled =
    clientSupportsJapanese &&
    isJapaneseLocaleRolloutEnabled() &&
    isFeatureEnabled(FeatureSwitchKey.JapaneseLocale, {
      orgId: auth.orgId,
      userId: auth.userId,
      overrides: await get(userFeatureSwitchOverrides(auth.orgId, auth.userId)),
    });
  const supportedLocales: UserLocale[] = ["en-US"];
  addSupportedLocale(
    supportedLocales,
    "pt-BR",
    clientSupportsBrazilianPortuguese,
    isBrazilianPortugueseLocaleRolloutEnabled(),
  );
  addSupportedLocale(
    supportedLocales,
    "ja-JP",
    clientSupportsJapanese,
    japaneseEnabled,
  );
  addSupportedLocale(
    supportedLocales,
    "ko-KR",
    clientSupportsKorean,
    isKoreanLocaleRolloutEnabled(),
  );
  addSupportedLocale(
    supportedLocales,
    "id-ID",
    clientSupportsIndonesian,
    isIndonesianLocaleRolloutEnabled(),
  );
  addSupportedLocale(
    supportedLocales,
    "de-DE",
    clientSupportsGerman,
    isGermanLocaleRolloutEnabled(),
  );
  addSupportedLocale(
    supportedLocales,
    "es-ES",
    clientSupportsSpanish,
    isSpanishLocaleRolloutEnabled(),
  );
  addSupportedLocale(
    supportedLocales,
    "it-IT",
    clientSupportsItalian,
    isItalianLocaleRolloutEnabled(),
  );
  addSupportedLocale(
    supportedLocales,
    "fr-FR",
    clientSupportsFrench,
    isFrenchLocaleRolloutEnabled(),
  );
  addSupportedLocale(
    supportedLocales,
    "hi-IN",
    clientSupportsHindi,
    isHindiLocaleRolloutEnabled(),
  );

  return {
    clientSupportsLocaleNegotiation:
      clientSupportsBrazilianPortuguese ||
      clientSupportsJapanese ||
      clientSupportsKorean ||
      clientSupportsIndonesian ||
      clientSupportsGerman ||
      clientSupportsSpanish ||
      clientSupportsItalian ||
      clientSupportsFrench ||
      clientSupportsHindi,
    supportedLocales,
  };
});

function projectUserPreferences(
  preferences: UserPreferencesResponse,
  rollout: LocaleRollout,
): UserPreferencesResponse {
  // Keep projecting unsupported values while older clients and rollback API
  // versions can still encounter locale values they cannot parse.
  const locale =
    preferences.locale === undefined ||
    preferences.locale === null ||
    rollout.supportedLocales.includes(preferences.locale)
      ? preferences.locale
      : "en-US";

  return {
    ...preferences,
    locale,
    ...(rollout.clientSupportsLocaleNegotiation && {
      supportedLocales: [...rollout.supportedLocales],
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
        allowedLocales: rollout.supportedLocales,
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
