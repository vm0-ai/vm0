import type { ChangeEvent } from "react";
import { useGet, useSet } from "ccstate-react";
import {
  setInspectLogInput$,
  handleInspectLogFileChange$,
} from "../signals/bootstrap/inspect-log-input.ts";
import { rootSignal$ } from "../signals/root-signal.ts";
import { detach, Reason } from "../signals/utils.ts";

export function InspectLogFileInput() {
  const setEl = useSet(setInspectLogInput$);
  const handleFileChange = useSet(handleInspectLogFileChange$);
  const rootSignal = useGet(rootSignal$);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }
    e.target.value = "";
    detach(handleFileChange(file, rootSignal), Reason.DomCallback);
  };

  return (
    <input
      type="file"
      accept=".json"
      ref={setEl}
      className="hidden"
      onChange={handleChange}
    />
  );
}
