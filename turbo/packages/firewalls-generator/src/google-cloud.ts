import {
  fetchSpec,
  logStats,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
  type PermissionGroup,
} from "./codegen";

const PLACEHOLDER_VALUE =
  "ya29.A0CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSa";

export const GOOGLE_CLOUD_DISCOVERY_URLS = {
  cloudresourcemanager:
    "https://cloudresourcemanager.googleapis.com/$discovery/rest?version=v3",
  serviceusage:
    "https://serviceusage.googleapis.com/$discovery/rest?version=v1",
  iam: "https://iam.googleapis.com/$discovery/rest?version=v1",
  compute: "https://www.googleapis.com/discovery/v1/apis/compute/v1/rest",
  appengine: "https://appengine.googleapis.com/$discovery/rest?version=v1",
  sqladmin: "https://sqladmin.googleapis.com/$discovery/rest?version=v1",
  bigquery: "https://bigquery.googleapis.com/$discovery/rest?version=v2",
  storage: "https://storage.googleapis.com/$discovery/rest?version=v1",
  run: "https://run.googleapis.com/$discovery/rest?version=v2",
  cloudbuild: "https://cloudbuild.googleapis.com/$discovery/rest?version=v1",
  artifactregistry:
    "https://artifactregistry.googleapis.com/$discovery/rest?version=v1",
  container: "https://container.googleapis.com/$discovery/rest?version=v1",
  cloudfunctions:
    "https://cloudfunctions.googleapis.com/$discovery/rest?version=v2",
  secretmanager:
    "https://secretmanager.googleapis.com/$discovery/rest?version=v1",
  logging: "https://logging.googleapis.com/$discovery/rest?version=v2",
  monitoring: "https://monitoring.googleapis.com/$discovery/rest?version=v3",
  cloudbilling:
    "https://cloudbilling.googleapis.com/$discovery/rest?version=v1",
  pubsub: "https://pubsub.googleapis.com/$discovery/rest?version=v1",
  firestore: "https://firestore.googleapis.com/$discovery/rest?version=v1",
  spanner: "https://spanner.googleapis.com/$discovery/rest?version=v1",
} as const;

const GOOGLE_CLOUD_PERMISSION_ROLE_PATHS = [
  "appengine",
  "artifactregistry",
  "bigquery",
  "billing",
  "cloudbuild",
  "cloudfunctions",
  "cloudsql",
  "compute",
  "container",
  "firestore",
  "iam",
  "logging",
  "monitoring",
  "pubsub",
  "resourcemanager",
  "run",
  "secretmanager",
  "serviceusage",
  "spanner",
  "storage",
] as const;

export const GOOGLE_CLOUD_PERMISSION_DOC_URLS =
  GOOGLE_CLOUD_PERMISSION_ROLE_PATHS.map((path) => {
    return `https://docs.cloud.google.com/iam/docs/roles-permissions/${path}?hl=en`;
  });

interface DiscoveryMediaUploadProtocol {
  path?: string;
}

interface DiscoveryMethod {
  id?: string;
  httpMethod?: string;
  path?: string;
  flatPath?: string;
  supportsMediaUpload?: boolean;
  mediaUpload?: {
    protocols?: {
      simple?: DiscoveryMediaUploadProtocol;
      resumable?: DiscoveryMediaUploadProtocol;
    };
  };
}

interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}

interface DiscoveryDocument {
  title?: string;
  version?: string;
  baseUrl?: string;
  servicePath?: string;
  resources?: Record<string, DiscoveryResource>;
}

interface ApiConfig {
  key: keyof typeof GOOGLE_CLOUD_DISCOVERY_URLS;
  base: string;
  description: string;
}

interface BuildStats {
  totalOperations: number;
  mappedOperations: number;
  explicitlyUnmappedOperations: number;
  unexpectedUnmappedOperations: number;
  permissionCount: number;
}

const API_CONFIGS: ApiConfig[] = [
  {
    key: "cloudresourcemanager",
    base: "https://cloudresourcemanager.googleapis.com",
    description: "Cloud Resource Manager API",
  },
  {
    key: "serviceusage",
    base: "https://serviceusage.googleapis.com",
    description: "Service Usage API",
  },
  {
    key: "iam",
    base: "https://iam.googleapis.com",
    description: "Identity and Access Management API",
  },
  {
    key: "compute",
    base: "https://compute.googleapis.com",
    description: "Compute Engine API",
  },
  {
    key: "appengine",
    base: "https://appengine.googleapis.com",
    description: "App Engine Admin API",
  },
  {
    key: "sqladmin",
    base: "https://sqladmin.googleapis.com",
    description: "Cloud SQL Admin API",
  },
  {
    key: "bigquery",
    base: "https://bigquery.googleapis.com",
    description: "BigQuery API",
  },
  {
    key: "storage",
    base: "https://storage.googleapis.com",
    description: "Cloud Storage JSON API",
  },
  {
    key: "run",
    base: "https://run.googleapis.com",
    description: "Cloud Run Admin API",
  },
  {
    key: "cloudbuild",
    base: "https://cloudbuild.googleapis.com",
    description: "Cloud Build API",
  },
  {
    key: "artifactregistry",
    base: "https://artifactregistry.googleapis.com",
    description: "Artifact Registry API",
  },
  {
    key: "container",
    base: "https://container.googleapis.com",
    description: "Kubernetes Engine API",
  },
  {
    key: "cloudfunctions",
    base: "https://cloudfunctions.googleapis.com",
    description: "Cloud Functions API",
  },
  {
    key: "secretmanager",
    base: "https://secretmanager.googleapis.com",
    description: "Secret Manager API",
  },
  {
    key: "logging",
    base: "https://logging.googleapis.com",
    description: "Cloud Logging API",
  },
  {
    key: "monitoring",
    base: "https://monitoring.googleapis.com",
    description: "Cloud Monitoring API",
  },
  {
    key: "cloudbilling",
    base: "https://cloudbilling.googleapis.com",
    description: "Cloud Billing API",
  },
  {
    key: "pubsub",
    base: "https://pubsub.googleapis.com",
    description: "Cloud Pub/Sub API",
  },
  {
    key: "firestore",
    base: "https://firestore.googleapis.com",
    description: "Cloud Firestore API",
  },
  {
    key: "spanner",
    base: "https://spanner.googleapis.com",
    description: "Cloud Spanner API",
  },
] as const;

const GOOGLE_CLOUD_PERMISSION_PREFIXES = new Set([
  "appengine",
  "artifactregistry",
  "bigquery",
  "billing",
  "cloudbuild",
  "cloudfunctions",
  "cloudsql",
  "compute",
  "container",
  "datastore",
  "iam",
  "logging",
  "monitoring",
  "pubsub",
  "resourcemanager",
  "run",
  "secretmanager",
  "serviceusage",
  "spanner",
  "storage",
]);

const API_PERMISSION_PREFIXES: Record<ApiConfig["key"], string> = {
  appengine: "appengine",
  artifactregistry: "artifactregistry",
  bigquery: "bigquery",
  cloudbilling: "billing",
  cloudbuild: "cloudbuild",
  cloudfunctions: "cloudfunctions",
  cloudresourcemanager: "resourcemanager",
  compute: "compute",
  container: "container",
  firestore: "datastore",
  iam: "iam",
  logging: "logging",
  monitoring: "monitoring",
  pubsub: "pubsub",
  run: "run",
  secretmanager: "secretmanager",
  serviceusage: "serviceusage",
  spanner: "spanner",
  sqladmin: "cloudsql",
  storage: "storage",
};

const GENERIC_RESOURCE_SEGMENTS = new Set([
  "folders",
  "locations",
  "organizations",
  "projects",
  "zones",
]);

const RESOURCE_SEGMENT_ALIASES: Partial<
  Record<ApiConfig["key"], Record<string, readonly string[]>>
> = {
  appengine: {
    applications: ["applications"],
    apps: ["applications"],
  },
  artifactregistry: {
    aptArtifacts: ["aptartifacts"],
    dockerImages: ["dockerimages"],
    files: ["files"],
    genericArtifacts: ["files"],
    goModules: ["files"],
    googetArtifacts: ["files"],
    kfpArtifacts: ["kfpartifacts"],
    mavenArtifacts: ["mavenartifacts"],
    npmPackages: ["npmpackages"],
    packages: ["packages"],
    projectConfig: ["projectconfigs"],
    projectSettings: ["projectsettings"],
    pythonPackages: ["pythonpackages"],
    repositories: ["repositories"],
    rules: ["rules"],
    tags: ["tags"],
    versions: ["versions"],
    yumArtifacts: ["yumartifacts"],
  },
  cloudbuild: {
    workerPools: ["workerpools"],
  },
  cloudbilling: {
    billingAccounts: ["accounts"],
    subAccounts: ["accounts"],
  },
  cloudresourcemanager: {
    tagBindings: ["tagValueBindings"],
  },
  firestore: {
    documents: ["entities"],
    fields: ["schemas"],
    indexes: ["schemas"],
  },
  logging: {
    metrics: ["logMetrics"],
  },
  monitoring: {
    serviceLevelObjectives: ["slos"],
  },
  run: {
    workerPools: ["workerpools"],
  },
  sqladmin: {
    Backups: ["backupRuns"],
    connect: ["instances"],
  },
};

const RESOURCE_PATH_ALIASES: Record<string, readonly string[]> = {
  "cloudbilling.billingAccounts.projects": ["resourceAssociations"],
  "cloudbilling.billingAccounts.subAccounts": ["accounts"],
  "cloudbilling.organizations.billingAccounts": ["accounts"],
  "iam.organizations.roles": ["roles"],
  "iam.projects.roles": ["roles"],
  "iam.projects.serviceAccounts": ["serviceAccounts"],
  "iam.projects.serviceAccounts.keys": ["serviceAccountKeys"],
  "iam.roles": ["roles"],
};

const VERB_ALIASES: Record<string, readonly string[]> = {
  CreateBackup: ["create"],
  DeleteBackup: ["delete"],
  GetBackup: ["get"],
  ListBackups: ["list"],
  UpdateBackup: ["update"],
  abandonInstances: ["update"],
  addons: ["update"],
  addAssociation: ["update"],
  addInstances: ["update"],
  addRule: ["update"],
  addVersion: ["add"],
  applyUpdatesToInstances: ["update"],
  aggregatedList: ["list"],
  announce: ["update"],
  batchCreate: ["create"],
  batchDelete: ["delete"],
  batchEnable: ["enable"],
  batchGet: ["get"],
  batchUpdate: ["update"],
  bulkInsert: ["create"],
  bulkRestore: ["restore"],
  bulkSetLabels: ["setLabels"],
  cancel: ["update", "cancel"],
  cloneRules: ["copyRules"],
  compose: ["create"],
  completeUpgrade: ["update"],
  copy: ["create"],
  createInstances: ["update"],
  createAsync: ["create"],
  createDocument: ["create"],
  deletePerInstanceConfigs: ["update"],
  deleteInstances: ["update"],
  deleteRecursive: ["delete"],
  deleteRevision: ["delete"],
  detach: ["update"],
  dropDatabase: ["drop"],
  exportArtifact: ["exportArtifacts"],
  getAssociation: ["get"],
  getRule: ["get"],
  getQueryResults: ["get"],
  import: ["create"],
  importDocuments: ["import"],
  insert: ["create"],
  legacyAbac: ["update"],
  listAssociations: ["list"],
  insertAll: ["updateData"],
  listDocuments: ["list"],
  listErrors: ["list"],
  listInstances: ["list"],
  listManagedInstances: ["list"],
  listPerInstanceConfigs: ["list"],
  locations: ["update"],
  logging: ["update"],
  master: ["update"],
  monitoring: ["update"],
  modifyPushConfig: ["update"],
  patch: ["update"],
  patchRule: ["update"],
  query: ["create"],
  removeAssociation: ["update"],
  removeInstances: ["update"],
  removeRule: ["update"],
  recreateInstances: ["update"],
  resourceLabels: ["update"],
  resumeInstances: ["update"],
  rollback: ["update"],
  resize: ["update"],
  rewrite: ["create"],
  setInstanceTemplate: ["update"],
  setNamedPorts: ["update"],
  setTargetPools: ["update"],
  startIpRotation: ["update"],
  startInstances: ["update"],
  completeIpRotation: ["update"],
  setAddons: ["update"],
  setLegacyAbac: ["update"],
  setLocations: ["update"],
  setLogging: ["update"],
  setMaintenancePolicy: ["update"],
  setMasterAuth: ["update"],
  setMonitoring: ["update"],
  setNetworkPolicy: ["update"],
  setResourceLabels: ["update"],
  updateMaster: ["update"],
  stopInstances: ["update"],
  suspendInstances: ["update"],
  patchPerInstanceConfigs: ["update"],
  updatePerInstanceConfigs: ["update"],
  updateAsync: ["update"],
  upload: ["upload", "create"],
  withdraw: ["update"],
};

const METHOD_PERMISSION_OVERRIDES: Record<string, string> = {
  "appengine.apps.services.versions.instances.debug":
    "appengine.instances.enableDebug",
  "appengine.projects.locations.applications.services.versions.instances.debug":
    "appengine.instances.enableDebug",
  "artifactregistry.projects.getProjectSettings":
    "artifactregistry.projectsettings.get",
  "artifactregistry.projects.locations.getProjectConfig":
    "artifactregistry.projectconfigs.get",
  "artifactregistry.projects.locations.updateProjectConfig":
    "artifactregistry.projectconfigs.update",
  "artifactregistry.projects.updateProjectSettings":
    "artifactregistry.projectsettings.update",
  "bigquery.datasets.list": "bigquery.datasets.get",
  "bigquery.datasets.undelete": "bigquery.datasets.update",
  "bigquery.jobs.cancel": "bigquery.jobs.update",
  "bigquery.jobs.getQueryResults": "bigquery.jobs.get",
  "bigquery.jobs.query": "bigquery.jobs.create",
  "bigquery.models.get": "bigquery.models.getMetadata",
  "bigquery.models.patch": "bigquery.models.updateMetadata",
  "bigquery.tabledata.insertAll": "bigquery.tables.updateData",
  "bigquery.tabledata.list": "bigquery.tables.getData",
  "cloudbilling.projects.getBillingInfo": "billing.resourceAssociations.list",
  "cloudbilling.projects.updateBillingInfo":
    "billing.resourceAssociations.create",
  "cloudbuild.projects.builds.retry": "cloudbuild.builds.create",
  "cloudbuild.projects.locations.builds.retry": "cloudbuild.builds.create",
  "cloudfunctions.projects.locations.functions.generateDownloadUrl":
    "cloudfunctions.functions.sourceCodeGet",
  "cloudfunctions.projects.locations.functions.generateUploadUrl":
    "cloudfunctions.functions.sourceCodeSet",
  "cloudresourcemanager.folders.search": "resourcemanager.folders.get",
  "cloudresourcemanager.liens.create": "resourcemanager.projects.updateLiens",
  "cloudresourcemanager.liens.delete": "resourcemanager.projects.updateLiens",
  "cloudresourcemanager.liens.get": "resourcemanager.projects.get",
  "cloudresourcemanager.liens.list": "resourcemanager.projects.get",
  "cloudresourcemanager.organizations.search":
    "resourcemanager.organizations.get",
  "cloudresourcemanager.projects.search": "resourcemanager.projects.get",
  "cloudresourcemanager.tagValues.tagHolds.create":
    "resourcemanager.tagHolds.create",
  "cloudresourcemanager.tagValues.tagHolds.delete":
    "resourcemanager.tagHolds.delete",
  "cloudresourcemanager.tagValues.tagHolds.list":
    "resourcemanager.tagHolds.list",
  "container.projects.locations.clusters.nodePools.create":
    "container.clusters.update",
  "container.projects.locations.clusters.nodePools.completeUpgrade":
    "container.clusters.update",
  "container.projects.locations.clusters.nodePools.delete":
    "container.clusters.update",
  "container.projects.locations.clusters.nodePools.get":
    "container.clusters.get",
  "container.projects.locations.clusters.nodePools.list":
    "container.clusters.list",
  "container.projects.locations.clusters.nodePools.rollback":
    "container.clusters.update",
  "container.projects.locations.clusters.nodePools.setAutoscaling":
    "container.clusters.update",
  "container.projects.locations.clusters.nodePools.setManagement":
    "container.clusters.update",
  "container.projects.locations.clusters.nodePools.setSize":
    "container.clusters.update",
  "container.projects.locations.clusters.nodePools.update":
    "container.clusters.update",
  "container.projects.zones.clusters.nodePools.create":
    "container.clusters.update",
  "container.projects.zones.clusters.nodePools.autoscaling":
    "container.clusters.update",
  "container.projects.zones.clusters.nodePools.delete":
    "container.clusters.update",
  "container.projects.zones.clusters.nodePools.get": "container.clusters.get",
  "container.projects.zones.clusters.nodePools.list": "container.clusters.list",
  "container.projects.zones.clusters.nodePools.rollback":
    "container.clusters.update",
  "container.projects.zones.clusters.nodePools.setManagement":
    "container.clusters.update",
  "container.projects.zones.clusters.nodePools.setSize":
    "container.clusters.update",
  "container.projects.zones.clusters.nodePools.update":
    "container.clusters.update",
  "firestore.projects.databases.documents.batchWrite":
    "datastore.entities.update",
  "firestore.projects.databases.documents.beginTransaction":
    "datastore.entities.get",
  "firestore.projects.databases.documents.commit": "datastore.entities.update",
  "firestore.projects.databases.documents.listen": "datastore.entities.get",
  "firestore.projects.databases.documents.partitionQuery":
    "datastore.entities.list",
  "firestore.projects.databases.documents.rollback": "datastore.entities.get",
  "firestore.projects.databases.documents.runAggregationQuery":
    "datastore.entities.list",
  "firestore.projects.databases.documents.runQuery": "datastore.entities.list",
  "firestore.projects.databases.documents.write": "datastore.entities.update",
  "firestore.projects.databases.bulkDeleteDocuments":
    "datastore.databases.bulkDelete",
  "firestore.projects.databases.exportDocuments": "datastore.databases.export",
  "firestore.projects.databases.importDocuments": "datastore.databases.import",
  "firestore.projects.databases.restore": "datastore.backups.restoreDatabase",
  "firestore.projects.databases.userCreds.disable":
    "datastore.userCreds.update",
  "firestore.projects.databases.userCreds.enable": "datastore.userCreds.update",
  "firestore.projects.databases.userCreds.resetPassword":
    "datastore.userCreds.update",
  "iam.projects.serviceAccounts.keys.upload": "iam.serviceAccountKeys.create",
  "logging.entries.copy": "logging.buckets.copyLogEntries",
  "logging.entries.list": "logging.logEntries.list",
  "logging.entries.tail": "logging.logEntries.list",
  "logging.entries.write": "logging.logEntries.create",
  "monitoring.projects.groups.members.list": "monitoring.groups.get",
  "monitoring.projects.timeSeries.createService": "monitoring.services.create",
  "pubsub.projects.subscriptions.acknowledge": "pubsub.subscriptions.consume",
  "pubsub.projects.subscriptions.modifyAckDeadline":
    "pubsub.subscriptions.consume",
  "pubsub.projects.subscriptions.modifyPushConfig":
    "pubsub.subscriptions.update",
  "pubsub.projects.subscriptions.pull": "pubsub.subscriptions.consume",
  "pubsub.projects.subscriptions.seek": "pubsub.subscriptions.consume",
  "pubsub.projects.schemas.validateMessage": "pubsub.schemas.validate",
  "pubsub.projects.topics.snapshots.list": "pubsub.snapshots.list",
  "pubsub.projects.topics.subscriptions.list": "pubsub.subscriptions.list",
  "run.projects.locations.builds.submit": "cloudbuild.builds.create",
  "secretmanager.projects.locations.secrets.addVersion":
    "secretmanager.versions.add",
  "secretmanager.projects.secrets.addVersion": "secretmanager.versions.add",
  "spanner.projects.instances.move": "spanner.instances.update",
  "spanner.projects.instances.databases.dropDatabase": "spanner.databases.drop",
  "spanner.projects.instances.databases.restore":
    "spanner.backups.restoreDatabase",
  "spanner.projects.instances.databases.sessions.batchCreate":
    "spanner.sessions.create",
  "spanner.projects.instances.databases.sessions.batchWrite":
    "spanner.databases.write",
  "spanner.projects.instances.databases.sessions.beginTransaction":
    "spanner.databases.beginReadOnlyTransaction",
  "spanner.projects.instances.databases.sessions.commit":
    "spanner.databases.write",
  "spanner.projects.instances.databases.sessions.executeBatchDml":
    "spanner.databases.write",
  "spanner.projects.instances.databases.sessions.executeSql":
    "spanner.databases.select",
  "spanner.projects.instances.databases.sessions.executeStreamingSql":
    "spanner.databases.select",
  "spanner.projects.instances.databases.sessions.partitionQuery":
    "spanner.databases.partitionQuery",
  "spanner.projects.instances.databases.sessions.partitionRead":
    "spanner.databases.partitionRead",
  "spanner.projects.instances.databases.sessions.read":
    "spanner.databases.read",
  "spanner.projects.instances.databases.sessions.rollback":
    "spanner.databases.beginOrRollbackReadWriteTransaction",
  "spanner.projects.instances.databases.sessions.streamingRead":
    "spanner.databases.read",
  "sql.connect.generateEphemeral": "cloudsql.instances.connect",
  "sql.connect.resolve": "cloudsql.instances.connect",
  "sql.instances.pointInTimeRestore": "cloudsql.instances.restoreBackup",
  "sql.projects.instances.getLatestRecoveryTime": "cloudsql.instances.get",
  "sql.projects.instances.rescheduleMaintenance": "cloudsql.instances.update",
  "sql.projects.instances.startExternalSync": "cloudsql.instances.update",
  "sql.projects.instances.verifyExternalSyncSettings": "cloudsql.instances.get",
  "storage.objects.compose": "storage.objects.create",
  "storage.objects.copy": "storage.objects.create",
  "storage.objects.rewrite": "storage.objects.create",
  "storage.objects.watchAll": "storage.objects.list",
};

const EXPLICIT_UNMAPPED_METHOD_PATTERNS = [
  /\.testIamPermissions$/,
  /\.locations\.(get|list)$/,
  /\.operations\.(cancel|delete|get|list|wait)$/,
  /\.projects\.locations\.operations\.(cancel|delete|get|list|wait)$/,
  /\.projects\.zones\.operations\.(cancel|delete|get|list|wait)$/,
  /\.projects\.locations\.(exportImage|exportImageMetadata|exportMetadata|exportProjectMetadata|getDefaultServiceAccount|regionalWebhook)$/,
  /\.apps\.operations\.(get|list)$/,
  /\.apps\.locations\.(get|list)$/,
  /^appengine\.(apps|projects\.locations\.applications)\.(authorizedCertificates|authorizedDomains|domainMappings)\./,
  /^appengine\.(apps|projects\.locations\.applications)\.firewall\.ingressRules\./,
  /^appengine\.apps\.repair$/,
  /\.projects\.locations\.runtimes\.list$/,
  /\.projects\.locations\.getServerConfig$/,
  /\.projects\.zones\.getServerconfig$/,
  /\.projects\.locations\.clusters\.well-known\.getOpenid-configuration$/,
  /\.projects\.locations\.clusters\.getJwks$/,
  /\.projects\.locations\.clusters\.fetchClusterUpgradeInfo$/,
  /\.projects\.locations\.clusters\.nodePools\.fetchNodePoolUpgradeInfo$/,
  /\.projects\.zones\.clusters\.fetchClusterUpgradeInfo$/,
  /\.projects\.zones\.clusters\.nodePools\.fetchNodePoolUpgradeInfo$/,
  /^iam\.iamPolicies\.(lintPolicy|queryAuditableServices)$/,
  /^iam\.permissions\.queryTestablePermissions$/,
  /^iam\.projects\.locations\./,
  /^iam\.locations\./,
  /^cloudbilling\.services\.skus\.list$/,
  /^cloudbilling\.services\.list$/,
  /^artifactregistry\.projects\.locations\.repositories\.googetArtifacts\.import$/,
  /^artifactregistry\.projects\.locations\.repositories\.(checkPrewarmedArtifact|prewarmArtifact|prewarmedArtifacts\.list|removePrewarmedArtifact)$/,
  /^artifactregistry\.projects\.locations\.(getVpcscConfig|updateVpcscConfig)$/,
  /^bigquery\.projects\.(getServiceAccount|list)$/,
  /^bigquery\.routines\.(getIamPolicy|setIamPolicy)$/,
  /^cloudbuild\.(githubDotComWebhook\.receive|webhook|locations\.regionalWebhook)$/,
  /^cloudbuild\.projects(\.locations)?\.triggers\./,
  /^cloudbuild\.projects\.locations\.(bitbucketServerConfigs|gitLabConfigs|githubEnterpriseConfigs)\./,
  /^cloudbuild\.projects\.githubEnterpriseConfigs\./,
  /^cloudfunctions\.projects\.locations\.functions\.(abortFunctionUpgrade|commitFunctionUpgrade|commitFunctionUpgradeAsGen2|detachFunction|redirectFunctionUpgradeTraffic|rollbackFunctionUpgradeTraffic|setupFunctionUpgradeConfig)$/,
  /^cloudresourcemanager\.(effectiveTags|locations\.effectiveTagBindingCollections|locations\.tagBindingCollections|tagBindings)\./,
  /^cloudresourcemanager\.(tagKeys|tagValues)\.getNamespaced$/,
  /^compute\.[^.]+Operations\.(delete|get|list|wait)$/,
  /^compute\.(global|region|zone)Operations\.wait$/,
  /^compute\.(addresses|globalAddresses)\.move$/,
  /^compute\.(backendBuckets|backendServices|regionBackendBuckets|regionBackendServices)\.(getEffectiveSecurityPolicies|getHealth|listUsable|setEdgeSecurityPolicy)$/,
  /^compute\.(globalNetworkEndpointGroups|networkEndpointGroups|regionNetworkEndpointGroups)\.listNetworkEndpoints$/,
  /^compute\.(global|zone)?VmExtensionPolicies\./,
  /^compute\.globalPublicDelegatedPrefixes\.patch$/,
  /^compute\.imageFamilyViews\.get$/,
  /^compute\.(instanceGroupManagerResizeRequests|regionInstanceGroupManagerResizeRequests)\./,
  /^compute\.instances\.(performMaintenance|reportHostAsFaulty)$/,
  /^compute\.(interconnectAttachmentGroups|interconnectGroups)\.(getIamPolicy|getOperationalStatus|setIamPolicy|createMembers)$/,
  /^compute\.interconnects\.getDiagnostics$/,
  /^compute\.(network|regionNetwork)FirewallPolicies\./,
  /^compute\.networks\.(cancelRequestRemovePeering|requestRemovePeering)$/,
  /^compute\.nodeGroups\.listNodes$/,
  /^compute\.organizationSecurityPolicies\./,
  /^compute\.projects\.(disableXpnHost|disableXpnResource|enableXpnHost|enableXpnResource|getXpnHost|getXpnResources|listXpnHosts|moveDisk|moveInstance)$/,
  /^compute\.(reservationBlocks|reservationSubBlocks|reservations)\.(getIamPolicy|setIamPolicy)$/,
  /^compute\.reservationSubBlocks\.getVersion$/,
  /^compute\.reservation(Sub)?Slots\.getVersion$/,
  /^compute\.rollouts\.(advance|pause|resume)$/,
  /^compute\.routers\.(getNatIpInfo|getNatMappingInfo|getRouterStatus|patchRoutePolicy|preview)$/,
  /^compute\.(securityPolicies|regionSecurityPolicies)\.listPreconfiguredExpressionSets$/,
  /^compute\.(regionCompositeHealthChecks|regionHealthSources)\.getHealth$/,
  /^compute\.storagePoolTypes\.(aggregatedList|get|list)$/,
  /^compute\.storagePools\.listDisks$/,
  /^compute\.subnetworks\.listUsable$/,
  /^compute\.targetPools\.(getHealth|setBackup)$/,
  /^compute\.targetTcpProxies\.(setBackendService|setProxyHeader)$/,
  /^compute\.vpnGateways\.getStatus$/,
  /^container\.projects\.aggregated\.usableSubnetworks\.list$/,
  /^container\.projects\.(locations|zones)\.clusters\.(checkAutopilotCompatibility|fetchClusterUpgradeInfo)$/,
  /^container\.projects\.(locations|zones)\.clusters\.nodePools\.fetchNodePoolUpgradeInfo$/,
  /^firestore\.projects\.databases\.documents\.(executePipeline|listCollectionIds)$/,
  /^iam\.roles\.queryGrantableRoles$/,
  /^logging\.(billingAccounts|folders|organizations|projects)?\.?get(Cmek)?Settings$/,
  /^logging\.(folders|organizations)?\.?update(Cmek)?Settings$/,
  /^logging\.(billingAccounts|folders|organizations|projects)\.locations\.(recentQueries|savedQueries)\./,
  /^logging\.monitoredResourceDescriptors\.list$/,
  /^monitoring\.projects\.collectdTimeSeries\.create$/,
  /^monitoring\.uptimeCheckIps\.list$/,
  /^run\.projects\.locations\.instances\./,
  /^run\.projects\.locations\.(jobs\.executions|services\.revisions)\.exportStatus$/,
  /^spanner\.(projects\.instances\.databases\.getScans|scans\.list)$/,
  /^spanner\.projects\.instances\.databases\.sessions\.(adaptMessage|adapter)$/,
  /^sql\.(flags|tiers)\.list$/,
  /^sql\.instances\.(acquireSsrsLease|demote|releaseSsrsLease|switchover)$/,
  /^sql\.sslCerts\.createEphemeral$/,
  /^storage\.(bucketAccessControls|defaultObjectAccessControls|objectAccessControls)\./,
  /^storage\.buckets\.(getStorageLayout|lockRetentionPolicy)$/,
  /^storage\.buckets\.operations\.advanceRelocateBucket$/,
  /^storage\.channels\.stop$/,
  /^storage\.notifications\./,
  /^storage\.projects\.serviceAccount\.get$/,
  /^compute\.(.*\.)?testIamPermissions$/,
] as const;

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function lowerInitial(value: string): string {
  if (value === "") return value;
  return `${value[0]!.toLowerCase()}${value.slice(1)}`;
}

function permissionNamePattern(): RegExp {
  return /\b[a-z][a-z0-9]*\.[a-zA-Z0-9][a-zA-Z0-9.]*\.[a-zA-Z][a-zA-Z0-9]*\b/g;
}

function isGoogleCloudPermissionName(value: string): boolean {
  const segments = value.split(".");
  return (
    segments.length >= 3 &&
    GOOGLE_CLOUD_PERMISSION_PREFIXES.has(segments[0]!) &&
    segments[1] !== "googleapis"
  );
}

function normalizePermissionSourceText(text: string): string {
  return text.replace(/<wbr\s*\/?>/gi, "");
}

export function extractOfficialPermissionNames(text: string): string[] {
  return unique(
    [...normalizePermissionSourceText(text).matchAll(permissionNamePattern())]
      .map((match) => match[0]!)
      .filter(isGoogleCloudPermissionName),
  ).sort();
}

function expandResourceSegment(
  apiKey: ApiConfig["key"],
  segment: string,
): string[] {
  const aliases = RESOURCE_SEGMENT_ALIASES[apiKey]?.[segment] ?? [];
  const regionMatch = /^region([A-Z].+)$/.exec(segment);
  return unique([
    segment,
    segment.toLowerCase(),
    ...(regionMatch ? [lowerInitial(regionMatch[1]!)] : []),
    ...aliases,
  ]);
}

function cartesianJoin(segments: readonly string[][]): string[] {
  let values = [""];
  for (const segment of segments) {
    values = values.flatMap((prefix) => {
      return segment.map((entry) => {
        return prefix === "" ? entry : `${prefix}.${entry}`;
      });
    });
  }
  return values;
}

function resourcePathCandidates(
  apiKey: ApiConfig["key"],
  methodId: string,
  resourcePath: readonly string[],
): string[] {
  const candidates: string[] = [];
  const strippedPath =
    resourcePath.length <= 1
      ? [...resourcePath]
      : resourcePath.filter((segment) => {
          return !GENERIC_RESOURCE_SEGMENTS.has(segment);
        });
  const methodPrefix = methodId.split(".")[0]!;
  const aliasKeys = unique([
    [methodPrefix, ...resourcePath].join("."),
    [methodPrefix, ...strippedPath].join("."),
  ]);
  for (const aliasKey of aliasKeys) {
    candidates.push(...(RESOURCE_PATH_ALIASES[aliasKey] ?? []));
  }

  for (let index = 0; index < strippedPath.length; index += 1) {
    const suffix = strippedPath.slice(index);
    candidates.push(
      ...cartesianJoin(
        suffix.map((segment) => expandResourceSegment(apiKey, segment)),
      ),
    );
  }

  return unique(candidates).filter((candidate) => {
    return candidate !== "";
  });
}

function verbCandidates(verb: string): string[] {
  const canonicalVerb = lowerInitial(verb);
  return unique([
    verb,
    canonicalVerb,
    ...(VERB_ALIASES[verb] ?? []),
    ...(VERB_ALIASES[canonicalVerb] ?? []),
  ]);
}

function methodPermissionCandidates(
  apiKey: ApiConfig["key"],
  methodId: string,
): string[] {
  const [, ...rest] = methodId.split(".");
  const verb = rest.at(-1);
  if (!verb) return [];
  const resourcePath = rest.slice(0, -1);
  const permissionPrefix = API_PERMISSION_PREFIXES[apiKey];
  return unique(
    resourcePathCandidates(apiKey, methodId, resourcePath).flatMap(
      (resource) => {
        return verbCandidates(verb).map((candidateVerb) => {
          return `${permissionPrefix}.${resource}.${candidateVerb}`;
        });
      },
    ),
  );
}

function isExplicitlyUnmappedMethod(methodId: string): boolean {
  return EXPLICIT_UNMAPPED_METHOD_PATTERNS.some((pattern) => {
    return pattern.test(methodId);
  });
}

function permissionForMethod(
  apiKey: ApiConfig["key"],
  methodId: string,
  officialPermissions: ReadonlySet<string>,
): string | null {
  const override = METHOD_PERMISSION_OVERRIDES[methodId];
  if (override !== undefined) {
    if (!officialPermissions.has(override)) {
      throw new Error(
        `Google Cloud permission override for ${methodId} is not in official IAM docs: ${override}`,
      );
    }
    return override;
  }

  for (const candidate of methodPermissionCandidates(apiKey, methodId)) {
    if (officialPermissions.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function extractMethods(
  resources: Record<string, DiscoveryResource>,
): DiscoveryMethod[] {
  const methods: DiscoveryMethod[] = [];
  for (const resource of Object.values(resources)) {
    if (resource.methods) {
      methods.push(...Object.values(resource.methods));
    }
    if (resource.resources) {
      methods.push(...extractMethods(resource.resources));
    }
  }
  return methods;
}

function normalizeTemplatePath(path: string): string {
  return path
    .replace(/^\//, "")
    .replace(/\{\+([^}]+)\}/g, "{$1}")
    .replace(/\{\*([^}]+)\}/g, "{$1}");
}

function methodPathWithServicePath(
  discovery: DiscoveryDocument,
  methodPath: string,
): string {
  const normalized = normalizeTemplatePath(methodPath);
  const servicePath = normalizeTemplatePath(discovery.servicePath ?? "");
  if (servicePath === "") return normalized;
  if (normalized.startsWith(servicePath)) return normalized;
  if (normalized.startsWith("upload/") || normalized.startsWith("download/")) {
    return normalized;
  }
  return `${servicePath.replace(/\/$/, "")}/${normalized}`;
}

function mediaUploadPathForMethod(
  discovery: DiscoveryDocument,
  method: DiscoveryMethod,
  protocolPath: string,
): string {
  const normalized = normalizeTemplatePath(protocolPath);
  if (!method.flatPath || !/\{[+*][^}]+\}/.test(protocolPath)) {
    return normalized;
  }
  const uploadPrefix = normalized.startsWith("resumable/upload/")
    ? "resumable/upload/"
    : normalized.startsWith("upload/")
      ? "upload/"
      : null;
  if (uploadPrefix === null) return normalized;
  return `${uploadPrefix}${methodPathWithServicePath(discovery, method.flatPath)}`;
}

function rulePathsForMethod(
  discovery: DiscoveryDocument,
  method: DiscoveryMethod,
): string[] {
  if (!method.id) {
    throw new Error("Discovery method is missing id");
  }
  const paths = new Set<string>();
  const methodPath = method.flatPath ?? method.path;
  if (methodPath) {
    paths.add(methodPathWithServicePath(discovery, methodPath));
  }

  const protocols = method.mediaUpload?.protocols;
  for (const protocol of [protocols?.simple, protocols?.resumable]) {
    if (protocol?.path) {
      paths.add(mediaUploadPathForMethod(discovery, method, protocol.path));
    }
  }

  return [...paths].sort();
}

function addRule(
  groups: Map<string, Set<string>>,
  permission: string,
  rule: string,
): void {
  const rules = groups.get(permission) ?? new Set<string>();
  rules.add(rule);
  groups.set(permission, rules);
}

function buildPermissionGroups(
  discovery: DiscoveryDocument,
  api: ApiConfig,
  officialPermissions: ReadonlySet<string>,
  unexpectedUnmappedMethods: Set<string>,
  explicitlyUnmappedMethods: string[],
  stats: BuildStats,
): PermissionGroup[] {
  const groups = new Map<string, Set<string>>();

  for (const method of extractMethods(discovery.resources ?? {})) {
    if (!method.id || !method.httpMethod) {
      throw new Error(`${api.key}: Discovery method missing id or httpMethod`);
    }
    stats.totalOperations += 1;
    const permission = permissionForMethod(
      api.key,
      method.id,
      officialPermissions,
    );
    if (permission === null) {
      if (isExplicitlyUnmappedMethod(method.id)) {
        explicitlyUnmappedMethods.push(method.id);
        stats.explicitlyUnmappedOperations += 1;
      } else {
        unexpectedUnmappedMethods.add(method.id);
        stats.unexpectedUnmappedOperations += 1;
      }
      continue;
    }
    for (const path of rulePathsForMethod(discovery, method)) {
      addRule(
        groups,
        permission,
        `${method.httpMethod.toUpperCase()} /${path}`,
      );
    }
    stats.mappedOperations += 1;
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, rules]) => ({
      name,
      rules: sanitizeAndSortRules([...rules]),
    }));
}

async function loadOfficialPermissions(): Promise<Set<string>> {
  const officialPermissions = new Set<string>();
  for (const sourceUrl of GOOGLE_CLOUD_PERMISSION_DOC_URLS) {
    const res = await fetchSpec(
      sourceUrl,
      `google-cloud permission source ${sourceUrl}`,
    );
    const text = await res.text();
    const permissions = extractOfficialPermissionNames(text);
    if (permissions.length === 0) {
      throw new Error(
        `Google Cloud permission source ${sourceUrl} did not expose any IAM permissions`,
      );
    }
    for (const permission of permissions) {
      officialPermissions.add(permission);
    }
  }
  return officialPermissions;
}

function validateMappingsWereUsed(
  overridesSeen: Set<string>,
  apiPermissions: Map<string, PermissionGroup[]>,
  unexpectedUnmappedMethods: ReadonlySet<string>,
): void {
  const missing = Object.keys(METHOD_PERMISSION_OVERRIDES).filter(
    (methodId) => {
      return !overridesSeen.has(methodId);
    },
  );
  if (missing.length > 0) {
    throw new Error(
      `Google Cloud permission overrides reference missing Discovery methods:\n${missing
        .sort()
        .map((methodId) => `  - ${methodId}`)
        .join("\n")}`,
    );
  }

  const emptyMappedApis = API_CONFIGS.filter((api) => {
    const permissions = apiPermissions.get(api.key);
    return permissions === undefined || permissions.length === 0;
  });
  if (emptyMappedApis.length > 0) {
    throw new Error(
      `Google Cloud generator produced no mapped permissions for configured APIs:\n${emptyMappedApis
        .map((api) => `  - ${api.key}`)
        .join("\n")}`,
    );
  }
  if (unexpectedUnmappedMethods.size > 0) {
    throw new Error(
      `Google Cloud Discovery methods need permission mapping or explicit unmapped allowlist:\n${[
        ...unexpectedUnmappedMethods,
      ]
        .sort()
        .map((methodId) => `  - ${methodId}`)
        .join("\n")}`,
    );
  }
}

function generateTypeScript(
  apiPermissions: Map<string, PermissionGroup[]>,
  stats: BuildStats,
): string {
  const lines: string[] = [
    "// Auto-generated from Google Discovery documents and official Google Cloud IAM docs.",
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:google-cloud",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../firewall-types";',
    "",
    "export const googleCloudFirewall = {",
    '  name: "google-cloud",',
    '  description: "Google Cloud APIs",',
    "  placeholders: {",
    `    GOOGLE_CLOUD_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
  ];

  for (const api of API_CONFIGS) {
    const permissions = apiPermissions.get(api.key) ?? [];
    lines.push("    {");
    lines.push(`      base: "${api.base}",`);
    lines.push("      auth: {");
    lines.push("        headers: {");
    lines.push(
      '          Authorization: "Bearer ${{ secrets.GOOGLE_CLOUD_TOKEN }}",',
    );
    lines.push("        },");
    lines.push("      },");
    lines.push("      permissions: [");
    lines.push(...renderPermissions(permissions));
    lines.push("      ],");
    lines.push("    },");
  }

  lines.push("  ],");
  lines.push("} as const satisfies FirewallConfig;");
  lines.push("");
  lines.push(...renderStats(stats));

  return lines.join("\n");
}

function renderStats(stats: BuildStats): string[] {
  return [
    "export const googleCloudGenerationStats = {",
    `  totalOperations: ${stats.totalOperations},`,
    `  mappedOperations: ${stats.mappedOperations},`,
    `  explicitlyUnmappedOperations: ${stats.explicitlyUnmappedOperations},`,
    `  unexpectedUnmappedOperations: ${stats.unexpectedUnmappedOperations},`,
    `  permissionCount: ${stats.permissionCount},`,
    "} as const;",
    "",
  ];
}

function logUnmapped(kind: string, methodIds: string[]): void {
  if (methodIds.length === 0) return;
  console.error(`  ${methodIds.length} ${kind} Google Cloud operations:`);
  for (const methodId of methodIds.slice(0, 20)) {
    console.error(`    ${methodId}`);
  }
  if (methodIds.length > 20) {
    console.error(`    ... ${methodIds.length - 20} more`);
  }
}

export async function generate(): Promise<void> {
  console.error("Generating Google Cloud firewall config...");
  const officialPermissions = await loadOfficialPermissions();

  const apiPermissions = new Map<string, PermissionGroup[]>();
  const overridesSeen = new Set<string>();
  const unexpectedUnmappedMethods = new Set<string>();
  const explicitlyUnmappedMethods: string[] = [];
  const stats: BuildStats = {
    totalOperations: 0,
    mappedOperations: 0,
    explicitlyUnmappedOperations: 0,
    unexpectedUnmappedOperations: 0,
    permissionCount: 0,
  };

  for (const api of API_CONFIGS) {
    const discoveryUrl = GOOGLE_CLOUD_DISCOVERY_URLS[api.key];
    const res = await fetchSpec(discoveryUrl, `${api.key} discovery document`);
    const discovery = (await res.json()) as DiscoveryDocument;
    console.error(
      `  ${api.description}: ${discovery.version ?? "unknown version"}`,
    );

    const permissions = buildPermissionGroups(
      discovery,
      api,
      officialPermissions,
      unexpectedUnmappedMethods,
      explicitlyUnmappedMethods,
      stats,
    );
    for (const method of extractMethods(discovery.resources ?? {})) {
      if (method.id && METHOD_PERMISSION_OVERRIDES[method.id]) {
        overridesSeen.add(method.id);
      }
    }
    if (permissions.length > 0) {
      apiPermissions.set(api.key, permissions);
    }
  }

  validateMappingsWereUsed(
    overridesSeen,
    apiPermissions,
    unexpectedUnmappedMethods,
  );

  const allPermissions = [...apiPermissions.values()].flat();
  stats.permissionCount = allPermissions.length;
  logUnmapped("explicitly unmapped", explicitlyUnmappedMethods);
  logStats(allPermissions);
  console.error(
    `  ${stats.mappedOperations}/${stats.totalOperations} operations mapped`,
  );
  writeOutput(
    "google-cloud",
    generateTypeScript(apiPermissions, stats),
    import.meta.dirname,
  );
}
