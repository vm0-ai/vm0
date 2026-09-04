import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Sparkles, X } from "lucide-react";
import { Button } from "@okouai/ui";
import {
  dismissRebrandBanner$,
  rebrandBannerVisible$,
} from "../../signals/rebrand-banner.ts";

export function RebrandBanner() {
  const { t } = useTranslation();
  const visible = useGet(rebrandBannerVisible$);
  const dismiss = useSet(dismissRebrandBanner$);

  if (!visible) {
    return null;
  }

  return (
    <div className="shrink-0 flex items-center gap-2 bg-primary/5 border-b border-primary/20 px-3 py-2 text-sm">
      <Sparkles size={16} className="text-brand-text shrink-0" />
      <span className="flex-1 min-w-0 truncate text-foreground">
        {t(($) => {
          return $.lifecycle.rebrandBanner.message;
        })}
      </span>
      <Button
        showTooltip
        type="button"
        onClick={() => {
          dismiss();
        }}
        variant="quiet"
        size="icon-xs"
        className="shrink-0"
        aria-label={t(($) => {
          return $.lifecycle.rebrandBanner.dismiss;
        })}
      >
        <X size={14} />
      </Button>
    </div>
  );
}
