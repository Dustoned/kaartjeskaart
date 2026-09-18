/**
 * Zet een korte inhoudshash achter de verwijzingen naar app.js en styles.css
 * in public/index.html.
 *
 * GitHub Pages stuurt `Cache-Control: max-age=600` mee. Zonder stempel draait
 * een terugkerende bezoeker na een uitrol dus tot tien minuten lang de oude
 * code — en oude code met nieuwe data is precies waar het fout gaat zodra het
 * formaat van events.json ooit verandert. Met een hash in de naam haalt de
 * browser een gewijzigd bestand meteen opnieuw op, en een ongewijzigd bestand
 * juist helemaal niet.
 *
 * Draait in de Action vlak vóór het publiceren, dus het resultaat wordt niet
 * teruggecommit. De bewerking is herhaalbaar: een bestaande stempel wordt
 * vervangen, niet aangevuld.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const INDEX = 'public/index.html';
const BESTANDEN = ['app.js', 'styles.css'];

let html = readFileSync(INDEX, 'utf8');

for (const naam of BESTANDEN) {
  const hash = createHash('sha256').update(readFileSync(`public/${naam}`)).digest('hex').slice(0, 8);
  // Zowel een kale verwijzing als een al gestempelde wordt opgepakt.
  const patroon = new RegExp(`(["'])${naam.replace('.', '\\.')}(\\?v=[a-f0-9]+)?\\1`, 'g');
  // Op een treffer controleren, niet op verandering: staat de juiste stempel
  // er al, dan levert vervangen dezelfde tekst op en is er niets mis.
  if (!patroon.test(html)) {
    console.error(`Geen verwijzing naar ${naam} gevonden in ${INDEX} — niets gestempeld.`);
    process.exit(1);
  }
  patroon.lastIndex = 0;
  html = html.replace(patroon, `$1${naam}?v=${hash}$1`);
  console.log(`${naam.padEnd(12)} -> ?v=${hash}`);
}

writeFileSync(INDEX, html);
