/**
 * Haalt per evenement de detailpagina op, en per organisator de pagina met
 * website en socials. Beide kosten een Firecrawl-credit, dus:
 *
 *  - de ruwe markdown gaat in `.raw/` (lokaal, niet in git). Moet de parser
 *    later veranderen, dan kan ik daaruit opnieuw parsen zonder credits;
 *  - het geparste resultaat gaat in `data/details.json`, dat wél in git zit;
 *  - alles wat er al in staat wordt overgeslagen.
 *
 * De socialspagina hoort bij de organisator, niet bij de losse beursdag, dus
 * die wordt per naam+stad één keer opgehaald in plaats van per evenement.
 *
 * Twee manieren van ophalen:
 *  - staat FIRECRAWL_API_KEY in de omgeving (de GitHub Action), dan gaat het
 *    via de API, pagina voor pagina. Daar gaat het om een handvol nieuwe
 *    evenementen per dag;
 *  - staat hij er niet, dan draait de Firecrawl-CLI met zijn opgeslagen
 *    inloggegevens. Die krijgt meerdere URL's tegelijk mee: één proces per
 *    groep in plaats van per pagina, want dat laatste liep vast.
 *
 *   node scripts/fetch-details.mjs             # alles wat ontbreekt
 *   node scripts/fetch-details.mjs --max 25    # hooguit 25 per soort
 *   node scripts/fetch-details.mjs --herparse  # alleen opnieuw parsen uit .raw/
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { parseDetail, parseSocials, organisatorSleutel } from './lib/detail-parse.mjs';
import { publiceerDetails } from './lib/details-publiceren.mjs';

const run = promisify(execFile);

const RAW_DIR = '.raw';
const CLI_DIR = '.firecrawl';
const DETAILS_PAD = 'data/details.json';
const EVENTS_PAD = 'public/events.json';
const GROEP = 20; // URL's per CLI-aanroep

const args = process.argv.slice(2);
const max = args.includes('--max') ? Number(args[args.indexOf('--max') + 1]) : Infinity;
const alleenHerparsen = args.includes('--herparse');

mkdirSync(RAW_DIR, { recursive: true });
mkdirSync('data', { recursive: true });

const events = JSON.parse(readFileSync(EVENTS_PAD, 'utf8')).events;
const details = existsSync(DETAILS_PAD) ? JSON.parse(readFileSync(DETAILS_PAD, 'utf8')) : { events: {}, organisatoren: {} };
details.events ??= {};
details.organisatoren ??= {};

const rawPad = (naam) => `${RAW_DIR}/${naam}.md`;
const wacht = (ms) => new Promise((r) => setTimeout(r, ms));

/** Zoals de CLI een opgehaalde pagina noemt: domein en pad, streepjes ertussen. */
const cliNaam = (url) =>
  `${CLI_DIR}/${url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').replace(/\//g, '-')}.md`;

/**
 * Haalt een groep pagina's op. Geeft per taak terug of het gelukt is; wat al
 * in `.raw/` staat wordt niet opnieuw opgehaald.
 *
 * @param {Array<{url: string, naam: string}>} taken
 */
async function haalGroep(taken) {
  const nodig = taken.filter((t) => !existsSync(rawPad(t.naam)));
  if (!nodig.length || alleenHerparsen) return;

  const sleutel = process.env.FIRECRAWL_API_KEY;

  if (sleutel) {
    for (const t of nodig) {
      const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sleutel}` },
        body: JSON.stringify({ url: t.url, formats: ['markdown'] }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        console.log(`  ! ${t.naam}: ${res.status} ${body?.error ?? ''}`);
        continue;
      }
      const markdown = body.data?.markdown ?? '';
      if (markdown.length < 500) { console.log(`  ! ${t.naam}: te korte pagina`); continue; }
      writeFileSync(rawPad(t.naam), markdown);
      await wacht(300);
    }
    return;
  }

  // Alleen adressen van de bron doorgeven, en niets met tekens die een shell
  // anders zou kunnen opvatten.
  const urls = nodig.map((t) => t.url);
  const onveilig = urls.find((u) => !/^https:\/\/www\.pokeradar\.nl\/evenement\/[\w-]+(\/[\w-]+)?$/.test(u));
  if (onveilig) throw new Error(`onverwacht adres geweigerd: ${onveilig}`);

  // De CLI schrijft zelf naar .firecrawl/ onder zijn eigen naamgeving; die
  // halen we daarna op en leggen we onder onze eigen naam in .raw/.
  // Op Windows is `firecrawl` een .cmd-schil, en die mag sinds Node 20 niet
  // meer rechtstreeks gestart worden (spawn EINVAL). Daarom via cmd.exe, met
  // de argumenten nog steeds los in een array in plaats van aaneengeplakt.
  const [cmd, basis] = process.platform === 'win32'
    ? ['cmd.exe', ['/c', 'firecrawl', 'scrape']]
    : ['firecrawl', ['scrape']];

  for (let poging = 1; poging <= 3; poging++) {
    try {
      await run(cmd, [...basis, ...urls], { timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
      break;
    } catch (err) {
      const tekst = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message}`;
      if (poging === 3) { console.log(`  ! groep mislukt: ${tekst.slice(0, 160)}`); break; }
      const seconden = Number(tekst.match(/retry after (\d+)/i)?.[1] ?? 30);
      await wacht((seconden + 3) * 1000);
    }
  }

  for (const t of nodig) {
    const vanaf = cliNaam(t.url);
    if (!existsSync(vanaf)) { console.log(`  ! ${t.naam}: niet opgehaald`); continue; }
    const markdown = readFileSync(vanaf, 'utf8');
    if (markdown.length < 500) { console.log(`  ! ${t.naam}: te korte pagina`); continue; }
    copyFileSync(vanaf, rawPad(t.naam));
  }
}

/** Werkt een lijst taken af in groepen en meldt de voortgang. */
async function werkAf(taken, label, verwerk) {
  console.log(`${label}: ${taken.length} te doen`);
  let klaar = 0;
  for (let i = 0; i < taken.length; i += GROEP) {
    const groep = taken.slice(i, i + GROEP);
    await haalGroep(groep);
    for (const t of groep) {
      if (!existsSync(rawPad(t.naam))) continue;
      try {
        verwerk(t, readFileSync(rawPad(t.naam), 'utf8'));
        klaar++;
      } catch (err) {
        console.log(`  ! ${t.naam}: ${err.message}`);
      }
    }
    writeFileSync(DETAILS_PAD, JSON.stringify(details, null, 1) + '\n');
    console.log(`  ${Math.min(i + GROEP, taken.length)}/${taken.length} (${klaar} verwerkt)`);
  }
  return klaar;
}

/* ---------- detailpagina's ---------- */

const detailTaken = events
  .filter((e) => !details.events[e.id] || alleenHerparsen)
  .slice(0, max)
  .map((e) => ({ url: e.url, naam: e.id, id: e.id }));

await werkAf(detailTaken, "detailpagina's", (t, markdown) => {
  details.events[t.id] = parseDetail(markdown);
});

/* ---------- socials, per organisator ---------- */

const perOrganisator = new Map();
for (const e of events) {
  const sleutel = organisatorSleutel(e);
  if (!perOrganisator.has(sleutel)) perOrganisator.set(sleutel, e);
}
const socialTaken = [...perOrganisator.entries()]
  .filter(([sleutel]) => !details.organisatoren[sleutel] || alleenHerparsen)
  .slice(0, max)
  .map(([sleutel, e]) => ({ url: `${e.url}/website-socials`, naam: `${e.id}--socials`, sleutel }));

await werkAf(socialTaken, 'socials', (t, markdown) => {
  details.organisatoren[t.sleutel] = parseSocials(markdown);
});

writeFileSync(DETAILS_PAD, JSON.stringify(details, null, 1) + '\n');
console.log(`\ncache: ${Object.keys(details.events).length} evenementen, ${Object.keys(details.organisatoren).length} organisatoren`);
console.log(`ruwe bestanden in ${RAW_DIR}/: ${readdirSync(RAW_DIR).length}`);

// De site leest public/details.json, dus die meteen bijwerken.
const gepubliceerd = publiceerDetails(events);
if (gepubliceerd) {
  console.log(`gepubliceerd: ${gepubliceerd.events} evenementen, ${gepubliceerd.organisatoren} organisatoren`);
}
