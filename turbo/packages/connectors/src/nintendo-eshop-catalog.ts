import { z } from "zod";

const AMERICAS_ALGOLIA_APP_ID = "U3B6GR4UA3";
const AMERICAS_ALGOLIA_SEARCH_KEY = "c4da8be7fd29f0f5bfa42920b0a99dc7";
const AMERICAS_ALGOLIA_STORE_SEARCH_KEY = "a29c6927638bfd8cee23993e51e721c9";
const AMERICAS_ALGOLIA_NCOM_SEARCH_KEY = "6efbfb0f8f80defc44895018caf77504";
const AU_NZ_ALGOLIA_APP_ID = "FMW57F6ERV";
const AU_NZ_ALGOLIA_SEARCH_KEY = "c8e4e9f60190ef785d167da77ba0b4fe";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const NINTENDO_ESHOP_AMERICAS_STORE_LOCALES = [
  "en_us",
  "en_ca",
  "fr_ca",
  "es_mx",
  "pt_br",
  "es_ar",
  "es_cl",
  "es_co",
  "es_pe",
] as const;

export const NINTENDO_ESHOP_AMERICAS_NCOM_LOCALES = [
  "en_us",
  "en_ca",
  "fr_ca",
  "es_mx",
  "pt_br",
] as const;

export const NINTENDO_ESHOP_EUROPE_LANGUAGES = [
  "en",
  "de",
  "fr",
  "es",
  "it",
  "nl",
  "pt",
] as const;

export const NINTENDO_ESHOP_SEA_REGIONS = ["sg", "th", "my", "ph"] as const;

export const NINTENDO_ESHOP_PRICE_COUNTRIES = [
  "US",
  "CA",
  "MX",
  "BR",
  "AR",
  "CL",
  "CO",
  "PE",
  "JP",
  "KR",
  "TW",
  "HK",
  "AU",
  "NZ",
  "GB",
  "ZA",
  "DE",
  "FR",
  "ES",
  "IT",
  "NL",
  "PT",
  "BE",
  "CH",
  "AT",
  "DK",
  "NO",
  "SE",
  "FI",
  "PL",
  "CZ",
  "GR",
  "HU",
  "SK",
  "IE",
  "MT",
  "LU",
] as const;

export const NINTENDO_ESHOP_CATALOG_REGIONS = [
  ...NINTENDO_ESHOP_AMERICAS_STORE_LOCALES,
  ...NINTENDO_ESHOP_EUROPE_LANGUAGES,
  "jp",
  "hk",
  "tw",
  "kr",
  ...NINTENDO_ESHOP_SEA_REGIONS,
  "au",
  "nz",
] as const;

export type NintendoEshopAmericasStoreLocale =
  (typeof NINTENDO_ESHOP_AMERICAS_STORE_LOCALES)[number];
type NintendoEshopAmericasNcomLocale =
  (typeof NINTENDO_ESHOP_AMERICAS_NCOM_LOCALES)[number];
export type NintendoEshopEuropeLanguage =
  (typeof NINTENDO_ESHOP_EUROPE_LANGUAGES)[number];
export type NintendoEshopSeaRegion =
  (typeof NINTENDO_ESHOP_SEA_REGIONS)[number];
export type NintendoEshopPriceCountry =
  (typeof NINTENDO_ESHOP_PRICE_COUNTRIES)[number];
export type NintendoEshopCatalogRegion =
  (typeof NINTENDO_ESHOP_CATALOG_REGIONS)[number];

export type NintendoEshopSourceFamily =
  | "americas-algolia"
  | "europe-solr"
  | "japan-xml"
  | "hong-kong-json"
  | "taiwan-api"
  | "korea-api"
  | "southeast-asia-search"
  | "australia-new-zealand-algolia";

export interface NintendoEshopCatalogItem {
  readonly sourceFamily: NintendoEshopSourceFamily;
  readonly region: NintendoEshopCatalogRegion;
  readonly countryCode: string | null;
  readonly language: string | null;
  readonly title: string;
  readonly nsuid: string | null;
  readonly titleId: string | null;
  readonly gameCode: string | null;
  readonly productUrl: string | null;
  readonly platform: string | null;
  readonly releaseDate: string | null;
  readonly listPrice: string | null;
  readonly salePrice: string | null;
  readonly currency: string | null;
  readonly saleStart: string | null;
  readonly saleEnd: string | null;
  readonly onSale: boolean | null;
}

export interface NintendoEshopPriceItem {
  readonly country: NintendoEshopPriceCountry;
  readonly titleId: string;
  readonly listPrice: string | null;
  readonly salePrice: string | null;
  readonly currency: string | null;
  readonly saleStart: string | null;
  readonly saleEnd: string | null;
  readonly onSale: boolean | null;
}

export class NintendoEshopCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NintendoEshopCatalogError";
  }
}

export interface SearchNintendoEshopCatalogArgs {
  readonly region: NintendoEshopCatalogRegion;
  readonly query?: string;
  readonly limit?: number;
  readonly page?: number;
  readonly signal?: AbortSignal;
}

export interface FetchNintendoEshopPricesArgs {
  readonly country: NintendoEshopPriceCountry;
  readonly titleIds: readonly string[];
  readonly lang?: string;
  readonly signal?: AbortSignal;
}

const algoliaSearchResponseSchema = z.object({
  hits: z.array(z.record(z.string(), z.unknown())),
});

const algoliaMultiSearchResponseSchema = z.object({
  results: z.array(algoliaSearchResponseSchema),
});

const nintendoPriceResponseSchema = z.object({
  prices: z.array(z.record(z.string(), z.unknown())).optional(),
});

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap<Record<string, unknown>>((item) => {
        const parsed = record(item);
        return parsed ? [parsed] : [];
      })
    : [];
}

function stringValue(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function booleanValue(
  source: Record<string, unknown>,
  keys: readonly string[],
): boolean | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value !== 0;
    }
  }
  return null;
}

function nestedRecord(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  return record(source[key]);
}

function nestedStringValue(
  source: Record<string, unknown>,
  key: string,
  keys: readonly string[],
): string | null {
  const nested = nestedRecord(source, key);
  return nested ? stringValue(nested, keys) : null;
}

function firstStringArrayValue(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      const first = value.find((item) => {
        return typeof item === "string" && item.trim();
      });
      if (typeof first === "string") {
        return first.trim();
      }
    }
  }
  return null;
}

function priceValue(source: Record<string, unknown>): {
  readonly listPrice: string | null;
  readonly salePrice: string | null;
  readonly currency: string | null;
} {
  const price = nestedRecord(source, "price");
  return {
    listPrice:
      stringValue(source, ["msrp", "regular_price", "price", "list_price"]) ??
      (price
        ? stringValue(price, ["regPrice", "regularPrice", "amount"])
        : null),
    salePrice:
      stringValue(source, ["salePrice", "sale_price", "current_price"]) ??
      (price ? stringValue(price, ["salePrice", "finalPrice"]) : null),
    currency:
      stringValue(source, ["currency", "currency_code"]) ??
      (price ? stringValue(price, ["currency"]) : null),
  };
}

function normalizeCatalogRecord(args: {
  readonly sourceFamily: NintendoEshopSourceFamily;
  readonly region: NintendoEshopCatalogRegion;
  readonly countryCode: string | null;
  readonly language: string | null;
  readonly record: Record<string, unknown>;
}): NintendoEshopCatalogItem | null {
  const title =
    stringValue(args.record, [
      "title",
      "name",
      "titleName",
      "TitleName",
      "formal_name",
      "title_name",
      "productName",
    ]) ?? firstStringArrayValue(args.record, ["title_txt", "title"]);
  if (!title) {
    return null;
  }

  const price = priceValue(args.record);
  const nsuid =
    stringValue(args.record, ["nsuid", "nsuid_txt", "nsuidTxt"]) ??
    firstStringArrayValue(args.record, ["nsuid_txt"]);
  const titleId =
    stringValue(args.record, ["titleId", "title_id", "id", "objectID"]) ??
    nsuid;
  return {
    sourceFamily: args.sourceFamily,
    region: args.region,
    countryCode: args.countryCode,
    language: args.language,
    title,
    nsuid,
    titleId,
    gameCode: stringValue(args.record, [
      "gameCode",
      "game_code",
      "InitialCode",
      "product_code",
      "productCode",
    ]),
    productUrl: stringValue(args.record, [
      "url",
      "productUrl",
      "product_url",
      "LinkURL",
      "link_url",
      "slug",
    ]),
    platform:
      stringValue(args.record, ["platform", "system", "hardware"]) ??
      firstStringArrayValue(args.record, ["platform_txt"]),
    releaseDate: stringValue(args.record, [
      "releaseDate",
      "release_date",
      "releaseDateDisplay",
      "release_date_on_eshop",
      "salesDate",
    ]),
    listPrice: price.listPrice,
    salePrice: price.salePrice,
    currency: price.currency,
    saleStart: stringValue(args.record, [
      "saleStart",
      "sale_start",
      "discount_start_date",
      "sdate",
    ]),
    saleEnd: stringValue(args.record, [
      "saleEnd",
      "sale_end",
      "discount_end_date",
      "edate",
    ]),
    onSale: booleanValue(args.record, ["onSale", "sale_flg", "saleFlag"]),
  };
}

function normalizeRecords(args: {
  readonly sourceFamily: NintendoEshopSourceFamily;
  readonly region: NintendoEshopCatalogRegion;
  readonly countryCode: string | null;
  readonly language: string | null;
  readonly records: readonly Record<string, unknown>[];
}): NintendoEshopCatalogItem[] {
  return args.records.flatMap((item) => {
    const normalized = normalizeCatalogRecord({ ...args, record: item });
    return normalized ? [normalized] : [];
  });
}

async function fetchJson(url: URL, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new NintendoEshopCatalogError(
      `Nintendo eShop request failed with HTTP ${response.status}`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new NintendoEshopCatalogError(
      "Nintendo eShop response is not valid JSON",
    );
  }
}

async function fetchText(url: URL, init: RequestInit): Promise<string> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new NintendoEshopCatalogError(
      `Nintendo eShop request failed with HTTP ${response.status}`,
    );
  }
  return await response.text();
}

function algoliaHeaders(appId: string, apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Algolia-API-Key": apiKey,
    "X-Algolia-Application-Id": appId,
  };
}

function isNintendoEshopAmericasNcomLocale(
  region: NintendoEshopAmericasStoreLocale,
): region is NintendoEshopAmericasNcomLocale {
  return (
    NINTENDO_ESHOP_AMERICAS_NCOM_LOCALES as readonly NintendoEshopAmericasStoreLocale[]
  ).includes(region);
}

async function searchAlgoliaIndex(args: {
  readonly appId: string;
  readonly apiKey: string;
  readonly indexName: string;
  readonly params: URLSearchParams;
  readonly signal?: AbortSignal;
}): Promise<Record<string, unknown>[]> {
  const url = new URL(
    `https://${args.appId}-dsn.algolia.net/1/indexes/${args.indexName}/query`,
  );
  const parsed = algoliaSearchResponseSchema.safeParse(
    await fetchJson(url, {
      method: "POST",
      headers: algoliaHeaders(args.appId, args.apiKey),
      body: JSON.stringify({ params: args.params.toString() }),
      signal: args.signal,
    }),
  );
  if (!parsed.success) {
    throw new NintendoEshopCatalogError(
      "Nintendo eShop Algolia response shape is invalid",
    );
  }
  return parsed.data.hits;
}

async function searchAmericasAlgolia(
  args: SearchNintendoEshopCatalogArgs,
): Promise<NintendoEshopCatalogItem[]> {
  const limit = clampLimit(args.limit);
  const page = args.page ?? 0;
  const region = args.region as NintendoEshopAmericasStoreLocale;
  const storeIndex = `store_all_products_${region}`;
  const params = new URLSearchParams({
    hitsPerPage: String(limit),
    page: String(page),
    query: args.query ?? "",
  });

  if (args.query) {
    const hits = await searchAlgoliaIndex({
      appId: AMERICAS_ALGOLIA_APP_ID,
      apiKey: AMERICAS_ALGOLIA_STORE_SEARCH_KEY,
      indexName: storeIndex,
      params,
      signal: args.signal,
    });
    if (isNintendoEshopAmericasNcomLocale(region)) {
      hits.push(
        ...(await searchAlgoliaIndex({
          appId: AMERICAS_ALGOLIA_APP_ID,
          apiKey: AMERICAS_ALGOLIA_NCOM_SEARCH_KEY,
          indexName: `ncom_game_${region}`,
          params,
          signal: args.signal,
        })),
      );
    }
    return normalizeRecords({
      sourceFamily: "americas-algolia",
      region: args.region,
      countryCode: args.region.slice(-2).toUpperCase(),
      language: args.region.slice(0, 2),
      records: hits,
    });
  }

  const requests = [
    {
      indexName: storeIndex,
      params: params.toString(),
    },
  ];

  if (isNintendoEshopAmericasNcomLocale(region)) {
    requests.push({
      indexName: `ncom_game_${region}`,
      params: params.toString(),
    });
  }

  const url = new URL(
    `https://${AMERICAS_ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/*/queries`,
  );
  const parsed = algoliaMultiSearchResponseSchema.safeParse(
    await fetchJson(url, {
      method: "POST",
      headers: algoliaHeaders(
        AMERICAS_ALGOLIA_APP_ID,
        AMERICAS_ALGOLIA_SEARCH_KEY,
      ),
      body: JSON.stringify({ requests }),
      signal: args.signal,
    }),
  );
  if (!parsed.success) {
    throw new NintendoEshopCatalogError(
      "Nintendo eShop Algolia response shape is invalid",
    );
  }

  const hits = parsed.data.results.flatMap((result) => {
    return result.hits;
  });
  return normalizeRecords({
    sourceFamily: "americas-algolia",
    region: args.region,
    countryCode: args.region.slice(-2).toUpperCase(),
    language: args.region.slice(0, 2),
    records: hits,
  });
}

async function searchEuropeSolr(
  args: SearchNintendoEshopCatalogArgs,
): Promise<NintendoEshopCatalogItem[]> {
  const url = new URL(
    `https://search.nintendo-europe.com/${args.region}/select`,
  );
  url.searchParams.set("q", args.query ? `*${args.query}*` : "*");
  url.searchParams.set("rows", String(clampLimit(args.limit)));
  url.searchParams.set(
    "start",
    String((args.page ?? 0) * clampLimit(args.limit)),
  );
  url.searchParams.set("wt", "json");
  const body = await fetchJson(url, { signal: args.signal });
  const root = record(body);
  const response = root ? record(root.response) : null;
  const docs = response ? records(response.docs) : [];
  return normalizeRecords({
    sourceFamily: "europe-solr",
    region: args.region,
    countryCode: null,
    language: args.region,
    records: docs,
  });
}

function xmlTagValue(source: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]+)</${tag}>`, "u").exec(source);
  return match?.[1]?.trim() ?? null;
}

async function searchJapanXml(
  args: SearchNintendoEshopCatalogArgs,
): Promise<NintendoEshopCatalogItem[]> {
  const url = new URL(
    "https://www.nintendo.co.jp/data/software/xml/switch.xml",
  );
  const text = await fetchText(url, { signal: args.signal });
  const records = [...text.matchAll(/<TitleInfo>([\s\S]*?)<\/TitleInfo>/gu)]
    .map((match) => {
      const item = match[1] ?? "";
      return {
        TitleName: xmlTagValue(item, "TitleName"),
        InitialCode: xmlTagValue(item, "InitialCode"),
        LinkURL: xmlTagValue(item, "LinkURL"),
        salesDate: xmlTagValue(item, "SalesDate"),
      };
    })
    .filter((item) => {
      return (
        !args.query ||
        item.TitleName?.toLowerCase().includes(args.query.toLowerCase())
      );
    })
    .slice(
      (args.page ?? 0) * clampLimit(args.limit),
      ((args.page ?? 0) + 1) * clampLimit(args.limit),
    );
  return normalizeRecords({
    sourceFamily: "japan-xml",
    region: "jp",
    countryCode: "JP",
    language: "ja",
    records,
  });
}

async function searchHongKongJson(
  args: SearchNintendoEshopCatalogArgs,
): Promise<NintendoEshopCatalogItem[]> {
  const url = new URL(
    "https://www.nintendo.com/hk/data/json/switch_software.json",
  );
  const body = await fetchJson(url, { signal: args.signal });
  const root = record(body);
  const sourceRecords = records(root?.soft ?? root?.software ?? body);
  const query = args.query?.toLowerCase();
  return normalizeRecords({
    sourceFamily: "hong-kong-json",
    region: "hk",
    countryCode: "HK",
    language: "zh",
    records: sourceRecords
      .filter((item) => {
        return (
          !query ||
          stringValue(item, ["title", "name"])?.toLowerCase().includes(query)
        );
      })
      .slice(
        (args.page ?? 0) * clampLimit(args.limit),
        ((args.page ?? 0) + 1) * clampLimit(args.limit),
      ),
  });
}

async function searchTaiwanOrKoreaApi(
  args: SearchNintendoEshopCatalogArgs,
): Promise<NintendoEshopCatalogItem[]> {
  const region = args.region === "tw" ? "tw" : "kr";
  const endpoint = args.query ? "search" : "software";
  const url = new URL(`https://www.nintendo.com/${region}/api/${endpoint}`);
  if (args.query) {
    url.searchParams.set("q", args.query);
  }
  url.searchParams.set("limit", String(clampLimit(args.limit)));
  url.searchParams.set(
    "offset",
    String((args.page ?? 0) * clampLimit(args.limit)),
  );
  const body = await fetchJson(url, { signal: args.signal });
  const root = record(body);
  const sourceRecords = records(
    root?.data ?? root?.result ?? root?.software ?? body,
  );
  return normalizeRecords({
    sourceFamily: region === "tw" ? "taiwan-api" : "korea-api",
    region,
    countryCode: region.toUpperCase(),
    language: region === "tw" ? "zh" : "ko",
    records: sourceRecords,
  });
}

async function searchSoutheastAsia(
  args: SearchNintendoEshopCatalogArgs,
): Promise<NintendoEshopCatalogItem[]> {
  const url = new URL(
    `https://search.nintendo.jp/nintendo_soft_${args.region}/search.json`,
  );
  if (args.query) {
    url.searchParams.set("q", args.query);
  }
  url.searchParams.set("limit", String(clampLimit(args.limit)));
  url.searchParams.set(
    "offset",
    String((args.page ?? 0) * clampLimit(args.limit)),
  );
  const body = await fetchJson(url, { signal: args.signal });
  const root = record(body);
  const sourceRecords = records(
    root?.result ?? root?.items ?? root?.soft ?? body,
  );
  return normalizeRecords({
    sourceFamily: "southeast-asia-search",
    region: args.region,
    countryCode: args.region.toUpperCase(),
    language: "en",
    records: sourceRecords,
  });
}

async function searchAustraliaNewZealandAlgolia(
  args: SearchNintendoEshopCatalogArgs,
): Promise<NintendoEshopCatalogItem[]> {
  const url = new URL(
    `https://${AU_NZ_ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/prod_games/query`,
  );
  const parsed = algoliaSearchResponseSchema.safeParse(
    await fetchJson(url, {
      method: "POST",
      headers: algoliaHeaders(AU_NZ_ALGOLIA_APP_ID, AU_NZ_ALGOLIA_SEARCH_KEY),
      body: JSON.stringify({
        hitsPerPage: clampLimit(args.limit),
        page: args.page ?? 0,
        query: args.query ?? "",
      }),
      signal: args.signal,
    }),
  );
  if (!parsed.success) {
    throw new NintendoEshopCatalogError(
      "Nintendo Australia Algolia response shape is invalid",
    );
  }
  return normalizeRecords({
    sourceFamily: "australia-new-zealand-algolia",
    region: args.region,
    countryCode: args.region.toUpperCase(),
    language: "en",
    records: parsed.data.hits,
  });
}

export async function searchNintendoEshopCatalog(
  args: SearchNintendoEshopCatalogArgs,
): Promise<NintendoEshopCatalogItem[]> {
  if (
    NINTENDO_ESHOP_AMERICAS_STORE_LOCALES.includes(
      args.region as NintendoEshopAmericasStoreLocale,
    )
  ) {
    return await searchAmericasAlgolia(args);
  }
  if (
    NINTENDO_ESHOP_EUROPE_LANGUAGES.includes(
      args.region as NintendoEshopEuropeLanguage,
    )
  ) {
    return await searchEuropeSolr(args);
  }
  if (args.region === "jp") {
    return await searchJapanXml(args);
  }
  if (args.region === "hk") {
    return await searchHongKongJson(args);
  }
  if (args.region === "tw" || args.region === "kr") {
    return await searchTaiwanOrKoreaApi(args);
  }
  if (
    NINTENDO_ESHOP_SEA_REGIONS.includes(args.region as NintendoEshopSeaRegion)
  ) {
    return await searchSoutheastAsia(args);
  }
  if (args.region === "au" || args.region === "nz") {
    return await searchAustraliaNewZealandAlgolia(args);
  }
  throw new NintendoEshopCatalogError(
    `Unsupported Nintendo eShop catalog region: ${args.region}`,
  );
}

function normalizePriceRecord(
  country: NintendoEshopPriceCountry,
  item: Record<string, unknown>,
): NintendoEshopPriceItem | null {
  const titleId = stringValue(item, ["title_id", "titleId", "id", "nsuid"]);
  if (!titleId) {
    return null;
  }
  const regular = nestedRecord(item, "regular_price");
  const discount = nestedRecord(item, "discount_price");
  const saleStart =
    nestedStringValue(item, "discount_price", ["start_datetime"]) ??
    stringValue(item, ["discount_start_datetime"]);
  const saleEnd =
    nestedStringValue(item, "discount_price", ["end_datetime"]) ??
    stringValue(item, ["discount_end_datetime"]);
  const listPrice =
    (regular ? stringValue(regular, ["raw_value", "amount"]) : null) ??
    stringValue(item, ["regular_price", "price"]);
  const salePrice = discount
    ? stringValue(discount, ["raw_value", "amount"])
    : null;
  return {
    country,
    titleId,
    listPrice,
    salePrice,
    currency:
      (regular ? stringValue(regular, ["currency"]) : null) ??
      (discount ? stringValue(discount, ["currency"]) : null) ??
      stringValue(item, ["currency"]),
    saleStart,
    saleEnd,
    onSale: salePrice !== null,
  };
}

export async function fetchNintendoEshopPrices(
  args: FetchNintendoEshopPricesArgs,
): Promise<NintendoEshopPriceItem[]> {
  if (args.titleIds.length === 0) {
    return [];
  }
  const url = new URL("https://api.ec.nintendo.com/v1/price");
  url.searchParams.set("country", args.country);
  url.searchParams.set("ids", args.titleIds.join(","));
  url.searchParams.set("lang", args.lang ?? "en");
  const parsed = nintendoPriceResponseSchema.safeParse(
    await fetchJson(url, { signal: args.signal }),
  );
  if (!parsed.success) {
    throw new NintendoEshopCatalogError(
      "Nintendo eShop price response shape is invalid",
    );
  }
  return (parsed.data.prices ?? []).flatMap((item) => {
    const normalized = normalizePriceRecord(args.country, item);
    return normalized ? [normalized] : [];
  });
}
