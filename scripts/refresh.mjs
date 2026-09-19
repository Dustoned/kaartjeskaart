/**
 * Haalt de agenda op, parseert hem, vult de coördinaten aan en schrijft
 * public/events.json.
 *
 *   node scripts/refresh.mjs                 # via de Firecrawl API
 *   node scripts/refresh.mjs --uit sample-index.md   # uit een bestand
 *
 * Draait in de GitHub Action. Faalt er iets, of komt er onzin terug, dan
 * eindigt dit script met een foutcode en wordt er niets gecommit: de site
 * blijft dan gewoon op de data van gisteren staan.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { parseAgenda } from './lib/parse.mjs';
import { vulCacheAan, cacheSleutel } from './lib/geocode.mjs';
import { publiceerDetails } from './lib/details-publiceren.mjs';

const BRON = 'https://www.pokeradar.nl/evenement';
const CACHE_PAD = 'data/venues.json';
const UIT_PAD = 'public/events.json';
const MIN_EVENTS = 50;

const args = process.argv.slice(2);
const uitBestand = args.includes('--uit') ? args[args.indexOf('--uit') + 1] : null;

/** Haalt de pagina op via de Firecrawl API. */
async function scrape() {
  const sleutel = process.env.FIRECRAWL_API_KEY;
  if (!sleutel) {
    throw new Error('FIRECRAWL_API_KEY ontbreekt. Zet hem als omgevingsvariabele, of draai met --uit <bestand>.');
  }
  const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sleutel}` },
    body: JSON.stringify({ url: BRON, formats: ['markdown'] }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    throw new Error(`Firecrawl gaf ${res.status}: ${body?.error ?? 'onbekende fout'}`);
  }
  const markdown = body.data?.markdown;
  if (!markdown || markdown.length < 5000) {
    throw new Error(`Firecrawl gaf een verdacht korte pagina terug (${markdown?.length ?? 0} tekens)`);
  }
  return markdown;
}

const markdown = uitBestand ? readFileSync(uitBestand, 'utf8') : await scrape();
console.log(`bron        ${uitBestand ?? BRON} (${markdown.length} tekens)`);

const { events, waarschuwingen } = parseAgenda(markdown);
console.log(`geparsed    ${events.length} evenementen`);
waarschuwingen.forEach((w) => console.log(`  ! ${w}`));

if (events.length < MIN_EVENTS) {
  throw new Error(`Maar ${events.length} evenementen gevonden (drempel ${MIN_EVENTS}). De bronpagina is waarschijnlijk veranderd — niets weggeschreven.`);
}

// Coördinaten aanvullen voor locaties die nog niet in de cache staan.
mkdirSync('data', { recursive: true });
const cache = existsSync(CACHE_PAD) ? JSON.parse(readFileSync(CACHE_PAD, 'utf8')) : {};
const { nieuw, mislukt } = await vulCacheAan(
  events.map((e) => ({ stad: e.stad, zaal: e.zaal })),
  cache,
);
if (nieuw) {
  const gesorteerd = Object.fromEntries(
    Object.keys(cache).sort((a, b) => a.localeCompare(b, 'nl')).map((k) => [k, cache[k]]),
  );
  writeFileSync(CACHE_PAD, JSON.stringify(gesorteerd, null, 2) + '\n');
}

// Evenementen en coördinaten samenvoegen.
const zonderCoord = [];
const verrijkt = events.map((e) => {
  const loc = cache[cacheSleutel(e.stad, e.zaal)];
  if (!loc) zonderCoord.push(`${e.stad} / ${e.zaal ?? '-'}`);
  return {
    id: e.id,
    naam: e.naam,
    url: e.url,
    datum: e.datum,
    weekdag: e.weekdag,
    tijd: e.tijd,
    viptijd: e.viptijd,
    type: e.type,
    afbeelding: e.afbeelding,
    geannuleerd: e.geannuleerd,
    stad: e.stad,
    zaal: e.zaal,
    lat: loc?.lat ?? null,
    lon: loc?.lon ?? null,
    land: loc?.land ?? null,
    precisie: loc?.precisie ?? null,
    // Eén regel die je kunt kopiëren en ergens plakken. Kennen we het
    // straatadres, dan staat dat erbij; zo niet, dan is de plaatsnaam het
    // beste wat we hebben — nog altijd genoeg voor een navigatie-app.
    adres: [e.zaal, loc?.adres ?? e.stad].filter(Boolean).join(', ') || null,
  };
});

const opKaart = verrijkt.filter((e) => e.lat !== null);
console.log(`op de kaart ${opKaart.length} van ${verrijkt.length}`);
if (zonderCoord.length) {
  console.log(`zonder coördinaten (${zonderCoord.length}): ${[...new Set(zonderCoord)].join(', ')}`);
}
if (mislukt.length) console.log(`geocoding mislukt: ${mislukt.join(', ')}`);

// Een enkele locatie zonder coördinaten is te overzien, maar als de helft
// wegvalt is er iets structureel mis en willen we de goede data niet kwijt.
if (opKaart.length < verrijkt.length * 0.9) {
  throw new Error(`Slechts ${opKaart.length} van ${verrijkt.length} evenementen hebben coördinaten — niets weggeschreven.`);
}

mkdirSync('public', { recursive: true });

const gepubliceerd = publiceerDetails(verrijkt);
if (gepubliceerd) {
  console.log(`details     ${gepubliceerd.events}/${verrijkt.length} evenementen, ${gepubliceerd.organisatoren} organisatoren`);
}

const uitvoer = {
  bijgewerkt: new Date().toISOString(),
  bron: BRON,
  aantal: verrijkt.length,
  events: verrijkt,
};
writeFileSync(UIT_PAD, JSON.stringify(uitvoer) + '\n');
console.log(`geschreven  ${UIT_PAD} (${(JSON.stringify(uitvoer).length / 1024).toFixed(0)} KB)`);
