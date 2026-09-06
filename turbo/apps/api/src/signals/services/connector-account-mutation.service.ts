import { connectorAccountMutationIntentSchema } from "@okouai/api-contracts/contracts/connector-accounts";
import { sql, type SQLWrapper } from "drizzle-orm";

import { zodDriverValueDecoder } from "../../lib/db-structured-result";

const storedConnectorAccountMutationDecoder = zodDriverValueDecoder(
  connectorAccountMutationIntentSchema,
);

export function storedConnectorAccountMutationSelection(
  accountMutation: SQLWrapper,
) {
  return sql`${accountMutation}`.mapWith(storedConnectorAccountMutationDecoder);
}
