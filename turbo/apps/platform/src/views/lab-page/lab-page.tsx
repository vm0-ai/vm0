import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { FeatureSwitchKey } from "@vm0/core";
import { Switch, Button } from "@vm0/ui";
import {
  featureSwitch$,
  overrideFeatureSwitch$,
  syncFeatureSwitchToDB$,
  resetFeatureSwitchOverrides$,
} from "../../signals/external/feature-switch.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";

export function LabPage() {
  const features = useLastResolved(featureSwitch$);
  const overrideLocal = useSet(overrideFeatureSwitch$);
  const syncDB = useSet(syncFeatureSwitchToDB$);
  const [resetLoadable, reset] = useLoadableSet(resetFeatureSwitchOverrides$);
  const resetting = resetLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const handleToggle = (key: FeatureSwitchKey, checked: boolean) => {
    const override = { [key]: checked } as Partial<
      Record<FeatureSwitchKey, boolean>
    >;
    overrideLocal(override);
    detach(
      syncDB(override, pageSignal),
      Reason.DomCallback,
      "syncFeatureSwitchToDB",
    );
  };

  const handleReset = () => {
    detach(
      reset(pageSignal),
      Reason.DomCallback,
      "resetFeatureSwitchOverrides",
    );
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px] flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Lab
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Toggle experimental features on or off.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={resetting}
            onPointerDown={handleReset}
          >
            {resetting ? "Resetting…" : "Reset all"}
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 pb-10">
        <div className="mx-auto max-w-[900px]">
          <div className="zero-card divide-y divide-border">
            {Object.values(FeatureSwitchKey)
              .sort((a, b) => {
                return a.localeCompare(b, undefined, { sensitivity: "base" });
              })
              .map((key) => {
                const enabled = features?.[key] ?? false;
                return (
                  <label
                    key={key}
                    className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors"
                  >
                    <span className="text-sm text-foreground">{key}</span>
                    <Switch
                      checked={enabled}
                      onCheckedChange={(checked) => {
                        handleToggle(key, checked);
                      }}
                    />
                  </label>
                );
              })}
          </div>
        </div>
      </div>
    </div>
  );
}
