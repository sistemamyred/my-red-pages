// INICIO DEL ARCHIVO
// build-index.mjs — Lee el buzón de cambios, aplica los cambios de existencia a
// docs/indice.json, enriquece TODOS los negocios y solo publica coordenadas
// cuando hay un pin real (nunca el centroide de la región).
// VERSIÓN 5.2 — 2026-11-27
// Cambios v5.1 → v5.2:
//   - Si myred_negocios no tiene filas de datos, el script NO falla: avisa y
//     termina sin tocar el índice (exit 0). Así una limpieza con solo el
//     encabezado no rompe el workflow ni vacía el catálogo.
//   - Se elimina el error por "N productos → 0": vaciar el índice es legítimo
//     cuando el negocio borra su último producto.
//   - RESET_INDEX=1 sigue disponible para un reset intencional (permite podar).
// ------------------------------------------------------------
// VERSIÓN 5.1 — 2026-11-27
// Cambios v5 → v5.1:
//   - Protección de vaciado: si myred_negocios no tiene FILAS DE DATOS (solo
//     encabezado) se aborta en vez de podar todo el índice.
//   - Protección de catálogo: si el índice pasaría de N>0 a 0 productos sin
//     RESET_INDEX=1, se aborta.
//   - Errores con anotación ::error:: para que el fallo sea visible en GitHub.
// ------------------------------------------------------------
// VERSIÓN 5 — 2026-11-26
// Cambios v4 → v5:
//   - Lee la columna F del buzón ("nombre") y la guarda en el índice. El buscador
//     y las zonas muestran nombres reales, no el SKU.
//   - Lee myred_negocios y myred_ubicaciones por NOMBRE DE ENCABEZADO (tolera
//     columnas nuevas o reordenadas; acepta region o ciudad).
//   - Si origen_ubicacion = DECLARADA, NO publica lat/lon ni geohash5: el
//     negocio se indexa por su zona y se muestra sin distancia ni marcador.
//     Las coordenadas reales (GPS / GPS_FUERA_DE_RADIO) sí se publican.
//   - El resto (enriquecimiento total, poda, backup, marcado selectivo) igual que v4.
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

function humanizarSku(sku) {
  const texto = String(sku || '').replace(/-/g, ' ').toLowerCase().trim();
  if (!texto) return '';
  return texto[0].toUpperCase() + texto.substring(1);
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

function dedupeProductos(productos) {
  const mapa = new Map();
  for (const p of productos) {
    if (!p || !p.negocio_id || !p.sku) continue;
    mapa.set(`${p.negocio_id}|${p.sku}`, p);
  }
  return Array.from(mapa.values());
}

function idxDe(headers, ...nombres) {
  const h = (headers || []).map(normalizar);
  for (const n of nombres) {
    const i = h.indexOf(normalizar(n));
    if (i !== -1) return i;
  }
  return -1;
}

async function leerRango(sheetId, rango) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: rango,
    majorDimension: 'ROWS',
  });
  return res.data.values || [];
}

async function main() {
  // 1) Buzón (A:F: timestamp, negocio_id, sku, existe, procesado, nombre)
  const filasCambios = await leerRango(SHEETS_CAMBIOS, 'Cambios!A:F');
  const pendientes = [];
  filasCambios.slice(1).forEach((r, i) => {
    const fila = r || [];
    if (String(fila[4] || '') !== '1') pendientes.push({ row: fila, rowNumber: i + 2 });
  });

  // 2) Índice actual
  const indice = cargarIndice();
  const antesContenido = JSON.stringify({ p: indice.productos, n: indice.negocios });
  const permitirVacio = String(process.env.RESET_INDEX || '') === '1';

  // 3) Sheets centrales (por encabezado)
  const [filasNeg, filasUbi] = await Promise.all([
    leerRango(SHEETS_NEGOCIOS, 'Negocios'),
    leerRango(SHEETS_UBICACIONES, 'Ubicaciones'),
  ]);
  if (filasNeg.length < 2) {
    if (!permitirVacio) {
      console.log('Sin negocios en myred_negocios: no se modifica el índice (no es un error).');
      return;
    }
    console.warn('RESET_INDEX=1 con myred_negocios vacío: se vaciará el índice.');
  }

  const hNeg = filasNeg[0] || [];
  const nId = idxDe(hNeg, 'negocio_id');
  const nNombre = idxDe(hNeg, 'nombre_negocio');
  const nSlug = idxDe(hNeg, 'slug');
  const nEstado = idxDe(hNeg, 'estado');
  const nZona = idxDe(hNeg, 'zona');

  const negMap = {};
  for (const r of filasNeg.slice(1)) {
    if (!r || !r[nId >= 0 ? nId : 0]) continue;
    const id = String(r[nId >= 0 ? nId : 0]);
    negMap[id] = {
      nombre: String(r[nNombre] || ''),
      slug: String(r[nSlug] || ''),
      estado: String(r[nEstado] || ''),
      zona: String(r[nZona] || '').trim(),
    };
  }

  const hUbi = filasUbi[0] || [];
  const uId = idxDe(hUbi, 'negocio_id');
  const uLat = idxDe(hUbi, 'latitud');
  const uLon = idxDe(hUbi, 'longitud');
  const uComuna = idxDe(hUbi, 'comuna');
  const uRegion = idxDe(hUbi, 'region', 'ciudad');
  const uPais = idxDe(hUbi, 'pais');
  const uOrigen = idxDe(hUbi, 'origen_ubicacion');

  const ubiMap = {};
  for (const r of filasUbi.slice(1)) {
    if (!r || !r[uId >= 0 ? uId : 0]) continue;
    const id = String(r[uId >= 0 ? uId : 0]);
    const lat = parseFloat(r[uLat]);
    const lon = parseFloat(r[uLon]);
    const origen = String((uOrigen >= 0 ? r[uOrigen] : '') || '').trim().toUpperCase();
    const coordsValidas = !isNaN(lat) && !isNaN(lon) && !(lat === 0 && lon === 0);
    // Regla: DECLARADA = solo dirección legal, sin pin. No se publica coordenada.
    const tieneCoords = coordsValidas && origen !== 'DECLARADA';
    ubiMap[id] = {
      lat: tieneCoords ? lat : null,
      lon: tieneCoords ? lon : null,
      tieneCoords,
      geohash5: tieneCoords ? ngeohash.encode(lat, lon, 5) : null,
      comuna: String(r[uComuna] || '').trim(),
      region: String(r[uRegion] || '').trim(),
      pais: String(r[uPais] || '').trim(),
      origen,
    };
  }

  // 4) Aplicar pendientes
  const aplicadas = [];
  const invalidas = [];
  const saltadas = [];
  for (const { row, rowNumber } of pendientes) {
    const negocioId = String(row[1] || '').trim();
    const sku = String(row[2] || '').trim();
    const existe = String(row[3] || '') === '1';
    const nombre = String(row[5] || '').trim();

    if (negocioId.length !== 6 || !sku) { invalidas.push(rowNumber); continue; }

    const neg = negMap[negocioId];
    const ubi = ubiMap[negocioId];
    if (!neg || String(neg.estado).trim().toUpperCase() === 'ELIMINADO' || !ubi) {
      saltadas.push({
        rowNumber, negocioId, sku,
        motivo: !neg ? 'negocio inexistente' : (String(neg.estado).trim().toUpperCase() === 'ELIMINADO' ? 'negocio eliminado' : 'sin fila de ubicación'),
      });
      continue;
    }

    const idx = indice.productos.findIndex(p => p.negocio_id === negocioId && p.sku === sku);
    if (existe) {
      const entry = {
        sku,
        termino: normalizar(sku),
        nombre: nombre || (idx !== -1 && indice.productos[idx].nombre) || humanizarSku(sku),
        negocio_id: negocioId,
      };
      if (ubi.tieneCoords) entry.geohash5 = ubi.geohash5;
      if (idx === -1) indice.productos.push(entry);
      else indice.productos[idx] = entry;
    } else if (idx !== -1) {
      indice.productos.splice(idx, 1);
    }
    aplicadas.push(rowNumber);
  }

  // 5) Enriquecimiento de TODO el índice (auto-sanante)
  indice.productos = dedupeProductos(indice.productos);
  const ids = new Set([
    ...Object.keys(indice.negocios),
    ...indice.productos.map(p => p.negocio_id),
  ]);

  let enriquecidos = 0;
  let sinUbicacion = 0;
  let sinCoords = 0;
  let podados = 0;

  for (const nid of ids) {
    const neg = negMap[nid];
    const ubi = ubiMap[nid];

    if (!neg || String(neg.estado).trim().toUpperCase() === 'ELIMINADO') {
      if (indice.negocios[nid]) delete indice.negocios[nid];
      const antesN = indice.productos.length;
      indice.productos = indice.productos.filter(p => p.negocio_id !== nid);
      if (antesN !== indice.productos.length) podados++;
      continue;
    }
    if (!ubi) { sinUbicacion++; continue; }

    const pc = paisCode(ubi.pais);
    const base = ubi.region ? slugify(ubi.region) : `zona-${neg.zona || 'x'}`;
    const entrada = {
      nombre: neg.nombre,
      slug: neg.slug,
      comuna: ubi.comuna,
      region: ubi.region,
      zona: neg.zona,
      pais: ubi.pais,
      zona_slug: `${base}-${pc}`,
    };
    if (ubi.tieneCoords) {
      entrada.lat = ubi.lat;
      entrada.lon = ubi.lon;
    } else {
      sinCoords++;
    }
    indice.negocios[nid] = entrada;

    for (const p of indice.productos) {
      if (p.negocio_id !== nid) continue;
      p.termino = normalizar(p.sku);
      p.nombre = (p.nombre && String(p.nombre).trim()) || humanizarSku(p.sku);
      if (ubi.tieneCoords) p.geohash5 = ubi.geohash5;
      else delete p.geohash5;
    }
    enriquecidos++;
  }

  // 6) Negocios sin productos no van al índice
  const conProductos = new Set(indice.productos.map(p => p.negocio_id));
  for (const nid of Object.keys(indice.negocios)) {
    if (!conProductos.has(nid)) delete indice.negocios[nid];
  }

  indice.total = indice.productos.length;
  const despuesContenido = JSON.stringify({ p: indice.productos, n: indice.negocios });
  const cambio = antesContenido !== despuesContenido;

  // 7) Escribir solo si cambió
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

  // 8) Marcar procesadas: aplicadas + inválidas (las saltadas quedan en 0)
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

  // 9) Log
  console.log(`Pendientes ${pendientes.length}: aplicadas ${aplicadas.length}, inválidas ${invalidas.length}, saltadas ${saltadas.length}.`);
  if (saltadas.length > 0) {
    const muestra = saltadas.slice(0, 10)
      .map(s => `fila ${s.rowNumber} ${s.negocioId}/${s.sku} → ${s.motivo}`)
      .join(' | ');
    console.log(`Saltadas (quedan en 0 para reintento): ${muestra}${saltadas.length > 10 ? ` … (+${saltadas.length - 10})` : ''}`);
  }
  console.log(`Enriquecidos ${enriquecidos} negocios (sin fila de ubicación: ${sinUbicacion}; solo dirección: ${sinCoords}), podados ${podados}. Índice: ${indice.total} productos, ${Object.keys(indice.negocios).length} negocios. ${cambio ? 'Índice actualizado.' : 'Sin cambios de contenido: no se reescribe.'}`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
// FIN DEL ARCHIVO
