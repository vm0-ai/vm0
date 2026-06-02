import {
  zeroSkillsCollectionContract,
  zeroSkillsDetailContract,
  type ZeroAgentCustomSkill,
  type ZeroAgentSkillContentResponse,
  type ZeroAgentSkillDetailResponse,
} from "@vm0/api-contracts/contracts/zero-agents";

import { mockApi } from "../msw-contract.ts";

const DEFAULT_SKILLS: ZeroAgentSkillDetailResponse[] = [];

let mockSkills: ZeroAgentSkillDetailResponse[] = [...DEFAULT_SKILLS];

function metadata(skill: ZeroAgentSkillDetailResponse): ZeroAgentCustomSkill {
  return {
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
  };
}

function toDetail(
  skill: ZeroAgentCustomSkill,
  content = "",
): ZeroAgentSkillDetailResponse {
  return {
    ...skill,
    content,
    files: [
      { path: "SKILL.md", size: new TextEncoder().encode(content).length },
    ],
    fileContents: [{ path: "SKILL.md", content }],
  };
}

function toDetailResponse(
  skill: ZeroAgentSkillContentResponse | ZeroAgentSkillDetailResponse,
): ZeroAgentSkillDetailResponse {
  if ("fileContents" in skill) {
    return skill;
  }
  return {
    ...skill,
    fileContents:
      skill.content === null
        ? null
        : [{ path: "SKILL.md", content: skill.content }],
  };
}

export function setMockSkills(
  skills: readonly (
    | ZeroAgentSkillDetailResponse
    | ZeroAgentSkillContentResponse
    | ZeroAgentCustomSkill
  )[],
): void {
  mockSkills = skills.map((skill) => {
    if ("content" in skill) {
      return toDetailResponse(skill);
    }
    return toDetail(skill);
  });
}

export function resetMockSkills(): void {
  mockSkills = [...DEFAULT_SKILLS];
}

export const apiSkillsHandlers = [
  mockApi(zeroSkillsCollectionContract.list, ({ respond }) => {
    return respond(200, mockSkills.map(metadata));
  }),

  mockApi(zeroSkillsDetailContract.get, ({ params, respond }) => {
    const skill = mockSkills.find((item) => {
      return item.name === params.name;
    });
    if (!skill) {
      return respond(404, {
        error: {
          message: `Skill not found: ${params.name}`,
          code: "NOT_FOUND",
        },
      });
    }
    return respond(200, skill);
  }),

  mockApi(zeroSkillsDetailContract.update, ({ body, params, respond }) => {
    const index = mockSkills.findIndex((item) => {
      return item.name === params.name;
    });
    if (index === -1) {
      return respond(404, {
        error: {
          message: `Skill not found: ${params.name}`,
          code: "NOT_FOUND",
        },
      });
    }

    const existing = mockSkills[index]!;
    const skillFile = body.files.find((file) => {
      return file.path === "SKILL.md";
    });
    const response: ZeroAgentSkillContentResponse = {
      ...existing,
      content: skillFile?.content ?? null,
      files: body.files.map((file) => {
        return {
          path: file.path,
          size: new TextEncoder().encode(file.content).length,
        };
      }),
    };
    const updated: ZeroAgentSkillDetailResponse = {
      ...response,
      fileContents: body.files,
    };
    mockSkills[index] = updated;
    return respond(200, response);
  }),
];
