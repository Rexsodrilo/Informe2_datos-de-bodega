// control.js — panel privado (control.html). Pendiente de confirmar con el
// usuario si esto debe pasar a leer un data_privado.json.gz aparte; por
// ahora, para partir simple, lee el mismo data.json.gz público (sin paso de
// subida adicional) — ver conversación del 2026-10-09.
import { isControlUnlocked, tryUnlockControl } from './authControl.js?v=1';
import { fetchPublishedData } from './dataPublish.js?v=17';
import { esRetiroAmplio, esSinRastro, normalizarPatente, getDateRange, semanaIsoDe, rangoSemanaIso } from './kpi.js?v=64';
import { startOfDay, endOfDay, startOfMonth, endOfMonth, isoWeekNumber, weekNumbersInRange } from './businessDates.js?v=16';

// Datos cargados una sola vez (ver renderContenido) y reusados por cada
// render de las tarjetas/alertas — así abrir o cerrar un detalle no necesita
// volver a pedir data.json.gz.
let nvRecordsCache = null;
let loadedAtCache = null;

function setupLogin() {
  const wrap = document.getElementById('control-login-wrap');
  const page = document.getElementById('control-page');
  const input = document.getElementById('control-password-input');
  const submit = document.getElementById('control-password-submit');
  const error = document.getElementById('control-password-error');
  const toggle = document.getElementById('control-password-toggle');

  function unlocked() {
    wrap.classList.add('hidden');
    page.classList.remove('hidden');
    renderContenido();
  }

  if (isControlUnlocked()) {
    unlocked();
    return;
  }

  toggle?.addEventListener('click', () => {
    const mostrando = input.type === 'text';
    input.type = mostrando ? 'password' : 'text';
    toggle.innerHTML = mostrando ? '<i class="ti ti-eye"></i>' : '<i class="ti ti-eye-off"></i>';
    input.focus();
  });

  input?.focus();
  submit?.addEventListener('click', async () => {
    error.textContent = '';
    try {
      const ok = await tryUnlockControl(input.value);
      if (ok) {
        unlocked();
      } else {
        error.textContent = 'Contraseña incorrecta.';
      }
    } catch (err) {
      // Pasa, por ejemplo, si la página se abre como archivo local
      // (file://) en vez de por http/https: crypto.subtle no está
      // disponible fuera de un "contexto seguro" y la verificación de la
      // contraseña no puede correr — no es que la contraseña esté mal.
      error.textContent = `No se pudo verificar la contraseña en este navegador (${err.message}). Si abriste el archivo control.html directamente (doble clic), pruébalo entrando por el sitio publicado o por un servidor local en vez de un archivo.`;
    }
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit.click();
  });
}

// Mismo criterio de "entregada" que usa kpi.js en NV entregadas
// Despacho/Retira (no exportado desde ahí — es una línea estable, igual se
// repite inline dentro de kpi.js en varios lugares).
function baseEntregadas(nv) {
  const esConcluida = nv.nvEstado === 'C';
  const esVigenteEntregada = nv.nvEstado === 'A' && (nv.guia || nv.factura) && nv.items.some((it) => it.salXDes === 0);
  return esConcluida || esVigenteEntregada;
}

function fmtMoney(n) {
  return (n || 0).toLocaleString('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 });
}

function auditorDe(nv) {
  return (nv.auditor || nv.auditorCorte || '').toString().trim().toLowerCase();
}

function hoyStr() {
  return new Date().toISOString().slice(0, 10);
}

function downloadXlsxSimple(filename, headers, rows) {
  const ws = window.XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Detalle');
  window.XLSX.writeFile(wb, filename);
}

// ---------------------------------------------------------------------------
// Filtro de fechas del panel (Día/Semana/Mes/Rango/Todo) — mismo criterio y
// estilo que el filtro de la barra lateral del dashboard público. Por ahora
// solo calcula y muestra el rango elegido: a qué secciones de este panel
// reemplaza (si a alguna) queda por definir (ver conversación 2026-10-10).
// ---------------------------------------------------------------------------
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
let fechaModo = 'semana'; // 'dia' | 'semana' | 'mes' | 'rango' | 'todo'
let fechaRefDate = new Date();
let mesSeleccionado = { year: new Date().getFullYear(), month: new Date().getMonth() };
let semanaSeleccionada = null; // semana ISO elegida (null = la semana en curso)
let rangoInicio = new Date(Date.now() - 30 * 86400000);
let rangoFin = new Date();

function pad2(n) {
  return String(n).padStart(2, '0');
}
function toInputDateValue(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function computeRangeControl() {
  if (fechaModo === 'dia') return getDateRange(fechaRefDate, 'dia');
  if (fechaModo === 'semana') return semanaSeleccionada ? rangoSemanaIso(semanaIsoDe(new Date()).anio, semanaSeleccionada) : getDateRange(fechaRefDate, 'semana');
  if (fechaModo === 'mes') {
    const base = new Date(mesSeleccionado.year, mesSeleccionado.month, 1);
    return { start: startOfMonth(base), end: endOfMonth(base) };
  }
  if (fechaModo === 'rango') return { start: startOfDay(rangoInicio), end: endOfDay(rangoFin) };
  return null; // 'todo' -> sin filtro de fecha
}

function formatFechaBadgeControl(range) {
  if (!range) return 'Todas las fechas';
  const fmt = (d) => `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`;
  const semanas = weekNumbersInRange(range.start, range.end);
  const semanasTxt = semanas.length <= 1 ? `Semana ${semanas[0]}` : `Semanas ${semanas[0]}–${semanas[semanas.length - 1]}`;
  return `Del ${fmt(range.start)} al ${fmt(range.end)} · ${semanasTxt}`;
}

function mesOptionsHtmlControl() {
  const maxMonth = mesSeleccionado.year === new Date().getFullYear() ? new Date().getMonth() : 11;
  let html = '';
  for (let m = 0; m <= maxMonth; m++) html += `<option value="${m}">${MESES[m]}</option>`;
  return html;
}

function semanaOptionsHtmlControl() {
  const hoy = new Date();
  const { anio, semana: actual } = semanaIsoDe(hoy);
  const total = isoWeekNumber(new Date(anio, 11, 28)); // el 28 de dic. siempre cae en la última semana
  const dm = (d) => `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}`;
  let html = '';
  for (let s = 1; s <= total; s++) {
    const { start, end } = rangoSemanaIso(anio, s);
    html += `<option value="${s}"${start > hoy ? ' disabled' : ''}>Semana ${s} · ${dm(start)} al ${dm(end)}${s === actual ? ' (actual)' : ''}</option>`;
  }
  return html;
}

function renderFiltroFecha() {
  const cont = document.getElementById('control-filtro-fecha-body');
  if (!cont) return;
  const range = computeRangeControl();
  cont.innerHTML = `
    <div class="control-fecha-pills">
      <button class="pill-btn${fechaModo === 'dia' ? ' active' : ''}" data-modo="dia">Día</button>
      <button class="pill-btn${fechaModo === 'semana' ? ' active' : ''}" data-modo="semana">Semana</button>
      <button class="pill-btn${fechaModo === 'mes' ? ' active' : ''}" data-modo="mes">Mes</button>
      <button class="pill-btn${fechaModo === 'rango' ? ' active' : ''}" data-modo="rango">Rango</button>
      <button class="pill-btn${fechaModo === 'todo' ? ' active' : ''}" data-modo="todo">Todo</button>
    </div>
    <input type="date" id="cf-fecha-input" class="control-fecha-input${fechaModo === 'dia' ? '' : ' hidden'}">
    <select id="cf-semana-select" class="control-fecha-input${fechaModo === 'semana' ? '' : ' hidden'}">${semanaOptionsHtmlControl()}</select>
    <select id="cf-mes-select" class="control-fecha-input${fechaModo === 'mes' ? '' : ' hidden'}">${mesOptionsHtmlControl()}</select>
    <div id="cf-rango-box" class="${fechaModo === 'rango' ? '' : 'hidden'}">
      <div class="control-fecha-rango-row"><label>Inicio</label><input type="date" id="cf-rango-inicio" class="control-fecha-input"></div>
      <div class="control-fecha-rango-row"><label>Fin</label><input type="date" id="cf-rango-fin" class="control-fecha-input"></div>
    </div>
    <span class="control-fecha-badge">${formatFechaBadgeControl(range)}</span>
  `;
  const fechaInput = document.getElementById('cf-fecha-input');
  if (fechaInput) fechaInput.value = toInputDateValue(fechaRefDate);
  const semanaSelect = document.getElementById('cf-semana-select');
  if (semanaSelect) semanaSelect.value = String(semanaSeleccionada ?? semanaIsoDe(new Date()).semana);
  const mesSelect = document.getElementById('cf-mes-select');
  if (mesSelect) mesSelect.value = String(mesSeleccionado.month);
  const inicioInput = document.getElementById('cf-rango-inicio');
  const finInput = document.getElementById('cf-rango-fin');
  if (inicioInput) inicioInput.value = toInputDateValue(rangoInicio);
  if (finInput) finInput.value = toInputDateValue(rangoFin);

  cont.querySelectorAll('[data-modo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      fechaModo = btn.dataset.modo;
      renderFiltroFecha();
    });
  });
  fechaInput?.addEventListener('change', (e) => {
    fechaRefDate = e.target.value ? new Date(e.target.value + 'T00:00:00') : fechaRefDate;
    renderFiltroFecha();
  });
  semanaSelect?.addEventListener('change', (e) => {
    const n = Number(e.target.value);
    semanaSeleccionada = n === semanaIsoDe(new Date()).semana ? null : n; // la semana en curso sigue siendo la "vigente"
    renderFiltroFecha();
  });
  mesSelect?.addEventListener('change', (e) => {
    mesSeleccionado = { ...mesSeleccionado, month: Number(e.target.value) };
    renderFiltroFecha();
  });
  inicioInput?.addEventListener('change', (e) => {
    rangoInicio = e.target.value ? new Date(e.target.value + 'T00:00:00') : rangoInicio;
    if (rangoInicio > rangoFin) {
      rangoFin = rangoInicio;
      if (finInput) finInput.value = toInputDateValue(rangoFin);
    }
    renderFiltroFecha();
  });
  finInput?.addEventListener('change', (e) => {
    rangoFin = e.target.value ? new Date(e.target.value + 'T00:00:00') : rangoFin;
    if (rangoFin < rangoInicio) {
      rangoInicio = rangoFin;
      if (inicioInput) inicioInput.value = toInputDateValue(rangoInicio);
    }
    renderFiltroFecha();
  });
}

// ---------------------------------------------------------------------------
// Reglas de negocio de cada sección
// ---------------------------------------------------------------------------

// "Universo Despacho" tal como lo cuenta la pestaña pública "NV entregadas
// Despacho" desde el 2026-10-09: entregada, no-retiro, y sin ser una NV "sin
// rastro" (ver esSinRastro en kpi.js) — esas se muestran aparte, más abajo.
function esDespachoUniverso(nv) {
  return baseEntregadas(nv) && !esRetiroAmplio(nv) && !esSinRastro(nv);
}

// "NV sin rastro": estado C sin ningún indicio de despacho real (sin
// chofer, patente, guía, factura, auditor ni OP_Picking). El usuario
// confirmó el 2026-10-09 que es un error de creación o una cancelación de
// pedido, no un despacho real, y que mientras no exista un tratamiento
// definitivo se deben ver aparte, acá, sin contarse en el panel público.
// `esSinRastro` ya trae su propia ventana fija de 15 días (ver kpi.js): sin
// eso, la condición coincidía con el 72% de todo el histórico (14.598 NV) —
// medido antes de aplicarse, ver Reglas de negocio y su ubicación.
function computeNvSinRastro(nvRecords) {
  return nvRecords
    .filter((nv) => esSinRastro(nv))
    .slice()
    .sort((a, b) => (b.fecCreacion?.getTime() || 0) - (a.fecCreacion?.getTime() || 0));
}

// "Guías sin factura": tiene número de guía pero no de factura — venta ya
// despachada (hay guía) que todavía no se facturó. Medido antes de
// construir (2026-10-09): 125 NV en todo el histórico (124 estado A, 1
// estado C), sin crecer de forma descontrolada como otras reglas de hoy, así
// que no necesita ventana de fecha — se listan todas.
function computeGuiasSinFactura(nvRecords) {
  return nvRecords
    .filter((nv) => nv.guia && !nv.factura)
    .slice()
    .sort((a, b) => (b.fecCreacion?.getTime() || 0) - (a.fecCreacion?.getTime() || 0));
}

// "Retira atrasadas con stock": dentro del universo Retira (mismo criterio
// que la pestaña NV entregadas Retira), las que tienen fecha compromiso
// vencida en los últimos 15 días (igual que la alerta "Atrasadas" de NV por
// entregar) Y alguna línea pendiente con stock disponible al corte — o sea,
// no es falta de inventario lo que las tiene atrasadas.
function computeRetiraAtrasadasConStock(nvRecords) {
  const fin = new Date();
  fin.setHours(23, 59, 59, 999);
  const inicio = new Date();
  inicio.setDate(inicio.getDate() - 14);
  inicio.setHours(0, 0, 0, 0);

  const universoRetira = nvRecords.filter((nv) => baseEntregadas(nv) && esRetiroAmplio(nv));
  const atrasadas = universoRetira.filter((nv) => {
    if (!nv.fechaCompromiso || nv.fechaCompromiso < inicio || nv.fechaCompromiso > fin) return false;
    const saldo = nv.items.reduce((s, it) => s + (it.salXDes || 0), 0);
    return saldo !== 0;
  });
  return atrasadas.filter((nv) => nv.items.some((it) => (it.salXDes || 0) > 0 && !it.quiebre));
}

const FECHA_MINIMA_COORDINACION = new Date('2020-01-01');
function coordinacionValida(fecha) {
  return fecha && !isNaN(fecha.getTime()) && fecha >= FECHA_MINIMA_COORDINACION ? fecha : null;
}
function startOfDayLocal(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// "Coordinadas el mismo día de creación, sin hora registrada": F_coordinacion
// no trae hora (siempre 00:00), así que para esos casos no se puede medir el
// tiempo real de entrega — "Tiempo promedio de entrega" (pestaña NV
// entregadas Despacho) ya las excluye del promedio; esto muestra cuántas son
// y de qué canal, para seguimiento interno. Verificado 2026-10-09: es sobre
// todo canal Despacho (92,5%), NO Ecommerce (45,7%, el más bajo de los 3).
function computeCoordinadasMismoDia(nvRecords) {
  const universoDespacho = nvRecords.filter(esDespachoUniverso);
  const conCoordinacion = universoDespacho.filter((nv) => nv.fecCreacion && coordinacionValida(nv.fCoordinacion));
  const mismoDia = conCoordinacion.filter(
    (nv) => startOfDayLocal(nv.fecCreacion).getTime() === startOfDayLocal(nv.fCoordinacion).getTime()
  );
  const porCanal = {};
  mismoDia.forEach((nv) => {
    const c = nv.canal || '(sin canal)';
    porCanal[c] = (porCanal[c] || 0) + 1;
  });
  return { total: conCoordinacion.length, mismoDia, mismoDiaCount: mismoDia.length, porCanal };
}

// Clasifica una NV de "NV entregadas Despacho" por patente, igual que la
// zona Transporte del dashboard público (Flota propia / Transporte externo),
// pero dejando cada NV identificable (no solo el conteo) para poder filtrar
// por patente y bajar el detalle. "Sin clasificar" es el caso que el usuario
// pidió poder revisar manualmente: no tiene patente, no es transporte
// externo y no es Ecommerce (auditor vacío o Matías) — no hay cómo saber
// cómo salió esa NV.
function categorizarTransporte(nv) {
  const trans = (nv.trans || '').toString().trim().toUpperCase();
  if (trans === 'EXTR') return 'Externa';
  const patente = (nv.patente || '').toString().trim().toUpperCase();
  if (patente && patente !== 'EXTR') return normalizarPatente(patente);
  const isEcom = (nv.canal || '').toString().toUpperCase().includes('ECOM');
  const auditor = auditorDe(nv);
  if (isEcom && (auditor === '' || auditor === 'matias')) return 'Ecommerce (sin patente)';
  return 'Sin clasificar';
}

// Semana actual (lunes a domingo), mismo rango que usa por defecto la
// pestaña pública "NV entregadas Despacho" — el panel privado no tiene
// selector de fecha propio, así que se deja fijo en la semana vigente.
function computeTransporteDespachoSemana(nvRecords) {
  const range = getDateRange(new Date(), 'semana');
  const universo = nvRecords.filter(
    (nv) => esDespachoUniverso(nv) && nv.fecCreacion && nv.fecCreacion >= range.start && nv.fecCreacion <= range.end
  );
  return { range, filas: universo.map((nv) => ({ nv, categoria: categorizarTransporte(nv) })) };
}

// ---------------------------------------------------------------------------
// Tarjetas: cada una es compacta y cerrada por defecto; "▾ Ver detalle" abre
// la tabla completa. Organizadas en una grilla (.control-cards-grid) en vez
// de apiladas a lo largo, para que el panel se lea de un vistazo — pedido
// del usuario el 2026-10-10 ("no se ve con sentido").
// ---------------------------------------------------------------------------
let abiertos = {
  retiraAtrasadas: false,
  mismoDia: false,
  sinRastro: false,
  guiasSinFactura: false,
  transporte: false,
};
// Descripción (la nota larga de cada tarjeta) empieza oculta, en su propio
// desplegable — separado de "Ver detalle" — para que las tarjetas cerradas
// se vean todas de un vistazo sin scroll (pedido 2026-10-10).
let descAbiertos = {
  retiraAtrasadas: false,
  mismoDia: false,
  sinRastro: false,
  guiasSinFactura: false,
  transporte: false,
};
let filtroPatenteActivo = 'Todas';

function tarjeta({ key, titulo, nota, valorPrincipal, subValor, detalleHtml, ancha }) {
  const abierto = abiertos[key];
  const descAbierta = descAbiertos[key];
  return `
    <div class="zone-box control-card${ancha ? ' control-card--ancha' : ''}">
      <h3 class="np-canvas-title">${titulo}</h3>
      <button class="pill-btn control-desc-toggle" data-desc-toggle="${key}">${descAbierta ? '▴ Descripción' : '▾ Descripción'}</button>
      ${descAbierta ? `<p class="kpi-note">${nota}</p>` : ''}
      <div class="kpi-card" style="max-width:260px; margin:10px 0;">
        <div class="kpi-card-label">NV</div>
        <div class="kpi-card-value">${valorPrincipal}</div>
        <div class="kpi-card-sub">${subValor}</div>
        <button class="pill-btn" data-toggle="${key}">${abierto ? '▴ Ocultar' : '▾ Ver detalle'}</button>
      </div>
      ${abierto ? detalleHtml : ''}
    </div>
  `;
}

function renderCardRetiraAtrasadas() {
  const lista = computeRetiraAtrasadasConStock(nvRecordsCache)
    .slice()
    .sort((a, b) => (a.cliente || '').localeCompare(b.cliente || ''));
  const monto = lista.reduce((s, nv) => s + (nv.montoPorDespachar || 0), 0);
  const hoy = startOfDayLocal(new Date());
  const filas = lista
    .map((nv) => {
      const dias = Math.round((hoy - startOfDayLocal(nv.fechaCompromiso)) / 86400000);
      return `<tr>
        <td>${nv.nvNumero}</td><td>${nv.cliente || ''}</td><td>${auditorDe(nv) || '(vacío)'}</td>
        <td>${fmtMoney(nv.montoPorDespachar)}</td><td>${nv.fechaCompromiso.toLocaleDateString('es-CL')}</td>
        <td>${dias}</td><td>${nv.vendedor || ''}</td>
      </tr>`;
    })
    .join('');
  const detalleHtml = `
    <button class="pill-btn" data-export="retiraAtrasadas">⬇ Exportar Excel</button>
    <div class="kpi-table-scroll" style="margin-top:8px;">
      <table class="kpi-table">
        <thead><tr><th>NV</th><th>Cliente</th><th>Auditor</th><th>Monto pendiente</th><th>Fecha compromiso</th><th>Días de atraso</th><th>Vendedor</th></tr></thead>
        <tbody>${filas || '<tr><td colspan="7">Sin casos ahora mismo.</td></tr>'}</tbody>
      </table>
    </div>`;
  return tarjeta({
    key: 'retiraAtrasadas',
    titulo: 'Retira atrasadas con stock disponible (últimos 15 días)',
    nota: 'Dentro del universo "NV entregadas Retira" (auditor Yuvitsa, o sin chofer/patente pero con guía o factura): compromiso vencido y con stock al corte en alguna línea pendiente — no es falta de inventario.',
    valorPrincipal: lista.length,
    subValor: `${fmtMoney(monto)} pendiente`,
    detalleHtml,
  });
}

function renderCardMismoDia() {
  const stats = computeCoordinadasMismoDia(nvRecordsCache);
  const filasPorCanal = Object.entries(stats.porCanal)
    .sort((a, b) => b[1] - a[1])
    .map(([canal, n]) => `<tr><td>${canal}</td><td>${n}</td><td>${((n / stats.mismoDiaCount) * 100).toFixed(1)}%</td></tr>`)
    .join('');
  const detalleHtml = `
    <button class="pill-btn" data-export="mismoDia">⬇ Exportar Excel</button>
    <table class="kpi-table" style="margin-top:8px; max-width:420px;">
      <thead><tr><th>Canal</th><th>NV</th><th>%</th></tr></thead>
      <tbody>${filasPorCanal}</tbody>
    </table>`;
  return tarjeta({
    key: 'mismoDia',
    titulo: 'Coordinadas el mismo día de creación (sin hora registrada)',
    nota: 'F_coordinacion no trae hora (siempre 00:00), así que para estas NV no se puede medir el tiempo real de entrega — "Tiempo promedio de entrega" (NV entregadas Despacho) ya las excluye del promedio. No es un problema de Ecommerce: es sobre todo canal Despacho.',
    valorPrincipal: stats.mismoDiaCount,
    subValor: `de ${stats.total} con coordinación válida (${((stats.mismoDiaCount / stats.total) * 100).toFixed(1)}%) · todo el histórico`,
    detalleHtml,
  });
}

function renderCardSinRastro() {
  const sinRastro = computeNvSinRastro(nvRecordsCache);
  const monto = sinRastro.reduce((s, nv) => s + (nv.montoTotal || 0), 0);
  const filas = sinRastro
    .map((nv) => `<tr>
      <td>${nv.nvNumero}</td><td>${nv.cliente || ''}</td><td>${nv.canal || ''}</td>
      <td>${fmtMoney(nv.montoTotal)}</td><td>${nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : ''}</td>
      <td>${nv.vendedor || ''}</td>
    </tr>`)
    .join('');
  const detalleHtml = `
    <button class="pill-btn" data-export="sinRastro">⬇ Exportar Excel</button>
    <div class="kpi-table-scroll" style="margin-top:8px;">
      <table class="kpi-table">
        <thead><tr><th>NV</th><th>Cliente</th><th>Canal</th><th>Monto</th><th>Fecha de creación</th><th>Vendedor</th></tr></thead>
        <tbody>${filas || '<tr><td colspan="6">Sin casos ahora mismo.</td></tr>'}</tbody>
      </table>
    </div>`;
  return tarjeta({
    key: 'sinRastro',
    titulo: 'NV sin rastro (revisión manual)',
    nota: 'Estado C, sin chofer, sin patente, sin guía ni factura, sin auditor y sin OP_Picking — ningún indicio de qué pasó con la NV (posible error de creación o cancelación de pedido). No se cuentan en "NV entregadas Despacho" desde el 2026-10-09. Últimos 15 días por fecha de creación (igual ventana que "Atrasadas").',
    valorPrincipal: sinRastro.length,
    subValor: fmtMoney(monto),
    detalleHtml,
  });
}

function renderCardGuiasSinFactura() {
  const guiasSinFactura = computeGuiasSinFactura(nvRecordsCache);
  const monto = guiasSinFactura.reduce((s, nv) => s + (nv.montoTotal || 0), 0);
  const filas = guiasSinFactura
    .map((nv) => `<tr>
      <td>${nv.nvNumero}</td><td>${nv.cliente || ''}</td><td>${nv.canal || ''}</td><td>${nv.nvEstado}</td>
      <td>${nv.guia}</td><td>${fmtMoney(nv.montoTotal)}</td>
      <td>${nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : ''}</td><td>${nv.vendedor || ''}</td>
    </tr>`)
    .join('');
  const detalleHtml = `
    <button class="pill-btn" data-export="guiasSinFactura">⬇ Exportar Excel</button>
    <div class="kpi-table-scroll" style="margin-top:8px;">
      <table class="kpi-table">
        <thead><tr><th>NV</th><th>Cliente</th><th>Canal</th><th>Estado</th><th>Guía</th><th>Monto</th><th>Fecha de creación</th><th>Vendedor</th></tr></thead>
        <tbody>${filas || '<tr><td colspan="8">Sin casos ahora mismo.</td></tr>'}</tbody>
      </table>
    </div>`;
  return tarjeta({
    key: 'guiasSinFactura',
    titulo: 'Guías sin factura (revisión manual)',
    nota: 'Tiene número de guía pero no de factura — venta ya despachada que todavía no se facturó. Sin ventana de fecha: históricamente se mantiene chico, se listan todas.',
    valorPrincipal: guiasSinFactura.length,
    subValor: fmtMoney(monto),
    detalleHtml,
  });
}

function renderCardTransporte() {
  const { range, filas } = computeTransporteDespachoSemana(nvRecordsCache);
  const categorias = ['Todas', ...new Set(filas.map((f) => f.categoria))].sort((a, b) => (a === 'Todas' ? -1 : b === 'Todas' ? 1 : a.localeCompare(b)));
  const filasFiltradas = filtroPatenteActivo === 'Todas' ? filas : filas.filter((f) => f.categoria === filtroPatenteActivo);
  const monto = filasFiltradas.reduce((s, f) => s + (f.nv.valorDespacho || f.nv.montoTotal || 0), 0);
  const filasTabla = filasFiltradas
    .slice()
    .sort((a, b) => (a.nv.cliente || '').localeCompare(b.nv.cliente || ''))
    .map(
      ({ nv, categoria }) => `<tr>
        <td>${nv.nvNumero}</td><td>${nv.cliente || ''}</td><td>${nv.canal || ''}</td><td>${categoria}</td>
        <td>${auditorDe(nv) || '(vacío)'}</td><td>${nv.statusDes || ''}</td>
        <td>${fmtMoney(nv.valorDespacho || nv.montoTotal)}</td>
        <td>${nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : ''}</td><td>${nv.vendedor || ''}</td>
      </tr>`
    )
    .join('');
  const detalleHtml = `
    <div class="control-fecha-pills" style="margin-top:4px;">
      ${categorias.map((c) => `<button class="pill-btn${c === filtroPatenteActivo ? ' active' : ''}" data-categoria="${c}">${c}${c !== 'Todas' ? ` (${filas.filter((f) => f.categoria === c).length})` : ` (${filas.length})`}</button>`).join('')}
    </div>
    <div class="kpi-card" style="max-width:260px; margin:10px 0;">
      <div class="kpi-card-label">${filtroPatenteActivo}</div>
      <div class="kpi-card-value">${filasFiltradas.length} NV</div>
      <div class="kpi-card-sub">${fmtMoney(monto)}</div>
    </div>
    <button class="pill-btn" data-export="transporte">⬇ Exportar Excel</button>
    <div class="kpi-table-scroll" style="margin-top:8px;">
      <table class="kpi-table">
        <thead><tr><th>NV</th><th>Cliente</th><th>Canal</th><th>Categoría</th><th>Auditor</th><th>Status des</th><th>Monto</th><th>Fecha creación</th><th>Vendedor</th></tr></thead>
        <tbody>${filasTabla || '<tr><td colspan="9">Sin NV en esta categoría.</td></tr>'}</tbody>
      </table>
    </div>`;
  return tarjeta({
    key: 'transporte',
    titulo: 'Transporte Despacho — detalle por patente',
    nota: `Semana vigente (${range.start.toLocaleDateString('es-CL')} – ${range.end.toLocaleDateString('es-CL')}), mismo universo que "NV entregadas Despacho" pública. "Sin clasificar" vale la pena revisarlas a mano.`,
    valorPrincipal: filas.length,
    subValor: `${categorias.length - 1} categorías`,
    detalleHtml,
    ancha: true,
  });
}

function renderPanel() {
  const grid = document.getElementById('control-cards-grid');
  if (!grid || !nvRecordsCache) return;
  grid.innerHTML = [
    renderCardRetiraAtrasadas(),
    renderCardMismoDia(),
    renderCardSinRastro(),
    renderCardGuiasSinFactura(),
    renderCardTransporte(),
  ].join('');
}

function ejecutarExport(key) {
  if (key === 'retiraAtrasadas') {
    const lista = computeRetiraAtrasadasConStock(nvRecordsCache).slice().sort((a, b) => (a.cliente || '').localeCompare(b.cliente || ''));
    downloadXlsxSimple(
      `retira_atrasadas_con_stock_${hoyStr()}.xlsx`,
      ['NV', 'Cliente', 'Auditor', 'Monto pendiente', 'Fecha compromiso', 'Vendedor'],
      lista.map((nv) => [nv.nvNumero, nv.cliente, auditorDe(nv) || '', Math.round(nv.montoPorDespachar || 0), nv.fechaCompromiso.toLocaleDateString('es-CL'), nv.vendedor || ''])
    );
  } else if (key === 'mismoDia') {
    const stats = computeCoordinadasMismoDia(nvRecordsCache);
    downloadXlsxSimple(
      `coordinadas_mismo_dia_${hoyStr()}.xlsx`,
      ['NV', 'Cliente', 'Canal', 'Fecha de creación', 'Vendedor'],
      stats.mismoDia.map((nv) => [nv.nvNumero, nv.cliente, nv.canal, nv.fecCreacion.toLocaleDateString('es-CL'), nv.vendedor || ''])
    );
  } else if (key === 'sinRastro') {
    const sinRastro = computeNvSinRastro(nvRecordsCache);
    downloadXlsxSimple(
      `nv_sin_rastro_${hoyStr()}.xlsx`,
      ['NV', 'Cliente', 'Canal', 'Monto', 'Fecha de creación', 'Vendedor'],
      sinRastro.map((nv) => [nv.nvNumero, nv.cliente, nv.canal, Math.round(nv.montoTotal || 0), nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : '', nv.vendedor || ''])
    );
  } else if (key === 'guiasSinFactura') {
    const guiasSinFactura = computeGuiasSinFactura(nvRecordsCache);
    downloadXlsxSimple(
      `guias_sin_factura_${hoyStr()}.xlsx`,
      ['NV', 'Cliente', 'Canal', 'Estado', 'Guía', 'Monto', 'Fecha de creación', 'Vendedor'],
      guiasSinFactura.map((nv) => [nv.nvNumero, nv.cliente, nv.canal, nv.nvEstado, nv.guia, Math.round(nv.montoTotal || 0), nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : '', nv.vendedor || ''])
    );
  } else if (key === 'transporte') {
    const { filas } = computeTransporteDespachoSemana(nvRecordsCache);
    const filasFiltradas = filtroPatenteActivo === 'Todas' ? filas : filas.filter((f) => f.categoria === filtroPatenteActivo);
    downloadXlsxSimple(
      `transporte_despacho_${filtroPatenteActivo.replace(/[^a-z0-9]/gi, '_')}_${hoyStr()}.xlsx`,
      ['NV', 'Cliente', 'Canal', 'Categoría', 'Auditor', 'Status des', 'Monto', 'Fecha creación', 'Vendedor'],
      filasFiltradas.map(({ nv, categoria }) => [
        nv.nvNumero, nv.cliente, nv.canal, categoria, auditorDe(nv) || '', nv.statusDes || '',
        Math.round(nv.valorDespacho || nv.montoTotal || 0), nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : '', nv.vendedor || '',
      ])
    );
  }
}

async function renderContenido() {
  const body = document.getElementById('control-body');
  try {
    const data = await fetchPublishedData();
    if (!data) {
      body.innerHTML = '<p class="kpi-empty">No se pudo cargar data/data.json.gz.</p>';
      return;
    }
    nvRecordsCache = data.nvRecords;
    loadedAtCache = data.loadedAt;

    body.innerHTML = `
      <div class="control-layout">
        <div class="control-filtro-col">
          <div class="zone-box">
            <h3 class="np-canvas-title">Filtro de fechas</h3>
            <p class="kpi-note">Por ahora no filtra ninguna sección — se está dejando listo para decidir con cuáles conectarlo.</p>
            <div id="control-filtro-fecha-body"></div>
          </div>
        </div>
        <div class="control-cards-grid" id="control-cards-grid"></div>
      </div>
      <p class="kpi-note" style="margin-top:12px;">Datos cargados: ${loadedAtCache ? loadedAtCache.toLocaleString('es-CL') : 'N/A'}.</p>
    `;

    renderFiltroFecha();

    const grid = document.getElementById('control-cards-grid');
    grid.addEventListener('click', (e) => {
      const toggleBtn = e.target.closest('[data-toggle]');
      if (toggleBtn) {
        abiertos[toggleBtn.dataset.toggle] = !abiertos[toggleBtn.dataset.toggle];
        renderPanel();
        return;
      }
      const descToggleBtn = e.target.closest('[data-desc-toggle]');
      if (descToggleBtn) {
        descAbiertos[descToggleBtn.dataset.descToggle] = !descAbiertos[descToggleBtn.dataset.descToggle];
        renderPanel();
        return;
      }
      const exportBtn = e.target.closest('[data-export]');
      if (exportBtn) {
        ejecutarExport(exportBtn.dataset.export);
        return;
      }
      const catBtn = e.target.closest('[data-categoria]');
      if (catBtn) {
        filtroPatenteActivo = catBtn.dataset.categoria;
        renderPanel();
      }
    });

    renderPanel();
  } catch (err) {
    body.innerHTML = `<p class="kpi-empty">No se pudo cargar data.json.gz (${err.message}).</p>`;
  }
}

setupLogin();
