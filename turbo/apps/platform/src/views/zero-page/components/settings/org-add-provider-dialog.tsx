import { useLastResolved, useSet } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { getSelectableProviderTypes, type ModelProviderType } from "@vm0/core";
import {
  orgConfiguredProviders$,
  orgOpenAddDialog$,
} from "../../../../signals/zero-page/settings/org-model-providers.ts";
import { getUILabel, getUIDescription } from "./provider-ui-config.ts";
import { ProviderIcon } from "./provider-icons.tsx";

function getProviderTypes(): ModelProviderType[] {
  return getSelectableProviderTypes();
}

function ProviderCardInDialog({
  type,
  onAdd,
}: {
  type: ModelProviderType;
  onAdd: () => void;
}) {
  const label = getUILabel(type);
  const description = getUIDescription(type);

  return (
    <button
      type="button"
      onClick={onAdd}
      className="flex flex-col gap-3 rounded-xl zero-border bg-card p-4 text-left transition-colors hover:bg-muted/50"
      data-testid={`org-provider-card-${type}`}
    >
      <div className="flex items-center gap-3">
        <div className="shrink-0">
          <ProviderIcon type={type} size={28} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground truncate">
            {label}
          </div>
        </div>
      </div>
      {description && (
        <div className="text-xs text-muted-foreground line-clamp-2">
          {description}
        </div>
      )}
      <div className="mt-auto">
        <span className="w-full h-8 rounded-lg zero-chip px-3 text-sm font-medium text-foreground transition-colors text-center flex items-center justify-center">
          Add
        </span>
      </div>
    </button>
  );
}

export function OrgAddProviderDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const configuredProviders = useLastResolved(orgConfiguredProviders$);
  const openAdd = useSet(orgOpenAddDialog$);
  const configuredSet = new Set(
    configuredProviders?.map((p) => {
      return p.type;
    }) ?? [],
  );

  const handleAdd = (type: ModelProviderType) => {
    openAdd(type);
  };

  const availableTypes = getProviderTypes().filter((type) => {
    return !configuredSet.has(type);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden pr-0 pb-0">
        <DialogHeader>
          <DialogTitle>Add workspace model provider</DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="pt-4 pb-6 pr-6">
            {availableTypes.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                All providers have been configured.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {availableTypes.map((type) => {
                  return (
                    <ProviderCardInDialog
                      key={type}
                      type={type}
                      onAdd={() => {
                        return handleAdd(type);
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
