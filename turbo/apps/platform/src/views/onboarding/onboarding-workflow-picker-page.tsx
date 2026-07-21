import { useGet, useSet } from "ccstate-react";
import {
  IconBriefcase,
  IconCode,
  IconHeadset,
  IconLayoutDashboard,
  IconPalette,
  IconSettingsAutomation,
  IconSpeakerphone,
  IconUsers,
  type Icon,
} from "@tabler/icons-react";
import { cn } from "@vm0/ui";
import {
  onboardingDraft$,
  updateOnboardingDraft$,
} from "../../signals/onboarding/onboarding-state.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  CUSTOM_WORKFLOW_ID,
  ONBOARDING_WORKFLOW_CATEGORIES,
  type OnboardingWorkflowCategory,
} from "./onboarding-data.ts";
import { useOnboardingNavigation } from "./onboarding-navigation.ts";
import { OnboardingFooter, OnboardingShell } from "./onboarding-shell.tsx";

const CATEGORY_ICONS: readonly Icon[] = [
  IconCode,
  IconLayoutDashboard,
  IconSpeakerphone,
  IconPalette,
  IconBriefcase,
  IconHeadset,
  IconSettingsAutomation,
  IconUsers,
];

function WorkflowOptions({
  category,
  selectedId,
  onSelect,
}: {
  readonly category: OnboardingWorkflowCategory;
  readonly selectedId: string | null;
  readonly onSelect: (workflowId: string) => void;
}) {
  return (
    <div className="space-y-3" role="radiogroup" aria-label="Workflows">
      <button
        type="button"
        role="radio"
        aria-checked={selectedId === CUSTOM_WORKFLOW_ID}
        onClick={() => {
          onSelect(CUSTOM_WORKFLOW_ID);
        }}
        className={cn(
          "flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-[hsl(var(--gray-50))]",
          selectedId === CUSTOM_WORKFLOW_ID
            ? "border-primary ring-2 ring-primary/15"
            : "border-border",
        )}
      >
        <IconSettingsAutomation
          size={20}
          stroke={1.6}
          className="mt-0.5 shrink-0 text-primary"
          aria-hidden="true"
        />
        <span>
          <span className="block text-sm font-medium">
            Build my own workflow
          </span>
          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
            Describe the outcome and let Zero design the workflow with you.
          </span>
        </span>
      </button>
      {category.workflows.map((workflow) => {
        const selected = selectedId === workflow.id;
        return (
          <button
            key={workflow.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => {
              onSelect(workflow.id);
            }}
            className={cn(
              "flex w-full items-start justify-between gap-4 rounded-lg border p-4 text-left transition-colors hover:bg-[hsl(var(--gray-50))]",
              selected
                ? "border-primary ring-2 ring-primary/15"
                : "border-border",
            )}
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                {workflow.title}
              </span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                {workflow.description}
              </span>
            </span>
            <span className="shrink-0 rounded-md bg-[hsl(var(--gray-100))] px-2 py-1 text-xs text-muted-foreground">
              {workflow.connectors.length === 0
                ? "No tools"
                : `${workflow.connectors.length} tools`}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CategoryOptions({
  onSelect,
}: {
  readonly onSelect: (categoryId: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {ONBOARDING_WORKFLOW_CATEGORIES.map((category, index) => {
        const CategoryIcon =
          CATEGORY_ICONS[index % CATEGORY_ICONS.length] ?? IconBriefcase;
        return (
          <button
            key={category.id}
            type="button"
            onClick={() => {
              onSelect(category.id);
            }}
            className="flex min-h-20 items-center gap-3 rounded-lg border border-border p-4 text-left transition-colors hover:border-[hsl(var(--gray-500))] hover:bg-[hsl(var(--gray-50))]"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--gray-100))]">
              <CategoryIcon size={19} stroke={1.6} aria-hidden="true" />
            </span>
            <span>
              <span className="block text-sm font-medium">
                {category.title}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {category.workflows.length} starting points
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function OnboardingWorkflowPickerPage() {
  const draft = useGet(onboardingDraft$);
  const setDraft = useSet(updateOnboardingDraft$);
  const { navigateTo } = useOnboardingNavigation();
  const selectedCategory = ONBOARDING_WORKFLOW_CATEGORIES.find((category) => {
    return category.id === draft.categoryId;
  });

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
    if (!draft.workflowId) {
      return;
    }
    navigateTo(ROUTES.onboardingWorkflowRun, {
      updates: {
        choice: "workflow",
        category: draft.categoryId,
        workflow: draft.workflowId,
      },
      remove: ["template"],
    });
  };

  return (
    <OnboardingShell
      currentStep={2}
      totalSteps={3}
      title={
        selectedCategory
          ? `Choose a workflow for ${selectedCategory.title.toLowerCase()}`
          : "What kind of work should Zero start with?"
      }
      description={
        selectedCategory
          ? "Select a workflow to review its tools and customize the first run."
          : "Choose the area closest to your day-to-day work."
      }
      footer={
        <OnboardingFooter
          onBack={handleBack}
          onPrimary={handleContinue}
          primaryLabel="Continue"
          primaryDisabled={!draft.workflowId}
        />
      }
    >
      {selectedCategory ? (
        <WorkflowOptions
          category={selectedCategory}
          selectedId={draft.workflowId}
          onSelect={(workflowId) => {
            setDraft({ workflowId });
          }}
        />
      ) : (
        <CategoryOptions
          onSelect={(categoryId) => {
            setDraft({ categoryId, workflowId: null });
          }}
        />
      )}
    </OnboardingShell>
  );
}
