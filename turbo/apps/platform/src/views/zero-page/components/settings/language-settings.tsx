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

import { isSupportedLocale } from "../../../../i18n/resources.ts";
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
              {availableLocales.includes("en-US") && (
                <SelectItem value="en-US">
                  {t(($) => {
                    return $.settings.preferences.language.options.english;
                  })}
                </SelectItem>
              )}
              {availableLocales.includes("pt-BR") && (
                <SelectItem value="pt-BR">
                  {t(($) => {
                    return $.settings.preferences.language.options
                      .portugueseBrazil;
                  })}
                </SelectItem>
              )}
              {availableLocales.includes("ja-JP") && (
                <SelectItem value="ja-JP">
                  {t(($) => {
                    return $.settings.preferences.language.options.japanese;
                  })}
                </SelectItem>
              )}
              {availableLocales.includes("ko-KR") && (
                <SelectItem value="ko-KR">
                  {t(($) => {
                    return $.settings.preferences.language.options.korean;
                  })}
                </SelectItem>
              )}
              {availableLocales.includes("id-ID") && (
                <SelectItem value="id-ID">
                  {t(($) => {
                    return $.settings.preferences.language.options.indonesian;
                  })}
                </SelectItem>
              )}
              {availableLocales.includes("de-DE") && (
                <SelectItem value="de-DE">
                  {t(($) => {
                    return $.settings.preferences.language.options.german;
                  })}
                </SelectItem>
              )}
              {availableLocales.includes("es-ES") && (
                <SelectItem value="es-ES">
                  {t(($) => {
                    return $.settings.preferences.language.options.spanish;
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
