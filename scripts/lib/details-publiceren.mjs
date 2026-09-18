import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/**
 * Schrijft public/details.json uit de cache in data/details.json.
 *
 * De extra gegevens staan los van events.json zodat de kaart snel blijft:
 * de site haalt ze pas op nadat de spelden er al staan. Alleen wat nu op de
 * agenda staat gaat mee, zodat het bestand niet aangroeit met beurzen die
 * allang geweest zijn — de cache zelf houdt alles wél, want opnieuw ophalen
 * kost credits.
 *
 * @param {Array<{id: string, naam: string, stad: string}>} events
 * @returns {{events: number, organisatoren: number} | null}
 */
export function publiceerDetails(events, { cachePad = 'data/details.json', uitPad = 'public/details.json' } = {}) {
  if (!existsSync(cachePad)) return null;

  const bron = JSON.parse(readFileSync(cachePad, 'utf8'));
  const idsNu = new Set(events.map((e) => e.id));
  const orgsNu = new Set(events.map((e) => `${e.naam}|${e.stad}`));

  const uitgedund = {
    events: Object.fromEntries(Object.entries(bron.events ?? {}).filter(([id]) => idsNu.has(id))),
    organisatoren: Object.fromEntries(Object.entries(bron.organisatoren ?? {}).filter(([k]) => orgsNu.has(k))),
  };
  writeFileSync(uitPad, JSON.stringify(uitgedund) + '\n');

  return {
    events: Object.keys(uitgedund.events).length,
    organisatoren: Object.keys(uitgedund.organisatoren).length,
  };
}
