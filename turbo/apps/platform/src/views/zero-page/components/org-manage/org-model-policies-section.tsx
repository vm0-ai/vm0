// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconAlertTriangle,
  IconDotsVertical,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@vm0/ui";
import {
  MODEL_PROVIDER_TYPES,
  SUPPORTED_RUN_MODELS,
  getCanonicalModelDisplayName,
  getProvidersForModel,
  type ModelProviderResponse,
  type ModelProviderType,
  type OrgModelPolicy,
  type SupportedRunModel,
  type UpdateOrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  orgModelPolicies$,
  updateOrgModelPolicies$,
} from "../../../../signals/external/org-model-policies.ts";
import { orgConfiguredProviders$ } from "../../../../signals/zero-page/settings/org-model-providers.ts";
import {
  closeModelPolicyDialog$,
  modelPolicyApiKey$,
  modelPolicyApiKeyError$,
  modelPolicyApiKeyTouched$,
  markModelPolicyApiKeyTouched$,
  modelPolicyDialogState$,
  openAddModelPolicyDialog$,
  openEditModelPolicyDialog$,
  setModelPolicyApiKey$,
  setModelPolicyApiKeyError$,
  submitModelPolicyApiKeyRoute$,
  updateModelPolicyDialogModel$,
  updateModelPolicyDialogRoute$,
  type ModelPolicyDialogMode,
  type ModelPolicyRouteKind,
} from "../../../../signals/zero-page/settings/org-model-policy-dialog.ts";
import {
  hasTokenInputValue,
  sanitizeTokenInput,
} from "../../../../signals/zero-page/settings/token-input.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  getModelBrandIconType as getModelIconType,
  getUILabel,
  getVm0ModelMultiplier,
} from "../settings/provider-ui-config.ts";
import { ProviderIcon } from "../settings/provider-icons.tsx";

function isOAuthMemberType(type: ModelProviderType): boolean {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function isByokProviderType(type: ModelProviderType): boolean {
  return type !== "vm0" && !isOAuthMemberType(type);
}

function getApiProviderTypes(model: SupportedRunModel): ModelProviderType[] {
  return getProvidersForModel(model).filter((type) => {
    return isByokProviderType(type);
  });
}

function getOAuthProviderTypes(model: SupportedRunModel): ModelProviderType[] {
  return getProvidersForModel(model).filter((type) => {
    return isOAuthMemberType(type);
  });
}

const ZERO_BORDER = {
  border: "0.7px solid hsl(var(--gray-400))",
} as const;

function getOAuthRouteCopy(oauthTypes: ModelProviderType[]): {
  title: string;
  description: string;
} {
  if (oauthTypes.includes("codex-oauth-token")) {
    return {
      title: "Codex subscription",
      description: "Each member connects their own Pro or Team plan.",
    };
  }
  return {
    title: "Claude subscription",
    description: "Each member connects their own Pro, Max, or Team plan.",
  };
}

function getProviderConfig(type: ModelProviderType) {
  return MODEL_PROVIDER_TYPES[type] as
    | { secretLabel?: string; helpText?: string }
    | undefined;
}

function getProviderSecretLabel(type: ModelProviderType): string {
  const config = getProviderConfig(type);
  return config?.secretLabel ?? "API key";
}

function getProviderSecretPlaceholder(type: ModelProviderType): string {
  return `Enter your ${getProviderSecretLabel(type)}`;
}

function getProviderSignupUrl(type: ModelProviderType): string | null {
  const helpText = getProviderConfig(type)?.helpText;
  if (!helpText) {
    return null;
  }
  const match = /https?:\/\/[^\s)]+/.exec(helpText);
  return match ? match[0] : null;
}

function findProviderByType(
  providers: ModelProviderResponse[],
  type: ModelProviderType | null,
): ModelProviderResponse | null {
  if (!type) {
    return null;
  }
  return (
    providers.find((provider) => {
      return provider.type === type;
    }) ?? null
  );
}

function toUpdate(policy: OrgModelPolicy): UpdateOrgModelPolicy {
  return {
    model: policy.model,
    isDefault: policy.isDefault,
    defaultProviderType: policy.defaultProviderType,
    credentialScope: policy.credentialScope,
    modelProviderId: policy.modelProviderId,
  };
}

function makeDefaultPolicy(
  model: SupportedRunModel,
  isDefault: boolean,
): UpdateOrgModelPolicy {
  return {
    model,
    isDefault,
    defaultProviderType: "vm0",
    credentialScope: "org",
    modelProviderId: null,
  };
}

function upsertPolicy(
  policies: OrgModelPolicy[],
  update: UpdateOrgModelPolicy,
): UpdateOrgModelPolicy[] {
  let found = false;
  const updates = policies.map((policy) => {
    if (policy.model !== update.model) {
      return toUpdate(policy);
    }
    found = true;
    return update;
  });
  if (!found) {
    updates.push(update);
  }
  return updates;
}

function removePolicy(
  policies: OrgModelPolicy[],
  model: SupportedRunModel,
): UpdateOrgModelPolicy[] {
  const removed = policies.find((policy) => {
    return policy.model === model;
  });
  const updates = policies.flatMap((policy) => {
    return policy.model === model ? [] : [toUpdate(policy)];
  });
  if (
    removed?.isDefault &&
    !updates.some((policy) => {
      return policy.isDefault;
    }) &&
    updates[0]
  ) {
    return updates.map((policy, index) => {
      return { ...policy, isDefault: index === 0 };
    });
  }
  return updates;
}

function makePolicyDefault(
  policies: OrgModelPolicy[],
  model: SupportedRunModel,
): UpdateOrgModelPolicy[] {
  const selected = policies.find((policy) => {
    return policy.model === model;
  });
  if (!selected) {
    return policies.map(toUpdate);
  }
  return policies.map((policy) => {
    return {
      ...toUpdate(policy),
      isDefault: policy.model === model,
    };
  });
}

function DefaultModelSection({
  policies,
  workspaceDefaultModel,
  disabled,
  onChange,
}: {
  policies: OrgModelPolicy[];
  workspaceDefaultModel: SupportedRunModel | null;
  disabled: boolean;
  onChange: (model: SupportedRunModel) => void;
}) {
  const selectItems = policies.filter((policy) => {
    return policy.routeStatus === "valid";
  });
  const currentDefault = selectItems.some((policy) => {
    return policy.model === workspaceDefaultModel;
  })
    ? (workspaceDefaultModel ?? "")
    : "";

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Default</h3>
      <div
        className="overflow-hidden rounded-xl bg-card"
        style={{ border: "0.7px solid hsl(var(--gray-400))" }}
      >
        <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Default model</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Applied to workspace tasks that do not pick a model.
            </p>
          </div>
          {selectItems.length === 0 ? (
            <span className="shrink-0 text-sm text-muted-foreground">
              No available models
            </span>
          ) : (
            <Select
              value={currentDefault}
              onValueChange={(value) => {
                onChange(value as SupportedRunModel);
              }}
              disabled={disabled}
            >
              <SelectTrigger
                className="h-9 w-full shrink-0 rounded-lg sm:w-[280px]"
                style={{ border: "0.7px solid hsl(var(--gray-400))" }}
              >
                <SelectValue placeholder="Select a default model" />
              </SelectTrigger>
              <SelectContent>
                {selectItems.map((policy) => {
                  const iconType = getModelIconType(policy.model);
                  return (
                    <SelectItem key={policy.id} value={policy.model}>
                      <div className="flex items-center gap-2">
                        {iconType && <ProviderIcon type={iconType} size={16} />}
                        <span>{policy.modelLabel}</span>
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

function getPolicyDetail(policy: OrgModelPolicy): string | null {
  if (policy.routeStatusReason) {
    return policy.routeStatusReason;
  }
  return null;
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

function getSelectedByokProvider(
  policy: OrgModelPolicy,
  providers: ModelProviderResponse[],
): ModelProviderResponse | null {
  if (
    policy.credentialScope !== "org" ||
    !isByokProviderType(policy.defaultProviderType) ||
    !policy.modelProviderId
  ) {
    return null;
  }
  return (
    providers.find((provider) => {
      return provider.id === policy.modelProviderId;
    }) ?? null
  );
}

function getPolicyRouteSummary(
  policy: OrgModelPolicy,
  providers: ModelProviderResponse[],
): { label: string; iconType: ModelProviderType } {
  if (policy.defaultProviderType === "vm0") {
    return {
      label: "Built-in",
      iconType: "vm0",
    };
  }

  const orgProvider = getSelectedByokProvider(policy, providers);
  if (orgProvider) {
    return {
      label: getUILabel(orgProvider.type),
      iconType: orgProvider.type,
    };
  }
  if (
    policy.credentialScope === "member" &&
    isOAuthMemberType(policy.defaultProviderType)
  ) {
    return {
      label: getUILabel(policy.defaultProviderType),
      iconType: policy.defaultProviderType,
    };
  }

  return {
    label: getUILabel(policy.defaultProviderType),
    iconType: policy.defaultProviderType,
  };
}

function PolicyActionsMenu({
  policy,
  disabled,
  canDelete,
  onEdit,
  onDelete,
}: {
  policy: OrgModelPolicy;
  disabled: boolean;
  canDelete: boolean;
  onEdit: (policy: OrgModelPolicy) => void;
  onDelete: (policy: OrgModelPolicy) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-lg text-muted-foreground hover:text-foreground"
          disabled={disabled}
          aria-label={`Actions for ${policy.modelLabel}`}
        >
          <IconDotsVertical size={14} stroke={1.5} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem
          disabled={disabled}
          onSelect={() => {
            onEdit(policy);
          }}
        >
          <IconPencil size={14} stroke={1.5} />
          Edit model
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          disabled={disabled || !canDelete}
          onSelect={() => {
            onDelete(policy);
          }}
        >
          <IconTrash size={14} stroke={1.5} />
          Delete model
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddModelButton({
  hasModels,
  disabled,
  onClick,
}: {
  hasModels: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  if (!hasModels) {
    return null;
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="h-8 gap-2 rounded-lg px-3 text-sm"
      disabled={disabled}
      onClick={onClick}
    >
      <IconPlus size={14} stroke={1.8} />
      Add model
    </Button>
  );
}

function PolicyRow({
  policy,
  providers,
  disabled,
  canDelete,
  onEdit,
  onDelete,
}: {
  policy: OrgModelPolicy;
  providers: ModelProviderResponse[];
  disabled: boolean;
  canDelete: boolean;
  onEdit: (policy: OrgModelPolicy) => void;
  onDelete: (policy: OrgModelPolicy) => void;
}) {
  const detail = getPolicyDetail(policy);
  const routeSummary = getPolicyRouteSummary(policy, providers);
  const modelIconType = getModelIconType(policy.model);
  const builtInMultiplier =
    policy.defaultProviderType === "vm0"
      ? getVm0ModelMultiplier(policy.model)
      : undefined;

  return (
    <div
      data-testid={`org-model-policy-row-${policy.model}`}
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_236px_auto]"
    >
      <div className="flex min-w-0 flex-col justify-center">
        <div className="flex items-center gap-2">
          {modelIconType && <ProviderIcon type={modelIconType} size={18} />}
          <p className="truncate text-sm font-medium text-foreground">
            {policy.modelLabel}
          </p>
          {builtInMultiplier !== undefined && (
            <MultiplierBadge multiplier={builtInMultiplier} />
          )}
          {policy.routeStatus !== "valid" && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              <IconAlertTriangle size={12} />
              {policy.routeStatus === "missing_provider"
                ? "Missing provider"
                : "Invalid route"}
            </span>
          )}
        </div>
        {detail && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {detail}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end sm:order-4">
        <PolicyActionsMenu
          policy={policy}
          disabled={disabled}
          canDelete={canDelete}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </div>
      <div className="col-span-2 flex min-w-0 flex-col justify-center sm:order-3 sm:col-span-1 sm:items-start">
        <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <ProviderIcon type={routeSummary.iconType} size={16} />
          <span className="min-w-0 truncate">{routeSummary.label}</span>
        </div>
      </div>
    </div>
  );
}

function RouteChoiceButton({
  active,
  disabled = false,
  title,
  description,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      style={{
        border: active
          ? "0.7px solid hsl(var(--primary))"
          : "0.7px solid hsl(var(--gray-400))",
      }}
      className={cn(
        "flex flex-col gap-0.5 rounded-xl bg-card px-5 py-4 text-left transition-colors",
        active && "bg-primary/5",
        !active && !disabled && "hover:bg-muted/40",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span className="text-sm font-medium text-foreground">{title}</span>
      <span className="text-[13px] text-muted-foreground">{description}</span>
    </button>
  );
}

function ProviderTypeSelect({
  value,
  types,
  placeholder,
  onChange,
}: {
  value: ModelProviderType | null;
  types: ModelProviderType[];
  placeholder: string;
  onChange: (type: ModelProviderType) => void;
}) {
  if (types.length === 0) {
    return null;
  }

  return (
    <Select
      value={value ?? undefined}
      onValueChange={(next) => {
        onChange(next as ModelProviderType);
      }}
    >
      <SelectTrigger className="h-10 rounded-lg" style={ZERO_BORDER}>
        <SelectValue placeholder={placeholder}>
          {value && (
            <div className="flex min-w-0 items-center gap-2">
              <ProviderIcon type={value} size={16} />
              <span className="min-w-0 truncate">{getUILabel(value)}</span>
            </div>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {types.map((type) => {
          return (
            <SelectItem key={type} value={type}>
              <div className="flex min-w-0 items-center gap-2">
                <ProviderIcon type={type} size={16} />
                <span className="min-w-0 flex-1 truncate">
                  {getUILabel(type)}
                </span>
              </div>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

const MASKED_API_KEY = "••••••••••••••••";

function ApiKeyProviderSection({
  selectedProviderType,
  apiTypes,
  routeProvider,
  apiKeyValue,
  apiKeyTouched,
  apiKeyError,
  onChange,
  onApiKeyChange,
  onApiKeyFocus,
}: {
  selectedProviderType: ModelProviderType | null;
  apiTypes: ModelProviderType[];
  routeProvider: ModelProviderResponse | null;
  apiKeyValue: string;
  apiKeyTouched: boolean;
  apiKeyError: string | null;
  onChange: (type: ModelProviderType) => void;
  onApiKeyChange: (value: string) => void;
  onApiKeyFocus: () => void;
}) {
  const secretLabel = selectedProviderType
    ? getProviderSecretLabel(selectedProviderType)
    : "API key";
  const secretSignupUrl = selectedProviderType
    ? getProviderSignupUrl(selectedProviderType)
    : null;
  const showMaskedExistingKey = Boolean(routeProvider) && !apiKeyTouched;
  const displayedKey = showMaskedExistingKey ? MASKED_API_KEY : apiKeyValue;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-foreground">Provider</label>
        <ProviderTypeSelect
          value={selectedProviderType}
          types={apiTypes}
          placeholder="Select a provider"
          onChange={onChange}
        />
      </div>
      {selectedProviderType && (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground">
            {getUILabel(selectedProviderType)} {secretLabel}
          </label>
          <Input
            type="password"
            autoComplete="off"
            value={displayedKey}
            placeholder={getProviderSecretPlaceholder(selectedProviderType)}
            onFocus={() => {
              if (showMaskedExistingKey) {
                onApiKeyFocus();
              }
            }}
            onChange={(e) => {
              onApiKeyChange(e.target.value);
            }}
            className={apiKeyError ? "h-10 border-destructive" : "h-10"}
          />
          {apiKeyError ? (
            <p className="text-xs text-destructive">{apiKeyError}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Stored in workspace secrets.{" "}
              {secretSignupUrl ? (
                <a
                  href={secretSignupUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline"
                >
                  Get a key
                </a>
              ) : null}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function buildPolicyUpdate(params: {
  policies: OrgModelPolicy[];
  model: SupportedRunModel;
  routeKind: ModelPolicyRouteKind;
  providerType: ModelProviderType | null;
  provider: ModelProviderResponse | null;
}): UpdateOrgModelPolicy | null {
  const existing = params.policies.find((policy) => {
    return policy.model === params.model;
  });
  const base = existing
    ? toUpdate(existing)
    : makeDefaultPolicy(params.model, params.policies.length === 0);

  if (params.routeKind === "built-in") {
    return {
      ...base,
      defaultProviderType: "vm0",
      credentialScope: "org",
      modelProviderId: null,
    };
  }

  if (!params.providerType) {
    return null;
  }

  if (params.routeKind === "oauth") {
    return {
      ...base,
      defaultProviderType: params.providerType,
      credentialScope: "member",
      modelProviderId: null,
    };
  }

  if (!params.provider) {
    return null;
  }

  return {
    ...base,
    defaultProviderType: params.provider.type,
    credentialScope: "org",
    modelProviderId: params.provider.id,
  };
}

function getDialogPrimaryLabel(params: {
  mode: ModelPolicyDialogMode;
}): string {
  return params.mode === "add" ? "Add model" : "Save changes";
}

function isSubmitDisabled(params: {
  selectedModel: SupportedRunModel | null;
  saving: boolean;
  inlineSaving: boolean;
  routeKind: ModelPolicyRouteKind;
  selectedProviderType: ModelProviderType | null;
}): boolean {
  if (!params.selectedModel || params.saving || params.inlineSaving) {
    return true;
  }
  if (params.routeKind === "built-in") {
    return false;
  }
  return params.selectedProviderType === null;
}

function getDefaultProviderTypeForRoute(params: {
  routeKind: ModelPolicyRouteKind;
  apiTypes: ModelProviderType[];
  oauthTypes: ModelProviderType[];
}): ModelProviderType | null {
  if (params.routeKind === "api-key") {
    return params.apiTypes[0] ?? null;
  }
  if (params.routeKind === "oauth") {
    return params.oauthTypes[0] ?? null;
  }
  return null;
}

function getSelectedProviderType(params: {
  routeKind: ModelPolicyRouteKind;
  providerType: ModelProviderType | null;
  apiTypes: ModelProviderType[];
  oauthTypes: ModelProviderType[];
}): ModelProviderType | null {
  if (params.routeKind === "api-key") {
    return params.providerType && params.apiTypes.includes(params.providerType)
      ? params.providerType
      : (params.apiTypes[0] ?? null);
  }
  if (params.routeKind === "oauth") {
    return params.providerType &&
      params.oauthTypes.includes(params.providerType)
      ? params.providerType
      : (params.oauthTypes[0] ?? null);
  }
  return null;
}

function getSelectedRouteProvider(params: {
  routeKind: ModelPolicyRouteKind;
  providerType: ModelProviderType | null;
  providers: ModelProviderResponse[];
}): ModelProviderResponse | null {
  if (params.routeKind === "api-key") {
    return findProviderByType(params.providers, params.providerType);
  }
  return null;
}

function ModelPolicyRouteDialog({
  policies,
  addableModels,
  providers,
  saving,
  onSubmit,
}: {
  policies: OrgModelPolicy[];
  addableModels: SupportedRunModel[];
  providers: ModelProviderResponse[];
  saving: boolean;
  onSubmit: (next: UpdateOrgModelPolicy[]) => void;
}) {
  const dialog = useGet(modelPolicyDialogState$);
  const close = useSet(closeModelPolicyDialog$);
  const setModel = useSet(updateModelPolicyDialogModel$);
  const setRoute = useSet(updateModelPolicyDialogRoute$);
  const apiKeyValue = useGet(modelPolicyApiKey$);
  const apiKeyError = useGet(modelPolicyApiKeyError$);
  const apiKeyTouched = useGet(modelPolicyApiKeyTouched$);
  const setApiKey = useSet(setModelPolicyApiKey$);
  const setApiKeyError = useSet(setModelPolicyApiKeyError$);
  const markApiKeyTouched = useSet(markModelPolicyApiKeyTouched$);
  const pageSignal = useGet(pageSignal$);
  const [inlineSaveLoadable, submitInlineApiKeyRoute] = useLoadableSet(
    submitModelPolicyApiKeyRoute$,
  );
  const inlineSaving = inlineSaveLoadable.state === "loading";
  const busy = saving || inlineSaving;
  const selectedModel = dialog.model ?? addableModels[0] ?? null;
  const apiTypes = selectedModel ? getApiProviderTypes(selectedModel) : [];
  const oauthTypes = selectedModel ? getOAuthProviderTypes(selectedModel) : [];
  const selectedProviderType = getSelectedProviderType({
    routeKind: dialog.routeKind,
    providerType: dialog.providerType,
    apiTypes,
    oauthTypes,
  });
  const routeProvider = getSelectedRouteProvider({
    routeKind: dialog.routeKind,
    providerType: selectedProviderType,
    providers,
  });
  const selectedModelIcon = selectedModel
    ? getModelIconType(selectedModel)
    : null;
  const isReplacingKey = dialog.routeKind === "api-key" && apiKeyTouched;
  const needsFreshKey =
    dialog.routeKind === "api-key" &&
    selectedProviderType !== null &&
    routeProvider === null;

  const chooseRoute = (routeKind: ModelPolicyRouteKind) => {
    setRoute({
      routeKind,
      providerType: getDefaultProviderTypeForRoute({
        routeKind,
        apiTypes,
        oauthTypes,
      }),
    });
  };

  const handleSubmit = () => {
    if (!selectedModel || busy) {
      return;
    }

    if (
      dialog.routeKind === "api-key" &&
      selectedProviderType &&
      (needsFreshKey || isReplacingKey)
    ) {
      if (!hasTokenInputValue(apiKeyValue)) {
        setApiKeyError(
          `${getProviderSecretLabel(selectedProviderType)} is required`,
        );
        return;
      }
      detach(
        submitInlineApiKeyRoute(
          {
            model: selectedModel,
            providerType: selectedProviderType,
            apiKey: sanitizeTokenInput(apiKeyValue),
          },
          pageSignal,
        ),
        Reason.DomCallback,
      );
      return;
    }

    const update = buildPolicyUpdate({
      policies,
      model: selectedModel,
      routeKind: dialog.routeKind,
      providerType: selectedProviderType,
      provider: routeProvider,
    });
    if (!update) {
      return;
    }
    onSubmit(upsertPolicy(policies, update));
    close();
  };

  const primaryLabel = getDialogPrimaryLabel({ mode: dialog.mode });
  const submitDisabled = isSubmitDisabled({
    selectedModel,
    saving,
    inlineSaving,
    routeKind: dialog.routeKind,
    selectedProviderType,
  });

  return (
    <Dialog
      open={dialog.open}
      onOpenChange={(open) => {
        if (!open && !busy) {
          close();
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {dialog.mode === "add" ? "Add model" : "Edit model"}
          </DialogTitle>
          <DialogDescription>
            Decide how members access this model.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-foreground">Model</label>
            <Select
              value={selectedModel ?? undefined}
              onValueChange={(next) => {
                setModel(next as SupportedRunModel);
              }}
              disabled={dialog.mode === "edit"}
            >
              <SelectTrigger className="h-10 rounded-lg" style={ZERO_BORDER}>
                <SelectValue placeholder="Select a model">
                  {selectedModel && (
                    <div className="flex items-center gap-2">
                      {selectedModelIcon && (
                        <ProviderIcon type={selectedModelIcon} size={16} />
                      )}
                      <span>{getCanonicalModelDisplayName(selectedModel)}</span>
                    </div>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {addableModels.map((model) => {
                  const iconType = getModelIconType(model);
                  return (
                    <SelectItem key={model} value={model}>
                      <div className="flex items-center gap-2">
                        {iconType && <ProviderIcon type={iconType} size={16} />}
                        <span>{getCanonicalModelDisplayName(model)}</span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-foreground">
              Provided by
            </label>
            <div
              role="radiogroup"
              aria-label="Provided by"
              className="grid grid-cols-1 gap-3 sm:grid-cols-3"
            >
              <RouteChoiceButton
                active={dialog.routeKind === "built-in"}
                title="Built-in"
                description="Workspace credits cover usage."
                onClick={() => {
                  chooseRoute("built-in");
                }}
              />
              <RouteChoiceButton
                active={dialog.routeKind === "api-key"}
                disabled={apiTypes.length === 0}
                title="API key"
                description="A shared workspace key. Best when the team bills through one account."
                onClick={() => {
                  chooseRoute("api-key");
                }}
              />
              {oauthTypes.length > 0 && (
                <RouteChoiceButton
                  active={dialog.routeKind === "oauth"}
                  title={getOAuthRouteCopy(oauthTypes).title}
                  description={getOAuthRouteCopy(oauthTypes).description}
                  onClick={() => {
                    chooseRoute("oauth");
                  }}
                />
              )}
            </div>
          </div>

          {dialog.routeKind === "api-key" && (
            <ApiKeyProviderSection
              selectedProviderType={selectedProviderType}
              apiTypes={apiTypes}
              routeProvider={routeProvider}
              apiKeyValue={apiKeyValue}
              apiKeyTouched={apiKeyTouched}
              apiKeyError={apiKeyError}
              onChange={(providerType) => {
                setRoute({ routeKind: "api-key", providerType });
              }}
              onApiKeyChange={setApiKey}
              onApiKeyFocus={markApiKeyTouched}
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitDisabled}>
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OrgModelPoliciesSection() {
  const policiesLoadable = useLoadable(orgModelPolicies$);
  const lastPolicies = useLastResolved(orgModelPolicies$);
  const providersLoadable = useLoadable(orgConfiguredProviders$);
  const lastProviders = useLastResolved(orgConfiguredProviders$);
  const pageSignal = useGet(pageSignal$);
  const openAddModelDialog = useSet(openAddModelPolicyDialog$);
  const openEditModelDialog = useSet(openEditModelPolicyDialog$);
  const [updateLoadable, updatePolicies] = useLoadableSet(
    updateOrgModelPolicies$,
  );
  const saving = updateLoadable.state === "loading";

  const data =
    policiesLoadable.state === "hasData" ? policiesLoadable.data : lastPolicies;
  const providers =
    providersLoadable.state === "hasData"
      ? providersLoadable.data
      : (lastProviders ?? []);
  const providersReady =
    providersLoadable.state === "hasData" || lastProviders !== undefined;

  if (
    (!data && policiesLoadable.state === "loading") ||
    (!providersReady && providersLoadable.state === "loading")
  ) {
    return <ModelPoliciesSkeleton />;
  }

  if (!data) {
    return null;
  }

  const policies = data.policies;
  const visiblePolicies = policies.filter((policy) => {
    return SUPPORTED_RUN_MODELS.includes(policy.model);
  });
  const configuredModels = new Set(
    policies.map((policy) => {
      return policy.model;
    }),
  );
  const addableModels = SUPPORTED_RUN_MODELS.filter((model) => {
    return !configuredModels.has(model);
  });

  const submit = (next: UpdateOrgModelPolicy[]) => {
    detach(updatePolicies({ policies: next }, pageSignal), Reason.DomCallback);
  };
  const handleDefaultModelChange = (model: SupportedRunModel) => {
    if (saving || model === data.workspaceDefaultModel) {
      return;
    }
    submit(makePolicyDefault(policies, model));
  };
  const handleOpenAddModel = () => {
    if (saving) {
      return;
    }
    openAddModelDialog(addableModels[0] ?? null);
  };
  const handleEditPolicy = (policy: OrgModelPolicy) => {
    if (saving) {
      return;
    }
    openEditModelDialog(policy);
  };
  const handleDeletePolicy = (policy: OrgModelPolicy) => {
    if (saving || policies.length <= 1) {
      return;
    }
    submit(removePolicy(policies, policy.model));
  };

  return (
    <div className="flex flex-col gap-8">
      <DefaultModelSection
        policies={visiblePolicies}
        workspaceDefaultModel={data.workspaceDefaultModel}
        disabled={saving}
        onChange={handleDefaultModelChange}
      />
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-foreground">Models</h3>
          <AddModelButton
            hasModels={addableModels.length > 0}
            disabled={saving}
            onClick={handleOpenAddModel}
          />
        </div>
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={{ border: "0.7px solid hsl(var(--gray-400))" }}
        >
          <div className="divide-y divide-border/50">
            {visiblePolicies.map((policy) => {
              return (
                <PolicyRow
                  key={policy.id}
                  policy={policy}
                  providers={providers}
                  disabled={false}
                  canDelete={policies.length > 1}
                  onEdit={handleEditPolicy}
                  onDelete={handleDeletePolicy}
                />
              );
            })}
          </div>
        </div>
      </section>
      <ModelPolicyRouteDialog
        policies={policies}
        addableModels={addableModels}
        providers={providers}
        saving={saving}
        onSubmit={submit}
      />
    </div>
  );
}

function ModelPoliciesSkeleton() {
  return (
    <section className="flex flex-col gap-3">
      <div className="h-5 w-24 rounded bg-muted/50 animate-pulse" />
      <div className="overflow-hidden rounded-xl border border-border/50 bg-card">
        {[0, 1, 2].map((item) => {
          return (
            <div key={item} className="flex h-16 items-center gap-3 px-4">
              <div className="h-5 w-9 rounded-full bg-muted/50 animate-pulse" />
              <div className="h-4 w-40 rounded bg-muted/50 animate-pulse" />
            </div>
          );
        })}
      </div>
    </section>
  );
}
