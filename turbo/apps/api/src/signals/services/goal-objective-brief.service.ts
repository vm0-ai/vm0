import { logger } from "../../lib/log";
import { FAST_PATH_MODEL, generateText } from "../external/openrouter";
import { tapError } from "../utils";
import {
  capGoalObjectiveBriefText,
  compactGoalObjectiveBriefText,
  fallbackGoalObjectiveBrief,
} from "./goal-objective-brief-normalization.service";

const log = logger("api:goal-objective-brief");
const OBJECTIVE_CONTEXT_CHAR_CAP = 4000;
export async function generateGoalObjectiveBrief(
  objective: string,
): Promise<string> {
  const fallback = fallbackGoalObjectiveBrief(objective);
  const generated = await tapError(
    generateText(
      FAST_PATH_MODEL,
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
    (error) => {
      log.warn("Failed to generate goal objective brief", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );

  if (generated === undefined) {
    return fallback;
  }
  if (generated === null) {
    return fallback;
  }

  const brief = capGoalObjectiveBriefText(
    compactGoalObjectiveBriefText(generated),
  );
  return brief.length > 0 ? brief : fallback;
}
