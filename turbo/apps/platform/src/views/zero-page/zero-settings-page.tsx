import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLastResolved } from "ccstate-react";
import { IconPlus, IconDotsVertical } from "@tabler/icons-react";
import type { ModelProviderType } from "@vm0/core";
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
  addProviderDialogOpen$,
  setAddProviderDialogOpen$,
  configuredProviders$,
  defaultProvider$,
  setDefaultProvider$,
  openEditDialog$,
  openDeleteDialog$,
} from "../../signals/settings-page/model-providers.ts";
import { getUILabel } from "../settings-page/provider-ui-config.ts";
import { ProviderIcon } from "../settings-page/provider-icons.tsx";
import { AddProviderDialog } from "../settings-page/add-provider-dialog.tsx";
import { ProviderDialog } from "../settings-page/provider-dialog.tsx";
import { DeleteProviderDialog } from "../settings-page/delete-provider-dialog.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";

interface DummyProvider {
  type: ModelProviderType;
  label: string;
  configured: boolean;
}

export function ZeroSettingsPage() {
  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <header className="shrink-0 bg-transparent px-4 pt-10 pb-4 sm:px-6">
        <div className="mx-auto max-w-[900px] px-7">
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
        <div className="mx-auto max-w-[900px] px-7 flex flex-col gap-8">
          <ZeroDefaultProvider />
          <ZeroProviderList />
        </div>
      </main>

      <ProviderDialog />
      <DeleteProviderDialog />
    </div>
  );
}

function ZeroDefaultProvider() {
  const providers = useLastResolved(configuredProviders$);
  const defaultProvider = useLastResolved(defaultProvider$);
  const setDefault = useSet(setDefaultProvider$);
  const pageSignal = useGet(pageSignal$);

  const DUMMY_PROVIDERS: DummyProvider[] = [
    { type: "anthropic-api-key", label: "Anthropic API Key", configured: true },
    { type: "openrouter-api-key", label: "OpenRouter", configured: true },
    { type: "deepseek-api-key", label: "DeepSeek", configured: true },
  ];

  const realProviders = providers ?? [];
  const selectItems =
    realProviders.length > 0
      ? realProviders.map((p) => ({ type: p.type, label: getUILabel(p.type) }))
      : DUMMY_PROVIDERS.map((p) => ({ type: p.type, label: p.label }));

  const currentDefault = defaultProvider?.type ?? selectItems[0]?.type ?? "";

  const handleChange = (value: string) => {
    if (realProviders.length > 0) {
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
      <div className="flex flex-col rounded-[var(--zero-card-radius)] border border-[var(--zero-card-border)] bg-card shadow-[var(--zero-card-shadow)]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center px-5 py-4">
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <span className="text-sm font-medium text-foreground">
              Default provider
            </span>
            <span className="text-xs text-muted-foreground">
              The provider used by default when running agents.
            </span>
          </div>
          <Select value={currentDefault} onValueChange={handleChange}>
            <SelectTrigger className="w-full sm:w-[260px] h-9 shrink-0 rounded-lg border-border/70">
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
        </div>
      </div>
    </div>
  );
}

function ZeroProviderList() {
  const providers = useLastResolved(configuredProviders$);
  const addDialogOpen = useGet(addProviderDialogOpen$);
  const setAddDialogOpen = useSet(setAddProviderDialogOpen$);
  const openEdit = useSet(openEditDialog$);
  const openDelete = useSet(openDeleteDialog$);

  const DUMMY_PROVIDERS: DummyProvider[] = [
    { type: "anthropic-api-key", label: "Anthropic API Key", configured: true },
    { type: "openrouter-api-key", label: "OpenRouter", configured: true },
    { type: "deepseek-api-key", label: "DeepSeek", configured: true },
    { type: "moonshot-api-key", label: "Moonshot", configured: false },
  ];

  const removedTypes$ = useCCState<ModelProviderType[]>([]);
  const removedTypes = useGet(removedTypes$);
  const setRemovedTypes = useSet(removedTypes$);

  const realProviders = providers ?? [];
  const useReal = realProviders.length > 0;

  const displayItems = useReal
    ? realProviders.map((p) => ({
        type: p.type,
        label: getUILabel(p.type),
        configured: true,
        isReal: true,
        provider: p,
      }))
    : DUMMY_PROVIDERS.filter((p) => !removedTypes.includes(p.type)).map(
        (p) => ({
          type: p.type,
          label: p.label,
          configured: p.configured,
          isReal: false,
          provider: null,
        }),
      );

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-semibold tracking-tight text-foreground">
        Model providers
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* Add provider */}
        <button
          type="button"
          onClick={() => setAddDialogOpen(true)}
          className="flex flex-col rounded-[var(--zero-card-radius)] border border-dashed border-border/80 transition-colors hover:border-border hover:bg-muted/30 group"
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
          <div className="flex h-11 items-center border-t border-dashed border-border/80 px-5 group-hover:border-border">
            <span className="text-xs text-muted-foreground/70">
              Browse supported providers
            </span>
          </div>
        </button>

        {/* Provider cards */}
        {displayItems.map((item) => (
          <div
            key={item.type}
            className="flex flex-col rounded-[var(--zero-card-radius)] border border-[var(--zero-card-border)] bg-card shadow-[var(--zero-card-shadow)]"
          >
            <div className="flex h-14 items-center gap-2.5 px-5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                <ProviderIcon type={item.type} size={22} />
              </span>
              <span className="min-w-0 flex-1 text-sm font-medium text-foreground truncate">
                {item.label}
              </span>
            </div>

            <div className="flex h-11 items-center justify-between border-t border-border/50 pl-5 pr-2">
              <div className="flex items-center gap-2 min-w-0">
                {item.configured ? (
                  <span className="flex items-center gap-2 text-xs text-muted-foreground truncate">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                    Configured
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAddDialogOpen(true)}
                    className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                  >
                    Configure
                  </button>
                )}
              </div>
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
                  {item.configured && item.isReal && item.provider ? (
                    <>
                      <DropdownMenuItem onClick={() => openEdit(item.provider)}>
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => openDelete(item.type)}
                      >
                        Delete
                      </DropdownMenuItem>
                    </>
                  ) : item.configured ? (
                    <>
                      <DropdownMenuItem>Edit</DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive">
                        Delete
                      </DropdownMenuItem>
                    </>
                  ) : (
                    <DropdownMenuItem
                      onClick={() =>
                        setRemovedTypes((prev) =>
                          prev.includes(item.type)
                            ? prev
                            : [...prev, item.type],
                        )
                      }
                    >
                      Remove
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ))}
      </div>

      <AddProviderDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />
    </div>
  );
}
