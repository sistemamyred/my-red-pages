// INICIO DEL ARCHIVO
// build-seo.mjs — Lee docs/indice.json y genera:
//   - docs/zona/{zona_slug}.html      una por zona (region + país)
//   - docs/zona/{geohash5}.html       redirect a la página de su zona
//   - docs/zona/index.html            índice de zonas
//   - docs/servicio/{slug}-{sku}.html una por producto/servicio (SEO)
//   - docs/sitemap.xml
// VERSIÓN 4.2 — 2026-11-26
// Cambios v4.1 → v4.2:
//   - Muestra el NOMBRE real del producto/servicio (p.nombre) en vez del término
//     derivado del SKU, y enlaza a su página de detalle.
//   - Una página por producto/servicio (/servicio/...) con JSON-LD y CTA al sitio
//     del negocio. Es la URL que Google puede posicionar por "arroz Calama".
//   - Solo dibuja mapa y marcadores si el negocio tiene coordenadas reales
//     (los negocios con origen DECLARADA no tienen lat/lon en el índice).
//   - JSON-LD con geo solo cuando hay coordenadas.
// ============================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

const INDICE_PATH = 'docs/indice.json';
const OUT_ZONA = 'docs/zona';
const OUT_SERVICIO = 'docs/servicio';
const OUT_SITEMAP = 'docs/sitemap.xml';
const BASE_URL = process.env.BASE_URL || 'https://my-red.net';

const urlSitio = (slug) => `https://sitios.my-red.net/cl/${slug}/index.html`;
const ZONA_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-(cl|pe)$/;

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

const esc = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const slugify = (s) => String(s || '')
  .trim().toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[''`´]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const paisCodigoIso = (pais) => {
  const p = String(pais || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (p === 'chile') return 'CL';
  if (p === 'peru') return 'PE';
  return '';
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function limpiarHtml(dir) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.html')) continue;
    try { unlinkSync(join(dir, f)); } catch (e) { /* ignorar */ }
  }
}

function sitemapMinimo() {
  mkdirSync('docs', { recursive: true });
  const hoy = new Date().toISOString().slice(0, 10);
  writeFileSync(OUT_SITEMAP, `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${BASE_URL}/</loc><lastmod>${hoy}</lastmod></url>
</urlset>
`);
}

// ─────────────────────────────────────────────────────────────
// Agrupar por zona_slug y recolectar servicios
// ─────────────────────────────────────────────────────────────
const zonas = {};
const servicios = [];
const omitidas = new Map();

if (Array.isArray(indice.productos) && indice.productos.length > 0) {
  for (const p of indice.productos) {
    if (!p || !p.negocio_id || !p.sku) continue;
    const neg = indice.negocios ? indice.negocios[p.negocio_id] : null;
    if (!neg) continue;

    const zonaSlug = String(neg.zona_slug || '').trim();
    const region = String(neg.region || '').trim();
    const motivo = !zonaSlug ? 'sin zona_slug' : (!ZONA_SLUG_RE.test(zonaSlug) ? `zona_slug inválido (${zonaSlug})` : (!region ? 'sin region' : ''));
    if (motivo) { omitidas.set(p.negocio_id, motivo); continue; }

    if (!zonas[zonaSlug]) {
      zonas[zonaSlug] = { region, pais: String(neg.pais || '').trim(), geohashes: new Set(), comunas: new Set(), negocios: {} };
    }
    if (p.geohash5) zonas[zonaSlug].geohashes.add(p.geohash5);
    if (neg.comuna) zonas[zonaSlug].comunas.add(neg.comuna);

    const nid = p.negocio_id;
    const nombre = String(p.nombre || p.termino || p.sku).trim();
    const skuSlug = slugify(p.sku);
    const urlServicio = `/servicio/${slugify(neg.slug)}-${skuSlug}.html`;

    if (!zonas[zonaSlug].negocios[nid]) {
      zonas[zonaSlug].negocios[nid] = {
        nombre: neg.nombre || '',
        slug: neg.slug || '',
        lat: num(neg.lat),
        lon: num(neg.lon),
        comuna: neg.comuna || '',
        productos: [],
      };
    }
    zonas[zonaSlug].negocios[nid].productos.push({ sku: p.sku, nombre, url: urlServicio });

    servicios.push({
      url: urlServicio,
      nombre,
      sku: p.sku,
      negocio: neg.nombre || '',
      negocioSlug: neg.slug || '',
      comuna: neg.comuna || '',
      region,
      pais: String(neg.pais || ''),
      zonaSlug,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Página de zona
// ─────────────────────────────────────────────────────────────
function generarZonaHTML(zonaSlug, data) {
  const negocios = Object.entries(data.negocios)
    .sort((a, b) => String(a[1].nombre).localeCompare(String(b[1].nombre), 'es'));
  for (const [, n] of negocios) {
    n.productos.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));
  }

  const totalProductos = negocios.reduce((acc, [, n]) => acc + n.productos.length, 0);
  const comunas = Array.from(data.comunas).sort((a, b) => a.localeCompare(b, 'es'));
  const comunaTexto = comunas.slice(0, 6).join(', ');
  const conCoords = negocios.filter(([, n]) => n.lat !== null && n.lon !== null);
  const region = data.region;
  const pais = data.pais || 'Chile';
  const ISO = paisCodigoIso(pais);

  const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
  const title = `Productos y servicios en ${region} (${pais}) — My-RED`;
  const metaDesc = totalProductos > 0
    ? `${plural(totalProductos, 'producto o servicio', 'productos y servicios')} en ${plural(negocios.length, 'negocio local', 'negocios locales')} de ${region}${comunaTexto ? ` (${comunaTexto})` : ''}. Encuentra, compara y contacta.`
    : `Negocios locales de ${region}${comunaTexto ? ` (${comunaTexto})` : ''}. Encuentra productos y servicios en My-RED.`;

  const negociosItems = negocios.map(([nid, n]) => {
    const prods = n.productos.slice(0, 10)
      .map(p => `<li><a href="${esc(p.url)}">${esc(p.nombre)}</a></li>`)
      .join('');
    const href = urlSitio(n.slug);
    const geoAttrs = (n.lat !== null && n.lon !== null)
      ? ` data-lat="${n.lat}" data-lon="${n.lon}"`
      : '';
    return `
      <article class="negocio" data-negocio-id="${esc(nid)}"${geoAttrs}>
        <h3><a href="${esc(href)}">${esc(n.nombre)}</a></h3>
        ${n.comuna ? `<p class="comuna">📍 ${esc(n.comuna)}</p>` : ''}
        ${(n.lat !== null && n.lon !== null) ? `<p class="distancia" data-lat="${n.lat}" data-lon="${n.lon}">—</p>` : ''}
        <ul class="productos">${prods}</ul>
        <a href="${esc(href)}" class="btn-ver">Ver negocio →</a>
      </article>`;
  }).join('');

  const jsonLdItems = negocios.map(([nid, n], i) => ({
    '@type': 'ListItem',
    position: i + 1,
    item: {
      '@type': 'LocalBusiness',
      name: n.nombre,
      url: urlSitio(n.slug),
      address: {
        '@type': 'PostalAddress',
        ...(n.comuna ? { addressLocality: n.comuna } : {}),
        addressRegion: region,
        ...(ISO ? { addressCountry: ISO } : {}),
      },
      ...((n.lat !== null && n.lon !== null)
        ? { geo: { '@type': 'GeoCoordinates', latitude: n.lat, longitude: n.lon } }
        : {}),
    },
  }));

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `Productos y servicios en ${region}`,
    description: metaDesc,
    numberOfItems: totalProductos,
    itemListElement: jsonLdItems,
  };

  const centLat = conCoords.length ? conCoords.reduce((a, [, n]) => a + n.lat, 0) / conCoords.length : 0;
  const centLon = conCoords.length ? conCoords.reduce((a, [, n]) => a + n.lon, 0) / conCoords.length : 0;
  const puntos = conCoords.map(([, n]) => [n.lon, n.lat]);

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(metaDesc)}">
<meta name="keywords" content="${esc(region)}, ${esc(comunaTexto)}, productos, servicios, negocios locales, comprar">
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
header{background:linear-gradient(135deg,#2E7D32,#4CAF50);color:#fff;padding:28px 16px;text-align:center}
header h1{font-size:1.6rem;margin-bottom:6px}
header p{opacity:.9;font-size:.95rem}
main{max-width:1200px;margin:0 auto;padding:16px;display:grid;grid-template-columns:1fr;gap:16px}
@media(min-width:900px){main.con-mapa{grid-template-columns:60% 40%}}
#mapa-skeleton{background:#eee;border-radius:8px;min-height:300px;display:flex;align-items:center;justify-content:center;color:#888}
#mapa{width:100%;min-height:300px;border-radius:8px;overflow:hidden}
.listado h2{margin-bottom:12px;color:#2E7D32;font-size:1.2rem}
.negocio{background:#fff;border-radius:8px;padding:14px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.negocio h3{font-size:1rem;margin-bottom:4px}
.negocio h3 a{color:#2E7D32;text-decoration:none}
.negocio .comuna{color:#2E7D32;font-size:.8rem;margin-bottom:4px}
.negocio .distancia{color:#666;font-size:.85rem;margin-bottom:8px}
.negocio .productos{list-style:none;display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.negocio .productos li{background:#E8F5E9;padding:0;border-radius:12px;font-size:.8rem}
.negocio .productos a{display:block;color:#2E7D32;text-decoration:none;padding:3px 8px}
.negocio .btn-ver{display:inline-block;background:#2E7D32;color:#fff;padding:6px 12px;border-radius:6px;text-decoration:none;font-size:.85rem}
footer{text-align:center;padding:24px;color:#666;font-size:.85rem}
footer a{color:#2E7D32}
</style>
</head>
<body>
<header>
  <h1>Productos y servicios en ${esc(region)}</h1>
  <p>${negocios.length} negocios · ${totalProductos} productos/servicios · ${esc(pais)}${comunaTexto ? ` · ${esc(comunaTexto)}` : ''}</p>
</header>
<main class="${conCoords.length ? 'con-mapa' : ''}">
  ${conCoords.length ? `<section><div id="mapa-skeleton">Cargando mapa…</div><div id="mapa" style="display:none"></div></section>` : ''}
  <aside class="listado">
    <h2>Negocios en ${esc(region)}</h2>
    ${negociosItems}
  </aside>
</main>
<footer>
  <p><a href="/">🔍 Buscar en todo My-RED</a> · <a href="/zona/">Todas las zonas</a></p>
  <p style="margin-top:8px;font-size:.8rem;color:#999">Los precios, stock y disponibilidad son responsabilidad de cada negocio.</p>
</footer>
${conCoords.length ? `<script src="https://unpkg.com/maplibre-gl@4.0.0/dist/maplibre-gl.js"></script>
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
  const map = new maplibregl.Map({ container: 'mapa', style: 'https://tiles.openfreemap.org/styles/liberty', center: [CENTRO.lon, CENTRO.lat], zoom: 11 });
  document.getElementById('mapa-skeleton').style.display = 'none';
  document.getElementById('mapa').style.display = 'block';
  map.on('load', () => {
    document.querySelectorAll('.negocio').forEach(el => {
      const lat = parseFloat(el.dataset.lat), lon = parseFloat(el.dataset.lon);
      if (!isFinite(lat) || !isFinite(lon)) return;
      const nombre = el.querySelector('h3 a').textContent;
      const href = el.querySelector('h3 a').getAttribute('href');
      new maplibregl.Marker({ color: '#2E7D32' })
        .setLngLat([lon, lat])
        .setPopup(new maplibregl.Popup().setHTML('<strong>' + nombre + '</strong><br><a href="' + href + '">Ver negocio</a>'))
        .addTo(map);
    });
    if (PUNTOS.length > 1) {
      const lons = PUNTOS.map(p => p[0]), lats = PUNTOS.map(p => p[1]);
      map.fitBounds([[Math.min.apply(null, lons), Math.min.apply(null, lats)], [Math.max.apply(null, lons), Math.max.apply(null, lats)]], { padding: 40, maxZoom: 13, duration: 0 });
    }
  });
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(pos => {
      const uLat = pos.coords.latitude, uLon = pos.coords.longitude;
      document.querySelectorAll('.distancia').forEach(el => {
        const lat = parseFloat(el.dataset.lat), lon = parseFloat(el.dataset.lon);
        const d = haversine(uLat, uLon, lat, lon);
        el.textContent = d < 1000 ? 'a ' + d + ' m' : 'a ' + (d/1000).toFixed(1) + ' km';
      });
    });
  }
})();
</script>` : ''}
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────
// Página de detalle de producto/servicio
// ─────────────────────────────────────────────────────────────
function generarServicioHTML(s) {
  const title = `${s.nombre} — ${s.negocio}${s.comuna ? ` (${s.comuna})` : ''} — My-RED`;
  const desc = `${s.nombre} en ${s.negocio}, ${s.comuna ? s.comuna + ', ' : ''}${s.region}. Consulta disponibilidad, precio y contacto en My-RED.`;
  const href = urlSitio(s.negocioSlug);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: s.nombre,
    serviceType: s.nombre,
    provider: {
      '@type': 'LocalBusiness',
      name: s.negocio,
      url: href,
      address: {
        '@type': 'PostalAddress',
        ...(s.comuna ? { addressLocality: s.comuna } : {}),
        addressRegion: s.region,
        ...(paisCodigoIso(s.pais) ? { addressCountry: paisCodigoIso(s.pais) } : {}),
      },
    },
    areaServed: { '@type': 'AdministrativeArea', name: s.region },
  };

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${BASE_URL}${esc(s.url)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${BASE_URL}${esc(s.url)}">
<meta property="og:type" content="website">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;color:#212121;background:#fafafa;line-height:1.55}
header{background:linear-gradient(135deg,#2E7D32,#4CAF50);color:#fff;padding:28px 16px}
header .wrap{max-width:760px;margin:0 auto}
header .miga{font-size:.85rem;opacity:.9;margin-bottom:8px}
header .miga a{color:#fff}
header h1{font-size:1.7rem;line-height:1.2}
main{max-width:760px;margin:0 auto;padding:20px}
.card{background:#fff;border-radius:10px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:16px}
.negocio{font-size:1.05rem;font-weight:600;color:#2E7D32;text-decoration:none}
.meta{color:#666;font-size:.9rem;margin-top:4px}
.cta{display:inline-block;background:#2E7D32;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:16px}
.sec{display:inline-block;background:#E8F5E9;color:#2E7D32;padding:6px 12px;border-radius:14px;font-size:.85rem}
footer{text-align:center;padding:28px;color:#666;font-size:.85rem}
footer a{color:#2E7D32}
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div class="miga"><a href="/">My-RED</a> › <a href="/zona/${esc(s.zonaSlug)}.html">${esc(s.region)}</a> › ${esc(s.nombre)}</div>
    <h1>${esc(s.nombre)}</h1>
  </div>
</header>
<main>
  <div class="card">
    <span class="sec">📍 ${esc(s.region)}${s.comuna ? ` · ${esc(s.comuna)}` : ''}</span>
    <p style="margin-top:14px">
      <a class="negocio" href="${esc(href)}">${esc(s.negocio)}</a>
    </p>
    <p class="meta">Producto o servicio publicado por el negocio. Los precios, stock y disponibilidad son responsabilidad del negocio.</p>
    <a class="cta" href="${esc(href)}">Ver ficha y contactar →</a>
  </div>
  <div class="card">
    <p class="meta">¿Buscas algo más en ${esc(s.region)}?</p>
    <p style="margin-top:8px"><a class="negocio" href="/zona/${esc(s.zonaSlug)}.html">Ver todos los negocios de ${esc(s.region)} →</a></p>
  </div>
</main>
<footer>
  <p><a href="/">🔍 Buscar en todo My-RED</a> · <a href="/zona/">Todas las zonas</a></p>
</footer>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────
// Índice de zonas
// ─────────────────────────────────────────────────────────────
function generarIndiceZonasHTML() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zonas — My-RED</title>
<meta name="description" content="Explora los productos y servicios disponibles por zona en Chile y Perú. My-RED conecta clientes con comercios locales.">
<link rel="canonical" href="${BASE_URL}/zona/">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;color:#212121;background:#fafafa;line-height:1.5}
header{background:linear-gradient(135deg,#2E7D32,#4CAF50);color:#fff;padding:32px 16px;text-align:center}
header h1{font-size:1.7rem;margin-bottom:6px}
main{max-width:900px;margin:0 auto;padding:20px}
.zona{background:#fff;border-radius:8px;padding:12px 14px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.zona a{color:#2E7D32;text-decoration:none;display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap}
.zona span{color:#777;font-size:.85rem}
footer{text-align:center;padding:28px;color:#666;font-size:.85rem}
footer a{color:#2E7D32}
</style>
</head>
<body>
<header><h1>Explorar por zona</h1><p>Productos y servicios locales en Chile y Perú</p></header>
<main>
  <ul style="list-style:none">${Object.keys(zonas).sort().map((slug) => {
    const z = zonas[slug];
    const negocios = Object.keys(z.negocios).length;
    const productos = Object.values(z.negocios).reduce((a, n) => a + n.productos.length, 0);
    const nNeg = `${negocios} ${negocios === 1 ? 'negocio' : 'negocios'}`;
    const nProd = `${productos} ${productos === 1 ? 'producto' : 'productos'}`;
    return `<li class="zona"><a href="/zona/${esc(slug)}.html"><strong>${esc(z.region)}</strong> <span>${nNeg} · ${nProd}</span></a></li>`;
  }).join('')}</ul>
</main>
<footer><p><a href="/">🔍 Buscar en todo My-RED</a> · <a href="/sitemap.xml">Mapa del sitio</a></p></footer>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────
// Regenerar todo
// ─────────────────────────────────────────────────────────────
limpiarHtml(OUT_ZONA);
limpiarHtml(OUT_SERVICIO);
mkdirSync(OUT_ZONA, { recursive: true });
mkdirSync(OUT_SERVICIO, { recursive: true });

if (Object.keys(zonas).length === 0) {
  console.log('Índice sin zonas válidas: no se generan páginas.');
  if (omitidas.size > 0) {
    const muestra = Array.from(omitidas.entries()).slice(0, 8).map(([nid, motivo]) => `${nid}: ${motivo}`).join(' | ');
    console.log(`Omitidas ${omitidas.size}: ${muestra}`);
  }
  sitemapMinimo();
  process.exit(0);
}

const zonasGeneradas = [];
const redirectsGenerados = [];
const serviciosGenerados = [];
const geohashUsado = new Map();

for (const zonaSlug of Object.keys(zonas).sort()) {
  const data = zonas[zonaSlug];
  writeFileSync(join(OUT_ZONA, `${zonaSlug}.html`), generarZonaHTML(zonaSlug, data));
  zonasGeneradas.push(zonaSlug);

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

// Páginas de servicio (una por producto), sin duplicados de URL
const urlsServicio = new Set();
for (const s of servicios) {
  if (urlsServicio.has(s.url)) continue;
  urlsServicio.add(s.url);
  const nombreArchivo = s.url.replace('/servicio/', '');
  writeFileSync(join(OUT_SERVICIO, nombreArchivo), generarServicioHTML(s));
  serviciosGenerados.push(s.url);
}

writeFileSync(join(OUT_ZONA, 'index.html'), generarIndiceZonasHTML());

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

// Sitemap
const hoy = new Date().toISOString().slice(0, 10);
const urls = [
  { loc: `${BASE_URL}/`, lastmod: hoy },
  { loc: `${BASE_URL}/zona/`, lastmod: hoy },
  ...zonasGeneradas.map(z => ({ loc: `${BASE_URL}/zona/${z}.html`, lastmod: hoy })),
  ...serviciosGenerados.map(s => ({ loc: `${BASE_URL}${s}`, lastmod: hoy })),
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n')}
</urlset>
`;
writeFileSync(OUT_SITEMAP, sitemap);

console.log(`Generadas ${zonasGeneradas.length} páginas de zona: ${zonasGeneradas.join(', ')}`);
console.log(`Generadas ${serviciosGenerados.length} páginas de producto/servicio.`);
console.log(`Generados ${redirectsGenerados.length} redirects desde geohash5.`);
console.log(`Sitemap: ${urls.length} URLs.`);
if (omitidas.size > 0) {
  const muestra = Array.from(omitidas.entries()).slice(0, 8).map(([nid, motivo]) => `${nid}: ${motivo}`).join(' | ');
  console.log(`Omitidas ${omitidas.size} (no se publican): ${muestra}${omitidas.size > 8 ? ` … (+${omitidas.size - 8})` : ''}`);
}
// FIN DEL ARCHIVO
