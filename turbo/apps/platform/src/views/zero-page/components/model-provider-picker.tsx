import type { ReactNode, SyntheticEvent } from "react";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { IconBolt, IconCpu } from "@tabler/icons-react";
import {
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
   * Classes applied to the SelectTrigger. Defaults to `h-9 w-full`. The
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

function ModelFirstPolicyRow({
  policy,
  limitedFree1,
}: {
  policy: OrgModelPolicy;
  limitedFree1: boolean;
}) {
  const iconType = getModelFirstIconType(policy.model);
  const builtInPriceTier =
    policy.defaultProviderType === "vm0"
      ? getVm0ModelPriceTier(policy.model)
      : undefined;
  const restricted = !modelSelectionAllowedForTier(limitedFree1, policy.model);
  return (
    <SelectItem
      key={policy.id}
      value={policy.model}
      disabled={policy.routeStatus !== "valid"}
    >
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
      </span>
    </SelectItem>
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
}: ModelProviderPickerProps & {
  placeholder: string;
  compactTrigger: boolean;
  mobileIconTrigger: boolean;
}) {
  const policiesLoadable = useLoadable(orgModelPolicies$);
  const billingLoadable = useLoadable(billingStatusAsync$);
  const lastPolicies = useLastResolved(orgModelPolicies$);
  const userPreference = useLastResolved(userModelPreference$);
  const openBillingPlans = useSet(openBillingPlans$);
  const openOrgManage = useSet(setOrgManageDialogOpen$);
  const pageSignal = useGet(pageSignal$);
  const policyResponse =
    policiesLoadable.state === "hasData" ? policiesLoadable.data : lastPolicies;
  const limitedFree1 =
    billingLoadable.state === "hasData" &&
    billingLoadable.data.tier === "limited-free-1";
  const policies = policyResponse?.policies ?? [];
  const selectablePolicies = selectablePoliciesForTier(policies, limitedFree1);
  const selectableValue = selectionAllowedValue(value, limitedFree1);
  const resolved = resolveModelFirstDefault(
    selectableValue,
    userPreference,
    selectablePolicies,
  );
  const selectedModel = resolved?.selectedModel ?? null;
  const codexFastModeAvailable =
    codexFastModeEnabled &&
    codexFastModeAvailableForModel(selectablePolicies, selectedModel);
  const codexServiceTier = codexServiceTierForTrigger(
    codexFastModeAvailable,
    value,
  );
  const selectValue =
    selectableValue?.selectedModel ?? selectedModel ?? INHERIT_SENTINEL;
  const triggerAriaLabel = selectedModel
    ? getCanonicalModelDisplayName(selectedModel)
    : placeholder;

  if (disabled) {
    return (
      <ModelFirstDisabledPickerLabel
        value={selectableValue}
        placeholder={placeholder}
        compactTrigger={compactTrigger}
        mobileIconTrigger={mobileIconTrigger}
        triggerClassName={triggerClassName}
        userPreference={userPreference}
        policies={selectablePolicies}
      />
    );
  }

  const openComparePlans = () => {
    openBillingPlans();
    detach(openOrgManage(true, pageSignal), Reason.DomCallback);
  };

  return (
    <Select
      value={selectValue}
      onValueChange={(raw) => {
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
            selectablePolicies,
            codexFastModeEnabled,
          ),
        );
      }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <SelectTrigger
        aria-label={triggerAriaLabel}
        className={cn("h-9 w-full", triggerClassName)}
      >
        <SelectValue placeholder={placeholder}>
          <ModelFirstTriggerLabel
            selectedModel={selectedModel}
            codexServiceTier={codexServiceTier}
            placeholder={placeholder}
            mobileIcon={mobileIconTrigger}
          />
        </SelectValue>
      </SelectTrigger>
      <ModelFirstModelPickerContent
        selectValue={selectValue}
        placeholder={placeholder}
        policies={policies}
        selectableValue={selectableValue}
        limitedFree1={limitedFree1}
        codexFastModeAvailable={codexFastModeAvailable}
        selectedModel={selectedModel}
        codexServiceTier={codexServiceTier}
        onChange={onChange}
      />
    </Select>
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
}: ModelProviderPickerProps) {
  return (
    <ModelFirstModelPicker
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      triggerClassName={triggerClassName}
      compactTrigger={compactTrigger}
      mobileIconTrigger={mobileIconTrigger}
      codexFastModeEnabled={codexFastModeEnabled}
      open={open}
      onOpenChange={onOpenChange}
      disabled={disabled}
    />
  );
}
