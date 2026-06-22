import { Command } from "commander";
import { createCommand } from "./create";
import { editCommand } from "./edit";
import { viewCommand } from "./view";
import { listCommand } from "./list";
import { deleteCommand } from "./delete";
import { copyCommand } from "./copy";
import { runCommand } from "./run";

export const zeroWorkflowCommand = new Command("workflow")
  .description("Manage workflows")
  .addCommand(createCommand)
  .addCommand(editCommand)
  .addCommand(viewCommand)
  .addCommand(listCommand)
  .addCommand(deleteCommand)
  .addCommand(copyCommand)
  .addCommand(runCommand)
  .addHelpText(
    "after",
    `
Examples:
  Create under an agent:   zero workflow create my-workflow --agent <agent-id> --instruction "Do things"
  List workflows:          zero workflow list
  View workflow content:   zero workflow view <workflow-id>
  Update workflow content: zero workflow edit <workflow-id> --instruction "New steps"
  Copy onto another agent: zero workflow copy <workflow-id> --to-agent <agent-id>
  Run a workflow once:     zero workflow run <workflow-id>
  Delete a workflow:       zero workflow delete <workflow-id> -y`,
  );
