/**
 * Parst de markdown van pokeradar.nl/evenement naar een lijst evenementen.
 *
 * Structuur van de pagina (zoals Firecrawl hem oplevert):
 *
 *   ## september              <- maandkop
 *   2026                      <- jaar, staat altijd los onder de maandkop
 *   ### 19 sepzaterdag        <- dagkop: dagnummer + 3-letterige maand + weekdag
 *   ![..](img)Beurs           <- optionele afbeelding, plakt aan het type
 *   10:00 uur- VT: 09:00 uur  <- tijd, soms met VIP-tijd erachter
 *   ### [Naam](url "Naam")    <- de kop van het evenement zelf
 *   **Stad** Zaalnaam         <- stad + locatie, staat NA de kop
 *
 * Let op: alles vóór de `### [Naam]`-kop (afbeelding, tijd, type,
 * "Geannuleerd") hoort bij het evenement dat er NA komt. Alleen de
 * `**Stad** Zaal`-regel hoort bij het evenement ervoor. Geannuleerde
 * dagen hebben geen tijd, type en stad; daar vallen we terug op de slug.
 */

const MAAND_NAAR_NR = {
  januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6,
  juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12,
};

const AFK_NAAR_NR = {
  jan: 1, feb: 2, mrt: 3, apr: 4, mei: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12,
};

const WEEKDAGEN = 'maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag';

const RE_MAANDKOP = new RegExp(`^## (${Object.keys(MAAND_NAAR_NR).join('|')})\\s*$`);
// Een `##`-kop die géén maand is, sluit de agenda af. In de praktijk is dat
// "## Extra uitgelicht": een carrousel onderaan die 26 evenementen herhaalt
// zonder maand/jaar eromheen, dus met een datum die we niet mogen vertrouwen.
const RE_H2 = /^## /;
const RE_JAAR = /^(20\d{2})\s*$/;
const RE_DAGKOP = new RegExp(`^### (\\d{1,2}) (${Object.keys(AFK_NAAR_NR).join('|')})(${WEEKDAGEN})\\s*$`);
const RE_EVENTKOP = /^### \[(.+?)\]\((https:\/\/[^\s)]+?)(?:\s+"[^"]*")?\)\s*$/;
const RE_STAD_ZAAL = /^\*\*([^*]+?)\*\*\s*(.*)$/;
const RE_TIJD = /(\d{1,2}:\d{2})\s*uur/;
const RE_VIPTIJD = /VT:\s*(\d{1,2}(?::\d{2})?)/;

// De typen die de site zelf in zijn filter aanbiedt.
const TYPES = ['Beurs', 'Tour', 'Toernooi', 'Comic Con', '(Retro) Games', 'Ruildag', 'Markt', 'Winkel opening'];

/**
 * Haalt de stad uit een event-slug als de pagina zelf geen stad toont
 * (gebeurt bij geannuleerde dagen). Slug ziet eruit als
 * "flevocards-ruilmiddag-lelystad-19-september-2026" -> de stad is het
 * woord vlak voor het datumdeel.
 */
export function stadUitSlug(url) {
  const slug = url.split('/').filter(Boolean).pop() || '';
  const maandNamen = Object.keys(MAAND_NAAR_NR).join('|');
  const m = slug.match(new RegExp(`(?:^|-)([a-z-]+?)-(\\d{1,2})-(${maandNamen})-(20\\d{2})$`));
  if (!m) return null;
  // Het stadsdeel kan meerdere streepjes hebben ("den-bosch"); pak het
  // laatste woord, of de laatste twee als het eerste een voorzetsel is.
  const delen = m[1].split('-');
  const staart = delen.slice(-2);
  if (['den', 'sint', 'sint-', 'de', 'het', 'aan', 'oude', 'nieuwe'].includes(staart[0])) {
    return staart.join(' ');
  }
  return delen[delen.length - 1];
}

function titelCase(s) {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * @param {string} markdown - ruwe markdown van /evenement
 * @returns {{events: Array, waarschuwingen: string[]}}
 */
export function parseAgenda(markdown) {
  const regels = markdown.split(/\r?\n/);
  const events = [];
  const waarschuwingen = [];

  let jaar = null;
  let maandNr = null;
  let dag = null;
  let weekdag = null;
  let inAgenda = false;

  // Verzamelt de attributen die vóór de eerstvolgende event-kop staan.
  let hangend = { tijd: null, viptijd: null, type: null, afbeelding: null, geannuleerd: false };
  const resetHangend = () => { hangend = { tijd: null, viptijd: null, type: null, afbeelding: null, geannuleerd: false }; };

  let vorige = null; // het laatst toegevoegde event, voor de **Stad** Zaal-regel

  for (const ruw of regels) {
    const regel = ruw.trim();
    if (!regel) continue;

    const mMaand = regel.match(RE_MAANDKOP);
    if (mMaand) { maandNr = MAAND_NAAR_NR[mMaand[1]]; inAgenda = true; continue; }

    // Zodra de agenda begonnen is, betekent een niet-maand `##` het einde.
    if (inAgenda && RE_H2.test(regel)) break;

    const mJaar = regel.match(RE_JAAR);
    if (mJaar) { jaar = Number(mJaar[1]); continue; }

    const mDag = regel.match(RE_DAGKOP);
    if (mDag) {
      dag = Number(mDag[1]);
      maandNr = AFK_NAAR_NR[mDag[2]];
      weekdag = mDag[3];
      resetHangend();
      vorige = null;
      continue;
    }

    const mEvent = regel.match(RE_EVENTKOP);
    if (mEvent) {
      if (!jaar || !maandNr || !dag) {
        waarschuwingen.push(`Evenement zonder datum overgeslagen: ${mEvent[1]}`);
        resetHangend();
        continue;
      }
      const datum = `${jaar}-${String(maandNr).padStart(2, '0')}-${String(dag).padStart(2, '0')}`;
      const url = mEvent[2];
      const event = {
        id: url.split('/').filter(Boolean).pop(),
        naam: mEvent[1].replace(/\\([|[\]])/g, '$1').trim(),
        url,
        datum,
        weekdag,
        tijd: hangend.tijd,
        viptijd: hangend.viptijd,
        type: hangend.type,
        afbeelding: hangend.afbeelding,
        geannuleerd: hangend.geannuleerd,
        stad: null,
        zaal: null,
      };
      events.push(event);
      vorige = event;
      resetHangend();
      continue;
    }

    // **Stad** Zaal  óf  **Geannuleerd** Deze beursdag gaat niet door
    const mStad = regel.match(RE_STAD_ZAAL);
    if (mStad) {
      const label = mStad[1].trim();
      if (/^geannuleerd$/i.test(label)) {
        // Hoort bij het evenement dat hierna komt.
        hangend.geannuleerd = true;
      } else if (/^\d+$/.test(label)) {
        // Een kaal getal is een datumbadge, geen stad. Negeren.
      } else if (vorige && !vorige.stad) {
        vorige.stad = label;
        vorige.zaal = mStad[2].trim() || null;
      }
      continue;
    }

    // Regels met tijd en/of type, eventueel met een afbeelding ervoor
    // geplakt: "![alt](url)Beurs" of "11:00 uur- VT: 10 uur".
    const mAfb = regel.match(/^!\[[^\]]*\]\((https?:\/\/[^\s)]+?)(?:\?[^)]*)?\)/);
    if (mAfb) hangend.afbeelding = mAfb[1];

    const restRegel = regel.replace(/^!\[[^\]]*\]\([^)]*\)/, '');

    const mTijd = restRegel.match(RE_TIJD);
    if (mTijd) hangend.tijd = mTijd[1];

    const mVip = restRegel.match(RE_VIPTIJD);
    if (mVip) hangend.viptijd = mVip[1].includes(':') ? mVip[1] : `${mVip[1]}:00`;

    for (const t of TYPES) {
      if (restRegel.includes(t)) { hangend.type = t; break; }
    }
  }

  // Vangnet voor het geval de uitgelicht-carrousel ooit tússen de agenda
  // belandt: hetzelfde evenement mag er maar één keer in. De eerste treffer
  // wint, want die staat in de agenda zelf en heeft dus de juiste datum.
  const gezien = new Set();
  const uniek = events.filter((e) => (gezien.has(e.id) ? false : gezien.add(e.id)));
  if (uniek.length !== events.length) {
    waarschuwingen.push(`${events.length - uniek.length} dubbele evenementen verwijderd`);
  }
  events.length = 0;
  events.push(...uniek);

  // Stad aanvullen vanuit de slug waar de pagina hem niet toonde.
  for (const e of events) {
    if (!e.stad) {
      const uitSlug = stadUitSlug(e.url);
      if (uitSlug) {
        e.stad = titelCase(uitSlug);
        e.stadUitSlug = true;
      } else {
        waarschuwingen.push(`Geen stad te bepalen voor: ${e.naam} (${e.url})`);
      }
    }
  }

  return { events, waarschuwingen };
}
