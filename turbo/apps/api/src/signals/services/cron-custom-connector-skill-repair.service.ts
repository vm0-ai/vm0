import { command, type Setter } from "ccstate";
import {
  getCustomConnectorSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { and, asc, eq, gt, inArray } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  commitPreparedCustomConnectorSkillVolume,
  computeCustomConnectorSkillVersionId,
  prepareCustomConnectorSkillVolume$,
  type CustomConnectorSkillContentInput,
} from "./custom-connector-skill-volume.service";
import {
  FEISHU_CUSTOM_CONNECTOR_SKILL_METADATA,
  getFeishuCustomConnectorSlug,
} from "./feishu-custom-connector-skill-metadata";

const SCAN_PAGE_SIZE = 100;
const REPAIR_LIMIT = 5;

type CustomConnectorSkillRepairReason =
  | "inverseInvalid"
  | "missingStorage"
  | "missingExpectedVersion"
  | "missingAssociation"
  | "wrongStorage"
  | "staleAssociation"
  | "headMismatch";

type SkillConnectorRepairReason = Exclude<
  CustomConnectorSkillRepairReason,
  "inverseInvalid"
>;

interface CustomConnectorSkillRepairReasonCounts {
  readonly inverseInvalid: number;
  readonly missingStorage: number;
  readonly missingExpectedVersion: number;
  readonly missingAssociation: number;
  readonly wrongStorage: number;
  readonly staleAssociation: number;
  readonly headMismatch: number;
}

interface CustomConnectorSkillRepairStatus {
  readonly total: number;
  readonly verified: number;
  readonly unresolved: number;
  readonly reasons: CustomConnectorSkillRepairReasonCounts;
  readonly complete: boolean;
}

interface CustomConnectorSkillRepairResult {
  readonly scanned: number;
  readonly attempted: number;
  readonly repaired: number;
  readonly conflicts: number;
}

interface CustomConnectorSkillScanRow {
  readonly id: string;
  readonly orgId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly skillMarkdown: string | null;
  readonly skillStorageVersionId: string | null;
  readonly isManagedFeishu: boolean;
}

interface CanonicalStorageState {
  readonly id: string;
  readonly headVersionId: string | null;
}

interface StorageVersionState {
  readonly id: string;
  readonly storageId: string;
}

type CustomConnectorSkillClassification =
  | {
      readonly kind: "verified";
      readonly connector: CustomConnectorSkillScanRow;
    }
  | {
      readonly kind: "unresolved";
      readonly connector: CustomConnectorSkillScanRow;
      readonly reason: "inverseInvalid";
    }
  | {
      readonly kind: "unresolved";
      readonly connector: CustomConnectorSkillScanRow & {
        readonly skillMarkdown: string;
      };
      readonly reason: SkillConnectorRepairReason;
    };

function storageKey(orgId: string, storageName: string): string {
  return `${orgId}\u0000${storageName}`;
}

function skillContentInput(
  connector: CustomConnectorSkillScanRow & { readonly skillMarkdown: string },
): CustomConnectorSkillContentInput {
  const managedMetadata = connector.isManagedFeishu
    ? FEISHU_CUSTOM_CONNECTOR_SKILL_METADATA
    : undefined;
  return {
    connectorId: connector.id,
    connectorSlug: connector.slug,
    displayName: connector.displayName,
    skillMarkdown: connector.skillMarkdown,
    skillName: managedMetadata?.name,
    skillDescription: managedMetadata?.description,
  };
}

async function readConnectorPage(
  db: ReadonlyDb,
  afterId: string | undefined,
  signal: AbortSignal,
): Promise<readonly CustomConnectorSkillScanRow[]> {
  const rows = await db
    .select({
      id: orgCustomConnectors.id,
      orgId: orgCustomConnectors.orgId,
      slug: orgCustomConnectors.slug,
      displayName: orgCustomConnectors.displayName,
      skillMarkdown: orgCustomConnectors.skillMarkdown,
      skillStorageVersionId: orgCustomConnectors.skillStorageVersionId,
    })
    .from(orgCustomConnectors)
    .where(
      afterId === undefined ? undefined : gt(orgCustomConnectors.id, afterId),
    )
    .orderBy(asc(orgCustomConnectors.id))
    .limit(SCAN_PAGE_SIZE);
  signal.throwIfAborted();
  const feishuOrgIds = [
    ...new Set(
      rows.map((row) => {
        return row.orgId;
      }),
    ),
  ];
  if (feishuOrgIds.length === 0) {
    return rows.map((row) => {
      return { ...row, isManagedFeishu: false };
    });
  }
  const installations = await db
    .select({
      id: feishuOrgInstallations.id,
      orgId: feishuOrgInstallations.orgId,
    })
    .from(feishuOrgInstallations)
    .where(inArray(feishuOrgInstallations.orgId, feishuOrgIds));
  signal.throwIfAborted();
  const managedConnectorKeys = new Set(
    installations.map((installation) => {
      return storageKey(
        installation.orgId,
        getFeishuCustomConnectorSlug(installation.id),
      );
    }),
  );
  return rows.map((row) => {
    return {
      ...row,
      isManagedFeishu: managedConnectorKeys.has(
        storageKey(row.orgId, row.slug),
      ),
    };
  });
}

async function readCanonicalStorages(
  db: ReadonlyDb,
  connectors: readonly CustomConnectorSkillScanRow[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, CanonicalStorageState>> {
  const skillConnectors = connectors.filter(
    (
      connector,
    ): connector is CustomConnectorSkillScanRow & {
      readonly skillMarkdown: string;
    } => {
      return connector.skillMarkdown !== null;
    },
  );
  if (skillConnectors.length === 0) {
    return new Map();
  }

  const orgIds = [
    ...new Set(
      skillConnectors.map(({ orgId }) => {
        return orgId;
      }),
    ),
  ];
  const storageNames = skillConnectors.map(({ id }) => {
    return getCustomConnectorSkillStorageName(id);
  });
  const rows = await db
    .select({
      id: storages.id,
      orgId: storages.orgId,
      name: storages.name,
      headVersionId: storages.headVersionId,
    })
    .from(storages)
    .where(
      and(
        eq(storages.userId, VOLUME_ORG_USER_ID),
        inArray(storages.orgId, orgIds),
        inArray(storages.name, storageNames),
      ),
    );
  signal.throwIfAborted();
  return new Map(
    rows.map((row) => {
      return [storageKey(row.orgId, row.name), row] as const;
    }),
  );
}

async function readRelevantVersions(
  db: ReadonlyDb,
  connectors: readonly CustomConnectorSkillScanRow[],
  canonicalStorageByKey: ReadonlyMap<string, CanonicalStorageState>,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, StorageVersionState>> {
  const ids = new Set<string>();
  for (const connector of connectors) {
    if (
      connector.skillMarkdown !== null &&
      connector.skillStorageVersionId !== null
    ) {
      ids.add(connector.skillStorageVersionId);
    }
    if (connector.skillMarkdown === null) {
      continue;
    }
    const storage = canonicalStorageByKey.get(
      storageKey(
        connector.orgId,
        getCustomConnectorSkillStorageName(connector.id),
      ),
    );
    if (storage) {
      ids.add(
        computeCustomConnectorSkillVersionId(
          storage.id,
          skillContentInput({
            ...connector,
            skillMarkdown: connector.skillMarkdown,
          }),
        ),
      );
    }
  }
  if (ids.size === 0) {
    return new Map();
  }

  const rows = await db
    .select({ id: storageVersions.id, storageId: storageVersions.storageId })
    .from(storageVersions)
    .where(inArray(storageVersions.id, [...ids]));
  signal.throwIfAborted();
  return new Map(
    rows.map((row) => {
      return [row.id, row] as const;
    }),
  );
}

function classifyConnector(
  connector: CustomConnectorSkillScanRow,
  canonicalStorageByKey: ReadonlyMap<string, CanonicalStorageState>,
  versionById: ReadonlyMap<string, StorageVersionState>,
): CustomConnectorSkillClassification {
  if (connector.skillMarkdown === null) {
    return connector.skillStorageVersionId === null
      ? { kind: "verified", connector }
      : { kind: "unresolved", connector, reason: "inverseInvalid" };
  }
  const skillConnector = {
    ...connector,
    skillMarkdown: connector.skillMarkdown,
  };

  const storage = canonicalStorageByKey.get(
    storageKey(
      skillConnector.orgId,
      getCustomConnectorSkillStorageName(skillConnector.id),
    ),
  );
  if (!storage) {
    return {
      kind: "unresolved",
      connector: skillConnector,
      reason: "missingStorage",
    };
  }
  const expectedVersionId = computeCustomConnectorSkillVersionId(
    storage.id,
    skillContentInput(skillConnector),
  );
  if (!versionById.has(expectedVersionId)) {
    return {
      kind: "unresolved",
      connector: skillConnector,
      reason: "missingExpectedVersion",
    };
  }
  if (skillConnector.skillStorageVersionId === null) {
    return {
      kind: "unresolved",
      connector: skillConnector,
      reason: "missingAssociation",
    };
  }
  const associatedVersion = versionById.get(
    skillConnector.skillStorageVersionId,
  );
  if (!associatedVersion) {
    throw new Error(
      `Custom connector ${skillConnector.id} points to missing storage version ${skillConnector.skillStorageVersionId}`,
    );
  }
  if (associatedVersion.storageId !== storage.id) {
    return {
      kind: "unresolved",
      connector: skillConnector,
      reason: "wrongStorage",
    };
  }
  if (skillConnector.skillStorageVersionId !== expectedVersionId) {
    return {
      kind: "unresolved",
      connector: skillConnector,
      reason: "staleAssociation",
    };
  }
  if (storage.headVersionId !== expectedVersionId) {
    return {
      kind: "unresolved",
      connector: skillConnector,
      reason: "headMismatch",
    };
  }
  return { kind: "verified", connector: skillConnector };
}

async function classifyConnectorPage(
  db: ReadonlyDb,
  connectors: readonly CustomConnectorSkillScanRow[],
  signal: AbortSignal,
): Promise<readonly CustomConnectorSkillClassification[]> {
  const canonicalStorages = await readCanonicalStorages(db, connectors, signal);
  const versions = await readRelevantVersions(
    db,
    connectors,
    canonicalStorages,
    signal,
  );
  return connectors.map((connector) => {
    return classifyConnector(connector, canonicalStorages, versions);
  });
}

async function walkClassifications(
  db: ReadonlyDb,
  signal: AbortSignal,
  visit: (
    classification: CustomConnectorSkillClassification,
  ) => boolean | Promise<boolean>,
): Promise<number> {
  let afterId: string | undefined;
  let scanned = 0;
  while (true) {
    const connectors = await readConnectorPage(db, afterId, signal);
    if (connectors.length === 0) {
      return scanned;
    }
    const classifications = await classifyConnectorPage(db, connectors, signal);
    for (const classification of classifications) {
      scanned += 1;
      if (!(await visit(classification))) {
        return scanned;
      }
      signal.throwIfAborted();
    }
    if (connectors.length < SCAN_PAGE_SIZE) {
      return scanned;
    }
    afterId = connectors.at(-1)?.id;
  }
}

function emptyReasonCounts(): CustomConnectorSkillRepairReasonCounts {
  return {
    inverseInvalid: 0,
    missingStorage: 0,
    missingExpectedVersion: 0,
    missingAssociation: 0,
    wrongStorage: 0,
    staleAssociation: 0,
    headMismatch: 0,
  };
}

function incrementReason(
  counts: CustomConnectorSkillRepairReasonCounts,
  reason: CustomConnectorSkillRepairReason,
): CustomConnectorSkillRepairReasonCounts {
  return { ...counts, [reason]: counts[reason] + 1 };
}

async function readLockedConnector(
  tx: Tx,
  connectorId: string,
  signal: AbortSignal,
): Promise<CustomConnectorSkillScanRow | undefined> {
  const [connector] = await tx
    .select({
      id: orgCustomConnectors.id,
      orgId: orgCustomConnectors.orgId,
      slug: orgCustomConnectors.slug,
      displayName: orgCustomConnectors.displayName,
      skillMarkdown: orgCustomConnectors.skillMarkdown,
      skillStorageVersionId: orgCustomConnectors.skillStorageVersionId,
    })
    .from(orgCustomConnectors)
    .where(eq(orgCustomConnectors.id, connectorId))
    .for("update")
    .limit(1);
  signal.throwIfAborted();
  if (!connector) {
    return undefined;
  }
  const installations = await tx
    .select({ id: feishuOrgInstallations.id })
    .from(feishuOrgInstallations)
    .where(eq(feishuOrgInstallations.orgId, connector.orgId))
    .for("key share");
  signal.throwIfAborted();
  return {
    ...connector,
    isManagedFeishu: installations.some((installation) => {
      return getFeishuCustomConnectorSlug(installation.id) === connector.slug;
    }),
  };
}

async function repairSkillConnector(
  set: Setter,
  db: Db,
  connector: CustomConnectorSkillScanRow & { readonly skillMarkdown: string },
  signal: AbortSignal,
): Promise<boolean> {
  const volume = await set(
    prepareCustomConnectorSkillVolume$,
    {
      orgId: connector.orgId,
      ...skillContentInput(connector),
    },
    signal,
  );
  signal.throwIfAborted();

  return await db.transaction(async (tx) => {
    const current = await readLockedConnector(tx, connector.id, signal);
    if (
      !current ||
      current.orgId !== connector.orgId ||
      current.skillMarkdown === null ||
      computeCustomConnectorSkillVersionId(
        volume.version.storageId,
        skillContentInput({ ...current, skillMarkdown: current.skillMarkdown }),
      ) !== volume.version.versionId
    ) {
      return false;
    }
    const [storage] = await tx
      .select({ headVersionId: storages.headVersionId })
      .from(storages)
      .where(eq(storages.id, volume.version.storageId))
      .limit(1);
    signal.throwIfAborted();
    if (
      current.skillStorageVersionId === volume.version.versionId &&
      storage?.headVersionId === volume.version.versionId
    ) {
      return false;
    }
    await commitPreparedCustomConnectorSkillVolume(
      { db: tx, connectorId: connector.id, volume },
      signal,
    );
    return true;
  });
}

async function repairInverseInvalidConnector(
  db: Db,
  connectorId: string,
  signal: AbortSignal,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const current = await readLockedConnector(tx, connectorId, signal);
    if (
      !current ||
      current.skillMarkdown !== null ||
      current.skillStorageVersionId === null
    ) {
      return false;
    }
    await tx
      .update(orgCustomConnectors)
      .set({ skillStorageVersionId: null })
      .where(eq(orgCustomConnectors.id, connectorId));
    signal.throwIfAborted();
    return true;
  });
}

export const customConnectorSkillRepairStatus$ = command(
  async (
    { get },
    signal: AbortSignal,
  ): Promise<CustomConnectorSkillRepairStatus> => {
    let verified = 0;
    let reasons = emptyReasonCounts();
    const total = await walkClassifications(
      get(db$),
      signal,
      (classification) => {
        if (classification.kind === "verified") {
          verified += 1;
        } else {
          reasons = incrementReason(reasons, classification.reason);
        }
        return true;
      },
    );
    const unresolved = total - verified;
    return {
      total,
      verified,
      unresolved,
      reasons,
      complete: unresolved === 0,
    };
  },
);

export const repairCustomConnectorSkillVersions$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<CustomConnectorSkillRepairResult> => {
    const db = set(writeDb$);
    let attempted = 0;
    let repaired = 0;
    let conflicts = 0;
    const scanned = await walkClassifications(
      db,
      signal,
      async (classification) => {
        if (classification.kind === "verified") {
          return true;
        }
        attempted += 1;
        const didRepair =
          classification.reason === "inverseInvalid"
            ? await repairInverseInvalidConnector(
                db,
                classification.connector.id,
                signal,
              )
            : await repairSkillConnector(
                set,
                db,
                classification.connector,
                signal,
              );
        if (didRepair) {
          repaired += 1;
        } else {
          conflicts += 1;
        }
        return attempted < REPAIR_LIMIT;
      },
    );
    return { scanned, attempted, repaired, conflicts };
  },
);
