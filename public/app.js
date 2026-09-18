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

/* De themakleuren staan in CSS-variabelen, maar ze uitlezen kost een
   herberekening van de stijl. Bij 235 spelden loont het om ze één keer
   per thema op te halen. */
let kleurCache = {};
function ververKleuren() {
  const stijl = getComputedStyle(document.documentElement);
  kleurCache = {};
  for (const niveau of ['vandaag', 'week', 'maand', 'later', 'accent']) {
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
  landen: new Set(['NL', 'BE']),
  type: '',
  zoek: '',
  inBeeld: false,
  toonGeannuleerd: false,
};

let alleEvents = [];
let zichtbaar = [];
let gekozenId = null;
let kaart;
let tegellaag;
let clusters;
const spelden = new Map(); // id -> marker

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
    preferCanvas: true,
    worldCopyJump: false,
  });

  const thema = document.documentElement.dataset.thema;
  tegellaag = L.tileLayer(TEGELS[thema === 'licht' ? 'licht' : 'donker'], {
    attribution: NAAMSVERMELDING,
    // Esri levert tot zoom 16; daarboven rekt Leaflet de laatste tegel op,
    // zodat je wel verder kunt inzoomen op een speld.
    maxNativeZoom: TEGEL_MAXZOOM,
    maxZoom: 18,
  }).addTo(kaart);

  clusters = L.markerClusterGroup({
    maxClusterRadius: 44,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    disableClusteringAtZoom: 13,
    chunkedLoading: true,
    iconCreateFunction(cluster) {
      // De kleur van een tros volgt het meest dringende evenement erin.
      const rang = { vandaag: 0, week: 1, maand: 2, later: 3 };
      let beste = 'later';
      for (const m of cluster.getAllChildMarkers()) {
        if (rang[m.options.niveau] < rang[beste]) beste = m.options.niveau;
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

function popupHtml(e) {
  const dagen = dagenTot(e.datum);
  const kleur = kleurVan(e.geannuleerd ? 'later' : urgentie(dagen));
  const meta = [];
  if (e.tijd) meta.push(`<span class="pil tijd">${ontsnap(e.tijd)}${e.viptijd ? ` · VIP ${ontsnap(e.viptijd)}` : ''}</span>`);
  if (e.type) meta.push(`<span class="pil">${ontsnap(e.type)}</span>`);
  if (e.geannuleerd) meta.push('<span class="pil pil-af">Geannuleerd</span>');

  return `
    <div style="--kleur:${kleur}">
      <div class="pop-datum">${ontsnap(datumLabel(e.datum))} · ${ontsnap(relatief(dagen))}</div>
      <p class="pop-naam">${ontsnap(e.naam)}</p>
      <div class="pop-plaats"><b>${ontsnap(e.stad)}</b>${e.zaal ? `<br>${ontsnap(e.zaal)}` : ''}</div>
      ${meta.length ? `<div class="pop-meta">${meta.join('')}</div>` : ''}
      <a class="pop-link" href="${ontsnap(e.url)}" target="_blank" rel="noopener noreferrer">Bekijk op pokeradar &rarr;</a>
      ${e.precisie === 'city' ? '<div class="pop-bron">speld staat op het centrum van de plaats</div>' : ''}
    </div>`;
}

function maakSpeld(e) {
  const niveau = e.geannuleerd ? 'later' : urgentie(dagenTot(e.datum));
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
  marker.on('popupopen', () => zetGekozen(e.id, true));
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
    if (dagen < 0) return false;
    if (filters.periode === '7' && dagen > 7) return false;
    if (filters.periode === '30' && dagen > 30) return false;
    if (filters.periode === 'weekend') {
      const d = naarDatum(e.datum);
      if (d < weekend.van || d > weekend.tot) return false;
    }

    if (zoek) {
      const hooi = `${e.naam} ${e.stad} ${e.zaal ?? ''} ${e.type ?? ''}`.toLowerCase();
      if (!hooi.includes(zoek)) return false;
    }
    return true;
  });
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

  const perDag = new Map();
  for (const e of rijen) {
    if (!perDag.has(e.datum)) perDag.set(e.datum, []);
    perDag.get(e.datum).push(e);
  }

  const stukken = [];
  for (const [datum, groep] of perDag) {
    const dagen = dagenTot(datum);
    stukken.push(
      `<div class="datumkop"><span>${ontsnap(datumLabel(datum))}</span><span class="relatief">${ontsnap(relatief(dagen))}</span></div>`,
    );
    for (const e of groep) {
      const niveau = e.geannuleerd ? 'later' : urgentie(dagen);
      const meta = [];
      if (e.tijd) meta.push(`<span class="pil tijd">${ontsnap(e.tijd)}</span>`);
      if (e.type) meta.push(`<span class="pil">${ontsnap(e.type)}</span>`);
      if (e.geannuleerd) meta.push('<span class="pil pil-af">Geannuleerd</span>');
      stukken.push(`
        <article class="kaartje${e.geannuleerd ? ' is-af' : ''}${e.id === gekozenId ? ' is-gekozen' : ''}"
                 style="--kleur:${kleurVan(niveau)}" data-id="${ontsnap(e.id)}" tabindex="0" role="button">
          <div class="kaartje-lijf">
            <p class="kaartje-naam">${ontsnap(e.naam)}</p>
            <div class="kaartje-plaats"><b>${ontsnap(e.stad)}</b>${e.zaal ? ` · ${ontsnap(e.zaal)}` : ''}</div>
            ${meta.length ? `<div class="kaartje-meta">${meta.join('')}</div>` : ''}
          </div>
        </article>`);
    }
  }
  lijst.innerHTML = stukken.join('');
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
      naFilter();
    });
  }

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

  const lijst = $('#lijst');
  lijst.addEventListener('click', (ev) => {
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
}

start();
