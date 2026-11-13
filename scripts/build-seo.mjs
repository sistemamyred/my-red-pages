// INICIO DEL ARCHIVO
// build-seo.mjs — Lee docs/indice.json y genera:
//   - docs/zona/{geohash5}.html (listado + mapa)
//   - docs/sitemap.xml
// No modifica indice.json. No accede a Sheets de negocios.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const INDICE_PATH = 'docs/indice.json';
const OUT_ZONA = 'docs/zona';
const OUT_SITEMAP = 'docs/sitemap.xml';
const BASE_URL = process.env.BASE_URL || 'https://my-red.net';

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

if (!indice.productos || indice.productos.length === 0) {
  console.log('Índice vacío. Generando sitemap mínimo.');
  mkdirSync('docs', { recursive: true });
  writeFileSync(OUT_SITEMAP, '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n');
  process.exit(0);
}

// Agrupar por geohash5
const zonas = {};
for (const p of indice.productos) {
  const g = p.geohash5;
  if (!g) continue;
  if (!zonas[g]) zonas[g] = { negocios: {} };
  const neg = indice.negocios[p.negocio_id];
  if (!neg) continue;
  if (!zonas[g].negocios[p.negocio_id]) {
    zonas[g].negocios[p.negocio_id] = {
      nombre: neg.nombre,
      slug: neg.slug,
      lat: neg.lat,
      lon: neg.lon,
      productos: [],
    };
  }
  zonas[g].negocios[p.negocio_id].productos.push({
    sku: p.sku,
    termino: p.termino,
  });
}

mkdirSync(OUT_ZONA, { recursive: true });

const esc = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function generarZonaHTML(geohash5, data) {
  const negocios = Object.entries(data.negocios);
  const totalProductos = negocios.reduce((acc, [, n]) => acc + n.productos.length, 0);
  const centLat = negocios[0][1].lat;
  const centLon = negocios[0][1].lon;

  const negociosItems = negocios.map(([nid, n]) => {
    const prods = n.productos
      .map(p => `<li>${esc(p.termino || p.sku)}</li>`)
      .join('');
    return `
      <article class="negocio" data-negocio-id="${esc(nid)}" data-lat="${n.lat}" data-lon="${n.lon}">
        <h3><a href=“https://sitios.my-red.net/cl/${esc(n.slug)}/”>${esc(n.nombre)}</a></h3>
        <p class="distancia" data-lat="${n.lat}" data-lon="${n.lon}">—</p>
        <ul class="productos">${prods}</ul>
        <a href=“https://sitios.my-red.net/cl/${esc(n.slug)}/” class=“btn-ver”>Ver negocio →</a>
      </article>`;
  }).join('');

  const jsonLdItems = negocios.map(([nid, n], i) => ({
    "@type": "ListItem",
    "position": i + 1,
    "item": {
      "@type": "LocalBusiness",
      "name": n.nombre,
      "url": `https://sitios.my-red.net/cl/${n.slug}/`,
      "geo": { "@type": "GeoCoordinates", "latitude": n.lat, "longitude": n.lon }
    }
  }));

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": `Productos disponibles en zona ${geohash5}`,
    "numberOfItems": totalProductos,
    "itemListElement": jsonLdItems
  };

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Productos disponibles en zona ${esc(geohash5)} — My-RED</title>
<meta name="description" content="${totalProductos} productos en ${negocios.length} negocios. Encuentra lo que buscas cerca de ti.">
<link rel="canonical" href="${BASE_URL}/zona/${esc(geohash5)}.html">
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
.negocio .distancia{color:#666;font-size:.85rem;margin-bottom:8px}
.negocio .productos{list-style:none;display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.negocio .productos li{background:#E8F5E9;color:#2E7D32;padding:3px 8px;border-radius:12px;font-size:.8rem}
.negocio .btn-ver{display:inline-block;background:#2E7D32;color:#fff;padding:6px 12px;border-radius:6px;text-decoration:none;font-size:.85rem}
footer{text-align:center;padding:24px;color:#666;font-size:.85rem}
</style>
</head>
<body>
<header>
  <h1>Productos disponibles en zona ${esc(geohash5)}</h1>
  <p>${negocios.length} negocios • ${totalProductos} productos</p>
</header>
<main>
  <section>
    <div id="mapa-skeleton">Cargando mapa…</div>
    <div id="mapa" style="display:none"></div>
  </section>
  <aside class="listado">
    <h2>Negocios cercanos</h2>
    ${negociosItems}
  </aside>
</main>
<footer>
  <p><a href="/">🔍 Buscar productos en todo My-RED</a></p>
  <p style="margin-top:8px;font-size:.8rem;color:#999">Los precios, stock y disponibilidad son responsabilidad de cada negocio.</p>
</footer>
<script src="https://unpkg.com/maplibre-gl@4.0.0/dist/maplibre-gl.js"></script>
<script>
(function(){
  const CENTRO = { lat: ${centLat}, lon: ${centLon} };
  const markers = [];

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
    zoom: 12
  });

  document.getElementById('mapa-skeleton').style.display = 'none';
  document.getElementById('mapa').style.display = 'block';

  map.on('load', () => {
    document.querySelectorAll('.negocio').forEach(el => {
      const lat = parseFloat(el.dataset.lat);
      const lon = parseFloat(el.dataset.lon);
      const name = el.querySelector('h3 a').textContent;
      const slug = el.querySelector('h3 a').getAttribute('href');

      const marker = new maplibregl.Marker({ color: '#2E7D32' })
        .setLngLat([lon, lat])
        .setPopup(new maplibregl.Popup().setHTML('<strong>' + name + '</strong><br><a href="' + slug + '">Ver negocio</a>'))
        .addTo(map);
      markers.push({ el, marker, lat, lon });
    });
  });

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(pos => {
      const uLat = pos.coords.latitude;
      const uLon = pos.coords.longitude;
      document.querySelectorAll('.distancia').forEach(el => {
        const lat = parseFloat(el.dataset.lat);
        const lon = parseFloat(el.dataset.lon);
        const d = haversine(uLat, uLon, lat, lon);
        el.textContent = d < 1000 ? `a ${d} m` : `a ${(d/1000).toFixed(1)} km`;
      });
    });
  }
})();
</script>
</body>
</html>`;
}

const zonasGeneradas = [];
for (const [geohash5, data] of Object.entries(zonas)) {
  const html = generarZonaHTML(geohash5, data);
  writeFileSync(join(OUT_ZONA, `${geohash5}.html`), html);
  zonasGeneradas.push(geohash5);
}

// Sitemap
const urls = [
  `${BASE_URL}/`,
  ...zonasGeneradas.map(g => `${BASE_URL}/zona/${g}.html`),
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>
`;
writeFileSync(OUT_SITEMAP, sitemap);

console.log(`Generadas ${zonasGeneradas.length} zonas. Sitemap: ${urls.length} URLs.`);
// FIN DEL ARCHIVO
