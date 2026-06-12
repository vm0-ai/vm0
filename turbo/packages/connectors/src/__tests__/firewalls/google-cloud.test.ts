import { describe, expect, it } from "vitest";

import { findMatchingPermissions } from "../../firewall-rule-matcher";
import {
  getConnectorFirewall,
  getDefaultFirewallPolicies,
} from "../../firewalls";
import { googleCloudGenerationStats } from "../../firewalls/google-cloud.generated";

const googleCloudFirewall = getConnectorFirewall("google-cloud");

function findPermissions(
  apiBase: string,
  method: string,
  path: string,
): string[] {
  return findMatchingPermissions(method, path, googleCloudFirewall, {
    apiBase,
  });
}

function permissionNames(): string[] {
  return googleCloudFirewall.apis.flatMap((api) => {
    return (
      api.permissions?.map((permission) => {
        return permission.name;
      }) ?? []
    );
  });
}

describe("google-cloud firewall", () => {
  it("keeps the existing Google Cloud host coverage", () => {
    expect(
      googleCloudFirewall.apis.map((api) => {
        return api.base;
      }),
    ).toEqual([
      "https://cloudresourcemanager.googleapis.com",
      "https://serviceusage.googleapis.com",
      "https://iam.googleapis.com",
      "https://compute.googleapis.com",
      "https://appengine.googleapis.com",
      "https://sqladmin.googleapis.com",
      "https://bigquery.googleapis.com",
      "https://storage.googleapis.com",
      "https://run.googleapis.com",
      "https://cloudbuild.googleapis.com",
      "https://artifactregistry.googleapis.com",
      "https://container.googleapis.com",
      "https://cloudfunctions.googleapis.com",
      "https://secretmanager.googleapis.com",
      "https://logging.googleapis.com",
      "https://monitoring.googleapis.com",
      "https://cloudbilling.googleapis.com",
      "https://pubsub.googleapis.com",
      "https://firestore.googleapis.com",
      "https://spanner.googleapis.com",
    ]);
  });

  it("exposes mapped permissions for every existing Google Cloud host", () => {
    for (const api of googleCloudFirewall.apis) {
      expect(api.permissions?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("records Google Cloud operation coverage stats", () => {
    expect(googleCloudGenerationStats.totalOperations).toBeGreaterThan(0);
    expect(googleCloudGenerationStats.mappedOperations).toBeGreaterThan(0);
    expect(
      googleCloudGenerationStats.explicitlyUnmappedOperations,
    ).toBeGreaterThan(0);
    expect(googleCloudGenerationStats.unexpectedUnmappedOperations).toBe(0);
    expect(
      googleCloudGenerationStats.mappedOperations +
        googleCloudGenerationStats.explicitlyUnmappedOperations +
        googleCloudGenerationStats.unexpectedUnmappedOperations,
    ).toBe(googleCloudGenerationStats.totalOperations);
    expect(googleCloudGenerationStats.permissionCount).toBe(
      permissionNames().length,
    );
  });

  it("matches Compute Engine instance endpoints to official IAM permissions", () => {
    const base = "https://compute.googleapis.com";

    expect(
      findPermissions(
        base,
        "GET",
        "/compute/v1/projects/project/zones/us-central1-a/instances/vm-1",
      ),
    ).toEqual(["compute.instances.get"]);
    expect(
      findPermissions(
        base,
        "GET",
        "/compute/v1/projects/project/zones/us-central1-a/instances",
      ),
    ).toEqual(["compute.instances.list"]);
    expect(
      findPermissions(
        base,
        "POST",
        "/compute/v1/projects/project/zones/us-central1-a/instances",
      ),
    ).toEqual(["compute.instances.create"]);
    expect(
      findPermissions(
        base,
        "DELETE",
        "/compute/v1/projects/project/zones/us-central1-a/instances/vm-1",
      ),
    ).toEqual(["compute.instances.delete"]);
  });

  it("matches Resource Manager project endpoints to official IAM permissions", () => {
    const base = "https://cloudresourcemanager.googleapis.com";

    expect(findPermissions(base, "GET", "/v3/projects/project")).toEqual([
      "resourcemanager.projects.get",
    ]);
    expect(
      findPermissions(base, "POST", "/v3/projects/project:setIamPolicy"),
    ).toEqual(["resourcemanager.projects.setIamPolicy"]);
  });

  it("matches Service Usage service endpoints to official IAM permissions", () => {
    const base = "https://serviceusage.googleapis.com";

    expect(
      findPermissions(
        base,
        "POST",
        "/v1/projects/project/services/compute.googleapis.com:enable",
      ),
    ).toEqual(["serviceusage.services.enable"]);
    expect(
      findPermissions(
        base,
        "POST",
        "/v1/projects/project/services/compute.googleapis.com:disable",
      ),
    ).toEqual(["serviceusage.services.disable"]);
  });

  it("matches Cloud Storage endpoints to official IAM permissions", () => {
    const base = "https://storage.googleapis.com";

    expect(
      findPermissions(
        base,
        "GET",
        "/storage/v1/b/bucket/o/folder%2Fobject.txt",
      ),
    ).toEqual(["storage.objects.get"]);
    expect(
      findPermissions(
        base,
        "PATCH",
        "/storage/v1/b/bucket/o/folder%2Fobject.txt",
      ),
    ).toEqual(["storage.objects.update"]);
    expect(
      findPermissions(
        base,
        "PUT",
        "/storage/v1/b/bucket/o/folder%2Fobject.txt",
      ),
    ).toEqual(["storage.objects.update"]);
    expect(
      findPermissions(
        base,
        "GET",
        "/storage/v1/b/bucket/o/folder%2Fobject.txt/iam",
      ),
    ).toEqual(["storage.objects.getIamPolicy"]);
    expect(
      findPermissions(
        base,
        "GET",
        "/storage/v1/b/bucket/o/folder/object.txt/iam",
      ),
    ).toEqual([]);
    expect(
      findPermissions(base, "POST", "/upload/storage/v1/b/bucket/o"),
    ).toEqual(["storage.objects.create"]);
  });

  it("matches representative endpoints across Google Cloud APIs to official IAM permissions", () => {
    expect(
      findPermissions(
        "https://iam.googleapis.com",
        "GET",
        "/v1/projects/project/serviceAccounts/service-account",
      ),
    ).toEqual(["iam.serviceAccounts.get"]);
    expect(
      findPermissions("https://appengine.googleapis.com", "POST", "/v1/apps"),
    ).toEqual(["appengine.applications.create"]);
    expect(
      findPermissions(
        "https://sqladmin.googleapis.com",
        "POST",
        "/v1/projects/project/instances",
      ),
    ).toEqual(["cloudsql.instances.create"]);
    expect(
      findPermissions(
        "https://bigquery.googleapis.com",
        "POST",
        "/bigquery/v2/projects/project/datasets/dataset/tables",
      ),
    ).toEqual(["bigquery.tables.create"]);
    expect(
      findPermissions(
        "https://bigquery.googleapis.com",
        "POST",
        "/upload/bigquery/v2/projects/project/jobs",
      ),
    ).toEqual(["bigquery.jobs.create"]);
    expect(
      findPermissions(
        "https://run.googleapis.com",
        "POST",
        "/v2/projects/project/locations/us-central1/services",
      ),
    ).toEqual(["run.services.create"]);
    expect(
      findPermissions(
        "https://cloudbuild.googleapis.com",
        "POST",
        "/v1/projects/project/builds",
      ),
    ).toEqual(["cloudbuild.builds.create"]);
    expect(
      findPermissions(
        "https://artifactregistry.googleapis.com",
        "POST",
        "/v1/projects/project/locations/us/repositories",
      ),
    ).toEqual(["artifactregistry.repositories.create"]);
    expect(
      findPermissions(
        "https://artifactregistry.googleapis.com",
        "POST",
        "/upload/v1/projects/project/locations/us/repositories/repo/aptArtifacts:create",
      ),
    ).toEqual(["artifactregistry.aptartifacts.create"]);
    expect(
      findPermissions(
        "https://container.googleapis.com",
        "POST",
        "/v1/projects/project/locations/us-central1/clusters",
      ),
    ).toEqual(["container.clusters.create"]);
    expect(
      findPermissions(
        "https://cloudfunctions.googleapis.com",
        "POST",
        "/v2/projects/project/locations/us-central1/functions",
      ),
    ).toEqual(["cloudfunctions.functions.create"]);
    expect(
      findPermissions(
        "https://secretmanager.googleapis.com",
        "GET",
        "/v1/projects/project/secrets/secret/versions/latest:access",
      ),
    ).toEqual(["secretmanager.versions.access"]);
    expect(
      findPermissions(
        "https://logging.googleapis.com",
        "POST",
        "/v2/projects/project/sinks",
      ),
    ).toEqual(["logging.sinks.create"]);
    expect(
      findPermissions(
        "https://monitoring.googleapis.com",
        "POST",
        "/v3/projects/project/alertPolicies",
      ),
    ).toEqual(["monitoring.alertPolicies.create"]);
    expect(
      findPermissions(
        "https://cloudbilling.googleapis.com",
        "GET",
        "/v1/billingAccounts/123",
      ),
    ).toEqual(["billing.accounts.get"]);
    expect(
      findPermissions(
        "https://pubsub.googleapis.com",
        "POST",
        "/v1/projects/project/topics/topic:publish",
      ),
    ).toEqual(["pubsub.topics.publish"]);
    expect(
      findPermissions(
        "https://firestore.googleapis.com",
        "POST",
        "/v1/projects/project/databases",
      ),
    ).toEqual(["datastore.databases.create"]);
    expect(
      findPermissions(
        "https://spanner.googleapis.com",
        "POST",
        "/v1/projects/project/instances",
      ),
    ).toEqual(["spanner.instances.create"]);
  });

  it("uses official IAM permission names instead of generic read/write groups", () => {
    expect(permissionNames()).toContain("compute.instances.create");
    expect(permissionNames()).toContain("storage.objects.create");
    expect(permissionNames()).toContain("spanner.databases.read");
    expect(permissionNames()).toContain("spanner.databases.write");
    expect(permissionNames()).not.toContain("read");
    expect(permissionNames()).not.toContain("write");
    expect(permissionNames()).not.toContain("compute.instances.insert");
    expect(permissionNames()).not.toContain("storage.objects.insert");
    expect(permissionNames()).not.toContain("compute.instances.read");
    expect(permissionNames()).not.toContain("storage.objects.write");
  });

  it("keeps Google Cloud default policies non-breaking", () => {
    const policy = getDefaultFirewallPolicies("google-cloud");

    expect(policy.policies["compute.instances.create"]).toBe("allow");
    expect(policy.policies["resourcemanager.projects.setIamPolicy"]).toBe(
      "allow",
    );
    expect(policy.policies["serviceusage.services.enable"]).toBe("allow");
    expect(policy.policies["storage.objects.create"]).toBe("allow");
    expect(policy.policies["run.services.create"]).toBe("allow");
    expect(policy.policies["secretmanager.versions.access"]).toBe("allow");
    expect(policy.unknownPolicy).toBe("allow");
  });
});
