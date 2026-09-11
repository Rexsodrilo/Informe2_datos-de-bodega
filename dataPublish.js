// dataPublish.js
// Cierra el flujo de la Opción C: convierte el dataset cargado en un JSON
// descargable (data/data.json) que el responsable sube/commitea al repo, y
// lo carga automáticamente para TODOS los visitantes del sitio publicado.
//
// Flujo:
//   1. El responsable carga el Excel -> se genera data/data.json para
//      descargar -> lo sube (drag & drop) a la carpeta data/ del repo.
//   2. Cualquier visitante que abre la URL pública: la app intenta
//      `fetch('data/data.json')` y, si existe, esos son los datos que ve
//      TODO el mundo (gerencia incluida), sin depender de su navegador.
//   3. Si ese archivo aún no existe (primera vez) o falla la carga, se cae
//      a lo último guardado en localStorage de ESE navegador (útil solo
//      para que el responsable vea su propia carga antes de publicarla).

function serializeNv(nv) {
  return {
    ...nv,
    fecCreacion: nv.fecCreacion ? nv.fecCreacion.toISOString() : null,
    fechaCompromiso: nv.fechaCompromiso ? nv.fechaCompromiso.toISOString() : null,
    fCoordinacion: nv.fCoordinacion ? nv.fCoordinacion.toISOString() : null,
  };
}

function serializeHodo(r) {
  return { ...r, fecha: r.fecha ? r.fecha.toISOString() : null };
}

export function reviveNvDates(nv) {
  return {
    ...nv,
    fecCreacion: nv.fecCreacion ? new Date(nv.fecCreacion) : null,
    fechaCompromiso: nv.fechaCompromiso ? new Date(nv.fechaCompromiso) : null,
    fCoordinacion: nv.fCoordinacion ? new Date(nv.fCoordinacion) : null,
  };
}

function reviveHodoDates(r) {
  return { ...r, fecha: r.fecha ? new Date(r.fecha) : null };
}

/** Descarga data/data.json con el dataset actual, listo para subir al repo. */
export function downloadDataJson({ nvRecords, contHodo, loadedAt }) {
  const payload = {
    loadedAt: loadedAt ? loadedAt.toISOString() : new Date().toISOString(),
    nvRecords: nvRecords.map(serializeNv),
    contHodo: contHodo.map(serializeHodo),
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'data.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Intenta cargar el dataset publicado en data/data.json (el que ve todo el
 * mundo). Devuelve null si no existe o falla, sin lanzar error — quien
 * llama decide el fallback (localStorage o pantalla vacía).
 */
export async function fetchPublishedData() {
  try {
    const res = await fetch('data/data.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const parsed = await res.json();
    return {
      nvRecords: (parsed.nvRecords || []).map(reviveNvDates),
      contHodo: (parsed.contHodo || []).map(reviveHodoDates),
      loadedAt: parsed.loadedAt ? new Date(parsed.loadedAt) : null,
      source: 'publicado',
    };
  } catch (err) {
    return null;
  }
}
