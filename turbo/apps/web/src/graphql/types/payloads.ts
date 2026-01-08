import { builder } from "../builder";
import { RunType, type RunShape } from "./run";

/**
 * CreateRunInput - Input type for creating a new run
 */
export const CreateRunInput = builder.inputType("CreateRunInput", {
  description: "Input for creating a new run",
  fields: (t) => ({
    agentId: t.id({
      required: true,
      description: "Agent ID or agent compose ID",
    }),
    prompt: t.string({
      required: true,
      description: "User prompt for the run",
    }),
    vars: t.field({
      type: "JSON",
      required: false,
      description: "Variables for the run",
    }),
  }),
});

/**
 * CreateRunPayload - Response type for createRun mutation
 */
export interface CreateRunPayloadShape {
  run: RunShape | null;
  errors: string[];
}

export const CreateRunPayload =
  builder.objectRef<CreateRunPayloadShape>("CreateRunPayload");

CreateRunPayload.implement({
  description: "Result of createRun mutation",
  fields: (t) => ({
    run: t.field({
      type: RunType,
      nullable: true,
      resolve: (parent) => parent.run,
      description: "The created run (null if errors occurred)",
    }),
    errors: t.stringList({
      resolve: (parent) => parent.errors,
      description: "List of errors (empty if successful)",
    }),
  }),
});
