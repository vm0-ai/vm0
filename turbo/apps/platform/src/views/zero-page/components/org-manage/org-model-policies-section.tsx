// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconArrowDown,
  IconArrowUp,
  IconAlertTriangle,
} from "@tabler/icons-react";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  cn,
} from "@vm0/ui";
import {
  getProvidersForModel,
  type ModelProviderResponse,
  type ModelProviderType,
  type OrgModelPolicy,
  type UpdateOrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  orgModelPolicies$,
  updateOrgModelPolicies$,
} from "../../../../signals/external/org-model-policies.ts";
import { orgConfiguredProviders$ } from "../../../../signals/zero-page/settings/org-model-providers.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { getUILabel } from "../settings/provider-ui-config.ts";
import { ProviderIcon } from "../settings/provider-icons.tsx";

type RouteScope = "org" | "member";

interface RouteOption {
  value: string;
  label: string;
  type: ModelProviderType;
  credentialScope: RouteScope;
  modelProviderId: string | null;
}

function isOAuthMemberType(type: ModelProviderType): boolean {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function routeValue(params: {
  credentialScope: RouteScope;
  type: ModelProviderType;
  modelProviderId: string | null;
}): string {
  return [
    params.credentialScope,
    params.type,
    params.modelProviderId ?? "none",
  ].join(":");
}

function parseRouteValue(value: string): {
  credentialScope: RouteScope;
  type: ModelProviderType;
  modelProviderId: string | null;
} {
  const [credentialScope, type, modelProviderId] = value.split(":");
  return {
    credentialScope: credentialScope === "member" ? "member" : "org",
    type: type as ModelProviderType,
    modelProviderId:
      modelProviderId === "none" ? null : (modelProviderId ?? null),
  };
}

function buildRouteOptions(
  policy: OrgModelPolicy,
  providers: ModelProviderResponse[],
): RouteOption[] {
  const compatibleTypes = new Set(getProvidersForModel(policy.model));
  const options: RouteOption[] = [
    {
      value: routeValue({
        credentialScope: "org",
        type: "vm0",
        modelProviderId: null,
      }),
      label: "Built-in",
      type: "vm0",
      credentialScope: "org",
      modelProviderId: null,
    },
  ];

  for (const provider of providers) {
    if (
      provider.type === "vm0" ||
      isOAuthMemberType(provider.type) ||
      !compatibleTypes.has(provider.type)
    ) {
      continue;
    }
    options.push({
      value: routeValue({
        credentialScope: "org",
        type: provider.type,
        modelProviderId: provider.id,
      }),
      label: getUILabel(provider.type),
      type: provider.type,
      credentialScope: "org",
      modelProviderId: provider.id,
    });
  }

  for (const type of compatibleTypes) {
    if (!isOAuthMemberType(type)) {
      continue;
    }
    options.push({
      value: routeValue({
        credentialScope: "member",
        type,
        modelProviderId: null,
      }),
      label: `${getUILabel(type)} member OAuth`,
      type,
      credentialScope: "member",
      modelProviderId: null,
    });
  }

  const selectedValue = routeValue({
    credentialScope: policy.credentialScope,
    type: policy.defaultProviderType,
    modelProviderId: policy.modelProviderId,
  });
  if (
    !options.some((option) => {
      return option.value === selectedValue;
    })
  ) {
    options.push({
      value: selectedValue,
      label: "Missing provider",
      type: policy.defaultProviderType,
      credentialScope: policy.credentialScope,
      modelProviderId: policy.modelProviderId,
    });
  }

  return options;
}

function toUpdate(policy: OrgModelPolicy): UpdateOrgModelPolicy {
  return {
    model: policy.model,
    enabled: policy.enabled,
    sortOrder: policy.sortOrder,
    defaultProviderType: policy.defaultProviderType,
    credentialScope: policy.credentialScope,
    modelProviderId: policy.modelProviderId,
  };
}

function normalizeSortOrder(
  policies: UpdateOrgModelPolicy[],
): UpdateOrgModelPolicy[] {
  return policies.map((policy, index) => {
    return { ...policy, sortOrder: index };
  });
}

function replacePolicy(
  policies: OrgModelPolicy[],
  model: string,
  updater: (policy: UpdateOrgModelPolicy) => UpdateOrgModelPolicy,
): UpdateOrgModelPolicy[] {
  return normalizeSortOrder(
    policies.map((policy) => {
      const update = toUpdate(policy);
      return policy.model === model ? updater(update) : update;
    }),
  );
}

function movePolicy(
  policies: OrgModelPolicy[],
  index: number,
  direction: -1 | 1,
): UpdateOrgModelPolicy[] {
  const next = policies.map(toUpdate);
  const target = index + direction;
  if (target < 0 || target >= next.length) {
    return next;
  }
  const [item] = next.splice(index, 1);
  if (!item) {
    return next;
  }
  next.splice(target, 0, item);
  return normalizeSortOrder(next);
}

export function OrgModelPoliciesSection() {
  const policiesLoadable = useLoadable(orgModelPolicies$);
  const providersLoadable = useLoadable(orgConfiguredProviders$);
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updatePolicies] = useLoadableSet(
    updateOrgModelPolicies$,
  );
  const saving = updateLoadable.state === "loading";

  if (
    policiesLoadable.state === "loading" ||
    providersLoadable.state === "loading"
  ) {
    return <ModelPoliciesSkeleton />;
  }

  if (policiesLoadable.state !== "hasData") {
    return null;
  }

  const data = policiesLoadable.data;
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  const policies = data.policies;

  const submit = (next: UpdateOrgModelPolicy[]) => {
    detach(updatePolicies(next, pageSignal), Reason.DomCallback);
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">Models</h3>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Workspace default:{" "}
            <span className="font-medium text-foreground">
              {data.workspaceDefaultModel ?? "None"}
            </span>
          </p>
        </div>
        {saving && (
          <span className="text-xs text-muted-foreground">Saving...</span>
        )}
      </div>

      <div
        className="overflow-hidden rounded-xl bg-card"
        style={{ border: "0.7px solid hsl(var(--gray-400))" }}
      >
        <div className="divide-y divide-border/50">
          {policies.map((policy, index) => {
            const options = buildRouteOptions(policy, providers);
            const selectedValue = routeValue({
              credentialScope: policy.credentialScope,
              type: policy.defaultProviderType,
              modelProviderId: policy.modelProviderId,
            });
            return (
              <div
                key={policy.id}
                className={cn(
                  "grid grid-cols-[auto_minmax(0,1fr)] gap-3 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_minmax(220px,280px)_auto]",
                  !policy.enabled && "bg-muted/20",
                )}
              >
                <div className="flex items-center pt-1">
                  <Switch
                    checked={policy.enabled}
                    onCheckedChange={(enabled) => {
                      submit(
                        replacePolicy(policies, policy.model, (current) => {
                          return { ...current, enabled };
                        }),
                      );
                    }}
                    aria-label={`Enable ${policy.modelLabel}`}
                  />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">
                      {policy.modelLabel}
                    </p>
                    {policy.routeStatus !== "valid" && (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                        <IconAlertTriangle size={12} />
                        {policy.routeStatus === "missing_provider"
                          ? "Missing provider"
                          : "Invalid route"}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {policy.routeStatusReason ?? `Rank ${policy.sortOrder + 1}`}
                  </p>
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <Select
                    value={selectedValue}
                    onValueChange={(value) => {
                      const route = parseRouteValue(value);
                      submit(
                        replacePolicy(policies, policy.model, (current) => {
                          return {
                            ...current,
                            defaultProviderType: route.type,
                            credentialScope: route.credentialScope,
                            modelProviderId: route.modelProviderId,
                          };
                        }),
                      );
                    }}
                    disabled={!policy.enabled}
                  >
                    <SelectTrigger className="h-9 w-full rounded-lg">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((option) => {
                        return (
                          <SelectItem key={option.value} value={option.value}>
                            <div className="flex items-center gap-2">
                              <ProviderIcon type={option.type} size={16} />
                              <span>{option.label}</span>
                            </div>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2 flex items-center justify-end gap-1 sm:col-span-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-lg"
                    disabled={index === 0}
                    aria-label={`Move ${policy.modelLabel} up`}
                    onClick={() => {
                      submit(movePolicy(policies, index, -1));
                    }}
                  >
                    <IconArrowUp size={15} />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-lg"
                    disabled={index === policies.length - 1}
                    aria-label={`Move ${policy.modelLabel} down`}
                    onClick={() => {
                      submit(movePolicy(policies, index, 1));
                    }}
                  >
                    <IconArrowDown size={15} />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
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
