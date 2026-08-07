import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { IconBug } from "@tabler/icons-react";
import { Switch } from "@vm0/ui/components/ui/switch";

import { pageSignal$ } from "../../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";
import {
  captureNetworkBodiesRemaining$,
  updateCaptureNetworkBodies$,
} from "../../../../../signals/zero-page/settings/preferences-page.ts";
import { BuildInfoBlock } from "../build-info-block.tsx";
import { ConnectorCatalogDiagnosticsBlock } from "../connector-catalog-diagnostics-block.tsx";

const CAPTURE_RUN_COUNT = 3;

function CaptureNetworkBodiesBlock() {
  const { t } = useTranslation();
  const remainingLoadable = useLoadable(captureNetworkBodiesRemaining$);
  const remaining =
    remainingLoadable.state === "hasData" ? remainingLoadable.data : 0;
  const [captureLoadable, updateCapture] = useLoadableSet(
    updateCaptureNetworkBodies$,
  );
  const saving = captureLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);
  const enabled = remaining > 0;

  const handleToggle = (checked: boolean) => {
    detach(
      updateCapture(checked ? CAPTURE_RUN_COUNT : 0, pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4 bg-card p-4 rounded-xl zero-border">
        <div className="shrink-0">
          <div className="flex h-7 w-7 items-center justify-center">
            <IconBug size={22} stroke={1.5} className="text-muted-foreground" />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-1 min-w-0">
          <div className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.settings.preferences.debug.capture.title;
            })}
          </div>
          <div className="text-sm text-muted-foreground">
            {enabled
              ? t(
                  ($) => {
                    return $.settings.preferences.debug.capture.enabled;
                  },
                  {
                    count: remaining,
                  },
                )
              : t(($) => {
                  return $.settings.preferences.debug.capture.disabled;
                })}
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={handleToggle}
          disabled={saving}
        />
      </div>
    </div>
  );
}

export function DebugSection() {
  return (
    <div className="flex flex-col gap-6">
      <BuildInfoBlock />
      <ConnectorCatalogDiagnosticsBlock />
      <CaptureNetworkBodiesBlock />
    </div>
  );
}
