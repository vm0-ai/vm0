import type {
  OfficialWorkflowCatalogDetail,
  OfficialWorkflowCatalogSummary,
} from "@okouai/api-contracts/contracts/official-workflows";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  ArrowLeft,
  BadgeCheck,
  Bot,
  Layers3,
  Loader2,
  RotateCcw,
  Search,
} from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@okouai/ui";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@okouai/ui/components/ui/alert";
import { toast } from "@okouai/ui/components/ui/sonner";
import { useTranslation } from "react-i18next";

import { i18n } from "../../i18n/index.ts";
import { agents$, defaultAgentId$ } from "../../signals/agent.ts";
import { activeRoute$ } from "../../signals/active-route.ts";
import { brandName$ } from "../../signals/branding.ts";
import {
  currentOfficialWorkflowDefinition$,
  installOfficialWorkflow$,
  officialWorkflowCatalog$,
  officialWorkflowConfigurationForm$,
  officialWorkflowSearch$,
  reloadOfficialWorkflows$,
  setOfficialWorkflowConfigurationForm$,
  setOfficialWorkflowSearch$,
} from "../../signals/workflows-page/official-workflows-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { userPreferences$ } from "../../signals/okou-page/settings/user-preferences.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import {
  DetailPageBreadcrumbBar,
  DetailPageHeader,
  DetailPageMain,
  DetailPageShell,
} from "../components/detail-page-layout.tsx";
import {
  createOfficialWorkflowConfigurationForm,
  OfficialWorkflowConfigurationFields,
  officialWorkflowConfigurationComplete,
} from "./official-workflow-configuration.tsx";

function OfficialBadge() {
  return (
    <span className="inline-flex w-fit items-center gap-1 rounded-full bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700">
      <BadgeCheck size={13} />
      {i18n.t(($) => {
        return $.workflows.official.badge;
      })}
    </span>
  );
}

function CatalogLoading() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {[0, 1, 2, 3].map((index) => {
        return (
          <div
            key={index}
            className="zero-card h-52 animate-pulse bg-muted/40"
          />
        );
      })}
    </div>
  );
}

function CatalogError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <div className="zero-card flex min-h-[20rem] flex-col items-center justify-center px-6 text-center">
      <RotateCcw size={28} className="text-muted-foreground" />
      <h2 className="mt-4 text-sm font-semibold text-foreground">
        {i18n.t(($) => {
          return $.workflows.official.loadErrorTitle;
        })}
      </h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        {i18n.t(($) => {
          return $.workflows.official.loadErrorDescription;
        })}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="zero-btn-morandi mt-4"
        onClick={onRetry}
      >
        {i18n.t(($) => {
          return $.workflows.official.retry;
        })}
      </Button>
    </div>
  );
}

function OfficialWorkflowCard({
  workflow,
}: {
  readonly workflow: OfficialWorkflowCatalogSummary;
}) {
  return (
    <article className="zero-card flex min-h-52 flex-col overflow-hidden transition-colors hover:bg-state-hover">
      {workflow.presentation.coverImageUrl ? (
        <img
          src={workflow.presentation.coverImageUrl}
          alt=""
          className="h-28 w-full border-b border-border/60 object-cover"
        />
      ) : null}
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-3">
          <OfficialBadge />
          {workflow.presentation.category ? (
            <span className="rounded-full bg-gray-50 px-2 py-1 text-[11px] text-muted-foreground">
              {workflow.presentation.category}
            </span>
          ) : null}
        </div>
        <h2 className="mt-3 text-base font-semibold text-foreground">
          {workflow.displayName}
        </h2>
        <p className="mt-1 line-clamp-3 text-sm leading-relaxed text-muted-foreground">
          {workflow.presentation.marketingCopy ?? workflow.description}
        </p>
        <div className="mt-auto flex items-center justify-between gap-3 pt-4">
          <span className="text-xs text-muted-foreground">
            {i18n.t(
              ($) => {
                return $.workflows.official.automationCount;
              },
              { count: workflow.blueprints.length },
            )}
          </span>
          <Button asChild type="button" size="sm" className="h-9 rounded-lg">
            <Link
              pathname={ROUTES.officialWorkflowDetail}
              options={{ pathParams: { definitionName: workflow.name } }}
            >
              {i18n.t(($) => {
                return $.workflows.official.viewAndInstall;
              })}
            </Link>
          </Button>
        </div>
      </div>
    </article>
  );
}

function OfficialWorkflowCatalogPage() {
  const catalogLoadable = useLoadable(officialWorkflowCatalog$);
  const search = useGet(officialWorkflowSearch$);
  const setSearch = useSet(setOfficialWorkflowSearch$);
  const reload = useSet(reloadOfficialWorkflows$);
  const query = search.trim().toLocaleLowerCase();
  const workflows =
    catalogLoadable.state === "hasData"
      ? catalogLoadable.data.filter((workflow) => {
          return (
            !query ||
            workflow.displayName.toLocaleLowerCase().includes(query) ||
            workflow.description.toLocaleLowerCase().includes(query) ||
            workflow.presentation.category?.toLocaleLowerCase().includes(query)
          );
        })
      : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 px-4 pb-0 pt-3 sm:px-6 md:pb-3 md:pt-10">
        <div className="mx-auto max-w-[900px]">
          <Link
            pathname={ROUTES.workflows}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft size={14} />
            {i18n.t(($) => {
              return $.workflows.common.workflows;
            })}
          </Link>
          <div className="mt-4 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-foreground">
                {i18n.t(($) => {
                  return $.workflows.official.title;
                })}
              </h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {i18n.t(($) => {
                  return $.workflows.official.description;
                })}
              </p>
            </div>
            <div className="relative w-full sm:w-72">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={search}
                onChange={(event) => {
                  setSearch(event.currentTarget.value);
                }}
                className="h-9 pl-9"
                placeholder={i18n.t(($) => {
                  return $.workflows.official.search;
                })}
                aria-label={i18n.t(($) => {
                  return $.workflows.official.search;
                })}
              />
            </div>
          </div>
        </div>
      </header>
      <main className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6">
        <div className="mx-auto max-w-[900px]">
          {catalogLoadable.state === "loading" ? <CatalogLoading /> : null}
          {catalogLoadable.state === "hasError" ? (
            <CatalogError onRetry={reload} />
          ) : null}
          {catalogLoadable.state === "hasData" && workflows.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {workflows.map((workflow) => {
                return (
                  <OfficialWorkflowCard
                    key={workflow.name}
                    workflow={workflow}
                  />
                );
              })}
            </div>
          ) : null}
          {catalogLoadable.state === "hasData" && workflows.length === 0 ? (
            <div className="zero-card flex min-h-[20rem] flex-col items-center justify-center px-6 text-center">
              <Layers3 size={28} className="text-muted-foreground" />
              <h2 className="mt-4 text-sm font-semibold text-foreground">
                {i18n.t(($) => {
                  return query
                    ? $.workflows.official.noResults
                    : $.workflows.official.empty;
                })}
              </h2>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function InstallDialog({
  definition,
}: {
  readonly definition: OfficialWorkflowCatalogDetail;
}) {
  const form = useGet(officialWorkflowConfigurationForm$);
  const setForm = useSet(setOfficialWorkflowConfigurationForm$);
  const agentsLoadable = useLoadable(agents$);
  const pageSignal = useGet(pageSignal$);
  const navigate = useSet(detachedNavigateTo$);
  const [installLoadable, install] = useLoadableSet(installOfficialWorkflow$);
  const installing = installLoadable.state === "loading";
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];
  const open = form?.definitionName === definition.name;
  const complete = form
    ? officialWorkflowConfigurationComplete(form, definition.blueprints)
    : false;
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setForm(null);
        }
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle>
            {i18n.t(
              ($) => {
                return $.workflows.official.installTitle;
              },
              { name: definition.displayName },
            )}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.workflows.official.installDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        {form ? (
          <OfficialWorkflowConfigurationFields
            form={form}
            blueprints={definition.blueprints}
            agents={agents}
            agentsLoaded={agentsLoadable.state === "hasData"}
            showAgent
            disabled={installing}
          />
        ) : null}
        {installLoadable.state === "hasError" ? (
          <Alert variant="destructive">
            <AlertTitle>
              {i18n.t(($) => {
                return $.workflows.official.installErrorTitle;
              })}
            </AlertTitle>
            <AlertDescription>
              {i18n.t(($) => {
                return $.workflows.official.installErrorDescription;
              })}
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={installing}
            onClick={() => {
              setForm(null);
            }}
          >
            {i18n.t(($) => {
              return $.workflows.common.cancel;
            })}
          </Button>
          <Button
            type="button"
            disabled={!form || !complete || installing}
            onClick={() => {
              if (!form) {
                return;
              }
              detach(
                (async () => {
                  const result = await install(
                    {
                      definitionName: definition.name,
                      agentId: form.agentId,
                      blueprints: form.blueprints,
                    },
                    pageSignal,
                  );
                  setForm(null);
                  toast.success(
                    i18n.t(($) => {
                      return $.workflows.official.installed;
                    }),
                  );
                  navigate(ROUTES.workflowDetailAutomations, {
                    pathParams: { workflowId: result.workflow.id },
                  });
                })(),
                Reason.DomCallback,
                "install Official Workflow",
              );
            }}
          >
            {installing ? <Loader2 size={14} className="animate-spin" /> : null}
            {i18n.t(($) => {
              return $.workflows.official.install;
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OfficialWorkflowDefinitionPage() {
  const definitionLoadable = useLoadable(currentOfficialWorkflowDefinition$);
  const defaultAgentId = useLastResolved(defaultAgentId$) ?? "";
  const preferences = useLastResolved(userPreferences$);
  const setForm = useSet(setOfficialWorkflowConfigurationForm$);
  const reload = useSet(reloadOfficialWorkflows$);
  const definition =
    definitionLoadable.state === "hasData" ? definitionLoadable.data : null;
  const lifecycle = definition?.lifecycle ?? "active";
  const userTimezone =
    preferences?.timezone ??
    new Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <DetailPageShell>
      <DetailPageBreadcrumbBar>
        <Link
          pathname={ROUTES.officialWorkflows}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft size={14} />
          {i18n.t(($) => {
            return $.workflows.official.title;
          })}
        </Link>
      </DetailPageBreadcrumbBar>
      <DetailPageHeader>
        {definition ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <OfficialBadge />
              <h1 className="mt-3 text-xl font-semibold text-foreground">
                {definition.displayName}
              </h1>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {definition.presentation.marketingCopy ??
                  definition.description}
              </p>
            </div>
            {lifecycle === "active" ? (
              <Button
                type="button"
                className="zero-btn-morandi h-9 shrink-0 gap-2 rounded-lg"
                onClick={() => {
                  setForm(
                    createOfficialWorkflowConfigurationForm({
                      definitionName: definition.name,
                      agentId: defaultAgentId,
                      blueprints: definition.blueprints,
                      userTimezone,
                    }),
                  );
                }}
              >
                <Bot size={14} />
                {i18n.t(($) => {
                  return $.workflows.official.install;
                })}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="h-20 animate-pulse rounded-2xl bg-muted/40" />
        )}
      </DetailPageHeader>
      <DetailPageMain>
        {definitionLoadable.state === "loading" ? <CatalogLoading /> : null}
        {definitionLoadable.state === "hasError" ? (
          <CatalogError onRetry={reload} />
        ) : null}
        {definitionLoadable.state === "hasData" && !definition ? (
          <div className="zero-card flex min-h-[20rem] items-center justify-center px-6 text-sm text-muted-foreground">
            {i18n.t(($) => {
              return $.workflows.official.notFound;
            })}
          </div>
        ) : null}
        {definition ? (
          <div className="mx-auto flex max-w-[900px] flex-col gap-4">
            {lifecycle === "retired" ? (
              <Alert>
                <AlertTitle>
                  {i18n.t(($) => {
                    return $.workflows.official.retiredTitle;
                  })}
                </AlertTitle>
                <AlertDescription>
                  {i18n.t(($) => {
                    return $.workflows.official.retiredDefinitionDescription;
                  })}
                </AlertDescription>
              </Alert>
            ) : null}
            <section className="zero-card p-5">
              <h2 className="text-sm font-semibold text-foreground">
                {i18n.t(($) => {
                  return $.workflows.official.includedAutomations;
                })}
              </h2>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {definition.blueprints.map((blueprint) => {
                  return (
                    <div
                      key={blueprint.key}
                      className="rounded-2xl border-[0.7px] border-border bg-gray-50 p-4"
                    >
                      <p className="text-sm font-medium text-foreground">
                        {blueprint.key}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {i18n.t(
                          ($) => {
                            return $.workflows.official.parameterCount;
                          },
                          { count: blueprint.parameters.length },
                        )}
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        ) : null}
      </DetailPageMain>
      {definition ? <InstallDialog definition={definition} /> : null}
    </DetailPageShell>
  );
}

export function OfficialWorkflowsPage() {
  const { t } = useTranslation();
  const brandName = useGet(brandName$);
  const route = useGet(activeRoute$);
  return (
    <>
      <title>{`${t(($) => {
        return $.workflows.official.title;
      })} | ${brandName}`}</title>
      {route === "officialWorkflowDetail" ? (
        <OfficialWorkflowDefinitionPage />
      ) : (
        <OfficialWorkflowCatalogPage />
      )}
    </>
  );
}
