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

  const meta = [];
  if (e.type) meta.push(`<button type="button" class="pil pil-tag" data-tag="${ontsnap(e.type)}">${ontsnap(e.type)}</button>`);
  if (e.viptijd) meta.push(`<span class="pil tijd">VIP vanaf ${ontsnap(e.viptijd)}</span>`);
  if (e.geannuleerd) meta.push('<span class="pil pil-af">Geannuleerd</span>');

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

  const socials = (org?.socials ?? [])
    .map((s) => `<a class="social" href="${ontsnap(s.url)}" target="_blank" rel="noopener noreferrer nofollow">${ontsnap(s.platform)}</a>`)
    .join('');

  // De twee bijrollen staan naast elkaar; staat er maar één, dan vult die
  // de hele regel.
  const bij = [];
  if (org?.website) {
    bij.push(`<a class="pop-knop pop-knop-zacht" href="${ontsnap(org.website)}" target="_blank" rel="noopener noreferrer nofollow">Website</a>`);
  }
  if (mijnLocatie) {
    const bestemming = encodeURIComponent(`${e.zaal ? e.zaal + ', ' : ''}${e.stad}`);
    bij.push(`<a class="pop-knop pop-knop-zacht" target="_blank" rel="noopener noreferrer"
      href="https://www.google.com/maps/dir/?api=1&amp;origin=${mijnLocatie.lat},${mijnLocatie.lon}&amp;destination=${bestemming}">Route · ${ontsnap(toonAfstand(km))}</a>`);
  }

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
        <a class="pop-knop pop-knop-hoofd" href="${ontsnap(e.url)}" target="_blank" rel="noopener noreferrer">Bekijk op pokeradar<span aria-hidden="true"> →</span></a>
        ${bij.length ? `<div class="pop-bij${bij.length === 1 ? ' is-een' : ''}">${bij.join('')}</div>` : ''}
        ${socials ? `<div class="socials">${socials}</div>` : ''}
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
  marker.on('popupopen', (ev) => {
    zetGekozen(e.id, true);
    // Laadt de afbeelding niet, dan de hele balk weghalen: liever geen beeld
    // dan een grijze strook bovenaan het kaartje.
    const img = ev.popup.getElement()?.querySelector('.pop-beeld img');
    img?.addEventListener('error', () => img.closest('.pop-beeld')?.remove(), { once: true });
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

/** Filter gewijzigd: opnieuw tekenen en het beeld erop zetten. */
function naFilter() {
  tekenAlles();
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

/**
 * Zet de eigen locatie en werkt de bediening bij. De coördinaten blijven
 * op dit apparaat: ze gaan alleen naar localStorage, zodat je na een
 * herlaadbeurt niet opnieuw toestemming hoeft te geven.
 */
function zetLocatie(lat, lon, { bewaren = true } = {}) {
  mijnLocatie = { lat, lon };
  if (bewaren) {
    try { localStorage.setItem('kaartjeskaart-locatie', JSON.stringify(mijnLocatie)); } catch { /* privémodus */ }
  }

  if (mijnSpeld) mijnSpeld.remove();
  mijnSpeld = L.marker([lat, lon], {
    icon: L.divIcon({ className: 'ik-wrap', html: '<div class="ik"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
    zIndexOffset: 1000,
    keyboard: false,
    title: 'Jouw locatie',
  }).addTo(kaart).bindPopup('Jouw locatie');

  $('#locatieLabel').textContent = 'Locatie aan';
  $('#locatieKnop').classList.add('is-actief');
  $('#straal').hidden = false;
  $('#sorteerKnop').hidden = false;
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
    $('#locatieLabel').textContent = 'Mijn locatie';
    $('#locatieKnop').classList.remove('is-actief');
    $('#straal').hidden = true;
    $('#straal').value = '';
    $('#sorteerKnop').hidden = true;
    $('#sorteerKnop').classList.remove('is-actief');
    $('#sorteerKnop').setAttribute('aria-pressed', 'false');
    naFilter();
    return;
  }

  if (!navigator.geolocation) {
    $('#locatieLabel').textContent = 'Niet beschikbaar';
    return;
  }
  $('#locatieLabel').textContent = 'Zoeken…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      zetLocatie(pos.coords.latitude, pos.coords.longitude);
      tekenAlles();
      kaart.flyTo([pos.coords.latitude, pos.coords.longitude], 9, { duration: 0.6 });
    },
    (err) => {
      $('#locatieLabel').textContent = err.code === err.PERMISSION_DENIED ? 'Geweigerd' : 'Mislukt';
      setTimeout(() => { $('#locatieLabel').textContent = 'Mijn locatie'; }, 3000);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
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
      // Op mobiel zitten de datumvelden in het ingeklapte deel; die openen
      // we dan meteen, anders klik je op "Datum…" en gebeurt er niets zichtbaars.
      if (eigen && !$('.filters').classList.contains('is-open')) $('#meerKnop').click();
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

  // Op een telefoon staat maar een deel van de filters uitgeklapt, zodat de
  // kaart niet in de verdrukking komt. Deze knop klapt de rest open.
  $('#meerKnop').addEventListener('click', (ev) => {
    const open = $('.filters').classList.toggle('is-open');
    ev.currentTarget.setAttribute('aria-expanded', String(open));
    ev.currentTarget.textContent = open ? 'Minder filters' : 'Meer filters';
    requestAnimationFrame(() => kaart.invalidateSize());
  });

  $('#locatieKnop').addEventListener('click', vraagLocatie);

  $('#straal').addEventListener('change', (ev) => {
    filters.straal = ev.target.value ? Number(ev.target.value) : null;
    naFilter();
  });

  $('#sorteerKnop').addEventListener('click', (ev) => {
    sorteerOpAfstand = !sorteerOpAfstand;
    ev.currentTarget.classList.toggle('is-actief', sorteerOpAfstand);
    ev.currentTarget.setAttribute('aria-pressed', String(sorteerOpAfstand));
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

  // Een eerder toegestane locatie meteen terugzetten, zonder opnieuw te vragen.
  try {
    const bewaard = JSON.parse(localStorage.getItem('kaartjeskaart-locatie') ?? 'null');
    if (bewaard?.lat && bewaard?.lon) zetLocatie(bewaard.lat, bewaard.lon, { bewaren: false });
  } catch { /* privémodus of rommel in de opslag */ }

  tekenAlles();

  // Beeld op de gefilterde spelden zetten, maar niet te ver inzoomen.
  if (zichtbaar.length) {
    kaart.fitBounds(L.latLngBounds(zichtbaar.map((e) => [e.lat, e.lon])).pad(0.12), { maxZoom: 11 });
  }

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
