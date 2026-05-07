// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet, useLoadable } from "ccstate-react";
import { IconDotsVertical, IconPlus } from "@tabler/icons-react";
import {
  MODEL_PROVIDER_TYPES,
  type ModelProviderResponse,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
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
  personalAddProviderDialogOpen$,
  setPersonalAddProviderDialogOpen$,
  personalConfiguredProviders$,
  personalDefaultProvider$,
  personalSetDefaultProvider$,
  personalOpenEditDialog$,
  personalOpenDeleteDialog$,
  setCodexPasteDialogStatePersonal$,
} from "../../../../signals/zero-page/settings/personal-model-providers.ts";
import { getUILabel } from "../settings/provider-ui-config.ts";
import { ProviderIcon } from "../settings/provider-icons.tsx";
import { PersonalAddProviderDialog } from "../settings/personal-add-provider-dialog.tsx";
import { PersonalProviderDialog } from "../settings/personal-provider-dialog.tsx";
import { PersonalDeleteProviderDialog } from "../settings/personal-delete-provider-dialog.tsx";
import { PersonalCodexAuthPasteDialog } from "../settings/codex-auth-paste-dialog.tsx";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";

export function PersonalProvidersTab() {
  return (
    <div className="flex flex-col gap-8">
      <DefaultProviderSection />
      <StaleBannerSection />
      <ProviderListSection />
      <PersonalDeleteProviderDialog />
      <PersonalProviderDialog />
      <PersonalCodexAuthPasteDialog />
    </div>
  );
}

/**
 * Render the re-connect banner above the personal provider list when any
 * codex-oauth-token provider has flipped to needsReconnect=true (the
 * firewall refresh pipeline writes this on refresh failure). Mirrors the
 * org-side banner from `org-providers-tab.tsx` so personal + org have
 * identical recovery UX (#12024).
 */
function StaleBannerSection() {
  const providersLoadable = useLoadable(personalConfiguredProviders$);
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  return <StaleProviderBanner providers={providers} />;
}

function StaleProviderBanner({
  providers,
}: {
  providers: ModelProviderResponse[];
}) {
  const setPasteDialog = useSet(setCodexPasteDialogStatePersonal$);
  const stale = providers.find((p) => {
    return p.type === "codex-oauth-token" && p.needsReconnect;
  });
  if (!stale) {
    return null;
  }
  return (
    <section
      className="flex items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4"
      role="alert"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          ChatGPT session needs reconnection
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {staleMessage(stale.lastRefreshErrorCode)}
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          return setPasteDialog({ open: true, mode: "reconnect" });
        }}
        className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
      >
        Re-paste auth.json
      </button>
    </section>
  );
}

function staleMessage(code: string | null): string {
  switch (code) {
    case "refresh_token_expired": {
      return "Your ChatGPT session expired. Re-connect to continue.";
    }
    case "refresh_token_reused": {
      return "Your ChatGPT session was used elsewhere. Re-connect.";
    }
    case "refresh_token_invalidated": {
      return "Your ChatGPT session was revoked. Re-connect.";
    }
    default: {
      return "ChatGPT refresh failed. Re-connect to retry.";
    }
  }
}

function DefaultProviderSection() {
  const providersLoadable = useLoadable(personalConfiguredProviders$);
  const defaultProviderLoadable = useLoadable(personalDefaultProvider$);
  const setDefault = useSet(personalSetDefaultProvider$);
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
              Personal default
            </p>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              Used when you opt into your personal provider on an agent.
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

function ProviderListSection() {
  const providersLoadable = useLoadable(personalConfiguredProviders$);
  const addDialogOpen = useGet(personalAddProviderDialogOpen$);
  const setAddDialogOpen = useSet(setPersonalAddProviderDialogOpen$);
  const openEdit = useSet(personalOpenEditDialog$);
  const openDelete = useSet(personalOpenDeleteDialog$);

  const isLoading = providersLoadable.state === "loading";
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  const totalProviderTypes = Object.keys(MODEL_PROVIDER_TYPES).length;
  const allConfigured = !isLoading && providers.length >= totalProviderTypes;

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">
        Personal model providers
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {!allConfigured && (
          <button
            type="button"
            onClick={() => {
              return setAddDialogOpen(true);
            }}
            className="flex flex-col overflow-hidden transition-colors hover:bg-muted/30 group zero-border-dashed rounded-xl"
            data-testid="personal-add-provider-button"
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
                role="button"
                tabIndex={0}
                onClick={() => {
                  return openEdit(p);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openEdit(p);
                  }
                }}
                className={cn(
                  "overflow-hidden zero-card shadow-[var(--zero-card-shadow)] cursor-pointer",
                )}
                data-testid={`personal-provider-tile-${p.type}`}
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
                  onClick={(e) => {
                    return e.stopPropagation();
                  }}
                >
                  <span className="flex items-center gap-2 text-xs text-muted-foreground truncate">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                    Configured
                  </span>
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
                </div>
              </div>
            );
          })}
      </div>

      <PersonalAddProviderDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
      />
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
