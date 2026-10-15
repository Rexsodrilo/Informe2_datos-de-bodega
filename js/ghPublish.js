// ghPublish.js — publicación directa a GitHub (API Contents), compartida por
// produccion.js (avance de maquila) y dataPublish.js (dataset principal,
// data.json.gz, desde el 2026-10-15). Un solo token guardado en localStorage
// de este navegador (nunca se sube a ningún lado salvo a la API de GitHub),
// con permiso de escritura sobre todo el repositorio — por eso el mismo
// token sirve para cualquier archivo del proyecto, no solo el que lo creó.
export const REPO_OWNER = 'Rexsodrilo';
export const REPO_NAME = 'Informe2_datos-de-bodega';
export const REPO_BRANCH = 'main';
const LS_TOKEN_KEY = 'downlight_gh_token';

export function getGhToken() {
  try { return localStorage.getItem(LS_TOKEN_KEY) || ''; } catch (e) { return ''; }
}
export function setGhToken(t) {
  try {
    if (t) localStorage.setItem(LS_TOKEN_KEY, t);
    else localStorage.removeItem(LS_TOKEN_KEY);
  } catch (e) { /* nada */ }
}

async function ghFetch(ruta, opciones = {}) {
  const token = getGhToken();
  return fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}${ruta}`, {
    ...opciones,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opciones.headers || {}),
    },
  });
}
async function ghError(r) {
  let msg = '';
  try { msg = (await r.json()).message || ''; } catch (e) { /* nada */ }
  const pista = r.status === 401 || r.status === 403 ? ' (revisa el token y sus permisos)' : '';
  return new Error(`GitHub respondió ${r.status}${msg ? ': ' + msg : ''}${pista}`);
}

/** Codifica bytes binarios (ej. un gzip) a base64, para el campo "content" de la API. */
export function bytesToBase64(bytes) {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

/** Publica contenido (ya en base64) en una ruta del repo — crea el archivo si
 * no existe, o lo reemplaza si existe (pide su sha actual primero). */
export async function publicarArchivo(ruta, { contenidoBase64, mensaje }) {
  const infoR = await ghFetch(`/contents/${ruta}?ref=${REPO_BRANCH}`);
  let sha = null;
  if (infoR.status === 404) sha = null;
  else if (infoR.ok) sha = (await infoR.json()).sha;
  else throw await ghError(infoR);

  const body = { message: mensaje, content: contenidoBase64, branch: REPO_BRANCH };
  if (sha) body.sha = sha;
  const r = await ghFetch(`/contents/${ruta}`, { method: 'PUT', body: JSON.stringify(body) });
  if (!r.ok) throw await ghError(r);
  return r.json();
}

/** Historial de commits que tocaron una ruta — de lectura pública, no necesita
 * token (el repo es público; sirve para mostrar versiones aunque el token
 * guardado haya vencido o nunca se haya configurado). */
export async function historialArchivo(ruta, limite = 20) {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits?path=${encodeURIComponent(ruta)}&sha=${REPO_BRANCH}&per_page=${limite}`;
  const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  if (!r.ok) throw await ghError(r);
  return r.json();
}

/** Contenido (base64 tal cual lo entrega GitHub) de una ruta en un commit
 * puntual — sí necesita token porque usa la misma API de Contents. */
export async function contenidoEnVersion(ruta, sha) {
  const r = await ghFetch(`/contents/${ruta}?ref=${sha}`);
  if (!r.ok) throw await ghError(r);
  const json = await r.json();
  return json.content;
}
