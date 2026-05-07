import type { MouseEvent, ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { IconCpu } from "@tabler/icons-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@vm0/ui";
import {
  areProvidersCompatible,
  getDefaultModel,
  getModels,
  MODEL_PROVIDER_TYPES,
  VM0_MODEL_TO_PROVIDER,
  type ModelProviderResponse,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { getModelDisplayName } from "@vm0/core/model-display-name";
import {
  showAllVm0Models$,
  toggleShowAllVm0Models$,
} from "../../../signals/zero-page/model-picker-ui";
import {
  getUILabel,
  getVm0ModelMultiplier,
  isVm0PrimaryModel,
} from "./settings/provider-ui-config";
import { ProviderIcon } from "./settings/provider-icons";

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
  /**
   * When true, the trigger renders as a provider icon on mobile while keeping
   * the normal label on larger screens.
   */
  mobileIconTrigger?: boolean;
  /** Controlled open state for programmatic toggle (e.g. keyboard shortcut). */
  open?: boolean;
  /** Callback when the open state changes. */
  onOpenChange?: (open: boolean) => void;
  // When true, picker is read-only (e.g. existing chat thread).
  disabled?: boolean;
  /**
   * The agent-level default model. When set, a "Default" tag is shown next
   * to the matching model in the dropdown.
   */
  agentDefault?: ModelProviderSelection | null;
  /**
   * Override the label shown in the "Use default" toggle row.
   * Defaults to the auto-detected source ("agent" or "workspace").
   * Chat and schedule pickers should pass `"agent"` since they
   * always inherit from the agent level regardless of whether
   * the agent itself falls back to workspace.
   */
  inheritLabel?: "agent" | "workspace";
  /**
   * Per-provider tier annotation (Wave 3 of Epic #11868). When provided,
   * the picker groups items into "Personal" and "Org" sections with
   * personal first, and shows distinct default badges ("Your default"
   * for personal-tier rows vs "Workspace default" for org-tier rows).
   *
   * The "workspace default" anchor for the inherit toggle is filtered to
   * org-tier rows when this map is set — the personal default is a
   * separate concept that the user picks explicitly via the personal
   * section, not via inheritance.
   *
   * Omitted by settings / schedule editor consumers (they pass org-only
   * lists and never need tier sectioning) — falls back to today's flat
   * per-type grouping with no behavior change.
   */
  tiers?: Map<string, "personal" | "org">;
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
  return `×${multiplier}`;
}

function MultiplierBadge({ multiplier }: { multiplier: number }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 cursor-help text-xs tabular-nums text-muted-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:decoration-muted-foreground">
            {formatMultiplier(multiplier)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Credit cost multiplier
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type DefaultSource = "agent" | "workspace";

/**
 * Resolve the effective default model: agent override → workspace default.
 * The source is "agent" only when the agent itself specifies a default;
 * any fallback to workspace is labeled "workspace", so the dropdown never
 * tells users an inherited workspace default is "Agent default".
 */
function resolveEffectiveDefault(
  agentDefault: ModelProviderSelection | null | undefined,
  providers: ModelProviderResponse[],
): {
  effectiveDefault: ModelProviderSelection | null;
  defaultSource: DefaultSource;
} {
  if (agentDefault) {
    return { effectiveDefault: agentDefault, defaultSource: "agent" };
  }
  const wsDefault = providers.find((p) => {
    return p.isDefault;
  });
  if (!wsDefault) {
    return { effectiveDefault: null, defaultSource: "workspace" };
  }
  const model = wsDefault.selectedModel ?? getDefaultModel(wsDefault.type);
  if (!model) {
    return { effectiveDefault: null, defaultSource: "workspace" };
  }
  return {
    effectiveDefault: { modelProviderId: wsDefault.id, selectedModel: model },
    defaultSource: "workspace",
  };
}

function InheritToggleRow({
  effectiveDefault,
  defaultSource,
  providers,
  isInheriting,
  onToggle,
}: {
  effectiveDefault: ModelProviderSelection | null;
  defaultSource: DefaultSource;
  providers: ModelProviderResponse[];
  isInheriting: boolean;
  onToggle: (inherit: boolean) => void;
}) {
  const sourceLabel = defaultSource === "agent" ? "agent" : "workspace";
  const defaultProvider = effectiveDefault
    ? providers.find((p) => {
        return p.id === effectiveDefault.modelProviderId;
      })
    : undefined;
  const multiplier =
    effectiveDefault && defaultProvider?.type === "vm0"
      ? getVm0ModelMultiplier(effectiveDefault.selectedModel)
      : undefined;
  return (
    <>
      {/*
       * Radix `<Select>` validates that the controlled `value` matches a
       * registered `<SelectItem>`; otherwise it falls back to the placeholder
       * and logs a warning. We drive the Select with `encodeValue(value)` —
       * which returns `INHERIT_SENTINEL` when the caller inherits — but the
       * inherit affordance is a non-item `<div>` with a `<Switch>` (a normal
       * `<SelectItem>` here would close the menu on click, breaking the UX).
       *
       * This hidden `<SelectItem>` registers the sentinel so Radix accepts it
       * as a valid value. `hidden absolute` keeps it out of the layout and
       * keyboard focus while still being a mounted descendant of
       * `<SelectContent>`. See Radix issue radix-ui/primitives#2090 for the
       * long-standing request to allow non-item rows inside `SelectContent`.
       */}
      <SelectItem value={INHERIT_SENTINEL} className="hidden absolute">
        Use {sourceLabel} default
      </SelectItem>
      <div
        className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm cursor-pointer hover:bg-accent transition-colors"
        onClick={(e) => {
          e.preventDefault();
          onToggle(!isInheriting);
        }}
      >
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="font-medium text-foreground">
            Use {sourceLabel} default
          </span>
          {effectiveDefault && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="truncate">
                {getModelDisplayName(effectiveDefault.selectedModel)}
              </span>
              {multiplier !== undefined && (
                <MultiplierBadge multiplier={multiplier} />
              )}
            </span>
          )}
        </div>
        <Switch
          size="sm"
          checked={isInheriting}
          onCheckedChange={onToggle}
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
          }}
          aria-label={`Use ${sourceLabel} default model`}
        />
      </div>
    </>
  );
}

interface TriggerLabelProps {
  providers: ModelProviderResponse[];
  value: ModelProviderSelection | null;
  effectiveDefault: ModelProviderSelection | null;
  placeholder: string;
  compact: boolean;
  mobileIcon: boolean;
}

function TriggerLabel({
  providers,
  value,
  effectiveDefault,
  placeholder,
  compact,
  mobileIcon,
}: TriggerLabelProps) {
  // When no explicit value, show the effective default model name
  const resolved = value ?? effectiveDefault;
  if (!resolved) {
    return (
      <ResponsiveTriggerContent
        mobileIcon={mobileIcon}
        iconType={undefined}
        label={<span>{placeholder}</span>}
      />
    );
  }
  const displayName = getModelDisplayName(resolved.selectedModel);
  const provider = providers.find((p) => {
    return p.id === resolved.modelProviderId;
  });
  const iconType = resolveIconType(provider, resolved.selectedModel);
  if (compact) {
    return (
      <ResponsiveTriggerContent
        mobileIcon={mobileIcon}
        iconType={iconType}
        label={<span className="truncate">{displayName}</span>}
      />
    );
  }
  if (!provider) {
    return (
      <ResponsiveTriggerContent
        mobileIcon={mobileIcon}
        iconType={undefined}
        label={<span>{displayName}</span>}
      />
    );
  }
  const multiplier =
    provider.type === "vm0"
      ? getVm0ModelMultiplier(resolved.selectedModel)
      : undefined;
  const label = (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="truncate">{displayName}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        · {getUILabel(provider.type)}
      </span>
      {multiplier !== undefined && <MultiplierBadge multiplier={multiplier} />}
    </span>
  );
  return (
    <ResponsiveTriggerContent
      mobileIcon={mobileIcon}
      iconType={iconType}
      label={label}
    />
  );
}

function resolveIconType(
  provider: ModelProviderResponse | undefined,
  model: string | undefined,
): ModelProviderType | undefined {
  if (!provider) {
    return undefined;
  }
  if (provider.type === "vm0" && model) {
    const entry = VM0_MODEL_TO_PROVIDER[model];
    if (entry) {
      return entry.concreteType as ModelProviderType;
    }
  }
  return provider.type;
}

function ResponsiveTriggerContent({
  mobileIcon,
  iconType,
  label,
}: {
  mobileIcon: boolean;
  iconType: ModelProviderType | undefined;
  label: ReactNode;
}) {
  if (!mobileIcon) {
    return label;
  }
  return (
    <span className="flex items-center min-w-0">
      <span className="flex items-center justify-center sm:hidden">
        {iconType ? (
          <ProviderIcon type={iconType} size={18} />
        ) : (
          <IconCpu size={18} stroke={1.5} />
        )}
      </span>
      <span className="hidden min-w-0 sm:inline-flex sm:items-center sm:gap-1.5">
        {iconType && <ProviderIcon type={iconType} size={16} />}
        {label}
      </span>
    </span>
  );
}

// Read-only span reuses the trigger's geometry classes but must not echo
// its interactive affordances (hover/focus/open-state), so callers don't
// have to branch their className for the disabled case.
function stripInteractiveClasses(cls: string | undefined): string | undefined {
  if (!cls) {
    return cls;
  }
  return cls
    .split(/\s+/)
    .filter((c) => {
      return (
        !c.startsWith("hover:") &&
        !c.startsWith("focus:") &&
        !c.startsWith("data-[state=")
      );
    })
    .join(" ");
}

function DisabledPickerLabel({
  providers,
  value,
  placeholder,
  compactTrigger,
  mobileIconTrigger,
  triggerClassName,
  agentDefault,
}: Pick<
  ModelProviderPickerProps,
  | "providers"
  | "value"
  | "placeholder"
  | "compactTrigger"
  | "mobileIconTrigger"
  | "triggerClassName"
  | "agentDefault"
> & {
  placeholder: string;
  compactTrigger: boolean;
  mobileIconTrigger: boolean;
}) {
  const { effectiveDefault } = resolveEffectiveDefault(agentDefault, providers);
  const resolved = value ?? effectiveDefault;
  const triggerAriaLabel = resolved
    ? getModelDisplayName(resolved.selectedModel)
    : placeholder;
  return (
    <span
      aria-label={triggerAriaLabel}
      className={cn(
        "inline-flex items-center px-2 text-sm text-muted-foreground cursor-default",
        stripInteractiveClasses(triggerClassName),
      )}
    >
      <TriggerLabel
        providers={providers}
        value={value}
        effectiveDefault={effectiveDefault}
        placeholder={placeholder}
        compact={compactTrigger}
        mobileIcon={mobileIconTrigger}
      />
    </span>
  );
}

interface ProviderGroup {
  provider: ModelProviderResponse;
  label: string;
  models: readonly string[];
  isVm0: boolean;
  incompatible: boolean;
}

function buildProviderGroups(
  providers: ModelProviderResponse[],
  sessionProviderType: ModelProviderType | null | undefined,
): ProviderGroup[] {
  return providers
    .map((provider): ProviderGroup | null => {
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
    .filter((g): g is ProviderGroup => {
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
}

function ShowMoreToggleRow({
  expanded,
  hiddenCount,
  onToggle,
}: {
  expanded: boolean;
  hiddenCount: number;
  onToggle: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      className="rounded-md px-2 py-1.5 text-sm text-muted-foreground cursor-pointer hover:bg-accent transition-colors"
      onClick={(e) => {
        e.preventDefault();
        onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      {expanded ? "Show fewer models" : `Show all models (+${hiddenCount})`}
    </div>
  );
}

interface RenderProviderGroupContext {
  idx: number;
  last: number;
  selectedModel: string | null;
  showAll: boolean;
  onToggleShowAll: () => void;
  /**
   * Tier of this provider's row (Wave 3, Epic #11868). When set, the row
   * shows a tier-specific default badge (`"Your default"` vs `"Workspace
   * default"`) when the provider is its tier's default. Omitted for the
   * legacy flat-list render, which kept no per-row default indicator.
   */
  tier?: "personal" | "org";
}

function DefaultBadge({ tier }: { tier: "personal" | "org" }) {
  const text = tier === "personal" ? "Your default" : "Workspace default";
  return (
    <span className="ml-1.5 shrink-0 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {text}
    </span>
  );
}

function renderProviderGroup(
  group: ProviderGroup,
  ctx: RenderProviderGroupContext,
): ReactNode[] {
  const { idx, last, selectedModel, showAll, onToggleShowAll, tier } = ctx;
  // Only the VM0 group is collapsible — BYOK groups list a handful of models.
  const collapsible = group.isVm0;
  const visibleModels =
    collapsible && !showAll
      ? group.models.filter((m) => {
          return isVm0PrimaryModel(m) || m === selectedModel;
        })
      : group.models;
  const hiddenCount = group.models.length - visibleModels.length;
  // Default badge shows on the row matching the provider's selectedModel
  // (or the type's default when selectedModel is unset). Only fires when
  // tier-aware so legacy callers (settings / schedule editors) keep
  // their no-badge behavior.
  const defaultRowModel =
    tier && group.provider.isDefault
      ? (group.provider.selectedModel ?? getDefaultModel(group.provider.type))
      : null;
  const rendered: ReactNode[] = [
    <SelectGroup key={group.provider.id}>
      <SelectLabel className="pl-2 pr-8 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
        {group.label}
        {group.incompatible && (
          <span className="ml-1.5 font-normal normal-case text-[10px] text-muted-foreground/80">
            (incompatible with current session)
          </span>
        )}
      </SelectLabel>
      {visibleModels.map((model) => {
        const multiplier = group.isVm0
          ? getVm0ModelMultiplier(model)
          : undefined;
        const isDefaultRow = tier !== undefined && model === defaultRowModel;
        return (
          <SelectItem
            key={`${group.provider.id}::${model}`}
            value={`${group.provider.id}::${model}`}
            disabled={group.incompatible}
          >
            <span className="inline-flex items-baseline gap-1.5">
              <span>{getModelDisplayName(model)}</span>
              {multiplier !== undefined && (
                <MultiplierBadge multiplier={multiplier} />
              )}
              {isDefaultRow && tier && <DefaultBadge tier={tier} />}
            </span>
          </SelectItem>
        );
      })}
      {collapsible && (showAll || hiddenCount > 0) && (
        <ShowMoreToggleRow
          expanded={showAll}
          hiddenCount={hiddenCount}
          onToggle={onToggleShowAll}
        />
      )}
    </SelectGroup>,
  ];
  if (idx < last) {
    rendered.push(<SelectSeparator key={`sep-${group.provider.id}`} />);
  }
  return rendered;
}

function partitionGroupsByTier(
  groups: ProviderGroup[],
  tiers: Map<string, "personal" | "org">,
): { personal: ProviderGroup[]; org: ProviderGroup[] } {
  const personal: ProviderGroup[] = [];
  const org: ProviderGroup[] = [];
  for (const group of groups) {
    const tier = tiers.get(group.provider.id) ?? "org";
    if (tier === "personal") {
      personal.push(group);
    } else {
      org.push(group);
    }
  }
  return { personal, org };
}

function TierSectionHeader({ tier }: { tier: "personal" | "org" }) {
  return (
    <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">
      {tier === "personal" ? "Personal" : "Workspace"}
    </div>
  );
}

function renderTieredSections(
  groups: ProviderGroup[],
  tiers: Map<string, "personal" | "org">,
  ctx: Omit<RenderProviderGroupContext, "idx" | "last" | "tier">,
): ReactNode[] {
  const { personal, org } = partitionGroupsByTier(groups, tiers);
  const out: ReactNode[] = [];
  if (personal.length > 0) {
    out.push(
      <TierSectionHeader key="tier-personal" tier="personal" />,
      ...personal.flatMap((group, idx) => {
        return renderProviderGroup(group, {
          ...ctx,
          idx,
          last: personal.length - 1,
          tier: "personal",
        });
      }),
    );
  }
  if (org.length > 0) {
    if (personal.length > 0) {
      out.push(<SelectSeparator key="sep-tier-boundary" />);
    }
    out.push(
      <TierSectionHeader key="tier-org" tier="org" />,
      ...org.flatMap((group, idx) => {
        return renderProviderGroup(group, {
          ...ctx,
          idx,
          last: org.length - 1,
          tier: "org",
        });
      }),
    );
  }
  return out;
}

function ModelSelectDropdown({
  groups,
  value,
  effectiveDefault,
  defaultSource,
  providers,
  placeholder,
  triggerClassName,
  compactTrigger,
  mobileIconTrigger,
  onChange,
  open,
  onOpenChange,
  showUseDefault,
  tiers,
}: {
  groups: ProviderGroup[];
  value: ModelProviderSelection | null;
  effectiveDefault: ModelProviderSelection | null;
  defaultSource: DefaultSource;
  providers: ModelProviderResponse[];
  placeholder: string;
  triggerClassName: string | undefined;
  compactTrigger: boolean;
  mobileIconTrigger: boolean;
  onChange: (value: ModelProviderSelection | null) => void;
  open: boolean | undefined;
  onOpenChange: ((open: boolean) => void) | undefined;
  showUseDefault: boolean;
  tiers: Map<string, "personal" | "org"> | undefined;
}) {
  const resolved = value ?? effectiveDefault;
  const triggerAriaLabel = resolved
    ? getModelDisplayName(resolved.selectedModel)
    : placeholder;
  const lastGroupIdx = groups.length - 1;
  const showAll = useGet(showAllVm0Models$);
  const toggleShowAll = useSet(toggleShowAllVm0Models$);
  return (
    <Select
      value={encodeValue(value)}
      onValueChange={(raw) => {
        onChange(decodeValue(raw));
      }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <SelectTrigger
        aria-label={triggerAriaLabel}
        className={cn("h-9 w-full", triggerClassName)}
      >
        <SelectValue placeholder={placeholder}>
          <TriggerLabel
            providers={providers}
            value={value}
            effectiveDefault={effectiveDefault}
            placeholder={placeholder}
            compact={compactTrigger}
            mobileIcon={mobileIconTrigger}
          />
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="max-h-[280px] min-w-[260px]">
        {showUseDefault && (
          <InheritToggleRow
            effectiveDefault={effectiveDefault}
            defaultSource={defaultSource}
            providers={providers}
            isInheriting={value === null}
            onToggle={(inherit) => {
              if (inherit) {
                onChange(null);
                // Close dropdown — user is done (reverted to default).
                // No-op for uncontrolled callers; they dismiss via click-outside.
                onOpenChange?.(false);
              } else {
                // Seed with the effective default; dropdown stays open
                // so the user can pick a different model if they want.
                onChange(effectiveDefault);
              }
            }}
          />
        )}
        {(!showUseDefault || value !== null) && groups.length > 0 && (
          <SelectSeparator key="sep-inherit" className="my-0" />
        )}
        {(!showUseDefault || value !== null) &&
          (tiers
            ? renderTieredSections(groups, tiers, {
                selectedModel: resolved?.selectedModel ?? null,
                showAll,
                onToggleShowAll: toggleShowAll,
              })
            : groups.flatMap((group, idx) => {
                return renderProviderGroup(group, {
                  idx,
                  last: lastGroupIdx,
                  selectedModel: resolved?.selectedModel ?? null,
                  showAll,
                  onToggleShowAll: toggleShowAll,
                });
              }))}
      </SelectContent>
    </Select>
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
  mobileIconTrigger = false,
  open,
  onOpenChange,
  disabled = false,
  agentDefault,
  inheritLabel,
  tiers,
}: ModelProviderPickerProps) {
  if (disabled) {
    return (
      <DisabledPickerLabel
        providers={providers}
        value={value}
        placeholder={placeholder}
        compactTrigger={compactTrigger}
        mobileIconTrigger={mobileIconTrigger}
        triggerClassName={triggerClassName}
        agentDefault={agentDefault}
      />
    );
  }

  // Workspace fallback for the inherit toggle resolves against org-tier rows
  // only when tiers are provided. Callers that want "agent default" to mean a
  // preferred personal provider pass that resolved personal row as
  // `agentDefault`; otherwise personal defaults stay out of workspace fallback.
  const inheritScope = tiers
    ? providers.filter((p) => {
        return tiers.get(p.id) !== "personal";
      })
    : providers;
  const { effectiveDefault, defaultSource: autoSource } =
    resolveEffectiveDefault(agentDefault, inheritScope);
  const defaultSource: DefaultSource = inheritLabel ?? autoSource;

  const groups = buildProviderGroups(providers, sessionProviderType);
  return (
    <ModelSelectDropdown
      groups={groups}
      value={value}
      effectiveDefault={effectiveDefault}
      defaultSource={defaultSource}
      providers={providers}
      placeholder={placeholder}
      triggerClassName={triggerClassName}
      compactTrigger={compactTrigger}
      mobileIconTrigger={mobileIconTrigger}
      onChange={onChange}
      open={open}
      onOpenChange={onOpenChange}
      showUseDefault
      tiers={tiers}
    />
  );
}
