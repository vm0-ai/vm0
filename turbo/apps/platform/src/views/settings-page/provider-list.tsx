import { useLastResolved } from "ccstate-react";
import { Card } from "@vm0/ui/components/ui/card";
import { configuredProviders$ } from "../../signals/settings-page/model-providers.ts";
import { ProviderRow } from "./provider-row.tsx";
import { AddProviderMenu } from "./add-provider-menu.tsx";

export function ProviderList() {
  const providers = useLastResolved(configuredProviders$);

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-medium text-foreground">Model providers</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Configure the model providers available for your sandboxes
        </p>
      </div>
      {providers &&
        providers.map((provider) => (
          <ProviderRow key={provider.type} provider={provider} />
        ))}
      <AddProviderMenu />
    </Card>
  );
}
