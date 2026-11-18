// INICIO DEL ARCHIVO
// build-index.mjs — Lee el buzón de cambios (Apps Script → Sheet Cambios),
// aplica los cambios de existencia a docs/indice.json, enriquece TODOS los
// negocios con datos de myred_negocios + myred_ubicaciones, genera backup y
// marca procesado=1.
// VERSIÓN 4 — 2026-11-18
// Cambios v3 → v4:
//   - Enriquece TODO el índice en cada corrida (no solo las filas pendientes).
//     Esto es lo que faltó para migrar el esquema v1 → v3 de los negocios ya procesados.
//   - Sin return temprano: el índice se recalcula aunque no haya filas pendientes.
//   - Marca procesado=1 solo las filas aplicadas o inválidas (negocio_id/SKU vacíos).
//     Las saltadas (negocio inactivo, sin ubicación) quedan en 0 para reintento.
//   - Si indice.json está corrupto intenta indice.backup.json; si tampoco sirve, ABORTA
//     (antes reiniciaba el índice vacío y podía borrar el catálogo).
//   - Solo escribe si el contenido cambió (evita commits vacíos y ruido en el historial).
//   - Poda negocios eliminados/inactivos y productos huérfanos (con guarda si Sheets falla).
// ============================================================
import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import ngeohash from 'ngeohash';
const INDICE_PATH = 'docs/indice.json';
const BACKUP_PATH = 'docs/indice.backup.json';
const SA = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
const SHEETS_CAMBIOS = process.env.SHEETS_CAMBIOS;
const SHEETS_NEGOCIOS = process.env.SHEETS_NEGOCIOS;
const SHEETS_UBICACIONES = process.env.SHEETS_UBICACIONES;
if (!SA.client_email || !SHEETS_CAMBIOS || !SHEETS_NEGOCIOS || !SHEETS_UBICACIONES) {
  console.error('Faltan secrets o variables de entorno requeridas.');
  process.exit(1);
}
const auth = new google.auth.GoogleAuth({
  credentials: SA,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });
function normalizar(s) {
  return String(s || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/-/g, ' ').replace(/\s+/g, ' ');
}
// Slug: NFD sin diacríticos, minúsculas, espacios → guion.
// "O'Higgins" → "o-higgins", "Ñuble" → "nuble", "Santiago - Centro" → "santiago-centro"
function slugify(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[''`´]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function paisCode(pais) {
  const p = String(pais || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (p === 'chile') return 'cl';
  if (p === 'peru') return 'pe';
  return 'xx';
}
function indiceVacio() {
  return { version: '1.0', actualizado: '', total: 0, productos: [], negocios: {} };
}
function sanear(o) {
  const i = (o && typeof o === 'object') ? o : indiceVacio();
  if (!Array.isArray(i.productos)) i.productos = [];
  if (!i.negocios || typeof i.negocios !== 'object') i.negocios = {};
  if (!i.version) i.version = '1.0';
  return i;
}
// Carga el índice. Si el JSON está corrupto intenta el backup; si no hay,
// aborta en vez de reiniciar desde cero (protege el catálogo).
function cargarIndice() {
  if (!existsSync(INDICE_PATH)) return indiceVacio();
  try {
    return sanear(JSON.parse(readFileSync(INDICE_PATH, 'utf8')));
  } catch (e) {
    console.warn(`indice.json ilegible (${e.message}).`);
    if (existsSync(BACKUP_PATH)) {
      try {
        const b = sanear(JSON.parse(readFileSync(BACKUP_PATH, 'utf8')));
        console.warn('Índice restaurado desde indice.backup.json.');
        return b;
      } catch (e2) {
        console.error(`indice.backup.json también ilegible (${e2.message}).`);
      }
    }
    throw new Error('No hay índice válido ni backup. Abortando para no borrar el catálogo.');
  }
}
// Un mismo (negocio_id, sku) puede aparecer repetido por el bug de duplicados.
function dedupeProductos(productos) {
  const mapa = new Map();
  for (const p of productos) {
    if (!p || !p.negocio_id || !p.sku) continue;
    mapa.set(`${p.negocio_id}|${p.sku}`, p);
  }
  return Array.from(mapa.values());
}
async function main() {
  // 1) Buzón
  const cambiosRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEETS_CAMBIOS,
    range: 'Cambios!A:E',
  });
  const rows = cambiosRes.data.values || [];
  const pendientes = [];
  rows.slice(1).forEach((r, i) => {
    const fila = r || [];
    if (String(fila[4] || '') !== '1') pendientes.push({ row: fila, rowNumber: i + 2 });
  });
  // 2) Índice actual
  const indice = cargarIndice();
  const antesContenido = JSON.stringify({ p: indice.productos, n: indice.negocios });
  // 3) Sheets centrales
  const [negRes, ubiRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: SHEETS_NEGOCIOS, range: 'Negocios' }),
    sheets.spreadsheets.values.get({ spreadsheetId: SHEETS_UBICACIONES, range: 'Ubicaciones' }),
  ]);
  const negRows = (negRes.data.values || []).slice(1);
  const ubiRows = (ubiRes.data.values || []).slice(1);
  // Guardas: si una lectura central vino vacía, abortar (evita podar el índice
  // o dejar filas pendientes sin posibilidad de aplicarse).
  if (negRows.length === 0) {
    throw new Error('myred_negocios no devolvió filas. Abortando para no podar el índice.');
  }
  if (ubiRows.length === 0) {
    throw new Error('myred_ubicaciones no devolvió filas. Abortando (revisar permisos del SA).');
  }
  // myred_negocios: A=0 negocio_id, B=1 nombre, G=6 slug, J=9 estado, M=12 zona
  const negMap = {};
  for (const r of negRows) {
    if (!r || !r[0]) continue;
    negMap[String(r[0])] = {
      nombre: r[1] || '',
      slug: r[6] || '',
      estado: r[9] || '',
      zonaCodigo: String(r[12] || '').trim(),
    };
  }
  // myred_ubicaciones: A=0 negocio_id, C=2 lat, D=3 lon, G=6 direccion,
  //                    H=7 comuna, I=8 region, J=9 pais
  const ubiMap = {};
  for (const r of ubiRows) {
    if (!r || !r[0]) continue;
    const lat = parseFloat(r[2]);
    const lon = parseFloat(r[3]);
    if (isNaN(lat) || isNaN(lon)) continue;
    ubiMap[String(r[0])] = {
      lat,
      lon,
      geohash5: ngeohash.encode(lat, lon, 5),
      comuna: String(r[7] || '').trim(),
      region: String(r[8] || '').trim(),
      pais: String(r[9] || '').trim(),
    };
  }
  // 4) Aplicar cambios pendientes
  const aplicadas = [];
  const invalidas = [];
  const saltadas = [];
  for (const { row, rowNumber } of pendientes) {
    const negocioId = String(row[1] || '').trim();
    const sku = String(row[2] || '').trim();
    const existe = String(row[3] || '') === '1';
    // Sin negocio_id o sin SKU no hay nada que indexar: fila irrecuperable.
    if (negocioId.length !== 6 || !sku) { invalidas.push(rowNumber); continue; }
    const neg = negMap[negocioId];
    const ubi = ubiMap[negocioId];
    if (!neg || String(neg.estado).trim().toUpperCase() !== 'ACTIVO' || !ubi) {
      saltadas.push({
        rowNumber, negocioId, sku,
        motivo: !neg ? 'negocio inexistente' : (String(neg.estado).trim().toUpperCase() !== 'ACTIVO' ? 'negocio inactivo' : 'sin ubicación'),
      });
      continue;
    }
    const idx = indice.productos.findIndex(p => p.negocio_id === negocioId && p.sku === sku);
    if (existe) {
      const entry = { sku, termino: normalizar(sku), geohash5: ubi.geohash5, negocio_id: negocioId };
      if (idx === -1) indice.productos.push(entry);
      else indice.productos[idx] = entry;
    } else if (idx !== -1) {
      indice.productos.splice(idx, 1);
    }
    aplicadas.push(rowNumber);
  }
  // 5) Enriquecimiento de TODO el índice (auto-sanante e idempotente)
  indice.productos = dedupeProductos(indice.productos);
  const ids = new Set([
    ...Object.keys(indice.negocios),
    ...indice.productos.map(p => p.negocio_id),
  ]);
  let enriquecidos = 0;
  let sinUbicacion = 0;
  let podados = 0;
  for (const nid of ids) {
    const neg = negMap[nid];
    const ubi = ubiMap[nid];
    // Negocio eliminado o inactivo: se retira del índice con sus productos.
    if (!neg || String(neg.estado).trim().toUpperCase() !== 'ACTIVO') {
      if (indice.negocios[nid]) delete indice.negocios[nid];
      const antesN = indice.productos.length;
      indice.productos = indice.productos.filter(p => p.negocio_id !== nid);
      if (antesN !== indice.productos.length) podados++;
      continue;
    }
    // Sin ubicación no se puede calcular geohash ni zona: se conserva lo que había
    // y se reporta en el log (no se inventan coordenadas).
    if (!ubi) { sinUbicacion++; continue; }
    const pc = paisCode(ubi.pais);
    const base = ubi.region ? slugify(ubi.region) : `zona-${neg.zonaCodigo || 'x'}`;
    indice.negocios[nid] = {
      nombre: neg.nombre,
      slug: neg.slug,
      lat: ubi.lat,
      lon: ubi.lon,
      comuna: ubi.comuna,
      region: ubi.region,
      zona: neg.zonaCodigo,
      pais: ubi.pais,
      zona_slug: `${base}-${pc}`,
    };
    for (const p of indice.productos) {
      if (p.negocio_id !== nid) continue;
      p.geohash5 = ubi.geohash5;
      p.termino = normalizar(p.sku);
    }
    enriquecidos++;
  }
  // 6) Negocios sin productos no van al índice (por diseño)
  const conProductos = new Set(indice.productos.map(p => p.negocio_id));
  for (const nid of Object.keys(indice.negocios)) {
    if (!conProductos.has(nid)) delete indice.negocios[nid];
  }
  indice.total = indice.productos.length;
  const despuesContenido = JSON.stringify({ p: indice.productos, n: indice.negocios });
  const cambio = antesContenido !== despuesContenido;
  // 7) Escribir solo si cambió, dejando backup del anterior
  if (cambio) {
    mkdirSync('docs', { recursive: true });
    if (existsSync(INDICE_PATH)) {
      try { copyFileSync(INDICE_PATH, BACKUP_PATH); }
      catch (e) { console.warn('No se pudo generar backup:', e.message); }
    }
    indice.actualizado = new Date().toISOString();
    writeFileSync(INDICE_PATH, JSON.stringify(indice));
    writeFileSync('.affected.json', JSON.stringify(Array.from(new Set(indice.productos.map(p => p.negocio_id)))));
  }
  // 8) Marcar procesadas solo aplicadas + inválidas (en lotes de 200)
  const marcar = [...aplicadas, ...invalidas];
  for (let i = 0; i < marcar.length; i += 200) {
    const lote = marcar.slice(i, i + 200);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEETS_CAMBIOS,
      requestBody: {
        valueInputOption: 'RAW',
        data: lote.map(n => ({ range: `Cambios!E${n}`, values: [[1]] })),
      },
    });
  }
  // 9) Log operativo
  console.log(`Pendientes ${pendientes.length}: aplicadas ${aplicadas.length}, inválidas ${invalidas.length}, saltadas ${saltadas.length}.`);
  if (saltadas.length > 0) {
    const muestra = saltadas.slice(0, 10)
      .map(s => `fila ${s.rowNumber} ${s.negocioId}/${s.sku} → ${s.motivo}`)
      .join(' | ');
    console.log(`Saltadas (quedan en 0 para reintento): ${muestra}${saltadas.length > 10 ? ` … (+${saltadas.length - 10})` : ''}`);
  }
  console.log(`Enriquecidos ${enriquecidos} negocios (sin ubicación: ${sinUbicacion}), podados ${podados}. Índice: ${indice.total} productos, ${Object.keys(indice.negocios).length} negocios. ${cambio ? 'Índice actualizado.' : 'Sin cambios de contenido: no se reescribe.'}`);
}
main().catch(err => { console.error('FATAL:', err); process.exit(1); });
// FIN DEL ARCHIVO
