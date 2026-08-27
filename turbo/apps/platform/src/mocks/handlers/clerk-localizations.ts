import { http, HttpResponse } from "msw";

import deDE from "../../i18n/clerk-localizations/de-DE.json";
import deDEUrl from "../../i18n/clerk-localizations/de-DE.json?url";
import esES from "../../i18n/clerk-localizations/es-ES.json";
import esESUrl from "../../i18n/clerk-localizations/es-ES.json?url";
import frFR from "../../i18n/clerk-localizations/fr-FR.json";
import frFRUrl from "../../i18n/clerk-localizations/fr-FR.json?url";
import hiIN from "../../i18n/clerk-localizations/hi-IN.json";
import hiINUrl from "../../i18n/clerk-localizations/hi-IN.json?url";
import idID from "../../i18n/clerk-localizations/id-ID.json";
import idIDUrl from "../../i18n/clerk-localizations/id-ID.json?url";
import itIT from "../../i18n/clerk-localizations/it-IT.json";
import itITUrl from "../../i18n/clerk-localizations/it-IT.json?url";
import jaJP from "../../i18n/clerk-localizations/ja-JP.json";
import jaJPUrl from "../../i18n/clerk-localizations/ja-JP.json?url";
import koKR from "../../i18n/clerk-localizations/ko-KR.json";
import koKRUrl from "../../i18n/clerk-localizations/ko-KR.json?url";
import ptBR from "../../i18n/clerk-localizations/pt-BR.json";
import ptBRUrl from "../../i18n/clerk-localizations/pt-BR.json?url";

const clerkLocalizationFixtures = [
  { localization: deDE, url: deDEUrl },
  { localization: esES, url: esESUrl },
  { localization: frFR, url: frFRUrl },
  { localization: hiIN, url: hiINUrl },
  { localization: idID, url: idIDUrl },
  { localization: itIT, url: itITUrl },
  { localization: jaJP, url: jaJPUrl },
  { localization: koKR, url: koKRUrl },
  { localization: ptBR, url: ptBRUrl },
] as const;

export const clerkLocalizationHandlers = clerkLocalizationFixtures.map(
  ({ localization, url }) => {
    return http.get(url, () => {
      return HttpResponse.json(localization);
    });
  },
);
