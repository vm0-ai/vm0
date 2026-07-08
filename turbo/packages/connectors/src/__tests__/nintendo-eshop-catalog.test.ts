import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  NintendoEshopCatalogError,
  fetchNintendoEshopPrices,
  searchNintendoEshopCatalog,
  type NintendoEshopCatalogRegion,
} from "../nintendo-eshop-catalog";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

describe("Nintendo eShop catalog sources", () => {
  it("searches Americas Algolia catalog records", async () => {
    server.use(
      http.post(
        "https://U3B6GR4UA3-dsn.algolia.net/1/indexes/store_all_products_en_us/query",
        ({ request }) => {
          expect(request.headers.get("X-Algolia-Application-Id")).toBe(
            "U3B6GR4UA3",
          );
          expect(request.headers.get("X-Algolia-API-Key")).toBe(
            "a29c6927638bfd8cee23993e51e721c9",
          );
          return HttpResponse.json({
            hits: [
              {
                title: "Mario Kart 8 Deluxe",
                nsuid: "70010000000001",
                slug: "/store/products/mario-kart-8-deluxe-switch/",
                platform: "Nintendo Switch",
                price: {
                  regPrice: "59.99",
                  salePrice: "39.99",
                  currency: "USD",
                },
              },
            ],
          });
        },
      ),
      http.post(
        "https://U3B6GR4UA3-dsn.algolia.net/1/indexes/ncom_game_en_us/query",
        ({ request }) => {
          expect(request.headers.get("X-Algolia-API-Key")).toBe(
            "6efbfb0f8f80defc44895018caf77504",
          );
          return HttpResponse.json({ hits: [] });
        },
      ),
    );

    await expect(
      searchNintendoEshopCatalog({ region: "en_us", query: "mario" }),
    ).resolves.toStrictEqual([
      {
        sourceFamily: "americas-algolia",
        region: "en_us",
        countryCode: "US",
        language: "en",
        title: "Mario Kart 8 Deluxe",
        nsuid: "70010000000001",
        titleId: "70010000000001",
        gameCode: null,
        productUrl: "/store/products/mario-kart-8-deluxe-switch/",
        platform: "Nintendo Switch",
        releaseDate: null,
        listPrice: "59.99",
        salePrice: "39.99",
        currency: "USD",
        saleStart: null,
        saleEnd: null,
        onSale: null,
      },
    ]);
  });

  it("parses Europe Solr records", async () => {
    server.use(
      http.get("https://search.nintendo-europe.com/en/select", () => {
        return HttpResponse.json({
          response: {
            docs: [
              {
                title: "The Legend of Zelda",
                nsuid_txt: ["70010000000002"],
                product_code: "HACPA1234",
                platform_txt: ["Nintendo Switch"],
              },
            ],
          },
        });
      }),
    );

    const results = await searchNintendoEshopCatalog({
      region: "en",
      query: "zelda",
    });

    expect(results[0]).toMatchObject({
      sourceFamily: "europe-solr",
      region: "en",
      language: "en",
      title: "The Legend of Zelda",
      nsuid: "70010000000002",
      platform: "Nintendo Switch",
    });
  });

  it("parses Japan XML records and filters by query", async () => {
    server.use(
      http.get(
        "https://www.nintendo.co.jp/data/software/xml/switch.xml",
        () => {
          return HttpResponse.text(`
          <TitleInfo>
            <TitleName>Animal Crossing</TitleName>
            <InitialCode>HACPA1234</InitialCode>
            <LinkURL>https://store-jp.nintendo.com/list/software/70010000000003.html</LinkURL>
            <SalesDate>2020-03-20</SalesDate>
          </TitleInfo>
          <TitleInfo>
            <TitleName>Splatoon</TitleName>
            <InitialCode>HACPB5678</InitialCode>
          </TitleInfo>
        `);
        },
      ),
    );

    const results = await searchNintendoEshopCatalog({
      region: "jp",
      query: "animal",
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sourceFamily: "japan-xml",
      region: "jp",
      countryCode: "JP",
      language: "ja",
      title: "Animal Crossing",
      gameCode: "HACPA1234",
      productUrl:
        "https://store-jp.nintendo.com/list/software/70010000000003.html",
    });
  });

  it("parses Hong Kong JSON records", async () => {
    server.use(
      http.get(
        "https://www.nintendo.com/hk/data/json/switch_software.json",
        () => {
          return HttpResponse.json({
            soft: [
              {
                title: "Kirby",
                nsuid: "70010000000004",
                price: "429",
                currency: "HKD",
              },
            ],
          });
        },
      ),
    );

    const results = await searchNintendoEshopCatalog({ region: "hk" });
    expect(results[0]).toMatchObject({
      sourceFamily: "hong-kong-json",
      countryCode: "HK",
      title: "Kirby",
      listPrice: "429",
      currency: "HKD",
    });
  });

  it("parses Taiwan and Korea API records", async () => {
    server.use(
      http.get("https://www.nintendo.com/tw/api/search", () => {
        return HttpResponse.json({
          data: [
            {
              title: "Pokemon",
              title_id: "70010000000005",
              release_date: "2026-01-01",
            },
          ],
        });
      }),
      http.get("https://www.nintendo.com/kr/api/software", () => {
        return HttpResponse.json({
          result: [
            {
              titleName: "Metroid",
              nsuid: "70010000000006",
            },
          ],
        });
      }),
    );

    await expect(
      searchNintendoEshopCatalog({ region: "tw", query: "pokemon" }),
    ).resolves.toMatchObject([
      {
        sourceFamily: "taiwan-api",
        countryCode: "TW",
        title: "Pokemon",
      },
    ]);
    await expect(
      searchNintendoEshopCatalog({ region: "kr" }),
    ).resolves.toMatchObject([
      {
        sourceFamily: "korea-api",
        countryCode: "KR",
        title: "Metroid",
      },
    ]);
  });

  it("parses Southeast Asia search records with embedded prices", async () => {
    server.use(
      http.get(
        "https://search.nintendo.jp/nintendo_soft_sg/search.json",
        () => {
          return HttpResponse.json({
            result: [
              {
                title: "Pikmin",
                nsuid: "70010000000007",
                price: "79.90",
                current_price: "59.90",
                currency: "SGD",
                sale_flg: 1,
              },
            ],
          });
        },
      ),
    );

    const results = await searchNintendoEshopCatalog({ region: "sg" });
    expect(results[0]).toMatchObject({
      sourceFamily: "southeast-asia-search",
      countryCode: "SG",
      title: "Pikmin",
      listPrice: "79.90",
      salePrice: "59.90",
      currency: "SGD",
      onSale: true,
    });
  });

  it("parses Australia and New Zealand Algolia records", async () => {
    server.use(
      http.post(
        "https://FMW57F6ERV-dsn.algolia.net/1/indexes/prod_games/query",
        ({ request }) => {
          expect(request.headers.get("X-Algolia-API-Key")).toBe(
            "c8e4e9f60190ef785d167da77ba0b4fe",
          );
          return HttpResponse.json({
            hits: [
              {
                title: "Luigi's Mansion",
                titleId: "70010000000008",
                productUrl: "/au/games/luigis-mansion/",
              },
            ],
          });
        },
      ),
    );

    const results = await searchNintendoEshopCatalog({ region: "au" });
    expect(results[0]).toMatchObject({
      sourceFamily: "australia-new-zealand-algolia",
      countryCode: "AU",
      title: "Luigi's Mansion",
      titleId: "70010000000008",
    });
  });

  it("returns an empty list for empty catalog results", async () => {
    server.use(
      http.get("https://search.nintendo-europe.com/de/select", () => {
        return HttpResponse.json({ response: { docs: [] } });
      }),
    );

    await expect(
      searchNintendoEshopCatalog({ region: "de", query: "missing" }),
    ).resolves.toStrictEqual([]);
  });

  it("fetches country-specific price records", async () => {
    server.use(
      http.get("https://api.ec.nintendo.com/v1/price", ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("country")).toBe("US");
        expect(url.searchParams.get("ids")).toBe("70010000000009");
        return HttpResponse.json({
          prices: [
            {
              title_id: "70010000000009",
              regular_price: { raw_value: "59.99", currency: "USD" },
              discount_price: {
                raw_value: "39.99",
                currency: "USD",
                start_datetime: "2026-01-01T00:00:00Z",
                end_datetime: "2026-01-08T00:00:00Z",
              },
            },
          ],
        });
      }),
    );

    await expect(
      fetchNintendoEshopPrices({
        country: "US",
        titleIds: ["70010000000009"],
      }),
    ).resolves.toStrictEqual([
      {
        country: "US",
        titleId: "70010000000009",
        listPrice: "59.99",
        salePrice: "39.99",
        currency: "USD",
        saleStart: "2026-01-01T00:00:00Z",
        saleEnd: "2026-01-08T00:00:00Z",
        onSale: true,
      },
    ]);
  });

  it("rejects unsupported catalog regions locally", async () => {
    await expect(
      searchNintendoEshopCatalog({
        region: "cn" as NintendoEshopCatalogRegion,
      }),
    ).rejects.toBeInstanceOf(NintendoEshopCatalogError);
  });
});
