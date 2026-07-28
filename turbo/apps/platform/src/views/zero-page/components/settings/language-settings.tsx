import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { IconWorld } from "@tabler/icons-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";

import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { brandName$ } from "../../../../signals/branding.ts";
import {
  locale$,
  localePreferenceSupported$,
  updateLocalePreference$,
} from "../../../../signals/locale.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

export function LanguageSettings() {
  const supportLoadable = useLoadable(localePreferenceSupported$);
  const brandName = useGet(brandName$);
  const locale = useGet(locale$);
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateLocale] = useLoadableSet(
    updateLocalePreference$,
  );

  if (supportLoadable.state !== "hasData" || supportLoadable.data !== true) {
    return null;
  }

  const saving = updateLoadable.state === "loading";

  const handleChange = (value: string) => {
    if (value !== "en-US" && value !== "zh-CN") {
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
          <div className="text-sm font-medium text-foreground">Language</div>
          <div className="text-sm text-muted-foreground">
            Choose your preferred language for the {brandName} interface
          </div>
        </div>
        <div className="w-40 shrink-0">
          <Select value={locale} disabled={saving} onValueChange={handleChange}>
            <SelectTrigger aria-label="Language" className="zero-btn-morandi">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en-US">English</SelectItem>
              <SelectItem value="zh-CN">简体中文</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
