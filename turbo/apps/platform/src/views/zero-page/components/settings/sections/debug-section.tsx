import { useState } from "react";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { IconBug, IconCoins } from "@tabler/icons-react";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import { Switch } from "@vm0/ui/components/ui/switch";
import { toast } from "@vm0/ui/components/ui/sonner";

import { pageSignal$ } from "../../../../../signals/page-signal.ts";
import { detach, Reason, settle } from "../../../../../signals/utils.ts";
import { setOrgCreditsDebug$ } from "../../../../../signals/zero-page/billing.ts";
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

function SimulateCreditsBlock() {
  const [value, setValue] = useState("0");
  const [saving, setSaving] = useState(false);
  const setCredits = useSet(setOrgCreditsDebug$);
  const pageSignal = useGet(pageSignal$);

  const handleApply = () => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast.error("Enter a non-negative number");
      return;
    }
    const credits = Math.floor(parsed);
    setSaving(true);
    const run = async () => {
      const result = await settle(setCredits(credits, pageSignal));
      setSaving(false);
      if (result.ok) {
        toast.success(`Credits set to ${credits.toLocaleString()}`);
      } else {
        toast.error(
          result.error instanceof Error
            ? result.error.message
            : "Failed to set credits",
        );
      }
    };
    detach(run(), Reason.DomCallback);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4 bg-card p-4 rounded-xl zero-border">
        <div className="shrink-0">
          <div className="flex h-7 w-7 items-center justify-center">
            <IconCoins
              size={22}
              stroke={1.5}
              className="text-muted-foreground"
            />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-1 min-w-0">
          <div className="text-sm font-medium text-foreground">
            Simulate credit balance
          </div>
          <div className="text-sm text-muted-foreground">
            Override this workspace's credit balance to preview empty or
            low-credit states. Available on preview deployments only.
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Input
            type="number"
            min={0}
            inputMode="numeric"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
            }}
            className="h-8 w-28"
            aria-label="Credit balance"
          />
          <Button
            type="button"
            size="sm"
            variant="default"
            disabled={saving}
            onClick={handleApply}
          >
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}

const isProductionBuild = import.meta.env.VITE_VERCEL_ENV === "production";

export function DebugSection() {
  return (
    <div className="flex flex-col gap-6">
      <CaptureNetworkBodiesBlock />
      {!isProductionBuild && <SimulateCreditsBlock />}
    </div>
  );
}
