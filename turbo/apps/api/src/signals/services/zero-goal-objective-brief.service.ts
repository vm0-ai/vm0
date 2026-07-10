import { logger } from "../../lib/log";
import { generateText } from "../external/openrouter";
import { settle } from "../utils";
import {
  capGoalObjectiveBriefText,
  compactGoalObjectiveBriefText,
  fallbackGoalObjectiveBrief,
} from "./zero-goal-objective-brief-normalization.service";

const log = logger("api:zero-goal-objective-brief");
const OBJECTIVE_BRIEF_MODEL = "google/gemini-3.1-flash-lite-preview";
const OBJECTIVE_CONTEXT_CHAR_CAP = 4000;
export async function generateGoalObjectiveBrief(
  objective: string,
): Promise<string> {
  const fallback = fallbackGoalObjectiveBrief(objective);
  const generated = await settle(
    generateText(
      OBJECTIVE_BRIEF_MODEL,
      [
        {
          role: "system",
          content:
            "Rewrite the goal objective into a short objective brief. Focus only on what outcome the goal is trying to achieve, not how to execute it. Keep the original language. Return one short sentence or phrase, max 140 characters, as plain text only. No markdown, no quotes.",
        },
        {
          role: "user",
          content: `Objective:\n${objective.slice(0, OBJECTIVE_CONTEXT_CHAR_CAP)}`,
        },
      ],
      80,
    ),
  );

  if (!generated.ok) {
    log.warn("Failed to generate goal objective brief", {
      error:
        generated.error instanceof Error
          ? generated.error.message
          : String(generated.error),
    });
    return fallback;
  }
  if (generated.value === null) {
    return fallback;
  }

  const brief = capGoalObjectiveBriefText(
    compactGoalObjectiveBriefText(generated.value),
  );
  return brief.length > 0 ? brief : fallback;
}
