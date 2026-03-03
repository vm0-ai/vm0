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
import { NotificationSettings } from "./notification-settings.tsx";

export function SettingsPage() {
  const tab = useGet(activeTab$);
  const setTab = useSet(setActiveTab$);
  const featureSwitches = useLastResolved(featureSwitch$);

  return (
    <AppShell
      breadcrumb={["Settings"]}
      title="Settings"
      subtitle="Configure your model providers, connectors, secrets, variables, and notifications"
      contentClassName="mx-auto w-full max-w-[1200px]"
    >
      <div className="flex flex-col gap-6 px-6 pb-8">
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as SettingsTab)}
        >
          <TabsList>
            <TabsTrigger value="providers">Model Providers</TabsTrigger>
            <TabsTrigger value="connections">Connections</TabsTrigger>
            <TabsTrigger value="integrations">Integrations</TabsTrigger>
            <TabsTrigger value="notifications">Notifications</TabsTrigger>
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

        {tab === "connections" && (
          <>
            <ConnectorList />
            <DisconnectConnectorDialog />
            <section className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <h3 className="text-base font-medium text-foreground">
                  Secrets and variables
                </h3>
                <p className="text-sm text-muted-foreground">
                  Add custom API keys and environment variables for your agents.
                </p>
              </div>
              <SecretsAndVariablesList />
            </section>
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

        {tab === "notifications" && <NotificationSettings />}
      </div>
    </AppShell>
  );
}
