import { z } from "zod";
import { listCustomConnectors } from "../../lib/api/domains/connectors";

export async function resolveCustomConnectorId(
  selector: string,
): Promise<string> {
  if (!selector.startsWith("_")) {
    const id = z.uuid().safeParse(selector);
    if (id.success) {
      return id.data;
    }
    throw new Error(
      `Expected a custom connector slug or UUID: ${selector}\nRun: okou connector custom list`,
    );
  }

  const connectors = await listCustomConnectors();
  const matches = connectors.filter((connector) => {
    return connector.slug === selector;
  });
  if (matches.length > 1) {
    const ids = matches
      .map((connector) => {
        return connector.id;
      })
      .sort()
      .join(", ");
    throw new Error(
      `Ambiguous custom connector slug: ${selector}\nMatching IDs: ${ids}\nRun: okou connector custom list\nSelect an explicit UUID (custom:<uuid> for connector check).`,
    );
  }
  const connector = matches[0];
  if (!connector) {
    throw new Error(
      `Unknown or unavailable custom connector slug: ${selector}\nRun: okou connector custom list`,
    );
  }
  return connector.id;
}
