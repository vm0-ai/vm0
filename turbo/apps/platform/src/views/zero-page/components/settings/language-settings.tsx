import { useGet, useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";

import {
  isSupportedLocale,
  type SupportedLocale,
} from "../../../../i18n/resources.ts";
import { brandName$ } from "../../../../signals/branding.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  availableLocalePreferences$,
  locale$,
  updateLocalePreference$,
} from "../../../../signals/locale.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

interface LanguageSelectItem {
  readonly label: string;
  readonly value: SupportedLocale;
}

function useLanguageSelectItems(
  availableLocales: readonly SupportedLocale[],
): LanguageSelectItem[] {
  const { t } = useTranslation();
  const items: LanguageSelectItem[] = [
    {
      value: "en-US",
      label: t(($) => {
        return $.settings.preferences.language.options.english;
      }),
    },
    {
      value: "pt-BR",
      label: t(($) => {
        return $.settings.preferences.language.options.portugueseBrazil;
      }),
    },
    {
      value: "ja-JP",
      label: t(($) => {
        return $.settings.preferences.language.options.japanese;
      }),
    },
    {
      value: "ko-KR",
      label: t(($) => {
        return $.settings.preferences.language.options.korean;
      }),
    },
    {
      value: "id-ID",
      label: t(($) => {
        return $.settings.preferences.language.options.indonesian;
      }),
    },
    {
      value: "de-DE",
      label: t(($) => {
        return $.settings.preferences.language.options.german;
      }),
    },
    {
      value: "es-ES",
      label: t(($) => {
        return $.settings.preferences.language.options.spanish;
      }),
    },
    {
      value: "it-IT",
      label: t(($) => {
        return $.settings.preferences.language.options.italian;
      }),
    },
    {
      value: "fr-FR",
      label: t(($) => {
        return $.settings.preferences.language.options.french;
      }),
    },
    {
      value: "hi-IN",
      label: t(($) => {
        return $.settings.preferences.language.options.hindi;
      }),
    },
  ];
  return items.filter((item) => {
    return availableLocales.includes(item.value);
  });
}

function LanguageSelectContent({
  items,
}: {
  readonly items: LanguageSelectItem[];
}) {
  return (
    <SelectContent className="max-h-64">
      {items.map((item) => {
        return (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        );
      })}
    </SelectContent>
  );
}

export function LanguageSettings() {
  const { t } = useTranslation();
  const availableLocalesLoadable = useLastLoadable(availableLocalePreferences$);
  const brandName = useGet(brandName$);
  const locale = useGet(locale$);
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateLocale] = useLoadableSet(
    updateLocalePreference$,
  );
  const availableLocales =
    availableLocalesLoadable.state === "hasData"
      ? availableLocalesLoadable.data
      : [];
  const languageItems = useLanguageSelectItems(availableLocales);
  if (availableLocalesLoadable.state !== "hasData") {
    return null;
  }

  const hasSelectableLocale = availableLocales.some((availableLocale) => {
    return availableLocale !== "en-US";
  });
  if (!hasSelectableLocale) {
    return null;
  }

  const saving = updateLoadable.state === "loading";

  const handleChange = (value: string) => {
    if (!isSupportedLocale(value) || !availableLocales.includes(value)) {
      throw new Error(`Unsupported locale: ${value}`);
    }
    detach(updateLocale(value, pageSignal), Reason.DomCallback);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 bg-card p-4 rounded-xl zero-border sm:flex-row sm:items-center sm:gap-4">
        <div className="flex flex-1 items-center gap-4 min-w-0">
          <div className="shrink-0">
            <div className="flex h-7 w-7 items-center justify-center">
              <Globe size={22} className="text-muted-foreground" />
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <div className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.settings.preferences.language.title;
              })}
            </div>
            <div className="text-sm text-muted-foreground">
              {t(
                ($) => {
                  return $.settings.preferences.language.description;
                },
                { brandName },
              )}
            </div>
          </div>
        </div>
        <div className="w-full shrink-0 sm:w-40">
          <Select
            items={languageItems}
            value={locale}
            disabled={saving}
            onValueChange={handleChange}
          >
            <SelectTrigger
              aria-label={t(($) => {
                return $.settings.preferences.language.label;
              })}
              className="zero-btn-morandi"
            >
              <SelectValue />
            </SelectTrigger>
            <LanguageSelectContent items={languageItems} />
          </Select>
        </div>
      </div>
    </div>
  );
}
