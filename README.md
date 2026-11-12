<!-- INICIO DEL ARCHIVO -->
# my-red-pages

Índice cross-negocio y buscador client-side de My-RED.

## Arquitectura

- **Índice** (`public/indice.json`): generado por `scripts/build-index.mjs` desde el buzón de cambios (Apps Script → Sheet `Cambios_Recientes`).
- **Buscador** (`public/index.html`): client-side con Fuse.js sobre `indice.json`.
- **Páginas de zona** (`public/zona/{geohash5}.html`): generadas por `scripts/build-seo.mjs` con listado + mapa (MapLibre + OpenFreeMap).
- **Sitemap** (`public/sitemap.xml`): generado por `scripts/build-seo.mjs`.
- **Workflow** (`.github/workflows/update-index.yml`): cron cada 15 min.

## Configuración inicial

1. Crear repositorio **público** con este contenido.
2. Añadir los secrets en Settings → Secrets and variables → Actions:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` — JSON completo del SA `myred-workers@my-red-produccion`
   - `SHEETS_CAMBIOS` — ID del Sheet `My-RED Cambios Índice`
   - `SHEETS_NEGOCIOS` — ID del Sheet `myred_negocios`
   - `SHEETS_UBICACIONES` — ID del Sheet `myred_ubicaciones`
3. Añadir la variable en Settings → Secrets and variables → Actions → Variables:
   - `BASE_URL` = `https://my-red.net`
4. Activar GitHub Pages: Settings → Pages → Source: Deploy from a branch → Branch: `main`, folder `/public`.
5. Ejecutar workflow manualmente la primera vez: Actions → Update Index → Run workflow.

## DNS

Apuntar `my-red.net` a GitHub Pages (4 A records):
- `185.199.108.153`
- `185.199.109.153`
- `185.199.110.153`
- `185.199.111.153`

Y `www.my-red.net` CNAME → `{usuario}.github.io`.

Todos en modo **DNS only** (gris, sin proxy Cloudflare).

## Verificación

```bash
curl -I https://my-red.net/indice.json       # 200
curl -I https://my-red.net/index.html        # 200
curl -I https://my-red.net/robots.txt        # 200
curl -I https://my-red.net/sitemap.xml       # 200
