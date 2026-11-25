// INICIO DEL ARCHIVO
// build-seo.mjs — Lee docs/indice.json y genera:
//   - docs/zona/{zona_slug}.html  (una por zona: region + país, con sus negocios)
//   - docs/zona/{geohash5}.html   (redirect a la página de su zona)
//   - docs/zona/index.html        (índice de zonas para rastreo de Google)
//   - docs/sitemap.xml
// VERSIÓN 4.2 — 2026-11-25
// Cambios v4 → v4.2:
//   - NUEVO: docs/zona/index.html con la lista de zonas válidas. Es la ruta de
//     rastreo para Google que no depende de JavaScript. Se enlaza desde el
//     buscador y se agrega al sitemap.
//   - NUEVO: JSON-LD por tipo de negocio. Cada negocio en la página de zona
//     usa el @type de schema.org correspondiente (GroceryStore, Restaurant,
//     ProfessionalService, etc.) en vez de LocalBusiness genérico.
//   - NUEVO: derivación del tipo desde el carácter 3 del negocio_id cuando el
//     índice aún no trae "tipo_establecimiento" (forward-compatible con el
//     cambio futuro de build-index.mjs).
//   - NUEVO: etiqueta visible según tipo en cada negocio del listado
//     ("Productos" / "Servicios" / "Platos" / "Reservas" / "Actividades").
//   - Se mantiene todo lo de v4: NO se publican zonas "sin-zona-*", enlaces
//     con /index.html, sitemap solo con páginas válidas + lastmod, salida
//     determinista (sin churn), redirects desde geohash5.
// ============================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

const INDICE_PATH = 'docs/indice.json';
const OUT_ZONA = 'docs/zona';
const OUT_SITEMAP = 'docs/sitemap.xml';
const BASE_URL = process.env.BASE_URL || 'https://my-red.net';

// URL pública del negocio. El objeto en R2 es un archivo exacto: sin index.html da 404.
// Si algún día se habilita un origen que sirva /cl/{slug}/, se cambia SOLO esta línea.
const urlSitio = (slug) => `https://sitios.my-red.net/cl/${slug}/index.html`;

// zona_slug válido: slug + sufijo de país. Ej: antofagasta-cl, biobio-cl, lima-norte-pe
const ZONA_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-(cl|pe)$/;

// ─────────────────────────────────────────────────────────────
// Mapeo tipo de negocio → @type de schema.org
// Se usa cuando el índice NO trae "tipo_establecimiento".
// Fuente: misma tabla que auth_service.dart y Worker v10.3.
// ─────────────────────────────────────────────────────────────
const TIPO_POR_CARACTER = {
  '0': 'ALMACEN', '1': 'TIENDA', '2': 'DISTRIBUIDORA', '3': 'RESTAURANTE',
  '4': 'SERVICIO', '5': 'ESTETICA', '6': 'ENTRETENCION', '7': 'ALOJAMIENTO',
  '8': 'ORGANIZACION', '9': 'IGLESIA', 'A': 'CONSTRUCCION', 'B': 'TALLER',
  'C': 'INDUSTRIA', 'D': 'SERVICIO_PERSONAL', 'E': 'COMERCIO',
  'F': 'AGRICULTURA', 'G': 'OTRO', 'H': 'TRANSPORTE', 'I': 'ARRIENDO',
};

// Mapeo tipo de negocio → @type de schema.org.
// Referencia: https://schema.org/LocalBusiness y subtipos.
const SCHEMA_TYPE_POR_TIPO = {
  'ALMACEN': 'GroceryStore',
  'TIENDA': 'Store',
  'DISTRIBUIDORA': 'Wholesaler',
  'RESTAURANTE': 'Restaurant',
  'SERVICIO': 'ProfessionalService',
  'ESTETICA': 'BeautySalon',
  'ENTRETENCION': 'EntertainmentBusiness',
  'ALOJAMIENTO': 'LodgingBusiness',
  'ORGANIZACION': 'Organization',
  'IGLESIA': 'PlaceOfWorship',
  'CONSTRUCCION': 'GeneralContractor',
  'TALLER': 'AutoRepair',
  'INDUSTRIA': 'Manufacturer',
  'SERVICIO_PERSONAL': 'ProfessionalService',
  'COMERCIO': 'Store',
  'AGRICULTURA': 'Farm',
  'TRANSPORTE': 'MovingCompany',
  'ARRIENDO': 'RealEstateAgent',
  'OTRO': 'LocalBusiness',
};

// Etiqueta visible de los ítems según tipo.
const ETIQUETA_POR_TIPO = {
  'ALMACEN': 'Productos',
  'TIENDA': 'Productos',
  'DISTRIBUIDORA': 'Productos',
  'COMERCIO': 'Productos',
  'AGRICULTURA': 'Productos',
  'RESTAURANTE': 'Platos y menú',
  'SERVICIO': 'Servicios',
  'SERVICIO_PERSONAL': 'Servicios',
  'CONSTRUCCION': 'Servicios',
  'TALLER': 'Servicios',
  'INDUSTRIA': 'Servicios',
  'OTRO': 'Servicios',
  'ESTETICA': 'Reservas y disponibilidad',
  'ALOJAMIENTO': 'Reservas y disponibilidad',
  'ENTRETENCION': 'Reservas y disponibilidad',
  'ARRIENDO': 'Reservas y disponibilidad',
  'TRANSPORTE': 'Reservas y disponibilidad',
  'IGLESIA': 'Actividades',
  'ORGANIZACION': 'Actividades',
};

function tipoDesdeNegocioId(negocioId) {
  if (!negocioId || String(negocioId).length < 3) return 'ALMACEN';
  const c = String(negocioId)[2].toUpperCase();
  return TIPO_POR_CARACTER[c] || 'ALMACEN';
}

function resolverTipo(negocioId, neg) {
  // Prioridad: 1) índice trae tipo_establecimiento; 2) derivar del negocio_id.
  const enIndice = neg && neg.tipo_establecimiento
    ? String(neg.tipo_establecimiento).trim().toUpperCase()
    : '';
  if (enIndice) return enIndice;
  return tipoDesdeNegocioId(negocioId);
}

function schemaTypeDe(tipo) {
  return SCHEMA_TYPE_POR_TIPO[tipo] || 'LocalBusiness';
}

function etiquetaDe(tipo) {
  return ETIQUETA_POR_TIPO[tipo] || 'Productos y servicios';
}

// ─────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────
const esc = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const paisCodigoIso = (pais) => {
  const p = String(pais || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (p === 'chile') return 'CL';
  if (p === 'peru') return 'PE';
  return '';
};

function limpiarZona() {
  if (!existsSync(OUT_ZONA)) return;
  for (const f of readdirSync(OUT_ZONA)) {
    if (!f.endsWith('.html')) continue;
    try { unlinkSync(join(OUT_ZONA, f)); } catch (e) { /* ignorar */ }
  }
}

function sitemapMinimo() {
  mkdirSync('docs', { recursive: true });
  const hoy = new Date().toISOString().slice(0, 10);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${BASE_URL}/</loc><lastmod>${hoy}</lastmod></url>
</urlset>
`;
  writeFileSync(OUT_SITEMAP, xml);
}

// ─────────────────────────────────────────────────────────────
// Carga del índice
// ─────────────────────────────────────────────────────────────
if (!existsSync(INDICE_PATH)) {
  console.log('No existe indice.json. Nada que generar.');
  process.exit(0);
}

let indice;
try {
  indice = JSON.parse(readFileSync(INDICE_PATH, 'utf8'));
} catch (e) {
  console.error('indice.json corrupto, abortando build-seo:', e.message);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// Agrupar por zona_slug. Las zonas sin region o sin zona_slug
// válido se OMITEN (nunca se publican con nombre de máquina).
// ─────────────────────────────────────────────────────────────
const zonas = {};
const omitidas = new Map();

if (Array.isArray(indice.productos) && indice.productos.length > 0) {
  for (const p of indice.productos) {
    if (!p || !p.negocio_id || !p.sku) continue;
    const neg = indice.negocios ? indice.negocios[p.negocio_id] : null;
    if (!neg) continue;

    const zonaSlug = String(neg.zona_slug || '').trim();
    const region = String(neg.region || '').trim();
    const motivo = !zonaSlug
      ? 'sin zona_slug'
      : (!ZONA_SLUG_RE.test(zonaSlug)
          ? `zona_slug inválido (${zonaSlug})`
          : (!region ? 'sin region' : ''));
    if (motivo) {
      omitidas.set(p.negocio_id, motivo);
      continue;
    }

    if (!zonas[zonaSlug]) {
      zonas[zonaSlug] = {
        region,
        pais: String(neg.pais || '').trim(),
        geohashes: new Set(),
        comunas: new Set(),
        negocios: {},
      };
    }

    if (p.geohash5) zonas[zonaSlug].geohashes.add(p.geohash5);
    if (neg.comuna) zonas[zonaSlug].comunas.add(neg.comuna);

    const nid = p.negocio_id;
    const tipo = resolverTipo(nid, neg);

    if (!zonas[zonaSlug].negocios[nid]) {
      zonas[zonaSlug].negocios[nid] = {
        nombre: neg.nombre || '',
        slug: neg.slug || '',
        lat: neg.lat,
        lon: neg.lon,
        comuna: neg.comuna || '',
        tipo,
        productos: [],
      };
    }
    zonas[zonaSlug].negocios[nid].productos.push({
      sku: p.sku,
      termino: p.termino || p.sku,
      nombre: p.nombre || '',
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Página de zona
// ─────────────────────────────────────────────────────────────
function generarZonaHTML(zonaSlug, data) {
  // Orden determinista (evita commits por reordenamiento)
  const negocios = Object.entries(data.negocios)
    .sort((a, b) => String(a[1].nombre).localeCompare(String(b[1].nombre), 'es'));
  for (const [, n] of negocios) {
    n.productos.sort((a, b) => String(a.nombre || a.termino).localeCompare(String(b.nombre || b.termino), 'es'));
  }

  const totalProductos = negocios.reduce((acc, [, n]) => acc + n.productos.length, 0);
  const comunas = Array.from(data.comunas).sort((a, b) => a.localeCompare(b, 'es'));
  const comunaTexto = comunas.length > 0 ? comunas.slice(0, 6).join(', ') : '';

  // Centro del mapa: promedio de los negocios con coordenadas válidas.
  const conCoords = negocios.filter(([, n]) => Number.isFinite(n.lat) && Number.isFinite(n.lon));
  const centLat = conCoords.length > 0
    ? conCoords.reduce((a, [, n]) => a + Number(n.lat), 0) / conCoords.length
    : -33.45;
  const centLon = conCoords.length > 0
    ? conCoords.reduce((a, [, n]) => a + Number(n.lon), 0) / conCoords.length
    : -70.65;
  const puntos = conCoords.map(([, n]) => [Number(n.lon), Number(n.lat)]);

  // Categorías = primera palabra del término/nombre, para meta description.
  const categorias = new Set();
  for (const [, n] of negocios) {
    for (const p of n.productos) {
      const base = String(p.nombre || p.termino || '').trim();
      if (!base) continue;
      const primera = base.split(/\s+/)[0];
      if (primera) categorias.add(primera);
    }
  }
  const categoriasLista = Array.from(categorias).slice(0, 8);

  const region = data.region;
  const pais = data.pais || 'Chile';
  const ISO = paisCodigoIso(pais);
  const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

  const title = `Productos y servicios en ${region} (${pais}) — My-RED`;
  const metaDesc = categoriasLista.length > 0
    ? `Encuentra ${categoriasLista.join(', ')} y más en ${region}${comunaTexto ? ` (${comunaTexto})` : ''}. ${plural(totalProductos, 'producto/servicio', 'productos/servicios')} en ${plural(negocios.length, 'negocio local', 'negocios locales')}. My-RED conecta clientes con comercios de tu zona.`
    : `${plural(totalProductos, 'producto/servicio', 'productos/servicios')} en ${plural(negocios.length, 'negocio', 'negocios')} de ${region}${comunaTexto ? ` (${comunaTexto})` : ''}. Encuentra lo que buscas en tu zona.`;

  const negociosItems = negocios.map(([nid, n]) => {
    const prods = n.productos.map(p =>
      `<li>${esc(p.nombre || p.termino || p.sku)}</li>`
    ).join('');
    const href = urlSitio(n.slug);
    const etiqueta = etiquetaDe(n.tipo);
    return `
      <article class="negocio" data-negocio-id="${esc(nid)}" data-lat="${n.lat}" data-lon="${n.lon}">
        <h3><a href="${esc(href)}">${esc(n.nombre)}</a></h3>
        ${n.comuna ? `<p class="comuna">📍 ${esc(n.comuna)}</p>` : ''}
        <p class="distancia" data-lat="${n.lat}" data-lon="${n.lon}">—</p>
        <p class="etiqueta-items">${esc(etiqueta)}</p>
        <ul class="productos">${prods}</ul>
        <a href="${esc(href)}" class="btn-ver">Ver negocio →</a>
      </article>`;
  }).join('');

  // JSON-LD: ItemList con el @type correcto por negocio.
  const jsonLdItems = negocios.map(([nid, n], i) => {
    const item = {
      '@type': schemaTypeDe(n.tipo),
      name: n.nombre,
      url: urlSitio(n.slug),
      address: {
        '@type': 'PostalAddress',
        ...(n.comuna ? { addressLocality: n.comuna } : {}),
        addressRegion: region,
        ...(ISO ? { addressCountry: ISO } : {}),
      },
    };
    if (Number.isFinite(n.lat) && Number.isFinite(n.lon)) {
      item.geo = { '@type': 'GeoCoordinates', latitude: Number(n.lat), longitude: Number(n.lon) };
    }
    return { '@type': 'ListItem', position: i + 1, item };
  });

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `Productos y servicios disponibles en ${region}`,
    description: metaDesc,
    numberOfItems: totalProductos,
    itemListElement: jsonLdItems,
  };

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(metaDesc)}">
<meta name="keywords" content="${esc(region)}, ${esc(comunaTexto)}, ${esc(categoriasLista.join(', '))}, productos, servicios, negocios locales, comprar">
<link rel="canonical" href="${BASE_URL}/zona/${esc(zonaSlug)}.html">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:url" content="${BASE_URL}/zona/${esc(zonaSlug)}.html">
<meta property="og:type" content="website">
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.0.0/dist/maplibre-gl.css">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;color:#212121;background:#fafafa;line-height:1.5}
header{background:linear-gradient(135deg,#2E7D32,#4CAF50);color:#fff;padding:24px 16px;text-align:center}
header h1{font-size:1.6rem;margin-bottom:6px}
header p{opacity:.9;font-size:.95rem}
main{max-width:1200px;margin:0 auto;padding:16px;display:grid;grid-template-columns:1fr;gap:16px}
@media(min-width:900px){main{grid-template-columns:60% 40%}}
#mapa-skeleton{background:#eee;border-radius:8px;min-height:300px;display:flex;align-items:center;justify-content:center;color:#888}
#mapa{width:100%;min-height:300px;border-radius:8px;overflow:hidden}
.listado h2{margin-bottom:12px;color:#2E7D32;font-size:1.2rem}
.negocio{background:#fff;border-radius:8px;padding:14px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.negocio h3{font-size:1rem;margin-bottom:4px}
.negocio h3 a{color:#2E7D32;text-decoration:none}
.negocio .comuna{color:#2E7D32;font-size:.8rem;margin-bottom:4px}
.negocio .distancia{color:#666;font-size:.85rem;margin-bottom:6px}
.negocio .etiqueta-items{color:#666;font-size:.75rem;margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.negocio .productos{list-style:none;display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.negocio .productos li{background:#E8F5E9;color:#2E7D32;padding:3px 8px;border-radius:12px;font-size:.8rem}
.negocio .btn-ver{display:inline-block;background:#2E7D32;color:#fff;padding:6px 12px;border-radius:6px;text-decoration:none;font-size:.85rem}
footer{text-align:center;padding:24px;color:#666;font-size:.85rem}
footer a{color:#2E7D32;text-decoration:none}
</style>
</head>
<body>
<header>
  <h1>Productos y servicios en ${esc(region)}</h1>
  <p>${negocios.length} negocios · ${totalProductos} ítems · ${esc(pais)}${comunaTexto ? ` · ${esc(comunaTexto)}` : ''}</p>
</header>
<main>
  <section>
    <div id="mapa-skeleton">Cargando mapa…</div>
    <div id="mapa" style="display:none"></div>
  </section>
  <aside class="listado">
    <h2>Negocios en ${esc(region)}</h2>
    ${negociosItems}
  </aside>
</main>
<footer>
  <p><a href="/">🔍 Buscar productos y servicios en todo My-RED</a></p>
  <p style="margin-top:8px;"><a href="/zona/index.html">📍 Ver todas las zonas</a></p>
  <p style="margin-top:8px;font-size:.8rem;color:#999">Los precios, stock y disponibilidad son responsabilidad de cada negocio.</p>
</footer>
<script src="https://unpkg.com/maplibre-gl@4.0.0/dist/maplibre-gl.js"></script>
<script>
(function(){
  const CENTRO = { lat: ${centLat}, lon: ${centLon} };
  const PUNTOS = ${JSON.stringify(puntos)};
  function haversine(lat1,lon1,lat2,lon2){
    const R=6371000,toRad=d=>d*Math.PI/180;
    const dLat=toRad(lat2-lat1),dLon=toRad(lon2-lon1);
    const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return Math.round(2*R*Math.asin(Math.sqrt(a)));
  }
  const map = new maplibregl.Map({
    container: 'mapa',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [CENTRO.lon, CENTRO.lat],
    zoom: 11
  });
  document.getElementById('mapa-skeleton').style.display = 'none';
  document.getElementById('mapa').style.display = 'block';
  map.on('load', () => {
    document.querySelectorAll('.negocio').forEach(el => {
      const lat = parseFloat(el.dataset.lat);
      const lon = parseFloat(el.dataset.lon);
      if (!isFinite(lat) || !isFinite(lon)) return;
      const nombre = el.querySelector('h3 a').textContent;
      const href = el.querySelector('h3 a').getAttribute('href');
      new maplibregl.Marker({ color: '#2E7D32' })
        .setLngLat([lon, lat])
        .setPopup(new maplibregl.Popup().setHTML('<strong>' + nombre + '</strong><br><a href="' + href + '">Ver negocio</a>'))
        .addTo(map);
    });
    if (PUNTOS.length > 1) {
      const lons = PUNTOS.map(p => p[0]);
      const lats = PUNTOS.map(p => p[1]);
      map.fitBounds(
        [[Math.min.apply(null, lons), Math.min.apply(null, lats)],
         [Math.max.apply(null, lons), Math.max.apply(null, lats)]],
        { padding: 40, maxZoom: 13, duration: 0 }
      );
    }
  });
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(pos => {
      const uLat = pos.coords.latitude, uLon = pos.coords.longitude;
      document.querySelectorAll('.distancia').forEach(el => {
        const lat = parseFloat(el.dataset.lat), lon = parseFloat(el.dataset.lon);
        if (!isFinite(lat) || !isFinite(lon)) return;
        const d = haversine(uLat, uLon, lat, lon);
        el.textContent = d < 1000 ? 'a ' + d + ' m' : 'a ' + (d/1000).toFixed(1) + ' km';
      });
    });
  }
})();
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────
// Redirect (meta refresh + canonical) desde la URL vieja por geohash
// ─────────────────────────────────────────────────────────────
function generarRedirectHTML(zonaSlug, region) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Redirigiendo a ${esc(region)} — My-RED</title>
<meta http-equiv="refresh" content="0;url=/zona/${esc(zonaSlug)}.html">
<link rel="canonical" href="${BASE_URL}/zona/${esc(zonaSlug)}.html">
<meta name="robots" content="noindex">
</head>
<body>
<p>Redirigiendo a <a href="/zona/${esc(zonaSlug)}.html">${esc(region)}</a>…</p>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────
// NUEVO en v4.2: índice de zonas (/zona/index.html)
// Es la ruta de rastreo para Google sin depender de JavaScript.
// ─────────────────────────────────────────────────────────────
function generarZonaIndexHTML(zonasMap) {
  const entradas = Object.entries(zonasMap)
    .map(([slug, data]) => ({
      slug,
      region: data.region,
      pais: data.pais || 'Chile',
      negocios: Object.keys(data.negocios).length,
      productos: Object.values(data.negocios).reduce((acc, n) => acc + n.productos.length, 0),
    }))
    .sort((a, b) => {
      // Ordenar por país, luego por región
      const pc = String(a.pais).localeCompare(String(b.pais), 'es');
      if (pc !== 0) return pc;
      return String(a.region).localeCompare(String(b.region), 'es');
    });

  const totalZonas = entradas.length;
  const totalNegocios = entradas.reduce((a, e) => a + e.negocios, 0);
  const totalProductos = entradas.reduce((a, e) => a + e.productos, 0);

  const items = entradas.map(e => `
    <li>
      <a href="/zona/${esc(e.slug)}.html">${esc(e.region)} (${esc(e.pais)})</a>
      <span class="meta">${e.negocios} negocio${e.negocios === 1 ? '' : 's'} · ${e.productos} ítem${e.productos === 1 ? '' : 's'}</span>
    </li>`).join('');

  const title = `Zonas disponibles — My-RED`;
  const metaDesc = `${totalZonas} zonas con ${totalNegocios} negocios y ${totalProductos} productos/servicios. Encuentra lo que buscas en tu zona.`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Zonas disponibles en My-RED',
    numberOfItems: totalZonas,
    itemListElement: entradas.map((e, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: `${e.region} (${e.pais})`,
      url: `${BASE_URL}/zona/${e.slug}.html`,
    })),
  };

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/zona/index.html">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:url" content="${BASE_URL}/zona/index.html">
<meta property="og:type" content="website">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;color:#212121;background:#fafafa;line-height:1.5}
header{background:linear-gradient(135deg,#2E7D32,#4CAF50);color:#fff;padding:24px 16px;text-align:center}
header h1{font-size:1.6rem;margin-bottom:6px}
header p{opacity:.9;font-size:.95rem}
main{max-width:900px;margin:0 auto;padding:16px}
main ul{list-style:none;background:#fff;border-radius:8px;padding:8px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
main li{padding:12px 14px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px}
main li:last-child{border-bottom:none}
main li a{color:#2E7D32;text-decoration:none;font-weight:600}
main li a:hover{text-decoration:underline}
main li .meta{color:#666;font-size:.85rem}
footer{text-align:center;padding:24px;color:#666;font-size:.85rem}
footer a{color:#2E7D32;text-decoration:none}
</style>
</head>
<body>
<header>
  <h1>📍 Zonas disponibles</h1>
  <p>${totalZonas} zonas · ${totalNegocios} negocios · ${totalProductos} ítems</p>
</header>
<main>
  <ul>${items}</ul>
</main>
<footer>
  <p><a href="/">🔍 Buscar en todo My-RED</a></p>
  <p style="margin-top:8px;font-size:.8rem;color:#999">Los precios, stock y disponibilidad son responsabilidad de cada negocio.</p>
</footer>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────
// Regenerar docs/zona/ completo (limpia páginas viejas incl. sin-zona-*)
// ─────────────────────────────────────────────────────────────
limpiarZona();
mkdirSync(OUT_ZONA, { recursive: true });

if (Object.keys(zonas).length === 0) {
  console.log('Índice sin zonas válidas: no se generan páginas de zona.');
  if (omitidas.size > 0) {
    const muestra = Array.from(omitidas.entries()).slice(0, 8)
      .map(([nid, motivo]) => `${nid}: ${motivo}`).join(' | ');
    console.log(`Omitidas ${omitidas.size}: ${muestra}${omitidas.size > 8 ? ` … (+${omitidas.size - 8})` : ''}`);
  }
  sitemapMinimo();
  process.exit(0);
}

const zonasGeneradas = [];
const redirectsGenerados = [];
const geohashUsado = new Map(); // geohash5 → zonaSlug (detecta colisiones entre zonas)

// 1. Generar página de cada zona
for (const zonaSlug of Object.keys(zonas).sort()) {
  const data = zonas[zonaSlug];
  writeFileSync(join(OUT_ZONA, `${zonaSlug}.html`), generarZonaHTML(zonaSlug, data));
  zonasGeneradas.push(zonaSlug);
}

// 2. Generar redirects desde geohash5
for (const zonaSlug of Object.keys(zonas).sort()) {
  const data = zonas[zonaSlug];
  for (const gh of Array.from(data.geohashes).sort()) {
    if (gh === zonaSlug) continue;
    if (geohashUsado.has(gh) && geohashUsado.get(gh) !== zonaSlug) {
      console.warn(`Geohash ${gh} reclamado por ${geohashUsado.get(gh)} y ${zonaSlug}; se conserva el primero.`);
      continue;
    }
    geohashUsado.set(gh, zonaSlug);
    writeFileSync(join(OUT_ZONA, `${gh}.html`), generarRedirectHTML(zonaSlug, data.region));
    redirectsGenerados.push(gh);
  }
}

// 3. NUEVO v4.2: generar índice de zonas
writeFileSync(join(OUT_ZONA, 'index.html'), generarZonaIndexHTML(zonas));

// 4. Sitemap: home + índice de zonas + páginas de zona válidas
const hoy = new Date().toISOString().slice(0, 10);
const urls = [
  { loc: `${BASE_URL}/`, lastmod: hoy },
  { loc: `${BASE_URL}/zona/index.html`, lastmod: hoy },
  ...zonasGeneradas.map(z => ({ loc: `${BASE_URL}/zona/${z}.html`, lastmod: hoy })),
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n')}
</urlset>
`;
writeFileSync(OUT_SITEMAP, sitemap);

// 5. Log operativo
console.log(`Generadas ${zonasGeneradas.length} páginas de zona: ${zonasGeneradas.join(', ')}`);
console.log(`Generado índice de zonas: /zona/index.html (${zonasGeneradas.length} zonas)`);
console.log(`Generados ${redirectsGenerados.length} redirects desde geohash5.`);
console.log(`Sitemap: ${urls.length} URLs.`);
if (omitidas.size > 0) {
  const muestra = Array.from(omitidas.entries()).slice(0, 8)
    .map(([nid, motivo]) => `${nid}: ${motivo}`).join(' | ');
  console.log(`Omitidas ${omitidas.size} (no se publican): ${muestra}${omitidas.size > 8 ? ` … (+${omitidas.size - 8})` : ''}`);
}
// FIN DEL ARCHIVO
