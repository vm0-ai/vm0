import { useGet, useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { IconWorld } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";

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

export function LanguageSettings() {
  const { t } = useTranslation();
  const availableLocalesLoadable = useLastLoadable(availableLocalePreferences$);
  const brandName = useGet(brandName$);
  const locale = useGet(locale$);
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateLocale] = useLoadableSet(
    updateLocalePreference$,
  );

  if (
    availableLocalesLoadable.state !== "hasData" ||
    availableLocalesLoadable.data.length <= 1
  ) {
    return null;
  }

  const availableLocales = availableLocalesLoadable.data;
  const saving = updateLoadable.state === "loading";

  const handleChange = (value: string) => {
    if (!isSupportedLocale(value) || !availableLocales.includes(value)) {
      throw new Error(`Unsupported locale: ${value}`);
    }
    detach(updateLocale(value, pageSignal), Reason.DomCallback);
  };

  const supports = (localeOption: SupportedLocale): boolean => {
    return availableLocales.includes(localeOption);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4 bg-card p-4 rounded-xl zero-border">
        <div className="shrink-0">
          <div className="flex h-7 w-7 items-center justify-center">
            <IconWorld
              size={22}
              stroke={1.5}
              className="text-muted-foreground"
            />
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
        <div className="w-40 shrink-0">
          <Select value={locale} disabled={saving} onValueChange={handleChange}>
            <SelectTrigger
              aria-label={t(($) => {
                return $.settings.preferences.language.label;
              })}
              className="zero-btn-morandi"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {supports("en-US") && (
                <SelectItem value="en-US">
                  {t(($) => {
                    return $.settings.preferences.language.options.english;
                  })}
                </SelectItem>
              )}
              {supports("pt-BR") && (
                <SelectItem value="pt-BR">
                  {t(($) => {
                    return $.settings.preferences.language.options
                      .portugueseBrazil;
                  })}
                </SelectItem>
              )}
              {supports("ja-JP") && (
                <SelectItem value="ja-JP">
                  {t(($) => {
                    return $.settings.preferences.language.options.japanese;
                  })}
                </SelectItem>
              )}
              {supports("ko-KR") && (
                <SelectItem value="ko-KR">
                  {t(($) => {
                    return $.settings.preferences.language.options.korean;
                  })}
                </SelectItem>
              )}
              {supports("id-ID") && (
                <SelectItem value="id-ID">
                  {t(($) => {
                    return $.settings.preferences.language.options.indonesian;
                  })}
                </SelectItem>
              )}
              {supports("de-DE") && (
                <SelectItem value="de-DE">
                  {t(($) => {
                    return $.settings.preferences.language.options.german;
                  })}
                </SelectItem>
              )}
              {supports("es-ES") && (
                <SelectItem value="es-ES">
                  {t(($) => {
                    return $.settings.preferences.language.options.spanish;
                  })}
                </SelectItem>
              )}
              {supports("it-IT") && (
                <SelectItem value="it-IT">
                  {t(($) => {
                    return $.settings.preferences.language.options.italian;
                  })}
                </SelectItem>
              )}
              {supports("fr-FR") && (
                <SelectItem value="fr-FR">
                  {t(($) => {
                    return $.settings.preferences.language.options.french;
                  })}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
