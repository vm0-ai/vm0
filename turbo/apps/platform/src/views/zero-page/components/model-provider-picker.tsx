import type React from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  cn,
} from "@vm0/ui";
import {
  areProvidersCompatible,
  getModelDisplayName,
  getModels,
  MODEL_PROVIDER_TYPES,
  type ModelProviderResponse,
  type ModelProviderType,
} from "@vm0/core";
import {
  getUILabel,
  getVm0ModelMultiplier,
} from "./settings/provider-ui-config";

export interface ModelProviderSelection {
  modelProviderId: string;
  selectedModel: string;
}

interface ModelProviderPickerProps {
  providers: ModelProviderResponse[];
  value: ModelProviderSelection | null;
  onChange: (value: ModelProviderSelection | null) => void;
  placeholder?: string;
  /**
   * Classes applied to the SelectTrigger. Defaults to `h-9 w-full`. The
   * composer passes an auto-width, compact variant to fit next to Send.
   */
  triggerClassName?: string;
  /**
   * Provider type of the active session's first run. When set, any picker
   * option whose provider type is incompatible (different base URL) is
   * disabled — switching mid-session would break continuity. See
   * `areProvidersCompatible`.
   */
  sessionProviderType?: ModelProviderType | null;
  /**
   * When true, the trigger shows only the friendly model name (no provider
   * label, no multiplier badge). Used by the chat composer where horizontal
   * space is tight and the full breakdown lives in the open dropdown.
   */
  compactTrigger?: boolean;
}

// Radix Select reserves the empty string for "no value" and throws if a
// SelectItem uses it, so use a sentinel to represent the inherit option.
const INHERIT_SENTINEL = "__inherit_default__";

function encodeValue(v: ModelProviderSelection | null): string {
  return v ? `${v.modelProviderId}::${v.selectedModel}` : INHERIT_SENTINEL;
}

function decodeValue(s: string): ModelProviderSelection | null {
  if (s === INHERIT_SENTINEL) {
    return null;
  }
  const idx = s.indexOf("::");
  return {
    modelProviderId: s.slice(0, idx),
    selectedModel: s.slice(idx + 2),
  };
}

function formatMultiplier(multiplier: number): string {
  return `${multiplier}x`;
}

interface TriggerLabelProps {
  providers: ModelProviderResponse[];
  value: ModelProviderSelection | null;
  placeholder: string;
  compact: boolean;
}

function TriggerLabel({
  providers,
  value,
  placeholder,
  compact,
}: TriggerLabelProps) {
  if (!value) {
    return <span>{placeholder}</span>;
  }
  const displayName = getModelDisplayName(value.selectedModel);
  if (compact) {
    return <span className="truncate">{displayName}</span>;
  }
  const provider = providers.find((p) => {
    return p.id === value.modelProviderId;
  });
  if (!provider) {
    return <span>{displayName}</span>;
  }
  const multiplier =
    provider.type === "vm0"
      ? getVm0ModelMultiplier(value.selectedModel)
      : undefined;
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="truncate">{displayName}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        · {getUILabel(provider.type)}
      </span>
      {multiplier !== undefined && (
        <span className="shrink-0 rounded border border-border/60 bg-muted/50 px-1 text-[10px] font-medium tabular-nums text-muted-foreground">
          {formatMultiplier(multiplier)}
        </span>
      )}
    </span>
  );
}

export function ModelProviderPicker({
  providers,
  value,
  onChange,
  placeholder = "Inherit from org default",
  triggerClassName,
  sessionProviderType,
  compactTrigger = false,
}: ModelProviderPickerProps) {
  const groups = providers
    .map((provider) => {
      const typeConfig = MODEL_PROVIDER_TYPES[provider.type];
      if (!typeConfig) {
        return null;
      }
      const models = getModels(provider.type);
      if (!models || models.length === 0) {
        return null;
      }
      const incompatible = sessionProviderType
        ? !areProvidersCompatible(provider.type, sessionProviderType)
        : false;
      return {
        provider,
        label: getUILabel(provider.type),
        models,
        isVm0: provider.type === "vm0",
        incompatible,
      };
    })
    .filter((g): g is NonNullable<typeof g> => {
      return g !== null;
    })
    .sort((a, b) => {
      // Surface the VM0 Managed group first — it's the recommended option
      // and the only one showing the credit multiplier.
      if (a.isVm0 === b.isVm0) {
        return 0;
      }
      return a.isVm0 ? -1 : 1;
    });

  return (
    <Select
      value={encodeValue(value)}
      onValueChange={(raw) => {
        onChange(decodeValue(raw));
      }}
    >
      <SelectTrigger className={cn("h-9 w-full", triggerClassName)}>
        <SelectValue
          placeholder={placeholder}
          aria-label={
            value ? getModelDisplayName(value.selectedModel) : placeholder
          }
        >
          <TriggerLabel
            providers={providers}
            value={value}
            placeholder={placeholder}
            compact={compactTrigger}
          />
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={INHERIT_SENTINEL}>{placeholder}</SelectItem>
        {groups.length > 0 && <SelectSeparator key="sep-inherit" />}
        {groups.flatMap((group, idx) => {
          const rendered: React.ReactNode[] = [
            <SelectGroup key={group.provider.id}>
              <SelectLabel className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label}
                {group.incompatible && (
                  <span className="ml-1.5 font-normal normal-case text-[10px] text-muted-foreground/80">
                    (incompatible with current session)
                  </span>
                )}
              </SelectLabel>
              {group.models.map((model) => {
                const multiplier = group.isVm0
                  ? getVm0ModelMultiplier(model)
                  : undefined;
                return (
                  <SelectItem
                    key={`${group.provider.id}::${model}`}
                    value={`${group.provider.id}::${model}`}
                    disabled={group.incompatible}
                  >
                    <span className="flex items-center justify-between gap-3 w-full">
                      <span className="truncate">
                        {getModelDisplayName(model)}
                      </span>
                      {multiplier !== undefined && (
                        <span className="shrink-0 rounded border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                          {formatMultiplier(multiplier)}
                        </span>
                      )}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectGroup>,
          ];
          if (idx < groups.length - 1) {
            rendered.push(<SelectSeparator key={`sep-${group.provider.id}`} />);
          }
          return rendered;
        })}
      </SelectContent>
    </Select>
  );
}
