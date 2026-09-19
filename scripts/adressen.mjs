/**
 * Vult de geocode-cache aan met een net adres per locatie.
 *
 * Bij het geocoden bewaarden we alleen de volledige regel die Nominatim
 * teruggeeft ("Emergohal, Langs de Akker, Amstelveen, Noord-Holland,
 * Nederland, 1186 DA, Nederland"). Dat is geen adres dat je ergens plakt.
 * Hier halen we dezelfde treffer nog eens op, maar bewaren we de losse
 * velden, zodat er "Langs de Akker, 1186 DA Amstelveen" van te maken is.
 *
 * De coördinaten blijven ongemoeid: we zoeken met precies dezelfde zoekterm
 * als destijds, en schrijven alleen het adres erbij. Handmatige correcties
 * raken dus niets kwijt.
 *
 *   node scripts/adressen.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const CACHE_PAD = 'data/venues.json';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'kaartjeskaart/1.0 (https://github.com/Dustoned; pokemon-beurzen kaart)';

const wacht = (ms) => new Promise((r) => setTimeout(r, ms));
const cache = JSON.parse(readFileSync(CACHE_PAD, 'utf8'));

/** Nederlandse schrijfwijze: straat met huisnummer, dan postcode en plaats. */
function maakAdres(a) {
  if (!a) return null;
  const straat = [a.road, a.house_number].filter(Boolean).join(' ');
  const plaats = a.city ?? a.town ?? a.village ?? a.municipality ?? a.suburb ?? null;
  const postcodePlaats = [a.postcode, plaats].filter(Boolean).join(' ');
  const regel = [straat, postcodePlaats].filter(Boolean).join(', ');
  return regel || null;
}

const teDoen = Object.entries(cache).filter(([, v]) => v.adres === undefined);
console.log(`${teDoen.length} locaties op te zoeken (${Object.keys(cache).length} in de cache)`);

let gevonden = 0;
for (const [i, [sleutel, waarde]] of teDoen.entries()) {
  const url = new URL(NOMINATIM);
  url.searchParams.set('q', waarde.query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('countrycodes', 'nl,be');

  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'nl' } });
    if (!res.ok) throw new Error(String(res.status));
    const [treffer] = await res.json();
    const adres = maakAdres(treffer?.address);
    // `null` bewaren we ook: dan weten we dat er gezocht is en niets was.
    waarde.adres = adres;
    if (adres) gevonden++;
  } catch (err) {
    console.log(`  ! ${sleutel}: ${err.message}`);
  }

  await wacht(1100); // Nominatim staat één verzoek per seconde toe.
  if ((i + 1) % 20 === 0 || i === teDoen.length - 1) {
    console.log(`  ${i + 1}/${teDoen.length} (${gevonden} met adres)`);
    writeFileSync(CACHE_PAD, JSON.stringify(cache, null, 2) + '\n');
  }
}

writeFileSync(CACHE_PAD, JSON.stringify(cache, null, 2) + '\n');
const metAdres = Object.values(cache).filter((v) => v.adres).length;
console.log(`\nklaar: ${metAdres} van de ${Object.keys(cache).length} locaties hebben een adres`);
