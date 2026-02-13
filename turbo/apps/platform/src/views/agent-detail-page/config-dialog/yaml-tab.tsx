import { useGet, useSet } from "ccstate-react";
import { CopyButton } from "@vm0/ui/components/ui/copy-button";
import {
  yamlText$,
  yamlError$,
  updateYamlText$,
} from "../../../signals/agent-detail/config-dialog.ts";

export function YamlTab() {
  const yamlText = useGet(yamlText$);
  const yamlError = useGet(yamlError$);
  const updateYaml = useSet(updateYamlText$);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <textarea
          value={yamlText}
          onChange={(e) => updateYaml(e.target.value)}
          className="w-full min-h-[300px] rounded-lg border border-border bg-input p-3 font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          spellCheck={false}
        />
        <div className="absolute top-1 right-1">
          <CopyButton text={yamlText} />
        </div>
      </div>
      {yamlError && <p className="text-sm text-destructive">{yamlError}</p>}
    </div>
  );
}
