// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet, useLoadable } from "ccstate-react";
import { IconPlus, IconDotsVertical } from "@tabler/icons-react";
import { MODEL_PROVIDER_TYPES, type ModelProviderType } from "@vm0/core";
import {
  cn,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@vm0/ui";
import {
  orgAddProviderDialogOpen$,
  setOrgAddProviderDialogOpen$,
  orgConfiguredProviders$,
  orgDefaultProvider$,
  orgSetDefaultProvider$,
  orgOpenEditDialog$,
  orgOpenDeleteDialog$,
} from "../../../../signals/zero-page/settings/org-model-providers.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import { getUILabel } from "../settings/provider-ui-config.ts";
import { ProviderIcon } from "../settings/provider-icons.tsx";
import { OrgAddProviderDialog } from "../settings/org-add-provider-dialog.tsx";
import { OrgProviderDialog } from "../settings/org-provider-dialog.tsx";
import { OrgDeleteProviderDialog } from "../settings/org-delete-provider-dialog.tsx";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";

export function OrgProvidersTab() {
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;

  return (
    <div className="flex flex-col gap-8">
      {isAdmin && <DefaultProviderSection />}
      <ProviderListSection isAdmin={isAdmin} />
      <OrgDeleteProviderDialog />
      <OrgProviderDialog />
    </div>
  );
}

function DefaultProviderSection() {
  const providersLoadable = useLoadable(orgConfiguredProviders$);
  const defaultProviderLoadable = useLoadable(orgDefaultProvider$);
  const setDefault = useSet(orgSetDefaultProvider$);
  const pageSignal = useGet(pageSignal$);

  const isLoading =
    providersLoadable.state === "loading" ||
    defaultProviderLoadable.state === "loading";
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  const defaultProvider =
    defaultProviderLoadable.state === "hasData"
      ? defaultProviderLoadable.data
      : null;

  const selectItems = providers.map((p) => {
    return {
      type: p.type,
      label: getUILabel(p.type),
    };
  });
  const currentDefault = defaultProvider?.type ?? selectItems[0]?.type ?? "";

  const handleChange = (value: string) => {
    if (providers.length > 0) {
      detach(
        setDefault(value as ModelProviderType, pageSignal),
        Reason.DomCallback,
      );
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Default</h3>
      <div
        className="overflow-hidden rounded-xl bg-card"
        style={{ border: "0.7px solid hsl(var(--gray-400))" }}
      >
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Default provider
            </p>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              Applied to all tasks across schedule, Slack, and web.
            </p>
          </div>
          {isLoading ? (
            <div className="w-[220px] h-9 shrink-0 rounded-lg bg-muted/50 animate-pulse" />
          ) : selectItems.length === 0 ? (
            <span className="text-sm text-muted-foreground shrink-0">
              No providers configured
            </span>
          ) : (
            <Select value={currentDefault} onValueChange={handleChange}>
              <SelectTrigger
                className="w-[280px] h-9 shrink-0 rounded-lg"
                style={{ border: "0.7px solid hsl(var(--gray-400))" }}
              >
                <SelectValue placeholder="Select a default provider" />
              </SelectTrigger>
              <SelectContent>
                {selectItems.map((item) => {
                  return (
                    <SelectItem key={item.type} value={item.type}>
                      <div className="flex items-center gap-2">
                        <ProviderIcon type={item.type} size={16} />
                        <span>{item.label}</span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
    </section>
  );
}

function ProviderListSection({ isAdmin }: { isAdmin: boolean }) {
  const providersLoadable = useLoadable(orgConfiguredProviders$);
  const addDialogOpen = useGet(orgAddProviderDialogOpen$);
  const setAddDialogOpen = useSet(setOrgAddProviderDialogOpen$);
  const openEdit = useSet(orgOpenEditDialog$);
  const openDelete = useSet(orgOpenDeleteDialog$);

  const isLoading = providersLoadable.state === "loading";
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  const totalProviderTypes = Object.keys(MODEL_PROVIDER_TYPES).length;
  const allConfigured = !isLoading && providers.length >= totalProviderTypes;

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Model providers</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {isAdmin && !allConfigured && (
          <button
            type="button"
            onClick={() => {
              return setAddDialogOpen(true);
            }}
            className="flex flex-col overflow-hidden transition-colors hover:bg-muted/30 group zero-border-dashed rounded-xl"
          >
            <div className="flex h-14 items-center gap-2.5 px-5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                <IconPlus
                  size={18}
                  stroke={2}
                  className="text-muted-foreground group-hover:text-foreground"
                />
              </span>
              <span className="text-sm font-medium text-muted-foreground group-hover:text-foreground">
                Add provider
              </span>
            </div>
            <div className="flex h-11 items-center px-5 zero-border-dashed-t">
              <span className="text-xs text-muted-foreground/70">
                Browse supported providers
              </span>
            </div>
          </button>
        )}

        {isLoading && (
          <>
            <ProviderSkeleton />
            <ProviderSkeleton />
          </>
        )}

        {!isLoading &&
          providers.map((p) => {
            return (
              <div
                key={p.type}
                role={isAdmin ? "button" : undefined}
                tabIndex={isAdmin ? 0 : undefined}
                onClick={
                  isAdmin
                    ? () => {
                        return openEdit(p);
                      }
                    : undefined
                }
                onKeyDown={
                  isAdmin
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openEdit(p);
                        }
                      }
                    : undefined
                }
                className={cn(
                  "overflow-hidden zero-card shadow-[var(--zero-card-shadow)]",
                  isAdmin && "cursor-pointer",
                )}
              >
                <div className="flex h-14 items-center gap-2.5 px-5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                    <ProviderIcon type={p.type} size={22} />
                  </span>
                  <span className="min-w-0 flex-1 text-sm font-medium text-foreground truncate">
                    {getUILabel(p.type)}
                  </span>
                </div>
                <div
                  className="flex h-11 items-center justify-between pl-5 pr-2 zero-border-t"
                  onClick={
                    isAdmin
                      ? (e) => {
                          return e.stopPropagation();
                        }
                      : undefined
                  }
                >
                  <span className="flex items-center gap-2 text-xs text-muted-foreground truncate">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                    Configured
                  </span>
                  {isAdmin && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                          aria-label="More options"
                        >
                          <IconDotsVertical size={14} stroke={1.5} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem
                          onClick={() => {
                            return openEdit(p);
                          }}
                        >
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => {
                            return openDelete(p.type);
                          }}
                        >
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
            );
          })}

        {!isLoading && !isAdmin && providers.length === 0 && (
          <div className="col-span-full text-center py-8">
            <p className="text-sm text-muted-foreground">
              No providers configured yet. Contact your admin.
            </p>
          </div>
        )}
      </div>

      {isAdmin && (
        <OrgAddProviderDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
        />
      )}
    </div>
  );
}

function ProviderSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden bg-card animate-pulse zero-border rounded-xl">
      <div className="flex h-14 items-center gap-2.5 px-5">
        <span className="h-7 w-7 shrink-0 rounded-lg bg-muted/50" />
        <span className="h-4 w-24 rounded bg-muted/50" />
      </div>
      <div className="flex h-11 items-center px-5 zero-border-t">
        <span className="h-3 w-16 rounded bg-muted/30" />
      </div>
    </div>
  );
}
