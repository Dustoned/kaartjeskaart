/**
 * Zet "stad + zaal" om in coördinaten via Nominatim (OpenStreetMap).
 *
 * Nominatim is gratis maar streng: maximaal 1 verzoek per seconde en een
 * herkenbare User-Agent verplicht. Daarom cachen we alles in
 * data/venues.json, dat meegecommit wordt. Na de eerste opbouw zijn er
 * per dag nog maar nul tot twee nieuwe locaties op te zoeken.
 *
 * De cache is ook de plek voor handmatige correcties: zet `precisie` op
 * "handmatig" en die regel wordt nooit meer overschreven.
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'kaartjeskaart/1.0 (https://github.com/Dustoned; pokemon-beurzen kaart)';

// Ruime doos om Nederland en België heen. Alles daarbuiten is een
// verkeerde treffer (Nominatim geeft bij een onbekende zaalnaam soms een
// gelijknamige plek in een ander land terug).
const BBOX = { minLat: 49.3, maxLat: 53.8, minLon: 2.3, maxLon: 7.4 };

/**
 * Schrijffouten en varianten in de bron. Links staat wat pokeradar
 * schrijft, rechts wat OpenStreetMap kent.
 */
export const STAD_ALIAS = {
  'Beeds': 'Beesd',                                   // typefout in hun event-slug
  'Etten Leur': 'Etten-Leur',                          // zelfde plaats, twee schrijfwijzen
  'Krimpen aan de IJsel': 'Krimpen aan den IJssel',    // ontbrekende n en s
};

/** Plaatsen die in beide landen bestaan, of deelgemeenten die OSM anders indeelt. */
export const STAD_LAND = {
  'Essen': 'be',       // Essen in de provincie Antwerpen, niet het Duitse Essen
  'Hasselt': 'be',     // Hasselt in Limburg (BE), niet Hasselt in Overijssel
  'Stevoort': 'be',    // deelgemeente van Hasselt
  'Zandvliet': 'be',   // deelgemeente van Antwerpen
  'Venray': 'nl',
  'Brecht': 'be',
  'Riemst': 'be',
};

export const normaliseerStad = (stad) => STAD_ALIAS[stad] ?? stad;

export const cacheSleutel = (stad, zaal) => `${normaliseerStad(stad)}|${zaal ?? ''}`;

const wacht = (ms) => new Promise((r) => setTimeout(r, ms));

function binnenBbox(lat, lon) {
  return lat >= BBOX.minLat && lat <= BBOX.maxLat && lon >= BBOX.minLon && lon <= BBOX.maxLon;
}

async function vraagNominatim(query, landcodes) {
  const url = new URL(NOMINATIM);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('countrycodes', landcodes);

  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'nl' } });
  if (res.status === 429 || res.status === 503) {
    // Nominatim knijpt af; even wachten en één keer opnieuw.
    await wacht(5000);
    const nogmaals = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'nl' } });
    if (!nogmaals.ok) throw new Error(`Nominatim ${nogmaals.status} voor "${query}"`);
    return nogmaals.json();
  }
  if (!res.ok) throw new Error(`Nominatim ${res.status} voor "${query}"`);
  return res.json();
}

/**
 * Zoekt één locatie op. Probeert eerst de zaal, dan de stad.
 * @returns {Promise<object|null>}
 */
export async function zoekLocatie(stad, zaal, { log = () => {} } = {}) {
  const plaats = normaliseerStad(stad);
  const landcodes = STAD_LAND[plaats] ?? STAD_LAND[stad] ?? 'nl,be';

  const pogingen = [];
  if (zaal) pogingen.push({ query: `${zaal}, ${plaats}`, precisie: 'venue' });
  pogingen.push({ query: plaats, precisie: 'city' });

  for (const poging of pogingen) {
    let treffers;
    try {
      treffers = await vraagNominatim(poging.query, landcodes);
    } catch (err) {
      log(`  ! ${poging.query}: ${err.message}`);
      await wacht(1100);
      continue;
    }
    await wacht(1100); // Nominatim staat 1 verzoek per seconde toe.

    const t = treffers?.[0];
    if (!t) continue;

    const lat = Number(t.lat);
    const lon = Number(t.lon);
    if (!binnenBbox(lat, lon)) {
      log(`  ! ${poging.query} viel buiten de Benelux (${lat}, ${lon}) — genegeerd`);
      continue;
    }

    const land = (t.address?.country_code ?? '').toUpperCase();
    return {
      lat: Number(lat.toFixed(5)),
      lon: Number(lon.toFixed(5)),
      precisie: poging.precisie,
      land: land === 'NL' || land === 'BE' ? land : null,
      query: poging.query,
      osm: t.display_name,
    };
  }
  return null;
}

/**
 * Vult de cache aan met alles wat er nog niet in staat.
 * Bestaande regels blijven staan — ook handmatige correcties.
 *
 * @param {Array<{stad: string, zaal: string|null}>} locaties
 * @param {object} cache - wordt ter plekke bijgewerkt
 */
export async function vulCacheAan(locaties, cache, { log = console.log } = {}) {
  const ontbreekt = [];
  for (const { stad, zaal } of locaties) {
    const sleutel = cacheSleutel(stad, zaal);
    if (!cache[sleutel]) ontbreekt.push({ sleutel, stad, zaal });
  }

  // Dubbele sleutels uit de lijst halen.
  const uniek = [...new Map(ontbreekt.map((o) => [o.sleutel, o])).values()];
  if (!uniek.length) {
    log('geocoding   alles stond al in de cache');
    return { nieuw: 0, mislukt: [] };
  }

  log(`geocoding   ${uniek.length} nieuwe locatie(s), ~${Math.ceil((uniek.length * 2.2))}s`);
  const mislukt = [];
  for (const [i, { sleutel, stad, zaal }] of uniek.entries()) {
    const gevonden = await zoekLocatie(stad, zaal, { log });
    if (gevonden) {
      cache[sleutel] = gevonden;
      log(`  ${i + 1}/${uniek.length} ${sleutel} -> ${gevonden.precisie} ${gevonden.land ?? '??'}`);
    } else {
      mislukt.push(sleutel);
      log(`  ${i + 1}/${uniek.length} ${sleutel} -> NIET GEVONDEN`);
    }
  }
  return { nieuw: uniek.length - mislukt.length, mislukt };
}
