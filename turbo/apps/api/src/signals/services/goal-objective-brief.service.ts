import { FAST_PATH_MODEL, generateText } from "../external/openrouter";
import { generateAuxiliary } from "./auxiliary-generation.service";
import {
  capGoalObjectiveBriefText,
  compactGoalObjectiveBriefText,
  fallbackGoalObjectiveBrief,
} from "./goal-objective-brief-normalization.service";

const OBJECTIVE_CONTEXT_CHAR_CAP = 4000;
export async function generateGoalObjectiveBrief(
  objective: string,
): Promise<string> {
  const fallback = fallbackGoalObjectiveBrief(objective);
  const brief = await generateAuxiliary({
    feature: "goal_objective_brief",
    usable: (value) => {
      return value !== null && value.length > 0;
    },
    generate: async () => {
      const generated = await generateText(
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
        768,
        { reasoning: { effort: "low" } },
      );
      return generated === null
        ? null
        : capGoalObjectiveBriefText(compactGoalObjectiveBriefText(generated));
    },
  });
  return brief || fallback;
}
