import { useGet, useLastResolved, useSet } from "ccstate-react";
import { Card } from "@vm0/ui/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import type { ModelProviderType } from "@vm0/core";
import { getUILabel } from "./provider-ui-config.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  configuredProviders$,
  defaultProvider$,
  setDefaultProvider$,
} from "../../signals/settings-page/model-providers.ts";
import { ProviderIcon } from "./provider-icons.tsx";

export function DefaultProviderCard() {
  const providers = useLastResolved(configuredProviders$);
  const defaultProvider = useLastResolved(defaultProvider$);
  const setDefault = useSet(setDefaultProvider$);
  const pageSignal = useGet(pageSignal$);

  if (!providers || providers.length === 0) {
    return null;
  }

  const handleChange = (value: string) => {
    detach(
      setDefault(value as ModelProviderType, pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-base font-medium text-foreground">
        Default model provider
      </h3>
      <Card className="p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex flex-1 flex-col gap-1">
            <span className="text-sm font-medium text-foreground">
              Default model provider
            </span>
            <span className="text-sm text-muted-foreground">
              Choose the provider VM0 will use by default when running agents.
            </span>
          </div>
          <Select
            value={defaultProvider?.type ?? ""}
            onValueChange={handleChange}
          >
            <SelectTrigger className="w-full sm:w-[280px] shrink-0">
              <SelectValue placeholder="Select a default provider" />
            </SelectTrigger>
            <SelectContent>
              {providers.map((provider) => (
                <SelectItem key={provider.type} value={provider.type}>
                  <div className="flex items-center gap-2">
                    <ProviderIcon type={provider.type} size={16} />
                    <span>{getUILabel(provider.type)}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Card>
    </div>
  );
}
