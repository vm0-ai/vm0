import { http, HttpResponse } from "msw";

/**
 * Default MSW handlers for schedule API endpoints.
 *
 * These provide default responses for testing. Individual tests can override
 * these handlers using server.use() to test specific scenarios.
 */
export const scheduleHandlers = [
  // GET /api/agent/schedules - listSchedules
  http.get("http://localhost:3000/api/agent/schedules", () => {
    return HttpResponse.json({ schedules: [] }, { status: 200 });
  }),

  // POST /api/agent/schedules - deploySchedule
  http.post("http://localhost:3000/api/agent/schedules", () => {
    return HttpResponse.json(
      {
        created: true,
        schedule: {
          id: "schedule-default-id",
          composeId: "compose-default-id",
          composeName: "test-agent",
          scopeSlug: "user-default",
          name: "test-schedule",
          cronExpression: "0 9 * * *",
          atTime: null,
          timezone: "UTC",
          prompt: "Test prompt",
          vars: null,
          secretNames: null,
          artifactName: null,
          artifactVersion: null,
          volumeVersions: null,
          enabled: false,
          nextRunAt: new Date(Date.now() + 86400000).toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      { status: 201 },
    );
  }),

  // GET /api/agent/schedules/:name - getScheduleByName
  http.get("http://localhost:3000/api/agent/schedules/:name", () => {
    return HttpResponse.json(
      {
        error: { message: "Schedule not found", code: "NOT_FOUND" },
      },
      { status: 404 },
    );
  }),

  // DELETE /api/agent/schedules/:name - deleteSchedule
  http.delete("http://localhost:3000/api/agent/schedules/:name", () => {
    return new HttpResponse(null, { status: 204 });
  }),

  // POST /api/agent/schedules/:name/enable - enableSchedule
  http.post("http://localhost:3000/api/agent/schedules/:name/enable", () => {
    return HttpResponse.json(
      {
        id: "schedule-default-id",
        composeId: "compose-default-id",
        composeName: "test-agent",
        scopeSlug: "user-default",
        name: "test-schedule",
        cronExpression: "0 9 * * *",
        atTime: null,
        timezone: "UTC",
        prompt: "Test prompt",
        vars: null,
        secretNames: null,
        artifactName: null,
        artifactVersion: null,
        volumeVersions: null,
        enabled: true,
        nextRunAt: new Date(Date.now() + 86400000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { status: 200 },
    );
  }),

  // POST /api/agent/schedules/:name/disable - disableSchedule
  http.post("http://localhost:3000/api/agent/schedules/:name/disable", () => {
    return HttpResponse.json(
      {
        id: "schedule-default-id",
        composeId: "compose-default-id",
        composeName: "test-agent",
        scopeSlug: "user-default",
        name: "test-schedule",
        cronExpression: "0 9 * * *",
        atTime: null,
        timezone: "UTC",
        prompt: "Test prompt",
        vars: null,
        secretNames: null,
        artifactName: null,
        artifactVersion: null,
        volumeVersions: null,
        enabled: false,
        nextRunAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { status: 200 },
    );
  }),

  // GET /api/agent/schedules/:name/runs - listScheduleRuns
  http.get("http://localhost:3000/api/agent/schedules/:name/runs", () => {
    return HttpResponse.json({ runs: [] }, { status: 200 });
  }),
];
