import { useGet } from "ccstate-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { AgentsPageLegacy } from "./agents-page-legacy.tsx";
import { AgentsPageTabs } from "./agents-page-tabs.tsx";

export function AgentsPage() {
  const features = useGet(featureSwitch$);
  const redesign = features[FeatureSwitchKey.AgentsPageRedesign] ?? false;
  return redesign ? <AgentsPageTabs /> : <AgentsPageLegacy />;
}
