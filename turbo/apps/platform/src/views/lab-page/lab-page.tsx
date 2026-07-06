import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  getFeatureSwitchMetadata,
  type FeatureSwitchMetadata,
} from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  Switch,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";
import {
  featureSwitch$,
  setFeatureSwitch$,
  resetFeatureSwitches$,
} from "../../signals/external/feature-switch.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  labSort$,
  setLabSort$,
  type LabSort,
} from "../../signals/lab-page/lab-page-ui.ts";

type FeatureSwitchStates = Record<FeatureSwitchKey, boolean> | undefined;
type FeatureSwitchMetadataByKey = Record<
  FeatureSwitchKey,
  FeatureSwitchMetadata
>;

const SORT_OPTIONS: readonly { value: LabSort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "maintainer", label: "Maintainer" },
  { value: "enabled", label: "Enabled first" },
];

function compareByName(a: FeatureSwitchKey, b: FeatureSwitchKey): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function compareFeatureSwitches(params: {
  readonly a: FeatureSwitchKey;
  readonly b: FeatureSwitchKey;
  readonly sort: LabSort;
  readonly features: FeatureSwitchStates;
  readonly metadata: FeatureSwitchMetadataByKey;
}): number {
  const { a, b, sort, features, metadata } = params;
  if (sort === "enabled") {
    const enabledComparison =
      Number(features?.[b] ?? false) - Number(features?.[a] ?? false);
    if (enabledComparison !== 0) {
      return enabledComparison;
    }
  }
  if (sort === "maintainer") {
    const maintainerComparison = metadata[a].maintainer.localeCompare(
      metadata[b].maintainer,
      undefined,
      { sensitivity: "base" },
    );
    if (maintainerComparison !== 0) {
      return maintainerComparison;
    }
  }
  return compareByName(a, b);
}

function sortedFeatureSwitchKeys(params: {
  readonly sort: LabSort;
  readonly features: FeatureSwitchStates;
  readonly metadata: FeatureSwitchMetadataByKey;
}): FeatureSwitchKey[] {
  return Object.values(FeatureSwitchKey).sort((a, b) => {
    return compareFeatureSwitches({ a, b, ...params });
  });
}

function LabHeader(props: {
  readonly sort: LabSort;
  readonly busy: boolean;
  readonly resetting: boolean;
  readonly onSortChange: (sort: LabSort) => void;
  readonly onReset: () => void;
}) {
  return (
    <header className="shrink-0 px-4 sm:px-6 pt-10 pb-3">
      <div className="mx-auto max-w-[900px] flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Lab
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Toggle experimental features on or off.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={props.sort}
            onValueChange={(value) => {
              props.onSortChange(value as LabSort);
            }}
          >
            <SelectTrigger
              aria-label="Sort features"
              className="zero-btn-morandi h-9 w-[160px] gap-1.5 rounded-lg px-3.5 text-sm font-medium"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((option) => {
                return (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
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

export function LabPage() {
  const features = useLastResolved(featureSwitch$);
  const [toggleLoadable, setFeature] = useLoadableSet(setFeatureSwitch$);
  const [resetLoadable, reset] = useLoadableSet(resetFeatureSwitches$);
  const sort = useGet(labSort$);
  const setSort = useSet(setLabSort$);
  const resetting = resetLoadable.state === "loading";
  const toggling = toggleLoadable.state === "loading";
  const busy = resetting || toggling;
  const pageSignal = useGet(pageSignal$);
  const metadata = getFeatureSwitchMetadata();
  const sorted = sortedFeatureSwitchKeys({ sort, features, metadata });
  const connectorKeys = sorted.filter((key) => {
    return key.endsWith("Connector");
  });
  const otherKeys = sorted.filter((key) => {
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
      <LabHeader
        sort={sort}
        busy={busy}
        resetting={resetting}
        onSortChange={setSort}
        onReset={handleReset}
      />

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 pb-10">
        <div className="mx-auto max-w-[900px] space-y-6">
          <LabFeatureGroup
            title="Other"
            keys={otherKeys}
            features={features}
            metadata={metadata}
            busy={busy}
            onToggle={handleToggle}
          />
          <LabFeatureGroup
            title="Connectors"
            keys={connectorKeys}
            features={features}
            metadata={metadata}
            busy={busy}
            onToggle={handleToggle}
          />
        </div>
      </div>
    </div>
  );
}
