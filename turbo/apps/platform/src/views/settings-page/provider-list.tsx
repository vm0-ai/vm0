import { useGet, useLastResolved, useSet } from "ccstate-react";
import { Button } from "@vm0/ui/components/ui/button";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { IconPlus } from "@tabler/icons-react";
import {
  addProviderDialogOpen$,
  setAddProviderDialogOpen$,
  configuredProviders$,
} from "../../signals/settings-page/model-providers.ts";
import { ProviderRow } from "./provider-row.tsx";
import { AddProviderDialog } from "./add-provider-dialog.tsx";

export function ProviderList() {
  const addDialogOpen = useGet(addProviderDialogOpen$);
  const setAddDialogOpen = useSet(setAddProviderDialogOpen$);
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
          <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <h3 className="text-base font-medium text-foreground">
              Configured model providers
            </h3>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-2"
              onClick={() => setAddDialogOpen(true)}
            >
              <IconPlus size={16} stroke={1.5} />
              Add model provider
            </Button>
          </div>
          <div className="flex flex-col">
            {providers.length === 0 ? (
              <div className="rounded-xl border border-border bg-card p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  No providers configured. Click Add model provider to add one.
                </p>
              </div>
            ) : (
              providers.map((provider, index) => (
                <ProviderRow
                  key={provider.type}
                  provider={provider}
                  isFirst={index === 0}
                />
              ))
            )}
          </div>
          <AddProviderDialog
            open={addDialogOpen}
            onOpenChange={setAddDialogOpen}
          />
        </>
      )}
    </div>
  );
}
