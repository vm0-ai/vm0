import { beforeAll, describe, expect, it } from "vitest";
import { fetchSpec } from "../codegen";
import {
  buildGoogleCalendarOfficialRouteKeys,
  GOOGLE_CALENDAR_DISCOVERY_URL,
  GOOGLE_CALENDAR_PERMISSION_MANIFEST,
  validateGoogleCalendarPermissionManifest,
  type GoogleCalendarDiscoveryDocument,
  type GoogleCalendarManifestPermission,
} from "../google-calendar";

async function loadDiscovery(): Promise<GoogleCalendarDiscoveryDocument> {
  const response = await fetchSpec(
    GOOGLE_CALENDAR_DISCOVERY_URL,
    "google-calendar test discovery document",
  );
  return (await response.json()) as GoogleCalendarDiscoveryDocument;
}

function cloneManifest(): GoogleCalendarManifestPermission[] {
  return GOOGLE_CALENDAR_PERMISSION_MANIFEST.map((permission) => {
    return {
      ...permission,
      routeKeys: [...permission.routeKeys],
    };
  });
}

function manifestPermission(name: string): GoogleCalendarManifestPermission {
  const permission = GOOGLE_CALENDAR_PERMISSION_MANIFEST.find((candidate) => {
    return candidate.name === name;
  });
  if (!permission) {
    throw new Error(`Missing Google Calendar manifest permission: ${name}`);
  }
  return permission;
}

describe("Google Calendar permission manifest", () => {
  let officialRouteKeys: Set<string>;

  beforeAll(async () => {
    officialRouteKeys = buildGoogleCalendarOfficialRouteKeys(
      await loadDiscovery(),
    );
  });

  it("matches the official Discovery route set exactly", () => {
    expect(officialRouteKeys.size).toBe(37);

    expect(() => {
      validateGoogleCalendarPermissionManifest(
        officialRouteKeys,
        GOOGLE_CALENDAR_PERMISSION_MANIFEST,
      );
    }).not.toThrow();
  });

  it("fails when the manifest contains a route absent from Discovery", () => {
    const manifest = cloneManifest();
    manifest[0] = {
      ...manifest[0]!,
      routeKeys: [
        ...manifest[0]!.routeKeys,
        "base:GET /v3/calendars/{calendarId}/bogus",
      ],
    };

    expect(() => {
      validateGoogleCalendarPermissionManifest(officialRouteKeys, manifest);
    }).toThrow("Unknown Google Calendar manifest route keys");
  });

  it("fails when Discovery contains a route missing from the manifest", () => {
    const changedOfficialRoutes = new Set(officialRouteKeys);
    changedOfficialRoutes.add("base:GET /v3/new-official-route");

    expect(() => {
      validateGoogleCalendarPermissionManifest(
        changedOfficialRoutes,
        GOOGLE_CALENDAR_PERMISSION_MANIFEST,
      );
    }).toThrow("Missing Google Calendar manifest route keys");
  });

  it("fails duplicate route assignments", () => {
    const duplicateRoute = "base:GET /v3/calendars/{calendarId}";
    const manifest = cloneManifest();
    manifest[1] = {
      ...manifest[1]!,
      routeKeys: [...manifest[1]!.routeKeys, duplicateRoute],
    };

    expect(() => {
      validateGoogleCalendarPermissionManifest(officialRouteKeys, manifest);
    }).toThrow("Duplicate Google Calendar manifest route assignments");
  });

  it("keeps sharing ACL routes separate from calendar metadata", () => {
    const calendarsRead = manifestPermission("calendars.read");
    const aclRead = manifestPermission("acl.read");
    const aclWrite = manifestPermission("acl.write");

    expect(calendarsRead.routeKeys).toEqual([
      "base:GET /v3/calendars/{calendarId}",
    ]);
    expect(aclRead.routeKeys).toEqual([
      "base:GET /v3/calendars/{calendarId}/acl",
      "base:GET /v3/calendars/{calendarId}/acl/{ruleId}",
    ]);
    expect(aclWrite.routeKeys).toEqual([
      "base:PATCH /v3/calendars/{calendarId}/acl/{ruleId}",
      "base:POST /v3/calendars/{calendarId}/acl",
      "base:PUT /v3/calendars/{calendarId}/acl/{ruleId}",
    ]);
  });

  it("keeps event reads, writes, deletes, and watches separate", () => {
    const eventsRead = manifestPermission("events.read");
    const eventsWrite = manifestPermission("events.write");
    const eventsDelete = manifestPermission("events.delete");
    const notificationsWrite = manifestPermission("notifications.write");

    expect(eventsRead.routeKeys).toEqual([
      "base:GET /v3/calendars/{calendarId}/events",
      "base:GET /v3/calendars/{calendarId}/events/{eventId}",
      "base:GET /v3/calendars/{calendarId}/events/{eventId}/instances",
    ]);
    expect(eventsWrite.routeKeys).toContain(
      "base:POST /v3/calendars/{calendarId}/events/{eventId}/move",
    );
    expect(eventsDelete.routeKeys).toEqual([
      "base:DELETE /v3/calendars/{calendarId}/events/{eventId}",
    ]);
    expect(notificationsWrite.routeKeys).toContain(
      "base:POST /v3/calendars/{calendarId}/events/watch",
    );
    expect(eventsRead.routeKeys).not.toContain(
      "base:POST /v3/calendars/{calendarId}/events/watch",
    );
  });

  it("does not expose Google OAuth scope names as permissions", () => {
    const names = GOOGLE_CALENDAR_PERMISSION_MANIFEST.map((permission) => {
      return permission.name;
    });

    expect(names).not.toContain("calendar");
    expect(names).not.toContain("calendar.events");
    expect(names).not.toContain("calendar.readonly");
    expect(
      names.every((name) => {
        return !name.startsWith("calendar.");
      }),
    ).toBe(true);
  });

  it("groups every permission into a resource-oriented category", () => {
    const categoriesByName = Object.fromEntries(
      GOOGLE_CALENDAR_PERMISSION_MANIFEST.map((permission) => {
        return [permission.name, permission.category];
      }),
    );

    expect(categoriesByName).toEqual({
      "acl.delete": "Sharing",
      "acl.read": "Sharing",
      "acl.write": "Sharing",
      "calendar-list.delete": "Calendar List",
      "calendar-list.read": "Calendar List",
      "calendar-list.write": "Calendar List",
      "calendars.clear": "Calendars",
      "calendars.delete": "Calendars",
      "calendars.read": "Calendars",
      "calendars.write": "Calendars",
      "colors.read": "Availability",
      "events.delete": "Events",
      "events.read": "Events",
      "events.write": "Events",
      "freebusy.query": "Availability",
      "notifications.write": "Notifications",
      "settings.read": "Settings",
    });
  });
});
