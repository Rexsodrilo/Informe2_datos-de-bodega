// produccion.js — seguimiento de avance de maquila. Hoy solo armado de
// canastillos (NV vigentes, estado A); pensado para sumar otras maquilas
// más adelante sin tener que renombrar nada de nuevo.
// Lee NV del mismo data.json.gz público; el avance (lo ingresado a mano
// acá) NO viene del Excel, se guarda aparte en data/produccion_progreso.json,
// publicado directo a GitHub con un token propio del navegador (ver guía
// dentro de la página).
import { fetchPublishedData } from './dataPublish.js?v=18';

const REPO_OWNER = 'Rexsodrilo';
const REPO_NAME = 'Informe2_datos-de-bodega';
const REPO_BRANCH = 'main';
const RUTA_PROGRESO = 'data/produccion_progreso.json';
const LS_TOKEN_KEY = 'produccion_gh_token';

const fmtPct = (v) => (v == null || isNaN(v) ? '—' : Math.round(v * 10) / 10 + '%');
const fmtNum = (v) => (v == null || isNaN(v) ? '—' : Number(v).toLocaleString('es-CL'));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- Deteccion de lineas (maquila "armado de canastillo"): el codigo de
// "Armado CANASTILLO" siempre empieza con CAN (CAN2500/CAN3000/CAN3500/
// CAN4000/CAN4500) — mas confiable que el texto libre de la descripcion,
// que trae variaciones y errores de tipeo entre "Tubular"/"Conico"/
// "+ canastillo"/"C/Canastillos". Medido en el Excel real el 2026-10-14:
// 532 NV historicas con este codigo, 531 con una linea de poste reconocible
// en la misma NV.
function esLineaCanastillo(item) {
  return (item.codProd || '').toString().trim().toUpperCase().startsWith('CAN');
}
function esLineaPoste(item) {
  if (esLineaCanastillo(item)) return false;
  return /poste/i.test(item.detProd || '');
}

/** Fecha de término posible: pedida como "fecha de creación + 5 días",
 * una estimación simple, no un compromiso real con el cliente. */
function sumarDias(fecha, n) {
  const d = new Date(fecha);
  d.setDate(d.getDate() + n);
  return d;
}

/** Una fila por cada linea "Armado CANASTILLO" de una NV en estado A — una
 * NV puede tener mas de una (distintas medidas de poste en la misma nota). */
function computeFilas(nvRecords, progreso) {
  const filas = [];
  nvRecords.forEach((nv) => {
    if (nv.nvEstado !== 'A') return;
    const items = nv.items || [];
    const lineasCan = items.filter(esLineaCanastillo);
    if (!lineasCan.length) return;
    const lineasPoste = items.filter(esLineaPoste);
    lineasCan.forEach((can, idx) => {
      const totalSolicitado = can.cant || 0;
      const despachado = Math.max(0, totalSolicitado - (can.salXDes || 0));
      const codCan = (can.codProd || '').toString().trim();
      // El indice distingue dos lineas del mismo codigo CAN en la misma NV
      // (pasa en pedidos grandes consolidados, ej. NV 329861 con dos lineas
      // CAN4500 de cantidades distintas) — sin esto colisionaban en la misma
      // clave y una pisaba el "producido" de la otra.
      const key = `${nv.nvNumero}__${codCan}__${idx}`;
      const guardado = progreso[key];
      const producido = Math.min(totalSolicitado, Math.max(despachado, guardado ? Number(guardado.producido) || 0 : 0));
      // Solo se muestra el/los poste(s) cuya cantidad calza exacto con la
      // linea de armado — en una NV con muchas lineas de postes distintos
      // (pedidos grandes consolidados) mostrar "todas las que haya" como
      // alternativa confundía mas de lo que ayudaba.
      const postesCoincidentes = lineasPoste.filter((p) => (p.cant || 0) === totalSolicitado);
      const posteTexto = postesCoincidentes.map((p) => p.detProd).join(' / ') || '—';
      filas.push({
        nvNumero: nv.nvNumero,
        cliente: nv.cliente || '',
        poste: posteTexto,
        armado: can.detProd || '',
        codCan,
        key,
        totalSolicitado,
        despachado,
        producido,
        fechaTermino: nv.fecCreacion ? sumarDias(nv.fecCreacion, 5) : null,
      });
    });
  });
  return filas.sort((a, b) => a.nvNumero.localeCompare(b.nvNumero, 'es', { numeric: true }));
}

// --- Progreso publicado (lectura publica, sin token) ---
async function leerProgresoPublicado() {
  try {
    const r = await fetch(`${RUTA_PROGRESO}?v=${Date.now()}`, { cache: 'no-store' });
    if (r.status === 404) return {};
    if (!r.ok) return {};
    return (await r.json()) || {};
  } catch (e) {
    return {};
  }
}

// --- Token (solo en este navegador) ---
function getToken() {
  try { return localStorage.getItem(LS_TOKEN_KEY) || ''; } catch (e) { return ''; }
}
function setToken(t) {
  try {
    if (t) localStorage.setItem(LS_TOKEN_KEY, t);
    else localStorage.removeItem(LS_TOKEN_KEY);
  } catch (e) { /* nada */ }
}

// --- Publicar a GitHub (sin cifrado, no hace falta para este dato) ---
async function ghFetch(ruta, opciones = {}) {
  const token = getToken();
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
async function guardarProgresoPublicado(progreso) {
  const infoR = await ghFetch(`/contents/${RUTA_PROGRESO}?ref=${REPO_BRANCH}`);
  let sha = null;
  if (infoR.status === 404) sha = null;
  else if (infoR.ok) sha = (await infoR.json()).sha;
  else throw await ghError(infoR);

  const contenido = JSON.stringify(progreso, null, 2);
  const bytes = new TextEncoder().encode(contenido);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  const body = {
    message: 'Actualiza avance de producción (' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ')',
    content: btoa(bin),
    branch: REPO_BRANCH,
  };
  if (sha) body.sha = sha;
  const r = await ghFetch(`/contents/${RUTA_PROGRESO}`, { method: 'PUT', body: JSON.stringify(body) });
  if (!r.ok) throw await ghError(r);
  return r.json();
}

// --- Estado de la pagina ---
let filasActuales = [];
let progresoBase = {};
const cambios = new Map(); // key -> nuevo producido

function renderKpis(filas) {
  const cont = document.getElementById('prod-kpis');
  if (!cont) return;
  const nvDistintas = new Set(filas.map((f) => f.nvNumero)).size;
  const totalSolicitado = filas.reduce((s, f) => s + f.totalSolicitado, 0);
  const totalDespachado = filas.reduce((s, f) => s + f.despachado, 0);
  const totalProducido = filas.reduce((s, f) => s + f.producido, 0);
  const listoSinDespachar = filas.reduce((s, f) => s + Math.max(0, f.producido - f.despachado), 0);
  const pctProducido = totalSolicitado ? (totalProducido / totalSolicitado) * 100 : null;
  const pctDespachado = totalSolicitado ? (totalDespachado / totalSolicitado) * 100 : null;

  cont.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-card-label">NV con canastillo pendiente</div>
      <div class="kpi-card-value">${fmtNum(nvDistintas)}</div>
      <div class="kpi-card-sub">${fmtNum(filas.length)} líneas de armado</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-card-label">Unidades solicitadas</div>
      <div class="kpi-card-value">${fmtNum(totalSolicitado)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-card-label">% producido</div>
      <div class="kpi-card-value">${fmtPct(pctProducido)}</div>
      <div class="kpi-card-sub">${fmtNum(totalProducido)} de ${fmtNum(totalSolicitado)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-card-label">% despachado</div>
      <div class="kpi-card-value">${fmtPct(pctDespachado)}</div>
      <div class="kpi-card-sub">${fmtNum(totalDespachado)} de ${fmtNum(totalSolicitado)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-card-label">Listo esperando despacho</div>
      <div class="kpi-card-value${listoSinDespachar > 0 ? ' prod-listo-positivo' : ''}">${fmtNum(listoSinDespachar)}</div>
      <div class="kpi-card-sub">Producido menos despachado</div>
    </div>
  `;
}

/** Agrupa las filas por código CAN (una medida de poste por código) — a
 * diferencia de renderKpis, que suma todo junto, esto separa cuánto falta
 * por producir medida por medida. */
function computeResumenMedida(filas) {
  const porCodigo = new Map();
  filas.forEach((f) => {
    if (!porCodigo.has(f.codCan)) {
      const medida = f.armado.replace(/^Armado CANASTILLO poste /i, '').trim() || f.armado;
      porCodigo.set(f.codCan, { codCan: f.codCan, medida, nv: 0, solicitado: 0, producido: 0 });
    }
    const g = porCodigo.get(f.codCan);
    g.nv += 1;
    g.solicitado += f.totalSolicitado;
    g.producido += f.producido;
  });
  return Array.from(porCodigo.values()).sort((a, b) => a.codCan.localeCompare(b.codCan));
}

function renderResumenMedida(filas) {
  const cont = document.getElementById('prod-resumen-medida');
  if (!cont) return;
  const grupos = computeResumenMedida(filas);
  if (!grupos.length) {
    cont.innerHTML = '<p class="kpi-empty">No hay NV vigentes con línea de Armado CANASTILLO en este momento.</p>';
    return;
  }
  const filasHtml = grupos
    .map((g) => {
      const falta = Math.max(0, g.solicitado - g.producido);
      return `
        <tr>
          <td>${esc(g.medida)}<br><span class="prod-cod">${esc(g.codCan)}</span></td>
          <td>${fmtNum(g.nv)}</td>
          <td>${fmtNum(g.solicitado)}</td>
          <td class="prod-listo-positivo">${fmtNum(g.producido)}</td>
          <td style="color:${falta > 0 ? 'var(--warning)' : 'var(--success)'}; font-weight:700;">${fmtNum(falta)}</td>
          <td>${fmtPct(g.solicitado ? (g.producido / g.solicitado) * 100 : null)}</td>
        </tr>`;
    })
    .join('');
  cont.innerHTML = `
    <table class="kpi-table">
      <thead>
        <tr><th>Medida</th><th>NV</th><th>Solicitado</th><th>Listo (producido)</th><th>Falta por producir</th><th>% producido</th></tr>
      </thead>
      <tbody>${filasHtml}</tbody>
    </table>
  `;
}

function renderTabla(filas) {
  const cont = document.getElementById('prod-tabla');
  if (!cont) return;
  if (!filas.length) {
    cont.innerHTML = '<p class="kpi-empty">No hay NV vigentes con línea de Armado CANASTILLO en este momento.</p>';
    return;
  }
  const filasHtml = filas
    .map((f) => {
      const listo = Math.max(0, f.producido - f.despachado);
      const cambiado = cambios.has(f.key);
      return `
        <tr>
          <td>${esc(f.nvNumero)}</td>
          <td>${esc(f.cliente)}</td>
          <td>${esc(f.poste)}</td>
          <td>${esc(f.armado)}<br><span class="prod-cod">${esc(f.codCan)}</span></td>
          <td>${fmtNum(f.totalSolicitado)}</td>
          <td>${fmtNum(f.despachado)}</td>
          <td><input type="number" class="prod-input-producido${cambiado ? ' cambiado' : ''}" data-key="${esc(f.key)}"
                min="${f.despachado}" max="${f.totalSolicitado}" step="1" value="${f.producido}"></td>
          <td>${fmtPct(f.totalSolicitado ? (f.producido / f.totalSolicitado) * 100 : null)}</td>
          <td class="${listo > 0 ? 'prod-listo-positivo' : 'prod-listo-cero'}">${fmtNum(listo)}</td>
          <td>${f.fechaTermino ? f.fechaTermino.toLocaleDateString('es-CL') : 'N/A'}</td>
        </tr>`;
    })
    .join('');
  cont.innerHTML = `
    <table class="kpi-table">
      <thead>
        <tr>
          <th>NV</th><th>Cliente</th><th>Poste</th><th>Armado</th>
          <th>Solicitado</th><th>Despachado</th><th>Producido</th><th>% producido</th><th>Listo sin despachar</th><th>Fecha término posible</th>
        </tr>
      </thead>
      <tbody>${filasHtml}</tbody>
    </table>
  `;
  cont.querySelectorAll('.prod-input-producido').forEach((inp) => {
    inp.addEventListener('change', onCambioProducido);
  });
}

function onCambioProducido(e) {
  const inp = e.target;
  const key = inp.dataset.key;
  const fila = filasActuales.find((f) => f.key === key);
  if (!fila) return;
  let v = Math.round(Number(inp.value));
  if (isNaN(v)) v = fila.producido;
  // Despachado <= Producido <= Total solicitado: no puede haber salido mas
  // de lo que se armo, ni haberse armado mas de lo pedido.
  v = Math.max(fila.despachado, Math.min(fila.totalSolicitado, v));
  inp.value = v;
  fila.producido = v;
  const original = (progresoBase[key] && Number(progresoBase[key].producido)) || 0;
  if (v === original) cambios.delete(key);
  else cambios.set(key, v);
  inp.classList.toggle('cambiado', cambios.has(key));

  // Actualiza en el momento las dos celdas que dependen de "producido" sin
  // reconstruir toda la tabla (perdería el foco del resto de los inputs).
  const fila_tr = inp.closest('tr');
  if (fila_tr) {
    const listo = Math.max(0, fila.producido - fila.despachado);
    fila_tr.children[7].textContent = fmtPct(fila.totalSolicitado ? (fila.producido / fila.totalSolicitado) * 100 : null);
    fila_tr.children[8].textContent = fmtNum(listo);
    fila_tr.children[8].className = listo > 0 ? 'prod-listo-positivo' : 'prod-listo-cero';
  }

  renderKpis(filasActuales);
  renderResumenMedida(filasActuales);
  actualizarBotonGuardar();
}

function actualizarBotonGuardar() {
  const btn = document.getElementById('prod-guardar-btn');
  if (!btn) return;
  btn.disabled = cambios.size === 0;
  btn.textContent = cambios.size ? `Guardar ${cambios.size} cambio${cambios.size === 1 ? '' : 's'}` : 'Guardar cambios';
}

function msg(id, texto, ok) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = texto;
  el.className = 'prod-estado-token' + (ok === true ? ' ok' : ok === false ? ' mal' : '');
}

function setupConexion() {
  const cab = document.getElementById('prod-conexion-toggle');
  const body = document.getElementById('prod-conexion-body');
  const chevron = document.getElementById('prod-conexion-chevron');
  cab?.addEventListener('click', () => {
    const abierto = body.classList.toggle('abierto');
    chevron.textContent = abierto ? '▴' : '▾';
  });

  const input = document.getElementById('prod-token-input');
  const toggle = document.getElementById('prod-token-toggle');
  const guardar = document.getElementById('prod-token-guardar');
  const olvidar = document.getElementById('prod-token-olvidar');
  if (input) input.value = getToken();

  toggle?.addEventListener('click', () => {
    const mostrando = input.type === 'text';
    input.type = mostrando ? 'password' : 'text';
    toggle.innerHTML = mostrando ? '<i class="ti ti-eye"></i>' : '<i class="ti ti-eye-off"></i>';
  });
  guardar?.addEventListener('click', () => {
    setToken(input.value.trim());
    msg('prod-token-estado', 'Conexión guardada en este navegador.', true);
  });
  olvidar?.addEventListener('click', () => {
    setToken('');
    input.value = '';
    msg('prod-token-estado', 'Token olvidado.', true);
  });
}

function setupDetalleToggle() {
  const btn = document.getElementById('prod-detalle-toggle');
  const wrap = document.getElementById('prod-tabla-wrap');
  btn?.addEventListener('click', () => {
    const oculto = wrap.classList.toggle('hidden');
    btn.textContent = oculto ? '▾ Ver detalle' : '▴ Ocultar';
  });
}

function exportarExcel() {
  const headers = ['NV', 'Cliente', 'Poste', 'Armado', 'Código', 'Solicitado', 'Despachado', 'Producido', '% producido', 'Listo sin despachar', 'Fecha término posible'];
  const rows = filasActuales.map((f) => [
    f.nvNumero,
    f.cliente,
    f.poste,
    f.armado,
    f.codCan,
    f.totalSolicitado,
    f.despachado,
    f.producido,
    f.totalSolicitado ? Math.round((f.producido / f.totalSolicitado) * 1000) / 10 : '',
    Math.max(0, f.producido - f.despachado),
    f.fechaTermino ? f.fechaTermino.toLocaleDateString('es-CL') : '',
  ]);
  const ws = window.XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Produccion');
  window.XLSX.writeFile(wb, `produccion_canastillos_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

async function onGuardarCambios() {
  if (!cambios.size) return;
  if (!getToken()) {
    msg('prod-guardar-estado', 'Falta guardar un token de GitHub primero (sección de arriba).', false);
    document.getElementById('prod-conexion-body')?.classList.add('abierto');
    const chevron = document.getElementById('prod-conexion-chevron');
    if (chevron) chevron.textContent = '▴';
    return;
  }
  const btn = document.getElementById('prod-guardar-btn');
  btn.disabled = true;
  msg('prod-guardar-estado', 'Guardando…');
  try {
    const nuevo = { ...progresoBase };
    cambios.forEach((producido, key) => {
      nuevo[key] = { producido, actualizado: new Date().toISOString() };
    });
    await guardarProgresoPublicado(nuevo);
    progresoBase = nuevo;
    cambios.clear();
    renderTabla(filasActuales);
    actualizarBotonGuardar();
    msg('prod-guardar-estado', 'Guardado. GitHub Pages puede tardar uno o dos minutos en mostrar la versión nueva.', true);
  } catch (err) {
    msg('prod-guardar-estado', 'No se pudo guardar: ' + err.message, false);
    actualizarBotonGuardar();
  }
}

async function iniciar() {
  setupConexion();
  setupDetalleToggle();
  document.getElementById('prod-guardar-btn')?.addEventListener('click', onGuardarCambios);
  document.getElementById('prod-export-btn')?.addEventListener('click', exportarExcel);

  const [datos, progreso] = await Promise.all([fetchPublishedData(), leerProgresoPublicado()]);
  if (!datos || !datos.nvRecords) {
    document.getElementById('prod-kpis').innerHTML = '<p class="kpi-empty">No se pudieron cargar los datos publicados.</p>';
    document.getElementById('prod-resumen-medida').innerHTML = '';
    document.getElementById('prod-tabla').innerHTML = '';
    return;
  }
  progresoBase = progreso || {};
  filasActuales = computeFilas(datos.nvRecords, progresoBase);
  renderKpis(filasActuales);
  renderResumenMedida(filasActuales);
  renderTabla(filasActuales);
  actualizarBotonGuardar();
}

iniciar();
