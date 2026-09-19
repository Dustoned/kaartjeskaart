/* Kaartjeskaart — beurzen uit events.json op een kaart en in een lijst. */
'use strict';

/* Esri's Gray Canvas: rustig, werkt zonder sleutel, en er is een donkere
   én een lichte variant. Let op de volgorde {z}/{y}/{x} — Esri zet de rij
   vóór de kolom, andersom dan de meeste tegelservers. */
const TEGELS = {
  donker: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  licht: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
};
const TEGEL_MAXZOOM = 16;

/* Vanaf dit zoomniveau clustert er niets meer: elke speld staat er los op
   de kaart. Zowel de clusterlaag als het springen naar een beurs rekenen
   daarmee, dus staat het getal hier één keer. */
const LOSSE_SPELDEN_ZOOM = 13;

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
let lijstIsVerouderd = false; // lijst overgeslagen omdat hij niet in beeld stond
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

/**
 * De regel met rijtijd en afstand. De tijd staat er groter en in de gewone
 * tekstkleur bij: dat is waar je op afgaat als je besluit of je gaat. De
 * afstand blijft ingetogen. "over de weg" is eraf — dat spreekt vanzelf
 * zodra er een rijtijd naast staat.
 */
function reisTekst({ minuten, km, geschat }) {
  return `<b>${geschat ? '±&nbsp;' : ''}${toonDuur(minuten)}</b> rijden <span class="reis-scheiding">·</span> ${toonAfstand(km)}`;
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
    /* De bronvermelding staat niet op de kaart maar in de voettekst van de
       lijst, naast de bron van de beursgegevens. Weglaten kan niet: die
       vermelding is de voorwaarde waaronder de tegels van Esri en de
       gegevens van OpenStreetMap vrij te gebruiken zijn. */
    attributionControl: false,
    // Verder uitzoomen dan 6 heeft geen zin voor een Benelux-kaart, en het
    // zorgt voor grijze banden boven en onder zodra de wereldkaart smaller
    // wordt dan het venster. De grenzen houden je bovendien in de buurt.
    minZoom: 6,
    maxBounds: L.latLngBounds([44.5, -11], [59.5, 21]),
    // Volledig stug in plaats van half: aan de rand stopt de kaart gewoon.
    // Een waarde ertussenin laat hem meeveren en terugspringen, en dat voelt
    // alsof het slepen hapert terwijl er niets hapert.
    maxBoundsViscosity: 1,
    worldCopyJump: false,

    /* Knijpzoomen schaalt tijdens het gebaar vloeiend mee en zakt bij het
       loslaten terug naar een heel zoomniveau.

       Dat laatste moet ook zo blijven. Met `zoomSnap: 0` bleef de kaart staan
       op 12,495 — en daar kan de clusterlaag niet tegen. Die bouwt één boom
       per heel zoomniveau en zoekt het huidige niveau op als sleutel; bij een
       gebroken getal komt daar niets uit. Het gevolg was dat alle spelden van
       de kaart verdwenen, met een handvol fouten in de console. Een gebaar dat
       precies uitloopt weegt daar niet tegenop.

       `bounceAtZoomLimits` uit: bij de grens stopt hij, in plaats van terug
       te stuiteren. */
    zoomSnap: 1,
    zoomDelta: 1,
    bounceAtZoomLimits: false,
    // Standaard is 60, waardoor één muiswielstapje al een heel niveau springt.
    wheelPxPerZoomLevel: 120,
  });

  const thema = document.documentElement.dataset.thema;
  tegellaag = L.tileLayer(TEGELS[thema === 'licht' ? 'licht' : 'donker'], {
    // Esri levert tot zoom 16; daarboven rekt Leaflet de laatste tegel op,
    // zodat je wel verder kunt inzoomen op een speld.
    maxNativeZoom: TEGEL_MAXZOOM,
    maxZoom: 18,
    noWrap: true,

    /* Deze drie bepalen hoe vlot de kaart aanvoelt.
       Leaflet zet `updateWhenIdle` op telefoons standaard aan: er worden dan
       pas tegels opgehaald als je je vinger optilt, dus sleep je het lege
       grijs in. Dat scheelt dataverkeer maar voelt traag terwijl de kaart
       zelf prima meebeweegt — vandaar uit.
       Met een ruimere buffer staan de tegels net buiten beeld al klaar, zodat
       je er niet meteen doorheen sleept.
       Tijdens het in- en uitzoomen juist niet bijwerken: dat haalt werk weg
       uit de animatie en laat hem vloeiender lopen. */
    updateWhenIdle: false,
    updateWhenZooming: false,
    keepBuffer: 4,
  }).addTo(kaart);

  clusters = L.markerClusterGroup({
    maxClusterRadius: 44,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    disableClusteringAtZoom: LOSSE_SPELDEN_ZOOM,
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

  kaart.on('moveend', () => { if (filters.inBeeld) lijstMisschienOpnieuw(); });
  kaart.on('resize', ververPopupHoogte);
  ververPopupHoogte();
  kaart.on('popupclose', () => { zetGekozen(null, false); });
}

/** Eén cijfer of tijdstip met een icoontje en een bijschrift eronder. */
function feitHtml(naam, tekst) {
  return `<span class="feit">${icoon(naam, 13)}${ontsnap(tekst)}</span>`;
}

/** "6 uur open", of "5,5 uur open" als het geen heel getal is. */
function duurTekst(van, tot) {
  const [vu, vm] = van.split(':').map(Number);
  const [tu, tm] = tot.split(':').map(Number);
  let minuten = (tu * 60 + tm) - (vu * 60 + vm);
  if (minuten <= 0) minuten += 24 * 60; // loopt door na middernacht
  const uren = minuten / 60;
  const netjes = Number.isInteger(uren) ? String(uren) : uren.toFixed(1).replace('.', ',');
  return `${netjes} uur open`;
}

/* Lijniconen uit Lucide, dezelfde set die shadcn gebruikt. Emoji leken
   handig maar verraden zich meteen: ze hebben elk hun eigen stijl, kleur en
   regelhoogte, en op Windows rendert de helft als een leeg blokje. Deze
   tekenen allemaal in dezelfde lijndikte mee met de tekstkleur. */
const ICONEN = {
  klok: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  kalender: '<path d="M8 2v3"/><path d="M16 2v3"/><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M8 13h.01"/><path d="M12 13h.01"/><path d="M16 13h.01"/><path d="M8 17h.01"/><path d="M12 17h.01"/><path d="M16 17h.01"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>',
  eten: '<path d="m16 2-2.3 2.3a3 3 0 0 0 0 4.2l1.8 1.8a3 3 0 0 0 4.2 0L22 8"/><path d="M15 15 3.3 3.3a4.2 4.2 0 0 0 0 6l7.3 7.3c.7.7 2 .7 2.8 0L15 15Zm0 0 7 7"/><path d="m2.1 21.8 6.4-6.3"/><path d="m19 5-7 7"/>',
  parkeren: '<circle cx="12" cy="12" r="10"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>',
  kraam: '<path d="M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5"/><path d="M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244"/><path d="M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05"/>',
  auto: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
  vink: '<path d="M20 6 9 17l-5-5"/>',
  pijlRechts: '<path d="m9 18 6-6-6-6"/>',
  extern: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  speld: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  kopieer: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
};

const icoon = (naam, grootte = 14) =>
  `<svg class="ic" width="${grootte}" height="${grootte}" viewBox="0 0 24 24" aria-hidden="true">${ICONEN[naam] ?? ''}</svg>`;

/* De echte merklogo's, uit Simple Icons — een vrije verzameling met de
   officiële vormen. Zelf natekenen gaat altijd net mis, maar dat hoeft ook
   niet. Het zijn gevulde vormen (geen lijnen zoals Lucide), dus ze krijgen
   hun eigen klasse. Ze blijven eenkleurig: de merkkleuren zouden er zes
   felle vlekjes van maken, en twee ervan zijn zwart. */
const MERK_LOGOS = {
  instagram: 'M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077',
  facebook: 'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z',
  tiktok: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z',
  whatsapp: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z',
  youtube: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  x: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z',
  discord: 'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z',
  linktree: 'm13.73635 5.85251 4.00467-4.11665 2.3248 2.3808-4.20064 4.00466h5.9085v3.30473h-5.9365l4.22865 4.10766-2.3248 2.3338L12.0005 12.099l-5.74052 5.76852-2.3248-2.3248 4.22864-4.10766h-5.9375V8.12132h5.9085L3.93417 4.11666l2.3248-2.3808 4.00468 4.11665V0h3.4727zm-3.4727 10.30614h3.4727V24h-3.4727z',
};
// De bron schrijft "twitter", het merk heet inmiddels X.
MERK_LOGOS.twitter = MERK_LOGOS.x;

/** Het logo van een platform, of niets als we het niet kennen. */
const merkLogo = (platform) => {
  const d = MERK_LOGOS[platform.toLowerCase().trim()];
  return d ? `<svg class="merk-ic" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>` : null;
};

/** Een ja/nee-voorziening. Niets bekend? Dan laten we hem weg. */
function voorzieningHtml(aan, label, naam) {
  if (aan === null || aan === undefined) return '';
  return `<span class="etiket${aan ? '' : ' is-niet'}">${icoon(naam, 12)}${ontsnap(label)}</span>`;
}

/**
 * Begrenst de hoogte van een beurskaartje op wat er in het kaartvlak past.
 *
 * Stond eerst op 70% van de vensterhoogte, maar de kaart is kleiner dan het
 * venster: er gaan een kop, een filterbalk en op een telefoon een knoppenbalk
 * vanaf. Een kaartje kon daardoor bijna net zo hoog worden als de kaart zelf.
 * Leaflet gaat dan flink schuiven om het passend te krijgen — dat voelt als
 * te agressief centreren — en lukt dat niet, dan haalt de clusterlaag de
 * speld buiten beeld weg en sluit het kaartje uit zichzelf.
 */
function ververPopupHoogte() {
  if (!kaart) return;
  // Ruimte laten voor het pijltje, de randen en wat lucht om te kunnen pannen.
  const hoogte = Math.max(200, Math.round(kaart.getSize().y - 130));
  document.documentElement.style.setProperty('--popup-max', `${hoogte}px`);
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
  if (e.type) meta.push(`<button type="button" class="etiket etiket-knop" data-tag="${ontsnap(e.type)}">${ontsnap(e.type)}</button>`);
  // De VIP-tijd staat bij de openingstijd, niet hier: het is een tijd, geen
  // kenmerk. Als etiket stond hij er bovendien dubbel.
  if (e.geannuleerd) meta.push('<span class="etiket is-af">Geannuleerd</span>');

  // De socials horen niet tussen de etiketten: die beschrijven de beurs, en
  // dit zijn links naar de organisator. Ze staan dus onderin bij de knoppen,
  // als eigen groepje.
  const socials = (org?.socials ?? [])
    .map((s) => {
      const logo = merkLogo(s.platform);
      // Kennen we het logo niet, dan maar de naam voluit — beter dan een
      // leeg vakje.
      const binnenkant = logo ?? `<span aria-hidden="true">${ontsnap(s.platform)}</span>`;
      return `<a class="etiket social${logo ? ' etiket-kaal' : ''}" href="${ontsnap(s.url)}" target="_blank" rel="noopener noreferrer nofollow"
        title="${ontsnap(s.platform)}"><span class="vb">${ontsnap(s.platform)}</span>${binnenkant}</a>`;
    })
    .join('');

  // De openingstijd is waar je een kaartje voor opent, dus die krijgt de
  // meeste ruimte. Met de duur erbij, want "10:00 – 16:00" laat je zelf
  // rekenen hoelang je hebt.
  // Lang niet elke beurs vult alles in. Wat ontbreekt laten we weg in plaats
  // van er "onbekend" neer te zetten: een kaartje moet er ook compleet
  // uitzien als de helft van de velden leeg is.
  const bijTijd = [
    d?.eindtijd ? duurTekst(e.tijd, d.eindtijd) : null,
    e.viptijd ? `VIP vanaf ${e.viptijd}` : null,
  ].filter(Boolean).join(' · ');

  const tijdBlok = e.tijd
    ? `<div class="pop-tijd">
         <span class="pop-tijd-groot">${ontsnap(e.tijd)}${d?.eindtijd ? `<span class="tot">–</span>${ontsnap(d.eindtijd)}` : ''}</span>
         ${bijTijd ? `<span class="pop-tijd-bij">${ontsnap(bijTijd)}</span>` : ''}
       </div>`
    : '';


  // Hoe groot en hoe ingeburgerd: twee getallen die helpen kiezen.
  const feiten = [];
  if (d?.tafels) feiten.push(feitHtml('kraam', `${d.tafels} stands`));
  if (d?.edities) feiten.push(feitHtml('kalender', `${d.edities}e editie`));

  const voorzieningen = [
    voorzieningHtml(d?.gratisEntree, 'Gratis entree', 'ticket'),
    voorzieningHtml(d?.tickets, 'Tickets', 'ticket'),
    voorzieningHtml(d?.eten, 'Eten & drinken', 'eten'),
    voorzieningHtml(d?.parkeren, 'Gratis parkeren', 'parkeren'),
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
    ? `<p class="pop-reis" data-reis="${ontsnap(e.id)}">${icoon('auto', 14)}
         <span class="pop-reis-tekst">${reisTekst(reistijden.get(`${mijnLocatie.lat},${mijnLocatie.lon}->${e.lat},${e.lon}`) ?? schatReistijd(km))}</span>
       </p>`
    : '';

  return `
    <div class="pop" style="--kleur:${kleur}">
      <div class="pop-lijf">
        ${afbeelding ? `<div class="pop-beeld"><img src="${ontsnap(afbeelding)}?w=640" alt=""></div>` : ''}
        <div class="pop-datum">${ontsnap(datumLabel(e.datum))}<span class="pop-wanneer">${ontsnap(relatief(dagen))}</span></div>
        <h2 class="pop-naam">${ontsnap(e.naam)}</h2>
        ${socials ? `<div class="pop-socials">${socials}</div>` : ''}
        ${tijdBlok}
        ${feiten.length ? `<div class="pop-feiten">${feiten.join('')}</div>` : ''}

        <!-- Soort en voorzieningen bij elkaar: allemaal kenmerken van deze
             beurs. De socials zitten onderin, want dat zijn links. -->
        ${meta.length || voorzieningen ? `<div class="pop-etiketten">${meta.join('')}${voorzieningen}</div>` : ''}
        ${d?.beschrijving ? `<details class="pop-tekst"><summary>${icoon('pijlRechts', 12)}Beschrijving</summary><div>${ontsnap(d.beschrijving).replace(/\n+/g, '<br>')}</div></details>` : ''}
      </div>

      <div class="pop-voet">
        ${e.adres ? `<p class="pop-adres">
          ${icoon('speld', 14)}
          <span class="pop-adres-tekst">${ontsnap(e.adres)}</span>
          <button type="button" class="kopieerknop" data-kopieer="${ontsnap(e.adres)}"
            title="Adres kopiëren" aria-label="Adres kopiëren">${icoon('kopieer', 13)}</button>
        </p>` : ''}
        ${reis}
        <div class="pop-knoppen">${knoppen.join('')}</div>
      </div>
    </div>`;
}

function maakSpeld(e) {
  const niveau = niveauVan(e);
  const marker = L.marker([e.lat, e.lon], {
    niveau,
    icon: L.divIcon({
      className: 'speld-wrap',
      html: `<div class="speld${e.geannuleerd ? ' speld-af' : ''}" style="--kleur:${kleurVan(niveau)}"></div>`,
      // Het bolletje blijft 15 pixels, maar het aanraakvlak eromheen is 32:
      // een speld van 15 pixels raak je met een vinger nauwelijks. De rand
      // eromheen is doorzichtig, dus je ziet er niets van.
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    }),
    title: `${e.naam} — ${e.stad}`,
  });
  /* `autoPan` uit: Leaflet schoof na het openen nog eens bij om het kaartje
     passend te krijgen, en dat was een tweede beweging bovenop de onze — met
     een uitkomst die afhing van de lengte van het kaartje. Een kort kaartje
     belandde 146 pixels boven het midden, een lang 50. We zetten hem nu zelf
     neer, in één keer, altijd op dezelfde plek. */
  marker.bindPopup(() => popupHtml(e), { maxWidth: 270, minWidth: 246, autoPan: false });
  marker.on('popupopen', async (ev) => {
    zetGekozen(e.id, true);
    const el = ev.popup.getElement();

    // Laadt de afbeelding niet, dan de hele balk weghalen: liever geen beeld
    // dan een grijze strook bovenaan het kaartje.
    const img = el?.querySelector('.pop-beeld img');
    img?.addEventListener('error', () => {
      img.closest('.pop-beeld')?.remove();
      zetKaartjeInMidden(ev.popup);   // het kaartje is nu korter geworden
    }, { once: true });

    zetKaartjeInMidden(ev.popup);

    /* Past het kaartje niet in één keer, dan begint het onder de banner.
       Anders open je op een plaatje terwijl je de datum, de tijd en het
       adres wilt zien; de banner is dan het minst belangrijke wat er staat.
       Past alles wél, dan blijft de banner gewoon in beeld — er valt dan
       toch niets te schuiven. */
    requestAnimationFrame(() => {
      const lijf = el?.querySelector('.pop-lijf');
      if (!lijf) return;
      maakSchuifbaar(lijf);
      const beeld = lijf.querySelector('.pop-beeld');
      if (beeld) lijf.scrollTop = beeld.offsetHeight;
    });

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

/**
 * Welke beurzen staan er nu in de lijst? Wordt gebruikt om te bepalen of
 * hertekenen überhaupt nodig is.
 */
function lijstRijen() {
  if (!filters.inBeeld || !kaart) return zichtbaar;
  const kader = kaart.getBounds();
  return zichtbaar.filter((e) => kader.contains([e.lat, e.lon]));
}

/**
 * De lijst opnieuw opbouwen na een kaartbeweging — maar alleen als er echt
 * iets veranderd is.
 *
 * Bij "alleen in beeld" hing dit aan elke beweging, en dat kost bij een
 * volle lijst zo'n twintig milliseconde op een snelle machine en het
 * veelvoud daarvan op een telefoon. Terwijl je bij het rondkijken meestal
 * precies dezelfde beurzen in beeld houdt. Nu vergelijken we eerst welke
 * beurzen er staan, en slaan we het hertekenen over als dat niet verschilt.
 */
let lijstVingerafdruk = null;
let lijstGepland = null;

/* De lijst wordt in happen opgebouwd: eerst een stuk of zestig regels, de
   rest zodra je ernaartoe scrolt. Een "stuk" is één kaartje of één
   datumkop. */
const LIJST_HAP = 60;
let lijstStukken = [];
let lijstGetoond = 0;

function lijstMisschienOpnieuw() {
  const rijen = lijstRijen();
  // Het aantal op de lijstknop kost niets en hoort direct te kloppen, ook
  // als het opbouwen zelf nog even wacht.
  $('#mobielTelling').textContent = rijen.length ? `(${rijen.length})` : '';

  const afdruk = rijen.map((e) => e.id).join();
  if (afdruk === lijstVingerafdruk) return;

  // Wél veranderd, maar het hoeft niet in dezelfde tel als de beweging.
  // Het opbouwen van tweehonderd kaartjes kost een paar honderd DOM-knopen
  // en dat is genoeg om een beeldje te laten vallen. Door het naar een
  // rustig moment te verschuiven blijft de kaart soepel en loopt de lijst
  // een fractie later bij — wat je niet ziet, want je kijkt naar de kaart.
  if (lijstGepland !== null) {
    (window.cancelIdleCallback ?? clearTimeout)(lijstGepland);
  }
  const plan = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 120));
  lijstGepland = plan(() => {
    lijstGepland = null;
    tekenLijst();
  }, { timeout: 400 });
}

function tekenLijst() {
  const lijst = $('#lijst');

  const rijen = lijstRijen();
  lijstVingerafdruk = rijen.map((e) => e.id).join();

  // Het aantal staat op de knop waarmee je naar de lijst wisselt, dus dat
  // moet ook kloppen als de lijst zelf niet in beeld staat.
  $('#mobielTelling').textContent = rijen.length ? `(${rijen.length})` : '';

  // Op een telefoon in kaartweergave staat de lijst niet in beeld. Hem dan
  // toch bij elke kaartbeweging opnieuw opbouwen is werk voor niemand; we
  // onthouden dat het nog moet gebeuren en doen het bij het omschakelen.
  if (!lijst.offsetParent) { lijstIsVerouderd = true; return; }
  lijstIsVerouderd = false;

  // De lijst wordt in zijn geheel opnieuw opgebouwd, en dat zet de
  // scrolpositie terug naar boven. Bij "alleen in beeld" gebeurt dat na
  // iedere kaartbeweging, dus dan springt de lijst telkens omhoog terwijl je
  // aan het kijken bent.
  const scrolpositie = lijst.scrollTop;

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
      meta.push(`<span class="etiket tijd">${ontsnap(e.tijd + tot)}</span>`);
    }
    // Het type is een knop: erop klikken filtert er meteen op.
    if (e.type) {
      const aan = filters.type === e.type;
      meta.push(`<button type="button" class="etiket etiket-knop${aan ? ' is-actief' : ''}" data-tag="${ontsnap(e.type)}"
        title="${aan ? 'Filter op dit soort uitzetten' : `Alleen ${ontsnap(e.type)} tonen`}">${ontsnap(e.type)}</button>`);
    }
    if (e.geannuleerd) meta.push('<span class="etiket is-af">Geannuleerd</span>');
    // Voorzieningen als kaal icoontje: in de lijst is er geen ruimte voor het
    // woord erbij, en de tooltip vertelt wat het is.
    if (d) {
      const kort = (naam, uitleg) => `<span class="etiket etiket-kaal" title="${uitleg}">${icoon(naam, 13)}<span class="vb">${uitleg}</span></span>`;
      if (d.tickets) meta.push(kort('ticket', 'Tickets'));
      if (d.eten) meta.push(kort('eten', 'Eten en drinken'));
      if (d.parkeren) meta.push(kort('parkeren', 'Gratis parkeren'));
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

  /* Niet alles in één keer in de pagina zetten. Bij tweehonderd beurzen zijn
     dat bijna vijfduizend elementen terwijl je er een stuk of zes ziet.
     We zetten er een eerste hap neer en vullen bij zodra je naar beneden
     scrolt. Wat er al stond blijft staan, zodat je scrolpositie klopt na
     een kaartbeweging. */
  lijstStukken = stukken;
  lijstGetoond = Math.min(Math.max(LIJST_HAP, lijstGetoond), stukken.length);
  lijst.innerHTML = stukken.slice(0, lijstGetoond).join('');
  lijst.scrollTop = scrolpositie;
  vulLijstAanIndienNodig();
}

/** Een volgende hap kaartjes onderaan de lijst zetten. */
function vulLijstAan() {
  if (lijstGetoond >= lijstStukken.length) return;
  const lijst = $('#lijst');
  const tot = Math.min(lijstGetoond + LIJST_HAP, lijstStukken.length);
  lijst.insertAdjacentHTML('beforeend', lijstStukken.slice(lijstGetoond, tot).join(''));
  lijstGetoond = tot;
}

/**
 * Bijvullen zolang de onderkant in zicht komt. Ook nodig direct na het
 * tekenen: op een hoog scherm past de eerste hap er soms helemaal op, en
 * dan zou je nooit een scrollgebeurtenis krijgen om de rest te laden.
 */
function vulLijstAanIndienNodig() {
  const lijst = $('#lijst');
  let rondes = 0;
  while (
    lijstGetoond < lijstStukken.length &&
    lijst.scrollHeight - lijst.scrollTop - lijst.clientHeight < 600 &&
    rondes++ < 20
  ) {
    vulLijstAan();
  }
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
  // Ander filter, andere lijst: weer bij de eerste hap beginnen.
  lijstGetoond = 0;
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
    // De lijst wordt in happen opgebouwd, dus de bijbehorende regel kan nog
    // niet in de pagina staan. Bijvullen tot hij er is.
    let rij = document.querySelector(`.kaartje[data-id="${CSS.escape(id)}"]`);
    while (!rij && lijstGetoond < lijstStukken.length) {
      vulLijstAan();
      rij = document.querySelector(`.kaartje[data-id="${CSS.escape(id)}"]`);
    }
    rij?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    // Na het aanvullen kan de onderkant weer in zicht zijn.
    if (rij) for (const el of document.querySelectorAll('.kaartje')) el.classList.toggle('is-gekozen', el.dataset.id === id);
  }
}

/**
 * Klapt de popup van een speld open zodra die werkelijk op de kaart staat.
 *
 * Na een zoom heeft de clusterlaag even nodig om de speld uit zijn cluster te
 * halen, en met `chunkedLoading` worden spelden sowieso in porties toegevoegd.
 * Zolang een speld nergens bij hoort, struikelt `openPopup()` over een
 * ontbrekende kaart — dus kijken we een seconde lang of hij er al is.
 *
 * Lukt het dan nog niet, dan vragen we het de clusterlaag, maar alleen als die
 * de speld inmiddels kent: zonder `__parent` loopt `zoomToShowLayer` stuk. Is
 * ook dat er niet, dan laten we het erbij. De kaart staat op dat moment al op
 * de goede plek, dus je ziet nog steeds waar de beurs is.
 */
/* Of een schuifbaar vlak binnen de kaart met je vinger meegeeft, verschilt per
   browser: Leaflet zet `touch-action: none` op de kaart om slepen en knijpen
   zelf af te handelen, en sommige browsers trekken dat door naar alles wat
   erin staat. Dan staat het kaartje muurvast en kom je niet bij de rest.

   We laten het eerst aan de browser: dat schuift het prettigst, met uitloop.
   Blijkt bij de eerste veeg dat er niets gebeurt terwijl er wel ruimte was,
   dan nemen we het over — voor de rest van de sessie, want dit verandert niet
   halverwege. */
let zelfSchuiven = false;

function maakSchuifbaar(lijf) {
  let vorigeY = 0;
  let meten = false;

  lijf.addEventListener('touchstart', (ev) => {
    if (ev.touches.length !== 1) return;
    vorigeY = ev.touches[0].clientY;
    meten = !zelfSchuiven;
  }, { passive: true });

  // Niet passief: als we het overnemen moeten we het standaardgedrag tegenhouden.
  lijf.addEventListener('touchmove', (ev) => {
    if (ev.touches.length !== 1) return;
    const y = ev.touches[0].clientY;
    const verschil = vorigeY - y;
    vorigeY = y;

    if (zelfSchuiven) {
      lijf.scrollTop += verschil;
      ev.preventDefault();
      return;
    }

    if (!meten) return;
    meten = false;
    // Alleen meten als er in déze richting daadwerkelijk ruimte is, anders
    // zou stilstand aan de bovenrand al voor een weigering doorgaan.
    const ruimte = verschil > 0
      ? lijf.scrollHeight - lijf.clientHeight - lijf.scrollTop
      : lijf.scrollTop;
    if (ruimte <= 1) return;

    /* Even de tijd geven voordat we concluderen dat er niets gebeurt: browsers
       laten schuiven vaak aan de compositor over, en dan staat `scrollTop` na
       één beeldje nog op de oude waarde terwijl het wel degelijk werkt. Een
       scroll-melding is het duidelijkste teken van leven. */
    const voor = lijf.scrollTop;
    let browserDoetHet = false;
    const merk = () => { browserDoetHet = true; };
    lijf.addEventListener('scroll', merk, { passive: true });
    setTimeout(() => {
      lijf.removeEventListener('scroll', merk);
      if (!browserDoetHet && lijf.scrollTop === voor) zelfSchuiven = true;
    }, 120);
  }, { passive: false });
}

/* De onderkant van een kaartje staat altijd even ver boven de speld: dertien
   pixels, plus een pixel rand. Dat ligt vast, ongeacht de inhoud, en daarmee
   is vooraf uit te rekenen waar de kaart moet liggen om het kaartje midden in
   beeld te krijgen. */
const KAARTJE_GAT = 14;

/** Waar moet het midden van de kaart liggen zodat het kaartje in het midden staat? */
function middenVoorKaartje(latlng, zoom, kaartjeHoogte) {
  const punt = kaart.project(latlng, zoom);
  return kaart.unproject(punt.subtract(L.point(0, KAARTJE_GAT + kaartjeHoogte / 2)), zoom);
}

/* Hoe hoog wordt het kaartje? Dat weten we pas als het er staat, en dan is het
   te laat: dan rest alleen nog achteraf bijschuiven, en juist dat heen-en-weer
   wilden we kwijt. Dus zetten we dezelfde inhoud even buiten beeld neer en
   meten we hem daar. Het vakje wordt één keer gemaakt en daarna hergebruikt. */
let meetvak = null;
function meetKaartjeHoogte(e) {
  if (!meetvak) {
    meetvak = document.createElement('div');
    meetvak.className = 'leaflet-popup-content meetvak';
    meetvak.setAttribute('aria-hidden', 'true');
    document.body.append(meetvak);
  }
  meetvak.innerHTML = popupHtml(e);
  const hoogte = meetvak.firstElementChild?.getBoundingClientRect().height ?? 0;
  meetvak.replaceChildren();
  return hoogte;
}

/* Vangnet voor als het kaartje toch afwijkt van de meting — een banner die
   niet laadt en eruit gehaald wordt, bijvoorbeeld. Meestal doet dit niets. */
function zetKaartjeInMidden(popup) {
  const el = popup?.getElement();
  if (!el) return;
  const vak = kaart.getContainer().getBoundingClientRect();
  const kaartje = el.getBoundingClientRect();
  const afwijking = Math.round((kaartje.top + kaartje.height / 2) - (vak.top + vak.height / 2));
  if (Math.abs(afwijking) <= 4) return;
  kaart.panBy([0, afwijking]);
}

function openSpeld(marker, poging = 0) {
  if (marker.isPopupOpen()) return;
  if (kaart.hasLayer(marker)) { marker.openPopup(); return; }
  if (poging < 14) { setTimeout(() => openSpeld(marker, poging + 1), 70); return; }
  if (marker.__parent) clusters.zoomToShowLayer(marker, () => marker.openPopup());
}

function springNaar(id) {
  const marker = spelden.get(id);
  if (!marker) return;
  zetGekozen(id, false);
  if (window.matchMedia('(max-width: 860px)').matches) zetWeergave('kaart');

  // Even wachten zodat de kaart zijn nieuwe afmeting kent na een weergavewissel.
  requestAnimationFrame(() => {
    kaart.invalidateSize();

    /* Eén beweging, naar de plek waar het kaartje straks precies in het midden
       komt te staan. Daarvoor meten we vooraf hoe hoog het wordt.

       Hier stond een uitzondering: was de speld al ruim in beeld, dan bewoog er
       niets. Maar dan kwam het kaartje ook niet in het midden, en dat was juist
       het onrustige eraan. Staat de kaart al goed, dan levert deze berekening
       hetzelfde midden op en beweegt er vanzelf niets.

       Voorbij `LOSSE_SPELDEN_ZOOM` clustert er niets meer, dus na deze sprong
       staat de speld zeker los en kan de popup open. Zat je al dichterbij, dan
       blijft dat zoomniveau staan: geen onnodige sprong. */
    const beurs = zichtbaar.find((x) => x.id === id);
    const hoogte = beurs ? meetKaartjeHoogte(beurs) : 0;
    const zoom = Math.max(kaart.getZoom(), LOSSE_SPELDEN_ZOOM);
    kaart.once('moveend', () => setTimeout(() => openSpeld(marker), 0));
    kaart.setView(middenVoorKaartje(marker.getLatLng(), zoom, hoogte), zoom);
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
  // De lijst is ondertussen misschien niet bijgewerkt omdat hij verborgen was.
  if (welke === 'lijst' && lijstIsVerouderd) tekenLijst();
}

/**
 * Knijpzoomen buiten de kaart tegenhouden.
 *
 * `touch-action` in de opmaak is niet genoeg: Safari op iOS behandelt het
 * knijpzoomen van een pagina als een eigen browsergebaar dat zich daar niets
 * van aantrekt. Die gebaren onderscheppen we hier, behalve boven de kaart —
 * daar hoort knijpen juist te werken.
 *
 * Bewust géén `user-scalable=no` in de viewport-regel: dat negeert iOS ook,
 * en het zou de zoominstelling van de browser blokkeren voor wie die nodig
 * heeft om tekst te kunnen lezen. Dit raakt alleen het gebaar.
 */
function houdPaginaZoomTegen() {
  const opDeKaart = (doel) => !!doel?.closest?.('#kaart');

  // De gesture-gebeurtenissen van Safari; andere browsers kennen ze niet.
  for (const soort of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(soort, (ev) => {
      if (!opDeKaart(ev.target)) ev.preventDefault();
    }, { passive: false });
  }

  // En voor de rest: twee vingers die bewegen buiten de kaart.
  document.addEventListener('touchmove', (ev) => {
    if (ev.touches.length > 1 && !opDeKaart(ev.target)) ev.preventDefault();
  }, { passive: false });
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
    lijstGetoond = 0; // andere volgorde, dus weer bovenaan beginnen
    tekenAlles();
  });

  // Bijvullen zodra je de onderkant nadert.
  $('#lijst').addEventListener('scroll', vulLijstAanIndienNodig, { passive: true });

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

  /* Het adres kopiëren. Op documentniveau afgevangen, want de knop zit in
     een popup die telkens opnieuw wordt opgebouwd. */
  document.addEventListener('click', async (ev) => {
    const knop = ev.target.closest('.kopieerknop');
    if (!knop) return;
    ev.preventDefault();
    ev.stopPropagation();
    const gelukt = () => {
      knop.classList.add('is-gelukt');
      knop.title = 'Gekopieerd';
      setTimeout(() => {
        knop.classList.remove('is-gelukt');
        knop.title = 'Adres kopiëren';
      }, 1600);
    };

    try {
      await navigator.clipboard.writeText(knop.dataset.kopieer);
      gelukt();
      return;
    } catch { /* geweigerd of niet beschikbaar; hieronder de terugval */ }

    // De nieuwe klembord-API wordt niet overal toegestaan. Dan de tekst
    // selecteren en de oude methode proberen — die werkt vaak wél. Lukt ook
    // dat niet, dan staat de tekst in elk geval geselecteerd en kun je hem
    // zelf kopiëren.
    const tekst = knop.closest('.pop-adres')?.querySelector('.pop-adres-tekst');
    if (!tekst) return;
    getSelection()?.selectAllChildren(tekst);
    try {
      if (document.execCommand('copy')) gelukt();
    } catch { /* dan blijft de selectie staan */ }
  }, true);

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
    if (ev.target.closest('.etiket-knop')) return;
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
  houdPaginaZoomTegen();

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
