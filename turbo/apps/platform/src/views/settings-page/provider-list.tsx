import { useLastResolved } from "ccstate-react";
import { configuredProviders$ } from "../../signals/settings-page/model-providers.ts";
import { ProviderRow } from "./provider-row.tsx";
import { AddProviderMenu } from "./add-provider-menu.tsx";

export function ProviderList() {
  const providers = useLastResolved(configuredProviders$);

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-base font-medium text-foreground">
        Configured model providers
      </h3>
      <div className="flex flex-col">
        {providers &&
          providers.map((provider, index) => (
            <ProviderRow
              key={provider.type}
              provider={provider}
              isFirst={index === 0}
            />
          ))}
        <AddProviderMenu isFirst={!providers || providers.length === 0} />
      </div>
    </div>
  );
}
