import { AppShell } from "../layout/app-shell.tsx";
import { DefaultProviderCard } from "./default-provider-card.tsx";
import { ProviderList } from "./provider-list.tsx";
import { ProviderDialog } from "./provider-dialog.tsx";
import { DeleteProviderDialog } from "./delete-provider-dialog.tsx";

export function SettingsPage() {
  return (
    <AppShell
      breadcrumb={["Settings"]}
      title="Settings"
      subtitle="Configure your model providers and project preferences"
    >
      <div className="flex flex-col gap-6 px-8 pb-8">
        <DefaultProviderCard />
        <ProviderList />
        <ProviderDialog />
        <DeleteProviderDialog />
      </div>
    </AppShell>
  );
}
