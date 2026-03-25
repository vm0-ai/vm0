import { useGet, useSet, useLoadable } from "ccstate-react";
import { IconPlus, IconDotsVertical } from "@tabler/icons-react";
import { MODEL_PROVIDER_TYPES } from "@vm0/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@vm0/ui";
import {
  orgAddProviderDialogOpen$,
  setOrgAddProviderDialogOpen$,
  orgConfiguredProviders$,
  orgOpenEditDialog$,
  orgOpenDeleteDialog$,
} from "../../../../signals/zero-page/settings/org-model-providers.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import { getUILabel } from "../settings/provider-ui-config.ts";
import { ProviderIcon } from "../settings/provider-icons.tsx";
import { OrgAddProviderDialog } from "../settings/org-add-provider-dialog.tsx";
import { OrgProviderDialog } from "../settings/org-provider-dialog.tsx";
import { OrgDeleteProviderDialog } from "../settings/org-delete-provider-dialog.tsx";

export function OrgProvidersTab() {
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;

  return (
    <div className="flex flex-col gap-8">
      <ProviderListSection isAdmin={isAdmin} />
      <OrgDeleteProviderDialog />
      <OrgProviderDialog />
    </div>
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
            onClick={() => setAddDialogOpen(true)}
            className="flex flex-col transition-colors hover:bg-muted/30 group"
            style={{
              border: "0.7px dashed hsl(var(--gray-400))",
              borderRadius: "0.75rem",
              boxShadow:
                "0 1px 1px hsl(220 12% 20% / 0.02), 0 2px 8px hsl(220 12% 20% / 0.025), 0 8px 24px hsl(220 12% 20% / 0.02)",
            }}
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
            <div
              className="flex h-11 items-center px-5"
              style={{ borderTop: "0.7px dashed hsl(var(--gray-400))" }}
            >
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
          providers
            .filter((p) => p.type !== "vm0")
            .map((p) => (
              <div
                key={p.type}
                role={isAdmin ? "button" : undefined}
                tabIndex={isAdmin ? 0 : undefined}
                onClick={isAdmin ? () => openEdit(p) : undefined}
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
                className={isAdmin ? "cursor-pointer" : ""}
                style={{
                  border: "0.7px solid hsl(var(--gray-400))",
                  borderRadius: "0.75rem",
                  backgroundColor: "hsl(var(--card))",
                  boxShadow:
                    "0 1px 1px hsl(220 12% 20% / 0.02), 0 2px 8px hsl(220 12% 20% / 0.025), 0 8px 24px hsl(220 12% 20% / 0.02)",
                }}
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
                  className="flex h-11 items-center justify-between pl-5 pr-2"
                  style={{ borderTop: "0.7px solid hsl(var(--gray-400))" }}
                  onClick={isAdmin ? (e) => e.stopPropagation() : undefined}
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
                        <DropdownMenuItem onClick={() => openEdit(p)}>
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => openDelete(p.type)}
                        >
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
            ))}

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
    <div
      className="flex flex-col bg-card animate-pulse"
      style={{
        border: "0.7px solid hsl(var(--gray-400))",
        borderRadius: "0.75rem",
      }}
    >
      <div className="flex h-14 items-center gap-2.5 px-5">
        <span className="h-7 w-7 shrink-0 rounded-lg bg-muted/50" />
        <span className="h-4 w-24 rounded bg-muted/50" />
      </div>
      <div
        className="flex h-11 items-center px-5"
        style={{ borderTop: "0.7px solid hsl(var(--gray-400))" }}
      >
        <span className="h-3 w-16 rounded bg-muted/30" />
      </div>
    </div>
  );
}
