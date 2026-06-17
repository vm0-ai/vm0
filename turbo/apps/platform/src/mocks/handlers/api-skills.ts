import {
  zeroWorkflowsCollectionContract as zeroSkillsCollectionContract,
  zeroWorkflowsDetailContract as zeroSkillsDetailContract,
  type ZeroWorkflowContentResponse as ZeroAgentSkillContentResponse,
  type ZeroWorkflowDetailResponse as ZeroAgentSkillDetailResponse,
  type ZeroWorkflowSummary as ZeroAgentCustomSkill,
} from "@vm0/api-contracts/contracts/zero-workflows";

import { mockApi } from "../msw-contract.ts";

const DEFAULT_SKILLS: ZeroAgentSkillDetailResponse[] = [];

let mockSkills: ZeroAgentSkillDetailResponse[] = [...DEFAULT_SKILLS];

function metadata(skill: ZeroAgentSkillDetailResponse): ZeroAgentCustomSkill {
  return {
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    visibility: skill.visibility,
    ownerUserId: skill.ownerUserId,
    attachedAgentCount: skill.attachedAgentCount,
    attachedAgents: skill.attachedAgents,
    canManage: skill.canManage,
  };
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
    const files = body.files ?? existing.fileContents ?? [];
    const skillFile = files.find((file) => {
      return file.path === "SKILL.md";
    });
    const response: ZeroAgentSkillContentResponse = {
      ...existing,
      visibility: body.visibility ?? existing.visibility,
      content: skillFile?.content ?? null,
      files: files.map((file) => {
        return {
          path: file.path,
          size: new TextEncoder().encode(file.content).length,
        };
      }),
    };
    const updated: ZeroAgentSkillDetailResponse = {
      ...response,
      fileContents: files,
    };
    mockSkills[index] = updated;
    return respond(200, response);
  }),
];
