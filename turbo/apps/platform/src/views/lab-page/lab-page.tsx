import {
  getFeatureSwitchMetadata,
  type FeatureSwitchMetadata,
  type FeatureSwitchRolloutStage,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useTranslation } from "react-i18next";

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
  readonly metadata: FeatureSwitchMetadataByKey;
}) {
  return (
    <section>
      <h2 className="mb-2 px-1 text-sm font-medium text-muted-foreground">
        {props.title}
      </h2>
      <ul className="zero-card divide-y divide-border overflow-hidden">
        {props.keys.map((key) => {
          const featureMetadata = props.metadata[key];
          return (
            <li key={key} className="px-4 py-3">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-sm text-foreground">{key}</span>
                {featureMetadata.description && (
                  <span className="text-xs text-muted-foreground">
                    {featureMetadata.description}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function LabPage() {
  const { t } = useTranslation();
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

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <LabHeader />

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 pb-10">
        <div className="mx-auto max-w-[900px] space-y-6">
          {groups.map((group) => {
            const keys = sorted.filter((key) => {
              return metadata[key].rolloutStage === group.stage;
            });
            return (
              <LabFeatureGroup
                key={group.stage}
                title={group.title}
                keys={keys}
                metadata={metadata}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
