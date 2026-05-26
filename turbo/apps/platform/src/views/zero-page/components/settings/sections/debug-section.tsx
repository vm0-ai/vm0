import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { IconBug } from "@tabler/icons-react";
import { Switch } from "@vm0/ui/components/ui/switch";

import { pageSignal$ } from "../../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";
import {
  captureNetworkBodiesRemaining$,
  updateCaptureNetworkBodies$,
} from "../../../../../signals/zero-page/settings/preferences-page.ts";

const CAPTURE_RUN_COUNT = 3;

function CaptureNetworkBodiesBlock() {
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
            Capture network bodies
          </div>
          <div className="text-sm text-muted-foreground">
            {enabled
              ? `Enabled for the next ${remaining} run${remaining === 1 ? "" : "s"}`
              : "Disabled"}
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
      <CaptureNetworkBodiesBlock />
    </div>
  );
}
