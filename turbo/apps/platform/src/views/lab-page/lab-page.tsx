import { useGet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  getFeatureSwitchMetadata,
  type FeatureSwitchMetadata,
  type FeatureSwitchRolloutStage,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { Button, Switch } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import {
  featureSwitch$,
  resetFeatureSwitches$,
  setFeatureSwitch$,
} from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

type FeatureSwitchStates = Record<FeatureSwitchKey, boolean> | undefined;
type FeatureSwitchMetadataByKey = Record<
  FeatureSwitchKey,
  FeatureSwitchMetadata
>;

function compareByName(a: FeatureSwitchKey, b: FeatureSwitchKey): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function sortedFeatureSwitchKeys(): FeatureSwitchKey[] {
  return Object.values(FeatureSwitchKey).sort(compareByName);
}

function LabHeader() {
  const { t } = useTranslation();

  return (
    <header className="shrink-0 px-4 sm:px-6 pt-10 pb-3">
      <div className="mx-auto max-w-[900px]">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t(($) => {
            return $.settings.lab.title;
          })}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.lab.description;
          })}
        </p>
      </div>
    </header>
  );
}

function LabFeatureGroup(props: {
  readonly title: string;
  readonly keys: readonly FeatureSwitchKey[];
  readonly features: FeatureSwitchStates;
  readonly metadata: FeatureSwitchMetadataByKey;
  readonly busy: boolean;
  readonly onToggle: (key: FeatureSwitchKey, checked: boolean) => void;
}) {
  return (
    <section>
      <h2 className="mb-2 px-1 text-sm font-medium text-muted-foreground">
        {props.title}
      </h2>
      <ul className="zero-card divide-y divide-border overflow-hidden">
        {props.keys.map((key) => {
          const enabled = props.features?.[key] ?? false;
          const featureMetadata = props.metadata[key];
          return (
            <li key={key}>
              <label className="flex cursor-pointer items-center justify-between px-4 py-3 transition-colors hover:bg-state-hover">
                <div className="flex min-w-0 flex-col gap-1 pr-4">
                  <span className="text-sm text-foreground">{key}</span>
                  {featureMetadata.description && (
                    <span className="text-xs text-muted-foreground">
                      {featureMetadata.description}
                    </span>
                  )}
                </div>
                <Switch
                  className="shrink-0"
                  checked={enabled}
                  disabled={props.busy}
                  onCheckedChange={(checked) => {
                    props.onToggle(key, checked);
                  }}
                />
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function LabControls(props: {
  readonly busy: boolean;
  readonly resetting: boolean;
  readonly onReset: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex justify-end">
      <Button
        variant="outline"
        size="sm"
        disabled={props.busy}
        onPointerDown={props.onReset}
      >
        {props.resetting
          ? t(($) => {
              return $.settings.lab.actions.resetting;
            })
          : t(($) => {
              return $.settings.lab.actions.resetAll;
            })}
      </Button>
    </div>
  );
}

export function LabPage() {
  const { t } = useTranslation();
  const features = useLastResolved(featureSwitch$);
  const [toggleLoadable, setFeature] = useLoadableSet(setFeatureSwitch$);
  const [resetLoadable, reset] = useLoadableSet(resetFeatureSwitches$);
  const resetting = resetLoadable.state === "loading";
  const toggling = toggleLoadable.state === "loading";
  const busy = resetting || toggling;
  const pageSignal = useGet(pageSignal$);
  const metadata = getFeatureSwitchMetadata();
  const sorted = sortedFeatureSwitchKeys();
  const groups: readonly {
    readonly stage: FeatureSwitchRolloutStage;
    readonly title: string;
  }[] = [
    {
      stage: "released",
      title: t(($) => {
        return $.settings.lab.groups.released;
      }),
    },
    {
      stage: "beta",
      title: t(($) => {
        return $.settings.lab.groups.beta;
      }),
    },
    {
      stage: "alpha",
      title: t(($) => {
        return $.settings.lab.groups.alpha;
      }),
    },
    {
      stage: "internal",
      title: t(($) => {
        return $.settings.lab.groups.internal;
      }),
    },
  ];

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
      <LabHeader />

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 pb-10">
        <div className="mx-auto max-w-[900px] space-y-4">
          <LabControls
            busy={busy}
            resetting={resetting}
            onReset={handleReset}
          />
          <div className="space-y-6">
            {groups.map((group) => {
              const keys = sorted.filter((key) => {
                return metadata[key].rolloutStage === group.stage;
              });
              return (
                <LabFeatureGroup
                  key={group.stage}
                  title={group.title}
                  keys={keys}
                  features={features}
                  metadata={metadata}
                  busy={busy}
                  onToggle={handleToggle}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
