import { useGet, useSet } from "ccstate-react";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import { AppShell } from "../layout/app-shell.tsx";
import {
  activeTab$,
  setActiveTab$,
  type SettingsTab,
} from "../../signals/settings-page/settings-tabs.ts";
import { DefaultProviderCard } from "./default-provider-card.tsx";
import { ProviderList } from "./provider-list.tsx";
import { ProviderDialog } from "./provider-dialog.tsx";
import { DeleteProviderDialog } from "./delete-provider-dialog.tsx";
import { ConnectorList } from "./connector-list.tsx";
import { DisconnectConnectorDialog } from "./disconnect-connector-dialog.tsx";
import { SecretList } from "./secret-list.tsx";
import { SecretDialog } from "./secret-dialog.tsx";
import { DeleteSecretDialog } from "./delete-secret-dialog.tsx";
import { VariableList } from "./variable-list.tsx";
import { VariableDialog } from "./variable-dialog.tsx";
import { DeleteVariableDialog } from "./delete-variable-dialog.tsx";
import { SlackIntegrationCard } from "../integrations-page/integrations-page.tsx";

export function SettingsPage() {
  const tab = useGet(activeTab$);
  const setTab = useSet(setActiveTab$);

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
            <TabsTrigger value="secrets">Secrets</TabsTrigger>
            <TabsTrigger value="variables">Variables</TabsTrigger>
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

        {tab === "secrets" && (
          <>
            <SecretList />
            <SecretDialog />
            <DeleteSecretDialog />
          </>
        )}

        {tab === "variables" && (
          <>
            <VariableList />
            <VariableDialog />
            <DeleteVariableDialog />
          </>
        )}

        {tab === "integrations" && <SlackIntegrationCard />}
      </div>
    </AppShell>
  );
}
