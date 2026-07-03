import { useGet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { getFeatureSwitchDescriptions } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { Switch, Button } from "@vm0/ui";
import {
  featureSwitch$,
  setFeatureSwitch$,
  resetFeatureSwitches$,
} from "../../signals/external/feature-switch.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";

export function LabPage() {
  const features = useLastResolved(featureSwitch$);
  const [toggleLoadable, setFeature] = useLoadableSet(setFeatureSwitch$);
  const [resetLoadable, reset] = useLoadableSet(resetFeatureSwitches$);
  const resetting = resetLoadable.state === "loading";
  const toggling = toggleLoadable.state === "loading";
  const busy = resetting || toggling;
  const pageSignal = useGet(pageSignal$);
  const descriptions = getFeatureSwitchDescriptions();

  const handleToggle = (key: FeatureSwitchKey, checked: boolean) => {
    detach(
      setFeature({ [key]: checked }, pageSignal),
      Reason.DomCallback,
      "setFeatureSwitch",
    );
  };

  const handleReset = () => {
    detach(reset(pageSignal), Reason.DomCallback, "resetFeatureSwitches");
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
            disabled={busy}
            onPointerDown={handleReset}
          >
            {resetting ? "Resetting…" : "Reset all"}
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 pb-10">
        <div className="mx-auto max-w-[900px] space-y-6">
          {(() => {
            const sorted = Object.values(FeatureSwitchKey).sort((a, b) => {
              return a.localeCompare(b, undefined, { sensitivity: "base" });
            });
            const connectorKeys = sorted.filter((key) => {
              return key.endsWith("Connector");
            });
            const otherKeys = sorted.filter((key) => {
              return !key.endsWith("Connector");
            });

            const renderGroup = (title: string, keys: FeatureSwitchKey[]) => {
              return (
                <section>
                  <h2 className="mb-2 px-1 text-sm font-medium text-muted-foreground">
                    {title}
                  </h2>
                  <div className="zero-card divide-y divide-border">
                    {keys.map((key) => {
                      const enabled = features?.[key] ?? false;
                      return (
                        <label
                          key={key}
                          className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors"
                        >
                          <div className="flex flex-col">
                            <span className="text-sm text-foreground">
                              {key}
                            </span>
                            {descriptions[key] && (
                              <span className="text-xs text-muted-foreground">
                                {descriptions[key]}
                              </span>
                            )}
                          </div>
                          <Switch
                            checked={enabled}
                            disabled={busy}
                            onCheckedChange={(checked) => {
                              handleToggle(key, checked);
                            }}
                          />
                        </label>
                      );
                    })}
                  </div>
                </section>
              );
            };

            return (
              <>
                {renderGroup("Other", otherKeys)}
                {renderGroup("Connectors", connectorKeys)}
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
