import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  getFeatureSwitchMetadata,
  getUserOverridableFeatureSwitchKeys,
  type FeatureSwitchMetadata,
} from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { Switch, Button, cn } from "@vm0/ui";
import {
  featureSwitch$,
  setFeatureSwitch$,
  resetFeatureSwitches$,
} from "../../signals/external/feature-switch.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  LAB_ALL_MAINTAINERS,
  labMaintainerFilter$,
  setLabMaintainerFilter$,
  type LabMaintainerFilter,
} from "../../signals/lab-page/lab-page-ui.ts";

type FeatureSwitchStates = Record<FeatureSwitchKey, boolean> | undefined;
type FeatureSwitchMetadataByKey = Record<
  FeatureSwitchKey,
  FeatureSwitchMetadata
>;

interface MaintainerFilterOption {
  readonly value: LabMaintainerFilter;
  readonly label: string;
  readonly count: number;
}

function compareByName(a: FeatureSwitchKey, b: FeatureSwitchKey): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function sortedFeatureSwitchKeys(): FeatureSwitchKey[] {
  return [...getUserOverridableFeatureSwitchKeys()].sort(compareByName);
}

function maintainerLabel(email: string): string {
  return email.split("@")[0] ?? email;
}

function maintainerFilterOptions(params: {
  readonly keys: readonly FeatureSwitchKey[];
  readonly metadata: FeatureSwitchMetadataByKey;
}): readonly MaintainerFilterOption[] {
  const countsByMaintainer = new Map<string, number>();
  for (const key of params.keys) {
    const maintainer = params.metadata[key].maintainer;
    countsByMaintainer.set(
      maintainer,
      (countsByMaintainer.get(maintainer) ?? 0) + 1,
    );
  }
  return [...countsByMaintainer.entries()]
    .map(([email, count]) => {
      return {
        value: email,
        label: maintainerLabel(email),
        count,
      };
    })
    .sort((a, b) => {
      return a.label.localeCompare(b.label, undefined, {
        sensitivity: "base",
      });
    });
}

function filterFeatureSwitchKeys(params: {
  readonly keys: readonly FeatureSwitchKey[];
  readonly maintainerFilter: LabMaintainerFilter;
  readonly metadata: FeatureSwitchMetadataByKey;
}): FeatureSwitchKey[] {
  if (params.maintainerFilter === LAB_ALL_MAINTAINERS) {
    return [...params.keys];
  }
  return params.keys.filter((key) => {
    return params.metadata[key].maintainer === params.maintainerFilter;
  });
}

function LabHeader() {
  return (
    <header className="shrink-0 px-4 sm:px-6 pt-10 pb-3">
      <div className="mx-auto max-w-[900px]">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Lab
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Toggle experimental features on or off.
        </p>
      </div>
    </header>
  );
}

function MaintainerFilterPills(props: {
  readonly value: LabMaintainerFilter;
  readonly totalCount: number;
  readonly options: readonly MaintainerFilterOption[];
  readonly onChange: (value: LabMaintainerFilter) => void;
}) {
  const options: readonly MaintainerFilterOption[] = [
    {
      value: LAB_ALL_MAINTAINERS,
      label: "All",
      count: props.totalCount,
    },
    ...props.options,
  ];
  return (
    <>
      {options.map((option) => {
        const active = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              props.onChange(option.value);
            }}
            className={cn(
              "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 text-sm font-medium leading-none transition-colors",
              active
                ? "bg-muted text-foreground"
                : "bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            <span>{option.label}</span>
            <span className="text-xs text-muted-foreground">
              {option.count}
            </span>
          </button>
        );
      })}
    </>
  );
}

function LabFilterBar(props: {
  readonly maintainerFilter: LabMaintainerFilter;
  readonly maintainerOptions: readonly MaintainerFilterOption[];
  readonly totalCount: number;
  readonly busy: boolean;
  readonly resetting: boolean;
  readonly onMaintainerFilterChange: (filter: LabMaintainerFilter) => void;
  readonly onReset: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <MaintainerFilterPills
        value={props.maintainerFilter}
        totalCount={props.totalCount}
        options={props.maintainerOptions}
        onChange={props.onMaintainerFilterChange}
      />
      <div className="ml-auto flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          disabled={props.busy}
          onPointerDown={props.onReset}
        >
          {props.resetting ? "Resetting…" : "Reset all"}
        </Button>
      </div>
    </div>
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
      <div className="zero-card divide-y divide-border">
        {props.keys.map((key) => {
          const enabled = props.features?.[key] ?? false;
          const featureMetadata = props.metadata[key];
          return (
            <label
              key={key}
              className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors"
            >
              <div className="flex min-w-0 flex-col gap-1 pr-4">
                <span className="text-sm text-foreground">{key}</span>
                {featureMetadata.description && (
                  <span className="text-xs text-muted-foreground">
                    {featureMetadata.description}
                  </span>
                )}
                <span className="break-all text-xs text-muted-foreground">
                  Maintainer: {featureMetadata.maintainer}
                </span>
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
          );
        })}
      </div>
    </section>
  );
}

function LabEmptyState() {
  return (
    <div className="zero-card flex min-h-[14rem] flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-medium text-foreground">No feature switches</p>
      <p className="mt-1 text-sm text-muted-foreground">
        No feature switches for this maintainer.
      </p>
    </div>
  );
}

export function LabPage() {
  const features = useLastResolved(featureSwitch$);
  const [toggleLoadable, setFeature] = useLoadableSet(setFeatureSwitch$);
  const [resetLoadable, reset] = useLoadableSet(resetFeatureSwitches$);
  const maintainerFilter = useGet(labMaintainerFilter$);
  const setMaintainerFilter = useSet(setLabMaintainerFilter$);
  const resetting = resetLoadable.state === "loading";
  const toggling = toggleLoadable.state === "loading";
  const busy = resetting || toggling;
  const pageSignal = useGet(pageSignal$);
  const metadata = getFeatureSwitchMetadata();
  const sorted = sortedFeatureSwitchKeys();
  const allKeys = getUserOverridableFeatureSwitchKeys();
  const maintainerOptions = maintainerFilterOptions({
    keys: allKeys,
    metadata,
  });
  const filtered = filterFeatureSwitchKeys({
    keys: sorted,
    maintainerFilter,
    metadata,
  });
  const connectorKeys = filtered.filter((key) => {
    return key.endsWith("Connector");
  });
  const otherKeys = filtered.filter((key) => {
    return !key.endsWith("Connector");
  });

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
          <LabFilterBar
            maintainerFilter={maintainerFilter}
            maintainerOptions={maintainerOptions}
            totalCount={allKeys.length}
            busy={busy}
            resetting={resetting}
            onMaintainerFilterChange={setMaintainerFilter}
            onReset={handleReset}
          />
          <div className="space-y-6">
            {filtered.length === 0 ? (
              <LabEmptyState />
            ) : (
              <>
                {otherKeys.length > 0 ? (
                  <LabFeatureGroup
                    title="Other"
                    keys={otherKeys}
                    features={features}
                    metadata={metadata}
                    busy={busy}
                    onToggle={handleToggle}
                  />
                ) : null}
                {connectorKeys.length > 0 ? (
                  <LabFeatureGroup
                    title="Connectors"
                    keys={connectorKeys}
                    features={features}
                    metadata={metadata}
                    busy={busy}
                    onToggle={handleToggle}
                  />
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
