import { command, computed } from "ccstate";
import {
  clientVersionSupportsCapability,
  CLIENT_CAPABILITY_KO_KR_LOCALE,
  CLIENT_CAPABILITY_PT_BR_LOCALE,
  CLIENT_VERSION_HEADER,
} from "@vm0/api-contracts/contracts/client-headers";
import {
  SUPPORTED_USER_LOCALES,
  type UserLocale,
  type UserPreferencesResponse,
  zeroUserPreferencesContract,
} from "@vm0/api-contracts/contracts/zero-user-preferences";

import { isBrazilianPortugueseLocaleRolloutEnabled } from "../../lib/brazilian-portuguese-locale-rollout";
import { badRequestMessage } from "../../lib/error";
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
  readonly clientSupportsKorean: boolean;
  readonly brazilianPortugueseEnabled: boolean;
  readonly koreanEnabled: boolean;
}

const localeRollout$ = computed((get): LocaleRollout => {
  const clientVersion = get(request$).raw.headers.get(CLIENT_VERSION_HEADER);
  const clientSupportsBrazilianPortuguese = clientVersionSupportsCapability(
    clientVersion,
    CLIENT_CAPABILITY_PT_BR_LOCALE,
  );
  const clientSupportsKorean = clientVersionSupportsCapability(
    clientVersion,
    CLIENT_CAPABILITY_KO_KR_LOCALE,
  );

  return {
    clientSupportsBrazilianPortuguese,
    clientSupportsKorean,
    brazilianPortugueseEnabled:
      clientSupportsBrazilianPortuguese &&
      isBrazilianPortugueseLocaleRolloutEnabled(),
    koreanEnabled: clientSupportsKorean && isKoreanLocaleRolloutEnabled(),
  };
});

function localeEnabled(locale: UserLocale, rollout: LocaleRollout): boolean {
  switch (locale) {
    case "en-US": {
      return true;
    }
    case "pt-BR": {
      return rollout.brazilianPortugueseEnabled;
    }
    case "ko-KR": {
      return rollout.koreanEnabled;
    }
  }
}

function supportedLocalesForRollout(rollout: LocaleRollout): UserLocale[] {
  return SUPPORTED_USER_LOCALES.filter((locale) => {
    return localeEnabled(locale, rollout);
  });
}

function projectUserPreferences(
  preferences: UserPreferencesResponse,
  rollout: LocaleRollout,
): UserPreferencesResponse {
  // Project stored locales that this client cannot safely render to English.
  // TODO(#23508): remove the pt-BR projection after legacy clients expire.
  const locale =
    preferences.locale === null ||
    preferences.locale === undefined ||
    localeEnabled(preferences.locale, rollout)
      ? preferences.locale
      : "en-US";
  const clientSupportsLocalePreferences =
    rollout.clientSupportsBrazilianPortuguese || rollout.clientSupportsKorean;

  return {
    ...preferences,
    locale,
    ...(clientSupportsLocalePreferences && {
      supportedLocales: supportedLocalesForRollout(rollout),
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
        writableLocales: supportedLocalesForRollout(rollout),
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
