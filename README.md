# Kaartjeskaart

Alle Pokémon-kaartenbeurzen in Nederland en België op één snelle kaart.

De agenda komt van [pokeradar.nl](https://www.pokeradar.nl/evenement), die de
evenementen verzamelt. Deze kaart is een **viewer**: elke speld linkt door naar
de evenementpagina op pokeradar zelf.

## Hoe het werkt

```
pokeradar.nl/evenement
        │   1 scrape levert de complete agenda (alle evenementen staan op één pagina)
        ▼
  GitHub Action, elke ochtend
        │   parsen → nieuwe locaties geocoden → public/events.json
        ▼
  commit → GitHub Pages
```

Geen server en geen database. De site is drie statische bestanden plus een
JSON van zo'n 60 KB, dus de kaart staat er meteen.

Daarnaast draait er een **Firecrawl-monitor** die dagelijks kijkt of het aantal
evenementen op de agenda verandert en daar een mail over stuurt.

## Mappen

| Pad | Wat |
|---|---|
| `public/` | de site: `index.html`, `styles.css`, `app.js`, `events.json`, `details.json` |
| `scripts/refresh.mjs` | haalt de agenda op, parseert, geocodeert, schrijft `events.json` |
| `scripts/fetch-details.mjs` | haalt per evenement de detailpagina en per organisator de website op |
| `scripts/lib/parse.mjs` | markdown van de agenda → evenementen |
| `scripts/lib/detail-parse.mjs` | markdown van een detailpagina → tijden, voorzieningen, website |
| `scripts/lib/geocode.mjs` | stad + zaal → coördinaten, via Nominatim |
| `scripts/lib/details-publiceren.mjs` | snoeit de detailcache tot wat nu op de agenda staat |
| `scripts/test-parse.mjs` | controleert de parser tegen `sample-index.md` |
| `data/venues.json` | de geocode-cache, **hoort in git** |
| `data/details.json` | de detailcache, **hoort in git** |
| `.raw/` | ruwe markdown per pagina, **niet in git** — om gratis te kunnen herparsen |
| `monitor.json` | de instellingen van de Firecrawl-monitor |
| `sample-index.md` | een opgeslagen versie van de bronpagina, als testmateriaal |

## Wat de kaart kan

- **Filteren** op periode (dit weekend, 7 of 30 dagen, alles, of een eigen
  datumbereik), land, soort en een zoekterm. De soort-tags in de lijst en de
  legenda zijn knoppen: erop klikken filtert meteen.
- **Eigen locatie** via de browser. Daarna staat de afstand en de rijtijd bij
  elke beurs, kun je op afstand sorteren of alleen beurzen binnen zoveel
  kilometer tonen, en zit er een navigeerknop in elke popup. Je coördinaten
  blijven op je eigen apparaat; ze gaan alleen naar `localStorage`.

  Bij het openen regelt de pagina dit zelf. Staat de toestemming al aan, dan
  wordt de positie stil ververst — je krijgt dus geen venster te zien. Is er
  nog nooit om gevraagd, dan gebeurt dat één keer, en pas nadat de kaart er
  staat: een venster boven een lege pagina wordt reflexmatig weggeklikt. Is
  het ooit geweigerd, dan laat de pagina het met rust; de speldknop blijft
  staan voor wie het later alsnog wil. Geef je later alsnog toestemming in de
  browserinstellingen, dan wordt dat direct opgepikt.

  **Een browser zonder GPS raadt.** Op een desktop leidt hij je positie af uit
  je IP-adres of de wifi-netwerken om je heen, en dat kan er tientallen
  kilometers naast zitten. Daarom staat onder de puntjesknop een veld waarin
  je je plaats of postcode kunt typen; die keuze overschrijft de browser niet
  meer. En om te voorkomen dat je je afvraagt waarom de afstanden raar zijn,
  toont de pagina welke plaats hij denkt te zien — met een waarschuwing erbij
  als de schatting grover is dan twee kilometer.
- **Kleur op soort of op datum**, met een schakelaar. Let op: 212 van de 235
  evenementen zijn van het soort "Beurs", dus op soort kleuren maakt de kaart
  grotendeels eenkleurig. Op datum is vaak bruikbaarder.
- **Per beurs**: begintijd en eindtijd, of er tickets zijn, eten en drinken,
  gratis parkeren, het aantal edities, de beschrijving, de website van de
  organisator en zijn socials.

### Twee databestanden, met opzet

`events.json` (~100 KB) bevat alles wat nodig is om de kaart te tekenen en
wordt meteen geladen. `details.json` is groter en bevat de extra gegevens;
dat haalt de site er pas bij nádat de spelden er staan. Valt dat tweede
bestand weg, dan werkt de kaart gewoon, alleen met minder detail per beurs.

### Detailgegevens ophalen

Elke detailpagina kost een credit en verandert daarna vrijwel nooit meer, dus
ze worden één keer opgehaald en bewaard in `data/details.json`. De dagelijkse
Action doet er hooguit 30 per run — genoeg voor de paar nieuwe beurzen die er
per dag bij komen, en een rem voor als de agenda ineens volloopt.

De ruwe markdown blijft lokaal in `.raw/` staan. Verandert de parser, dan kun
je alles opnieuw verwerken zonder ook maar één credit uit te geven:

```bash
node scripts/fetch-details.mjs --herparse
```

## Lokaal draaien

```bash
node scripts/test-parse.mjs                       # parser controleren, kost niets
node scripts/refresh.mjs --uit sample-index.md    # events.json uit het testbestand
npx serve public                                  # of open public/index.html
```

Verversen vanaf de echte site heeft een Firecrawl-sleutel nodig:

```bash
FIRECRAWL_API_KEY=fc-... node scripts/refresh.mjs
```

## De geocode-cache

`data/venues.json` bewaart de coördinaten per `stad|zaal`. De cache staat in
git, zodat Nominatim niet elke dag opnieuw 129 locaties hoeft op te zoeken —
er komen er per dag hooguit een paar bij.

Staat een speld verkeerd? Pas de regel aan en zet `precisie` op `handmatig`;
zulke regels worden nooit overschreven.

```json
"Utrecht|Jaarbeurs Utrecht": {
  "lat": 52.08979,
  "lon": 5.10119,
  "precisie": "handmatig",
  "land": "NL"
}
```

Bekende schrijffouten in de bron staan in `STAD_ALIAS` in
`scripts/lib/geocode.mjs` (`Beeds` → `Beesd`, `Etten Leur` → `Etten-Leur`,
`Krimpen aan de IJsel` → `Krimpen aan den IJssel`). Plaatsen die in beide
landen bestaan staan vastgezet in `STAD_LAND` — `Essen` is het Belgische
Essen, `Hasselt` het Limburgse.

## Als er iets misgaat

Het refresh-script stopt zonder te schrijven als:

- Firecrawl een fout of een verdacht korte pagina teruggeeft;
- er minder dan 50 evenementen uit de parser komen;
- minder dan 90% van de evenementen coördinaten heeft.

Dan blijft de vorige `events.json` staan en blijft de site dus gewoon werken.
De voettekst toont wanneer de data voor het laatst is bijgewerkt, en kleurt
oranje zodra dat meer dan drie dagen geleden is.

## Instellen

1. Zet GitHub Pages aan: **Settings → Pages → Source: GitHub Actions**.
2. Voeg je Firecrawl-sleutel toe als secret:

   ```bash
   gh secret set FIRECRAWL_API_KEY
   ```

3. Start de eerste run met **Actions → Verversen en publiceren → Run workflow**.

## Credits

Doorlopend zo'n 180 tot 270 Firecrawl-credits per maand:

| Wat | Per maand |
|---|---|
| dagelijkse scrape van de agenda | 30 |
| monitor met JSON-extractie | ~150 |
| detailpagina's van nieuwe beurzen | 0–90 (hooguit 30 per dag) |

Eenmalig kostte het vullen van de detailcache zo'n 390 credits. Die hoeft
nooit meer opgehaald te worden. Geocoden via Nominatim is gratis.

Wordt het krap, dan kan de monitor van ~150 naar 30 door de JSON-extractie te
vervangen door een gewone markdown-diff — de Action ziet nieuwe beurzen
namelijk ook zelf, door met de vorige `events.json` in git te vergelijken.
