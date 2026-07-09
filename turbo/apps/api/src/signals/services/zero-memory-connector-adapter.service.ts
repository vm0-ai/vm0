import type {
  MemoryDocumentChunkCitation,
  MemoryDocumentMetadata,
  MemoryProvider,
  MemorySourceType,
} from "@vm0/db/schema/memory-substrate";

import type { Db } from "../external/db";
import type { MemoryContextSpaceInput } from "./memory-substrate.service";
import { recordMemoryDocumentFromConnectorSource } from "./zero-memory-document-ingestion.service";

export interface NormalizedConnectorMemoryDocument {
  readonly provider: MemoryProvider;
  readonly sourceType: MemorySourceType;
  readonly externalId: string;
  readonly title?: string | null;
  readonly content: string;
  readonly occurredAt?: Date | null;
  readonly contextSpace?: MemoryContextSpaceInput;
  readonly metadata?: MemoryDocumentMetadata;
  readonly citation?: Partial<MemoryDocumentChunkCitation>;
}

export type MemoryConnectorDocumentAdapter<Input> = (
  input: Input,
) => NormalizedConnectorMemoryDocument | null;

export function normalizedConnectorMemoryDocumentAdapter(
  input: NormalizedConnectorMemoryDocument,
): NormalizedConnectorMemoryDocument {
  return input;
}

export async function recordConnectorMemoryDocument<Input>(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly adapter: MemoryConnectorDocumentAdapter<Input>;
  readonly input: Input;
}): Promise<boolean> {
  const document = args.adapter(args.input);
  if (!document) {
    return false;
  }
  return await recordMemoryDocumentFromConnectorSource(args.db, {
    orgId: args.orgId,
    userId: args.userId,
    ...document,
  });
}
