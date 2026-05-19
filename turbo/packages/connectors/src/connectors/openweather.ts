import type { ConnectorConfig } from "../connectors";

export const openweather = {
  openweather: {
    label: "OpenWeather",
    category: "data-automation-infrastructure",
    environmentMapping: {
      OPENWEATHER_TOKEN: "$secrets.OPENWEATHER_TOKEN",
    },
    helpText:
      "Connect OpenWeather to access current weather, forecasts, and climate data via the One Call API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to [OpenWeather](https://home.openweathermap.org)\n2. Go to **My API keys**\n3. Copy your default key or click **Generate** to create a new one\n4. Pass it as the `appid` query parameter on every request",
        secrets: {
          OPENWEATHER_TOKEN: {
            label: "API Key",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
