import {
  formatSkillInvocation,
  formatSkillsForSystemPrompt,
  loadSourcedSkills,
  type ExecutionEnv,
  type Skill,
  type SkillDiagnostic,
} from "@earendil-works/pi-agent-core";
import type {
  RunSkillSnapshot,
  RunSkillSnapshotEntry,
} from "@vm0/api-contracts/contracts/runners";

export const PI_BASE_SYSTEM_PROMPT = `You are an expert coding assistant working in /home/user/workspace.

Follow the user's instructions and the repository's local guidance. Use the available tools to inspect the workspace, make focused changes, and verify your work. Continue until the requested task is complete, and report the result clearly.`;

export interface PiRunSkills {
  readonly skills: readonly Skill[];
  readonly sourcedSkills: ReadonlyArray<{
    readonly skill: Skill;
    readonly source: RunSkillSnapshotEntry;
  }>;
  readonly diagnostics: ReadonlyArray<
    SkillDiagnostic & { readonly source: RunSkillSnapshotEntry }
  >;
}

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

/** Render the one immutable system prompt shared by both Pi runtimes. */
export function renderPiSystemPrompt(args: {
  readonly appendSystemPrompt?: string | null;
  readonly agentInstructions?: string | null;
  readonly skills: readonly Skill[];
}): string {
  return promptParts([
    PI_BASE_SYSTEM_PROMPT,
    args.appendSystemPrompt,
    args.agentInstructions,
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
