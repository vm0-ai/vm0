import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { zeroMapsCommand } from "../index";

describe("zero maps command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("posts directions requests to the maps API and prints JSON", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/maps/directions",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            operation: "directions",
            provider: "google-maps",
            creditsCharged: 15,
            billingCategory: "routes.compute_routes.essentials",
            result: { distanceMeters: 42 },
          });
        },
      ),
    );

    await zeroMapsCommand.parseAsync([
      "node",
      "cli",
      "directions",
      "--origin",
      "SFO",
      "--destination",
      "Mountain View",
      "--json",
    ]);

    expect(requestBody).toEqual({
      origin: "SFO",
      destination: "Mountain View",
      mode: "driving",
    });
    expect(mockConsoleLog).toHaveBeenCalledWith(
      JSON.stringify({
        operation: "directions",
        provider: "google-maps",
        creditsCharged: 15,
        billingCategory: "routes.compute_routes.essentials",
        result: { distanceMeters: 42 },
      }),
    );
  });

  it("defaults places search to a small result limit", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/maps/places/search",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            operation: "places.search",
            provider: "google-maps",
            creditsCharged: 96,
            result: { places: [] },
          });
        },
      ),
    );

    await zeroMapsCommand.parseAsync([
      "node",
      "cli",
      "places",
      "search",
      "--query",
      "coffee near Union Square SF",
      "--json",
    ]);

    expect(requestBody).toEqual({
      query: "coffee near Union Square SF",
      limit: 5,
    });
  });

  it("renders credit metadata in human output", async () => {
    server.use(
      http.post("http://localhost:3000/api/zero/maps/geocode", () => {
        return HttpResponse.json({
          operation: "geocode",
          provider: "google-maps",
          creditsCharged: 15,
          billingCategory: "geocoding",
          billingQuantity: 1,
          result: {
            formattedAddress: "1 Infinite Loop, Cupertino, CA",
            location: { lat: 37.3317, lng: -122.0301 },
          },
        });
      }),
    );

    await zeroMapsCommand.parseAsync([
      "node",
      "cli",
      "geocode",
      "--address",
      "1 Infinite Loop, Cupertino",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("✓ Geocode completed");
    expect(output).toContain("Provider: google-maps");
    expect(output).toContain("Billing category: geocoding");
    expect(output).toContain("Credits charged: 15");
    expect(output).toContain("1 Infinite Loop, Cupertino, CA");
  });

  it("shows auth guidance when no token is available", async () => {
    vi.stubEnv("ZERO_TOKEN", undefined);
    vi.stubEnv("VM0_TOKEN", undefined);

    await expect(
      zeroMapsCommand.parseAsync([
        "node",
        "cli",
        "geocode",
        "--address",
        "1 Infinite Loop, Cupertino",
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain("✗ Not authenticated");
    expect(errors).toContain("Run: vm0 auth login");
  });
});
