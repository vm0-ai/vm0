import {
  formatSkillInvocation,
  formatSkillsForSystemPrompt,
  loadSourcedSkills,
  type ExecutionEnv,
  type Skill,
} from "@earendil-works/pi-agent-core";
import type { RunSkillSnapshot } from "@vm0/api-contracts/contracts/runners";

import type { PiRunSkills } from "./types";

const PI_AGENT_NAME_PLACEHOLDER = "{{agent_name}}";

const PI_BASE_SYSTEM_PROMPT_TEMPLATE = `You are ${PI_AGENT_NAME_PLACEHOLDER}, an AI agent. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.

# Personality

As ${PI_AGENT_NAME_PLACEHOLDER}, you are an excellent communicator with a curious, distinct personality. Match the user's tone and level of understanding so the conversation feels natural.

Have judgment and a point of view. Guide users through unfamiliar tasks, anticipate likely questions and pitfalls, and set clear expectations. Communicate like a thoughtful collaborator working at the user's level.

## Writing style

Use the minimum formatting needed for clarity. Avoid unnecessary headings, emphasis, and long lists.

Lead with the outcome. Prefer plain language over jargon, and include technical detail only when it helps the user understand or verify the result.

# Working with the user

Treat the user's latest request as authoritative. If a new request changes the task, follow it; if it adds to unfinished work, handle both.

Make reasonable, reversible assumptions when they let you progress. Ask for clarification only when a missing choice would materially change the result or require new authority.

Keep the user informed during long-running work. Your final response must stand on its own and clearly state the outcome, relevant verification, and any remaining blocker.

# Rules for getting work done

- Work from /home/user/workspace and follow repository-local instructions such as AGENTS.md.
- Use the available read, bash, write, and edit tools to inspect first, make focused changes, and verify them proportionately.
- Prefer rg and rg --files for searching. Preserve existing user changes and avoid unrelated edits.
- Use an applicable listed Skill when the user names it or the task clearly matches it. Read its SKILL.md before acting.
- Keep secrets and sensitive data out of commands and responses.
- Do not take destructive or externally consequential actions unless they are clearly within the user's request. Resolve exact targets before changing or deleting data.

## Autonomy and persistence

For questions, explanations, reviews, or diagnosis, inspect the relevant evidence and answer without making unrequested changes. For change or build requests, carry the work through implementation and verification.

Continue until the requested outcome is genuinely complete or you are blocked by a concrete need for user input or external state. Do not stop at a plan when you can safely perform the work, and do not expand the scope beyond the user's request.

# Final response

Lead with the result. Be concise, mention changed files or checks when useful, and explain blockers plainly.`;

function renderPiBaseSystemPrompt(agentName: string): string {
  const normalizedAgentName = agentName.replace(/\s+/g, " ").trim() || "Okou";
  return PI_BASE_SYSTEM_PROMPT_TEMPLATE.replaceAll(
    PI_AGENT_NAME_PLACEHOLDER,
    () => {
      return normalizedAgentName;
    },
  );
}

/** Default base prompt used when no user-facing agent identity is available. */
export const PI_BASE_SYSTEM_PROMPT = renderPiBaseSystemPrompt("Okou");

/** Load only the exact Skill directories pinned in this run's snapshot. */
export async function loadPiRunSkills(
  env: ExecutionEnv,
  snapshot: RunSkillSnapshot,
): Promise<PiRunSkills> {
  const loaded = await loadSourcedSkills(
    env,
    snapshot.entries.map((entry) => {
      return { path: entry.logicalDir, source: entry };
    }),
  );
  return {
    skills: loaded.skills.map(({ skill }) => {
      return skill;
    }),
    sourcedSkills: loaded.skills,
    diagnostics: loaded.diagnostics,
  };
}

function promptParts(parts: ReadonlyArray<string | null | undefined>): string {
  return parts
    .map((part) => {
      return part?.trim();
    })
    .filter((part): part is string => {
      return part !== undefined && part.length > 0;
    })
    .join("\n\n");
}

function renderPiMemoryPrompt(memory: {
  readonly directory: string;
  readonly primaryFile: string;
  readonly prefix: string | null;
}): string {
  return promptParts([
    `## Memory

Your durable memory directory is:

\`${memory.directory}\`

The primary memory file is:

\`${memory.primaryFile}\`

Read \`${memory.primaryFile}\` and related files when more detail is needed. When the user explicitly asks you to remember, update, or forget something, modify files in this directory.`,
    memory.prefix
      ? `### MEMORY.md prefix

The following is only a possibly truncated prefix of \`${memory.primaryFile}\`:

${memory.prefix}`
      : null,
  ]);
}

/** Render the system prompt shared by both Pi runtimes. */
export function renderPiSystemPrompt(args: {
  readonly agentName: string;
  readonly appendSystemPrompt?: string | null;
  readonly agentInstructions?: string | null;
  readonly memory?: {
    readonly directory: string;
    readonly primaryFile: string;
    readonly prefix: string | null;
  } | null;
  readonly skills: readonly Skill[];
}): string {
  return promptParts([
    renderPiBaseSystemPrompt(args.agentName),
    args.appendSystemPrompt,
    args.agentInstructions,
    args.memory ? renderPiMemoryPrompt(args.memory) : null,
    formatSkillsForSystemPrompt([...args.skills]),
  ]);
}

const EXPLICIT_SKILL_PATTERN = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/;

/** Apply Pi's native explicit Skill invocation wrapper when requested. */
export function formatPiUserPrompt(
  prompt: string,
  skills: readonly Skill[],
): string {
  const invocation = EXPLICIT_SKILL_PATTERN.exec(prompt.trim());
  if (!invocation) {
    return prompt;
  }
  const name = invocation[1];
  const skill = skills.find((candidate) => {
    return candidate.name === name;
  });
  if (!skill) {
    throw new Error(`Unknown Pi Skill "${name}"`);
  }
  return formatSkillInvocation(skill, invocation[2]);
}
