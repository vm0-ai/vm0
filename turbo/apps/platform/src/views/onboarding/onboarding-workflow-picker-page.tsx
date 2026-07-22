import { useGet, useSet } from "ccstate-react";
import {
  IconBox,
  IconBriefcase,
  IconChartBar,
  IconCircleCheckFilled,
  IconCode,
  IconMessageCircle,
  IconMessagePlus,
  IconScanEye,
  IconSparkles,
  IconSpeakerphone,
  IconSun,
  IconTrendingUp,
  type Icon,
} from "@tabler/icons-react";
import { cn } from "@vm0/ui";
import {
  onboardingDraft$,
  onboardingUi$,
  updateOnboardingDraft$,
  updateOnboardingUi$,
} from "../../signals/onboarding/onboarding-state.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  CUSTOM_WORKFLOW_ID,
  findOnboardingWorkflow,
  ONBOARDING_WORKFLOW_CATEGORIES,
  type OnboardingWorkflow,
  type OnboardingWorkflowCategory,
  type OnboardingWorkflowCategoryId,
} from "./onboarding-data.ts";
import { OnboardingConnectorIcon } from "./onboarding-connectors.tsx";
import { WorkflowPreviewDiagram } from "./onboarding-workflow-diagram.tsx";
import { useOnboardingNavigation } from "./onboarding-navigation.ts";
import {
  OnboardingDialog,
  OnboardingFooter,
  OnboardingShell,
} from "./onboarding-shell.tsx";

const CATEGORY_ICONS: Readonly<Record<OnboardingWorkflowCategoryId, Icon>> = {
  engineering: IconCode,
  product: IconBox,
  data: IconChartBar,
  marketing: IconSpeakerphone,
  sales: IconTrendingUp,
  support: IconMessageCircle,
  ceo: IconBriefcase,
  operations: IconSun,
  everyone: IconSparkles,
};

export function WorkflowConnectorPills({
  connectorIds,
}: {
  readonly connectorIds: readonly string[];
}) {
  if (connectorIds.length === 0) {
    return (
      <span className="inline-flex min-h-7 items-center rounded-full border border-border bg-muted/30 px-2.5 text-xs font-medium text-muted-foreground">
        No connector required
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5" aria-hidden="true">
      {connectorIds.slice(0, 4).map((connectorId) => {
        return (
          <span
            key={connectorId}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-muted/30"
          >
            <OnboardingConnectorIcon connectorId={connectorId} size={14} />
          </span>
        );
      })}
    </span>
  );
}

export function WorkflowPreview({
  workflow,
  onClose,
  onSelect,
}: {
  readonly workflow: OnboardingWorkflow;
  readonly onClose: () => void;
  readonly onSelect: () => void;
}) {
  const hasDetailSteps = workflow.detailSteps.length > 0;
  const fallbackSteps =
    workflow.steps.length > 0
      ? workflow.steps
      : ["Zero gathers the context", "The workflow completes the task"];
  return (
    <OnboardingDialog
      title={workflow.title}
      description={workflow.description}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="h-9 rounded-[10px] border border-border bg-muted px-4 text-sm font-medium"
            onClick={onClose}
          >
            Got it
          </button>
          <button
            type="button"
            className="h-9 rounded-[10px] bg-primary px-4 text-sm font-medium text-white"
            onClick={onSelect}
          >
            Select this template
          </button>
        </>
      }
    >
      <div className="grid gap-5 sm:grid-cols-[minmax(0,1.15fr)_minmax(240px,0.85fr)]">
        <div className="flex min-h-56 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/20 p-6">
          <WorkflowPreviewDiagram workflow={workflow} />
        </div>
        <div className="space-y-5">
          <section>
            <h3 className="text-sm font-semibold">What it does</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {workflow.scenario}
            </p>
          </section>
          <section>
            <h3 className="text-sm font-semibold">How it works</h3>
            <ol className="mt-2 space-y-2 text-sm leading-5 text-muted-foreground">
              {hasDetailSteps
                ? workflow.detailSteps.map((step, index) => {
                    return (
                      <li key={step.title} className="flex gap-2">
                        <span className="font-medium text-foreground">
                          {index + 1}.
                        </span>
                        <span>
                          <strong className="font-medium text-foreground">
                            {step.title}:{" "}
                          </strong>
                          {step.description}
                        </span>
                      </li>
                    );
                  })
                : fallbackSteps.map((step, index) => {
                    return (
                      <li key={step} className="flex gap-2">
                        <span className="font-medium text-foreground">
                          {index + 1}.
                        </span>
                        <span>{step}</span>
                      </li>
                    );
                  })}
            </ol>
          </section>
        </div>
      </div>
    </OnboardingDialog>
  );
}

function WorkflowCard({
  workflow,
  selected,
  onSelect,
  onPreview,
}: {
  readonly workflow: OnboardingWorkflow;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onPreview: () => void;
}) {
  return (
    <article
      className={cn(
        "relative flex min-h-[143px] min-w-0 flex-col justify-between gap-3.5 rounded-xl border bg-background p-4 text-left shadow-sm transition-all hover:border-primary hover:shadow-md",
        selected && "border-primary shadow-md",
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${workflow.title} ${workflow.description}`}
        className="absolute inset-0 rounded-xl"
        onClick={onSelect}
      />
      <span className="pointer-events-none min-w-0">
        <span className="block truncate pr-5 text-sm font-semibold leading-5">
          {workflow.title}
        </span>
        <span className="mt-1 h-[46px] overflow-hidden text-sm leading-[22.75px] text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
          {workflow.description}
        </span>
      </span>
      <span className="relative z-10 flex items-center justify-between gap-3">
        <WorkflowConnectorPills connectorIds={workflow.connectors} />
        <button
          type="button"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/30 text-muted-foreground hover:border-primary/35 hover:text-primary"
          aria-label="Preview workflow details"
          onClick={onPreview}
        >
          <IconScanEye size={16} stroke={1.6} aria-hidden="true" />
        </button>
      </span>
      {selected ? (
        <IconCircleCheckFilled
          size={18}
          className="absolute right-3 top-3 text-primary"
          aria-hidden="true"
        />
      ) : null}
    </article>
  );
}

function WorkflowOptions({
  category,
  selectedId,
  onSelect,
  onPreview,
}: {
  readonly category: OnboardingWorkflowCategory;
  readonly selectedId: string;
  readonly onSelect: (workflowId: string) => void;
  readonly onPreview: (workflow: OnboardingWorkflow) => void;
}) {
  return (
    <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {category.workflows.map((workflow) => {
        return (
          <WorkflowCard
            key={workflow.id}
            workflow={workflow}
            selected={selectedId === workflow.id}
            onSelect={() => {
              onSelect(workflow.id);
            }}
            onPreview={() => {
              onPreview(workflow);
            }}
          />
        );
      })}
      <button
        type="button"
        aria-pressed={selectedId === CUSTOM_WORKFLOW_ID}
        onClick={() => {
          onSelect(CUSTOM_WORKFLOW_ID);
        }}
        className={cn(
          "flex min-h-[143px] flex-col justify-center gap-2 rounded-xl border border-dashed border-border bg-background p-4 text-left text-muted-foreground transition-all hover:border-primary hover:text-foreground hover:shadow-md",
          selectedId === CUSTOM_WORKFLOW_ID &&
            "border-solid border-primary text-foreground shadow-md",
        )}
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-muted/40 text-primary">
          <IconMessagePlus size={19} aria-hidden="true" />
        </span>
        <span className="text-sm font-semibold text-foreground">
          Talk to Zero and make my own
        </span>
        <span className="text-xs leading-[1.4]">
          Describe what you want and Zero builds it with you.
        </span>
      </button>
    </div>
  );
}

function CategoryOptions({
  onSelect,
}: {
  readonly onSelect: (category: OnboardingWorkflowCategory) => void;
}) {
  return (
    <div className="mt-5 grid grid-cols-2 gap-3.5 sm:grid-cols-3">
      {ONBOARDING_WORKFLOW_CATEGORIES.map((category) => {
        const CategoryIcon = CATEGORY_ICONS[category.id];
        return (
          <button
            key={category.id}
            type="button"
            onClick={() => {
              onSelect(category);
            }}
            className="flex min-h-[130px] min-w-0 flex-col items-start gap-2.5 rounded-xl border border-border bg-background p-4 text-left shadow-sm transition-all hover:border-primary hover:shadow-md"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-muted/40">
              <CategoryIcon size={21} stroke={1.7} aria-hidden="true" />
            </span>
            <span className="text-sm font-semibold">{category.title}</span>
            <span className="text-xs leading-[1.35] text-muted-foreground">
              {category.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function OnboardingWorkflowPickerPage() {
  const draft = useGet(onboardingDraft$);
  const ui = useGet(onboardingUi$);
  const setDraft = useSet(updateOnboardingDraft$);
  const setUi = useSet(updateOnboardingUi$);
  const { navigateTo } = useOnboardingNavigation();
  const previewWorkflow = findOnboardingWorkflow(ui.workflowPreviewId);
  const selectedCategory = ONBOARDING_WORKFLOW_CATEGORIES.find((category) => {
    return category.id === draft.categoryId;
  });
  const selectedWorkflowId =
    draft.workflowId ?? selectedCategory?.workflows[0]?.id ?? "";

  const handleBack = (): void => {
    if (selectedCategory) {
      setDraft({ categoryId: null, workflowId: null });
      return;
    }
    navigateTo(ROUTES.onboarding, {
      updates: { choice: "workflow" },
    });
  };

  const handleContinue = (): void => {
    if (!selectedWorkflowId) {
      return;
    }
    navigateTo(ROUTES.onboardingWorkflowRun, {
      updates: {
        choice: "workflow",
        category: draft.categoryId,
        workflow: selectedWorkflowId,
      },
      remove: ["template"],
    });
  };

  return (
    <>
      <OnboardingShell
        currentStep={2}
        totalSteps={3}
        title={
          selectedCategory
            ? `${selectedCategory.title} workflows`
            : "What do you work on?"
        }
        description={
          selectedCategory
            ? "Ready-to-run setups you can adapt to your tools and goals."
            : "Pick a role to see the workflows that fit. You can switch anytime."
        }
        footer={
          <OnboardingFooter
            onBack={handleBack}
            onPrimary={handleContinue}
            primaryLabel="Continue"
            primaryDisabled={!selectedWorkflowId}
          />
        }
      >
        {selectedCategory ? (
          <WorkflowOptions
            category={selectedCategory}
            selectedId={selectedWorkflowId}
            onSelect={(workflowId) => {
              setDraft({ workflowId });
            }}
            onPreview={(workflow) => {
              setUi({ workflowPreviewId: workflow.id });
            }}
          />
        ) : (
          <CategoryOptions
            onSelect={(category) => {
              setDraft({
                categoryId: category.id,
                workflowId: category.workflows[0]?.id ?? null,
              });
            }}
          />
        )}
      </OnboardingShell>
      {previewWorkflow ? (
        <WorkflowPreview
          workflow={previewWorkflow}
          onClose={() => {
            setUi({ workflowPreviewId: null });
          }}
          onSelect={() => {
            setDraft({ workflowId: previewWorkflow.id });
            setUi({ workflowPreviewId: null });
          }}
        />
      ) : null}
    </>
  );
}
