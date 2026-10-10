// kpi.js
// Cálculo de los indicadores de gerencia y render de cada sección
// (tarjetas + tablas + gráficos) en el panel principal del módulo KPI.

import {
  startOfDay,
  endOfDay,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  isoWeekNumber,
  weekNumbersInRange,
  hoursElapsed,
  lastBusinessDaysRange,
  previousMonthRange,
  yesterday,
  coordinacionValida,
  HOURS_PER_DAY,
  HOURS_LABEL,
} from './businessDates.js?v=16';
import { minutosToHora } from './dataLoader.js?v=20';

// Chart.js dibuja su texto (leyenda, ejes) en canvas con su propia fuente
// por defecto — no hereda el font-family de styles.css porque no es DOM/CSS.
// Sin esto, los gráficos de "Rendimiento del equipo" quedaban con una
// tipografía distinta al resto del dashboard (pedido explícito: una sola
// fuente en todas las visualizaciones).
if (window.Chart) {
  window.Chart.defaults.font.family = "'Inter', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";
}

const fmtMoney = (v) => '$' + Math.round(v || 0).toLocaleString('es-CL');
const fmtPct = (v) => (v === null || isNaN(v) ? 'N/A' : Math.round(v * 10) / 10 + '%');
const fmtFechaHora = (d) => (d ? `${d.toLocaleDateString('es-CL')} ${d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}` : '');

/** Cómo salió la NV de la bodega, para saber de un vistazo qué tipo de caso es. */
function tipoDespacho(nv) {
  if (nv.retiroMalMarcado) return 'Probable retiro en tienda (DESPACHADO sin chofer ni patente)';
  const patente = (nv.patente || '').toString().trim().toUpperCase();
  if (patente === 'EXTR') return 'Transporte externo';
  if (patente) return 'Flota propia';
  return 'Sin transporte asignado';
}

// ---------------------------------------------------------------------------
// Filtro de fecha (día / semana / mes) sobre F_coordinacion
// ---------------------------------------------------------------------------

export function getDateRange(refDate, mode) {
  // "Semana" y "Mes" son ventanas fijas relativas a hoy (no navegables con el
  // selector de fecha): la semana calendario vigente (lunes 00:00 a domingo
  // 23:59, alineada con el número de semana del año) y el mes calendario
  // anterior. Solo "Día" usa la fecha elegida (refDate). El modo "rango" se
  // resuelve aparte, en main.js, con el control de barra arrastrable.
  if (mode === 'semana') { const hoy = new Date(); return { start: startOfWeek(hoy), end: endOfWeek(hoy) }; }
  if (mode === 'mes') return previousMonthRange();
  return { start: startOfDay(refDate), end: endOfDay(refDate) };
}

function inRange(date, range) {
  if (!date) return false;
  return date >= range.start && date <= range.end;
}

// Semanas ISO (lunes a domingo; la semana 1 es la que contiene el primer jueves):
// la misma numeración que muestra el dashboard ("Semana 40"). Un año tiene 52 o 53.
// Exportadas para que el panel de control privado (control.js) arme su propio
// filtro de fecha con el mismo criterio de semana, sin duplicar la fórmula.
export function semanaIsoDe(fecha) {
  const jueves = startOfWeek(fecha);
  jueves.setDate(jueves.getDate() + 3); // el año ISO es el del jueves de esa semana
  return { anio: jueves.getFullYear(), semana: isoWeekNumber(fecha) };
}

/** Lunes 00:00 a domingo 23:59 de la semana ISO `semana` del año ISO `anio`. */
export function rangoSemanaIso(anio, semana) {
  const inicio = startOfWeek(new Date(anio, 0, 4)); // el 4 de enero siempre cae en la semana 1
  inicio.setDate(inicio.getDate() + (semana - 1) * 7);
  return { start: inicio, end: endOfWeek(inicio) };
}

/** Opciones del desplegable de semanas del año en curso, con las fechas de cada
 * una; las que todavía no empiezan quedan deshabilitadas. */
function semanaOptionsHtml() {
  const hoy = new Date();
  const { anio, semana: actual } = semanaIsoDe(hoy);
  const total = isoWeekNumber(new Date(anio, 11, 28)); // el 28 de dic. siempre cae en la última semana
  const dm = (d) => `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  let html = '';
  for (let s = 1; s <= total; s++) {
    const { start, end } = rangoSemanaIso(anio, s);
    html += `<option value="${s}"${start > hoy ? ' disabled' : ''}>Semana ${s} · ${dm(start)} al ${dm(end)}${s === actual ? ' (actual)' : ''}</option>`;
  }
  return html;
}

/** Descarga un .xlsx real (v\u00EDa SheetJS, ya cargado por index.html). */
function downloadXlsx(filename, headers, rows) {
  const ws = window.XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Detalle');
  window.XLSX.writeFile(wb, filename);
}

// ---------------------------------------------------------------------------
// Render de secciones
// ---------------------------------------------------------------------------

export function renderKpiSection(sectionId, nvRecords, contHodo, horarioCam, loadedAt) {
  const el = document.getElementById('kpi-panel');
  if (!el) return;

  switch (sectionId) {
    case 'notasPendientes':
      renderNotasPendientes(el, nvRecords);
      break;
    case 'notasConcluidas':
      renderNotasConcluidas(el, nvRecords, contHodo, horarioCam, loadedAt, 'despacho');
      break;
    case 'notasConcluidasRetira':
      renderNotasConcluidas(el, nvRecords, contHodo, horarioCam, loadedAt, 'retira');
      break;
    case 'rendimientoEquipo':
      renderRendimientoEquipo(el, nvRecords);
      break;
    case 'corte':
      renderCorte(el, nvRecords);
      break;
    default:
      el.innerHTML = '<p>Selecciona una sección.</p>';
  }
}

function kpiCard(label, value, sub) {
  return `<div class="kpi-card">
    <div class="kpi-card-label">${label}</div>
    <div class="kpi-card-value">${value}</div>
    ${sub ? `<div class="kpi-card-sub">${sub}</div>` : ''}
  </div>`;
}

function tableHtml(headers, rows) {
  const head = headers.map((h) => `<th>${h}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<table class="kpi-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// 0. Notas de venta pendientes — todas las NV en estado A (aprobadas por
//    comercial, pendientes de procesar por logística). Pestaña
//    independiente: maneja sus propios filtros (Bloqueado, Entrega, Fecha
//    sobre Fec_Cre), sin depender del selector global de arriba ni afectarlo.
// ---------------------------------------------------------------------------

function flashExportFeedback(btn) {
  if (!btn) return;
  const original = btn.textContent;
  btn.textContent = '✓ Descargado';
  btn.classList.add('is-success');
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove('is-success');
  }, 1600);
}

function renderNotasPendientes(el, nvRecords) {
  const pad = (n) => String(n).padStart(2, '0');
  const toInputDateValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

  let fechaModo = 'semana'; // 'dia' | 'semana' | 'mes' | 'rango' | 'todo'
  let fechaRefDate = yesterday(); // solo se usa si fechaModo === 'dia'
  let mesSeleccionado = { year: new Date().getFullYear(), month: new Date().getMonth() }; // solo si fechaModo === 'mes'
  let semanaSeleccionada = null; // solo si fechaModo === 'semana': semana ISO elegida en el desplegable (null = la semana en curso)
  let rangoInicio = new Date(Date.now() - 30 * 86400000); // solo si fechaModo === 'rango'
  let rangoFin = new Date();
  let searchTerm = ''; // busca por NV / cliente / vendedor
  let filtrosAbiertos = true; // caja de filtros del sidebar, plegable
  // Único estado de detalle expandible, compartido por las 4 tarjetas de
  // Zona 1 y por "Bloqueadas" (Zona 3): un solo espacio de detalle, no uno
  // por panel.
  let detalleActivo = null; // { tipo: 'zona1', id } | { tipo: 'bloqueadas' } | null
  let clienteFiltro = ''; // filtro de cliente dentro del panel de detalle compartido

  el.innerHTML = `
    <div class="np-header">
      <h2>Notas de ventas vigentes</h2>
      <p class="np-header-sub">Todas las NV en estado A: aprobadas por el área comercial, pendientes de que logística las procese.</p>
    </div>

    <div class="np-grid-2x2">
      <div class="zone-box zone-box--zona1">
        <div class="np-canvas-title-row">
          <h3 class="np-canvas-title">Estados Notas de venta</h3>
          <span class="np-zona1-badge" id="np-zona1-badge"></span>
        </div>
        <div id="np-kpis"></div>
      </div>

      <div class="zone-box zone-box--semana">
        <span class="zone-label zone-label--slate">Notas de ventas coordinadas</span>
        <div class="np-semana-panel" id="np-semana"></div>
      </div>

      <div class="zone-box zone-box--zona4">
        <h3 class="np-canvas-title">NV Con riesgo de quiebre por stock</h3>
        <div id="np-fillrate"></div>
      </div>

      <div class="zone-box zone-box--zona3">
        <h3 class="np-canvas-title">Alertas</h3>
        <div id="np-alertas"></div>
      </div>
    </div>

    <div class="zone-box zone-box--detalle hidden" id="np-detalle-box">
      <div id="np-detalle"></div>
    </div>
  `;

  function isDetalleActivo(tipo, id) {
    return !!detalleActivo && detalleActivo.tipo === tipo && (id === undefined || detalleActivo.id === id);
  }

  function setDetalleActivo(tipo, id) {
    detalleActivo = isDetalleActivo(tipo, id) ? null : { tipo, id };
    renderAll();
  }

  function mesOptionsHtml() {
    const maxMonth = mesSeleccionado.year === new Date().getFullYear() ? new Date().getMonth() : 11;
    let html = '';
    for (let m = 0; m <= maxMonth; m++) html += `<option value="${m}">${MESES[m]}</option>`;
    return html;
  }

  function renderSidebarFiltros() {
    const cont = document.getElementById('sidebar-filters');
    if (!cont) return;
    cont.innerHTML = `
      <div class="sb-box">
        <button class="sb-toggle${filtrosAbiertos ? '' : ' is-collapsed'}" id="sb-toggle-btn">
          <span>Contextuales a "Notas de venta vigentes"</span>
          <span class="sb-toggle-arrow">▾</span>
        </button>
        <div class="sb-body${filtrosAbiertos ? '' : ' hidden'}" id="sb-body">
          <div>
            <div class="sb-group-label">Fecha de creación</div>
            <div class="sb-pills" id="sb-pills-fecha">
              <button class="sb-pill${fechaModo === 'dia' ? ' active' : ''}" data-value="dia">Día</button>
              <button class="sb-pill${fechaModo === 'semana' ? ' active' : ''}" data-value="semana">Semana</button>
              <button class="sb-pill${fechaModo === 'mes' ? ' active' : ''}" data-value="mes">Mes</button>
              <button class="sb-pill${fechaModo === 'rango' ? ' active' : ''}" data-value="rango">Rango 📅</button>
              <button class="sb-pill${fechaModo === 'todo' ? ' active' : ''}" data-value="todo">Todo</button>
            </div>
            <input type="date" id="sb-fecha-input" class="${fechaModo === 'dia' ? '' : 'hidden'}">
            <select id="sb-semana-select" class="${fechaModo === 'semana' ? '' : 'hidden'}">${semanaOptionsHtml()}</select>
            <select id="sb-mes-select" class="${fechaModo === 'mes' ? '' : 'hidden'}">${mesOptionsHtml()}</select>
            <div id="sb-rango-box" class="${fechaModo === 'rango' ? '' : 'hidden'}">
              <div class="sb-rango-row">
                <span class="sb-rango-dot sb-rango-dot--inicio"></span><label>Inicio</label>
                <input type="date" id="sb-rango-inicio">
              </div>
              <div class="sb-rango-row">
                <span class="sb-rango-dot sb-rango-dot--fin"></span><label>Fin</label>
                <input type="date" id="sb-rango-fin">
              </div>
            </div>
            <span class="sb-fecha-label" id="sb-fecha-label"></span>
          </div>
          <div>
            <div class="sb-group-label">Buscar</div>
            <div class="sb-search-box">
              <span class="sb-search-icon">🔍</span>
              <input type="text" id="sb-search-input" placeholder="NV, cliente o vendedor..." value="${searchTerm}">
            </div>
          </div>
          <button class="sb-limpiar" id="sb-limpiar-btn">✕ Limpiar filtros</button>
        </div>
      </div>
      <p class="sidebar-note">Nota: "Tipo de entrega" (Retira/Despacho) se retiró de aquí — se usará en otro reporte.</p>
    `;

    const dateInput = document.getElementById('sb-fecha-input');
    if (dateInput) dateInput.value = toInputDateValue(fechaRefDate);
    const semanaSelect = document.getElementById('sb-semana-select');
    if (semanaSelect) semanaSelect.value = String(semanaSeleccionada ?? semanaIsoDe(new Date()).semana);
    const mesSelect = document.getElementById('sb-mes-select');
    if (mesSelect) mesSelect.value = String(mesSeleccionado.month);
    const inicioInput = document.getElementById('sb-rango-inicio');
    const finInput = document.getElementById('sb-rango-fin');
    if (inicioInput) inicioInput.value = toInputDateValue(rangoInicio);
    if (finInput) finInput.value = toInputDateValue(rangoFin);

    document.getElementById('sb-toggle-btn')?.addEventListener('click', () => {
      filtrosAbiertos = !filtrosAbiertos;
      renderSidebarFiltros();
    });
    document.querySelectorAll('#sb-pills-fecha .sb-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        fechaModo = btn.dataset.value;
        renderSidebarFiltros();
        renderAll();
      });
    });
    dateInput?.addEventListener('change', (e) => {
      fechaRefDate = e.target.value ? new Date(e.target.value + 'T00:00:00') : yesterday();
      renderAll();
    });
    semanaSelect?.addEventListener('change', (e) => {
      const n = Number(e.target.value);
      semanaSeleccionada = n === semanaIsoDe(new Date()).semana ? null : n; // la semana en curso sigue siendo la "vigente"
      renderAll();
    });
    mesSelect?.addEventListener('change', (e) => {
      mesSeleccionado = { ...mesSeleccionado, month: Number(e.target.value) };
      renderAll();
    });
    inicioInput?.addEventListener('change', (e) => {
      rangoInicio = e.target.value ? new Date(e.target.value + 'T00:00:00') : rangoInicio;
      if (rangoInicio > rangoFin) {
        rangoFin = rangoInicio;
        if (finInput) finInput.value = toInputDateValue(rangoFin);
      }
      renderAll();
    });
    finInput?.addEventListener('change', (e) => {
      rangoFin = e.target.value ? new Date(e.target.value + 'T00:00:00') : rangoFin;
      if (rangoFin < rangoInicio) {
        rangoInicio = rangoFin;
        if (inicioInput) inicioInput.value = toInputDateValue(rangoInicio);
      }
      renderAll();
    });
    document.getElementById('sb-search-input')?.addEventListener('input', (e) => {
      searchTerm = e.target.value;
      renderAll();
    });
    document.getElementById('sb-limpiar-btn')?.addEventListener('click', limpiarFiltros);
  }

  function computeRange() {
    if (fechaModo === 'dia') return getDateRange(fechaRefDate, 'dia');
    if (fechaModo === 'semana') return semanaSeleccionada ? rangoSemanaIso(semanaIsoDe(new Date()).anio, semanaSeleccionada) : getDateRange(fechaRefDate, 'semana');
    if (fechaModo === 'mes') {
      const base = new Date(mesSeleccionado.year, mesSeleccionado.month, 1);
      return { start: startOfMonth(base), end: endOfMonth(base) };
    }
    if (fechaModo === 'rango') return { start: startOfDay(rangoInicio), end: endOfDay(rangoFin) };
    return null; // 'todo' -> sin filtro de fecha
  }

  /** Texto contextual junto al título de "Estados Notas de venta": fecha(s)
   * activas + a qué semana(s) del año corresponden. */
  function formatFechaBadge(range) {
    if (!range) return 'Todas las fechas';
    const fmt = (d) => d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' });
    const semanas = weekNumbersInRange(range.start, range.end);
    const semanasTxt = semanas.length <= 1 ? `Semana ${semanas[0]}` : `Semanas ${semanas[0]}–${semanas[semanas.length - 1]}`;
    if (fechaModo === 'semana') return `${semanaSeleccionada ? 'Semana' : 'Semana vigente'}: ${fmt(range.start)} – ${fmt(range.end)} · ${semanasTxt}`;
    if (fechaModo === 'dia') return `${fmt(range.start)} · ${semanasTxt}`;
    if (fechaModo === 'mes') return `${range.start.toLocaleDateString('es-CL', { month: 'long', year: 'numeric' })} · ${semanasTxt}`;
    return `${fmt(range.start)} – ${fmt(range.end)} · ${semanasTxt}`; // 'rango'
  }

  /** ¿La NV coincide con el texto de la búsqueda (NV, cliente o vendedor)? Sin texto, todas. */
  function coincideConBusqueda(nv) {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return true;
    return (
      (nv.nvNumero || '').toLowerCase().includes(term) ||
      (nv.cliente || '').toLowerCase().includes(term) ||
      (nv.vendedor || '').toLowerCase().includes(term)
    );
  }

  function computeUniverso() {
    const range = computeRange();

    const label = document.getElementById('sb-fecha-label');
    if (label) {
      label.textContent = !range
        ? 'Todas las fechas'
        : range.start.toLocaleDateString('es-CL') === range.end.toLocaleDateString('es-CL')
        ? range.start.toLocaleDateString('es-CL')
        : `${range.start.toLocaleDateString('es-CL')} – ${range.end.toLocaleDateString('es-CL')}`;
    }
    const badge = document.getElementById('np-zona1-badge');
    if (badge) badge.textContent = formatFechaBadge(range);

    return nvRecords.filter((nv) => {
      if (nv.nvEstado !== 'A') return false;
      if (range && !inRange(nv.fecCreacion, range)) return false;
      return coincideConBusqueda(nv);
    });
  }

  function computePool(universo) {
    // --- Zona 1: Estados de notas de venta Aceptadas ---
    // "Notas en proceso de preparación": OP_Picking (Corte) ya asignado,
    // pero Status des y Trans (ambos de Corte) todavía vacíos — el picking
    // arrancó pero aún no se le asigna transporte.
    const enProcesoPreparacion = universo.filter((nv) => nv.opPickingCorte && !nv.statusDes && !nv.trans);
    // "Notas de venta en despacho": (a) las que ya cumplen todo — OP_Picking
    // asignado, Status des vacío, Trans y Auditor (ambos de Corte) asignados,
    // listas para salir — y (b) las coordinadas (F_coordinacion) para HOY que
    // no cumplen eso: la planilla todavía no se llena con ese nivel de
    // exactitud, así que la coordinación del día es lo que mejor dice qué sale
    // hoy. (b) es la columna de hoy del tablero "Notas de ventas coordinadas":
    // respeta la búsqueda, pero no el filtro de fechas (siempre es "hoy").
    // Una NV que cae en (a) y en (b) se cuenta una sola vez.
    const listasParaSalir = universo.filter((nv) => nv.opPickingCorte && !nv.statusDes && nv.trans && nv.auditorCorte);
    const hoy = startOfDay(new Date()).getTime();
    const coordinadasHoy = nvRecords.filter(
      (nv) => nv.nvEstado === 'A' && nv.fCoordinacion && startOfDay(nv.fCoordinacion).getTime() === hoy && coincideConBusqueda(nv)
    );
    const enDespacho = [...new Map([...listasParaSalir, ...coordinadasHoy].map((nv) => [nv.nvNumero, nv])).values()];

    // --- Zona 4: Quiebre Stock Notas de Venta — una NV "con quiebre" es la
    // que tiene al menos una línea con stock disponible menor a la cantidad
    // solicitada (mismo criterio que ya usa "Exportar productos con
    // quiebre").
    const tieneQuiebre = (nv) => nv.items.some((it) => it.quiebre);
    const conQuiebre = universo.filter(tieneQuiebre);
    const sinQuiebre = universo.filter((nv) => !tieneQuiebre(nv));

    return { enProcesoPreparacion, enDespacho, sinQuiebre, conQuiebre };
  }

  function renderKpisPrincipales(universo, pool) {
    // Monto REAL pendiente de las 3 tarjetas: Σ montoPorDespachar (Sal_X_Des
    // × nvPrecio de cada línea), no el valor original completo de la NV.
    const montoPorDespachar = (list) => list.reduce((s, nv) => s + (nv.montoPorDespachar || 0), 0);
    const cardHtml = (id, label, list, monto, extraClass, tagHtml) => `
      <div class="kpi-card${extraClass ? ' ' + extraClass : ''}">
        <div class="kpi-card-label">${label}${tagHtml || ''}</div>
        <div class="kpi-card-value">${list.length}</div>
        <div class="kpi-card-sub">${fmtMoney(monto)}</div>
        <button class="pill-btn" id="np-kpi-${id}-toggle">${isDetalleActivo('zona1', id) ? '▴ Ocultar' : '▾ Ver detalle'}</button>
      </div>`;
    document.getElementById('np-kpis').innerHTML = `
      <div class="np-zona1-grid">
        ${cardHtml('total', 'Total por despachar', universo, montoPorDespachar(universo))}
        ${cardHtml('preparacion', 'Notas en proceso de preparación', pool.enProcesoPreparacion, montoPorDespachar(pool.enProcesoPreparacion))}
        ${cardHtml('despacho', 'Notas de venta en despacho', pool.enDespacho, montoPorDespachar(pool.enDespacho))}
      </div>
    `;
    ['total', 'preparacion', 'despacho'].forEach((id) => {
      document.getElementById(`np-kpi-${id}-toggle`)?.addEventListener('click', () => setDetalleActivo('zona1', id));
    });
  }

  // Umbrales de las alertas nuevas — pensados como punto de partida
  // razonable, no un dato de negocio ya validado; ajustables a pedido.
  // Las horas siguen la regla vigente (corridas o hábiles, ver businessDates.js).
  const UMBRAL_HORAS_POR_VENCER = 24; // horas restantes hasta el compromiso
  const UMBRAL_HORAS_PREPARACION_ESTANCADA = 27; // horas desde la creación

  function computeAlertas(universo) {
    const bloqueadas = universo.filter((nv) => nv.bloqueado);
    return { bloqueadas };
  }

  // "Atrasadas": a diferencia del resto de las alertas, NO depende del
  // filtro de fecha de la barra lateral — es una ventana fija de los
  // últimos 15 días, medida desde la FECHA COMPROMISO (no la de creación), e
  // igual que el tablero de NV coordinadas lee directo de todas las NV.
  // Se cuenta "atrasada" si su compromiso ya llegó (es hoy o antes) pero no
  // quedó demasiado atrás en el tiempo (más de 15 días) — así la alerta
  // queda acotada a lo reciente/accionable, sin ir creciendo para siempre
  // con atrasos viejos. Ejemplo: NV creada el día 5 (compromiso el día 7) no
  // aparece si hoy es el día 6, porque su compromiso es mañana, no hoy;
  // creada el día 4 (compromiso el día 6 = hoy) sí aparece. También se
  // excluyen las que ya no tienen nada pendiente por despachar (mismo
  // criterio que en la pestaña Corte): si el saldo es 0, no es un atraso
  // real aunque el sistema no la haya concluido.
  function computeAtrasadasFijo() {
    const fin = endOfDay(new Date());
    const inicio = startOfDay(new Date());
    inicio.setDate(inicio.getDate() - 14); // 15 días en total, incluido hoy
    return nvRecords.filter((nv) => {
      if (nv.nvEstado !== 'A') return false;
      if (!nv.fechaCompromiso || nv.fechaCompromiso < inicio || nv.fechaCompromiso > fin) return false;
      const saldo = nv.items.reduce((s, it) => s + (it.salXDes || 0), 0);
      return saldo !== 0;
    });
  }

  // "Sin guía ni factura": NV concluidas (estado C) sin ninguno de los dos
  // documentos, ventana fija de los últimos 30 días por FECHA DE
  // COORDINACIÓN (cuándo se entregó) — tampoco depende del filtro de la
  // barra lateral, mismo patrón que Atrasadas. Verificado con datos reales
  // (2026-10-06): incluso acotando a solo despachos reales (sin retiros) el
  // porcentaje sigue altísimo (~79%), así que varios canales probablemente
  // no usan estos dos campos — esta alerta es para revisar caso a caso, no
  // para asumir que cada fila es un problema real de facturación pendiente.
  function computeSinFacturarFijo() {
    const fin = endOfDay(new Date());
    const inicio = startOfDay(new Date());
    inicio.setDate(inicio.getDate() - 29); // 30 días en total, incluido hoy
    return nvRecords.filter((nv) => {
      if (nv.nvEstado !== 'C') return false;
      if (nv.guia || nv.factura) return false;
      if (!nv.fCoordinacion || nv.fCoordinacion < inicio || nv.fCoordinacion > fin) return false;
      return true;
    });
  }

  // "Top 20 por monto pendiente": las NV vigentes con saldo por despachar
  // (en pesos) más alto, de mayor a menor — tampoco depende del filtro de la
  // barra lateral, mismo patrón que Atrasadas y Sin guía ni factura: la idea
  // es ver los montos más grandes pendientes AHORA, sin importar qué
  // período se esté mirando arriba. Se excluyen las que ya tienen una fecha
  // de coordinación (F_coordinacion, Corte columna AQ) futura: ya tienen un
  // plan de entrega posterior a hoy, así que no son un pendiente urgente.
  function computeTop20MontoFijo() {
    const finHoy = endOfDay(new Date());
    return nvRecords
      .filter((nv) => nv.nvEstado === 'A' && (nv.montoPorDespachar || 0) > 0)
      .filter((nv) => !nv.fCoordinacion || nv.fCoordinacion <= finHoy)
      .sort((a, b) => (b.montoPorDespachar || 0) - (a.montoPorDespachar || 0))
      .slice(0, 20);
  }

  /** Quiebre "real" por antigüedad (FIFO), para el indicador de Alertas —
   * distinto del flag `quiebre` de cada línea (que marca a TODAS las NV de
   * un SKU por igual si la demanda total supera el stock: ese es el
   * universo de "riesgo" que se muestra en la Zona 4, y se deja así a
   * propósito porque decidir cuál NV se atiende es del área comercial, no
   * del sistema). Acá se calcula, por SKU, cuáles NV específicas quedarían
   * sin stock si se atiende en orden de antigüedad: se ordenan de más
   * antigua a más nueva y se va restando el stock disponible (Stock_Dis); la primera
   * NV cuyo remanente ya no le alcanza al 100% marca el corte — esa NV y
   * todas las más nuevas del mismo SKU quedan "con quiebre real". Se
   * calcula sobre TODAS las NV vigentes (no solo el universo filtrado por
   * fecha), igual que el flag `quiebre` original, y después se filtra al
   * universo activo para mostrar/contar.
   */
  function computeQuiebreFifo() {
    const porSku = new Map();
    nvRecords.forEach((nv) => {
      if (nv.nvEstado !== 'A') return;
      nv.items.forEach((item) => {
        if (!item.quiebre) return;
        const key = (item.codProd || '').trim().toUpperCase();
        if (!key) return;
        if (!porSku.has(key)) porSku.set(key, { stock: Math.max(0, item.stockDisp || 0), lineas: [] });
        porSku.get(key).lineas.push({ nv, cant: item.salXDes || 0 });
      });
    });

    const nvConQuiebreFifo = new Set();
    porSku.forEach((grupo) => {
      const lineas = grupo.lineas.slice().sort((a, b) => {
        const fa = a.nv.fecCreacion ? a.nv.fecCreacion.getTime() : 0;
        const fb = b.nv.fecCreacion ? b.nv.fecCreacion.getTime() : 0;
        return fa !== fb ? fa - fb : (a.nv.nvNumero || '').localeCompare(b.nv.nvNumero || '');
      });
      let remanente = grupo.stock;
      let cortado = false;
      lineas.forEach(({ nv, cant }) => {
        if (!cortado && remanente >= cant) remanente -= cant;
        else cortado = true;
        if (cortado) nvConQuiebreFifo.add(nv);
      });
    });
    return nvConQuiebreFifo;
  }

  // Próximas a vencer y todavía sin fecha de coordinación — a diferencia de
  // las alertas reactivas de arriba (ya atrasadas), esta avisa ANTES de
  // que se rompa el compromiso.
  function computePorVencerSinCoordinar(universo, umbralHoras = UMBRAL_HORAS_POR_VENCER) {
    const ahora = new Date();
    return universo.filter((nv) => {
      if (nv.esRetiro || coordinacionValida(nv.fCoordinacion) || !nv.fechaCompromiso) return false;
      const horasRestantes = hoursElapsed(ahora, nv.fechaCompromiso);
      return horasRestantes > 0 && horasRestantes <= umbralHoras;
    });
  }

  // NV con OP_Picking asignado (arrancó picking) que llevan demasiado
  // tiempo sin pasar a "en despacho" — posible cuello de botella.
  function computePreparacionEstancada(enProcesoPreparacion, umbralHoras = UMBRAL_HORAS_PREPARACION_ESTANCADA) {
    const ahora = new Date();
    return enProcesoPreparacion.filter((nv) => hoursElapsed(nv.fecCreacion, ahora) > umbralHoras);
  }

  // NV con líneas EXACTAMENTE duplicadas (mismo producto, cantidad y monto
  // repetidos dos o más veces) — error de digitación en el sistema de
  // origen (confirmado revisando casos reales). No se corrige solo: el
  // área de ventas debe arreglarlo ahí, esto solo avisa.
  function computeLineasDuplicadas(universo) {
    return universo.filter((nv) => {
      const vistos = new Set();
      return nv.items.some((it) => {
        const key = `${it.codProd}|${it.cant}|${it.montoLinea}`;
        if (vistos.has(key)) return true;
        vistos.add(key);
        return false;
      });
    });
  }

  function renderAlertasPanel(universo, pool) {
    const cont = document.getElementById('np-alertas');
    if (!cont) return;
    const { bloqueadas } = computeAlertas(universo);
    const atrasadas = computeAtrasadasFijo();
    const sinFacturar = computeSinFacturarFijo();
    const top20Monto = computeTop20MontoFijo();
    const porVencer = computePorVencerSinCoordinar(universo);
    const retirosMalMarcados = universo.filter((nv) => nv.retiroMalMarcado);
    const preparacionEstancada = computePreparacionEstancada(pool.enProcesoPreparacion);
    const lineasDuplicadas = computeLineasDuplicadas(universo);
    const quiebreFifoSet = computeQuiebreFifo();
    const quiebreFifo = universo.filter((nv) => quiebreFifoSet.has(nv));

    const filaHtml = (tipo, badgeClass, label, list) => `
      <div class="np-alerta-row">
        <span class="status-badge ${badgeClass}">${label}</span>
        <span><strong>${list.length}</strong> NV</span>
        <button class="pill-btn" data-alerta-toggle="${tipo}">${isDetalleActivo(tipo) ? '▴ Ocultar' : '▾ Ver detalle'}</button>
      </div>`;

    cont.innerHTML = `
      <div class="np-alerta-row np-alerta-row--first">
        <span class="status-badge status-badge--danger">Bloqueadas</span>
        <span><strong>${bloqueadas.length}</strong> NV con bloqueo de Finanzas</span>
        <button class="pill-btn" id="np-alerta-bloqueadas-export">⬇ Exportar Excel</button>
        <button class="pill-btn" data-alerta-toggle="bloqueadas">${isDetalleActivo('bloqueadas') ? '▴ Ocultar' : '▾ Ver detalle'}</button>
      </div>
      ${filaHtml('atrasadas', 'status-badge--danger', 'Atrasadas (últimos 15 días)', atrasadas)}
      ${filaHtml('sinFacturar', 'status-badge--warning', 'Sin guía ni factura (últimos 30 días)', sinFacturar)}
      ${filaHtml('top20Monto', 'status-badge--warning', 'Top 20 por monto pendiente', top20Monto)}
      ${filaHtml('quiebreFifo', 'status-badge--danger', 'Quiebre de stock', quiebreFifo)}
      ${filaHtml('porVencer', 'status-badge--warning', `Por vencer sin coordinar (< ${UMBRAL_HORAS_POR_VENCER}h ${HOURS_LABEL})`, porVencer)}
      ${filaHtml('preparacionEstancada', 'status-badge--warning', `Preparación estancada (+${UMBRAL_HORAS_PREPARACION_ESTANCADA}h ${HOURS_LABEL})`, preparacionEstancada)}
      ${filaHtml('retiroMalMarcado', 'status-badge--neutral', 'Retiros mal marcados', retirosMalMarcados)}
      ${filaHtml('lineasDuplicadas', 'status-badge--warning', 'NV con líneas duplicadas (revisar en sistema)', lineasDuplicadas)}
    `;
    document.getElementById('np-alerta-bloqueadas-export')?.addEventListener('click', (e) => {
      downloadXlsx(
        `nv_bloqueadas_${new Date().toISOString().slice(0, 10)}.xlsx`,
        ['NV', 'Cliente', 'Vendedor', 'Canal', 'Monto', 'Fecha creacion', 'Fecha compromiso'],
        bloqueadas.map((nv) => [
          nv.nvNumero,
          nv.cliente,
          nv.vendedor,
          nv.canal,
          Math.round(nv.montoPorDespachar),
          nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : '',
          nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : '',
        ])
      );
      flashExportFeedback(e.currentTarget);
    });
    cont.querySelectorAll('[data-alerta-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => setDetalleActivo(btn.dataset.alertaToggle));
    });
  }

  // "NV con riesgo de atención" — agrupado por código de producto (no por
  // NV): cuántas unidades piden en total las NV vigentes de ese producto,
  // cuánto stock real hay en el sistema, qué NV lo piden, y desde cuándo
  // está esperando la más antigua de ellas. Usa el universo de "riesgo"
  // (flag `quiebre` agregado, el mismo de la Zona 4) — a propósito no usa
  // el corte por antigüedad (FIFO) de las alertas: acá se listan TODAS las
  // NV en riesgo, porque decidir a cuál atender es del área comercial.
  function computeQuiebreAtencionDetalle(conQuiebre) {
    const porSku = new Map();
    conQuiebre.forEach((nv) => {
      nv.items.forEach((item) => {
        if (!item.quiebre) return;
        const key = (item.codProd || '').trim().toUpperCase();
        if (!key) return;
        if (!porSku.has(key)) {
          porSku.set(key, { codProd: item.codProd, detProd: item.detProd, unidades: 0, stockVigente: item.stockDisp || 0, nvs: new Map(), fechaIngreso: null });
        }
        const g = porSku.get(key);
        g.unidades += item.salXDes || 0;
        if (!g.nvs.has(nv.nvNumero)) g.nvs.set(nv.nvNumero, nv);
        if (nv.fecCreacion && (!g.fechaIngreso || nv.fecCreacion < g.fechaIngreso)) g.fechaIngreso = nv.fecCreacion;
      });
    });
    const hoy = new Date();
    return [...porSku.values()]
      .map((g) => ({
        codProd: g.codProd,
        detProd: g.detProd,
        unidades: g.unidades,
        stockVigente: g.stockVigente,
        nvsQueAfectan: [...g.nvs.keys()],
        clientesQueAfectan: [...new Set([...g.nvs.values()].map((nv) => nv.cliente))],
        fechaIngreso: g.fechaIngreso,
        // Días corridos (calendario), no hábiles, tal como se pidió.
        diasTranscurridos: g.fechaIngreso ? Math.floor((hoy - g.fechaIngreso) / 86400000) : null,
      }))
      .sort((a, b) => (b.diasTranscurridos ?? -1) - (a.diasTranscurridos ?? -1));
  }

  function renderFillRatePanel(universo, pool) {
    const cont = document.getElementById('np-fillrate');
    if (!cont) return;
    const montoSinQuiebre = pool.sinQuiebre.reduce((s, nv) => s + (nv.montoPorDespachar || 0), 0);
    const montoConQuiebre = pool.conQuiebre.reduce((s, nv) => s + (nv.montoPorDespachar || 0), 0);
    const pctSinQuiebre = universo.length > 0 ? (pool.sinQuiebre.length / universo.length) * 100 : 0;
    const pctConQuiebre = universo.length > 0 ? (pool.conQuiebre.length / universo.length) * 100 : 0;
    cont.innerHTML = `
      <div class="np-zona4-total-row">
        <div class="np-zona4-total">
          <span class="np-zona4-total-label">Total NV del período</span>
          <span class="np-zona4-total-value">${universo.length}</span>
          <span class="np-zona4-total-label">según filtro de fecha activo</span>
        </div>
        <div class="np-zona4-total">
          <span class="np-zona4-total-label">Cumplimiento</span>
          <span class="np-zona4-total-value">${fmtPct(pctSinQuiebre)}</span>
          <span class="np-zona4-total-label">NV atendidas 100% del período</span>
        </div>
      </div>
      <div class="np-zona4-grid">
        <div class="kpi-card kpi-card--success">
          <div class="kpi-card-label">NV Stock al 100% · NV</div>
          <div class="kpi-card-value">${pool.sinQuiebre.length}</div>
          <div class="kpi-card-sub">${fmtPct(pctSinQuiebre)} del total</div>
          <button class="pill-btn" id="np-sinquiebre-toggle">${isDetalleActivo('sinQuiebre') ? '▴ Ocultar' : '▾ Ver detalle'}</button>
        </div>
        <div class="kpi-card kpi-card--success">
          <div class="kpi-card-label">NV Stock al 100% · Dinero</div>
          <div class="kpi-card-value">${fmtMoney(montoSinQuiebre)}</div>
        </div>
        <div class="kpi-card kpi-card--danger">
          <div class="kpi-card-label">NV con riesgo de quiebre</div>
          <div class="kpi-card-value">${pool.conQuiebre.length}</div>
          <div class="kpi-card-sub">${fmtPct(pctConQuiebre)} del total</div>
          <button class="pill-btn" id="np-quiebre-toggle">${isDetalleActivo('quiebre') ? '▴ Ocultar' : '▾ Ver detalle'}</button>
        </div>
        <div class="kpi-card kpi-card--danger">
          <div class="kpi-card-label">Con quiebre de stock · Dinero</div>
          <div class="kpi-card-value">${fmtMoney(montoConQuiebre)}</div>
        </div>
      </div>
    `;
    document.getElementById('np-quiebre-toggle')?.addEventListener('click', () => setDetalleActivo('quiebre'));
    document.getElementById('np-sinquiebre-toggle')?.addEventListener('click', () => setDetalleActivo('sinQuiebre'));
  }

  function renderDetalleCompartido(universo, pool) {
    const box = document.getElementById('np-detalle-box');
    const cont = document.getElementById('np-detalle');
    if (!box || !cont) return;
    if (!detalleActivo) {
      box.classList.add('hidden');
      cont.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');

    // El bloque de resultados (título + tabla + export) se recalcula cada
    // vez que cambia el filtro de cliente, pero el input en sí NO se
    // reconstruye — si se metiera dentro del HTML que se regenera acá,
    // perdería el foco en cada letra tecleada.
    function computeResultado() {
      // Filtro de cliente, compartido por todas las tarjetas: se aplica
      // sobre lo que esté abierto en este panel, sea cual sea.
      const clienteTerm = clienteFiltro.trim().toLowerCase();
      const matchesCliente = (cliente) => !clienteTerm || (cliente || '').toLowerCase().includes(clienteTerm);

      let titulo;
      let exportName;
      let totalCount;
      let headers;
      let rows;
      let xlsxHeaders;
      let xlsxRows;
      if (detalleActivo.tipo === 'zona1') {
      const listasPorId = { total: universo, preparacion: pool.enProcesoPreparacion, despacho: pool.enDespacho };
      const titulosPorId = {
        total: 'Total por despachar',
        preparacion: 'Notas en proceso de preparación',
        despacho: 'Notas de venta en despacho',
      };
      const list = (listasPorId[detalleActivo.id] || []).filter((nv) => matchesCliente(nv.cliente));
      titulo = titulosPorId[detalleActivo.id];
      exportName = `nv_${detalleActivo.id}`;
      totalCount = list.length;
      headers = ['NV', 'Cliente', 'Canal', 'Guía', 'Monto', 'Fecha compromiso'];
      rows = list.slice(0, 300).map((nv) => [nv.nvNumero, nv.cliente, nv.canal || '', nv.guia || '', fmtMoney(nv.montoPorDespachar), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : 'N/A']);
      xlsxHeaders = ['NV', 'Cliente', 'Vendedor', 'Canal', 'Guia', 'Monto', 'Fecha compromiso'];
      xlsxRows = list.map((nv) => [nv.nvNumero, nv.cliente, nv.vendedor, nv.canal, nv.guia || '', Math.round(nv.montoPorDespachar), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : '']);
    } else if (detalleActivo.tipo === 'sinQuiebre') {
      const list = pool.sinQuiebre.filter((nv) => matchesCliente(nv.cliente));
      titulo = 'NV Stock al 100%';
      exportName = 'nv_stock_100';
      totalCount = list.length;
      headers = ['NV', 'Cliente', 'Canal', 'Guía', 'Monto', 'Fecha compromiso'];
      rows = list.slice(0, 300).map((nv) => [nv.nvNumero, nv.cliente, nv.canal || '', nv.guia || '', fmtMoney(nv.montoPorDespachar), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : 'N/A']);
      xlsxHeaders = ['NV', 'Cliente', 'Vendedor', 'Canal', 'Guia', 'Monto', 'Fecha compromiso'];
      xlsxRows = list.map((nv) => [nv.nvNumero, nv.cliente, nv.vendedor, nv.canal, nv.guia || '', Math.round(nv.montoPorDespachar), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : '']);
    } else if (detalleActivo.tipo === 'quiebre') {
      // "NV con riesgo de atención": agrupado por código de producto (no
      // por NV) — unidades pedidas, stock disponible (Stock_Dis), qué NV lo
      // piden y hace cuánto está esperando la más antigua de ellas.
      const filas = computeQuiebreAtencionDetalle(pool.conQuiebre).filter((f) => f.clientesQueAfectan.some(matchesCliente));
      titulo = 'NV con riesgo de atención';
      exportName = 'nv_riesgo_atencion';
      totalCount = filas.length;
      headers = ['Código', 'Producto', 'Unidades', 'Stock vigente', 'NV que afectan', 'Fecha ingreso', 'Días transcurridos'];
      rows = filas
        .slice(0, 300)
        .map((f) => [f.codProd, f.detProd, f.unidades, f.stockVigente, f.nvsQueAfectan.length, f.fechaIngreso ? f.fechaIngreso.toLocaleDateString('es-CL') : 'N/A', f.diasTranscurridos ?? 'N/A']);
      xlsxHeaders = ['Código', 'Producto', 'Unidades', 'Stock vigente', 'NV que afectan', 'Fecha ingreso', 'Días transcurridos'];
      xlsxRows = filas.map((f) => [
        f.codProd,
        f.detProd,
        f.unidades,
        f.stockVigente,
        f.nvsQueAfectan.join(', '),
        f.fechaIngreso ? f.fechaIngreso.toLocaleDateString('es-CL') : '',
        f.diasTranscurridos ?? '',
      ]);
    } else {
      // Resto de las alertas de Zona 3: todas son listas simples de NV,
      // mismo formato de tabla.
      const { bloqueadas } = computeAlertas(universo);
      const atrasadas = computeAtrasadasFijo();
      const sinFacturar = computeSinFacturarFijo();
      const top20Monto = computeTop20MontoFijo();
      const quiebreFifoSet = computeQuiebreFifo();
      const listasPorTipo = {
        bloqueadas,
        atrasadas,
        sinFacturar,
        top20Monto,
        quiebreFifo: universo.filter((nv) => quiebreFifoSet.has(nv)),
        porVencer: computePorVencerSinCoordinar(universo),
        preparacionEstancada: computePreparacionEstancada(pool.enProcesoPreparacion),
        retiroMalMarcado: universo.filter((nv) => nv.retiroMalMarcado),
        lineasDuplicadas: computeLineasDuplicadas(universo),
      };
      const titulosPorTipo = {
        bloqueadas: 'Bloqueadas',
        atrasadas: 'Atrasadas (últimos 15 días)',
        sinFacturar: 'Sin guía ni factura (últimos 30 días)',
        top20Monto: 'Top 20 por monto pendiente',
        quiebreFifo: 'Quiebre de stock',
        porVencer: 'Por vencer sin coordinar',
        preparacionEstancada: 'Preparación estancada',
        retiroMalMarcado: 'Retiros mal marcados',
        lineasDuplicadas: 'NV con líneas duplicadas',
      };
      const list = (listasPorTipo[detalleActivo.tipo] || []).filter((nv) => matchesCliente(nv.cliente));
      titulo = titulosPorTipo[detalleActivo.tipo] || detalleActivo.tipo;
      exportName = `nv_${detalleActivo.tipo}`;
      totalCount = list.length;
      if (detalleActivo.tipo === 'atrasadas') {
        // Acá sí importa saber hace cuánto venció cada una y quién la vendió,
        // para decidir qué atender primero — por eso tiene su propio detalle
        // en vez del genérico de abajo. Toda NV de esta lista ya tiene fecha
        // compromiso vencida (la exige computeAtrasadasFijo), así que el
        // cálculo de días siempre da 0 o más. Ordenada por cliente (A-Z) para
        // que lo de un mismo cliente quede junto. "Saldo por despachar" va en
        // UNIDADES (Sal_X_Des), aparte de "Monto" que ya está en pesos.
        const diasDeAtraso = (nv) => Math.floor(hoursElapsed(nv.fechaCompromiso, new Date()) / 24);
        const saldoUnidades = (nv) => nv.items.reduce((s, it) => s + (it.salXDes || 0), 0);
        const listOrdenada = list.slice().sort((a, b) => (a.cliente || '').localeCompare(b.cliente || '', 'es', { sensitivity: 'base' }));
        headers = ['NV', 'Cliente', 'Canal', 'Guía', 'Factura', 'Monto', 'Saldo por despachar', 'Fecha compromiso', 'Días de atraso', 'Vendedor'];
        rows = listOrdenada
          .slice(0, 300)
          .map((nv) => [
            nv.nvNumero,
            nv.cliente,
            nv.canal || '',
            nv.guia || '',
            nv.factura || '',
            fmtMoney(nv.montoPorDespachar),
            saldoUnidades(nv).toLocaleString('es-CL'),
            nv.fechaCompromiso.toLocaleDateString('es-CL'),
            diasDeAtraso(nv),
            nv.vendedor || '',
          ]);
        xlsxHeaders = ['NV', 'Cliente', 'Canal', 'Guia', 'Factura', 'Monto', 'Saldo por despachar', 'Fecha compromiso', 'Dias de atraso', 'Vendedor'];
        xlsxRows = listOrdenada.map((nv) => [
          nv.nvNumero,
          nv.cliente,
          nv.canal,
          nv.guia || '',
          nv.factura || '',
          Math.round(nv.montoPorDespachar),
          saldoUnidades(nv),
          nv.fechaCompromiso.toLocaleDateString('es-CL'),
          diasDeAtraso(nv),
          nv.vendedor,
        ]);
      } else if (detalleActivo.tipo === 'sinFacturar') {
        // Concluida sin guía ni factura: el monto es el valor total de la NV
        // (no el saldo por despachar, que acá siempre sería $0 porque ya está
        // concluida) y la fecha relevante es la de coordinación (cuándo se
        // entregó), no la de compromiso. Ordenada por cliente (A-Z), igual
        // que Atrasadas.
        const listOrdenada = list.slice().sort((a, b) => (a.cliente || '').localeCompare(b.cliente || '', 'es', { sensitivity: 'base' }));
        headers = ['NV', 'Cliente', 'Canal', 'Entrega', 'Monto', 'Fecha de coordinación', 'Vendedor'];
        rows = listOrdenada
          .slice(0, 300)
          .map((nv) => [
            nv.nvNumero,
            nv.cliente,
            nv.canal || '',
            nv.entrega === 'RETIRA' ? 'Retira' : 'Despacho',
            fmtMoney(nv.montoTotal),
            nv.fCoordinacion ? nv.fCoordinacion.toLocaleDateString('es-CL') : '',
            nv.vendedor || '',
          ]);
        xlsxHeaders = ['NV', 'Cliente', 'Canal', 'Entrega', 'Monto', 'Fecha de coordinacion', 'Vendedor'];
        xlsxRows = listOrdenada.map((nv) => [
          nv.nvNumero,
          nv.cliente,
          nv.canal,
          nv.entrega === 'RETIRA' ? 'Retira' : 'Despacho',
          Math.round(nv.montoTotal || 0),
          nv.fCoordinacion ? nv.fCoordinacion.toLocaleDateString('es-CL') : '',
          nv.vendedor,
        ]);
      } else if (detalleActivo.tipo === 'top20Monto') {
        // Una fila por LÍNEA pendiente, no por NV — para mostrar qué
        // productos componen el monto, igual que el buscador por SKU de
        // Corte. Se arman en el mismo orden del ranking (NV de mayor a
        // menor monto pendiente); dentro de una NV quedan en el orden del
        // Excel — si un mismo producto está repetido ahí (como ya marca
        // "NV con líneas duplicadas"), también se repite acá a propósito,
        // para no esconder ese problema.
        const filas = [];
        list.forEach((nv) => {
          nv.items.forEach((it) => {
            if ((it.salXDes || 0) <= 0) return;
            filas.push({ nv, it });
          });
        });
        totalCount = filas.length;
        headers = ['NV', 'Cliente', 'Monto pendiente', 'Código', 'Producto', 'Pendiente', 'Canal', 'Entrega', 'Fecha compromiso', 'Vendedor'];
        rows = filas
          .slice(0, 300)
          .map(({ nv, it }) => [
            nv.nvNumero,
            nv.cliente,
            fmtMoney(nv.montoPorDespachar),
            it.codProd || '',
            it.detProd || '',
            (it.salXDes || 0).toLocaleString('es-CL'),
            nv.canal || '',
            nv.entrega === 'RETIRA' ? 'Retira' : 'Despacho',
            nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : 'N/A',
            nv.vendedor || '',
          ]);
        xlsxHeaders = ['NV', 'Cliente', 'Monto pendiente', 'Codigo', 'Producto', 'Pendiente', 'Canal', 'Entrega', 'Fecha compromiso', 'Vendedor'];
        xlsxRows = filas.map(({ nv, it }) => [
          nv.nvNumero,
          nv.cliente,
          Math.round(nv.montoPorDespachar || 0),
          it.codProd || '',
          it.detProd || '',
          it.salXDes || 0,
          nv.canal,
          nv.entrega === 'RETIRA' ? 'Retira' : 'Despacho',
          nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : '',
          nv.vendedor,
        ]);
      } else {
      // Todas estas alertas son sobre NV en estado A (sin entregar) — el
      // monto mostrado/exportado es lo real pendiente por despachar.
      headers = ['NV', 'Cliente', 'Canal', 'Guía', 'Monto', 'Fecha compromiso'];
      rows = list.slice(0, 300).map((nv) => [nv.nvNumero, nv.cliente, nv.canal || '', nv.guia || '', fmtMoney(nv.montoPorDespachar), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : 'N/A']);
      xlsxHeaders = ['NV', 'Cliente', 'Vendedor', 'Canal', 'Guia', 'Monto', 'Fecha compromiso'];
      xlsxRows = list.map((nv) => [nv.nvNumero, nv.cliente, nv.vendedor, nv.canal, nv.guia || '', Math.round(nv.montoPorDespachar), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : '']);
      }
      }
      return { titulo, exportName, totalCount, headers, rows, xlsxHeaders, xlsxRows };
    }

    function renderResultados() {
      const r = computeResultado();
      const tituloEl = document.getElementById('np-detalle-titulo');
      if (tituloEl) tituloEl.innerHTML = `Detalle — ${r.titulo}${r.totalCount > 300 ? ` <span class="kpi-note">(mostrando las primeras 300 de ${r.totalCount})</span>` : ''}`;
      const tablaEl = document.getElementById('np-detalle-tabla');
      if (tablaEl) tablaEl.innerHTML = tableHtml(r.headers, r.rows);
      const exportBtn = document.getElementById('np-detalle-export');
      if (exportBtn) {
        exportBtn.onclick = (e) => {
          downloadXlsx(`${r.exportName}_${new Date().toISOString().slice(0, 10)}.xlsx`, r.xlsxHeaders, r.xlsxRows);
          flashExportFeedback(e.currentTarget);
        };
      }
    }

    cont.innerHTML = `
      <h4 id="np-detalle-titulo"></h4>
      <div class="np-detalle-toolbar">
        <div class="sb-search-box np-detalle-cliente-filtro">
          <span class="sb-search-icon">🔍</span>
          <input type="text" id="np-detalle-cliente-input" placeholder="Filtrar por cliente..." value="${clienteFiltro}">
        </div>
        <button class="pill-btn" id="np-detalle-export">⬇ Exportar Excel</button>
      </div>
      <div id="np-detalle-tabla"></div>
    `;
    document.getElementById('np-detalle-cliente-input')?.addEventListener('input', (e) => {
      clienteFiltro = e.target.value;
      renderResultados();
    });
    renderResultados();
  }

  // Réplica digital de la pizarra de asignación semanal: lunes a sábado de
  // la semana vigente, con las NV activas coordinadas ese día (columna
  // F_coordinacion). Es una vista fija de "la semana en curso" — a
  // propósito no depende de los filtros de fecha/búsqueda de arriba, igual
  // que la pizarra física no cambia según lo que alguien esté filtrando.
  function computeSemanaVigente() {
    const hoy = startOfDay(new Date());
    const diaSemana = hoy.getDay(); // 0=domingo, 1=lunes, ...
    const offsetLunes = diaSemana === 0 ? -6 : 1 - diaSemana;
    const lunes = new Date(hoy.getTime() + offsetLunes * 86400000);
    const dias = [];
    for (let i = 0; i < 6; i++) {
      dias.push({ fecha: new Date(lunes.getTime() + i * 86400000), nvsPorNumero: new Map() });
    }
    nvRecords.forEach((nv) => {
      if (nv.nvEstado !== 'A' || !nv.fCoordinacion) return;
      const f = startOfDay(nv.fCoordinacion).getTime();
      const dia = dias.find((d) => d.fecha.getTime() === f);
      // Una misma NV puede aparecer varias veces en nvRecords (una por línea
      // de producto) — se deduplica por N° de NV para no repetirla dentro
      // del mismo día.
      if (dia && !dia.nvsPorNumero.has(nv.nvNumero)) dia.nvsPorNumero.set(nv.nvNumero, nv);
    });
    return dias.map((d) => ({ fecha: d.fecha, nvs: [...d.nvsPorNumero.values()] }));
  }

  function renderSemanaPanel() {
    const cont = document.getElementById('np-semana');
    if (!cont) return;
    const nombresDia = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const dias = computeSemanaVigente();
    const hoy = startOfDay(new Date());
    // No se muestran los días ya pasados (solo hoy en adelante) ni los días
    // sin NV coordinadas — así los demás días de la semana usan el espacio
    // que dejan libre.
    const diasConNv = dias
      .map((d, i) => ({ ...d, indice: i }))
      .filter((d) => d.fecha >= hoy && d.nvs.length > 0);
    if (diasConNv.length === 0) {
      cont.innerHTML = '<span class="np-semana-vacio">Sin notas de venta coordinadas esta semana.</span>';
      return;
    }
    cont.innerHTML = diasConNv
      .map((d) => {
        // Agrupadas por cliente: si un cliente tiene varias NV coordinadas
        // el mismo día, se muestran juntas bajo su nombre en vez de
        // repetirlo en cada tarjeta.
        const porCliente = new Map();
        d.nvs.forEach((nv) => {
          const cliente = nv.cliente || 'Cliente no especificado';
          if (!porCliente.has(cliente)) porCliente.set(cliente, []);
          porCliente.get(cliente).push(nv);
        });
        const gruposHtml = [...porCliente.entries()]
          .map(
            ([cliente, nvs]) => `
          <div class="np-semana-cliente">
            <div class="np-semana-cliente-nombre">${cliente}</div>
            ${nvs
              .map(
                (nv) => `
              <div class="np-semana-nv">
                <span class="np-semana-nv-numero">${nv.nvNumero}</span>
                ${nv.horaCoordinacion ? `<span class="np-semana-nv-hora">${nv.horaCoordinacion}</span>` : ''}
              </div>`
              )
              .join('')}
          </div>`
          )
          .join('');
        return `
      <div class="np-semana-dia np-semana-dia--${d.indice % 6}">
        <div class="np-semana-dia-header">${nombresDia[d.indice]}<br>${d.fecha.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: '2-digit' })}</div>
        <div class="np-semana-dia-body">${gruposHtml}</div>
      </div>`;
      })
      .join('');
  }

  function renderAll() {
    const universo = computeUniverso();
    const pool = computePool(universo);
    renderKpisPrincipales(universo, pool);
    renderAlertasPanel(universo, pool);
    renderFillRatePanel(universo, pool);
    renderSemanaPanel();
    renderDetalleCompartido(universo, pool);
  }

  function limpiarFiltros() {
    fechaModo = 'semana';
    fechaRefDate = yesterday();
    mesSeleccionado = { year: new Date().getFullYear(), month: new Date().getMonth() };
    semanaSeleccionada = null;
    rangoInicio = new Date(Date.now() - 30 * 86400000);
    rangoFin = new Date();
    searchTerm = '';
    detalleActivo = null;
    clienteFiltro = '';
    filtrosAbiertos = true;
    renderSidebarFiltros();
    renderAll();
  }

  renderSidebarFiltros();
  renderAll();
}

// ---------------------------------------------------------------------------
// 0b. NV entregadas — NV concluidas (estado C) más las vigentes (estado A)
// que ya tienen guía y/o factura y al menos una línea despachada (Sal_X_Des
// = 0). Zonas: 1 "Entregado" (ancho completo, arriba), 2 "On-Time Delivery"
// y 3 "Transporte" (abajo, una junto a la otra) — mismo patrón de filtros/
// zona de detalle que "Notas de ventas vigentes".
// ---------------------------------------------------------------------------

// Patentes reales de la flota propia — Cont_Hodo no valida esto por su
// cuenta, así que sin esta lista cualquier valor raro que aparezca ahí
// (typo, fila de prueba, etc.) se sumaría igual a los km de la flota.
// Si la empresa suma o da de baja vehículos, actualizar esta lista.
const FLOTA_PROPIA_PATENTES = new Set(['VVJV-24', 'PZFP-85', 'VTTP-21']);

// La planilla (Corte, Desp y Cont_Hodo) escribe "VVJU-24" para la camioneta
// cuya patente real es VVJV-24. Se unifican las dos grafías en la correcta,
// así la whitelist y las tablas funcionan tanto con la planilla actual como
// el día que se corrija el tipeo en origen.
const ALIAS_PATENTE = { 'VVJU-24': 'VVJV-24' };
// Exportada por la misma razón que esRetiroAmplio: el panel de control
// privado (control.js) la necesita para su propio filtro por patente.
export const normalizarPatente = (p) => {
  const s = (p || '').toString().trim().toUpperCase();
  return ALIAS_PATENTE[s] || s;
};

// Regla de negocio de "NV entregadas Despacho/Retira": "Retira" es el
// auditor Yuvitsa (ella entrega en tienda física) O cualquier NV sin chofer
// ni patente asignados (nunca salió con vehículo), con auditor vacío o
// Yuvitsa, QUE ADEMÁS tenga guía o factura asociada — sin ningún documento
// no hay cómo saber si de verdad salió algo, así que no se asume retiro.
// "Despacho" es el resto. `chofer` puede venir como el texto "0" en vez de
// vacío (mismo criterio que usa `retiroMalMarcado` en dataLoader.js);
// `guia`/`factura` ya vienen vacíos y no "0" desde ahí (`emptyIfZero` los
// limpia al cargar). El auditor sale de la columna "Auditor" de Desp, o de
// Corte si Desp no la trae (en los datos reales ambas coinciden siempre).
//
// Decidido el 2026-10-08, en 3 pasos, cada uno medido con datos reales
// antes de aplicarse (ver Bitácora "2026-10-08 Transporte, conciliación y
// regla Ecommerce" y "...Despacho-Retira con retiro mal marcado..."):
// 1) Con solo el auditor, "Despacho" quedaba con ~15.800 NV sin patente ni
//    transporte externo (98% de ellas con status DESPACHADO sin chofer ni
//    patente, el flag `retiroMalMarcado`).
// 2) Se agregó `retiroMalMarcado` al criterio de Retira. Exigir además un
//    documento sin matices devolvía ~14.800 NV a "Despacho" (sobre todo
//    venta de mostrador/"Tienda" y Ecommerce, que tampoco documentan así) —
//    aun así el usuario pidió exigirlo.
// 3) Al revisar una lista de NV de referencia armada a mano por el usuario
//    (ENT_PARCIAL con saldo pendiente, auditor vacío o Yuvitsa), varias NV
//    con documento quedaban en "Despacho" porque `retiroMalMarcado` exige
//    status DESPACHADO y esas estaban ENT_PARCIAL — se sacó esa exigencia
//    de status y se dejó solo "sin chofer y sin patente", que es la parte
//    que de verdad importa.
const AUDITOR_EXCLUIDO_ENTREGADAS = 'yuvitsa';
const auditorDe = (nv) => (nv.auditor || nv.auditorCorte || '').toString().trim().toLowerCase();
const choferVacio = (nv) => !nv.chofer || nv.chofer.toString().trim() === '0';
const patenteDe = (nv) => (nv.patente || '').toString().trim().toUpperCase();
// Exportada para el panel de control privado (control.html / control.js),
// que necesita la MISMA regla para su propio universo "Retira" — evita que
// las dos páginas se desalineen si esta regla se vuelve a ajustar.
export const esRetiroAmplio = (nv) => {
  const auditor = auditorDe(nv);
  if (auditor === AUDITOR_EXCLUIDO_ENTREGADAS) return true;
  if (auditor !== '') return false;
  return choferVacio(nv) && !patenteDe(nv) && !!(nv.guia || nv.factura);
};

// Regla de negocio "NV sin rastro": estado C (el sistema la da por concluida)
// pero sin NINGÚN indicio de que de verdad se despachó — sin chofer, sin
// patente, sin guía, sin factura, sin auditor y sin OP_Picking asignado.
// Confirmado por el usuario el 2026-10-09 (tras revisar 5 casos reales de la
// semana 41) como un error de creación o una cancelación de pedido que el
// sistema igual dejó en estado C, no un despacho real — por eso NO cuenta en
// "NV entregadas Despacho" ni "Retira" (se excluye en ambas pestañas antes de
// aplicar `esRetiroAmplio`). Mientras no se defina un tratamiento definitivo,
// se muestra aparte en el panel de control privado para revisión manual.
//
// Ventana fija de los últimos 15 días (por fecha de creación), igual criterio
// que "Atrasadas": medido con datos reales antes de aplicarse (2026-10-09),
// sin ventana esta condición coincide con 14.598 de 20.277 NV históricas
// (72%, sobre todo de hace más de 90 días) — ahí la falta de estos campos ya
// no es un indicio confiable de error puntual, es que antes no se llenaban
// siempre. Con los últimos 15 días coincide con 11 NV, en línea con los 5
// casos reales que el usuario revisó a mano en la semana 41.
//
// Exportada por la misma razón que esRetiroAmplio: control.js la necesita
// para no duplicar el criterio ni desalinearse si se ajusta.
export const esSinRastro = (nv) => {
  if (!nv.fecCreacion) return false;
  const fin = endOfDay(new Date());
  const inicio = startOfDay(new Date());
  inicio.setDate(inicio.getDate() - 14); // 15 días en total, incluido hoy
  if (nv.fecCreacion < inicio || nv.fecCreacion > fin) return false;
  return (
    nv.nvEstado === 'C' &&
    choferVacio(nv) &&
    !patenteDe(nv) &&
    !nv.guia &&
    !nv.factura &&
    auditorDe(nv) === '' &&
    !nv.opPicking
  );
};

// Lo que le falta entregar a una línea = lo vendido (nvTotLinea) menos lo ya
// despachado ("Valor del despacho"). Se usa esto y no "Sal_X_Des × precio" porque
// ese cálculo se descuadra con los descuentos de línea y con un mismo producto
// repetido en varias líneas de la NV (el saldo se repite en cada línea).
const montoSinEntregarLinea = (it) => Math.max(0, (it.montoLinea || 0) - (it.valorDespacho || 0));
const unidadesSinEntregarLinea = (it) => Math.min(it.salXDes || 0, it.cant || 0);

/** Reparte el 100% entre las partes redondeando a 1 decimal (método del mayor
 * resto), así los porcentajes que se muestran siempre suman exactamente 100. */
function porcentajesQueSuman100(partes) {
  const total = partes.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return partes.map(() => 0);
  const decimas = partes.map((v) => (v / total) * 1000);
  const base = decimas.map(Math.floor);
  const faltan = 1000 - base.reduce((s, v) => s + v, 0);
  decimas
    .map((v, i) => ({ i, resto: v - base[i] }))
    .sort((a, b) => b.resto - a.resto)
    .slice(0, faltan)
    .forEach(({ i }) => { base[i] += 1; });
  return base.map((v) => v / 10);
}

function renderNotasConcluidas(el, nvRecords, contHodo, horarioCam, loadedAt, modo = 'despacho') {
  const esRetira = modo === 'retira';
  const tituloTab = esRetira ? 'NV entregadas Retira' : 'NV entregadas Despacho';
  const pad = (n) => String(n).padStart(2, '0');
  const toInputDateValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const hodoRecords = contHodo || [];
  const horarioCamRecords = horarioCam || [];
  // Día en que se cargó el Excel (el "corte" de los datos). Las NV sin fecha de
  // coordinación válida se evalúan como si se hubieran entregado ese día. Se
  // usa este día y no el reloj del computador para que el mismo archivo dé
  // siempre las mismas cifras, sin importar cuándo se abra el reporte.
  const fechaCorte = startOfDay(loadedAt || new Date());

  let fechaModo = 'semana';
  let fechaRefDate = yesterday();
  let mesSeleccionado = { year: new Date().getFullYear(), month: new Date().getMonth() };
  let semanaSeleccionada = null; // semana ISO elegida en el desplegable (null = la semana en curso)
  let rangoInicio = new Date(Date.now() - 30 * 86400000);
  let rangoFin = new Date();
  let searchTerm = '';
  let filtrosAbiertos = true;
  let detalleActivo = null; // { tipo } | null
  let transporteDetalleAbierto = false; // tabla patente x día (Cont_Hodo)
  let ecomAlertaAbierta = false; // detalle de ECOM con auditor distinto de Matías
  let retiroDesviacionAbierta = false; // detalle de Entrega=RETIRA con auditor distinto de Yuvitsa
  let entregaParcialStockAbierta = false; // detalle de entrega parcial con stock disponible (Retira)
  let chartTopClientesCantidad = null; // instancias Chart.js, para destruir antes de redibujar (Retira)
  let chartTopClientesMonto = null;

  // NV marcadas "RETIRA" en Corte (columna Entrega) cuyo auditor NO es
  // Yuvitsa: no caen en "NV entregadas Retira" (que se arma por auditor) ni
  // quedan identificadas como retiro en "Despacho" — vale la pena revisarlas
  // a mano. Fija (lee nvRecords directo, no el universo ni el filtro de la
  // barra lateral): un retiro real nunca llega a tener guía/factura ni pasa a
  // estado C (verificado 2026-10-08, las 98 NV con Entrega=RETIRA de toda la
  // base son estado A), así que medirla solo dentro del universo de esta
  // pestaña casi siempre daría 0 y perdería el sentido de alerta temprana.
  function retiroDesviacion() {
    return nvRecords.filter((nv) => nv.entrega === 'RETIRA' && auditorDe(nv) !== AUDITOR_EXCLUIDO_ENTREGADAS);
  }

  el.innerHTML = `
    <div class="np-header np-header-top">
      <div>
        <h2>${tituloTab}</h2>
        <p class="np-header-sub">${
          esRetira
            ? 'NV concluidas o vigentes entregadas (mismo criterio que NV entregadas Despacho) cuyo auditor es "Yuvitsa", o sin auditor Yuvitsa pero marcadas como posible retiro (despachado sin chofer ni patente) — retiros en tienda.'
            : 'NV concluidas, más las vigentes que ya tienen guía o factura y al menos una línea despachada, sin auditor "Yuvitsa" y sin marca de posible retiro (despachado sin chofer ni patente).'
        }</p>
      </div>
      <div class="np-header-badge" id="nc-fecha-badge"></div>
    </div>

    <div class="np-rendimiento-layout">
      <div class="zone-box zone-box--entregado">
        <h3 class="np-canvas-title">Entregado</h3>
        <div id="nc-entregado"></div>
      </div>
      ${
        esRetira
          ? `<div class="np-rendimiento-row">
              <div class="zone-box zone-box--tiempo">
                <h3 class="np-canvas-title">Top 15 clientes que más retiran · Cantidad</h3>
                <p class="kpi-note">Últimos 6 meses, ventana fija (no depende del filtro de fecha de arriba), sin canal Retail ni Ecommerce. En negrita: clientes que también están en el top 15 por monto.</p>
                <div class="np-chart-box"><canvas id="nc-retira-chart-cantidad"></canvas></div>
              </div>
              <div class="zone-box zone-box--transporte">
                <h3 class="np-canvas-title">Top 15 clientes que más retiran · Monto</h3>
                <p class="kpi-note">Últimos 6 meses, ventana fija (no depende del filtro de fecha de arriba), sin canal Retail ni Ecommerce. En negrita: clientes que también están en el top 15 por cantidad.</p>
                <div class="np-chart-box"><canvas id="nc-retira-chart-monto"></canvas></div>
              </div>
            </div>`
          : `<div class="np-rendimiento-row">
              <div class="zone-box zone-box--tiempo">
                <h3 class="np-canvas-title">On-Time Delivery</h3>
                <div id="nc-tiempo"></div>
              </div>
              <div class="zone-box zone-box--transporte">
                <h3 class="np-canvas-title">Transporte</h3>
                <div id="nc-transporte"></div>
              </div>
            </div>`
      }
    </div>

    <div id="nc-retiro-desviacion-box"></div>
    <div id="nc-entrega-parcial-stock-box"></div>

    <div class="zone-box zone-box--detalle hidden" id="nc-detalle-box">
      <div id="nc-detalle"></div>
    </div>
  `;

  function renderRetiroDesviacionAlerta() {
    const box = document.getElementById('nc-retiro-desviacion-box');
    if (!box) return;
    const lista = retiroDesviacion();
    if (esRetira || lista.length === 0) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = `
      <div class="np-alerta-row np-alerta-row--first">
        <span class="status-badge status-badge--warning">Entrega "Retira" en Corte con auditor distinto de "Yuvitsa" (revisar)</span>
        <span><strong>${lista.length}</strong> NV</span>
        <button class="pill-btn" id="nc-retiro-desviacion-toggle">${retiroDesviacionAbierta ? '▴ Ocultar' : '▾ Ver detalle'}</button>
      </div>
      <div id="nc-retiro-desviacion-detalle" class="${retiroDesviacionAbierta ? '' : 'hidden'}"></div>
    `;
    document.getElementById('nc-retiro-desviacion-toggle')?.addEventListener('click', () => {
      retiroDesviacionAbierta = !retiroDesviacionAbierta;
      renderRetiroDesviacionAlerta();
    });
    if (retiroDesviacionAbierta) {
      const detalleCont = document.getElementById('nc-retiro-desviacion-detalle');
      if (!detalleCont) return;
      const filasOrdenadas = lista.slice().sort((a, b) => (a.cliente || '').localeCompare(b.cliente || ''));
      const filas = filasOrdenadas.map((nv) => [
        nv.nvNumero,
        nv.cliente,
        nv.auditor || nv.auditorCorte || '',
        nv.canal || '',
        nv.guia || '',
        nv.factura || '',
        fmtMoney(nv.montoPorDespachar),
        nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : '',
        nv.vendedor || '',
      ]);
      detalleCont.innerHTML = `
        <button class="pill-btn" id="nc-retiro-desviacion-export">⬇ Exportar Excel</button>
        <div class="kpi-table-scroll">${tableHtml(['NV', 'Cliente', 'Auditor', 'Canal', 'Guía', 'Factura', 'Monto pendiente', 'Fecha de ingreso', 'Vendedor'], filas)}</div>
      `;
      document.getElementById('nc-retiro-desviacion-export')?.addEventListener('click', (e) => {
        const xlsxRows = filasOrdenadas.map((nv) => [
          nv.nvNumero,
          nv.cliente,
          nv.auditor || nv.auditorCorte || '',
          nv.canal || '',
          nv.guia || '',
          nv.factura || '',
          Math.round(nv.montoPorDespachar || 0),
          nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : '',
          nv.vendedor || '',
        ]);
        downloadXlsx(
          `retiro_desviacion_${new Date().toISOString().slice(0, 10)}.xlsx`,
          ['NV', 'Cliente', 'Auditor', 'Canal', 'Guía', 'Factura', 'Monto pendiente', 'Fecha de ingreso', 'Vendedor'],
          xlsxRows
        );
        flashExportFeedback(e.currentTarget);
      });
    }
  }
  renderRetiroDesviacionAlerta();

  // "Entrega parcial con stock disponible": NV ya entregadas (estado C, o
  // vigente con guía/factura y al menos una línea ya despachada — mismo
  // criterio de "entregada" que el resto de esta pestaña, NO solo estado C:
  // probado primero con estado C a secas y dio 0 casos, porque una NV recién
  // concluida casi nunca queda con saldo pendiente), auditoría Yuvitsa
  // (retiro en tienda), que quedaron con saldo por despachar en alguna línea
  // CUYO producto sí tiene stock al corte — o sea, no fue falta de stock lo
  // que dejó la entrega incompleta. Fija, ventana de 3 días por fecha de
  // coordinación (no depende del filtro de la barra lateral), igual que el
  // resto de las alertas de esta pestaña. Solo tiene sentido en "NV
  // entregadas Retira".
  function entregaParcialConStock() {
    const fin = endOfDay(new Date());
    const inicio = startOfDay(new Date());
    inicio.setDate(inicio.getDate() - 2); // 3 días en total, incluido hoy
    const filas = [];
    nvRecords.forEach((nv) => {
      const esConcluida = nv.nvEstado === 'C';
      const esVigenteEntregada = nv.nvEstado === 'A' && (nv.guia || nv.factura) && nv.items.some((it) => it.salXDes === 0);
      if (!esConcluida && !esVigenteEntregada) return;
      if (auditorDe(nv) !== AUDITOR_EXCLUIDO_ENTREGADAS) return;
      if (!nv.fCoordinacion || nv.fCoordinacion < inicio || nv.fCoordinacion > fin) return;
      nv.items.forEach((it) => {
        if ((it.salXDes || 0) > 0 && !it.quiebre) filas.push({ nv, it });
      });
    });
    return filas;
  }

  function renderEntregaParcialStockAlerta() {
    const box = document.getElementById('nc-entrega-parcial-stock-box');
    if (!box) return;
    const lista = entregaParcialConStock();
    if (!esRetira || lista.length === 0) {
      box.innerHTML = '';
      return;
    }
    const nvAfectadas = new Set(lista.map(({ nv }) => nv)).size;
    box.innerHTML = `
      <div class="np-alerta-row np-alerta-row--first">
        <span class="status-badge status-badge--warning">Entrega parcial con stock disponible (últimos 3 días)</span>
        <span><strong>${lista.length}</strong> líneas · ${nvAfectadas} NV</span>
        <button class="pill-btn" id="nc-entrega-parcial-stock-toggle">${entregaParcialStockAbierta ? '▴ Ocultar' : '▾ Ver detalle'}</button>
      </div>
      <div id="nc-entrega-parcial-stock-detalle" class="${entregaParcialStockAbierta ? '' : 'hidden'}"></div>
    `;
    document.getElementById('nc-entrega-parcial-stock-toggle')?.addEventListener('click', () => {
      entregaParcialStockAbierta = !entregaParcialStockAbierta;
      renderEntregaParcialStockAlerta();
    });
    if (entregaParcialStockAbierta) {
      const detalleCont = document.getElementById('nc-entrega-parcial-stock-detalle');
      if (!detalleCont) return;
      const entregadas = (it) => Math.max(0, (it.cant || 0) - unidadesSinEntregarLinea(it));
      const filasOrdenadas = lista
        .slice()
        .sort((a, b) => (a.nv.cliente || '').localeCompare(b.nv.cliente || '') || (a.nv.nvNumero || '').localeCompare(b.nv.nvNumero || ''));
      const filas = filasOrdenadas.map(({ nv, it }) => [
        nv.cliente,
        nv.nvNumero,
        nv.vendedor || '',
        it.codProd,
        it.detProd,
        it.cant,
        entregadas(it),
        it.stockDisp ?? 0,
      ]);
      detalleCont.innerHTML = `
        <button class="pill-btn" id="nc-entrega-parcial-stock-export">⬇ Exportar Excel</button>
        <p class="kpi-note">Stock al corte (${fechaCorte.toLocaleDateString('es-CL')}), no del día de la entrega — ver nota de Transporte/Stock de la pestaña.</p>
        <div class="kpi-table-scroll">${tableHtml(['Cliente', 'NV', 'Vendedor', 'Código', 'Producto', 'Cant. solicitada', 'Cant. entregada', 'Stock al corte'], filas)}</div>
      `;
      document.getElementById('nc-entrega-parcial-stock-export')?.addEventListener('click', (e) => {
        const xlsxRows = filasOrdenadas.map(({ nv, it }) => [
          nv.cliente,
          nv.nvNumero,
          nv.vendedor || '',
          it.codProd,
          it.detProd,
          it.cant,
          entregadas(it),
          it.stockDisp ?? 0,
        ]);
        downloadXlsx(
          `entrega_parcial_con_stock_${new Date().toISOString().slice(0, 10)}.xlsx`,
          ['Cliente', 'NV', 'Vendedor', 'Código', 'Producto', 'Cant. solicitada', 'Cant. entregada', 'Stock al corte'],
          xlsxRows
        );
        flashExportFeedback(e.currentTarget);
      });
    }
  }
  renderEntregaParcialStockAlerta();

  // Top 15 clientes que más retiran (pestaña "NV entregadas Retira"): fijo,
  // últimos 6 meses por fecha de creación, mismo universo que la pestaña
  // (auditor Yuvitsa o retiro mal marcado), SIN canal Retail ni Ecommerce —
  // esos dos canales meten "clientes" que en realidad son el canal mismo
  // (Mercado Libre, Walmart, tiendas de retail) y no personas que retiran
  // repetidas veces, distorsionando el ranking (2026-10-08). Reemplaza a
  // On-Time Delivery/Transporte, que casi no aportan dato en un retiro de
  // mostrador.
  function renderTopClientesRetira() {
    const canvasCantidad = document.getElementById('nc-retira-chart-cantidad');
    const canvasMonto = document.getElementById('nc-retira-chart-monto');
    if (!canvasCantidad || !canvasMonto) return;
    const hace6Meses = new Date();
    hace6Meses.setMonth(hace6Meses.getMonth() - 6);
    const universo6m = nvRecords.filter((nv) => {
      const esConcluida = nv.nvEstado === 'C';
      const esVigenteEntregada = nv.nvEstado === 'A' && (nv.guia || nv.factura) && nv.items.some((it) => it.salXDes === 0);
      if (!esConcluida && !esVigenteEntregada) return false;
      if (!esRetiroAmplio(nv)) return false;
      const canal = (nv.canal || '').toString().toUpperCase();
      if (canal.includes('RETAIL') || canal.includes('ECOM')) return false;
      return nv.fecCreacion && nv.fecCreacion >= hace6Meses;
    });
    const porCliente = new Map();
    universo6m.forEach((nv) => {
      const c = nv.cliente || '(sin cliente)';
      if (!porCliente.has(c)) porCliente.set(c, { cliente: c, cantidad: 0, monto: 0 });
      const r = porCliente.get(c);
      r.cantidad += 1;
      r.monto += nv.montoTotal || 0;
    });
    const todos = [...porCliente.values()];
    const top15Cantidad = todos
      .slice()
      .sort((a, b) => b.cantidad - a.cantidad)
      .slice(0, 15)
      .reverse();
    const top15Monto = todos
      .slice()
      .sort((a, b) => b.monto - a.monto)
      .slice(0, 15)
      .reverse();
    const setCantidad = new Set(top15Cantidad.map((d) => d.cliente));
    const setMonto = new Set(top15Monto.map((d) => d.cliente));
    const tickFont = (data, otroSet) => (ctx) => ({ weight: otroSet.has(data[ctx.index]?.cliente) ? 'bold' : 'normal', size: 11 });

    chartTopClientesCantidad?.destroy();
    chartTopClientesMonto?.destroy();
    chartTopClientesCantidad = new Chart(canvasCantidad, {
      type: 'bar',
      data: { labels: top15Cantidad.map((d) => d.cliente), datasets: [{ label: 'Retiros (NV)', data: top15Cantidad.map((d) => d.cantidad), backgroundColor: '#2563EB' }] },
      options: {
        indexAxis: 'y',
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true }, y: { ticks: { font: tickFont(top15Cantidad, setMonto) } } },
      },
    });
    chartTopClientesMonto = new Chart(canvasMonto, {
      type: 'bar',
      data: { labels: top15Monto.map((d) => d.cliente), datasets: [{ label: 'Monto retirado', data: top15Monto.map((d) => d.monto), backgroundColor: '#009E73' }] },
      options: {
        indexAxis: 'y',
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => fmtMoney(ctx.parsed.x) } },
        },
        scales: {
          x: { beginAtZero: true, ticks: { callback: (v) => '$' + (v / 1000000).toFixed(0) + 'M' } },
          y: { ticks: { font: tickFont(top15Monto, setCantidad) } },
        },
      },
    });
  }

  function isDetalleActivo(tipo) {
    return !!detalleActivo && detalleActivo.tipo === tipo;
  }
  function setDetalleActivo(tipo) {
    detalleActivo = isDetalleActivo(tipo) ? null : { tipo };
    renderAll();
  }

  function mesOptionsHtml() {
    const maxMonth = mesSeleccionado.year === new Date().getFullYear() ? new Date().getMonth() : 11;
    let html = '';
    for (let m = 0; m <= maxMonth; m++) html += `<option value="${m}">${MESES[m]}</option>`;
    return html;
  }

  function renderSidebarFiltros() {
    const cont = document.getElementById('sidebar-filters');
    if (!cont) return;
    cont.innerHTML = `
      <div class="sb-box">
        <button class="sb-toggle${filtrosAbiertos ? '' : ' is-collapsed'}" id="sb-toggle-btn">
          <span>Contextuales a "${tituloTab}"</span>
          <span class="sb-toggle-arrow">▾</span>
        </button>
        <div class="sb-body${filtrosAbiertos ? '' : ' hidden'}" id="sb-body">
          <div>
            <div class="sb-group-label">Fecha de creación</div>
            <div class="sb-pills" id="sb-pills-fecha">
              <button class="sb-pill${fechaModo === 'dia' ? ' active' : ''}" data-value="dia">Día</button>
              <button class="sb-pill${fechaModo === 'semana' ? ' active' : ''}" data-value="semana">Semana</button>
              <button class="sb-pill${fechaModo === 'mes' ? ' active' : ''}" data-value="mes">Mes</button>
              <button class="sb-pill${fechaModo === 'rango' ? ' active' : ''}" data-value="rango">Rango 📅</button>
              <button class="sb-pill${fechaModo === 'todo' ? ' active' : ''}" data-value="todo">Todo</button>
            </div>
            <input type="date" id="sb-fecha-input" class="${fechaModo === 'dia' ? '' : 'hidden'}">
            <select id="sb-semana-select" class="${fechaModo === 'semana' ? '' : 'hidden'}">${semanaOptionsHtml()}</select>
            <select id="sb-mes-select" class="${fechaModo === 'mes' ? '' : 'hidden'}">${mesOptionsHtml()}</select>
            <div id="sb-rango-box" class="${fechaModo === 'rango' ? '' : 'hidden'}">
              <div class="sb-rango-row">
                <span class="sb-rango-dot sb-rango-dot--inicio"></span><label>Inicio</label>
                <input type="date" id="sb-rango-inicio">
              </div>
              <div class="sb-rango-row">
                <span class="sb-rango-dot sb-rango-dot--fin"></span><label>Fin</label>
                <input type="date" id="sb-rango-fin">
              </div>
            </div>
            <span class="sb-fecha-label" id="sb-fecha-label"></span>
          </div>
          <div>
            <div class="sb-group-label">Buscar</div>
            <div class="sb-search-box">
              <span class="sb-search-icon">🔍</span>
              <input type="text" id="sb-search-input" placeholder="NV, cliente o vendedor..." value="${searchTerm}">
            </div>
          </div>
          <button class="sb-limpiar" id="sb-limpiar-btn">✕ Limpiar filtros</button>
        </div>
      </div>
    `;

    const dateInput = document.getElementById('sb-fecha-input');
    if (dateInput) dateInput.value = toInputDateValue(fechaRefDate);
    const semanaSelect = document.getElementById('sb-semana-select');
    if (semanaSelect) semanaSelect.value = String(semanaSeleccionada ?? semanaIsoDe(new Date()).semana);
    const mesSelect = document.getElementById('sb-mes-select');
    if (mesSelect) mesSelect.value = String(mesSeleccionado.month);
    const inicioInput = document.getElementById('sb-rango-inicio');
    const finInput = document.getElementById('sb-rango-fin');
    if (inicioInput) inicioInput.value = toInputDateValue(rangoInicio);
    if (finInput) finInput.value = toInputDateValue(rangoFin);

    document.getElementById('sb-toggle-btn')?.addEventListener('click', () => {
      filtrosAbiertos = !filtrosAbiertos;
      renderSidebarFiltros();
    });
    document.querySelectorAll('#sb-pills-fecha .sb-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        fechaModo = btn.dataset.value;
        renderSidebarFiltros();
        renderAll();
      });
    });
    dateInput?.addEventListener('change', (e) => {
      fechaRefDate = e.target.value ? new Date(e.target.value + 'T00:00:00') : yesterday();
      renderAll();
    });
    semanaSelect?.addEventListener('change', (e) => {
      const n = Number(e.target.value);
      semanaSeleccionada = n === semanaIsoDe(new Date()).semana ? null : n; // la semana en curso sigue siendo la "vigente"
      renderAll();
    });
    mesSelect?.addEventListener('change', (e) => {
      mesSeleccionado = { ...mesSeleccionado, month: Number(e.target.value) };
      renderAll();
    });
    inicioInput?.addEventListener('change', (e) => {
      rangoInicio = e.target.value ? new Date(e.target.value + 'T00:00:00') : rangoInicio;
      if (rangoInicio > rangoFin) {
        rangoFin = rangoInicio;
        if (finInput) finInput.value = toInputDateValue(rangoFin);
      }
      renderAll();
    });
    finInput?.addEventListener('change', (e) => {
      rangoFin = e.target.value ? new Date(e.target.value + 'T00:00:00') : rangoFin;
      if (rangoFin < rangoInicio) {
        rangoInicio = rangoFin;
        if (inicioInput) inicioInput.value = toInputDateValue(rangoInicio);
      }
      renderAll();
    });
    document.getElementById('sb-search-input')?.addEventListener('input', (e) => {
      searchTerm = e.target.value;
      renderAll();
    });
    document.getElementById('sb-limpiar-btn')?.addEventListener('click', limpiarFiltros);
  }

  function computeRange() {
    if (fechaModo === 'dia') return getDateRange(fechaRefDate, 'dia');
    if (fechaModo === 'semana') return semanaSeleccionada ? rangoSemanaIso(semanaIsoDe(new Date()).anio, semanaSeleccionada) : getDateRange(fechaRefDate, 'semana');
    if (fechaModo === 'mes') {
      const base = new Date(mesSeleccionado.year, mesSeleccionado.month, 1);
      return { start: startOfMonth(base), end: endOfMonth(base) };
    }
    if (fechaModo === 'rango') return { start: startOfDay(rangoInicio), end: endOfDay(rangoFin) };
    return null; // 'todo' -> sin filtro de fecha
  }

  /** Filas de Cont_Hodo dentro del mismo rango de fecha activo (sobre su
   * propio campo "fecha"), para la Zona de Transporte. */
  function computeContHodoEnRango() {
    const range = computeRange();
    if (!range) return hodoRecords;
    return hodoRecords.filter((r) => inRange(r.fecha, range));
  }

  /** Viajes de Horario_Cam dentro del rango activo Y de la flota propia
   * (misma whitelist que Cont_Hodo — ver FLOTA_PROPIA_PATENTES), para los
   * indicadores nuevos de la Zona de Transporte (vueltas/día, velocidad
   * real, horarios promedio). */
  function computeHorarioCamEnRango() {
    const range = computeRange();
    const enRango = range ? horarioCamRecords.filter((v) => inRange(v.fecha, range)) : horarioCamRecords;
    return enRango.filter((v) => FLOTA_PROPIA_PATENTES.has(normalizarPatente(v.patente)));
  }

  /** Cajita junto al título: semana(s) del año + rango de fechas exacto que
   * cubre el filtro activo (pedido explícito de gerencia). */
  function formatFechaBadgeHeader(range) {
    if (!range) return '<span>Todas las fechas</span>';
    const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
    const semanas = weekNumbersInRange(range.start, range.end);
    const semanasTxt = semanas.length <= 1 ? `Semana ${semanas[0]}` : `Semanas ${semanas[0]}–${semanas[semanas.length - 1]}`;
    return `<span>${semanasTxt}</span><span>Del ${fmt(range.start)} al ${fmt(range.end)}</span>`;
  }

  function computeUniverso() {
    const range = computeRange();

    const label = document.getElementById('sb-fecha-label');
    if (label) {
      label.textContent = !range
        ? 'Todas las fechas'
        : range.start.toLocaleDateString('es-CL') === range.end.toLocaleDateString('es-CL')
        ? range.start.toLocaleDateString('es-CL')
        : `${range.start.toLocaleDateString('es-CL')} – ${range.end.toLocaleDateString('es-CL')}`;
    }
    const headerBadge = document.getElementById('nc-fecha-badge');
    if (headerBadge) headerBadge.innerHTML = formatFechaBadgeHeader(range);

    const term = searchTerm.trim().toLowerCase();
    return nvRecords.filter((nv) => {
      // Concluida, o vigente con guía/factura y al menos una línea ya
      // despachada (Sal_X_Des = 0 en esa línea).
      const esConcluida = nv.nvEstado === 'C';
      const esVigenteEntregada = nv.nvEstado === 'A' && (nv.guia || nv.factura) && nv.items.some((it) => it.salXDes === 0);
      if (!esConcluida && !esVigenteEntregada) return false;
      if (esSinRastro(nv)) return false;
      if (esRetira ? !esRetiroAmplio(nv) : esRetiroAmplio(nv)) return false;
      if (range && !inRange(nv.fecCreacion, range)) return false;
      if (term) {
        const enTexto =
          (nv.nvNumero || '').toLowerCase().includes(term) ||
          (nv.cliente || '').toLowerCase().includes(term) ||
          (nv.vendedor || '').toLowerCase().includes(term);
        if (!enTexto) return false;
      }
      return true;
    });
  }

  /** Evalúa una NV frente a su fecha compromiso (creación + 48 horas). Si no
   * tiene fecha de coordinación válida se asume que se entregó el día de corte
   * de los datos (`estimada`). Devuelve null cuando no aplica medir el
   * cumplimiento: retiros reales (no hay despacho) o NV sin fecha de creación. */
  function evaluarEntrega(nv) {
    if (nv.esRetiro || !nv.fechaCompromiso) return null;
    const real = coordinacionValida(nv.fCoordinacion);
    const efectiva = real || fechaCorte;
    const atrasada = efectiva > nv.fechaCompromiso;
    return { atrasada, estimada: !real, efectiva, horasAtraso: atrasada ? hoursElapsed(nv.fechaCompromiso, efectiva) : 0 };
  }

  function computePool(universo) {
    // "NV Stock al 100%": todas las líneas sin saldo por despachar. Equivale a
    // Cum_INV (cumplimiento de inventario) = 100% en todas las líneas; en
    // toda la base solo difieren 2 NV (líneas con cantidad 0).
    const completa100 = universo.filter((nv) => nv.items.length > 0 && nv.items.every((it) => it.salXDes === 0));
    const completa100Set = new Set(completa100);
    const parcial = universo.filter((nv) => !completa100Set.has(nv));
    const evaluaciones = new Map();
    const aTiempo = [];
    const atrasada = [];
    const sinFecha = []; // evaluadas con la fecha de corte por no tener coordinación
    universo.forEach((nv) => {
      const ev = evaluarEntrega(nv);
      if (!ev) return;
      evaluaciones.set(nv, ev);
      (ev.atrasada ? atrasada : aTiempo).push(nv);
      if (ev.estimada) sinFecha.push(nv);
    });
    // "Transporte externo" es SOLO lo marcado explícitamente como "EXTR" en
    // Trans (columna de Corte) — no "cualquier NV sin patente" (eso incluía
    // retiros y otros casos que no son realmente transporte externo).
    const externa = universo.filter((nv) => (nv.trans || '').toString().trim().toUpperCase() === 'EXTR');
    // "Flota propia": tiene patente asignada y NO es "EXTR". En Desp, los
    // despachos con transporte externo también traen "EXTR" en la columna
    // Patente, así que contar "cualquier patente" los sumaba también aquí
    // (doble conteo con "Transporte externo").
    const patenteDe = (nv) => (nv.patente || '').toString().trim().toUpperCase();
    const propiaConPatente = universo.filter((nv) => patenteDe(nv) && patenteDe(nv) !== 'EXTR');
    // Ecommerce casi nunca completa Patente/Trans (ese flujo no pasa por el
    // mismo picking con vehículo asignado), así que sin esta regla casi toda
    // ECOM quedaba sin clasificar. Verificado con datos reales (2026-10-08):
    // de 2.063 NV ECOM, 0 han sido "Transporte externo" y de las 405 que ya
    // traen patente, 404 están auditadas "Matias" (la única excepción,
    // "Dussan", también tiene patente propia). Regla pedida: ECOM con auditor
    // vacío o "Matias" cuenta como Flota propia aunque no tenga patente; ECOM
    // con cualquier OTRO auditor NO se reclasifica solo, queda como alerta
    // para revisar a mano (`ecomAuditorInesperado`) por si el patrón cambia.
    const propiaConPatenteSet = new Set(propiaConPatente);
    const esEcom = (nv) => (nv.canal || '').toString().toUpperCase().includes('ECOM');
    const ecomComoPropia = universo.filter(
      (nv) => esEcom(nv) && !propiaConPatenteSet.has(nv) && (auditorDe(nv) === '' || auditorDe(nv) === 'matias')
    );
    const ecomAuditorInesperado = universo.filter((nv) => esEcom(nv) && auditorDe(nv) && auditorDe(nv) !== 'matias');
    const propia = [...propiaConPatente, ...ecomComoPropia];

    // Ítems (líneas de producto) de las NV entregadas a medias que quedaron sin
    // entregar. Criterio de gerencia: el indicador marca TODO lo que no llegó al
    // cliente, sin sub-lecturas: el quiebre (stock al corte) no filtra nada, solo
    // se informa como columna del detalle.
    const itemsSinEntrega = [];
    parcial.forEach((nv) => nv.items.forEach((it) => { if (it.salXDes > 0) itemsSinEntrega.push({ nv, it }); }));
    const sinEntrega = {
      items: itemsSinEntrega,
      nvAfectadas: new Set(itemsSinEntrega.map(({ nv }) => nv)).size,
    };
    return { completa100, parcial, aTiempo, atrasada, sinFecha, evaluaciones, propia, externa, sinEntrega, ecomAuditorInesperado };
  }

  /** Severidad del atraso: horas transcurridas entre la fecha compromiso y la
   * fecha de coordinación (o la de corte si no hay) — no desde la creación de
   * la NV. */
  function computeSeveridadAtraso(pool) {
    const b0_24 = [];
    const b24_48 = [];
    const b48mas = [];
    pool.atrasada.forEach((nv) => {
      const horas = pool.evaluaciones.get(nv).horasAtraso;
      if (horas <= 24) b0_24.push(nv);
      else if (horas <= 48) b24_48.push(nv);
      else b48mas.push(nv);
    });
    return { b0_24, b24_48, b48mas };
  }

  /** Tiempo promedio de ciclo completo (creación -> coordinación), en horas,
   * solo entre las NV del universo con fecha de coordinación real (las
   * estimadas con la fecha de corte no entran: inflarían el promedio).
   * Tampoco entran las coordinadas el MISMO DÍA de la creación: F_coordinacion
   * no trae hora (siempre queda en 00:00), así que la resta no refleja un
   * tiempo real para esos casos — se verían como "0 horas" sin serlo.
   * Verificado el 2026-10-09: es la mayoría de los casos y, al revisarlo por
   * canal, concentrado en Despacho (92,5%), no en Ecommerce como se pensó en
   * un principio (Ecommerce es el canal con MENOS casos así, 45,7%). Se
   * cuentan aparte en vez de promediarlas como si hubieran sido instantáneas. */
  function computeTiempoPromedio(universo) {
    const conCoordinacion = universo.filter((nv) => nv.fecCreacion && coordinacionValida(nv.fCoordinacion));
    const mismoDia = (nv) => startOfDay(nv.fecCreacion).getTime() === startOfDay(nv.fCoordinacion).getTime();
    const medibles = conCoordinacion.filter((nv) => !mismoDia(nv));
    const excluidas = conCoordinacion.length - medibles.length;
    if (medibles.length === 0) return { promedio: null, excluidas, totalConCoordinacion: conCoordinacion.length };
    const totalHoras = medibles.reduce((s, nv) => s + hoursElapsed(nv.fecCreacion, nv.fCoordinacion), 0);
    return { promedio: totalHoras / medibles.length, excluidas, totalConCoordinacion: conCoordinacion.length };
  }

  function renderZonaEntregado(universo, pool) {
    const cont = document.getElementById('nc-entregado');
    if (!cont) return;
    // "Total" = lo que dicen las notas (unidades pedidas y nvTotLinea de todas sus
    // líneas), no solo lo despachado. Se reparte en tres partes que suman justo
    // ese total: entregado en NV al 100%, entregado en NV <100% y lo que quedó sin
    // entrega (el resto, = Σ nvTotLinea − Valor del despacho).
    const totalUnidades = universo.reduce((s, nv) => s + nv.items.reduce((u, it) => u + (it.cant || 0), 0), 0);
    const totalMonto = universo.reduce((s, nv) => s + (nv.montoTotal || 0), 0);
    const pctCumplimiento = universo.length > 0 ? (pool.completa100.length / universo.length) * 100 : 0;
    const monto100 = pool.completa100.reduce((s, nv) => s + (nv.valorDespacho || 0), 0);
    const montoParcial = pool.parcial.reduce((s, nv) => s + (nv.valorDespacho || 0), 0);
    const montoSinEntrega = Math.max(0, totalMonto - monto100 - montoParcial);
    const [pct100, pctParcial, pctSinEntrega] = porcentajesQueSuman100([monto100, montoParcial, montoSinEntrega]);
    // IN FULL se muestra de dos maneras, lado a lado (gerencia decide cuál usar):
    // "En NV" cuenta notas completas; "En pesos" es lo entregado ÷ lo vendido, o
    // sea la suma de las dos tarjetas de monto entregado. Se toma de los
    // porcentajes ya redondeados para que la suma se pueda comprobar a mano.
    const pctInFullPesos = Math.round((pct100 + pctParcial) * 10) / 10;

    cont.innerHTML = `
      <div class="np-zona4-total-row np-zona4-total-row--infull">
        <div class="np-zona4-total">
          <span class="np-zona4-total-label">Total NV despachadas</span>
          <span class="np-zona4-total-value">${universo.length}</span>
          <span class="np-zona4-total-label">${totalUnidades.toLocaleString('es-CL')} unidades · ${fmtMoney(totalMonto)}</span>
        </div>
        <div class="np-zona4-total">
          <span class="np-zona4-total-label">IN FULL</span>
          <div class="np-infull-cols">
            <div class="np-infull-col" title="${pool.completa100.length} de ${universo.length} NV entregadas con Stock al 100%">
              <span class="np-zona4-total-value">${fmtPct(pctCumplimiento)}</span>
              <span class="np-zona4-total-label">En NV</span>
            </div>
            <div class="np-infull-col" title="${fmtMoney(monto100 + montoParcial)} entregados de ${fmtMoney(totalMonto)} vendidos">
              <span class="np-zona4-total-value">${fmtPct(pctInFullPesos)}</span>
              <span class="np-zona4-total-label">En pesos</span>
            </div>
          </div>
        </div>
      </div>
      <div class="np-zona4-grid np-zona4-grid--3col np-zona4-grid--centrado">
        <div class="kpi-card kpi-card--success">
          <div class="kpi-card-label">NV entregadas con Stock al 100%</div>
          <div class="kpi-card-value">${pool.completa100.length}</div>
          <button class="pill-btn" id="nc-entregado100-toggle">${isDetalleActivo('entregado100') ? '▴ Ocultar' : '▾ Ver detalle'}</button>
        </div>
        <div class="kpi-card kpi-card--danger">
          <div class="kpi-card-label">NV entregadas con Stock &lt;100%</div>
          <div class="kpi-card-value">${pool.parcial.length}</div>
          <button class="pill-btn" id="nc-entregadoParcial-toggle">${isDetalleActivo('entregadoParcial') ? '▴ Ocultar' : '▾ Ver detalle'}</button>
        </div>
        <div class="kpi-card kpi-card--danger">
          <div class="kpi-card-label">Sin entrega: ítems por NV</div>
          <div class="kpi-card-value">${pool.sinEntrega.items.length}</div>
          <div class="kpi-card-sub">ítems en ${pool.sinEntrega.nvAfectadas} NV</div>
          <button class="pill-btn" id="nc-sinEntregaQuiebre-toggle">${isDetalleActivo('sinEntregaQuiebre') ? '▴ Ocultar' : '▾ Ver detalle'}</button>
        </div>
        <div class="kpi-card kpi-card--success">
          <div class="kpi-card-label">Monto entregado con Stock al 100%</div>
          <div class="kpi-card-value">${fmtMoney(monto100)}</div>
          <div class="kpi-card-sub">${pct100}% del total NV</div>
        </div>
        <div class="kpi-card kpi-card--danger">
          <div class="kpi-card-label">Monto entregado con Stock &lt;100%</div>
          <div class="kpi-card-value">${fmtMoney(montoParcial)}</div>
          <div class="kpi-card-sub">${pctParcial}% del total NV</div>
        </div>
        <div class="kpi-card kpi-card--danger">
          <div class="kpi-card-label">Monto sin entrega</div>
          <div class="kpi-card-value">${fmtMoney(montoSinEntrega)}</div>
          <div class="kpi-card-sub">${pctSinEntrega}% del total NV</div>
        </div>
      </div>
    `;
    document.getElementById('nc-entregado100-toggle')?.addEventListener('click', () => setDetalleActivo('entregado100'));
    document.getElementById('nc-entregadoParcial-toggle')?.addEventListener('click', () => setDetalleActivo('entregadoParcial'));
    document.getElementById('nc-sinEntregaQuiebre-toggle')?.addEventListener('click', () => setDetalleActivo('sinEntregaQuiebre'));
  }

  function renderZonaTiempo(universo, pool) {
    const cont = document.getElementById('nc-tiempo');
    if (!cont) return;
    // Total evaluado = NV con fecha compromiso que no son retiros reales (un
    // retiro en tienda no es un despacho, no tiene plazo de entrega).
    const evaluadas = pool.aTiempo.length + pool.atrasada.length;
    const pctATiempo = evaluadas > 0 ? (pool.aTiempo.length / evaluadas) * 100 : 0;
    const pctAtrasada = evaluadas > 0 ? (pool.atrasada.length / evaluadas) * 100 : 0;
    const severidad = computeSeveridadAtraso(pool);
    const tiempoPromedio = computeTiempoPromedio(universo);

    cont.innerHTML = `
      <div class="np-otd-hero">
        <div class="np-otd-hero-cols">
          <div class="np-otd-hero-col">
            <div class="np-otd-hero-label">OTD — On-Time Delivery</div>
            <div class="np-otd-hero-value">${fmtPct(pctATiempo)}</div>
            <div class="np-otd-hero-formula">OTD (%) = (despachos a tiempo / total despachos) × 100</div>
            <div class="np-otd-hero-sub">${pool.aTiempo.length} a tiempo / ${evaluadas} total</div>
          </div>
          <div class="np-otd-hero-col">
            <div class="np-otd-hero-label">Tiempo promedio de entrega</div>
            <div class="np-otd-hero-extra-value">${tiempoPromedio.promedio === null ? 'N/A' : `${(tiempoPromedio.promedio / HOURS_PER_DAY).toFixed(2)} días`}</div>
            <div class="np-otd-hero-formula">${tiempoPromedio.promedio === null ? '' : `${tiempoPromedio.promedio.toFixed(1)}h ${HOURS_LABEL} · `}creación → coordinación</div>
          </div>
        </div>
      </div>
      <div class="np-zona4-grid">
        <div class="kpi-card kpi-card--success">
          <div class="kpi-card-label">A tiempo · NV</div>
          <div class="kpi-card-value">${pool.aTiempo.length}</div>
          <div class="kpi-card-sub">${fmtPct(pctATiempo)} del total</div>
        </div>
        <div class="kpi-card kpi-card--danger">
          <div class="kpi-card-label">Atrasada (+48h ${HOURS_LABEL}) · NV</div>
          <div class="kpi-card-value">${pool.atrasada.length}</div>
          <div class="kpi-card-sub">${fmtPct(pctAtrasada)} del total</div>
          <button class="pill-btn" id="nc-atrasada-toggle">${isDetalleActivo('atrasada') ? '▴ Ocultar' : '▾ Ver detalle'}</button>
        </div>
      </div>
      <div class="np-canvas-subtitle">Severidad del atraso (desde fecha compromiso)</div>
      <div class="np-zona4-grid np-zona4-grid--3col">
        <div class="kpi-card kpi-card--warn">
          <div class="kpi-card-label">0–24h de atraso</div>
          <div class="kpi-card-value">${severidad.b0_24.length}</div>
          <button class="pill-btn" id="nc-atraso024-toggle">${isDetalleActivo('atraso0_24') ? '▴ Ocultar' : '▾ Ver detalle'}</button>
        </div>
        <div class="kpi-card kpi-card--warn">
          <div class="kpi-card-label">24–48h de atraso</div>
          <div class="kpi-card-value">${severidad.b24_48.length}</div>
          <button class="pill-btn" id="nc-atraso2448-toggle">${isDetalleActivo('atraso24_48') ? '▴ Ocultar' : '▾ Ver detalle'}</button>
        </div>
        <div class="kpi-card kpi-card--danger">
          <div class="kpi-card-label">+48h de atraso</div>
          <div class="kpi-card-value">${severidad.b48mas.length}</div>
          <button class="pill-btn" id="nc-atraso48-toggle">${isDetalleActivo('atraso48mas') ? '▴ Ocultar' : '▾ Ver detalle'}</button>
        </div>
      </div>
      <div class="np-sin-fecha">
        <span><strong>${pool.sinFecha.length}</strong> NV sin fecha de coordinación · se evalúan como entregadas el ${fechaCorte.toLocaleDateString('es-CL')} (día de corte de los datos)</span>
        ${pool.sinFecha.length > 0 ? '<button class="pill-btn" id="nc-sinfecha-export">⬇ Descargar detalle</button>' : ''}
      </div>
    `;
    document.getElementById('nc-sinfecha-export')?.addEventListener('click', (e) => {
      const filas = pool.sinFecha
        .slice()
        .sort((a, b) => (a.fecCreacion?.getTime() || 0) - (b.fecCreacion?.getTime() || 0))
        .map((nv) => {
          const ev = pool.evaluaciones.get(nv);
          return [
            nv.nvNumero,
            nv.cliente,
            nv.vendedor,
            nv.canal,
            nv.nvEstado,
            fmtFechaHora(nv.fecCreacion),
            fmtFechaHora(nv.fechaCompromiso),
            nv.guia || '',
            nv.factura || '',
            nv.auditor || nv.auditorCorte || '',
            nv.patente || nv.trans || '',
            tipoDespacho(nv),
            nv.statusDes || '',
            Math.round(nv.valorDespacho || 0),
            ev.atrasada ? 'Atrasada' : 'A tiempo',
            Math.round(ev.horasAtraso),
          ];
        });
      downloadXlsx(
        `nv_sin_fecha_coordinacion_${new Date().toISOString().slice(0, 10)}.xlsx`,
        ['NV', 'Cliente', 'Vendedor', 'Canal', 'Estado NV', 'Fecha creación', 'Fecha compromiso', 'Guía', 'Factura', 'Auditor', 'Patente / transporte', 'Tipo de despacho', 'Status despacho', 'Monto despachado', 'Resultado asumido', 'Horas de atraso asumidas'],
        filas
      );
      flashExportFeedback(e.currentTarget);
    });
    document.getElementById('nc-atrasada-toggle')?.addEventListener('click', () => setDetalleActivo('atrasada'));
    document.getElementById('nc-atraso024-toggle')?.addEventListener('click', () => setDetalleActivo('atraso0_24'));
    document.getElementById('nc-atraso2448-toggle')?.addEventListener('click', () => setDetalleActivo('atraso24_48'));
    document.getElementById('nc-atraso48-toggle')?.addEventListener('click', () => setDetalleActivo('atraso48mas'));
  }

  function renderZonaTransporte(universo, pool) {
    const cont = document.getElementById('nc-transporte');
    if (!cont) return;
    const montoPropia = pool.propia.reduce((s, nv) => s + (nv.valorDespacho || 0), 0);
    const montoExterna = pool.externa.reduce((s, nv) => s + (nv.valorDespacho || 0), 0);

    // Solo las patentes reales de la flota propia — Cont_Hodo no valida esto
    // por su cuenta (se confirmó con un caso real: apareció "J35", que no es
    // ninguna de las 3 patentes de la empresa, sumando km que no correspondían).
    const hodoEnRango = computeContHodoEnRango().filter((r) => FLOTA_PROPIA_PATENTES.has(normalizarPatente(r.patente)));
    const porPatente = new Map();
    hodoEnRango.forEach((r) => {
      const patente = normalizarPatente(r.patente);
      if (!porPatente.has(patente)) porPatente.set(patente, { patente, km: 0, nvEntregadas: 0, monto: 0 });
      const p = porPatente.get(patente);
      p.km += r.kmUso || 0;
      p.nvEntregadas += r.nvEntregadas || 0;
      p.monto += r.montoEntregado || 0;
    });
    const flota = [...porPatente.values()].sort((a, b) => b.km - a.km);
    const totalKm = flota.reduce((s, p) => s + p.km, 0);
    const totalNvHodo = flota.reduce((s, p) => s + p.nvEntregadas, 0);
    // DPR (Distancia Por Recorrido) — km promedio que toma cada entrega
    // registrada en Cont_Hodo. Más legible que el ratio al revés (NV/km),
    // que daba un decimal chico y poco intuitivo.
    const dprPromedio = totalNvHodo > 0 ? totalKm / totalNvHodo : null;

    // Hoja de horarios (Horario_Trans / Horario_Cam): vueltas por día,
    // velocidad real y horarios — misma flota propia y mismo rango de fecha
    // que Cont_Hodo de arriba, pero es otra fuente (por viaje, no por
    // patente/día) así que se combina con el km de Cont_Hodo solo para la
    // velocidad real. Los horarios son la PRIMERA salida y la ÚLTIMA llegada
    // de cada patente en cada día (la ventana en que opera la flota), luego
    // promediadas entre patente-días; promediar todos los viajes daba una
    // hora de medio día que no dice a qué hora parte ni termina la flota.
    const viajesEnRango = computeHorarioCamEnRango();
    const porPatenteDia = new Map();
    let sumaDuracionMin = 0;
    viajesEnRango.forEach((v) => {
      sumaDuracionMin += v.duracionMin || 0;
      if (!v.fecha) return;
      const key = `${normalizarPatente(v.patente)}|${startOfDay(v.fecha).getTime()}`;
      const d = porPatenteDia.get(key) || { primeraSalida: Infinity, ultimaLlegada: -Infinity };
      d.primeraSalida = Math.min(d.primeraSalida, v.salidaMin);
      d.ultimaLlegada = Math.max(d.ultimaLlegada, v.ingresoMin);
      porPatenteDia.set(key, d);
    });
    const patenteDias = [...porPatenteDia.values()];
    const promedioMin = (campo) => patenteDias.reduce((s, d) => s + d[campo], 0) / patenteDias.length;
    const vueltasPorDia = patenteDias.length > 0 ? viajesEnRango.length / patenteDias.length : null;
    const horasEnRuta = sumaDuracionMin / 60;
    const velocidadReal = horasEnRuta > 0 ? totalKm / horasEnRuta : null;
    const salidaProm = patenteDias.length > 0 ? minutosToHora(promedioMin('primeraSalida')) : null;
    const llegadaProm = patenteDias.length > 0 ? minutosToHora(promedioMin('ultimaLlegada')) : null;

    cont.innerHTML = `
      <div class="np-transporte-resumen">
        <div class="np-transporte-resumen-card np-transporte-resumen-card--propia">
          <i class="ti ti-truck np-transporte-resumen-icon"></i>
          <div>
            <div class="np-transporte-resumen-label">Flota propia</div>
            <div class="np-transporte-resumen-value">${pool.propia.length} NV <span>·</span> ${fmtMoney(montoPropia)}</div>
          </div>
        </div>
        <div class="np-transporte-resumen-card np-transporte-resumen-card--externa">
          <i class="ti ti-building-store np-transporte-resumen-icon"></i>
          <div>
            <div class="np-transporte-resumen-label">Transporte externo</div>
            <div class="np-transporte-resumen-value">${pool.externa.length} NV <span>·</span> ${fmtMoney(montoExterna)}</div>
          </div>
        </div>
      </div>
      <p class="kpi-note">Ecommerce no completa Patente/Trans en Corte, así que cuenta como Flota propia por el canal (auditor vacío o "Matías"); solo se excluye de esta cuenta automática cuando trae otro auditor, caso que queda abajo como alerta para revisar a mano.</p>
      ${
        pool.ecomAuditorInesperado.length > 0
          ? `<div class="np-alerta-row np-alerta-row--first">
              <span class="status-badge status-badge--warning">Ecommerce con auditor distinto de "Matías" (revisar)</span>
              <span><strong>${pool.ecomAuditorInesperado.length}</strong> NV</span>
              <button class="pill-btn" id="nc-ecom-alerta-toggle">${ecomAlertaAbierta ? '▴ Ocultar' : '▾ Ver detalle'}</button>
            </div>
            <div id="nc-ecom-alerta-detalle" class="${ecomAlertaAbierta ? '' : 'hidden'}"></div>`
          : ''
      }
      <div class="np-zona4-grid np-zona4-grid--3col">
        <div class="kpi-card kpi-card--propia kpi-card--icon">
          <i class="ti ti-repeat kpi-card-icon"></i>
          <div class="kpi-card-label">Vueltas por día (prom.)</div>
          <div class="kpi-card-value">${vueltasPorDia === null ? 'N/A' : vueltasPorDia.toFixed(1)}</div>
        </div>
        <div class="kpi-card kpi-card--propia kpi-card--icon">
          <i class="ti ti-road kpi-card-icon"></i>
          <div class="kpi-card-label">Km recorridos</div>
          <div class="kpi-card-value">${totalKm.toLocaleString('es-CL')}</div>
        </div>
        <div class="kpi-card kpi-card--propia kpi-card--icon">
          <i class="ti ti-gauge kpi-card-icon"></i>
          <div class="kpi-card-label">DPR prom. km/entrega</div>
          <div class="kpi-card-value">${dprPromedio === null ? 'N/A' : dprPromedio.toFixed(1)}</div>
        </div>
        <div class="kpi-card kpi-card--propia kpi-card--icon">
          <i class="ti ti-bolt kpi-card-icon"></i>
          <div class="kpi-card-label">Velocidad real</div>
          <div class="kpi-card-value">${velocidadReal === null ? 'N/A' : velocidadReal.toFixed(1)}<span class="kpi-card-unit"> km/h</span></div>
        </div>
        <div class="kpi-card kpi-card--propia kpi-card--icon">
          <i class="ti ti-logout kpi-card-icon"></i>
          <div class="kpi-card-label">Primera salida (prom.)</div>
          <div class="kpi-card-value">${salidaProm || 'N/A'}</div>
        </div>
        <div class="kpi-card kpi-card--propia kpi-card--icon">
          <i class="ti ti-login kpi-card-icon"></i>
          <div class="kpi-card-label">Última llegada (prom.)</div>
          <div class="kpi-card-value">${llegadaProm || 'N/A'}</div>
        </div>
      </div>
      <p class="kpi-note">Km y "NV entregadas" vienen de Cont_Hodo; vueltas, velocidad y horarios vienen de Horario_Trans — ambas son bitácoras propias (registro por patente/día y por viaje), fuentes separadas de las NV de Corte, así que sus conteos no tienen por qué coincidir exactamente con los de arriba.</p>
      <button class="pill-btn" id="nc-transporte-detalle-toggle">${transporteDetalleAbierto ? '▴ Ocultar detalle por patente/día' : `▾ Ver detalle por patente/día (${flota.length} patentes)`}</button>
      <div id="nc-transporte-detalle" class="${transporteDetalleAbierto ? '' : 'hidden'}"></div>
    `;

    document.getElementById('nc-transporte-detalle-toggle')?.addEventListener('click', () => {
      transporteDetalleAbierto = !transporteDetalleAbierto;
      renderZonaTransporte(universo, pool);
    });

    if (transporteDetalleAbierto) {
      const detalleCont = document.getElementById('nc-transporte-detalle');
      if (!detalleCont) return;
      const filasOrdenadas = hodoEnRango
        .slice()
        .sort((a, b) => (b.fecha?.getTime() || 0) - (a.fecha?.getTime() || 0) || (a.patente || '').localeCompare(b.patente || ''));
      const filas = filasOrdenadas.map((r) => [
        r.fecha ? r.fecha.toLocaleDateString('es-CL') : '',
        normalizarPatente(r.patente),
        r.operador || '',
        (r.kmUso || 0).toLocaleString('es-CL'),
        r.nvEntregadas || 0,
        fmtMoney(r.montoEntregado),
      ]);
      detalleCont.innerHTML = `
        <button class="pill-btn" id="nc-transporte-export">⬇ Exportar Excel</button>
        ${tableHtml(['Fecha', 'Patente', 'Operador', 'Km', 'NV entregadas', 'Monto'], filas)}
      `;
      document.getElementById('nc-transporte-export')?.addEventListener('click', (e) => {
        const xlsxRows = filasOrdenadas.map((r) => [
          r.fecha ? r.fecha.toLocaleDateString('es-CL') : '',
          normalizarPatente(r.patente),
          r.operador || '',
          r.kmUso || 0,
          r.nvEntregadas || 0,
          Math.round(r.montoEntregado || 0),
        ]);
        downloadXlsx(
          `transporte_patente_dia_${new Date().toISOString().slice(0, 10)}.xlsx`,
          ['Fecha', 'Patente', 'Operador', 'Km', 'NV entregadas', 'Monto'],
          xlsxRows
        );
        flashExportFeedback(e.currentTarget);
      });
    }

    document.getElementById('nc-ecom-alerta-toggle')?.addEventListener('click', () => {
      ecomAlertaAbierta = !ecomAlertaAbierta;
      renderZonaTransporte(universo, pool);
    });

    if (ecomAlertaAbierta) {
      const alertaCont = document.getElementById('nc-ecom-alerta-detalle');
      if (!alertaCont) return;
      const filasOrdenadas = pool.ecomAuditorInesperado
        .slice()
        .sort((a, b) => (a.cliente || '').localeCompare(b.cliente || ''));
      const filas = filasOrdenadas.map((nv) => [
        nv.nvNumero,
        nv.cliente,
        nv.auditor || nv.auditorCorte || '',
        nv.patente || 'Sin patente',
        fmtMoney(nv.valorDespacho),
        fmtFechaHora(nv.fechaCompromiso) || 'N/A',
        nv.vendedor || '',
      ]);
      alertaCont.innerHTML = `
        <button class="pill-btn" id="nc-ecom-alerta-export">⬇ Exportar Excel</button>
        <div class="kpi-table-scroll">${tableHtml(['NV', 'Cliente', 'Auditor', 'Patente', 'Monto', 'Fecha compromiso', 'Vendedor'], filas)}</div>
      `;
      document.getElementById('nc-ecom-alerta-export')?.addEventListener('click', (e) => {
        const xlsxRows = filasOrdenadas.map((nv) => [
          nv.nvNumero,
          nv.cliente,
          nv.auditor || nv.auditorCorte || '',
          nv.patente || '',
          Math.round(nv.valorDespacho || 0),
          fmtFechaHora(nv.fechaCompromiso) || '',
          nv.vendedor || '',
        ]);
        downloadXlsx(
          `ecom_auditor_inesperado_${new Date().toISOString().slice(0, 10)}.xlsx`,
          ['NV', 'Cliente', 'Auditor', 'Patente', 'Monto', 'Fecha compromiso', 'Vendedor'],
          xlsxRows
        );
        flashExportFeedback(e.currentTarget);
      });
    }
  }

  /** Detalle de la tarjeta "Sin entrega: ítems por NV": una fila por ítem no
   * entregado, agrupadas por NV. Su suma de montos es el "Monto sin entrega" de
   * la tarjeta de abajo. La columna "Quiebre al corte" dice si el stock
   * disponible (Stock_Dis) de ese producto, a la fecha de la última actualización
   * de datos, no alcanza para todo lo pendiente: es una foto de ese día, no la
   * causa por la que quedó sin entregar. */
  function renderDetalleItemsSinEntrega(cont, pool) {
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const filas = pool.sinEntrega.items
      .slice()
      .sort((a, b) => (a.nv.nvNumero || '').localeCompare(b.nv.nvNumero || '') || montoSinEntregarLinea(b.it) - montoSinEntregarLinea(a.it));
    const entregadas = (it) => Math.max(0, (it.cant || 0) - unidadesSinEntregarLinea(it));
    const quiebre = (it) => (it.quiebre ? 'Sí' : 'No');
    const fechaCorte = loadedAt ? ` (${loadedAt.toLocaleDateString('es-CL')})` : '';
    const headers = ['NV', 'Cliente', 'Código', 'Producto', 'Pedido', 'Entregado', 'Sin entregar', 'Quiebre al corte', 'Monto sin entregar'];
    const rows = filas
      .slice(0, 300)
      .map(({ nv, it }) => [esc(nv.nvNumero), esc(nv.cliente), esc(it.codProd), esc(it.detProd), it.cant, entregadas(it), unidadesSinEntregarLinea(it), quiebre(it), fmtMoney(montoSinEntregarLinea(it))]);
    const xlsxHeaders = ['NV', 'Cliente', 'Vendedor', 'Canal', 'Código', 'Producto', 'Pedido (unid)', 'Entregado (unid)', 'Sin entregar (unid)', 'Quiebre al corte', 'Monto sin entregar'];
    const xlsxRows = filas.map(({ nv, it }) => [nv.nvNumero, nv.cliente, nv.vendedor, nv.canal, it.codProd, it.detProd, it.cant, entregadas(it), unidadesSinEntregarLinea(it), quiebre(it), Math.round(montoSinEntregarLinea(it))]);

    cont.innerHTML = `
      <h4>Detalle — Sin entrega: ítems por NV${filas.length > 300 ? ` <span class="kpi-note">(mostrando los primeros 300 de ${filas.length})</span>` : ''}</h4>
      <p class="kpi-note"><strong>Quiebre al corte${fechaCorte}:</strong> el stock disponible (Stock_Dis) no alcanza para todo lo pendiente de ese producto. Es una foto del día de la actualización, no la causa de la no entrega.</p>
      <button class="pill-btn" id="nc-detalle-export">⬇ Exportar Excel</button>
      ${tableHtml(headers, rows)}
    `;
    document.getElementById('nc-detalle-export')?.addEventListener('click', (e) => {
      downloadXlsx(`nv_items_sin_entrega_${new Date().toISOString().slice(0, 10)}.xlsx`, xlsxHeaders, xlsxRows);
      flashExportFeedback(e.currentTarget);
    });
  }

  function renderDetalleCompartido(universo, pool) {
    const box = document.getElementById('nc-detalle-box');
    const cont = document.getElementById('nc-detalle');
    if (!box || !cont) return;
    if (!detalleActivo) {
      box.classList.add('hidden');
      cont.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');

    if (detalleActivo.tipo === 'sinEntregaQuiebre') {
      renderDetalleItemsSinEntrega(cont, pool);
      return;
    }

    const severidad = computeSeveridadAtraso(pool);
    const listasPorTipo = {
      entregado100: pool.completa100,
      entregadoParcial: pool.parcial,
      atrasada: pool.atrasada,
      atraso0_24: severidad.b0_24,
      atraso24_48: severidad.b24_48,
      atraso48mas: severidad.b48mas,
    };
    const titulosPorTipo = {
      entregado100: 'NV entregadas con Stock al 100%',
      entregadoParcial: 'NV entregadas con Stock &lt;100%',
      atrasada: `Atrasadas (+48h ${HOURS_LABEL})`,
      atraso0_24: `Atrasadas 0–24h ${HOURS_LABEL} (desde fecha compromiso)`,
      atraso24_48: `Atrasadas 24–48h ${HOURS_LABEL} (desde fecha compromiso)`,
      atraso48mas: `Atrasadas +48h ${HOURS_LABEL} (desde fecha compromiso)`,
    };
    const list = listasPorTipo[detalleActivo.tipo] || [];
    const titulo = titulosPorTipo[detalleActivo.tipo] || detalleActivo.tipo;
    const totalCount = list.length;
    const fCoordTexto = (nv) => {
      const f = coordinacionValida(nv.fCoordinacion);
      return f ? f.toLocaleDateString('es-CL') : 'Sin fecha';
    };
    const headers = ['NV', 'Cliente', 'Canal', 'Guía', 'Unidades', 'Monto', 'Fecha compromiso', 'F. coordinación'];
    const rows = list
      .slice(0, 300)
      .map((nv) => [nv.nvNumero, nv.cliente, nv.canal || '', nv.guia || '', nv.unidadesEntregadas || 0, fmtMoney(nv.valorDespacho), fmtFechaHora(nv.fechaCompromiso) || 'N/A', fCoordTexto(nv)]);
    const xlsxHeaders = ['NV', 'Cliente', 'Vendedor', 'Canal', 'Guia', 'Unidades', 'Monto', 'Fecha compromiso', 'F. coordinación'];
    const xlsxRows = list.map((nv) => [
      nv.nvNumero,
      nv.cliente,
      nv.vendedor,
      nv.canal,
      nv.guia || '',
      nv.unidadesEntregadas || 0,
      Math.round(nv.valorDespacho || 0),
      fmtFechaHora(nv.fechaCompromiso),
      fCoordTexto(nv),
    ]);

    cont.innerHTML = `
      <h4>Detalle — ${titulo}${totalCount > 300 ? ` <span class="kpi-note">(mostrando las primeras 300 de ${totalCount})</span>` : ''}</h4>
      <button class="pill-btn" id="nc-detalle-export">⬇ Exportar Excel</button>
      ${tableHtml(headers, rows)}
    `;
    document.getElementById('nc-detalle-export')?.addEventListener('click', (e) => {
      downloadXlsx(`nv_${detalleActivo.tipo}_${new Date().toISOString().slice(0, 10)}.xlsx`, xlsxHeaders, xlsxRows);
      flashExportFeedback(e.currentTarget);
    });
  }

  function renderAll() {
    const universo = computeUniverso();
    const pool = computePool(universo);
    renderZonaEntregado(universo, pool);
    if (esRetira) {
      renderTopClientesRetira();
    } else {
      renderZonaTiempo(universo, pool);
      renderZonaTransporte(universo, pool);
    }
    renderDetalleCompartido(universo, pool);
  }

  function limpiarFiltros() {
    fechaModo = 'semana';
    fechaRefDate = yesterday();
    mesSeleccionado = { year: new Date().getFullYear(), month: new Date().getMonth() };
    semanaSeleccionada = null;
    rangoInicio = new Date(Date.now() - 30 * 86400000);
    rangoFin = new Date();
    searchTerm = '';
    detalleActivo = null;
    filtrosAbiertos = true;
    renderSidebarFiltros();
    renderAll();
  }

  renderSidebarFiltros();
  renderAll();
}

// ---------------------------------------------------------------------------
// 0c. Rendimiento del equipo — ranking de Operadores de Packing, Conductores
// y Auditores por entregas de HOY y de la SEMANA (últimos 5 días hábiles),
// en cantidad y en monto. Medido por fecha de coordinación real — fijo, no
// tiene filtros propios de fecha (antes vivía como una zona más dentro de
// "NV entregadas", ahora es su propia pestaña). Cada tarjeta muestra su
// gráfico a la vista y el detalle (tabla) en un desplegable, cerrado por defecto.
// ---------------------------------------------------------------------------

function renderRendimientoEquipo(el, nvRecords) {
  // Esta pestaña no tiene filtros propios — si venías de "NV entregadas" o
  // "NV por entregar" (que sí llenan el sidebar), hay que limpiarlo o
  // quedarían controles de la otra sección sin efecto.
  const sidebarFilters = document.getElementById('sidebar-filters');
  if (sidebarFilters) sidebarFilters.innerHTML = '';

  el.innerHTML = `
    <div class="np-header">
      <h2>Rendimiento del equipo</h2>
      <p class="np-header-sub">Entregas de hoy y de la semana (últimos 5 días hábiles), por fecha de coordinación real.</p>
    </div>
    <div class="np-rendimiento-layout">
      <div class="zone-box zone-box--rendimiento-picking">
        <h3 class="np-canvas-title">Equipo de Picking</h3>
        <div id="re-picking"></div>
      </div>
      <div class="np-rendimiento-row">
        <div class="zone-box zone-box--rendimiento-conductores">
          <h3 class="np-canvas-title">Conductores</h3>
          <div id="re-conductores"></div>
        </div>
        <div class="zone-box zone-box--rendimiento-auditores">
          <h3 class="np-canvas-title">Auditores</h3>
          <div id="re-auditores"></div>
        </div>
      </div>
    </div>
  `;

  function computeRendimientoEquipo() {
    const hoyRange = getDateRange(new Date(), 'dia');
    const semanaRange = lastBusinessDaysRange(5, new Date());
    const conCoordinacion = nvRecords.filter((nv) => {
      const esConcluida = nv.nvEstado === 'C';
      const esVigenteEntregada = nv.nvEstado === 'A' && (nv.guia || nv.factura) && nv.items.some((it) => it.salXDes === 0);
      return (esConcluida || esVigenteEntregada) && nv.fCoordinacion;
    });

    function ranking(getRol) {
      const map = new Map();
      conCoordinacion.forEach((nv) => {
        const rol = (getRol(nv) || '').toString().trim() || 'Sin asignar';
        if (!map.has(rol)) {
          map.set(rol, {
            nombre: rol,
            cantHoy: 0, montoHoy: 0, cantSemana: 0, montoSemana: 0,
            // Dos formas más de mirar la misma acción de picking: cuántas
            // líneas de producto distintas tocó, y cuántas unidades en total
            // (Equipo de Picking únicamente — los otros roles no las usan).
            lineasHoy: 0, lineasSemana: 0, unidadesHoy: 0, unidadesSemana: 0,
          });
        }
        const r = map.get(rol);
        const numLineas = nv.items ? nv.items.length : 0;
        const numUnidades = nv.items ? nv.items.reduce((s, it) => s + (it.cant || 0), 0) : 0;
        if (inRange(nv.fCoordinacion, hoyRange)) {
          r.cantHoy += 1;
          r.montoHoy += nv.valorDespacho || 0;
          r.lineasHoy += numLineas;
          r.unidadesHoy += numUnidades;
        }
        if (inRange(nv.fCoordinacion, semanaRange)) {
          r.cantSemana += 1;
          r.montoSemana += nv.valorDespacho || 0;
          r.lineasSemana += numLineas;
          r.unidadesSemana += numUnidades;
        }
      });
      return [...map.values()].filter((r) => r.cantSemana > 0 || r.cantHoy > 0).sort((a, b) => b.cantSemana - a.cantSemana);
    }

    return {
      packing: ranking((nv) => nv.opPicking),
      conductores: ranking((nv) => nv.chofer),
      auditores: ranking((nv) => nv.auditor || nv.auditorCorte),
    };
  }

  // Desplegable del detalle (tabla) de cada tarjeta: parte cerrado.
  const detalleAbierto = { picking: false, conductores: false, auditores: false };
  const chartInstances = {};
  let pickingPeriodo = 'semana'; // 'dia' | 'semana' — switch propio del gráfico de Picking

  function destroyChart(canvasId) {
    if (chartInstances[canvasId]) {
      chartInstances[canvasId].destroy();
      delete chartInstances[canvasId];
    }
  }

  function drawChart(canvasId, rows) {
    destroyChart(canvasId);
    const canvasEl = document.getElementById(canvasId);
    if (!canvasEl || !window.Chart) return;
    chartInstances[canvasId] = new window.Chart(canvasEl, {
      type: 'bar',
      data: {
        labels: rows.map((r) => r.nombre),
        datasets: [
          { label: 'Hoy', data: rows.map((r) => r.cantHoy), backgroundColor: '#2563EB' },
          { label: 'Semana', data: rows.map((r) => r.cantSemana), backgroundColor: '#93C5FD' },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false, // llena la caja de 240 px de alto y todo el ancho de la tarjeta
        plugins: { legend: { position: 'bottom' } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  /** Gráfico propio de Equipo de Picking, de UN solo período a la vez (Hoy o
   * Semana, según el switch). Por operador hay dos columnas: la primera lleva
   * las líneas/ítems (verde, atrás) con las NV (azul) delante, en la misma
   * columna — cada NV tiene al menos una línea, así que las líneas siempre son
   * igual o más que las NV y el azul nunca pasa al verde —, y la segunda, a un
   * costado, las unidades (naranja) en un eje derecho aparte, porque suelen ser
   * un número muchísimo más grande. Chart.js no superpone barras: el azul se
   * apila en su columna y el verde pone solo lo que le falta para llegar al
   * total de líneas, así el alto de la columna es el total de líneas. Los
   * números sobre las barras y el tooltip muestran siempre los valores reales. */
  function drawChartPicking(canvasId, rows, periodo) {
    destroyChart(canvasId);
    const canvasEl = document.getElementById(canvasId);
    if (!canvasEl || !window.Chart) return;
    const sufijo = periodo === 'dia' ? 'Hoy' : 'Semana';
    const nv = rows.map((r) => r[`cant${sufijo}`]);
    const lineas = rows.map((r) => r[`lineas${sufijo}`]);
    const unidades = rows.map((r) => r[`unidades${sufijo}`]);
    const fmtNum = (n) => Math.round(n || 0).toLocaleString('es-CL');

    // Escribe las cantidades sobre las barras: las líneas arriba de la columna,
    // las NV sobre el azul (adentro si el azul es lo bastante alto, si no justo
    // encima, y las líneas suben para no taparlas) y las unidades arriba de la
    // barra naranja, subiendo si chocan con los números de la columna de al
    // lado. Los ceros no se escriben. Con las barras muy delgadas (ventanas
    // angostas) las unidades dejan de escribirse y, más angosto aún (celular),
    // tampoco las demás: queda el tooltip.
    const cantidadesSobreBarras = {
      id: 'cantidadesSobreBarras',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        const [metaNv, metaLineas, metaUnidades] = [0, 1, 2].map((i) => chart.getDatasetMeta(i));
        const anchoBarra = metaNv.data[0] ? metaNv.data[0].width : 0;
        if (anchoBarra < 14) return;
        const tamano = anchoBarra >= 24 ? 11 : 10;
        const altoTexto = tamano + 1;
        ctx.save();
        ctx.font = `700 ${tamano}px 'Inter', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif`;
        ctx.textAlign = 'center';
        const escribir = (texto, x, y, color, base) => {
          ctx.fillStyle = color;
          ctx.textBaseline = base;
          ctx.fillText(texto, x, y);
        };
        const cajaDe = (texto, x, yBase) => {
          const mitad = ctx.measureText(texto).width / 2;
          return { x1: x - mitad, x2: x + mitad, y1: yBase - altoTexto, y2: yBase };
        };
        const chocan = (a, b) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
        nv.forEach((_, i) => {
          const barraNv = metaNv.data[i];
          const barraLineas = metaLineas.data[i];
          const barraUnidades = metaUnidades.data[i];
          if (!barraNv) return;
          const ocupados = []; // números de la columna NV/líneas que el de unidades no debe tapar
          let yLineas = (barraLineas.base - barraLineas.y > 0 ? barraLineas.y : barraNv.y) - 3;
          if (nv[i] > 0) {
            const textoNv = fmtNum(nv[i]);
            if (barraNv.base - barraNv.y >= 16) {
              escribir(textoNv, barraNv.x, barraNv.y + 3, '#FFFFFF', 'top');
              ocupados.push(cajaDe(textoNv, barraNv.x, barraNv.y + 3 + altoTexto));
            } else {
              const yNv = barraNv.y - 3;
              escribir(textoNv, barraNv.x, yNv, '#172033', 'bottom');
              ocupados.push(cajaDe(textoNv, barraNv.x, yNv));
              yLineas = Math.min(yLineas, barraNv.y - 16);
            }
          }
          if (lineas[i] > 0) {
            escribir(fmtNum(lineas[i]), barraLineas.x, yLineas, '#172033', 'bottom');
            ocupados.push(cajaDe(fmtNum(lineas[i]), barraLineas.x, yLineas));
          }
          if (unidades[i] > 0 && anchoBarra >= 18) {
            const textoUnidades = fmtNum(unidades[i]);
            let yUnidades = barraUnidades.y - 3;
            for (let intento = 0; intento < 3; intento++) {
              const tapados = ocupados.filter((o) => chocan(cajaDe(textoUnidades, barraUnidades.x, yUnidades), o));
              if (tapados.length === 0) break;
              yUnidades = Math.min(...tapados.map((o) => o.y1 - 2));
            }
            escribir(textoUnidades, barraUnidades.x, Math.max(yUnidades, altoTexto), '#172033', 'bottom');
          }
        });
        ctx.restore();
      },
    };

    chartInstances[canvasId] = new window.Chart(canvasEl, {
      type: 'bar',
      data: {
        labels: rows.map((r) => r.nombre),
        // Barras anchas (poco aire entre operadores) para que los números quepan.
        datasets: [
          { label: 'NV', data: nv, backgroundColor: '#2563EB', stack: 'nv-lineas', yAxisID: 'y', barPercentage: 0.95, categoryPercentage: 0.9 },
          { label: 'Líneas/Ítems', data: lineas.map((l, i) => Math.max(l - nv[i], 0)), backgroundColor: '#009E73', stack: 'nv-lineas', yAxisID: 'y', barPercentage: 0.95, categoryPercentage: 0.9 },
          { label: 'Unidades', data: unidades, backgroundColor: '#E69F00', stack: 'unidades', yAxisID: 'y1', barPercentage: 0.95, categoryPercentage: 0.9 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 20 } }, // lugar para el número de la columna más alta
        plugins: {
          // Sin ocultar series desde la leyenda: el verde depende del azul para quedar a la altura correcta.
          legend: { position: 'bottom', onClick: () => {} },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtNum([nv, lineas, unidades][ctx.datasetIndex][ctx.dataIndex])}` } },
        },
        scales: {
          x: { stacked: true },
          y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, position: 'left', title: { display: true, text: 'NV / Líneas' } },
          y1: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Unidades' } },
        },
      },
      plugins: [cantidadesSobreBarras],
    });
  }

  /** Contenido de una tarjeta: el gráfico a la vista y, debajo, el botón del
   * desplegable que abre el detalle (la tabla). */
  function contenidoZona(key, rows) {
    if (rows.length === 0) return '<p class="kpi-empty">Sin entregas hoy ni esta semana.</p>';
    const canvasId = `re-chart-${key}`;
    const esPicking = key === 'picking';
    const abierto = detalleAbierto[key];
    return `
      <p class="kpi-note">"Hoy" y "Semana" (últimos 5 días hábiles) son fijos.</p>
      ${
        esPicking
          ? `<div class="np-rendimiento-chart-switch">
               <button class="pill-btn${pickingPeriodo === 'dia' ? ' active' : ''}" id="re-picking-periodo-dia">Hoy</button>
               <button class="pill-btn${pickingPeriodo === 'semana' ? ' active' : ''}" id="re-picking-periodo-semana">Semana</button>
             </div>`
          : ''
      }
      <div class="np-rendimiento-chart-box"><canvas id="${canvasId}"></canvas></div>
      <button class="pill-btn" id="re-detalle-toggle-${key}">${abierto ? '▴ Ocultar' : '▾ Ver detalle'}</button>
      <div class="np-rendimiento-detalle${abierto ? '' : ' hidden'}" id="re-detalle-${key}">
        ${tableHtml(
          ['Nombre', 'Hoy · NV', 'Hoy · Monto', 'Semana · NV', 'Semana · Monto'],
          rows.map((r) => [r.nombre, r.cantHoy, fmtMoney(r.montoHoy), r.cantSemana, fmtMoney(r.montoSemana)])
        )}
      </div>
    `;
  }

  function render() {
    const { packing, conductores, auditores } = computeRendimientoEquipo();
    const datos = { picking: packing, conductores, auditores };
    const contenedores = {
      picking: document.getElementById('re-picking'),
      conductores: document.getElementById('re-conductores'),
      auditores: document.getElementById('re-auditores'),
    };

    // Redibuja la tarjeta de una zona y reengancha sus botones (son nodos
    // nuevos cada vez que se reconstruye el innerHTML, así que los listeners
    // anteriores quedan huérfanos y hay que reponerlos). El desplegable solo
    // muestra u oculta la tabla: no necesita redibujar el gráfico.
    function renderZona(key) {
      const cont = contenedores[key];
      if (!cont) return;
      cont.innerHTML = contenidoZona(key, datos[key]);
      document.getElementById(`re-detalle-toggle-${key}`)?.addEventListener('click', (e) => {
        detalleAbierto[key] = !detalleAbierto[key];
        e.currentTarget.textContent = detalleAbierto[key] ? '▴ Ocultar' : '▾ Ver detalle';
        document.getElementById(`re-detalle-${key}`)?.classList.toggle('hidden', !detalleAbierto[key]);
      });
      if (key === 'picking') {
        document.getElementById('re-picking-periodo-dia')?.addEventListener('click', () => {
          pickingPeriodo = 'dia';
          renderZona('picking');
        });
        document.getElementById('re-picking-periodo-semana')?.addEventListener('click', () => {
          pickingPeriodo = 'semana';
          renderZona('picking');
        });
      }
      // requestAnimationFrame: el gráfico recién se insertó en el DOM con el
      // innerHTML de arriba — si se crea el Chart en el mismo tick, mide el
      // contenedor ANTES de que el navegador termine el layout y el canvas
      // queda en 0x0. Un frame de margen alcanza.
      requestAnimationFrame(() => {
        if (key === 'picking') drawChartPicking(`re-chart-${key}`, datos[key], pickingPeriodo);
        else drawChart(`re-chart-${key}`, datos[key]);
      });
    }

    Object.keys(contenedores).forEach(renderZona);
  }

  render();
}

// ---------------------------------------------------------------------------
// 0d. Corte — guía para generar el picking: NV vigentes (estado A) con saldo
// por despachar, agrupadas en 3 columnas tipo kanban por tipo de canal
// (Despacho / Retail / Ecomm). No se excluyen los retiros en tienda (columna
// Entrega = "RETIRA"): si una NV quedó mal marcada como retiro siendo en
// realidad un despacho, igual debe aparecer acá para no perderla — por eso
// cada columna muestra, bajo su conteo, cuántas de esas NV son retiros, y el
// detalle trae una columna "Entrega" para poder revisarlas. El detalle va EN
// UNIDADES (no en pesos, a diferencia del resto del dashboard, salvo por el
// "Valor total NV" que se agrega como referencia), pensado para ir a bodega
// a preparar el picking: NV, cliente, entrega, valor total de la NV, fecha
// de ingreso, fecha compromiso, lo solicitado y el saldo por despachar, y
// vendedor. Filtros propios en la barra lateral: fecha de creación (misma
// estructura que las otras pestañas), cliente y tipo (qué columnas se
// muestran).
// ---------------------------------------------------------------------------

const TIPOS_CORTE = [
  { id: 'DESPACHO', label: 'Despacho', clase: 'corte-despacho' },
  { id: 'RETAIL', label: 'Retail', clase: 'corte-retail' },
  { id: 'ECOMM', label: 'Ecomm', clase: 'corte-ecomm' },
];

function renderCorte(el, nvRecords) {
  const pad = (n) => String(n).padStart(2, '0');
  const toInputDateValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

  let fechaModo = 'semana';
  let fechaRefDate = yesterday();
  let mesSeleccionado = { year: new Date().getFullYear(), month: new Date().getMonth() };
  let semanaSeleccionada = null;
  let rangoInicio = new Date(Date.now() - 30 * 86400000);
  let rangoFin = new Date();
  let clienteFiltro = '';
  let filtrosAbiertos = true;
  const tiposActivos = new Set(TIPOS_CORTE.map((t) => t.id));
  let detalleAbierto = null; // id de TIPOS_CORTE, o null
  let skuQuery = '';

  el.innerHTML = `
    <div class="np-header np-header-top">
      <div>
        <h2>Corte</h2>
        <p class="np-header-sub">Notas de venta aprobadas (vigentes), por tipo — guía para generar el picking.</p>
      </div>
      <div class="np-header-badge" id="corte-fecha-badge"></div>
    </div>
    <div class="np-corte-kanban" id="corte-kanban"></div>
    <div class="zone-box zone-box--detalle hidden" id="corte-detalle-box">
      <div id="corte-detalle"></div>
    </div>
    <div class="zone-box" id="corte-sku-box">
      <h3 class="np-canvas-title">Buscar por SKU</h3>
      <p class="np-header-sub">NV vigentes con esta línea sin despachar o con despacho parcial, en cualquier tipo — no depende de los filtros de arriba.</p>
      <div class="np-detalle-toolbar">
        <div class="sb-search-box np-detalle-cliente-filtro">
          <span class="sb-search-icon">🔍</span>
          <input type="text" id="corte-sku-input" placeholder="Código o nombre de producto...">
        </div>
      </div>
      <div id="corte-sku-resultado"><p class="kpi-empty">Escribe un código o nombre de producto para buscar.</p></div>
    </div>
  `;

  function mesOptionsHtml() {
    const maxMonth = mesSeleccionado.year === new Date().getFullYear() ? new Date().getMonth() : 11;
    let html = '';
    for (let m = 0; m <= maxMonth; m++) html += `<option value="${m}">${MESES[m]}</option>`;
    return html;
  }

  function computeRange() {
    if (fechaModo === 'dia') return getDateRange(fechaRefDate, 'dia');
    if (fechaModo === 'semana') return semanaSeleccionada ? rangoSemanaIso(semanaIsoDe(new Date()).anio, semanaSeleccionada) : getDateRange(fechaRefDate, 'semana');
    if (fechaModo === 'mes') {
      const base = new Date(mesSeleccionado.year, mesSeleccionado.month, 1);
      return { start: startOfMonth(base), end: endOfMonth(base) };
    }
    if (fechaModo === 'rango') return { start: startOfDay(rangoInicio), end: endOfDay(rangoFin) };
    return null; // 'todo' -> sin filtro de fecha
  }

  function formatFechaBadgeHeader(range) {
    if (!range) return '<span>Todas las fechas</span>';
    const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
    const semanas = weekNumbersInRange(range.start, range.end);
    const semanasTxt = semanas.length <= 1 ? `Semana ${semanas[0]}` : `Semanas ${semanas[0]}–${semanas[semanas.length - 1]}`;
    return `<span>${semanasTxt}</span><span>Del ${fmt(range.start)} al ${fmt(range.end)}</span>`;
  }

  function computeUniverso() {
    const range = computeRange();
    const headerBadge = document.getElementById('corte-fecha-badge');
    if (headerBadge) headerBadge.innerHTML = formatFechaBadgeHeader(range);
    const term = clienteFiltro.trim().toLowerCase();
    return nvRecords.filter((nv) => {
      if (nv.nvEstado !== 'A') return false;
      if (range && !inRange(nv.fecCreacion, range)) return false;
      if (term && !(nv.cliente || '').toLowerCase().includes(term)) return false;
      // Ya despachada al 100% (sin unidades por despachar): sigue en estado A
      // porque el sistema aún no la concluye, pero no aporta nada a una guía
      // de picking — se excluye del listado completo (conteos y detalle).
      if (totalesNV(nv).saldo <= 0) return false;
      return true;
    });
  }

  const tipoDe = (nv) => (nv.canal || '').trim().toUpperCase();

  // A diferencia del resto del dashboard (que suma pesos), acá se suman
  // UNIDADES: es lo que necesita bodega para preparar el picking.
  const totalesNV = (nv) => ({
    solicitado: nv.items.reduce((s, it) => s + (it.cant || 0), 0),
    saldo: nv.items.reduce((s, it) => s + (it.salXDes || 0), 0),
  });

  function renderSidebarFiltros() {
    const cont = document.getElementById('sidebar-filters');
    if (!cont) return;
    cont.innerHTML = `
      <div class="sb-box">
        <button class="sb-toggle${filtrosAbiertos ? '' : ' is-collapsed'}" id="sb-toggle-btn">
          <span>Contextuales a "Corte"</span>
          <span class="sb-toggle-arrow">▾</span>
        </button>
        <div class="sb-body${filtrosAbiertos ? '' : ' hidden'}" id="sb-body">
          <div>
            <div class="sb-group-label">Fecha de creación</div>
            <div class="sb-pills" id="sb-pills-fecha">
              <button class="sb-pill${fechaModo === 'dia' ? ' active' : ''}" data-value="dia">Día</button>
              <button class="sb-pill${fechaModo === 'semana' ? ' active' : ''}" data-value="semana">Semana</button>
              <button class="sb-pill${fechaModo === 'mes' ? ' active' : ''}" data-value="mes">Mes</button>
              <button class="sb-pill${fechaModo === 'rango' ? ' active' : ''}" data-value="rango">Rango 📅</button>
              <button class="sb-pill${fechaModo === 'todo' ? ' active' : ''}" data-value="todo">Todo</button>
            </div>
            <input type="date" id="sb-fecha-input" class="${fechaModo === 'dia' ? '' : 'hidden'}">
            <select id="sb-semana-select" class="${fechaModo === 'semana' ? '' : 'hidden'}">${semanaOptionsHtml()}</select>
            <select id="sb-mes-select" class="${fechaModo === 'mes' ? '' : 'hidden'}">${mesOptionsHtml()}</select>
            <div id="sb-rango-box" class="${fechaModo === 'rango' ? '' : 'hidden'}">
              <div class="sb-rango-row">
                <span class="sb-rango-dot sb-rango-dot--inicio"></span><label>Inicio</label>
                <input type="date" id="sb-rango-inicio">
              </div>
              <div class="sb-rango-row">
                <span class="sb-rango-dot sb-rango-dot--fin"></span><label>Fin</label>
                <input type="date" id="sb-rango-fin">
              </div>
            </div>
            <span class="sb-fecha-label" id="sb-fecha-label"></span>
          </div>
          <div>
            <div class="sb-group-label">Cliente</div>
            <div class="sb-search-box">
              <span class="sb-search-icon">🔍</span>
              <input type="text" id="sb-cliente-input" placeholder="Filtrar por cliente..." value="${clienteFiltro}">
            </div>
          </div>
          <div>
            <div class="sb-group-label">Tipo</div>
            <div class="sb-pills" id="sb-pills-tipo">
              ${TIPOS_CORTE.map((t) => `<button class="sb-pill${tiposActivos.has(t.id) ? ' active' : ''}" data-tipo="${t.id}">${t.label}</button>`).join('')}
            </div>
          </div>
          <button class="sb-limpiar" id="sb-limpiar-btn">✕ Limpiar filtros</button>
        </div>
      </div>
    `;

    const dateInput = document.getElementById('sb-fecha-input');
    if (dateInput) dateInput.value = toInputDateValue(fechaRefDate);
    const semanaSelect = document.getElementById('sb-semana-select');
    if (semanaSelect) semanaSelect.value = String(semanaSeleccionada ?? semanaIsoDe(new Date()).semana);
    const mesSelect = document.getElementById('sb-mes-select');
    if (mesSelect) mesSelect.value = String(mesSeleccionado.month);
    const inicioInput = document.getElementById('sb-rango-inicio');
    const finInput = document.getElementById('sb-rango-fin');
    if (inicioInput) inicioInput.value = toInputDateValue(rangoInicio);
    if (finInput) finInput.value = toInputDateValue(rangoFin);

    document.getElementById('sb-toggle-btn')?.addEventListener('click', () => {
      filtrosAbiertos = !filtrosAbiertos;
      renderSidebarFiltros();
    });
    document.querySelectorAll('#sb-pills-fecha .sb-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        fechaModo = btn.dataset.value;
        renderSidebarFiltros();
        renderAll();
      });
    });
    dateInput?.addEventListener('change', (e) => {
      fechaRefDate = e.target.value ? new Date(e.target.value + 'T00:00:00') : yesterday();
      renderAll();
    });
    semanaSelect?.addEventListener('change', (e) => {
      const n = Number(e.target.value);
      semanaSeleccionada = n === semanaIsoDe(new Date()).semana ? null : n; // la semana en curso sigue siendo la "vigente"
      renderAll();
    });
    mesSelect?.addEventListener('change', (e) => {
      mesSeleccionado = { ...mesSeleccionado, month: Number(e.target.value) };
      renderAll();
    });
    inicioInput?.addEventListener('change', (e) => {
      rangoInicio = e.target.value ? new Date(e.target.value + 'T00:00:00') : rangoInicio;
      if (rangoInicio > rangoFin) {
        rangoFin = rangoInicio;
        if (finInput) finInput.value = toInputDateValue(rangoFin);
      }
      renderAll();
    });
    finInput?.addEventListener('change', (e) => {
      rangoFin = e.target.value ? new Date(e.target.value + 'T00:00:00') : rangoFin;
      if (rangoFin < rangoInicio) {
        rangoInicio = rangoFin;
        if (inicioInput) inicioInput.value = toInputDateValue(rangoInicio);
      }
      renderAll();
    });
    document.getElementById('sb-cliente-input')?.addEventListener('input', (e) => {
      clienteFiltro = e.target.value;
      renderAll();
    });
    document.querySelectorAll('#sb-pills-tipo .sb-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.tipo;
        if (tiposActivos.has(id)) {
          // Al menos un tipo debe quedar activo, para no dejar el panel vacío sin salida.
          if (tiposActivos.size === 1) return;
          tiposActivos.delete(id);
          if (detalleAbierto === id) detalleAbierto = null;
        } else {
          tiposActivos.add(id);
        }
        renderSidebarFiltros();
        renderAll();
      });
    });
    document.getElementById('sb-limpiar-btn')?.addEventListener('click', () => {
      fechaModo = 'semana';
      fechaRefDate = yesterday();
      mesSeleccionado = { year: new Date().getFullYear(), month: new Date().getMonth() };
      semanaSeleccionada = null;
      rangoInicio = new Date(Date.now() - 30 * 86400000);
      rangoFin = new Date();
      clienteFiltro = '';
      TIPOS_CORTE.forEach((t) => tiposActivos.add(t.id));
      detalleAbierto = null;
      filtrosAbiertos = true;
      renderSidebarFiltros();
      renderAll();
    });
  }

  function renderKanban(universo) {
    const cont = document.getElementById('corte-kanban');
    if (!cont) return;
    const activos = TIPOS_CORTE.filter((t) => tiposActivos.has(t.id));
    cont.innerHTML = activos
      .map((t) => {
        const lista = universo.filter((nv) => tipoDe(nv) === t.id);
        const retiros = lista.filter((nv) => nv.entrega === 'RETIRA').length;
        const abierto = detalleAbierto === t.id;
        return `
          <div class="zone-box zone-box--${t.clase}">
            <h3 class="np-canvas-title">${t.label}</h3>
            <div class="np-corte-col-n">${lista.length}<span> NV</span></div>
            <div class="kpi-card-sub">${retiros} ingresadas como retira</div>
            <button class="pill-btn" id="corte-toggle-${t.id}"${lista.length === 0 ? ' disabled' : ''}>${
          lista.length === 0 ? 'Sin pendientes' : abierto ? '▴ Ocultar' : '▾ Ver detalle'
        }</button>
          </div>`;
      })
      .join('');
    activos.forEach((t) => {
      document.getElementById(`corte-toggle-${t.id}`)?.addEventListener('click', () => {
        detalleAbierto = detalleAbierto === t.id ? null : t.id;
        renderAll();
      });
    });
  }

  function renderDetalle(universo) {
    const box = document.getElementById('corte-detalle-box');
    if (!box) return;
    if (!detalleAbierto || !tiposActivos.has(detalleAbierto)) {
      box.classList.add('hidden');
      return;
    }
    const tipo = TIPOS_CORTE.find((t) => t.id === detalleAbierto);
    const lista = universo.filter((nv) => tipoDe(nv) === detalleAbierto);
    box.classList.remove('hidden');
    const filas = lista.map((nv) => {
      const { solicitado, saldo } = totalesNV(nv);
      return {
        nv: nv.nvNumero,
        cliente: nv.cliente,
        entrega: nv.entrega === 'RETIRA' ? 'Retira' : 'Despacho',
        valorNv: nv.montoTotal || 0,
        ingreso: nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : '',
        compromiso: nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : 'N/A',
        solicitado,
        saldo,
        vendedor: nv.vendedor || '',
      };
    });
    document.getElementById('corte-detalle').innerHTML = `
      <h4>Detalle — ${tipo.label} (${filas.length} NV)</h4>
      <p class="kpi-note">Incluye lo ingresado como "Retira" (columna Entrega): si está mal marcado y en realidad es un despacho, no debe perderse de este listado.</p>
      <div class="np-detalle-toolbar"><button class="pill-btn" id="corte-export">⬇ Exportar Excel</button></div>
      ${tableHtml(
        ['NV', 'Cliente', 'Entrega', 'Valor total NV', 'Fecha de ingreso', 'Fecha compromiso', 'Solicitado', 'Saldo por despachar', 'Vendedor'],
        filas.slice(0, 300).map((f) => [f.nv, f.cliente, f.entrega, fmtMoney(f.valorNv), f.ingreso, f.compromiso, f.solicitado.toLocaleString('es-CL'), f.saldo.toLocaleString('es-CL'), f.vendedor])
      )}
      ${filas.length > 300 ? `<p class="kpi-note">Mostrando las primeras 300 de ${filas.length}.</p>` : ''}
    `;
    document.getElementById('corte-export')?.addEventListener('click', (e) => {
      downloadXlsx(
        `corte_${tipo.id.toLowerCase()}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        ['NV', 'Cliente', 'Entrega', 'Valor total NV', 'Vendedor', 'Fecha de ingreso', 'Fecha compromiso', 'Solicitado', 'Saldo por despachar'],
        filas.map((f) => [f.nv, f.cliente, f.entrega, Math.round(f.valorNv), f.vendedor, f.ingreso, f.compromiso, f.solicitado, f.saldo])
      );
      flashExportFeedback(e.currentTarget);
    });
  }

  // Buscador por SKU: a propósito NO usa `computeUniverso()` — recorre TODAS
  // las NV vigentes de una vez, sin importar el filtro de fecha/cliente/tipo
  // de arriba, porque la pregunta es "¿dónde está pendiente este producto,
  // en cualquier parte?", no "dentro de lo que tenía filtrado". Busca por
  // línea (código o nombre de producto), no por NV completa: una NV puede
  // tener el producto buscado ya despachado y otra línea distinta pendiente,
  // y acá solo importa la línea de este producto.
  function renderBuscadorSku() {
    const cont = document.getElementById('corte-sku-resultado');
    if (!cont) return;
    const term = skuQuery.trim().toLowerCase();
    if (!term) {
      cont.innerHTML = '<p class="kpi-empty">Escribe un código o nombre de producto para buscar.</p>';
      return;
    }
    const filas = [];
    nvRecords.forEach((nv) => {
      if (nv.nvEstado !== 'A') return;
      nv.items.forEach((it) => {
        if ((it.salXDes || 0) <= 0) return;
        const codigo = (it.codProd || '').toString().trim();
        const nombre = (it.detProd || '').toString().trim();
        if (!codigo.toLowerCase().includes(term) && !nombre.toLowerCase().includes(term)) return;
        filas.push({
          codigo,
          nombre,
          stock: it.stockDisp || 0,
          nv: nv.nvNumero,
          cliente: nv.cliente,
          canal: nv.canal || '',
          entrega: nv.entrega === 'RETIRA' ? 'Retira' : 'Despacho',
          solicitado: it.cant || 0,
          despachado: (it.cant || 0) - (it.salXDes || 0),
          pendiente: it.salXDes || 0,
          ingreso: nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : '',
          compromiso: nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : 'N/A',
          vendedor: nv.vendedor || '',
        });
      });
    });

    if (filas.length === 0) {
      cont.innerHTML = `<p class="kpi-empty">Sin notas de venta pendientes para "${skuQuery}".</p>`;
      return;
    }
    const skusDistintos = new Set(filas.map((f) => f.codigo)).size;
    const nvDistintas = new Set(filas.map((f) => f.nv)).size;
    const pendienteTotal = filas.reduce((s, f) => s + f.pendiente, 0);
    cont.innerHTML = `
      <p class="kpi-note">${skusDistintos} producto${skusDistintos === 1 ? '' : 's'} · ${filas.length} línea${filas.length === 1 ? '' : 's'} en ${nvDistintas} NV · ${pendienteTotal.toLocaleString('es-CL')} unidades pendientes. El stock es una foto al corte, no del día del despacho.</p>
      <div class="np-detalle-toolbar"><button class="pill-btn" id="corte-sku-export">⬇ Exportar Excel</button></div>
      ${tableHtml(
        ['Código', 'Producto', 'Stock al corte', 'NV', 'Cliente', 'Canal', 'Entrega', 'Solicitado', 'Despachado', 'Pendiente', 'Fecha de ingreso', 'Fecha compromiso', 'Vendedor'],
        filas
          .slice(0, 300)
          .map((f) => [f.codigo, f.nombre, f.stock.toLocaleString('es-CL'), f.nv, f.cliente, f.canal, f.entrega, f.solicitado.toLocaleString('es-CL'), f.despachado.toLocaleString('es-CL'), f.pendiente.toLocaleString('es-CL'), f.ingreso, f.compromiso, f.vendedor])
      )}
      ${filas.length > 300 ? `<p class="kpi-note">Mostrando las primeras 300 de ${filas.length}.</p>` : ''}
    `;
    document.getElementById('corte-sku-export')?.addEventListener('click', (e) => {
      downloadXlsx(
        `corte_sku_${skuQuery.trim().replace(/[^a-z0-9]+/gi, '_')}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        ['Codigo', 'Producto', 'Stock al corte', 'NV', 'Cliente', 'Canal', 'Entrega', 'Solicitado', 'Despachado', 'Pendiente', 'Fecha de ingreso', 'Fecha compromiso', 'Vendedor'],
        filas.map((f) => [f.codigo, f.nombre, f.stock, f.nv, f.cliente, f.canal, f.entrega, f.solicitado, f.despachado, f.pendiente, f.ingreso, f.compromiso, f.vendedor])
      );
      flashExportFeedback(e.currentTarget);
    });
  }

  function renderAll() {
    const universo = computeUniverso();
    renderKanban(universo);
    renderDetalle(universo);
  }

  document.getElementById('corte-sku-input')?.addEventListener('input', (e) => {
    skuQuery = e.target.value;
    renderBuscadorSku();
  });

  renderSidebarFiltros();
  renderAll();
}

