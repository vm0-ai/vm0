import type { OnboardingChoice } from "../../signals/onboarding/onboarding-state.ts";
import { getCategories } from "../zero-page/zero-ideation-data.ts";

export interface OnboardingMakeOption {
  readonly id: OnboardingChoice;
  readonly title: string;
  readonly description: string;
  readonly imageUrl: string;
}

export const ONBOARDING_MAKE_OPTIONS: readonly OnboardingMakeOption[] = [
  {
    id: "workflow",
    title: "Workflow automation",
    description: "Start from a ready-to-run workflow",
    imageUrl:
      "https://static.vm0.io/web/assets/onboarding/v2-choice-workflow-default_80x80.png",
  },
  {
    id: "presentation",
    title: "Generate a presentation",
    description: "Create slides with speaker notes",
    imageUrl:
      "https://static.vm0.io/web/assets/onboarding/v2-choice-presentation_80x80.png",
  },
  {
    id: "video",
    title: "Video production",
    description: "Turn an idea into a polished video",
    imageUrl:
      "https://static.vm0.io/web/assets/onboarding/v2-choice-video_80x80.png",
  },
  {
    id: "images",
    title: "Generate images",
    description: "Create high-quality illustrations",
    imageUrl:
      "https://static.vm0.io/web/assets/onboarding/v2-choice-images_80x80.png",
  },
  {
    id: "explore",
    title: "Explore on my own",
    description: "Open the workspace and start from scratch",
    imageUrl:
      "https://static.vm0.io/web/assets/onboarding/v2-choice-explore_80x80.png",
  },
];

export interface OnboardingWorkflow {
  readonly id: string;
  readonly categoryId: string;
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly connectors: readonly string[];
}

export interface OnboardingWorkflowCategory {
  readonly id: string;
  readonly title: string;
  readonly workflows: readonly OnboardingWorkflow[];
}

function workflowId(categoryId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return `${categoryId}-${slug}`;
}

export const ONBOARDING_WORKFLOW_CATEGORIES: readonly OnboardingWorkflowCategory[] =
  getCategories({}).map((category) => {
    return {
      id: category.id,
      title: category.title,
      workflows: category.cases.slice(0, 5).map((useCase) => {
        return {
          id: workflowId(category.id, useCase.title),
          categoryId: category.id,
          title: useCase.title,
          description: useCase.description,
          prompt: useCase.prompt,
          connectors: useCase.connectors ?? [],
        };
      }),
    };
  });

export const CUSTOM_WORKFLOW_ID = "custom-workflow";

export function findOnboardingWorkflow(
  workflowIdValue: string | null,
): OnboardingWorkflow | null {
  if (!workflowIdValue || workflowIdValue === CUSTOM_WORKFLOW_ID) {
    return null;
  }
  for (const category of ONBOARDING_WORKFLOW_CATEGORIES) {
    const workflow = category.workflows.find((candidate) => {
      return candidate.id === workflowIdValue;
    });
    if (workflow) {
      return workflow;
    }
  }
  return null;
}

export function buildWorkflowPrompt(
  workflow: OnboardingWorkflow,
  note: string,
): string {
  const trimmedNote = note.trim();
  if (!trimmedNote) {
    return workflow.prompt;
  }
  return `${workflow.prompt}\n\nAdditional context:\n${trimmedNote}`;
}

export function buildCustomWorkflowPrompt(note: string): string {
  const trimmedNote = note.trim();
  if (!trimmedNote) {
    return "";
  }
  return trimmedNote.startsWith("@Zero") ? trimmedNote : `@Zero ${trimmedNote}`;
}
