import type { ReactNode, SyntheticEvent } from "react";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import {
  IconBolt,
  IconCheck,
  IconChevronDown,
  IconCpu,
} from "@tabler/icons-react";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
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
} from "@vm0/ui";
import {
  getCanonicalModelDisplayName,
  getProvidersForModel,
  isLimitedFree1RestrictedRunModel,
  isSupportedRunModel,
  VM0_MODEL_TO_PROVIDER,
  type ModelProviderType,
  type OrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import type { CodexServiceTier } from "@vm0/api-contracts/contracts/chat-threads";
import { orgModelPolicies$ } from "../../../signals/external/org-model-policies";
import { userModelPreference$ } from "../../../signals/external/user-model-preference";
import { billingStatusAsync$ } from "../../../signals/zero-page/billing";
import { setOrgManageDialogOpen$ } from "../../../signals/zero-page/settings/org-manage-dialog";
import { openBillingPlans$ } from "../../../signals/zero-page/settings/org-manage-tabs-state";
import { pageSignal$ } from "../../../signals/page-signal";
import { detach, Reason } from "../../../signals/utils";
import {
  getModelBrandIconType,
  getVm0ModelPriceTier,
  getVm0ModelPriceTierLabel,
  type Vm0ModelPriceTier,
} from "./settings/provider-ui-config";
import { ProviderIcon } from "./settings/provider-icons";

const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

export interface ModelProviderSelection {
  modelProviderId: string;
  selectedModel: string;
  codexServiceTier?: CodexServiceTier;
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
  /** Enables the Codex fast mode split control for eligible ChatGPT subscription models. */
  codexFastModeEnabled?: boolean;
  /** Controlled open state for programmatic toggle (e.g. keyboard shortcut). */
  open?: boolean;
  /** Callback when the open state changes. */
  onOpenChange?: (open: boolean) => void;
  // When true, picker is read-only for the current caller state.
  disabled?: boolean;
  /**
   * When false, the trigger renders only the explicit value. Existing thread
   * composers use this because thread model state comes from event projection,
   * not user/workspace defaults.
   */
  resolveDefaultSelection?: boolean;
  /** Controls which trigger/content primitive backs the model picker. */
  pickerMode?: "select" | "popover";
}

// Radix Select reserves the empty string for "no value" and throws if a
// SelectItem uses it, so use a sentinel to represent the inherit option.
const INHERIT_SENTINEL = "__inherit_default__";

// Radix Select uses the selected item's offsetHeight as the scroll-button
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
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 cursor-help text-xs font-medium text-muted-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:decoration-muted-foreground">
            BYOK
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Uses your configured provider
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ProBadge() {
  return (
    <span className="shrink-0 rounded bg-primary px-1.5 py-0.5 text-[11px] font-medium leading-none text-primary-foreground">
      Pro
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
        !c.startsWith("focus-visible:") &&
        !c.startsWith("active:") &&
        !c.startsWith("data-[state=")
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
    policies.some((policy) => {
      return (
        policy.model === userPreference.selectedModel &&
        policy.routeStatus === "valid"
      );
    })
      ? {
          modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
          selectedModel: userPreference.selectedModel,
        }
      : null;
  const validWorkspaceDefault = policies.find((policy) => {
    return policy.isDefault && policy.routeStatus === "valid";
  });
  return (
    value ??
    validUserDefault ??
    (validWorkspaceDefault
      ? {
          modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
          selectedModel: validWorkspaceDefault.model,
        }
      : null)
  );
}

function modelSelectionAllowedForTier(
  limitedFree1: boolean,
  selectedModel: string | null | undefined,
): boolean {
  return (
    !limitedFree1 || !isLimitedFree1RestrictedRunModel(selectedModel ?? null)
  );
}

function selectablePoliciesForTier(
  policies: OrgModelPolicy[],
  limitedFree1: boolean,
): OrgModelPolicy[] {
  if (!limitedFree1) {
    return policies;
  }
  return policies.filter((policy) => {
    return !isLimitedFree1RestrictedRunModel(policy.model);
  });
}

function selectionAllowedValue(
  value: ModelProviderSelection | null,
  limitedFree1: boolean,
): ModelProviderSelection | null {
  return modelSelectionAllowedForTier(limitedFree1, value?.selectedModel)
    ? value
    : null;
}

function codexFastModeAvailableForModel(
  policies: OrgModelPolicy[],
  selectedModel: string | null | undefined,
): boolean {
  if (!selectedModel || selectedModel !== "gpt-5.5") {
    return false;
  }
  const policy = policies.find((candidate) => {
    return candidate.model === selectedModel;
  });
  return (
    policy?.routeStatus === "valid" &&
    policy.defaultProviderType === "codex-oauth-token"
  );
}

function selectionWithCodexServiceTier(
  selection: ModelProviderSelection | null,
  current: ModelProviderSelection | null,
  policies: OrgModelPolicy[],
  codexFastModeEnabled: boolean,
): ModelProviderSelection | null {
  if (!selection) {
    return null;
  }
  if (
    codexFastModeEnabled &&
    current?.codexServiceTier === "fast" &&
    codexFastModeAvailableForModel(policies, selection.selectedModel)
  ) {
    return { ...selection, codexServiceTier: "fast" };
  }
  return selection;
}

function codexServiceTierForTrigger(
  available: boolean,
  value: ModelProviderSelection | null,
): CodexServiceTier | undefined {
  return available ? value?.codexServiceTier : undefined;
}

function ModelFirstTriggerLabel({
  selectedModel,
  codexServiceTier,
  placeholder,
  mobileIcon,
}: {
  selectedModel: string | null;
  codexServiceTier?: CodexServiceTier;
  placeholder: string;
  mobileIcon: boolean;
}) {
  if (!selectedModel) {
    return (
      <ResponsiveTriggerContent
        mobileIcon={mobileIcon}
        iconType={undefined}
        label={<span>{placeholder}</span>}
      />
    );
  }
  const iconType = getModelFirstIconType(selectedModel);
  return (
    <ResponsiveTriggerContent
      mobileIcon={mobileIcon}
      iconType={iconType}
      label={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">
            {getCanonicalModelDisplayName(selectedModel)}
          </span>
          {codexServiceTier === "fast" && (
            <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded bg-amber-500/10 px-1.5 text-[11px] font-medium leading-none text-amber-700 dark:text-amber-300">
              <IconBolt size={12} stroke={1.8} />
              Fast
            </span>
          )}
        </span>
      }
    />
  );
}

function ModelFirstDisabledPickerLabel({
  value,
  placeholder,
  mobileIconTrigger,
  triggerClassName,
  userPreference,
  policies,
}: Pick<
  ModelProviderPickerProps,
  | "value"
  | "placeholder"
  | "compactTrigger"
  | "mobileIconTrigger"
  | "triggerClassName"
> & {
  placeholder: string;
  compactTrigger: boolean;
  mobileIconTrigger: boolean;
  policies: OrgModelPolicy[];
  userPreference: { selectedModel: string | null } | null | undefined;
}) {
  const resolved = resolveModelFirstDefault(value, userPreference, policies);
  const selectedModel = resolved?.selectedModel ?? null;
  return (
    <span
      aria-label={
        selectedModel
          ? getCanonicalModelDisplayName(selectedModel)
          : placeholder
      }
      className={cn(
        "inline-flex items-center px-2 text-sm text-muted-foreground cursor-default",
        stripInteractiveClasses(triggerClassName),
      )}
    >
      <ModelFirstTriggerLabel
        selectedModel={selectedModel}
        codexServiceTier={resolved?.codexServiceTier}
        placeholder={placeholder}
        mobileIcon={mobileIconTrigger}
      />
    </span>
  );
}

function modelFirstSelectionFromRaw(
  raw: string,
): ModelProviderSelection | null {
  if (raw === INHERIT_SENTINEL) {
    return null;
  }
  return {
    modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
    selectedModel: raw,
  };
}

function ModelFirstPolicyRowContent({
  policy,
  limitedFree1,
  selected = false,
  showSelectedIndicator = false,
}: {
  policy: OrgModelPolicy;
  limitedFree1: boolean;
  selected?: boolean;
  showSelectedIndicator?: boolean;
}) {
  const iconType = getModelFirstIconType(policy.model);
  const builtInPriceTier =
    policy.defaultProviderType === "vm0"
      ? getVm0ModelPriceTier(policy.model)
      : undefined;
  const restricted = !modelSelectionAllowedForTier(limitedFree1, policy.model);
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
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-foreground">
          {selected && <IconCheck size={15} stroke={1.8} />}
        </span>
      )}
    </span>
  );
}

function ModelFirstPolicyRow({
  policy,
  limitedFree1,
}: {
  policy: OrgModelPolicy;
  limitedFree1: boolean;
}) {
  return (
    <SelectItem
      key={policy.id}
      value={policy.model}
      disabled={policy.routeStatus !== "valid"}
    >
      <ModelFirstPolicyRowContent policy={policy} limitedFree1={limitedFree1} />
    </SelectItem>
  );
}

function ModelFirstPolicyOption({
  policy,
  limitedFree1,
  selected,
  onSelect,
}: {
  policy: OrgModelPolicy;
  limitedFree1: boolean;
  selected: boolean;
  onSelect: (model: string) => void;
}) {
  const disabled = policy.routeStatus !== "valid";
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      className="relative flex w-full cursor-pointer select-none items-center rounded-md py-1.5 pl-2 pr-2 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
      onClick={() => {
        onSelect(policy.model);
      }}
    >
      <ModelFirstPolicyRowContent
        policy={policy}
        limitedFree1={limitedFree1}
        selected={selected}
        showSelectedIndicator
      />
    </button>
  );
}

function ModelFirstPolicyItems({
  policies,
  explicitSelectedModel,
  limitedFree1,
  showSeparator = true,
}: {
  policies: OrgModelPolicy[];
  explicitSelectedModel: string | null;
  limitedFree1: boolean;
  showSeparator?: boolean;
}) {
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
          No configured models
        </div>
      ) : (
        <SelectGroup>
          <SelectLabel className="pl-2 pr-8 py-1.5 text-xs font-medium text-muted-foreground">
            Models
          </SelectLabel>
          {policies.map((policy) => {
            return (
              <ModelFirstPolicyRow
                key={policy.id}
                policy={policy}
                limitedFree1={limitedFree1}
              />
            );
          })}
        </SelectGroup>
      )}
    </>
  );
}

function CodexFastModeSplitPanel({
  checked,
  selectedModel,
  onCheckedChange,
}: {
  checked: boolean;
  selectedModel: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  const stopSelectDismiss = (event: SyntheticEvent) => {
    event.stopPropagation();
  };
  return (
    <div className="w-[132px] border-l border-border/70 p-2">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">Run speed</span>
        <span className="truncate text-[11px] text-muted-foreground">
          {getCanonicalModelDisplayName(selectedModel)}
        </span>
      </div>
      <div
        role="group"
        aria-label="Run speed"
        className="grid gap-1.5"
        onClick={stopSelectDismiss}
        onPointerDown={stopSelectDismiss}
      >
        <button
          type="button"
          aria-pressed={!checked}
          className={cn(
            "flex min-h-14 flex-col justify-center rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-gray-50",
            checked
              ? "border-border/70 bg-background text-muted-foreground"
              : "border-border bg-gray-50 text-foreground",
          )}
          onClick={() => {
            onCheckedChange(false);
          }}
        >
          <span className="text-xs font-medium">Standard</span>
          <span className="mt-0.5 text-[11px] leading-3 text-muted-foreground">
            Balanced use
          </span>
        </button>
        <button
          type="button"
          aria-pressed={checked}
          className={cn(
            "flex min-h-14 flex-col justify-center rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-gray-50",
            checked
              ? "border-border bg-gray-50 text-foreground"
              : "border-border/70 bg-background text-muted-foreground",
          )}
          onClick={() => {
            onCheckedChange(true);
          }}
        >
          <span className="inline-flex items-center gap-1 text-xs font-medium">
            <IconBolt size={12} stroke={1.8} />
            Fast
          </span>
          <span className="mt-0.5 text-[11px] leading-3 text-muted-foreground">
            Prioritize speed
          </span>
        </button>
      </div>
      <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
        Uses more Codex credits.
      </p>
    </div>
  );
}

function CodexFastModeSelectControl({
  selectedModel,
  codexServiceTier,
  onChange,
}: {
  selectedModel: string;
  codexServiceTier: CodexServiceTier | undefined;
  onChange: (value: ModelProviderSelection | null) => void;
}) {
  return (
    <CodexFastModeSplitPanel
      checked={codexServiceTier === "fast"}
      selectedModel={selectedModel}
      onCheckedChange={(checked) => {
        onChange({
          modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
          selectedModel,
          ...(checked ? { codexServiceTier: "fast" as const } : {}),
        });
      }}
    />
  );
}

function ModelFirstModelPickerContent({
  selectValue,
  placeholder,
  policies,
  selectableValue,
  limitedFree1,
  codexFastModeAvailable,
  selectedModel,
  codexServiceTier,
  onChange,
}: {
  selectValue: string;
  placeholder: string;
  policies: OrgModelPolicy[];
  selectableValue: ModelProviderSelection | null;
  limitedFree1: boolean;
  codexFastModeAvailable: boolean;
  selectedModel: string | null;
  codexServiceTier: CodexServiceTier | undefined;
  onChange: (value: ModelProviderSelection | null) => void;
}) {
  return (
    <SelectContent
      className={cn(
        "max-h-[280px]",
        codexFastModeAvailable ? "min-w-[372px]" : "min-w-[260px]",
      )}
    >
      <div
        className={cn(
          "min-w-0",
          codexFastModeAvailable && "grid grid-cols-[minmax(0,1fr)_132px]",
        )}
      >
        <div className="min-w-0">
          {selectValue === INHERIT_SENTINEL && (
            <SelectItem
              value={INHERIT_SENTINEL}
              className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
              disabled
              aria-hidden="true"
            >
              {placeholder}
            </SelectItem>
          )}
          <ModelFirstPolicyItems
            policies={policies}
            explicitSelectedModel={selectableValue?.selectedModel ?? null}
            limitedFree1={limitedFree1}
            showSeparator={false}
          />
        </div>
        {codexFastModeAvailable && selectedModel && (
          <CodexFastModeSelectControl
            selectedModel={selectedModel}
            codexServiceTier={codexServiceTier}
            onChange={onChange}
          />
        )}
      </div>
    </SelectContent>
  );
}

function ModelFirstModelPickerPopoverTrigger({
  triggerAriaLabel,
  selectedModel,
  codexServiceTier,
  placeholder,
  mobileIconTrigger,
  triggerClassName,
  open,
}: {
  triggerAriaLabel: string;
  selectedModel: string | null;
  codexServiceTier: CodexServiceTier | undefined;
  placeholder: string;
  mobileIconTrigger: boolean;
  triggerClassName: string | undefined;
  open: boolean;
}) {
  return (
    <PopoverTrigger asChild>
      <button
        type="button"
        role="combobox"
        aria-label={triggerAriaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          "flex h-9 w-full items-center justify-start gap-2 rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=open]:ring-2 data-[state=open]:ring-ring data-[state=open]:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1 [&>span]:w-full [&>span]:text-left",
          triggerClassName,
        )}
      >
        <ModelFirstTriggerLabel
          selectedModel={selectedModel}
          codexServiceTier={codexServiceTier}
          placeholder={placeholder}
          mobileIcon={mobileIconTrigger}
        />
        <IconChevronDown className="h-4 w-4 shrink-0 opacity-50" />
      </button>
    </PopoverTrigger>
  );
}

function ModelFirstModelPickerPopoverContent({
  policies,
  limitedFree1,
  codexFastModeAvailable,
  selectedModel,
  codexServiceTier,
  onSelectModel,
  onChange,
}: {
  policies: OrgModelPolicy[];
  limitedFree1: boolean;
  codexFastModeAvailable: boolean;
  selectedModel: string | null;
  codexServiceTier: CodexServiceTier | undefined;
  onSelectModel: (model: string) => void;
  onChange: (value: ModelProviderSelection | null) => void;
}) {
  return (
    <PopoverContent
      align="end"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
      }}
      onFocusOutside={(event) => {
        event.preventDefault();
      }}
      onInteractOutside={(event) => {
        const originalEvent = (event.detail as { originalEvent?: Event })
          .originalEvent;
        if (originalEvent instanceof FocusEvent) {
          event.preventDefault();
        }
      }}
      className={cn(
        "max-h-[280px] overflow-hidden p-0",
        codexFastModeAvailable ? "min-w-[372px]" : "min-w-[260px]",
      )}
    >
      <div
        className={cn(
          "min-w-0",
          codexFastModeAvailable && "grid grid-cols-[minmax(0,1fr)_132px]",
        )}
      >
        <div
          role="listbox"
          aria-label="Models"
          className="max-h-[280px] min-w-0 overflow-y-auto p-1"
        >
          {policies.length === 0 ? (
            <div className="px-2 py-2 text-sm text-muted-foreground">
              No configured models
            </div>
          ) : (
            <>
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                Models
              </div>
              {policies.map((policy) => {
                return (
                  <PopoverClose key={policy.id} asChild>
                    <ModelFirstPolicyOption
                      policy={policy}
                      limitedFree1={limitedFree1}
                      selected={selectedModel === policy.model}
                      onSelect={onSelectModel}
                    />
                  </PopoverClose>
                );
              })}
            </>
          )}
        </div>
        {codexFastModeAvailable && selectedModel && (
          <CodexFastModeSelectControl
            selectedModel={selectedModel}
            codexServiceTier={codexServiceTier}
            onChange={onChange}
          />
        )}
      </div>
    </PopoverContent>
  );
}

interface ModelFirstModelPickerState {
  policies: OrgModelPolicy[];
  selectablePolicies: OrgModelPolicy[];
  selectableValue: ModelProviderSelection | null;
  selectedModel: string | null;
  codexFastModeAvailable: boolean;
  codexServiceTier: CodexServiceTier | undefined;
  selectValue: string;
  triggerAriaLabel: string;
}

function resolveModelFirstModelPickerState({
  value,
  userPreference,
  policyResponse,
  limitedFree1,
  resolveDefaultSelection,
  codexFastModeEnabled,
  placeholder,
}: {
  value: ModelProviderSelection | null;
  userPreference: { selectedModel: string | null } | null | undefined;
  policyResponse: { policies: OrgModelPolicy[] } | null | undefined;
  limitedFree1: boolean;
  resolveDefaultSelection: boolean;
  codexFastModeEnabled: boolean;
  placeholder: string;
}): ModelFirstModelPickerState {
  const policies = policyResponse?.policies ?? [];
  const selectablePolicies = selectablePoliciesForTier(policies, limitedFree1);
  const selectableValue = selectionAllowedValue(value, limitedFree1);
  const resolved = resolveDefaultSelection
    ? resolveModelFirstDefault(
        selectableValue,
        userPreference,
        selectablePolicies,
      )
    : selectableValue;
  const selectedModel = resolved?.selectedModel ?? null;
  const codexFastModeAvailable =
    codexFastModeEnabled &&
    codexFastModeAvailableForModel(selectablePolicies, selectedModel);
  const codexServiceTier = codexServiceTierForTrigger(
    codexFastModeAvailable,
    value,
  );
  return {
    policies,
    selectablePolicies,
    selectableValue,
    selectedModel,
    codexFastModeAvailable,
    codexServiceTier,
    selectValue:
      selectableValue?.selectedModel ?? selectedModel ?? INHERIT_SENTINEL,
    triggerAriaLabel: selectedModel
      ? getCanonicalModelDisplayName(selectedModel)
      : placeholder,
  };
}

function ModelFirstSelectPicker({
  state,
  placeholder,
  triggerClassName,
  mobileIconTrigger,
  limitedFree1,
  open,
  onOpenChange,
  onValueChange,
  onChange,
}: {
  state: ModelFirstModelPickerState;
  placeholder: string;
  triggerClassName: string | undefined;
  mobileIconTrigger: boolean;
  limitedFree1: boolean;
  open: boolean | undefined;
  onOpenChange: ((open: boolean) => void) | undefined;
  onValueChange: (raw: string) => void;
  onChange: (value: ModelProviderSelection | null) => void;
}) {
  return (
    <Select
      value={state.selectValue}
      onValueChange={onValueChange}
      open={open}
      onOpenChange={onOpenChange}
    >
      <SelectTrigger
        aria-label={state.triggerAriaLabel}
        className={cn("h-9 w-full", triggerClassName)}
      >
        <SelectValue placeholder={placeholder}>
          <ModelFirstTriggerLabel
            selectedModel={state.selectedModel}
            codexServiceTier={state.codexServiceTier}
            placeholder={placeholder}
            mobileIcon={mobileIconTrigger}
          />
        </SelectValue>
      </SelectTrigger>
      <ModelFirstModelPickerContent
        selectValue={state.selectValue}
        placeholder={placeholder}
        policies={state.policies}
        selectableValue={state.selectableValue}
        limitedFree1={limitedFree1}
        codexFastModeAvailable={state.codexFastModeAvailable}
        selectedModel={state.selectedModel}
        codexServiceTier={state.codexServiceTier}
        onChange={onChange}
      />
    </Select>
  );
}

function ModelFirstPopoverPicker({
  state,
  placeholder,
  triggerClassName,
  mobileIconTrigger,
  limitedFree1,
  open,
  onOpenChange,
  onValueChange,
  onChange,
}: {
  state: ModelFirstModelPickerState;
  placeholder: string;
  triggerClassName: string | undefined;
  mobileIconTrigger: boolean;
  limitedFree1: boolean;
  open: boolean | undefined;
  onOpenChange: ((open: boolean) => void) | undefined;
  onValueChange: (raw: string) => void;
  onChange: (value: ModelProviderSelection | null) => void;
}) {
  const popoverOpen = open ?? false;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <ModelFirstModelPickerPopoverTrigger
        triggerAriaLabel={state.triggerAriaLabel}
        selectedModel={state.selectedModel}
        codexServiceTier={state.codexServiceTier}
        placeholder={placeholder}
        mobileIconTrigger={mobileIconTrigger}
        triggerClassName={triggerClassName}
        open={popoverOpen}
      />
      <ModelFirstModelPickerPopoverContent
        policies={state.policies}
        limitedFree1={limitedFree1}
        codexFastModeAvailable={state.codexFastModeAvailable}
        selectedModel={state.selectedModel}
        codexServiceTier={state.codexServiceTier}
        onSelectModel={(model) => {
          onOpenChange?.(false);
          if (model === state.selectValue) {
            return;
          }
          onValueChange(model);
        }}
        onChange={onChange}
      />
    </Popover>
  );
}

function ModelFirstModelPicker({
  value,
  onChange,
  placeholder,
  triggerClassName,
  compactTrigger,
  mobileIconTrigger,
  codexFastModeEnabled = false,
  open,
  onOpenChange,
  disabled,
  userPreference,
  resolveDefaultSelection,
  pickerMode = "select",
}: ModelProviderPickerProps & {
  placeholder: string;
  compactTrigger: boolean;
  mobileIconTrigger: boolean;
  userPreference: { selectedModel: string | null } | null | undefined;
  resolveDefaultSelection: boolean;
}) {
  const policiesLoadable = useLoadable(orgModelPolicies$);
  const billingLoadable = useLoadable(billingStatusAsync$);
  const lastPolicies = useLastResolved(orgModelPolicies$);
  const openBillingPlans = useSet(openBillingPlans$);
  const openOrgManage = useSet(setOrgManageDialogOpen$);
  const pageSignal = useGet(pageSignal$);
  const policyResponse =
    policiesLoadable.state === "hasData" ? policiesLoadable.data : lastPolicies;
  const limitedFree1 =
    billingLoadable.state === "hasData" &&
    billingLoadable.data.tier === "limited-free-1";
  const state = resolveModelFirstModelPickerState({
    value,
    userPreference,
    policyResponse,
    limitedFree1,
    resolveDefaultSelection,
    codexFastModeEnabled,
    placeholder,
  });

  if (disabled) {
    return (
      <ModelFirstDisabledPickerLabel
        value={state.selectableValue}
        placeholder={placeholder}
        compactTrigger={compactTrigger}
        mobileIconTrigger={mobileIconTrigger}
        triggerClassName={triggerClassName}
        userPreference={resolveDefaultSelection ? userPreference : null}
        policies={resolveDefaultSelection ? state.selectablePolicies : []}
      />
    );
  }

  const openComparePlans = () => {
    openBillingPlans();
    detach(openOrgManage(true, pageSignal), Reason.DomCallback);
  };

  const handleRawValueChange = (raw: string) => {
    if (
      raw !== INHERIT_SENTINEL &&
      limitedFree1 &&
      isLimitedFree1RestrictedRunModel(raw)
    ) {
      openComparePlans();
      return;
    }
    onChange(
      selectionWithCodexServiceTier(
        modelFirstSelectionFromRaw(raw),
        value,
        state.selectablePolicies,
        codexFastModeEnabled,
      ),
    );
  };

  if (pickerMode === "popover") {
    return (
      <ModelFirstPopoverPicker
        state={state}
        placeholder={placeholder}
        triggerClassName={triggerClassName}
        mobileIconTrigger={mobileIconTrigger}
        limitedFree1={limitedFree1}
        open={open}
        onOpenChange={onOpenChange}
        onValueChange={handleRawValueChange}
        onChange={onChange}
      />
    );
  }

  return (
    <ModelFirstSelectPicker
      state={state}
      placeholder={placeholder}
      triggerClassName={triggerClassName}
      mobileIconTrigger={mobileIconTrigger}
      limitedFree1={limitedFree1}
      open={open}
      onOpenChange={onOpenChange}
      onValueChange={handleRawValueChange}
      onChange={onChange}
    />
  );
}

function ModelFirstModelPickerWithDefaultSelection(
  props: ModelProviderPickerProps & {
    placeholder: string;
    compactTrigger: boolean;
    mobileIconTrigger: boolean;
  },
) {
  const userPreference = useLastResolved(userModelPreference$);
  return (
    <ModelFirstModelPicker
      {...props}
      userPreference={userPreference}
      resolveDefaultSelection
    />
  );
}

export function ModelProviderPicker({
  value,
  onChange,
  placeholder = "Inherit from org default",
  triggerClassName,
  compactTrigger = false,
  mobileIconTrigger = false,
  codexFastModeEnabled = false,
  open,
  onOpenChange,
  disabled = false,
  resolveDefaultSelection = true,
  pickerMode = "select",
}: ModelProviderPickerProps) {
  const props = {
    value,
    onChange,
    placeholder,
    triggerClassName,
    compactTrigger,
    mobileIconTrigger,
    codexFastModeEnabled,
    open,
    onOpenChange,
    disabled,
    pickerMode,
  };
  if (resolveDefaultSelection) {
    return <ModelFirstModelPickerWithDefaultSelection {...props} />;
  }
  return (
    <ModelFirstModelPicker
      {...props}
      userPreference={null}
      resolveDefaultSelection={false}
    />
  );
}
