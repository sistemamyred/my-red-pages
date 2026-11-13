// INICIO DEL ARCHIVO
// build-index.mjs — Lee el buzón de cambios (Apps Script → Sheet Cambios),
// aplica los cambios a docs/indice.json, genera backup y marca procesado=1.
// No lee Sheets ni Drive de negocios. Cumple D3.

import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import ngeohash from 'ngeohash';

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

async function main() {
  // 1) Leer buzón
  const cambiosRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEETS_CAMBIOS,
    range: 'Cambios!A:E',
  });
  const rows = cambiosRes.data.values || [];
  if (rows.length < 2) {
    console.log('Sin cambios en el buzón.');
    return;
  }
  const pendientes = [];
  rows.slice(1).forEach((r, i) => {
    if (r[4] !== '1') pendientes.push({ row: r, rowNumber: i + 2 });
  });
  if (pendientes.length === 0) {
    console.log('Sin cambios pendientes (todos procesados).');
    return;
  }

  // 2) Cargar índice actual con backup
  let indice = { version: '1.0', actualizado: '', total: 0, productos: [], negocios: {} };
  if (existsSync('docs/indice.json')) {
    try {
      copyFileSync('docs/indice.json', 'docs/indice.backup.json');
    } catch (e) {
      console.warn('No se pudo generar backup:', e.message);
    }
    try {
      indice = JSON.parse(readFileSync('docs/indice.json', 'utf8'));
      if (!indice.productos) indice.productos = [];
      if (!indice.negocios) indice.negocios = {};
      if (!indice.version) indice.version = '1.0';
    } catch (e) {
      console.warn('Índice corrupto, reiniciando desde cero:', e.message);
    }
  }

  // 3) Leer negocios y ubicaciones (solo Sheets centrales)
  const [negRes, ubiRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: SHEETS_NEGOCIOS, range: 'Negocios' }),
    sheets.spreadsheets.values.get({ spreadsheetId: SHEETS_UBICACIONES, range: 'Ubicaciones' }),
  ]);
  const negMap = {};
  (negRes.data.values || []).slice(1).forEach(r => {
    if (r[0]) negMap[r[0]] = { nombre: r[1] || '', slug: r[6] || '', estado: r[9] || '' };
  });
  const ubiMap = {};
  (ubiRes.data.values || []).slice(1).forEach(r => {
    const lat = parseFloat(r[2]);
    const lon = parseFloat(r[3]);
    if (!isNaN(lat) && !isNaN(lon) && r[0]) {
      ubiMap[r[0]] = { lat, lon, geohash5: ngeohash.encode(lat, lon, 5) };
    }
  });

  // 4) Aplicar cambios
  const afectados = new Set();
  let aplicados = 0;
  let saltados = 0;
  for (const { row } of pendientes) {
    const [, negocioId, sku, existeRaw] = row;
    const existe = existeRaw === '1';
    const neg = negMap[negocioId];
    const ubi = ubiMap[negocioId];
    if (!neg || !ubi || neg.estado !== 'ACTIVO') {
      saltados++;
      continue;
    }
    const skuStr = String(sku || '').trim();
    if (!skuStr) { saltados++; continue; }

    const idx = indice.productos.findIndex(
      p => p.negocio_id === negocioId && p.sku === skuStr
    );

    if (existe) {
      const entry = {
        sku: skuStr,
        termino: normalizar(skuStr),
        geohash5: ubi.geohash5,
        negocio_id: negocioId,
      };
      if (idx === -1) indice.productos.push(entry);
      else indice.productos[idx] = entry;
    } else {
      if (idx !== -1) indice.productos.splice(idx, 1);
    }

    indice.negocios[negocioId] = {
      nombre: neg.nombre,
      slug: neg.slug,
      lat: ubi.lat,
      lon: ubi.lon,
    };
    afectados.add(negocioId);
    aplicados++;
  }

  // 5) Limpiar negocios sin productos
  const negsConProductos = new Set(indice.productos.map(p => p.negocio_id));
  for (const nid of Object.keys(indice.negocios)) {
    if (!negsConProductos.has(nid)) delete indice.negocios[nid];
  }

  // 6) Escribir índice
  indice.version = '1.0';
  indice.actualizado = new Date().toISOString();
  indice.total = indice.productos.length;
  mkdirSync('public', { recursive: true });
  writeFileSync('docs/indice.json', JSON.stringify(indice));

  // 7) Lista de afectados (para build-seo)
  writeFileSync('.affected.json', JSON.stringify(Array.from(afectados)));

  // 8) Marcar procesados (batch)
  const updates = pendientes.map(({ rowNumber }) => ({
    range: `Cambios!E${rowNumber}`,
    values: [[1]],
  }));
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEETS_CAMBIOS,
    requestBody: { valueInputOption: 'RAW', data: updates },
  });

  console.log(`Aplicados ${aplicados}, saltados ${saltados}. Índice: ${indice.total} productos, ${Object.keys(indice.negocios).length} negocios. Afectados: ${afectados.size}.`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
// FIN DEL ARCHIVO
