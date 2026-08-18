import type { ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cpu,
  MessageCircle,
  Zap,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import {
  getCanonicalModelDisplayName,
  getProvidersForModel,
  isCodexFastModeModel,
  isSupportedRunModel,
  VM0_MODEL_TO_PROVIDER,
  type ModelProviderType,
  type OrgModelPolicy,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import {
  VIDEO_MODEL_CONFIGS,
  type VideoModel,
} from "@okouai/core/video-model-catalog";
import { useTranslation } from "react-i18next";
import { orgModelPolicies$ } from "../../../signals/external/org-model-policies";
import { userModelPreference$ } from "../../../signals/external/user-model-preference";
import {
  DEFAULT_MODEL_PLAN_CAPABILITIES,
  modelAllowedForPlan,
  modelPlanCapabilities$,
  modelPolicyAllowedForPlan,
  type ModelPlanCapabilities,
} from "../../../signals/zero-page/model-plan-capabilities";
import {
  openSettingsBillingPlans$,
  setSettingsDialogOpen$,
} from "../../../signals/zero-page/settings/settings-dialog.ts";
import { pageSignal$ } from "../../../signals/page-signal";
import { resolveExplicitModelSelection$ } from "../../../signals/zero-page/model-default-selection";
import { detach, Reason } from "../../../signals/utils";
import {
  getModelBrandIconType,
  getVm0ModelPriceTier,
  getVm0ModelPriceTierLabel,
  type Vm0ModelPriceTier,
} from "./settings/provider-ui-config";
import { ProviderIcon } from "./settings/provider-icons";
import { settingsIconAssetUrl } from "./settings/settings-icon-assets";

export interface ModelProviderSelection {
  selectedModel: SupportedRunModel;
  codexServiceTier?: CodexServiceTier;
}

export interface MediaModelPanelOption {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly icon: ReactNode;
  readonly priceTier: Vm0ModelPriceTier;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly variantPicker?: {
    readonly ariaLabel: string;
    readonly valueLabel: string;
    readonly options: readonly {
      readonly key: string;
      readonly label: string;
      readonly priceTier: Vm0ModelPriceTier;
      readonly selected: boolean;
      readonly onSelect: () => void;
    }[];
  };
}

export interface MediaModelPanelCategory {
  readonly id: "video";
  readonly label: string;
  readonly menuLabel: string;
  readonly options: readonly MediaModelPanelOption[];
}

/**
 * Media-model categories share the run-model popover without joining its
 * Select value space. Mobile opens one nested category at a time; desktop
 * supplies the active mode and its control anchor through the same state.
 */
export interface MediaModelPanelState {
  readonly activeCategory: "video" | null;
  readonly categories: readonly MediaModelPanelCategory[];
  readonly onActiveCategoryChange: (category: "video" | null) => void;
  readonly contentAnchor?: Element | null;
}

interface ModelProviderPickerProps {
  value: ModelProviderSelection | null;
  onChange: (value: ModelProviderSelection | null) => void;
  placeholder?: string;
  /**
   * Classes applied to the picker trigger. Defaults to `h-9 w-full`. The
   * composer passes an auto-width, compact variant to fit next to Send.
   */
  triggerClassName?: string;
  /**
   * When true, the trigger shows only the friendly model name (no provider
   * label, no price tier badge). Used by the chat composer where horizontal
   * space is tight and the full breakdown lives in the open dropdown.
   */
  compactTrigger?: boolean;
  /**
   * When true, the trigger renders as a provider icon on mobile while keeping
   * the normal label on larger screens.
   */
  mobileIconTrigger?: boolean;
  /** Optional desktop-only mode label shown before the selected model. */
  desktopModeLabel?: string;
  /** Controlled open state for programmatic toggle (e.g. keyboard shortcut). */
  open?: boolean;
  /** Callback when the open state changes. */
  onOpenChange?: (
    open: boolean,
    eventDetails: { readonly event: Event; readonly cancel: () => void },
  ) => void;
  /** Whether the open picker blocks interaction with surrounding controls. */
  modal?: boolean;
  /** Whether this trigger is the control represented by the shared popup. */
  triggerControlsPopup?: boolean;
  // When true, picker is read-only for the current caller state.
  disabled?: boolean;
  /**
   * When false, the trigger renders only the explicit value. Existing thread
   * composers use this because thread model state comes from event projection,
   * not user/workspace defaults.
   */
  resolveDefaultSelection?: boolean;
  /** Enables the inline Codex Fast choices in the model list. */
  codexFastModeEnabled?: boolean;
  /** Media-model category panel state for composer callers. */
  mediaModelPanel?: MediaModelPanelState;
}

// Keep the inherit option distinct from an empty model identifier at the UI
// boundary so its value remains stable across controlled Select updates.
const INHERIT_SENTINEL = "__inherit_default__";
const CODEX_FAST_OPTION_PREFIX = "__codex_fast_option__:";
const CODEX_FAST_SELECTED_PREFIX = "__codex_fast_selected__:";

// Select uses the selected item's offsetHeight as the scroll-button
// step. Keep hidden selected items measurable so native hover scrolling works.
// These items are also `disabled`, and SelectItem's base `data-[disabled]:opacity-50`
// outranks a plain `opacity-0` on specificity, so restate the hidden opacity under
// the disabled variant to stop the measuring item from bleeding through.
const MEASURABLE_HIDDEN_SELECT_ITEM_CLASS =
  "absolute left-0 top-0 h-8 w-px overflow-hidden opacity-0 data-[disabled]:opacity-0 pointer-events-none";

function PriceTierBadge({ tier }: { tier: Vm0ModelPriceTier }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 cursor-help text-xs font-medium text-muted-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:decoration-muted-foreground">
            {tier}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {getVm0ModelPriceTierLabel(tier)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ByokBadge() {
  const { t } = useTranslation();
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 cursor-help text-xs font-medium text-muted-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:decoration-muted-foreground">
            BYOK
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {t(($) => {
            return $.settings.models.picker.byokHelp;
          })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ProBadge() {
  const { t } = useTranslation();
  return (
    <span className="shrink-0 rounded bg-primary px-1.5 py-0.5 text-[11px] font-medium leading-none text-primary-foreground">
      {t(($) => {
        return $.settings.models.picker.pro;
      })}
    </span>
  );
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
          <Cpu size={18} />
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
        !c.startsWith("focus-visible:") &&
        !c.startsWith("active:") &&
        !c.startsWith("data-popup-open:")
      );
    })
    .join(" ");
}

function getModelFirstIconType(model: string): ModelProviderType | undefined {
  if (isSupportedRunModel(model)) {
    return getModelBrandIconType(model);
  }
  const vm0Entry = VM0_MODEL_TO_PROVIDER[model];
  if (vm0Entry) {
    return vm0Entry.concreteType as ModelProviderType;
  }
  return getProvidersForModel(model).find((type) => {
    return type !== "vm0";
  });
}

function resolveModelFirstDefault(
  value: ModelProviderSelection | null,
  userPreference: { selectedModel: string | null } | null | undefined,
  policies: OrgModelPolicy[],
): ModelProviderSelection | null {
  const validUserDefault =
    userPreference?.selectedModel &&
    isSupportedRunModel(userPreference.selectedModel) &&
    policies.some((policy) => {
      return (
        policy.model === userPreference.selectedModel &&
        policy.routeStatus === "valid"
      );
    })
      ? {
          selectedModel: userPreference.selectedModel,
        }
      : null;
  const validWorkspaceDefault = policies.find((policy) => {
    return (
      policy.isDefault &&
      policy.routeStatus === "valid" &&
      isSupportedRunModel(policy.model)
    );
  });
  return (
    value ??
    validUserDefault ??
    (validWorkspaceDefault
      ? {
          selectedModel: validWorkspaceDefault.model,
        }
      : null)
  );
}

function selectablePoliciesForPlan(
  policies: OrgModelPolicy[],
  modelCapabilities: ModelPlanCapabilities,
): OrgModelPolicy[] {
  if (modelCapabilities.supportByok && !modelCapabilities.restrictedVm0Models) {
    return policies;
  }
  return policies.filter((policy) => {
    return modelPolicyAllowedForPlan(policy, modelCapabilities);
  });
}

function selectionAllowedValue(
  value: ModelProviderSelection | null,
  policies: OrgModelPolicy[],
  modelCapabilities: ModelPlanCapabilities,
): ModelProviderSelection | null {
  if (!value) {
    return null;
  }
  const policy = policies.find((candidate) => {
    return candidate.model === value.selectedModel;
  });
  const allowed = policy
    ? modelPolicyAllowedForPlan(policy, modelCapabilities)
    : modelAllowedForPlan(value.selectedModel, modelCapabilities);
  return allowed ? value : null;
}

function selectionLabel({
  selection,
  placeholder,
  codexFastModeEnabled,
  fastLabel,
}: {
  selection: ModelProviderSelection | null;
  placeholder: string;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}): string {
  if (!selection) {
    return placeholder;
  }
  const modelLabel = getCanonicalModelDisplayName(selection.selectedModel);
  return codexFastModeEnabled && selection.codexServiceTier === "fast"
    ? `${modelLabel} ${fastLabel}`
    : modelLabel;
}

function ModelFirstTriggerLabel({
  selection,
  placeholder,
  mobileIcon,
  codexFastModeEnabled,
  fastLabel,
}: {
  selection: ModelProviderSelection | null;
  placeholder: string;
  mobileIcon: boolean;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}) {
  if (!selection) {
    return (
      <ResponsiveTriggerContent
        mobileIcon={mobileIcon}
        iconType={undefined}
        label={<span>{placeholder}</span>}
      />
    );
  }
  const iconType = getModelFirstIconType(selection.selectedModel);
  return (
    <ResponsiveTriggerContent
      mobileIcon={mobileIcon}
      iconType={iconType}
      label={
        <span className="min-w-0 truncate">
          {selectionLabel({
            selection,
            placeholder,
            codexFastModeEnabled,
            fastLabel,
          })}
        </span>
      }
    />
  );
}

function ModelFirstTriggerContent({
  desktopModeLabel,
  selection,
  placeholder,
  mobileIcon,
  codexFastModeEnabled,
  fastLabel,
}: {
  desktopModeLabel: string | undefined;
  selection: ModelProviderSelection | null;
  placeholder: string;
  mobileIcon: boolean;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {desktopModeLabel && (
        <span className="hidden shrink-0 sm:inline-flex sm:items-center sm:gap-1.5">
          <MessageCircle size={16} aria-hidden="true" />
          <span aria-hidden="true">·</span>
        </span>
      )}
      <ModelFirstTriggerLabel
        selection={selection}
        placeholder={placeholder}
        mobileIcon={mobileIcon}
        codexFastModeEnabled={codexFastModeEnabled}
        fastLabel={fastLabel}
      />
    </span>
  );
}

function ModelFirstDisabledPickerLabel({
  value,
  placeholder,
  mobileIconTrigger,
  desktopModeLabel,
  triggerClassName,
  userPreference,
  policies,
  codexFastModeEnabled,
  fastLabel,
}: Pick<
  ModelProviderPickerProps,
  | "value"
  | "placeholder"
  | "compactTrigger"
  | "mobileIconTrigger"
  | "desktopModeLabel"
  | "triggerClassName"
> & {
  placeholder: string;
  compactTrigger: boolean;
  mobileIconTrigger: boolean;
  policies: OrgModelPolicy[];
  userPreference: { selectedModel: string | null } | null | undefined;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}) {
  const resolved = resolveModelFirstDefault(value, userPreference, policies);
  const label = selectionLabel({
    selection: resolved,
    placeholder,
    codexFastModeEnabled,
    fastLabel,
  });
  return (
    <span
      aria-label={label}
      className={cn(
        "inline-flex items-center px-2 text-sm text-muted-foreground cursor-default",
        stripInteractiveClasses(triggerClassName),
      )}
    >
      <ModelFirstTriggerContent
        desktopModeLabel={desktopModeLabel}
        selection={resolved}
        placeholder={placeholder}
        mobileIcon={mobileIconTrigger}
        codexFastModeEnabled={codexFastModeEnabled}
        fastLabel={fastLabel}
      />
    </span>
  );
}

function modelFirstSelectionFromRaw(
  raw: string,
  codexFastModeEnabled: boolean,
): ModelProviderSelection | null {
  if (raw === INHERIT_SENTINEL) {
    return null;
  }
  if (raw.startsWith(CODEX_FAST_OPTION_PREFIX)) {
    const selectedModel = raw.slice(CODEX_FAST_OPTION_PREFIX.length);
    if (
      codexFastModeEnabled &&
      isSupportedRunModel(selectedModel) &&
      isCodexFastModeModel(selectedModel)
    ) {
      return { selectedModel, codexServiceTier: "fast" };
    }
    return null;
  }
  if (!isSupportedRunModel(raw)) {
    return null;
  }
  return {
    selectedModel: raw,
  };
}

function modelFirstSelectValue(
  selection: ModelProviderSelection | null,
): string {
  if (!selection) {
    return INHERIT_SENTINEL;
  }
  return selection.codexServiceTier === "fast"
    ? `${CODEX_FAST_SELECTED_PREFIX}${selection.selectedModel}`
    : selection.selectedModel;
}

function codexFastOptionValue(model: string): string {
  return `${CODEX_FAST_OPTION_PREFIX}${model}`;
}

function modelFirstSelectionFromInteraction(
  raw: string,
  currentSelection: ModelProviderSelection | null,
  codexFastModeEnabled: boolean,
): ModelProviderSelection | null | undefined {
  if (codexFastModeEnabled && currentSelection?.codexServiceTier === "fast") {
    if (raw === currentSelection.selectedModel) {
      return undefined;
    }
    if (raw === codexFastOptionValue(currentSelection.selectedModel)) {
      return { selectedModel: currentSelection.selectedModel };
    }
  }
  return modelFirstSelectionFromRaw(raw, codexFastModeEnabled);
}

function isHiddenModelFirstSelectValue(value: string): boolean {
  return (
    value === INHERIT_SENTINEL || value.startsWith(CODEX_FAST_SELECTED_PREFIX)
  );
}

function ModelFirstPolicyRowContent({
  policy,
  modelCapabilities,
  selected = false,
  showSelectedIndicator = false,
}: {
  policy: OrgModelPolicy;
  modelCapabilities: ModelPlanCapabilities;
  selected?: boolean;
  showSelectedIndicator?: boolean;
}) {
  const iconType = getModelFirstIconType(policy.model);
  const builtInPriceTier =
    policy.defaultProviderType === "vm0"
      ? getVm0ModelPriceTier(policy.model)
      : undefined;
  const restricted = !modelPolicyAllowedForPlan(policy, modelCapabilities);
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      {iconType && <ProviderIcon type={iconType} size={16} />}
      <span className="min-w-0 flex-1 truncate">
        {policy.modelLabel || getCanonicalModelDisplayName(policy.model)}
      </span>
      {builtInPriceTier !== undefined ? (
        <PriceTierBadge tier={builtInPriceTier} />
      ) : (
        <ByokBadge />
      )}
      {restricted && <ProBadge />}
      {showSelectedIndicator && (
        <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center text-foreground">
          {selected && <Check size={15} />}
        </span>
      )}
    </span>
  );
}

function ModelFirstPolicyRow({
  policy,
  modelCapabilities,
  selection,
  codexFastModeEnabled,
}: {
  policy: OrgModelPolicy;
  modelCapabilities: ModelPlanCapabilities;
  selection: ModelProviderSelection | null;
  codexFastModeEnabled: boolean;
}) {
  const { t } = useTranslation();
  const fastAvailable =
    codexFastModeEnabled &&
    policy.routeStatus === "valid" &&
    isCodexFastModeModel(policy.model);
  if (fastAvailable) {
    const modelLabel =
      policy.modelLabel || getCanonicalModelDisplayName(policy.model);
    const selected = selection?.selectedModel === policy.model;
    const fastSelected = selected && selection.codexServiceTier === "fast";
    const fastLabel = t(($) => {
      return $.settings.models.picker.fast;
    });
    const fastImpact = t(($) => {
      return $.settings.models.picker.fastImpact;
    });
    return (
      <div
        className={cn(
          "relative flex overflow-hidden rounded-lg transition-colors hover:bg-state-hover has-[[data-highlighted]]:bg-state-hover",
          selected &&
            "bg-state-selected hover:bg-state-selected-hover has-[[data-highlighted]]:bg-state-selected-hover",
        )}
      >
        <SelectItem
          value={policy.model}
          aria-label={modelLabel}
          className={cn(
            "min-w-0 flex-1 rounded-lg pr-8 hover:bg-transparent data-highlighted:bg-transparent",
            selected && "mr-8",
          )}
        >
          <ModelFirstPolicyRowContent
            policy={policy}
            modelCapabilities={modelCapabilities}
            selected={selected}
            showSelectedIndicator={fastSelected}
          />
        </SelectItem>
        <TooltipProvider delayDuration={800} skipDelayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <SelectItem
                value={codexFastOptionValue(policy.model)}
                aria-label={`${modelLabel} ${fastLabel}`}
                className={cn(
                  "group/fast-option absolute inset-y-0 right-0 w-8 justify-center rounded-lg px-0 text-muted-foreground hover:bg-transparent data-highlighted:bg-transparent",
                  fastSelected &&
                    "text-amber-600 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200",
                )}
              >
                <Zap
                  size={18}
                  fill={fastSelected ? "currentColor" : "none"}
                  className={cn(
                    fastSelected
                      ? "group-hover/fast-option:fill-none group-data-[highlighted]/fast-option:fill-none"
                      : "group-hover/fast-option:fill-current group-data-[highlighted]/fast-option:fill-current",
                  )}
                  aria-hidden="true"
                />
              </SelectItem>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {fastLabel} · {fastImpact}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    );
  }
  return (
    <SelectItem
      key={policy.id}
      value={policy.model}
      disabled={policy.routeStatus !== "valid"}
    >
      <ModelFirstPolicyRowContent
        policy={policy}
        modelCapabilities={modelCapabilities}
      />
    </SelectItem>
  );
}

function ModelFirstPolicyItems({
  policies,
  selection,
  modelCapabilities,
  codexFastModeEnabled,
  showSeparator = true,
}: {
  policies: OrgModelPolicy[];
  selection: ModelProviderSelection | null;
  modelCapabilities: ModelPlanCapabilities;
  codexFastModeEnabled: boolean;
  showSeparator?: boolean;
}) {
  const { t } = useTranslation();
  const explicitSelectedModel = selection?.selectedModel ?? null;
  const hasExplicitSelectedPolicy =
    explicitSelectedModel === null ||
    policies.some((policy) => {
      return policy.model === explicitSelectedModel;
    });
  return (
    <>
      {showSeparator && (!hasExplicitSelectedPolicy || policies.length > 0) && (
        <SelectSeparator className="my-0" />
      )}
      {!hasExplicitSelectedPolicy && explicitSelectedModel && (
        <SelectItem
          value={explicitSelectedModel}
          className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
          disabled
          aria-hidden="true"
        >
          {getCanonicalModelDisplayName(explicitSelectedModel)}
        </SelectItem>
      )}
      {policies.length === 0 ? (
        <div className="px-2 py-2 text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.models.picker.noConfiguredModels;
          })}
        </div>
      ) : (
        <SelectGroup>
          <SelectLabel className="pl-2 pr-8 py-1.5 text-xs font-medium text-muted-foreground">
            {t(($) => {
              return $.settings.models.picker.models;
            })}
          </SelectLabel>
          {policies.map((policy) => {
            return (
              <ModelFirstPolicyRow
                key={policy.id}
                policy={policy}
                modelCapabilities={modelCapabilities}
                selection={selection}
                codexFastModeEnabled={codexFastModeEnabled}
              />
            );
          })}
        </SelectGroup>
      )}
    </>
  );
}

// Rows in media-model panels are plain buttons rather than SelectItems: the
// Select's value space belongs to the run model, and a SelectItem here would
// both join it and close the popover on click.
const MEDIA_MODEL_PANEL_ROW_CLASS =
  "relative flex w-full select-none items-center rounded-lg text-sm outline-none transition-colors hover:bg-state-hover hover:text-accent-foreground";

const BYTEDANCE_ICON_PATH =
  "M19.8772 1.4685 24 2.5326v18.9426l-4.1228 1.0563V1.4685zm-13.3481 9.428 4.115 1.0641v8.9786l-4.115 1.0642v-11.107zM0 2.572l4.115 1.0642v16.7354L0 21.428V2.572zm17.4553 5.6205v11.107l-4.1228-1.0642V9.2568l4.1228-1.0642z";

const MINIMAX_ICON_URL = settingsIconAssetUrl("minimax");

function VideoModelVeoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M5.988 1.622A8.539 8.539 0 0 0 3.45 8.446c.349 4.408 4.506 7.995 8.276 7.995 3.507 0 4.88-3.061 4.541-5.14a4.318 4.318 0 0 0-.95-2.073c.632.34 1.244.776 1.809 1.3 1.52 1.415 2.44 3.229 2.587 5.1C20.04 19.763 16.98 24 11.863 24c-1.695 0-3.48-.432-4.98-1.143C2.816 20.937 0 16.797 0 12.002 0 7.571 2.405 3.7 5.988 1.622zM12.136 0c1.696 0 3.481.432 4.98 1.143C21.186 3.063 24 7.203 24 11.998c0 4.431-2.405 8.303-5.988 10.38a8.539 8.539 0 0 0 2.538-6.824c-.349-4.408-4.506-7.995-8.276-7.995-3.507 0-4.88 3.061-4.541 5.14a4.3 4.3 0 0 0 .953 2.073 8.723 8.723 0 0 1-1.81-1.3c-1.52-1.415-2.44-3.227-2.589-5.1C3.96 4.237 7.02 0 12.137 0z"
        fill="url(#video-model-veo-gradient)"
        fillRule="evenodd"
      />
      <defs>
        <linearGradient
          id="video-model-veo-gradient"
          x1="2"
          x2="22"
          y1="4"
          y2="20"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#78b8ff" />
          <stop offset="1" stopColor="#8d8cff" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function VideoModelKlingIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M5.412 13.775A23.193 23.193 0 0 1 7.41 9.32c3.17-5.492 7.795-8.757 10.33-7.294C12.038-1.266 4.598.944 1.122 6.964A13.378 13.378 0 0 0 .085 9.22c-.259.739.092 1.534.77 1.926l4.557 2.63z"
        fill="url(#video-model-kling-outer-start)"
      />
      <path
        d="M18.588 10.164a23.188 23.188 0 0 1-1.999 4.455c-3.17 5.492-7.795 8.758-10.33 7.294 5.703 3.293 13.143 1.082 16.619-4.938a13.392 13.392 0 0 0 1.037-2.255c.259-.738-.092-1.534-.77-1.925l-4.557-2.63z"
        fill="url(#video-model-kling-outer-end)"
      />
      <path
        d="M16.59 14.62c3.17-5.492 3.686-11.13 1.15-12.594C15.207.563 10.582 3.83 7.41 9.32c2.074-3.59 5.809-5.315 8.344-3.852 2.534 1.464 2.908 5.56.835 9.151z"
        fill="url(#video-model-kling-inner-start)"
      />
      <path
        d="M7.41 9.32c-3.17 5.492-3.686 11.13-1.15 12.593 2.534 1.464 7.159-1.802 10.33-7.294-2.074 3.591-5.809 5.316-8.344 3.852-2.534-1.463-2.908-5.56-.835-9.15z"
        fill="url(#video-model-kling-inner-end)"
      />
      <defs>
        <radialGradient
          id="video-model-kling-outer-start"
          cx="0"
          cy="0"
          r="1"
          gradientTransform="matrix(7.47772 -12.51022 17.14368 10.24728 5.173 13.637)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".095" stopColor="#fff959" />
          <stop offset=".326" stopColor="#0df35e" />
          <stop offset=".64" stopColor="#0bf2f9" />
          <stop offset="1" stopColor="#04a6f0" />
        </radialGradient>
        <radialGradient
          id="video-model-kling-outer-end"
          cx="0"
          cy="0"
          r="1"
          gradientTransform="rotate(120.868 6.491 10.491) scale(14.5747 19.9728)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".095" stopColor="#fff959" />
          <stop offset=".326" stopColor="#0df35e" />
          <stop offset=".64" stopColor="#0bf2f9" />
          <stop offset="1" stopColor="#04a6f0" />
        </radialGradient>
        <linearGradient
          id="video-model-kling-inner-start"
          x1="15.578"
          x2="18.062"
          y1="1.798"
          y2="9.861"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#003eff" />
          <stop offset="1" stopColor="#0bffe7" />
        </linearGradient>
        <linearGradient
          id="video-model-kling-inner-end"
          x1="8.422"
          x2="5.938"
          y1="22.142"
          y2="14.079"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#003eff" />
          <stop offset="1" stopColor="#0bffe7" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function VideoModelBrandIcon({ model }: { model: VideoModel }) {
  const config = VIDEO_MODEL_CONFIGS[model];
  const brand =
    config.provider === "byteplus"
      ? "bytedance"
      : config.provider === "minimax"
        ? "minimax"
        : config.requestFormat;
  if (brand === "minimax") {
    return (
      <img
        src={MINIMAX_ICON_URL}
        width={16}
        height={16}
        alt=""
        className="shrink-0"
      />
    );
  }
  if (brand === "veo") {
    return <VideoModelVeoIcon />;
  }
  if (brand === "kling") {
    return <VideoModelKlingIcon />;
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d={BYTEDANCE_ICON_PATH} />
    </svg>
  );
}

function MediaModelPriceTier({ tier }: { tier: Vm0ModelPriceTier }) {
  return (
    <span
      className="min-w-7 shrink-0 text-right text-xs font-medium text-muted-foreground"
      aria-label={getVm0ModelPriceTierLabel(tier)}
    >
      {tier}
    </span>
  );
}

function MediaModelVariantPicker({
  picker,
}: {
  picker: NonNullable<MediaModelPanelOption["variantPicker"]>;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={picker.ariaLabel}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-border bg-background px-2.5 text-xs font-medium text-foreground shadow-sm outline-none transition-colors hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring"
        >
          {picker.valueLabel}
          <ChevronDown size={13} className="text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-44 p-1.5">
        {picker.options.map((variant) => {
          return (
            <DropdownMenuItem
              key={variant.key}
              aria-label={`${variant.label} ${variant.priceTier}`}
              className={cn(
                "grid grid-cols-[1fr_auto_15px] gap-3 px-2.5 py-2",
                variant.selected && "bg-state-selected",
              )}
              onClick={variant.onSelect}
            >
              <span>{variant.label}</span>
              <MediaModelPriceTier tier={variant.priceTier} />
              {variant.selected ? (
                <Check size={15} className="text-foreground" />
              ) : (
                <span aria-hidden="true" />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MediaModelPanelRow({ option }: { option: MediaModelPanelOption }) {
  return (
    <div
      className={cn(
        MEDIA_MODEL_PANEL_ROW_CLASS,
        option.selected && "bg-state-selected hover:bg-state-selected-hover",
      )}
    >
      <button
        type="button"
        aria-label={option.label}
        aria-pressed={option.selected}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-2 pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={option.onSelect}
      >
        {option.icon}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{option.label}</span>
          <span className="truncate text-[11px] leading-4 text-muted-foreground">
            {option.detail}
          </span>
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-2.5 pr-2">
        {option.variantPicker && (
          <MediaModelVariantPicker picker={option.variantPicker} />
        )}
        <MediaModelPriceTier tier={option.priceTier} />
      </span>
      {option.selected && (
        <Check size={15} className="mr-2 shrink-0 text-foreground" />
      )}
    </div>
  );
}

function MediaModelPanel({
  panel,
  category,
}: {
  panel: MediaModelPanelState;
  category: MediaModelPanelCategory;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded-lg py-1.5 pl-1 pr-2 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-state-hover hover:text-foreground sm:hidden"
        onClick={() => {
          panel.onActiveCategoryChange(null);
        }}
      >
        <ChevronLeft size={14} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{category.label}</span>
      </button>
      <SelectGroup>
        <SelectLabel className="hidden py-1.5 pl-2 pr-8 text-xs font-medium text-muted-foreground sm:block">
          {t(($) => {
            return $.settings.models.picker.models;
          })}
        </SelectLabel>
        {category.options.map((option) => {
          return <MediaModelPanelRow key={option.key} option={option} />;
        })}
      </SelectGroup>
    </>
  );
}

function MediaModelPanelMenu({ panel }: { panel: MediaModelPanelState }) {
  return (
    <>
      <SelectSeparator className="my-0 sm:hidden" />
      {panel.categories.map((category) => {
        return (
          <button
            key={category.id}
            type="button"
            className={cn(MEDIA_MODEL_PANEL_ROW_CLASS, "sm:hidden")}
            onClick={() => {
              panel.onActiveCategoryChange(category.id);
            }}
          >
            <span className="min-w-0 flex-1 truncate">
              {category.menuLabel}
            </span>
            <ChevronRight
              size={15}
              className="absolute right-2 text-muted-foreground"
              aria-hidden="true"
            />
          </button>
        );
      })}
    </>
  );
}

interface ModelFirstModelPickerContentBaseProps {
  selectValue: string;
  placeholder: string;
  policies: OrgModelPolicy[];
  selection: ModelProviderSelection | null;
  modelCapabilities: ModelPlanCapabilities;
  codexFastModeEnabled: boolean;
  fastLabel: string;
  mediaModelPanel: MediaModelPanelState | undefined;
}

function ModelFirstModelPickerContentLayout({
  selectValue,
  placeholder,
  policies,
  selection,
  modelCapabilities,
  codexFastModeEnabled,
  fastLabel,
  mediaModelPanel,
}: ModelFirstModelPickerContentBaseProps) {
  const activeMediaModelCategoryId = mediaModelPanel?.activeCategory;
  const activeMediaModelCategory = mediaModelPanel?.categories.find(
    (category) => {
      return category.id === activeMediaModelCategoryId;
    },
  );
  const mediaModelPanelOpen = activeMediaModelCategory !== undefined;
  const contentAnchor = mediaModelPanelOpen
    ? mediaModelPanel?.contentAnchor
    : undefined;
  return (
    <SelectContent
      anchor={contentAnchor}
      className={cn(
        "max-h-[380px] min-w-[260px]",
        mediaModelPanelOpen && "min-w-[340px]",
      )}
    >
      {/* A media-model panel replaces the model rows, so keep the selected run
          model measurable the same way a hidden select value is. */}
      {(mediaModelPanelOpen || isHiddenModelFirstSelectValue(selectValue)) && (
        <SelectItem
          value={selectValue}
          className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
          disabled
          aria-hidden="true"
        >
          {selectionLabel({
            selection,
            placeholder,
            codexFastModeEnabled,
            fastLabel,
          })}
        </SelectItem>
      )}
      {mediaModelPanel && activeMediaModelCategory ? (
        <MediaModelPanel
          panel={mediaModelPanel}
          category={activeMediaModelCategory}
        />
      ) : (
        <>
          <ModelFirstPolicyItems
            policies={policies}
            selection={selection}
            modelCapabilities={modelCapabilities}
            codexFastModeEnabled={codexFastModeEnabled}
            showSeparator={false}
          />
          {mediaModelPanel && <MediaModelPanelMenu panel={mediaModelPanel} />}
        </>
      )}
    </SelectContent>
  );
}

interface ModelFirstModelPickerState {
  policies: OrgModelPolicy[];
  selectablePolicies: OrgModelPolicy[];
  selectableValue: ModelProviderSelection | null;
  selection: ModelProviderSelection | null;
  selectValue: string;
  triggerAriaLabel: string;
}

function resolveModelFirstModelPickerState({
  value,
  userPreference,
  policyResponse,
  modelCapabilities,
  resolveDefaultSelection,
  placeholder,
  codexFastModeEnabled,
  fastLabel,
}: {
  value: ModelProviderSelection | null;
  userPreference: { selectedModel: string | null } | null | undefined;
  policyResponse: { policies: OrgModelPolicy[] } | null | undefined;
  modelCapabilities: ModelPlanCapabilities;
  resolveDefaultSelection: boolean;
  placeholder: string;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}): ModelFirstModelPickerState {
  const policies = policyResponse?.policies ?? [];
  const selectablePolicies = selectablePoliciesForPlan(
    policies,
    modelCapabilities,
  );
  const selectableValue = selectionAllowedValue(
    value,
    policies,
    modelCapabilities,
  );
  const resolved = resolveDefaultSelection
    ? resolveModelFirstDefault(
        selectableValue,
        userPreference,
        selectablePolicies,
      )
    : selectableValue;
  return {
    policies,
    selectablePolicies,
    selectableValue,
    selection: resolved,
    selectValue: modelFirstSelectValue(resolved),
    triggerAriaLabel: selectionLabel({
      selection: resolved,
      placeholder,
      codexFastModeEnabled,
      fastLabel,
    }),
  };
}

function ModelFirstSelectPicker({
  state,
  content,
  placeholder,
  triggerClassName,
  mobileIconTrigger,
  desktopModeLabel,
  modelCapabilities,
  codexFastModeEnabled,
  fastLabel,
  mediaModelPanel,
  open,
  onOpenChange,
  modal,
  triggerControlsPopup,
  onValueChange,
}: {
  state: ModelFirstModelPickerState;
  content?: ReactNode;
  placeholder: string;
  triggerClassName: string | undefined;
  mobileIconTrigger: boolean;
  desktopModeLabel: string | undefined;
  modelCapabilities: ModelPlanCapabilities;
  codexFastModeEnabled: boolean;
  fastLabel: string;
  mediaModelPanel: MediaModelPanelState | undefined;
  open: boolean | undefined;
  onOpenChange:
    | ((
        open: boolean,
        eventDetails: { readonly event: Event; readonly cancel: () => void },
      ) => void)
    | undefined;
  modal: boolean | undefined;
  triggerControlsPopup: boolean | undefined;
  onValueChange: (raw: string) => void;
}) {
  return (
    <Select
      value={state.selectValue}
      onValueChange={onValueChange}
      open={open}
      onOpenChange={onOpenChange}
      modal={modal}
    >
      <SelectTrigger
        aria-label={state.triggerAriaLabel}
        className={cn("h-9 w-full", triggerClassName)}
        {...(triggerControlsPopup === false
          ? { "aria-controls": undefined, "aria-expanded": false }
          : {})}
      >
        <SelectValue placeholder={placeholder}>
          <ModelFirstTriggerContent
            desktopModeLabel={desktopModeLabel}
            selection={state.selection}
            placeholder={placeholder}
            mobileIcon={mobileIconTrigger}
            codexFastModeEnabled={codexFastModeEnabled}
            fastLabel={fastLabel}
          />
        </SelectValue>
      </SelectTrigger>
      {open !== false &&
        (content ?? (
          <ModelFirstModelPickerContentLayout
            selectValue={state.selectValue}
            placeholder={placeholder}
            policies={state.policies}
            selection={state.selection}
            modelCapabilities={modelCapabilities}
            codexFastModeEnabled={codexFastModeEnabled}
            fastLabel={fastLabel}
            mediaModelPanel={mediaModelPanel}
          />
        ))}
    </Select>
  );
}

function SubscribedModelFirstModelPicker({
  value,
  onChange,
  placeholder,
  triggerClassName,
  compactTrigger,
  mobileIconTrigger,
  desktopModeLabel,
  open,
  onOpenChange,
  modal,
  triggerControlsPopup,
  disabled,
  userPreference,
  resolveDefaultSelection,
  codexFastModeEnabled = false,
  fastLabel,
  mediaModelPanel,
}: ModelProviderPickerProps & {
  placeholder: string;
  compactTrigger: boolean;
  mobileIconTrigger: boolean;
  userPreference: { selectedModel: string | null } | null | undefined;
  resolveDefaultSelection: boolean;
  fastLabel: string;
}) {
  const policiesLoadable = useLastLoadable(orgModelPolicies$);
  const modelCapabilitiesLoadable = useLoadable(modelPlanCapabilities$);
  const lastModelCapabilities = useLastResolved(modelPlanCapabilities$);
  const openBillingPlans = useSet(openSettingsBillingPlans$);
  const openSettings = useSet(setSettingsDialogOpen$);
  const pageSignal = useGet(pageSignal$);
  const policyResponse =
    policiesLoadable.state === "hasData" ? policiesLoadable.data : undefined;
  const modelCapabilities =
    modelCapabilitiesLoadable.state === "hasData"
      ? modelCapabilitiesLoadable.data
      : (lastModelCapabilities ?? DEFAULT_MODEL_PLAN_CAPABILITIES);
  const state = resolveModelFirstModelPickerState({
    value,
    userPreference,
    policyResponse,
    modelCapabilities,
    resolveDefaultSelection,
    placeholder,
    codexFastModeEnabled,
    fastLabel,
  });

  if (disabled) {
    return (
      <ModelFirstDisabledPickerLabel
        value={state.selectableValue}
        placeholder={placeholder}
        compactTrigger={compactTrigger}
        mobileIconTrigger={mobileIconTrigger}
        desktopModeLabel={desktopModeLabel}
        triggerClassName={triggerClassName}
        userPreference={resolveDefaultSelection ? userPreference : null}
        policies={resolveDefaultSelection ? state.selectablePolicies : []}
        codexFastModeEnabled={codexFastModeEnabled}
        fastLabel={fastLabel}
      />
    );
  }

  const openComparePlans = () => {
    openBillingPlans();
    detach(openSettings(true, pageSignal), Reason.DomCallback);
  };

  const handleRawValueChange = (raw: string) => {
    const selection = modelFirstSelectionFromInteraction(
      raw,
      state.selection,
      codexFastModeEnabled,
    );
    if (selection === undefined) {
      return;
    }
    if (selection) {
      const policy = state.policies.find((candidate) => {
        return candidate.model === selection.selectedModel;
      });
      if (
        !modelAllowedForPlan(selection.selectedModel, modelCapabilities) ||
        (policy !== undefined &&
          !modelPolicyAllowedForPlan(policy, modelCapabilities))
      ) {
        openComparePlans();
        return;
      }
    }
    onChange(selection);
  };

  return (
    <ModelFirstSelectPicker
      state={state}
      placeholder={placeholder}
      triggerClassName={triggerClassName}
      mobileIconTrigger={mobileIconTrigger}
      desktopModeLabel={desktopModeLabel}
      modelCapabilities={modelCapabilities}
      codexFastModeEnabled={codexFastModeEnabled}
      fastLabel={fastLabel}
      mediaModelPanel={mediaModelPanel}
      open={open}
      onOpenChange={onOpenChange}
      modal={modal}
      triggerControlsPopup={triggerControlsPopup}
      onValueChange={handleRawValueChange}
    />
  );
}

function resolveExplicitModelFirstModelPickerState({
  value,
  placeholder,
  codexFastModeEnabled,
  fastLabel,
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}): ModelFirstModelPickerState {
  return {
    policies: [],
    selectablePolicies: [],
    selectableValue: value,
    selection: value,
    selectValue: modelFirstSelectValue(value),
    triggerAriaLabel: selectionLabel({
      selection: value,
      placeholder,
      codexFastModeEnabled,
      fastLabel,
    }),
  };
}

function LoadingModelFirstModelPickerContent({
  value,
  placeholder,
  codexFastModeEnabled,
  fastLabel,
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}) {
  const { t } = useTranslation();
  const selectValue = modelFirstSelectValue(value);
  return (
    <SelectContent className="min-w-[260px]">
      <SelectItem
        value={selectValue}
        className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
        disabled
        aria-hidden="true"
      >
        {selectionLabel({
          selection: value,
          placeholder,
          codexFastModeEnabled,
          fastLabel,
        })}
      </SelectItem>
      <div className="px-2 py-2 text-sm text-muted-foreground">
        {t(($) => {
          return $.settings.models.picker.loading;
        })}
      </div>
    </SelectContent>
  );
}

function ErrorModelFirstModelPickerContent({
  value,
  placeholder,
  codexFastModeEnabled,
  fastLabel,
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}) {
  const { t } = useTranslation();
  const selectValue = modelFirstSelectValue(value);
  return (
    <SelectContent className="min-w-[260px]">
      <SelectItem
        value={selectValue}
        className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
        disabled
        aria-hidden="true"
      >
        {selectionLabel({
          selection: value,
          placeholder,
          codexFastModeEnabled,
          fastLabel,
        })}
      </SelectItem>
      <div className="px-2 py-2 text-sm text-muted-foreground">
        {t(($) => {
          return $.settings.models.picker.loadError;
        })}
      </div>
    </SelectContent>
  );
}

function SubscribedExplicitModelFirstModelPickerContent({
  value,
  placeholder,
  codexFastModeEnabled,
  fastLabel,
  mediaModelPanel,
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
  codexFastModeEnabled: boolean;
  fastLabel: string;
  mediaModelPanel: MediaModelPanelState | undefined;
}) {
  const policiesLoadable = useLastLoadable(orgModelPolicies$);
  const modelCapabilities =
    useLastResolved(modelPlanCapabilities$) ?? DEFAULT_MODEL_PLAN_CAPABILITIES;
  if (policiesLoadable.state === "loading") {
    return (
      <LoadingModelFirstModelPickerContent
        value={value}
        placeholder={placeholder}
        codexFastModeEnabled={codexFastModeEnabled}
        fastLabel={fastLabel}
      />
    );
  }
  if (policiesLoadable.state === "hasError") {
    return (
      <ErrorModelFirstModelPickerContent
        value={value}
        placeholder={placeholder}
        codexFastModeEnabled={codexFastModeEnabled}
        fastLabel={fastLabel}
      />
    );
  }
  const state = resolveModelFirstModelPickerState({
    value,
    userPreference: null,
    policyResponse: policiesLoadable.data,
    modelCapabilities: DEFAULT_MODEL_PLAN_CAPABILITIES,
    resolveDefaultSelection: false,
    placeholder,
    codexFastModeEnabled,
    fastLabel,
  });
  return (
    <ModelFirstModelPickerContentLayout
      selectValue={state.selectValue}
      placeholder={placeholder}
      policies={state.policies}
      selection={state.selection}
      modelCapabilities={modelCapabilities}
      codexFastModeEnabled={codexFastModeEnabled}
      fastLabel={fastLabel}
      mediaModelPanel={mediaModelPanel}
    />
  );
}

function EnabledExplicitModelFirstModelPicker(
  props: ModelProviderPickerProps & {
    placeholder: string;
    compactTrigger: boolean;
    mobileIconTrigger: boolean;
    fastLabel: string;
  },
) {
  const resolveSelection = useSet(resolveExplicitModelSelection$);
  const openBillingPlans = useSet(openSettingsBillingPlans$);
  const openSettings = useSet(setSettingsDialogOpen$);
  const pageSignal = useGet(pageSignal$);
  const state = resolveExplicitModelFirstModelPickerState({
    value: props.value,
    placeholder: props.placeholder,
    codexFastModeEnabled: props.codexFastModeEnabled ?? false,
    fastLabel: props.fastLabel,
  });
  const handleRawValueChange = (raw: string) => {
    const selection = modelFirstSelectionFromInteraction(
      raw,
      state.selection,
      props.codexFastModeEnabled ?? false,
    );
    if (selection === undefined) {
      return;
    }
    detach(
      (async () => {
        const result = await resolveSelection(
          {
            selection,
          },
          pageSignal,
        );
        if (result.kind === "compare-plans") {
          openBillingPlans();
          await openSettings(true, pageSignal);
          return;
        }
        props.onChange(result.selection);
      })(),
      Reason.DomCallback,
    );
  };
  return (
    <ModelFirstSelectPicker
      state={state}
      content={
        props.open !== false ? (
          <SubscribedExplicitModelFirstModelPickerContent
            value={props.value}
            placeholder={props.placeholder}
            codexFastModeEnabled={props.codexFastModeEnabled ?? false}
            fastLabel={props.fastLabel}
            mediaModelPanel={props.mediaModelPanel}
          />
        ) : undefined
      }
      placeholder={props.placeholder}
      triggerClassName={props.triggerClassName}
      mobileIconTrigger={props.mobileIconTrigger}
      desktopModeLabel={props.desktopModeLabel}
      modelCapabilities={DEFAULT_MODEL_PLAN_CAPABILITIES}
      codexFastModeEnabled={props.codexFastModeEnabled ?? false}
      fastLabel={props.fastLabel}
      mediaModelPanel={props.mediaModelPanel}
      open={props.open}
      onOpenChange={props.onOpenChange}
      modal={props.modal}
      triggerControlsPopup={props.triggerControlsPopup}
      onValueChange={handleRawValueChange}
    />
  );
}

function ModelFirstModelPicker(
  props: ModelProviderPickerProps & {
    placeholder: string;
    compactTrigger: boolean;
    mobileIconTrigger: boolean;
    fastLabel: string;
  },
) {
  if (props.disabled) {
    return (
      <ModelFirstDisabledPickerLabel
        value={props.value}
        placeholder={props.placeholder}
        compactTrigger={props.compactTrigger}
        mobileIconTrigger={props.mobileIconTrigger}
        desktopModeLabel={props.desktopModeLabel}
        triggerClassName={props.triggerClassName}
        userPreference={null}
        policies={[]}
        codexFastModeEnabled={props.codexFastModeEnabled ?? false}
        fastLabel={props.fastLabel}
      />
    );
  }
  return <EnabledExplicitModelFirstModelPicker {...props} />;
}

function ModelFirstModelPickerWithDefaultSelection(
  props: ModelProviderPickerProps & {
    placeholder: string;
    compactTrigger: boolean;
    mobileIconTrigger: boolean;
    fastLabel: string;
  },
) {
  const userPreference = useLastResolved(userModelPreference$);
  return (
    <SubscribedModelFirstModelPicker
      {...props}
      userPreference={userPreference}
      resolveDefaultSelection
    />
  );
}

export function ModelProviderPicker({
  value,
  onChange,
  placeholder,
  triggerClassName,
  compactTrigger = false,
  mobileIconTrigger = false,
  desktopModeLabel,
  open,
  onOpenChange,
  modal,
  triggerControlsPopup,
  disabled = false,
  resolveDefaultSelection = true,
  codexFastModeEnabled = false,
  mediaModelPanel,
}: ModelProviderPickerProps) {
  const { t } = useTranslation();
  const resolvedPlaceholder =
    placeholder ??
    t(($) => {
      return $.settings.models.picker.inheritDefault;
    });
  const fastLabel = t(($) => {
    return $.settings.models.picker.fast;
  });
  const props = {
    value,
    onChange,
    placeholder: resolvedPlaceholder,
    triggerClassName,
    compactTrigger,
    mobileIconTrigger,
    desktopModeLabel,
    open,
    onOpenChange,
    modal,
    triggerControlsPopup,
    disabled,
    codexFastModeEnabled,
    fastLabel,
    ...(mediaModelPanel ? { mediaModelPanel } : {}),
  };
  if (resolveDefaultSelection) {
    return <ModelFirstModelPickerWithDefaultSelection {...props} />;
  }
  return <ModelFirstModelPicker {...props} />;
}
