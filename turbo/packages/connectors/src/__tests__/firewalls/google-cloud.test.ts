import { describe, expect, it } from "vitest";

import { findMatchingPermissions } from "../../firewall-rule-matcher";
import {
  getConnectorFirewall,
  getDefaultFirewallPolicies,
} from "../../firewalls";

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
      findPermissions(base, "GET", "/storage/v1/b/bucket/o/folder/object.txt"),
    ).toEqual(["storage.objects.get"]);
    expect(
      findPermissions(base, "POST", "/upload/storage/v1/b/bucket/o"),
    ).toEqual(["storage.objects.create"]);
  });

  it("uses official IAM permission names instead of generic read/write groups", () => {
    expect(permissionNames()).toContain("compute.instances.create");
    expect(permissionNames()).toContain("storage.objects.create");
    expect(permissionNames()).not.toContain("compute.instances.insert");
    expect(permissionNames()).not.toContain("storage.objects.insert");

    const genericNames = permissionNames().filter((name) => {
      return name.endsWith(".read") || name.endsWith(".write");
    });
    expect(genericNames).toEqual([]);
  });

  it("keeps Google Cloud default policies non-breaking", () => {
    const policy = getDefaultFirewallPolicies("google-cloud");

    expect(policy.policies["compute.instances.create"]).toBe("allow");
    expect(policy.policies["resourcemanager.projects.setIamPolicy"]).toBe(
      "allow",
    );
    expect(policy.policies["serviceusage.services.enable"]).toBe("allow");
    expect(policy.policies["storage.objects.create"]).toBe("allow");
    expect(policy.unknownPolicy).toBe("allow");
  });
});
