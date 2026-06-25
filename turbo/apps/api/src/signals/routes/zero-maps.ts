import { zeroMapsContract } from "@vm0/api-contracts/contracts/zero-maps";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import {
  zeroMapsDirections$,
  zeroMapsGeocode$,
  zeroMapsPlacesDetails$,
  zeroMapsPlacesSearch$,
  zeroMapsReverseGeocode$,
} from "../services/zero-maps.service";
import {
  zeroMapsOsmDownload$,
  zeroMapsOsmRender$,
} from "../services/zero-maps-osm.service";

const geocodeBody$ = bodyResultOf(zeroMapsContract.geocode);
const reverseGeocodeBody$ = bodyResultOf(zeroMapsContract.reverseGeocode);
const directionsBody$ = bodyResultOf(zeroMapsContract.directions);
const placesSearchBody$ = bodyResultOf(zeroMapsContract.placesSearch);
const placesDetailsBody$ = bodyResultOf(zeroMapsContract.placesDetails);
const osmDownloadBody$ = bodyResultOf(zeroMapsContract.osmDownload);
const osmRenderBody$ = bodyResultOf(zeroMapsContract.osmRender);

const geocodeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(geocodeBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(zeroMapsGeocode$, { auth, body: bodyResult.data }, signal);
});

const reverseGeocodeInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(reverseGeocodeBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      zeroMapsReverseGeocode$,
      { auth, body: bodyResult.data },
      signal,
    );
  },
);

const directionsInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(directionsBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(
    zeroMapsDirections$,
    { auth, body: bodyResult.data },
    signal,
  );
});

const placesSearchInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(placesSearchBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      zeroMapsPlacesSearch$,
      { auth, body: bodyResult.data },
      signal,
    );
  },
);

const placesDetailsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(placesDetailsBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      zeroMapsPlacesDetails$,
      { auth, body: bodyResult.data },
      signal,
    );
  },
);

const osmDownloadInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(osmDownloadBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(
    zeroMapsOsmDownload$,
    { auth, body: bodyResult.data },
    signal,
  );
});

const osmRenderInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(osmRenderBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(zeroMapsOsmRender$, { auth, body: bodyResult.data }, signal);
});

const mapsAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "maps:read",
} as const;

export const zeroMapsRoutes: readonly RouteEntry[] = [
  {
    route: zeroMapsContract.geocode,
    handler: authRoute(mapsAuth, geocodeInner$),
  },
  {
    route: zeroMapsContract.reverseGeocode,
    handler: authRoute(mapsAuth, reverseGeocodeInner$),
  },
  {
    route: zeroMapsContract.directions,
    handler: authRoute(mapsAuth, directionsInner$),
  },
  {
    route: zeroMapsContract.placesSearch,
    handler: authRoute(mapsAuth, placesSearchInner$),
  },
  {
    route: zeroMapsContract.placesDetails,
    handler: authRoute(mapsAuth, placesDetailsInner$),
  },
  {
    route: zeroMapsContract.osmDownload,
    handler: authRoute(mapsAuth, osmDownloadInner$),
  },
  {
    route: zeroMapsContract.osmRender,
    handler: authRoute(mapsAuth, osmRenderInner$),
  },
];
