import { logger } from "../../lib/log";
import { generateText } from "../external/openrouter";
import { settle } from "../utils";

const log = logger("api:zero-goal-objective-brief");
const OBJECTIVE_BRIEF_MODEL = "google/gemini-3.1-flash-lite-preview";
const OBJECTIVE_CONTEXT_CHAR_CAP = 4000;
const OBJECTIVE_BRIEF_MAX_CHARS = 140;

function stripMarkdown(text: string): string {
  return text
    .replace(/(\*{1,3}|_{1,3})(.+?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^["'](.+)["']$/, "$1")
    .trim();
}

function compactText(text: string): string {
  return stripMarkdown(text).replace(/\s+/g, " ").trim();
}

function capText(text: string): string {
  if (text.length <= OBJECTIVE_BRIEF_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, OBJECTIVE_BRIEF_MAX_CHARS - 3).trimEnd()}...`;
}

function fallbackObjectiveBrief(objective: string): string {
  const firstNonEmptyLine = objective
    .split(/\r?\n/)
    .map((line) => {
      return compactText(line);
    })
    .find((line) => {
      return line.length > 0;
    });
  return capText(firstNonEmptyLine ?? compactText(objective));
}

export async function generateGoalObjectiveBrief(
  objective: string,
): Promise<string> {
  const fallback = fallbackObjectiveBrief(objective);
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

  const brief = capText(compactText(generated.value));
  return brief.length > 0 ? brief : fallback;
}
