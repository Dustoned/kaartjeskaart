/**
 * Parst de detailpagina van een evenement en de bijbehorende pagina met
 * website en socials.
 *
 * De detailpagina toont onderaan een blok met kerngegevens, dat er in
 * markdown zo uitziet:
 *
 *   11:00 uurBegintijd
 *   16:00 uurEindtijd
 *   Ja[Tickets](https://.../tickets)
 *   JaEten & drinken
 *   JaGratis Parkeren
 *   44[Edities (totaal)](https://.../edities)
 *
 * De volgorde wisselt per evenement en velden kunnen ontbreken, dus we
 * zoeken elk gegeven los op in de hele tekst in plaats van regel voor regel.
 */

/** Socials horen bij de organisator, niet bij de losse beursdag. */
export const organisatorSleutel = (e) => `${e.naam}|${e.stad}`;

const jaNee = (s) => (s ? /^ja$/i.test(s.trim()) : null);

/** Snijdt de beschrijving uit: alles tussen de terugkoppeling en het cijferblok. */
function haalBeschrijving(markdown) {
  const start = markdown.search(/\[Alle evenementen[^\]]*\]\([^)]*\)/);
  if (start === -1) return null;
  let tekst = markdown.slice(markdown.indexOf(')', start) + 1);

  // De aftelklok ("Dagen / Uur / Minuten / Seconden" met losse cijfers) en
  // het cijferblok eronder horen niet bij de beschrijving. Knip bij het
  // eerste teken van een van beide.
  const einde = [
    /^\s*Dagen\s*$/m,
    /\d{1,2}:\d{2}\s*uur\s*Begintijd/,
    /^\s*##\s/m,
    /Op de Radar/,
  ]
    .map((re) => tekst.search(re))
    .filter((i) => i !== -1);
  if (einde.length) tekst = tekst.slice(0, Math.min(...einde));

  tekst = tekst
    .split(/\r?\n/)
    .map((r) => r.trim())
    // Losse opmaakresten en afbeeldingen eruit.
    .filter((r) => r && r !== '* * *' && !/^!\[/.test(r) && !/^\[.*\]\(.*\)$/.test(r))
    .join('\n')
    .trim();

  return tekst || null;
}

/**
 * @param {string} markdown - de markdown van /evenement/<slug>
 */
export function parseDetail(markdown) {
  const pak = (re) => markdown.match(re)?.[1] ?? null;

  const afbeelding = markdown.match(/!\[[^\]]*\]\((https:\/\/cms\.pokeradar\.nl\/assets\/events\/[^)\s?]+)/)?.[1] ?? null;

  return {
    begintijd: pak(/(\d{1,2}:\d{2})\s*uur\s*Begintijd/),
    eindtijd: pak(/(\d{1,2}:\d{2})\s*uur\s*Eindtijd/),
    tickets: jaNee(pak(/(Ja|Nee)\s*\[?\s*Tickets/i)),
    eten: jaNee(pak(/(Ja|Nee)\s*Eten\s*&?\s*drinken/i)),
    parkeren: jaNee(pak(/(Ja|Nee)\s*Gratis\s*Parkeren/i)),
    edities: Number(pak(/(\d+)\s*\[?\s*Edities/i)) || null,
    ticketsUrl: markdown.match(/\[Tickets\]\((https:\/\/[^)\s]+\/tickets)\)/)?.[1] ?? null,
    afbeelding,
    beschrijving: haalBeschrijving(markdown),
  };
}

/**
 * @param {string} markdown - de markdown van /evenement/<slug>/website-socials
 */
export function parseSocials(markdown) {
  // Alleen het blok onder de kop pakken; daaronder staat de vaste voettekst
  // met links van pokeradar zelf, die we niet willen.
  const start = markdown.search(/##\s*Website\s*&?\s*socials/i);
  const blok = start === -1 ? markdown : markdown.slice(start, markdown.search(/##\s*Meer handige links/i) >>> 0 || undefined);

  const website = blok.match(/\*\*Website\*\*\s*\n+\s*\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i)?.[1] ?? null;
  const email = blok.match(/\[([^\]]+)\]\(mailto:([^)\s]+)\)/i)?.[2] ?? null;

  const socials = [];
  const socialsBlok = blok.slice(blok.search(/\*\*Socials\*\*/i) >>> 0 || 0);
  for (const m of socialsBlok.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+?)(?:\s+"[^"]*")?\)/g)) {
    const url = m[2];
    if (/pokeradar\.nl|devoda\.nl/.test(url)) continue;
    if (url === website) continue;
    socials.push({ platform: m[1].toLowerCase().trim(), url });
  }

  return {
    website,
    email,
    socials: socials.length ? socials : null,
  };
}
