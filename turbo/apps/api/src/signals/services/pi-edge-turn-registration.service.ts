import { runPiEdgeTurn$ } from "./pi-edge-loop.service";
import { configurePiEdgeTurnCommand } from "./pi-edge-turn-dispatch.service";

/** Wire the Pi implementation at the API composition root without a cycle. */
export function configurePiEdgeTurnDispatcher(): void {
  configurePiEdgeTurnCommand(runPiEdgeTurn$);
}
