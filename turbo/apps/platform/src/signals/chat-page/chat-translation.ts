import { command, computed } from "ccstate";
import {
  chatTranslationContract,
  type ChatTranslationResponse,
} from "@okouai/api-contracts/contracts/chat-translation";
import {
  CHAT_TRANSLATION_LANGUAGE_BY_USER_LOCALE,
  userLocaleSchema,
  type ChatTranslationLanguage,
  type UserLocale,
} from "@okouai/api-contracts/contracts/user-preferences";

import { accept } from "../../lib/accept.ts";
import { i18n } from "../../i18n/index.ts";
import { apiClient$ } from "../api-client.ts";
import {
  updateUserPreference$,
  userPreferences$,
} from "../okou-page/settings/user-preferences.ts";

function languageFromLocale(
  locale: UserLocale | string | null | undefined,
): ChatTranslationLanguage {
  const userLocale = userLocaleSchema.safeParse(locale);
  if (userLocale.success) {
    return CHAT_TRANSLATION_LANGUAGE_BY_USER_LOCALE[userLocale.data];
  }

  if (locale?.startsWith("zh-TW") || locale?.startsWith("zh-HK")) {
    return "zh-TW";
  }
  if (locale?.startsWith("zh")) {
    return "zh-CN";
  }
  if (locale?.startsWith("pt")) {
    return "pt-BR";
  }
  const language = locale?.split("-")[0];
  if (
    language === "ja" ||
    language === "ko" ||
    language === "es" ||
    language === "fr" ||
    language === "de" ||
    language === "it" ||
    language === "id" ||
    language === "hi"
  ) {
    return language;
  }
  return "en";
}

export const savedChatTranslationLanguage$ = computed(async (get) => {
  const preferences = await get(userPreferences$);
  return (
    preferences.translationLanguage ??
    languageFromLocale(preferences.locale ?? i18n.resolvedLanguage)
  );
});

export const persistChatTranslationLanguage$ = command(
  async (
    { set },
    language: ChatTranslationLanguage,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(updateUserPreference$, { translationLanguage: language }, signal);
  },
);

export const requestChatTranslation$ = command(
  async (
    { get },
    text: string,
    targetLanguage: ChatTranslationLanguage,
    signal: AbortSignal,
  ): Promise<ChatTranslationResponse> => {
    const client = get(apiClient$)(chatTranslationContract);
    const result = await accept(
      client.translate({
        body: { text, targetLanguage },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body;
  },
);
