import { Command } from "commander";
import { createCommand } from "./create";
import { editCommand } from "./edit";
import { viewCommand } from "./view";
import { listCommand } from "./list";
import { deleteCommand } from "./delete";

export const zeroSkillCommand = new Command("skill")
  .description("Manage custom skills")
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
  List all skills:         zero skill list
  View skill content:      zero skill view my-skill
  Update skill content:    zero skill edit my-skill --dir ./skills/my-skill/
  Delete a skill:          zero skill delete my-skill -y

Skill Binding:
  Bind to agent:           zero agent edit <id> --add-skill my-skill
  Unbind from agent:       zero agent edit <id> --remove-skill my-skill
  Replace all skills:      zero agent edit <id> --skills a,b,c`,
  );
