import { NextRequest } from "next/server";
import { e2bService } from "../../../src/lib/e2b";
import { successResponse, errorResponse } from "../../../src/lib/api-response";
import { BadRequestError } from "../../../src/lib/errors";
import type {
  CreateAgentRuntimeRequest,
  CreateAgentRuntimeResponse,
} from "../../../src/types/agent-runtime";

/**
 * POST /api/agent-runtimes
 * Create and execute an agent runtime
 *
 * MVP: Executes simple echo command in E2B sandbox
 * Future: Will integrate with agent configs and execute real Claude Code
 */
export async function POST(request: NextRequest) {
  try {
    // Parse request body
    const body: CreateAgentRuntimeRequest = await request.json();

    // Basic validation
    if (!body.agentConfigId) {
      throw new BadRequestError("Missing agentConfigId");
    }

    if (!body.prompt) {
      throw new BadRequestError("Missing prompt");
    }

    console.log(`[API] Creating runtime for config: ${body.agentConfigId}`);

    // Create runtime using E2B service
    const result = await e2bService.createRuntime({
      agentConfigId: body.agentConfigId,
      prompt: body.prompt,
      dynamicVars: body.dynamicVars,
    });

    // Return response
    const response: CreateAgentRuntimeResponse = {
      runtimeId: result.runtimeId,
      status: result.status,
      sandboxId: result.sandboxId,
      output: result.output,
      error: result.error,
      executionTimeMs: result.executionTimeMs,
      createdAt: result.createdAt.toISOString(),
    };

    console.log(
      `[API] Runtime ${result.runtimeId} completed with status: ${result.status}`,
    );

    return successResponse(response, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
