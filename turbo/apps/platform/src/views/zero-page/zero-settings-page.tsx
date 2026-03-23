import { useGet, useSet, useLoadable } from "ccstate-react";
import { IconPlus, IconDotsVertical } from "@tabler/icons-react";
import { MODEL_PROVIDER_TYPES, type ModelProviderType } from "@vm0/core";
import {
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
} from "../../signals/zero-page/settings/org-model-providers.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { getUILabel } from "./components/settings/provider-ui-config.ts";
import { ProviderIcon } from "./components/settings/provider-icons.tsx";
import { OrgAddProviderDialog } from "./components/settings/org-add-provider-dialog.tsx";
import { OrgProviderDialog } from "./components/settings/org-provider-dialog.tsx";
import { OrgDeleteProviderDialog } from "./components/settings/org-delete-provider-dialog.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";

export function ZeroSettingsPage() {
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <header className="shrink-0 bg-transparent px-4 pt-10 pb-4 sm:px-6">
        <div className="mx-auto max-w-[900px]">
          <div className="flex items-center">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Settings
            </h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Configure model providers for your agents.
          </p>
        </div>
      </header>

      <main className="shrink-0 px-4 sm:px-6 pt-4 pb-16">
        <div className="mx-auto max-w-[900px] flex flex-col gap-8">
          {isAdmin && <ZeroOrgDefaultProvider />}
          <ZeroOrgProviderList isAdmin={isAdmin} />
        </div>
      </main>

      <OrgDeleteProviderDialog />
      <OrgProviderDialog />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Org default provider selector (admin only)
// ---------------------------------------------------------------------------

function ZeroOrgDefaultProvider() {
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

  const selectItems = providers.map((p) => ({
    type: p.type,
    label: getUILabel(p.type),
  }));
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
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-semibold tracking-tight text-foreground">
        Default model provider
      </h2>
      <div className="zero-card cursor-pointer">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center px-5 py-4">
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <span className="text-sm font-medium text-foreground">
              Default provider
            </span>
            <span className="text-sm text-muted-foreground">
              The default provider used by all members in this organization.
            </span>
          </div>
          {isLoading ? (
            <div className="w-full sm:w-[260px] h-9 shrink-0 rounded-lg bg-muted/50 animate-pulse" />
          ) : selectItems.length === 0 ? (
            <span className="text-sm text-muted-foreground">
              No providers configured
            </span>
          ) : (
            <Select value={currentDefault} onValueChange={handleChange}>
              <SelectTrigger className="zero-form-border w-full sm:w-[260px] h-9 shrink-0 rounded-lg">
                <SelectValue placeholder="Select a default provider" />
              </SelectTrigger>
              <SelectContent>
                {selectItems.map((item) => (
                  <SelectItem key={item.type} value={item.type}>
                    <div className="flex items-center gap-2">
                      <ProviderIcon type={item.type} size={16} />
                      <span>{item.label}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Org provider list
// ---------------------------------------------------------------------------

function ZeroOrgProviderList({ isAdmin }: { isAdmin: boolean }) {
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
      <h2 className="text-base font-semibold tracking-tight text-foreground">
        Model providers
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* Add provider — only for admins, hidden when all types configured */}
        {isAdmin && !allConfigured && (
          <button
            type="button"
            onClick={() => setAddDialogOpen(true)}
            className="flex flex-col rounded-[var(--zero-card-radius)] border border-dashed border-[hsl(var(--gray-400))] transition-colors hover:border-[hsl(var(--gray-400))] hover:bg-muted/30 group"
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
            <div className="flex h-11 items-center border-t border-dashed border-[hsl(var(--gray-400))] px-5 group-hover:border-[hsl(var(--gray-400))]">
              <span className="text-xs text-muted-foreground/70">
                Browse supported providers
              </span>
            </div>
          </button>
        )}

        {/* Skeleton cards while loading */}
        {isLoading && (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        )}

        {/* Real provider cards */}
        {!isLoading &&
          providers.map((p) => (
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
              className={`zero-card ${isAdmin ? "cursor-pointer" : ""}`}
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
                className="flex h-11 items-center justify-between border-t border-border/50 pl-5 pr-2"
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

        {/* Empty state for members */}
        {!isLoading && !isAdmin && providers.length === 0 && (
          <div className="col-span-full text-center py-8">
            <p className="text-sm text-muted-foreground">
              No organization providers have been configured yet. Contact your
              admin to set up model providers.
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

// ---------------------------------------------------------------------------
// Skeleton card — matches the real card dimensions
// ---------------------------------------------------------------------------

function SkeletonCard() {
  return (
    <div className="flex flex-col rounded-[var(--zero-card-radius)] border border-border/50 bg-card animate-pulse">
      <div className="flex h-14 items-center gap-2.5 px-5">
        <span className="h-7 w-7 shrink-0 rounded-lg bg-muted/50" />
        <span className="h-4 w-24 rounded bg-muted/50" />
      </div>
      <div className="flex h-11 items-center border-t border-border/30 px-5">
        <span className="h-3 w-16 rounded bg-muted/30" />
      </div>
    </div>
  );
}
