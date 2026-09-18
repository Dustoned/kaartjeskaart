/**
 * Controle van de parser tegen een opgeslagen pagina.
 *
 *   node scripts/test-parse.mjs [pad-naar-markdown]
 *
 * Draait ook in de GitHub Action: faalt de controle, dan wordt er niet
 * gecommit en blijft de site op de data van gisteren staan.
 */
import { readFileSync } from 'node:fs';
import { parseAgenda } from './lib/parse.mjs';

const pad = process.argv[2] || 'sample-index.md';
const { events, waarschuwingen } = parseAgenda(readFileSync(pad, 'utf8'));

const fouten = [];
const check = (voorwaarde, bericht) => {
  if (!voorwaarde) fouten.push(bericht);
};

const geannuleerd = events.filter((e) => e.geannuleerd);
const actief = events.filter((e) => !e.geannuleerd);

console.log(`bestand            ${pad}`);
console.log(`evenementen        ${events.length}`);
console.log(`  actief           ${actief.length}`);
console.log(`  geannuleerd      ${geannuleerd.length}`);
console.log(`zonder stad        ${events.filter((e) => !e.stad).length}`);
console.log(`stad uit slug      ${events.filter((e) => e.stadUitSlug).length}`);
console.log(`zonder zaal        ${events.filter((e) => !e.zaal).length}`);
console.log(`actief zonder tijd ${actief.filter((e) => !e.tijd).length}`);
console.log(`actief zonder type ${actief.filter((e) => !e.type).length}`);
console.log(`unieke steden      ${new Set(events.map((e) => e.stad)).size}`);
console.log(`unieke ids         ${new Set(events.map((e) => e.id)).size}`);
console.log(`datumbereik        ${events[0]?.datum} .. ${events.at(-1)?.datum}`);
if (waarschuwingen.length) {
  console.log(`\nwaarschuwingen (${waarschuwingen.length}):`);
  waarschuwingen.slice(0, 10).forEach((w) => console.log('  !', w));
}

// De drempel die een kapotte scrape of een verbouwde bronpagina vangt.
check(events.length >= 50, `te weinig evenementen (${events.length}), bron waarschijnlijk veranderd`);
check(events.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.datum)), 'evenement met een ongeldige datum');
check(new Set(events.map((e) => e.id)).size === events.length, 'dubbele event-ids');
check(events.every((e) => e.url.startsWith('https://www.pokeradar.nl/evenement/')), 'evenement met een onverwachte url');
check(events.filter((e) => !e.stad).length === 0, 'evenement zonder stad');
// Datums moeten oplopen; anders is de maand/jaar-administratie misgegaan.
const datums = events.map((e) => e.datum);
check(datums.every((d, i) => i === 0 || d >= datums[i - 1]), 'datums lopen niet op — maand/jaar verkeerd geparsed');
check(actief.filter((e) => !e.type).length / Math.max(actief.length, 1) < 0.1, 'meer dan 10% van de actieve evenementen mist een type');

if (fouten.length) {
  console.error(`\nMISLUKT:\n${fouten.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('\nOK');
