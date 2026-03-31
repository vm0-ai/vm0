import { Command } from "commander";
import { createCommand } from "./create";
import { editCommand } from "./edit";
import { viewCommand } from "./view";
import { listCommand } from "./list";
import { deleteCommand } from "./delete";

export const zeroSkillCommand = new Command("skill")
  .description("Manage custom skills for zero agents")
  .addCommand(createCommand)
  .addCommand(editCommand)
  .addCommand(viewCommand)
  .addCommand(listCommand)
  .addCommand(deleteCommand)
  .addHelpText(
    "after",
    `
Examples:
  Create from directory:   zero skill create my-skill --dir ./skills/my-skill/
  List agent's skills:     zero skill list --agent <id>
  View skill content:      zero skill view my-skill
  Update skill content:    zero skill edit my-skill --dir ./skills/my-skill/
  Delete a skill:          zero skill delete my-skill -y

Notes:
  Agent ID comes from --agent flag or $ZERO_AGENT_ID environment variable`,
  );
