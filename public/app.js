/* Kaartjeskaart — beurzen uit events.json op een kaart en in een lijst. */
'use strict';

/* Esri's Gray Canvas: rustig, werkt zonder sleutel, en er is een donkere
   én een lichte variant. Let op de volgorde {z}/{y}/{x} — Esri zet de rij
   vóór de kolom, andersom dan de meeste tegelservers. */
const TEGELS = {
  donker: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  licht: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
};
const NAAMSVERMELDING =
  'Tegels &copy; <a href="https://www.esri.com">Esri</a> &middot; ' +
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bijdragers';
const TEGEL_MAXZOOM = 16;

const DAG_MS = 86400000;
const WEEKDAGEN = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

/* ---------- hulpjes ---------- */

const $ = (sel) => document.querySelector(sel);

/** Middernacht vandaag, in lokale tijd. */
function vandaagOm0() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** "2026-09-19" -> Date op middernacht lokale tijd (niet UTC, anders schuift de dag). */
function naarDatum(s) {
  const [j, m, d] = s.split('-').map(Number);
  return new Date(j, m - 1, d);
}

const dagenTot = (datum) => Math.round((naarDatum(datum) - vandaagOm0()) / DAG_MS);

function urgentie(dagen) {
  if (dagen <= 0) return 'vandaag';
  if (dagen <= 7) return 'week';
  if (dagen <= 30) return 'maand';
  return 'later';
}

/* Vaste plek per soort. De volgorde ligt vast en wordt nooit doorgeschoven:
   verdwijnt een soort uit het filter, dan houden de andere hun kleur. Een
   soort die hier niet in staat krijgt grijs in plaats van een nieuwe kleur. */
const SOORT_SLOT = {
  'Beurs': 1,
  'Ruildag': 2,
  'Toernooi': 3,
  'Comic Con': 4,
  '(Retro) Games': 5,
  'Markt': 6,
  'Tour': 7,
  'Winkel opening': 8,
};

let kleurModus = 'soort'; // 'soort' of 'datum'

/** Welke kleurnaam hoort bij dit evenement, gegeven de gekozen modus. */
function niveauVan(e) {
  if (e.geannuleerd) return kleurModus === 'soort' ? 'soort-0' : 'later';
  if (kleurModus === 'soort') return `soort-${SOORT_SLOT[e.type] ?? 0}`;
  return urgentie(dagenTot(e.datum));
}

/** Dringendheid voor de kleur van een tros; alleen zinvol in datummodus. */
const RANG = { vandaag: 0, week: 1, maand: 2, later: 3 };

/* De themakleuren staan in CSS-variabelen, maar ze uitlezen kost een
   herberekening van de stijl. Bij 235 spelden loont het om ze één keer
   per thema op te halen. */
let kleurCache = {};
function ververKleuren() {
  const stijl = getComputedStyle(document.documentElement);
  kleurCache = {};
  const namen = ['vandaag', 'week', 'maand', 'later', 'accent'];
  for (let i = 0; i <= 8; i++) namen.push(`soort-${i}`);
  for (const niveau of namen) {
    kleurCache[niveau] = stijl.getPropertyValue(`--${niveau}`).trim() || '#8a97ab';
  }
}
const kleurVan = (niveau) => kleurCache[niveau] ?? '#8a97ab';

/** "vandaag", "morgen", "over 5 dagen", "over 3 weken" */
function relatief(dagen) {
  if (dagen < 0) return 'geweest';
  if (dagen === 0) return 'vandaag';
  if (dagen === 1) return 'morgen';
  if (dagen === 2) return 'overmorgen';
  if (dagen < 14) return `over ${dagen} dagen`;
  if (dagen < 60) return `over ${Math.round(dagen / 7)} weken`;
  return `over ${Math.round(dagen / 30)} maanden`;
}

function datumLabel(datumStr) {
  const d = naarDatum(datumStr);
  return `${WEEKDAGEN[d.getDay()]} ${d.getDate()} ${MAANDEN[d.getMonth()]}`;
}

/** De eerstvolgende zaterdag en zondag (vandaag telt mee als het al weekend is). */
function komendWeekend() {
  const nu = vandaagOm0();
  const dag = nu.getDay(); // 0 = zondag
  const zat = new Date(nu);
  if (dag === 0) {
    zat.setDate(nu.getDate() - 1); // vandaag is zondag: het weekend loopt af
  } else {
    zat.setDate(nu.getDate() + ((6 - dag + 7) % 7));
  }
  const zon = new Date(zat);
  zon.setDate(zat.getDate() + 1);
  return { van: zat < nu ? nu : zat, tot: zon };
}

const ontsnap = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- toestand ---------- */

const filters = {
  periode: '30',
  van: null,   // eigen datumbereik, als periode === 'eigen'
  tot: null,
  landen: new Set(['NL', 'BE']),
  type: '',
  zoek: '',
  straal: null, // km vanaf mijn locatie
  inBeeld: true,   // standaard aan: de lijst toont wat je op de kaart ziet
  toonGeannuleerd: false,
};

let alleEvents = [];
let zichtbaar = [];
let gekozenId = null;
let details = null;       // extra gegevens, worden na het eerste tekenen geladen
let mijnLocatie = null;   // {lat, lon}
let mijnSpeld = null;
let sorteerOpAfstand = false;
let kaart;
let tegellaag;
let clusters;
const spelden = new Map(); // id -> marker

/* ---------- afstand ---------- */

/** Hemelsbrede afstand in kilometers tussen twee punten. */
function afstandKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Afstand van mijn locatie tot een evenement, of null als ik niet weet waar ik ben. */
function afstandTot(e) {
  if (!mijnLocatie || e.lat === null) return null;
  return afstandKm(mijnLocatie.lat, mijnLocatie.lon, e.lat, e.lon);
}

const toonAfstand = (km) => (km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`);

/** "45 min" of "2 u 12". */
function toonDuur(minuten) {
  if (minuten < 60) return `${minuten} min`;
  return `${Math.floor(minuten / 60)} u ${String(minuten % 60).padStart(2, '0')}`;
}

/**
 * Ruwe schatting van de rijtijd, puur uit de hemelsbrede afstand. Wordt
 * meteen getoond zodat er nooit een lege plek staat, en daarna vervangen
 * door de echte route zodra die binnen is.
 */
function schatReistijd(km) {
  const weg = km * 1.25; // wegen lopen niet rechtdoor
  const snelheid = weg < 10 ? 35 : weg < 40 ? 62 : 85;
  return { minuten: Math.max(1, Math.round((weg / snelheid) * 60)), km: weg, geschat: true };
}

/* Echte rijtijden komen van OSRM, een gratis routeringsdienst zonder
   sleutel. Het is een demoserver, dus: hooguit één verzoek per geopende
   popup, het antwoord onthouden, en bij een fout gewoon de schatting laten
   staan. */
const reistijden = new Map(); // "lat,lon->lat,lon" -> {minuten, km}

async function haalReistijd(e) {
  if (!mijnLocatie || e.lat === null) return null;
  const sleutel = `${mijnLocatie.lat},${mijnLocatie.lon}->${e.lat},${e.lon}`;
  if (reistijden.has(sleutel)) return reistijden.get(sleutel);

  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${mijnLocatie.lon},${mijnLocatie.lat};${e.lon},${e.lat}?overview=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    const route = body?.routes?.[0];
    if (!route) throw new Error('geen route');
    const uitkomst = { minuten: Math.round(route.duration / 60), km: route.distance / 1000, geschat: false };
    reistijden.set(sleutel, uitkomst);
    return uitkomst;
  } catch {
    reistijden.set(sleutel, null); // niet blijven proberen
    return null;
  }
}

/** De regel met rijtijd en afstand over de weg. */
function reisTekst({ minuten, km, geschat }) {
  return `${geschat ? '±&nbsp;' : ''}${toonDuur(minuten)} rijden · ${toonAfstand(km)} over de weg`;
}

/* ---------- thema ---------- */

function pasThemaToe(thema) {
  document.documentElement.dataset.thema = thema;
  try { localStorage.setItem('kaartjeskaart-thema', thema); } catch { /* privémodus */ }
  ververKleuren();
  if (tegellaag) tegellaag.setUrl(TEGELS[thema === 'licht' ? 'licht' : 'donker']);
  if (alleEvents.length) tekenAlles();
}

function beginThema() {
  let opgeslagen = null;
  try { opgeslagen = localStorage.getItem('kaartjeskaart-thema'); } catch { /* privémodus */ }
  const systeem = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'licht' : 'donker';
  return opgeslagen || systeem;
}

/* ---------- kaart ---------- */

function maakKaart() {
  kaart = L.map('kaart', {
    center: [51.85, 4.9],
    zoom: 7,
    zoomControl: true,
    // Verder uitzoomen dan 6 heeft geen zin voor een Benelux-kaart, en het
    // zorgt voor grijze banden boven en onder zodra de wereldkaart smaller
    // wordt dan het venster. De grenzen houden je bovendien in de buurt.
    minZoom: 6,
    maxBounds: L.latLngBounds([44.5, -11], [59.5, 21]),
    maxBoundsViscosity: 0.7,
    worldCopyJump: false,
  });

  const thema = document.documentElement.dataset.thema;
  tegellaag = L.tileLayer(TEGELS[thema === 'licht' ? 'licht' : 'donker'], {
    attribution: NAAMSVERMELDING,
    // Esri levert tot zoom 16; daarboven rekt Leaflet de laatste tegel op,
    // zodat je wel verder kunt inzoomen op een speld.
    maxNativeZoom: TEGEL_MAXZOOM,
    maxZoom: 18,
    noWrap: true,
  }).addTo(kaart);

  clusters = L.markerClusterGroup({
    maxClusterRadius: 44,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    disableClusteringAtZoom: 13,
    chunkedLoading: true,
    iconCreateFunction(cluster) {
      const kinderen = cluster.getAllChildMarkers();
      let beste;
      if (kleurModus === 'datum') {
        // Op datum telt het meest dringende evenement in de tros.
        beste = 'later';
        for (const m of kinderen) if (RANG[m.options.niveau] < RANG[beste]) beste = m.options.niveau;
      } else {
        // Op soort telt wat er het meeste in zit.
        const telling = new Map();
        for (const m of kinderen) telling.set(m.options.niveau, (telling.get(m.options.niveau) ?? 0) + 1);
        beste = [...telling.entries()].sort((a, b) => b[1] - a[1])[0][0];
      }
      const n = cluster.getChildCount();
      const grootte = n < 10 ? 34 : n < 50 ? 40 : 46;
      return L.divIcon({
        html: `<div style="background:${kleurVan(beste)}"><span>${n}</span></div>`,
        className: 'marker-cluster',
        iconSize: L.point(grootte, grootte),
      });
    },
  });
  kaart.addLayer(clusters);

  kaart.on('moveend', () => { if (filters.inBeeld) tekenLijst(); });
  kaart.on('popupclose', () => { zetGekozen(null, false); });
}

/** Eén cijfer of tijdstip met een icoontje en een bijschrift eronder. */
function feitHtml(icoon, waarde, label) {
  return `<div class="feit"><span class="feit-icoon" aria-hidden="true">${icoon}</span>
    <b>${ontsnap(waarde)}</b><span>${ontsnap(label)}</span></div>`;
}

/* Korte codes voor de socials. Vijf volledige namen passen nooit naast de
   soort-tag, twee letters wel — en dat blijft eerlijker dan nagetekende
   merklogo's. De volledige naam staat in de tooltip en voor schermlezers. */
const SOCIAL_CODE = {
  instagram: 'IG',
  facebook: 'FB',
  tiktok: 'TT',
  whatsapp: 'WA',
  youtube: 'YT',
  twitter: 'X',
  x: 'X',
  discord: 'DC',
  linktree: 'LT',
};

const socialCode = (platform) =>
  SOCIAL_CODE[platform] ?? platform.slice(0, 2).toUpperCase();

/** Een ja/nee-voorziening. Niets bekend? Dan laten we hem weg. */
function voorzieningHtml(aan, label) {
  if (aan === null || aan === undefined) return '';
  return `<span class="voorziening${aan ? '' : ' is-niet'}">
    <span class="vink" aria-hidden="true">${aan ? '✓' : '✕'}</span>${ontsnap(label)}</span>`;
}

function popupHtml(e) {
  const dagen = dagenTot(e.datum);
  const kleur = kleurVan(niveauVan(e));
  const d = details?.events?.[e.id];
  const org = details?.organisatoren?.[`${e.naam}|${e.stad}`];
  const km = afstandTot(e);

  const afbeelding = e.afbeelding ?? d?.afbeelding ?? null;

  // Soort, VIP-tijd en de socials staan bij elkaar in één rij labels onder
  // de plaatsnaam — allemaal korte etiketten die bij het evenement horen.
  const meta = [];
  if (e.type) meta.push(`<button type="button" class="pil pil-tag" data-tag="${ontsnap(e.type)}">${ontsnap(e.type)}</button>`);
  if (e.viptijd) meta.push(`<span class="pil tijd">VIP vanaf ${ontsnap(e.viptijd)}</span>`);
  if (e.geannuleerd) meta.push('<span class="pil pil-af">Geannuleerd</span>');

  // De socials zitten in een eigen groepje dat intern niet afbreekt, zodat
  // ze altijd netjes op één regel bij elkaar blijven staan.
  if (org?.socials?.length) {
    const knopjes = org.socials
      .map((s) => `<a class="pil social" href="${ontsnap(s.url)}" target="_blank" rel="noopener noreferrer nofollow"
        title="${ontsnap(s.platform)}"><span class="vb">${ontsnap(s.platform)}</span><span aria-hidden="true">${ontsnap(socialCode(s.platform))}</span></a>`)
      .join('');
    meta.push(`<span class="pop-socials">${knopjes}</span>`);
  }

  // Cijfers en tijdstippen in een raster, ja/nee-zaken eronder als vinkjes.
  // Dat scheelt ruimte en leest sneller dan zes blokjes met "Ja" erin.
  const feiten = [];
  if (e.tijd) feiten.push(feitHtml('🕐', e.tijd, 'Begintijd'));
  if (d?.eindtijd) feiten.push(feitHtml('🕓', d.eindtijd, 'Eindtijd'));
  if (d?.edities) feiten.push(feitHtml('📅', String(d.edities), 'Edities'));

  const voorzieningen = [
    voorzieningHtml(d?.tickets, 'Tickets'),
    voorzieningHtml(d?.eten, 'Eten & drinken'),
    voorzieningHtml(d?.parkeren, 'Gratis parkeren'),
  ].filter(Boolean).join('');

  // Alle knoppen op één regel, die afbreekt als er geen ruimte meer is.
  const knoppen = [
    `<a class="pop-knop pop-knop-hoofd" href="${ontsnap(e.url)}" target="_blank" rel="noopener noreferrer">Pokeradar</a>`,
  ];
  if (org?.website) {
    knoppen.push(`<a class="pop-knop pop-knop-zacht" href="${ontsnap(org.website)}" target="_blank" rel="noopener noreferrer nofollow">Website</a>`);
  }
  if (mijnLocatie) {
    const bestemming = encodeURIComponent(`${e.zaal ? e.zaal + ', ' : ''}${e.stad}`);
    knoppen.push(`<a class="pop-knop pop-knop-zacht" target="_blank" rel="noopener noreferrer"
      href="https://www.google.com/maps/dir/?api=1&amp;origin=${mijnLocatie.lat},${mijnLocatie.lon}&amp;destination=${bestemming}">Navigeren</a>`);
  }

  // Meteen de schatting tonen; de echte rijtijd schuift er overheen zodra
  // die binnen is (zie de popupopen-afhandeling bij de speld).
  const reis = mijnLocatie
    ? `<p class="pop-reis" data-reis="${ontsnap(e.id)}">
         <span class="pop-reis-icoon" aria-hidden="true">🚗</span>
         <span class="pop-reis-tekst">${reisTekst(reistijden.get(`${mijnLocatie.lat},${mijnLocatie.lon}->${e.lat},${e.lon}`) ?? schatReistijd(km))}</span>
       </p>`
    : '';

  return `
    <div class="pop" style="--kleur:${kleur}">
      ${afbeelding ? `<div class="pop-beeld"><img src="${ontsnap(afbeelding)}?w=640" alt=""></div>` : ''}

      <div class="pop-kop">
        <div class="pop-datum">${ontsnap(datumLabel(e.datum))}<span class="pop-wanneer">${ontsnap(relatief(dagen))}</span></div>
        <h2 class="pop-naam">${ontsnap(e.naam)}</h2>
        <div class="pop-plaats">
          <span class="pop-stad">${ontsnap(e.stad)}</span>
          ${e.zaal ? `<span class="pop-zaal">${ontsnap(e.zaal)}</span>` : ''}
        </div>
        ${meta.length ? `<div class="pop-meta">${meta.join('')}</div>` : ''}
      </div>

      ${feiten.length ? `<div class="pop-feiten">${feiten.join('')}</div>` : ''}
      ${voorzieningen ? `<div class="pop-voorzieningen">${voorzieningen}</div>` : ''}
      ${d?.beschrijving ? `<details class="pop-tekst"><summary>Beschrijving</summary><div>${ontsnap(d.beschrijving).replace(/\n+/g, '<br>')}</div></details>` : ''}

      <div class="pop-acties">
        ${reis}
        <div class="pop-knoppen">${knoppen.join('')}</div>
      </div>

      ${e.precisie === 'city' ? '<p class="pop-bron">Speld staat op het centrum van de plaats</p>' : ''}
    </div>`;
}

function maakSpeld(e) {
  const niveau = niveauVan(e);
  const marker = L.marker([e.lat, e.lon], {
    niveau,
    icon: L.divIcon({
      className: 'speld-wrap',
      html: `<div class="speld${e.geannuleerd ? ' speld-af' : ''}" style="--kleur:${kleurVan(niveau)}"></div>`,
      iconSize: [15, 15],
      iconAnchor: [7.5, 7.5],
    }),
    title: `${e.naam} — ${e.stad}`,
  });
  marker.bindPopup(() => popupHtml(e), { maxWidth: 270, minWidth: 246, autoPanPadding: [24, 24] });
  marker.on('popupopen', async (ev) => {
    zetGekozen(e.id, true);
    const el = ev.popup.getElement();

    // Laadt de afbeelding niet, dan de hele balk weghalen: liever geen beeld
    // dan een grijze strook bovenaan het kaartje.
    const img = el?.querySelector('.pop-beeld img');
    img?.addEventListener('error', () => img.closest('.pop-beeld')?.remove(), { once: true });

    // De echte rijtijd opvragen en over de schatting heen zetten. Lukt het
    // niet, dan blijft de schatting staan.
    const regel = el?.querySelector(`.pop-reis[data-reis="${CSS.escape(e.id)}"] .pop-reis-tekst`);
    if (!regel) return;
    const echt = await haalReistijd(e);
    // Ondertussen kan de popup alweer gesloten of vervangen zijn.
    if (echt && regel.isConnected) {
      regel.innerHTML = reisTekst(echt);
      regel.closest('.pop-reis')?.classList.add('is-echt');
    }
  });
  return marker;
}

/* ---------- filteren ---------- */

function pasFiltersToe() {
  const weekend = komendWeekend();
  const zoek = filters.zoek.trim().toLowerCase();

  zichtbaar = alleEvents.filter((e) => {
    if (e.lat === null) return false;
    if (!filters.toonGeannuleerd && e.geannuleerd) return false;
    if (e.land && !filters.landen.has(e.land)) return false;
    if (filters.type && e.type !== filters.type) return false;

    const dagen = dagenTot(e.datum);
    // Bij een eigen datumbereik mag je ook terugkijken; anders tonen we
    // alleen wat nog komt.
    if (filters.periode !== 'eigen' && dagen < 0) return false;
    if (filters.periode === '7' && dagen > 7) return false;
    if (filters.periode === '30' && dagen > 30) return false;
    if (filters.periode === 'weekend') {
      const d = naarDatum(e.datum);
      if (d < weekend.van || d > weekend.tot) return false;
    }
    if (filters.periode === 'eigen') {
      if (filters.van && e.datum < filters.van) return false;
      if (filters.tot && e.datum > filters.tot) return false;
    }

    if (filters.straal) {
      const km = afstandTot(e);
      if (km === null || km > filters.straal) return false;
    }

    if (zoek) {
      const hooi = `${e.naam} ${e.stad} ${e.zaal ?? ''} ${e.type ?? ''}`.toLowerCase();
      if (!hooi.includes(zoek)) return false;
    }
    return true;
  });

  if (sorteerOpAfstand && mijnLocatie) {
    zichtbaar.sort((a, b) => (afstandTot(a) ?? Infinity) - (afstandTot(b) ?? Infinity));
  } else {
    zichtbaar.sort((a, b) => a.datum.localeCompare(b.datum) || (a.tijd ?? '').localeCompare(b.tijd ?? ''));
  }
}

/* ---------- tekenen ---------- */

function tekenSpelden() {
  clusters.clearLayers();
  spelden.clear();
  const laag = zichtbaar.map((e) => {
    const m = maakSpeld(e);
    spelden.set(e.id, m);
    return m;
  });
  clusters.addLayers(laag);
}

function tekenLijst() {
  const lijst = $('#lijst');
  let rijen = zichtbaar;

  if (filters.inBeeld && kaart) {
    const kader = kaart.getBounds();
    rijen = rijen.filter((e) => kader.contains([e.lat, e.lon]));
  }

  $('#mobielTelling').textContent = rijen.length ? `(${rijen.length})` : '';

  if (!rijen.length) {
    lijst.innerHTML = `<div class="leeg"><b>Niks gevonden</b>Probeer een langere periode, of zet een filter uit.</div>`;
    return;
  }

  /** Eén rij in de lijst. `metDatum` zet de datum in de rij zelf, voor als
      er niet per dag gegroepeerd wordt. */
  const kaartjeHtml = (e, dagen, metDatum = false) => {
    const niveau = niveauVan(e);
    const d = details?.events?.[e.id];
    const km = afstandTot(e);

    const meta = [];
    if (e.tijd) {
      const tot = d?.eindtijd ? `–${d.eindtijd}` : '';
      meta.push(`<span class="pil tijd">${ontsnap(e.tijd + tot)}</span>`);
    }
    // Het type is een knop: erop klikken filtert er meteen op.
    if (e.type) {
      const aan = filters.type === e.type;
      meta.push(`<button type="button" class="pil pil-tag${aan ? ' is-actief' : ''}" data-tag="${ontsnap(e.type)}"
        title="${aan ? 'Filter op dit soort uitzetten' : `Alleen ${ontsnap(e.type)} tonen`}">${ontsnap(e.type)}</button>`);
    }
    if (e.geannuleerd) meta.push('<span class="pil pil-af">Geannuleerd</span>');
    if (d) {
      if (d.tickets) meta.push('<span class="pil pil-icoon" title="Tickets beschikbaar">🎟️</span>');
      if (d.eten) meta.push('<span class="pil pil-icoon" title="Eten &amp; drinken aanwezig">🍟</span>');
      if (d.parkeren) meta.push('<span class="pil pil-icoon" title="Gratis parkeren">🅿️</span>');
    }

    return `
      <article class="kaartje${e.geannuleerd ? ' is-af' : ''}${e.id === gekozenId ? ' is-gekozen' : ''}"
               style="--kleur:${kleurVan(niveau)}" data-id="${ontsnap(e.id)}" tabindex="0" role="button">
        <div class="kaartje-lijf">
          ${metDatum ? `<div class="kaartje-datum">${ontsnap(datumLabel(e.datum))}</div>` : ''}
          <p class="kaartje-naam">${ontsnap(e.naam)}</p>
          <div class="kaartje-plaats"><b>${ontsnap(e.stad)}</b>${e.zaal ? ` · ${ontsnap(e.zaal)}` : ''}</div>
          ${meta.length ? `<div class="kaartje-meta">${meta.join('')}</div>` : ''}
        </div>
        ${km !== null ? `<span class="kaartje-afstand">${ontsnap(toonAfstand(km))}</span>` : ''}
      </article>`;
  };

  const stukken = [];

  if (sorteerOpAfstand && mijnLocatie) {
    // Op afstand gesorteerd is groeperen per dag zinloos; dan zet de datum
    // bij elke rij zelf.
    stukken.push('<div class="datumkop"><span>Dichtstbij eerst</span><span class="relatief">vanaf jouw locatie</span></div>');
    for (const e of rijen) stukken.push(kaartjeHtml(e, dagenTot(e.datum), true));
  } else {
    const perDag = new Map();
    for (const e of rijen) {
      if (!perDag.has(e.datum)) perDag.set(e.datum, []);
      perDag.get(e.datum).push(e);
    }
    for (const [datum, groep] of perDag) {
      const dagen = dagenTot(datum);
      stukken.push(
        `<div class="datumkop"><span>${ontsnap(datumLabel(datum))}</span><span class="relatief">${ontsnap(relatief(dagen))}</span></div>`,
      );
      for (const e of groep) stukken.push(kaartjeHtml(e, dagen));
    }
  }

  lijst.innerHTML = stukken.join('');
}

/**
 * Bouwt de legenda op bij de gekozen kleurmodus. Bij kleur-op-soort tonen we
 * alleen de soorten die daadwerkelijk in de data voorkomen, met hoeveel het
 * er zijn — dan zie je meteen dat het grootste deel gewoon "Beurs" is.
 */
function tekenLegenda() {
  const el = $('#legenda');
  if (kleurModus === 'datum') {
    el.innerHTML = [
      ['vandaag', 'vandaag'],
      ['week', '≤&nbsp;7&nbsp;dgn'],
      ['maand', '≤&nbsp;30&nbsp;dgn'],
      ['later', 'later'],
    ]
      .map(([n, label]) => `<span class="legenda-item"><i class="stip" style="background:${kleurVan(n)}"></i>${label}</span>`)
      .join('');
    return;
  }

  const telling = new Map();
  for (const e of alleEvents) {
    if (!e.type) continue;
    telling.set(e.type, (telling.get(e.type) ?? 0) + 1);
  }
  el.innerHTML = [...telling.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => {
      const aan = filters.type === type;
      return `<button type="button" class="legenda-item legenda-knop${aan ? ' is-actief' : ''}" data-tag="${ontsnap(type)}">
        <i class="stip" style="background:${kleurVan(`soort-${SOORT_SLOT[type] ?? 0}`)}"></i>${ontsnap(type)} <span class="legenda-n">${n}</span>
      </button>`;
    })
    .join('');
}

function tekenTeller() {
  const n = zichtbaar.length;
  const woord = n === 1 ? 'beurs' : 'beurzen';
  $('#teller').innerHTML = `<b>${n}</b> ${woord}`;
}

function tekenAlles() {
  pasFiltersToe();
  tekenSpelden();
  tekenLijst();
  tekenTeller();
  tekenLegenda();
}

/**
 * Zet het beeld om de zichtbare spelden heen. Wordt aangeroepen na een
 * filterwissel: wie op "dit weekend" klikt wil zien wáár die beurzen zijn,
 * niet blijven hangen op de plek waar hij toevallig stond.
 */
function herstelBeeld() {
  if (!zichtbaar.length) return;
  kaart.flyToBounds(L.latLngBounds(zichtbaar.map((e) => [e.lat, e.lon])).pad(0.12), {
    maxZoom: 11,
    duration: 0.45,
  });
}

/**
 * Een uitklaplijst die niet op "alles" staat is een actief filter. Dat mag
 * je kunnen zien zonder de lijst open te klappen, want anders zoek je je
 * scheel naar waarom er zo weinig beurzen staan.
 */
function merkActieveFilters() {
  $('#type').classList.toggle('is-gefilterd', !!filters.type);
  $('#straal').classList.toggle('is-gefilterd', !!filters.straal);
}

/** Filter gewijzigd: opnieuw tekenen en het beeld erop zetten. */
function naFilter() {
  tekenAlles();
  merkActieveFilters();
  herstelBeeld();
}

/* ---------- selectie ---------- */

function zetGekozen(id, vanuitKaart) {
  gekozenId = id;
  for (const el of document.querySelectorAll('.kaartje')) {
    el.classList.toggle('is-gekozen', el.dataset.id === id);
  }
  if (id && vanuitKaart) {
    const rij = document.querySelector(`.kaartje[data-id="${CSS.escape(id)}"]`);
    rij?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function springNaar(id) {
  const marker = spelden.get(id);
  if (!marker) return;
  zetGekozen(id, false);
  if (window.matchMedia('(max-width: 860px)').matches) zetWeergave('kaart');
  // Even wachten zodat de kaart zijn nieuwe afmeting kent na een weergavewissel.
  requestAnimationFrame(() => {
    kaart.invalidateSize();
    clusters.zoomToShowLayer(marker, () => marker.openPopup());
  });
}

/* ---------- mijn locatie ---------- */

/* Nominatim, dezelfde dienst die de beurslocaties omzet. Eén verzoek per
   keer dat je je plaats intypt of je positie laat bepalen — ruim binnen wat
   die dienst toestaat. */
const NOMINATIM = 'https://nominatim.openstreetmap.org';

/** Zoekt de coördinaten bij een ingetypte plaats of postcode. */
async function zoekPlaats(tekst) {
  const url = new URL(`${NOMINATIM}/search`);
  url.searchParams.set('q', tekst);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'nl,be');
  url.searchParams.set('addressdetails', '1');
  const res = await fetch(url, { headers: { 'Accept-Language': 'nl' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const [treffer] = await res.json();
  if (!treffer) throw new Error('niets gevonden');
  return { lat: Number(treffer.lat), lon: Number(treffer.lon), naam: korteNaam(treffer.address, treffer.display_name) };
}

/** Zoekt de plaatsnaam bij coördinaten, zodat je kunt zien of het klopt. */
async function benoemLocatie(lat, lon) {
  const url = new URL(`${NOMINATIM}/reverse`);
  url.searchParams.set('lat', lat);
  url.searchParams.set('lon', lon);
  url.searchParams.set('format', 'json');
  url.searchParams.set('zoom', '13');
  const res = await fetch(url, { headers: { 'Accept-Language': 'nl' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const body = await res.json();
  return korteNaam(body.address, body.display_name);
}

/** "Utrecht" in plaats van de hele adresregel. */
function korteNaam(adres, volledig) {
  const plaats = adres?.city ?? adres?.town ?? adres?.village ?? adres?.municipality ?? adres?.suburb ?? adres?.county;
  return plaats ?? volledig?.split(',')[0] ?? null;
}

/**
 * Zet de regel onder "Jouw locatie": waar hij denkt dat je bent, en hoe
 * grof die schatting is. Een browser zonder GPS gokt op je IP-adres of
 * wifi-netwerk, en dat kan er kilometers naast zitten — dan moet je dat
 * kunnen zien in plaats van je af te vragen waarom de afstanden raar zijn.
 */
function toonLocatieUitleg(tekst, waarschuwing = false) {
  const el = $('#locatieUitleg');
  el.hidden = !tekst;
  el.textContent = tekst ?? '';
  el.classList.toggle('is-waarschuwing', waarschuwing);
}

/**
 * Zet de eigen locatie en werkt de bediening bij. De coördinaten blijven
 * op dit apparaat: ze gaan alleen naar localStorage, zodat je na een
 * herlaadbeurt niet opnieuw toestemming hoeft te geven.
 */
function zetLocatie(lat, lon, { bewaren = true, naam = null, nauwkeurigheid = null, handmatig = false } = {}) {
  mijnLocatie = { lat, lon, naam, handmatig };
  if (bewaren) {
    try { localStorage.setItem('kaartjeskaart-locatie', JSON.stringify(mijnLocatie)); } catch { /* privémodus */ }
  }
  // Rijtijden gelden vanaf een vertrekpunt; verschuift dat, dan kloppen de
  // onthouden antwoorden niet meer.
  reistijden.clear();

  if (naam) {
    toonLocatieUitleg(handmatig ? `Ingesteld op ${naam}.` : `Gevonden: ${naam}.`);
  } else {
    // Nog geen naam bekend: die zoeken we erbij, zodat je kunt controleren
    // of het klopt.
    toonLocatieUitleg('Locatie bepalen…');
    benoemLocatie(lat, lon)
      .then((gevonden) => {
        if (!mijnLocatie || mijnLocatie.lat !== lat) return; // ondertussen veranderd
        mijnLocatie.naam = gevonden;
        const grof = nauwkeurigheid && nauwkeurigheid > 2000;
        toonLocatieUitleg(
          grof
            ? `Gevonden: ${gevonden}, maar op zo'n ${Math.round(nauwkeurigheid / 1000)} km nauwkeurig. Klopt dat niet, typ dan je plaats hierboven.`
            : `Gevonden: ${gevonden}. Klopt dat niet, typ dan je plaats hierboven.`,
          grof,
        );
      })
      .catch(() => toonLocatieUitleg('Klopt de locatie niet? Typ hierboven je plaats.'));
  }

  if (mijnSpeld) mijnSpeld.remove();
  mijnSpeld = L.marker([lat, lon], {
    icon: L.divIcon({ className: 'ik-wrap', html: '<div class="ik"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
    zIndexOffset: 1000,
    keyboard: false,
    title: 'Jouw locatie',
  }).addTo(kaart).bindPopup('Jouw locatie');

  const knop = $('#locatieKnop');
  knop.classList.remove('is-bezig', 'is-mis');
  knop.classList.add('is-actief');
  knop.title = 'Locatie staat aan — klik om uit te zetten';
  $('#locatieLabel').textContent = 'Locatie staat aan';
  $('#straalRij').hidden = false;
  $('#sorteerRij').hidden = false;
}

function vraagLocatie() {
  if (mijnLocatie) {
    // Nog eens klikken zet hem weer uit.
    mijnLocatie = null;
    sorteerOpAfstand = false;
    filters.straal = null;
    mijnSpeld?.remove();
    mijnSpeld = null;
    try { localStorage.removeItem('kaartjeskaart-locatie'); } catch { /* privémodus */ }
    const knop = $('#locatieKnop');
    knop.classList.remove('is-actief', 'is-bezig', 'is-mis');
    knop.title = 'Mijn locatie gebruiken';
    $('#locatieLabel').textContent = 'Mijn locatie';
    $('#straalRij').hidden = true;
    $('#straal').value = '';
    $('#sorteerRij').hidden = true;
    $('#sorteerKnop').checked = false;
    reistijden.clear();
    toonLocatieUitleg(null);
    naFilter();
    return;
  }

  haalPositie({ verplaatsKaart: true });
}

/**
 * Vraagt de browser om de huidige positie.
 *
 * @param {object} opties
 * @param {boolean} opties.verplaatsKaart - naar de locatie toe vliegen
 * @param {boolean} opties.stil - geen foutmelding tonen als het misgaat
 *   (voor de poging bij het opstarten: die mag niet met rode randjes komen
 *   als er toevallig geen toestemming is)
 */
function haalPositie({ verplaatsKaart = false, stil = false } = {}) {
  const knop = $('#locatieKnop');
  const meldFout = (tekst) => {
    knop.classList.remove('is-bezig');
    if (stil) return;
    knop.classList.add('is-mis');
    knop.title = tekst;
    $('#locatieLabel').textContent = tekst;
    setTimeout(() => {
      knop.classList.remove('is-mis');
      knop.title = 'Mijn locatie gebruiken';
      $('#locatieLabel').textContent = 'Mijn locatie';
    }, 4000);
  };

  if (!navigator.geolocation) {
    meldFout('Deze browser kent je locatie niet');
    return;
  }
  knop.classList.add('is-bezig');
  if (!stil) knop.title = 'Locatie zoeken…';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      zetLocatie(latitude, longitude, { nauwkeurigheid: accuracy });
      tekenAlles();
      if (verplaatsKaart) kaart.flyTo([latitude, longitude], 9, { duration: 0.6 });
    },
    (err) => meldFout(err.code === err.PERMISSION_DENIED ? 'Toegang geweigerd' : 'Locatie niet gevonden'),
    // Wel om de beste bron vragen: op een telefoon levert dat GPS op in
    // plaats van een gok op basis van het wifi-netwerk. En geen oud antwoord
    // hergebruiken, want dat is juist vaak de slechte schatting.
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
  );
}

/**
 * Regelt de locatie bij het openen van de pagina.
 *
 * Eerst een eerder onthouden locatie terugzetten, zodat afstanden er meteen
 * staan zonder dat er iets gevraagd wordt. Daarna kijken hoe het met de
 * toestemming staat:
 *
 *  - al gegeven: de positie stil verversen, want je kunt verhuisd zijn;
 *  - nog niet gevraagd: één keer vragen, maar pas nadat de kaart er staat.
 *    Een venster dat voor een lege pagina verschijnt wordt reflexmatig
 *    weggeklikt;
 *  - geweigerd: met rust laten. De speldknop blijft staan voor wie het
 *    later alsnog wil.
 */
async function regelLocatieBijOpstart() {
  let handmatigGezet = false;
  try {
    const bewaard = JSON.parse(localStorage.getItem('kaartjeskaart-locatie') ?? 'null');
    if (bewaard?.lat && bewaard?.lon) {
      handmatigGezet = !!bewaard.handmatig;
      zetLocatie(bewaard.lat, bewaard.lon, {
        bewaren: false,
        naam: bewaard.naam ?? null,
        handmatig: handmatigGezet,
      });
      tekenAlles(); // afstanden meteen in de lijst
    }
  } catch { /* privémodus of rommel in de opslag */ }

  // Heb je je plaats zelf ingetypt, dan is dat een bewuste keuze. Die gaan
  // we niet overschrijven met de gok van de browser.
  if (handmatigGezet) return;

  // Niet elke browser kent de Permissions API; dan vragen we het gewoon,
  // tenzij we al een locatie hebben.
  let toestand = null;
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' });
    toestand = status?.state ?? null;
    // Geeft iemand later alsnog toestemming in de browserinstellingen, dan
    // pikken we dat meteen op.
    if (status) {
      status.addEventListener('change', () => {
        if (status.state === 'granted' && !mijnLocatie) haalPositie({ stil: true });
      });
    }
  } catch { /* niet ondersteund */ }

  if (toestand === 'denied') return;
  if (toestand === 'granted') { haalPositie({ stil: true }); return; }

  // Toestand 'prompt' of onbekend: alleen vragen als we nog niets hebben.
  if (!mijnLocatie) {
    setTimeout(() => haalPositie({ stil: true, verplaatsKaart: true }), 800);
  }
}

/* ---------- mobiele weergave ---------- */

function zetWeergave(welke) {
  document.body.dataset.weergave = welke;
  for (const b of document.querySelectorAll('.mobielknop')) {
    b.classList.toggle('is-actief', b.dataset.weergave === welke);
  }
  if (welke === 'kaart' && kaart) requestAnimationFrame(() => kaart.invalidateSize());
}

/* ---------- opstarten ---------- */

function koppelBediening() {
  for (const knop of document.querySelectorAll('[data-periode]')) {
    knop.addEventListener('click', () => {
      filters.periode = knop.dataset.periode;
      for (const k of document.querySelectorAll('[data-periode]')) k.classList.toggle('is-actief', k === knop);

      const eigen = filters.periode === 'eigen';
      $('#datumrij').hidden = !eigen;
      knop.setAttribute('aria-expanded', String(eigen));
      // Bij de eerste keer openen meteen een zinnig bereik voorstellen:
      // vandaag tot drie maanden vooruit.
      if (eigen && !filters.van && !filters.tot) {
        const vandaag = vandaagOm0();
        const over3m = new Date(vandaag);
        over3m.setMonth(over3m.getMonth() + 3);
        const alsTekst = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        filters.van = $('#datumVan').value = alsTekst(vandaag);
        filters.tot = $('#datumTot').value = alsTekst(over3m);
      }
      naFilter();
    });
  }

  for (const veld of ['datumVan', 'datumTot']) {
    $(`#${veld}`).addEventListener('change', (ev) => {
      filters[veld === 'datumVan' ? 'van' : 'tot'] = ev.target.value || null;
      if (filters.periode !== 'eigen') {
        document.querySelector('[data-periode="eigen"]').click();
      } else {
        naFilter();
      }
    });
  }

  for (const knop of document.querySelectorAll('[data-kleur]')) {
    knop.addEventListener('click', () => {
      kleurModus = knop.dataset.kleur;
      for (const k of document.querySelectorAll('[data-kleur]')) k.classList.toggle('is-actief', k === knop);
      try { localStorage.setItem('kaartjeskaart-kleur', kleurModus); } catch { /* privémodus */ }
      tekenAlles();
    });
  }

  // De weergave-instellingen zijn dingen die je één keer zet, dus die staan
  // ingeklapt onder deze knop.
  $('#meerKnop').addEventListener('click', (ev) => {
    const open = $('#instellingen').hidden;
    $('#instellingen').hidden = !open;
    ev.currentTarget.classList.toggle('is-actief', open);
    ev.currentTarget.setAttribute('aria-expanded', String(open));
    requestAnimationFrame(() => kaart.invalidateSize());
  });

  $('#locatieKnop').addEventListener('click', vraagLocatie);

  /** Een ingetypte plaats of postcode als vertrekpunt gebruiken. */
  async function gebruikIngetypt() {
    const tekst = $('#plaatsInvoer').value.trim();
    if (!tekst) return;
    toonLocatieUitleg('Zoeken…');
    try {
      const { lat, lon, naam } = await zoekPlaats(tekst);
      zetLocatie(lat, lon, { naam, handmatig: true });
      $('#plaatsInvoer').value = '';
      tekenAlles();
      kaart.flyTo([lat, lon], 9, { duration: 0.6 });
    } catch {
      toonLocatieUitleg(`Geen plaats gevonden voor "${tekst}".`, true);
    }
  }

  $('#plaatsZoek').addEventListener('click', gebruikIngetypt);
  $('#plaatsInvoer').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); gebruikIngetypt(); }
  });

  $('#straal').addEventListener('change', (ev) => {
    filters.straal = ev.target.value ? Number(ev.target.value) : null;
    naFilter();
  });

  $('#sorteerKnop').addEventListener('change', (ev) => {
    sorteerOpAfstand = ev.target.checked;
    tekenAlles();
  });

  for (const knop of document.querySelectorAll('[data-land]')) {
    knop.addEventListener('click', () => {
      const land = knop.dataset.land;
      if (filters.landen.has(land)) {
        if (filters.landen.size === 1) return; // laatste land laten staan
        filters.landen.delete(land);
      } else {
        filters.landen.add(land);
      }
      knop.classList.toggle('is-actief', filters.landen.has(land));
      naFilter();
    });
  }

  let tik;
  $('#zoek').addEventListener('input', (ev) => {
    clearTimeout(tik);
    tik = setTimeout(() => { filters.zoek = ev.target.value; naFilter(); }, 140);
  });

  $('#type').addEventListener('change', (ev) => { filters.type = ev.target.value; naFilter(); });
  $('#inBeeld').addEventListener('change', (ev) => { filters.inBeeld = ev.target.checked; tekenLijst(); });
  $('#toonGeannuleerd').addEventListener('change', (ev) => { filters.toonGeannuleerd = ev.target.checked; naFilter(); });

  $('#themaknop').addEventListener('click', () => {
    pasThemaToe(document.documentElement.dataset.thema === 'licht' ? 'donker' : 'licht');
  });

  for (const b of document.querySelectorAll('.mobielknop')) {
    b.addEventListener('click', () => zetWeergave(b.dataset.weergave));
  }

  /** Op een typetag klikken filtert erop; nog eens klikken zet hem uit. */
  function wisselTag(tag) {
    filters.type = filters.type === tag ? '' : tag;
    $('#type').value = filters.type;
    naFilter();
  }

  // Tags staan in de lijst, in de popups op de kaart en in de legenda, dus
  // vangen we ze op documentniveau af — vóór de klik op het kaartje zelf.
  document.addEventListener('click', (ev) => {
    const tag = ev.target.closest('[data-tag]');
    if (!tag) return;
    ev.preventDefault();
    ev.stopPropagation();
    wisselTag(tag.dataset.tag);
  }, true);

  const lijst = $('#lijst');
  lijst.addEventListener('click', (ev) => {
    if (ev.target.closest('.pil-tag')) return;
    const kaartje = ev.target.closest('.kaartje');
    if (kaartje) springNaar(kaartje.dataset.id);
  });
  lijst.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const kaartje = ev.target.closest('.kaartje');
    if (kaartje) { ev.preventDefault(); springNaar(kaartje.dataset.id); }
  });
}

async function start() {
  document.documentElement.dataset.thema = beginThema();
  ververKleuren();
  try {
    const bewaard = localStorage.getItem('kaartjeskaart-kleur');
    if (bewaard === 'datum' || bewaard === 'soort') kleurModus = bewaard;
  } catch { /* privémodus */ }
  for (const k of document.querySelectorAll('[data-kleur]')) {
    k.classList.toggle('is-actief', k.dataset.kleur === kleurModus);
  }
  maakKaart();
  koppelBediening();

  let data;
  try {
    const res = await fetch(`events.json?v=${Date.now()}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    $('#lijst').innerHTML =
      `<div class="leeg"><b>De gegevens zijn niet geladen</b>${ontsnap(err.message)}<br>Probeer de pagina te verversen.</div>`;
    $('#teller').textContent = 'fout';
    return;
  }

  alleEvents = data.events ?? [];

  // Soorten vullen met wat er daadwerkelijk in de data zit.
  const soorten = [...new Set(alleEvents.map((e) => e.type).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'nl'));
  $('#type').append(...soorten.map((t) => new Option(t, t)));

  if (data.bijgewerkt) {
    const d = new Date(data.bijgewerkt);
    const versWeg = Math.round((Date.now() - d) / DAG_MS);
    const stempel = `bijgewerkt ${d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}`;
    $('#bijgewerkt').textContent = versWeg > 3 ? `${stempel} (${versWeg} dagen geleden)` : stempel;
    $('#bijgewerkt').style.color = versWeg > 3 ? 'var(--week)' : '';
  }

  tekenAlles();

  // Beeld op de gefilterde spelden zetten, maar niet te ver inzoomen.
  if (zichtbaar.length) {
    kaart.fitBounds(L.latLngBounds(zichtbaar.map((e) => [e.lat, e.lon])).pad(0.12), { maxZoom: 11 });
  }

  regelLocatieBijOpstart();

  // De extra gegevens (eindtijd, tickets, website, socials) zijn een stuk
  // groter en niet nodig om de kaart te tonen. Die halen we er daarom pas
  // achteraf bij; tot die tijd werkt alles gewoon, alleen met minder detail.
  try {
    const res = await fetch(`details.json?v=${encodeURIComponent(data.bijgewerkt ?? '')}`);
    if (res.ok) {
      details = await res.json();
      tekenLijst();
      // Een open popup opnieuw opbouwen, zodat de nieuwe gegevens er meteen in staan.
      if (gekozenId) spelden.get(gekozenId)?.getPopup()?.update();
    }
  } catch { /* geen details is geen ramp */ }
}

start();
