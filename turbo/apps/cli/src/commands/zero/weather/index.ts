import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";

import { callZeroWeather, type ZeroWeatherResponse } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

const WEATHER_UNITS = ["metric", "imperial"] as const;

type WeatherUnits = (typeof WEATHER_UNITS)[number];

interface JsonOption {
  readonly json?: boolean;
}

interface LocationOptions extends JsonOption {
  readonly lat: number;
  readonly lng: number;
  readonly units: WeatherUnits;
  readonly language?: string;
}

interface PagedOptions extends LocationOptions {
  readonly pageSize?: number;
  readonly pageToken?: string;
}

interface HourlyForecastOptions extends PagedOptions {
  readonly hours?: number;
}

interface DailyForecastOptions extends PagedOptions {
  readonly days?: number;
}

interface HourlyHistoryOptions extends PagedOptions {
  readonly hours?: number;
}

function parseLatitude(value: string): number {
  const latitude = Number(value);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new InvalidArgumentError("latitude must be a number from -90 to 90");
  }
  return latitude;
}

function parseLongitude(value: string): number {
  const longitude = Number(value);
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new InvalidArgumentError(
      "longitude must be a number from -180 to 180",
    );
  }
  return longitude;
}

function parseIntegerInRange(value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new InvalidArgumentError(
      `value must be an integer from ${min} to ${max}`,
    );
  }
  return parsed;
}

function parseWeatherUnits(value: string): WeatherUnits {
  if (WEATHER_UNITS.includes(value as WeatherUnits)) {
    return value as WeatherUnits;
  }
  throw new InvalidArgumentError(
    `units must be one of: ${WEATHER_UNITS.join(", ")}`,
  );
}

function locationPayload(options: LocationOptions): Record<string, unknown> {
  return {
    lat: options.lat,
    lng: options.lng,
    units: options.units,
    languageCode: options.language,
  };
}

function pagedPayload(options: PagedOptions): Record<string, unknown> {
  return {
    ...locationPayload(options),
    pageSize: options.pageSize,
    pageToken: options.pageToken,
  };
}

function renderWeatherMetadata(response: ZeroWeatherResponse): void {
  if (response.provider) {
    console.log(chalk.dim(`  Provider: ${response.provider}`));
  }
  if (response.billingCategory) {
    console.log(chalk.dim(`  Billing category: ${response.billingCategory}`));
  }
  if (response.billingQuantity !== undefined) {
    console.log(chalk.dim(`  Billing quantity: ${response.billingQuantity}`));
  }
  if (response.creditsCharged !== undefined) {
    console.log(chalk.dim(`  Credits charged: ${response.creditsCharged}`));
  }
}

function renderWeatherResponse(
  label: string,
  response: ZeroWeatherResponse,
): void {
  console.log(chalk.green(`✓ ${label}`));
  renderWeatherMetadata(response);
  console.log(JSON.stringify(response.result ?? response, null, 2));
}

async function runWeatherRequest(
  label: string,
  endpoint: "current" | "forecast/hourly" | "forecast/daily" | "history/hourly",
  payload: Record<string, unknown>,
  options: JsonOption,
): Promise<void> {
  const response = await callZeroWeather(endpoint, payload);
  if (options.json) {
    console.log(JSON.stringify(response));
    return;
  }
  renderWeatherResponse(label, response);
}

function addLocationOptions(command: Command): Command {
  return command
    .requiredOption("--lat <number>", "Latitude", parseLatitude)
    .requiredOption("--lng <number>", "Longitude", parseLongitude)
    .option(
      "--units <system>",
      "Units system: metric or imperial",
      parseWeatherUnits,
      "metric",
    )
    .option("--language <code>", "IETF BCP-47 response language code")
    .option("--json", "Print the raw weather response as JSON");
}

function addHourlyPaginationOptions(command: Command): Command {
  return command
    .option("--page-size <n>", "Records per page, from 1 to 24", (value) => {
      return parseIntegerInRange(value, 1, 24);
    })
    .option("--page-token <token>", "Token for the next page");
}

const currentCommand = addLocationOptions(
  new Command().name("current").description("Get current weather conditions"),
).action(
  withErrorHandler(async (options: LocationOptions) => {
    await runWeatherRequest(
      "Current weather retrieved",
      "current",
      locationPayload(options),
      options,
    );
  }),
);

const hourlyForecastCommand = addHourlyPaginationOptions(
  addLocationOptions(
    new Command()
      .name("hourly")
      .description("Get up to 240 hours of hourly forecasts"),
  ),
)
  .option("--hours <n>", "Total forecast hours, from 1 to 240", (value) => {
    return parseIntegerInRange(value, 1, 240);
  })
  .action(
    withErrorHandler(async (options: HourlyForecastOptions) => {
      await runWeatherRequest(
        "Hourly forecast retrieved",
        "forecast/hourly",
        { ...pagedPayload(options), hours: options.hours },
        options,
      );
    }),
  );

const dailyForecastCommand = addLocationOptions(
  new Command()
    .name("daily")
    .description("Get up to 10 days of daily forecasts"),
)
  .option("--days <n>", "Total forecast days, from 1 to 10", (value) => {
    return parseIntegerInRange(value, 1, 10);
  })
  .option("--page-size <n>", "Records per page, from 1 to 10", (value) => {
    return parseIntegerInRange(value, 1, 10);
  })
  .option("--page-token <token>", "Token for the next page")
  .action(
    withErrorHandler(async (options: DailyForecastOptions) => {
      await runWeatherRequest(
        "Daily forecast retrieved",
        "forecast/daily",
        { ...pagedPayload(options), days: options.days },
        options,
      );
    }),
  );

const hourlyHistoryCommand = addHourlyPaginationOptions(
  addLocationOptions(
    new Command()
      .name("hourly")
      .description("Get up to 24 hours of recent hourly history"),
  ),
)
  .option("--hours <n>", "Total history hours, from 1 to 24", (value) => {
    return parseIntegerInRange(value, 1, 24);
  })
  .action(
    withErrorHandler(async (options: HourlyHistoryOptions) => {
      await runWeatherRequest(
        "Hourly weather history retrieved",
        "history/hourly",
        { ...pagedPayload(options), hours: options.hours },
        options,
      );
    }),
  );

const forecastCommand = new Command()
  .name("forecast")
  .description("Get hourly or daily weather forecasts")
  .addCommand(hourlyForecastCommand)
  .addCommand(dailyForecastCommand);

const historyCommand = new Command()
  .name("history")
  .description("Get recent weather history")
  .addCommand(hourlyHistoryCommand);

export const zeroWeatherCommand = new Command()
  .name("weather")
  .description("Use managed Zero weather services")
  .addCommand(currentCommand)
  .addCommand(forecastCommand)
  .addCommand(historyCommand)
  .addHelpText(
    "after",
    `
Examples:
  Current conditions:  zero weather current --lat 39.9042 --lng 116.4074 --language zh-CN --json
  Hourly forecast:     zero weather forecast hourly --lat 39.9042 --lng 116.4074 --hours 48 --page-size 24 --json
  Daily forecast:      zero weather forecast daily --lat 39.9042 --lng 116.4074 --days 10 --page-size 10 --json
  Hourly history:      zero weather history hourly --lat 39.9042 --lng 116.4074 --hours 24 --json

Notes:
  - Authenticates via ZERO_TOKEN (requires weather:read capability) or a CLI token
  - Each command makes one Google Weather API request; use page tokens for additional pages
  - Calls are recorded for usage analytics and currently charge 0 credits`,
  );
