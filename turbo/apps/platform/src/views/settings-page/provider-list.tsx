import { useLastResolved } from "ccstate-react";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { configuredProviders$ } from "../../signals/settings-page/model-providers.ts";
import { ProviderRow } from "./provider-row.tsx";
import { AddProviderMenu } from "./add-provider-menu.tsx";

export function ProviderList() {
  const providers = useLastResolved(configuredProviders$);

  return (
    <div className="flex flex-col gap-4">
      {providers === undefined ? (
        <>
          <Skeleton className="h-5 w-52 rounded" />
          <div className="flex flex-col">
            <Skeleton className="h-[68px] w-full rounded-t-xl rounded-b-none" />
            <Skeleton className="h-[68px] w-full rounded-t-none rounded-b-xl border-t border-background" />
          </div>
        </>
      ) : (
        <>
          <h3 className="text-base font-medium text-foreground">
            Configured model providers
          </h3>
          <div className="flex flex-col">
            {providers.map((provider, index) => (
              <ProviderRow
                key={provider.type}
                provider={provider}
                isFirst={index === 0}
              />
            ))}
            <AddProviderMenu isFirst={providers.length === 0} />
          </div>
        </>
      )}
    </div>
  );
}
