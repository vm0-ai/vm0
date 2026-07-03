import { describe, expect, it } from "vitest";

import {
  extractOfficialPermissionNames,
  googleCloudRulesForDiscoveryMethod,
  type GoogleCloudDiscoveryDocument,
} from "../google-cloud";

describe("extractOfficialPermissionNames", () => {
  it("normalizes Google documentation word-break tags inside permission names", () => {
    expect(
      extractOfficialPermissionNames(
        "datastore.<wbr>keyVisualizerScans.<wbr>get",
      ),
    ).toEqual(["datastore.keyVisualizerScans.get"]);
  });

  it("does not treat Google API hosts as IAM permissions", () => {
    expect(
      extractOfficialPermissionNames(
        "Use https://compute.googleapis.com and compute.googleapis.cn",
      ),
    ).toEqual([]);
  });
});

describe("googleCloudRulesForDiscoveryMethod", () => {
  it("adds media-phase PUT rules for resumable upload methods", () => {
    const discovery: GoogleCloudDiscoveryDocument = {
      servicePath: "bigquery/v2/",
    };

    expect(
      googleCloudRulesForDiscoveryMethod(discovery, {
        id: "bigquery.jobs.insert",
        httpMethod: "POST",
        path: "projects/{projectId}/jobs",
        supportsMediaUpload: true,
        mediaUpload: {
          protocols: {
            simple: {
              path: "upload/bigquery/v2/projects/{projectId}/jobs",
            },
            resumable: {
              path: "resumable/upload/bigquery/v2/projects/{projectId}/jobs",
            },
          },
        },
      }),
    ).toEqual([
      "POST /bigquery/v2/projects/{projectId}/jobs",
      "POST /resumable/upload/bigquery/v2/projects/{projectId}/jobs",
      "PUT /resumable/upload/bigquery/v2/projects/{projectId}/jobs",
      "POST /upload/bigquery/v2/projects/{projectId}/jobs",
      "PUT /upload/bigquery/v2/projects/{projectId}/jobs",
    ]);
  });
});
