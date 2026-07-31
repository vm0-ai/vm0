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

import { badRequestMessage } from "../../lib/error";
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

interface LocaleNegotiation {
  readonly clientSupportsLocaleNegotiation: boolean;
  readonly supportedLocales: readonly UserLocale[];
}

function addSupportedLocale(
  supportedLocales: UserLocale[],
  locale: UserLocale,
  clientSupportsLocale: boolean,
): void {
  if (clientSupportsLocale) {
    supportedLocales.push(locale);
  }
}

const localeNegotiation$ = computed((get): LocaleNegotiation => {
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
  const supportedLocales: UserLocale[] = ["en-US"];
  addSupportedLocale(
    supportedLocales,
    "pt-BR",
    clientSupportsBrazilianPortuguese,
  );
  addSupportedLocale(supportedLocales, "ja-JP", clientSupportsJapanese);
  addSupportedLocale(supportedLocales, "ko-KR", clientSupportsKorean);
  addSupportedLocale(supportedLocales, "id-ID", clientSupportsIndonesian);
  addSupportedLocale(supportedLocales, "de-DE", clientSupportsGerman);
  addSupportedLocale(supportedLocales, "es-ES", clientSupportsSpanish);
  addSupportedLocale(supportedLocales, "it-IT", clientSupportsItalian);
  addSupportedLocale(supportedLocales, "fr-FR", clientSupportsFrench);
  addSupportedLocale(supportedLocales, "hi-IN", clientSupportsHindi);

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
  negotiation: LocaleNegotiation,
): UserPreferencesResponse {
  // Keep projecting unsupported values while older clients and rollback API
  // versions can still encounter locale values they cannot parse.
  const locale =
    preferences.locale === undefined ||
    preferences.locale === null ||
    negotiation.supportedLocales.includes(preferences.locale)
      ? preferences.locale
      : "en-US";

  return {
    ...preferences,
    locale,
    ...(negotiation.clientSupportsLocaleNegotiation && {
      supportedLocales: [...negotiation.supportedLocales],
    }),
  };
}

const getUserPreferencesInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const preferences = await get(
    userPreferences({ orgId: auth.orgId, userId: auth.userId }),
  );
  const negotiation = get(localeNegotiation$);
  return {
    status: 200 as const,
    body: projectUserPreferences(preferences, negotiation),
  };
});

const updateUserPreferencesInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const negotiation = get(localeNegotiation$);
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
        allowedLocales: negotiation.supportedLocales,
      },
      signal,
    );
    if (!result.ok) {
      return badRequestMessage(result.message);
    }

    return {
      status: 200 as const,
      body: projectUserPreferences(result.data, negotiation),
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
