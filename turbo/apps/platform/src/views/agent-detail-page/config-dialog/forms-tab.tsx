import { useGet, useSet } from "ccstate-react";
import { Input } from "@vm0/ui/components/ui/input";
import { MultiSelectCombobox } from "@vm0/ui/components/ui/multi-select-combobox";
import {
  editableCompose$,
  updateComposeField$,
  updateSkills$,
  skillEnvHints$,
} from "../../../signals/agent-detail/config-dialog.ts";
import { skills$, skillUrlToValue } from "../../../data/skills.ts";

export function FormsTab() {
  const compose = useGet(editableCompose$);
  const skills = useGet(skills$);
  const envHints = useGet(skillEnvHints$);
  const updateField = useSet(updateComposeField$);
  const updateSkillValues = useSet(updateSkills$);

  if (!compose) {
    return null;
  }

  const agentKeys = Object.keys(compose.agents);
  const firstKey = agentKeys[0];
  if (firstKey === undefined) {
    return null;
  }

  const agent = compose.agents[firstKey];
  if (!agent) {
    return null;
  }

  const selectedSkills = agent.skills?.map(skillUrlToValue) ?? [];

  // Include custom/unrecognized skill URLs as extra options so they aren't
  // silently dropped from the selection when editing.
  const knownValues = new Set(skills.map((s) => s.value));
  const extraOptions = selectedSkills
    .filter((v) => !knownValues.has(v))
    .map((v) => ({ value: v, label: v }));
  const allOptions =
    extraOptions.length > 0 ? [...skills, ...extraOptions] : skills;

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

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-foreground">Skills</label>
        <MultiSelectCombobox
          options={allOptions}
          selected={selectedSkills}
          onChange={updateSkillValues}
          placeholder="Select skills..."
          searchPlaceholder="Search skills..."
        />
        {envHints.length > 0 && (
          <p className="text-xs text-amber-500">
            The following environment variables will be configured:{" "}
            <span className="font-mono font-bold">{envHints.join(", ")}</span>
          </p>
        )}
      </div>

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
