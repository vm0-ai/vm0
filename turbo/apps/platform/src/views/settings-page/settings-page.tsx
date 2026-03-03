import { useGet, useLastResolved, useSet } from "ccstate-react";
import { FeatureSwitchKey } from "@vm0/core";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import { AppShell } from "../layout/app-shell.tsx";
import {
  activeTab$,
  setActiveTab$,
  type SettingsTab,
} from "../../signals/settings-page/settings-tabs.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { DefaultProviderCard } from "./default-provider-card.tsx";
import { ProviderList } from "./provider-list.tsx";
import { ProviderDialog } from "./provider-dialog.tsx";
import { DeleteProviderDialog } from "./delete-provider-dialog.tsx";
import { ConnectorList } from "./connector-list.tsx";
import { DisconnectConnectorDialog } from "./disconnect-connector-dialog.tsx";
import { SecretsAndVariablesList } from "./secrets-and-variables-list.tsx";
import { SecretDialog } from "./secret-dialog.tsx";
import { DeleteSecretDialog } from "./delete-secret-dialog.tsx";
import { VariableDialog } from "./variable-dialog.tsx";
import { DeleteVariableDialog } from "./delete-variable-dialog.tsx";
import {
  SlackIntegrationCard,
  GitHubIntegrationCard,
} from "../integrations-page/integrations-page.tsx";

export function SettingsPage() {
  const tab = useGet(activeTab$);
  const setTab = useSet(setActiveTab$);
  const featureSwitches = useLastResolved(featureSwitch$);

  return (
    <AppShell
      breadcrumb={["Settings"]}
      title="Settings"
      subtitle="Configure your model providers, connectors, secrets, and variables"
    >
      <div className="flex flex-col gap-6 px-6 pb-8">
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as SettingsTab)}
        >
          <TabsList>
            <TabsTrigger value="providers">Model Providers</TabsTrigger>
            <TabsTrigger value="connectors">Connectors</TabsTrigger>
            <TabsTrigger value="secrets-and-variables">
              Secrets and variables
            </TabsTrigger>
            <TabsTrigger value="integrations">Integrations</TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === "providers" && (
          <>
            <DefaultProviderCard />
            <ProviderList />
            <ProviderDialog />
            <DeleteProviderDialog />
          </>
        )}

        {tab === "connectors" && (
          <>
            <ConnectorList />
            <DisconnectConnectorDialog />
          </>
        )}

        {tab === "secrets-and-variables" && (
          <>
            <SecretsAndVariablesList />
            <SecretDialog />
            <DeleteSecretDialog />
            <VariableDialog />
            <DeleteVariableDialog />
          </>
        )}

        {tab === "integrations" && (
          <div className="flex flex-col gap-4">
            <SlackIntegrationCard />
            {featureSwitches?.[FeatureSwitchKey.GitHubIntegration] && (
              <GitHubIntegrationCard />
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
