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
| `public/` | de site: `index.html`, `styles.css`, `app.js`, `events.json` |
| `scripts/refresh.mjs` | haalt op, parseert, geocodeert, schrijft `events.json` |
| `scripts/lib/parse.mjs` | markdown → evenementen |
| `scripts/lib/geocode.mjs` | stad + zaal → coördinaten, via Nominatim |
| `scripts/test-parse.mjs` | controleert de parser tegen `sample-index.md` |
| `data/venues.json` | de geocode-cache, **hoort in git** |
| `monitor.json` | de instellingen van de Firecrawl-monitor |
| `sample-index.md` | een opgeslagen versie van de bronpagina, als testmateriaal |

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

Ongeveer 180 Firecrawl-credits per maand: 30 voor de dagelijkse scrape en
zo'n 150 voor de monitor. Geocoden via Nominatim is gratis.
