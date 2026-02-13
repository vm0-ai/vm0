import { useGet, useSet } from "ccstate-react";
import { Input } from "@vm0/ui/components/ui/input";
import {
  editableCompose$,
  updateComposeField$,
} from "../../../signals/agent-detail/config-dialog.ts";

function extractSkillName(url: string): string {
  // https://github.com/vm0-ai/vm0-skills/tree/main/hackernews → hackernews
  const parts = url.split("/");
  return parts[parts.length - 1] ?? url;
}

export function FormsTab() {
  const compose = useGet(editableCompose$);
  const updateField = useSet(updateComposeField$);

  if (!compose) {
    return null;
  }

  const agentKeys = Object.keys(compose.agents);
  const firstKey = agentKeys[0];
  if (!firstKey) {
    return null;
  }

  const agent = compose.agents[firstKey];
  if (!agent) {
    return null;
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-foreground">
          Agent name
        </label>
        <Input value={firstKey} readOnly className="bg-muted" />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-foreground">
          Description
        </label>
        <Input
          value={agent.description ?? ""}
          onChange={(e) => updateField("description", e.target.value)}
          placeholder="Agent description"
        />
      </div>

      {agent.skills && agent.skills.length > 0 && (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground">Skills</label>
          <div className="flex flex-wrap gap-1.5">
            {agent.skills.map((skill) => (
              <span
                key={skill}
                className="inline-flex items-center rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
              >
                {extractSkillName(skill)}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-foreground">Framework</label>
        <Input value={agent.framework ?? ""} readOnly className="bg-muted" />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-foreground">
          Instructions
        </label>
        <Input value={agent.instructions ?? ""} readOnly className="bg-muted" />
      </div>
    </div>
  );
}
