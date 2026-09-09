import { Buffer } from "node:buffer";
import type { Message } from "ably";
import type { ConnectorRuntimeTarget } from "@okouai/api-contracts/contracts/runners";

const MAX_BATCH_MESSAGES = 1000;
// Include JSON framing and escaping, staying below Ably's smallest message-size limit.
const MAX_BATCH_BYTES = 16 * 1024;

export interface ConnectorRuntimeWakeup {
  readonly runId: string;
  readonly runnerGroup: string;
  readonly target: ConnectorRuntimeTarget;
}

interface ConnectorRuntimeWakeupBatch {
  readonly runnerGroup: string;
  readonly wakeups: ConnectorRuntimeWakeup[];
  readonly messages: Message[];
}

export function connectorRuntimeWakeupBatches(
  wakeups: readonly ConnectorRuntimeWakeup[],
): readonly ConnectorRuntimeWakeupBatch[] {
  const groups = new Map<string, ConnectorRuntimeWakeup[]>();
  for (const wakeup of wakeups) {
    const group = groups.get(wakeup.runnerGroup) ?? [];
    group.push(wakeup);
    groups.set(wakeup.runnerGroup, group);
  }
  const batches: ConnectorRuntimeWakeupBatch[] = [];
  for (const [runnerGroup, group] of groups) {
    const framingBytes = Buffer.byteLength(
      JSON.stringify([
        { channels: [`runner-group:${runnerGroup}`], messages: [] },
      ]),
    );
    let batch: ConnectorRuntimeWakeupBatch = {
      runnerGroup,
      wakeups: [],
      messages: [],
    };
    let bytes = framingBytes;
    for (const wakeup of group) {
      // Native batchPublish serializes DTOs directly, unlike channel.publish.
      const message: Message = {
        name: "connector-runtime-sync",
        data: JSON.stringify({ runId: wakeup.runId, target: wakeup.target }),
        encoding: "json",
      };
      const messageBytes = Buffer.byteLength(JSON.stringify(message));
      if (framingBytes + messageBytes > MAX_BATCH_BYTES) {
        throw new Error("Connector runtime wakeup exceeds batch size limit");
      }
      const separatorBytes = batch.messages.length > 0 ? 1 : 0;
      if (
        batch.messages.length >= MAX_BATCH_MESSAGES ||
        bytes + separatorBytes + messageBytes > MAX_BATCH_BYTES
      ) {
        batches.push(batch);
        batch = { runnerGroup, wakeups: [], messages: [] };
        bytes = framingBytes;
      }
      bytes += messageBytes + (batch.messages.length > 0 ? 1 : 0);
      batch.messages.push(message);
      batch.wakeups.push(wakeup);
    }
    batches.push(batch);
  }
  return batches;
}
