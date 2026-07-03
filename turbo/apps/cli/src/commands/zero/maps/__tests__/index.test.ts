import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import chalk from "chalk";
import { mkdtempSync } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { zeroMapsCommand } from "../index";

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "zero-maps-home-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => {
      return TEST_HOME;
    },
  };
});

describe("zero maps command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(async () => {
    await fs.rm(path.join(TEST_HOME, ".vm0"), { recursive: true, force: true });
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
  });

  afterEach(async () => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
    await fs.rm(path.join(TEST_HOME, ".vm0"), { recursive: true, force: true });
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
            creditsCharged: 6,
            billingCategory: "routes.directions",
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
        creditsCharged: 6,
        billingCategory: "routes.directions",
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
            creditsCharged: 39,
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
      fields: "pro",
    });
  });

  it("posts Enterprise places search fieldsets to the maps API", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/maps/places/search",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            operation: "places.search",
            provider: "google-maps",
            creditsCharged: 42,
            billingCategory: "places.text_search.enterprise",
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
      "--fields",
      "enterprise",
      "--json",
    ]);

    expect(requestBody).toEqual({
      query: "coffee near Union Square SF",
      limit: 5,
      fields: "enterprise",
    });
  });

  it("posts Enterprise place details fieldsets to the maps API", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/maps/places/details",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            operation: "places.details",
            provider: "google-maps",
            creditsCharged: 24,
            billingCategory: "places.details.enterprise",
            result: { id: "ChIJtest" },
          });
        },
      ),
    );

    await zeroMapsCommand.parseAsync([
      "node",
      "cli",
      "places",
      "details",
      "--place-id",
      "ChIJtest",
      "--fields",
      "enterprise",
      "--json",
    ]);

    expect(requestBody).toEqual({
      placeId: "ChIJtest",
      fields: "enterprise",
    });
  });

  it("writes OSM download GeoJSON output", async () => {
    const outputPath = path.join(TEST_HOME, "map.geojson");
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/maps/osm/download",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            operation: "osm.download",
            provider: "openstreetmap",
            creditsCharged: 1,
            billingCategory: "osm.download",
            billingQuantity: 1,
            result: {
              bbox: {
                west: -122.43,
                south: 37.76,
                east: -122.4,
                north: 37.79,
              },
              layers: ["roads", "buildings"],
              attribution: "© OpenStreetMap contributors",
              featureCount: 1,
              geojson: {
                type: "FeatureCollection",
                features: [
                  {
                    type: "Feature",
                    properties: { layer: "roads" },
                    geometry: {
                      type: "LineString",
                      coordinates: [
                        [-122.43, 37.76],
                        [-122.4, 37.79],
                      ],
                    },
                  },
                ],
              },
            },
          });
        },
      ),
    );

    await zeroMapsCommand.parseAsync([
      "node",
      "cli",
      "osm",
      "download",
      "--bbox",
      "-122.43,37.76,-122.40,37.79",
      "--layers",
      "roads,buildings",
      "--output",
      outputPath,
    ]);

    expect(requestBody).toEqual({
      bbox: { west: -122.43, south: 37.76, east: -122.4, north: 37.79 },
      layers: ["roads", "buildings"],
    });
    const written = JSON.parse(
      await fs.readFile(outputPath, "utf8"),
    ) as unknown;
    expect(written).toMatchObject({
      type: "FeatureCollection",
      features: [{ properties: { layer: "roads" } }],
    });
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("✓ OSM download completed");
    expect(output).toContain(`Output: ${outputPath}`);
  });

  it("writes OSM render PNG output", async () => {
    const outputPath = path.join(TEST_HOME, "map.png");
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/maps/osm/render",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            operation: "osm.render",
            provider: "openstreetmap",
            creditsCharged: 2,
            billingCategory: "osm.render.png",
            billingQuantity: 1,
            result: {
              bbox: {
                west: -122.4308,
                south: 37.7641,
                east: -122.408,
                north: 37.7857,
              },
              layers: ["roads", "buildings", "water", "parks"],
              width: 640,
              height: 480,
              style: "guide",
              attribution: "© OpenStreetMap contributors",
              featureCount: 4,
              image: {
                mimeType: "image/png",
                base64: pngBytes.toString("base64"),
              },
            },
          });
        },
      ),
    );

    await zeroMapsCommand.parseAsync([
      "node",
      "cli",
      "osm",
      "render",
      "--center",
      "37.7749,-122.4194",
      "--radius",
      "1200",
      "--width",
      "640",
      "--height",
      "480",
      "--style",
      "guide",
      "--title",
      "Mission walk",
      "--marker",
      "37.7749,-122.4194,Ferry Building",
      "--output",
      outputPath,
    ]);

    expect(requestBody).toEqual({
      center: { lat: 37.7749, lng: -122.4194 },
      radiusMeters: 1200,
      layers: ["roads", "buildings", "water", "parks"],
      width: 640,
      height: 480,
      style: "guide",
      title: "Mission walk",
      markers: [{ lat: 37.7749, lng: -122.4194, label: "Ferry Building" }],
    });
    await expect(fs.readFile(outputPath)).resolves.toEqual(pngBytes);
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("✓ OSM render completed");
    expect(output).toContain(`Output: ${outputPath}`);
  });

  it("documents Enterprise fieldsets in places help output", () => {
    const placesCommand = zeroMapsCommand.commands.find((command) => {
      return command.name() === "places";
    });
    if (!placesCommand) {
      throw new Error("places command not found");
    }
    const searchCommand = placesCommand.commands.find((command) => {
      return command.name() === "search";
    });
    const detailsCommand = placesCommand.commands.find((command) => {
      return command.name() === "details";
    });
    if (!searchCommand || !detailsCommand) {
      throw new Error("places fieldset commands not found");
    }

    expect(searchCommand.helpInformation()).toContain(
      "Field set: pro or enterprise",
    );
    expect(detailsCommand.helpInformation()).toContain(
      "Field set: essentials, pro, or enterprise",
    );
  });

  it("renders credit metadata in human output", async () => {
    server.use(
      http.post("http://localhost:3000/api/zero/maps/geocode", () => {
        return HttpResponse.json({
          operation: "geocode",
          provider: "google-maps",
          creditsCharged: 6,
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
    expect(output).toContain("Credits charged: 6");
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
