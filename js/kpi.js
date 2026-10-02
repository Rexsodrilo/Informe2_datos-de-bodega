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
  businessHoursElapsed,
  lastBusinessDaysRange,
  previousMonthRange,
  yesterday,
  WORK_START,
  WORK_END,
} from './businessDates.js?v=15';
import { minutosToHora } from './dataLoader.js?v=15';

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

export function renderKpiSection(sectionId, nvRecords, contHodo, horarioCam) {
  const el = document.getElementById('kpi-panel');
  if (!el) return;

  switch (sectionId) {
    case 'notasPendientes':
      renderNotasPendientes(el, nvRecords);
      break;
    case 'notasConcluidas':
      renderNotasConcluidas(el, nvRecords, contHodo, horarioCam);
      break;
    case 'rendimientoEquipo':
      renderRendimientoEquipo(el, nvRecords);
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
    if (fechaModo === 'semana') return getDateRange(fechaRefDate, 'semana');
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
    if (fechaModo === 'semana') return `Semana vigente: ${fmt(range.start)} – ${fmt(range.end)} · ${semanasTxt}`;
    if (fechaModo === 'dia') return `${fmt(range.start)} · ${semanasTxt}`;
    if (fechaModo === 'mes') return `${range.start.toLocaleDateString('es-CL', { month: 'long', year: 'numeric' })} · ${semanasTxt}`;
    return `${fmt(range.start)} – ${fmt(range.end)} · ${semanasTxt}`; // 'rango'
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

    const term = searchTerm.trim().toLowerCase();
    return nvRecords.filter((nv) => {
      if (nv.nvEstado !== 'A') return false;
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

  function computePool(universo) {
    // --- Zona 1: Estados de notas de venta Aceptadas ---
    // "Notas en proceso de preparación": OP_Picking (Corte) ya asignado,
    // pero Status des y Trans (ambos de Corte) todavía vacíos — el picking
    // arrancó pero aún no se le asigna transporte.
    const enProcesoPreparacion = universo.filter((nv) => nv.opPickingCorte && !nv.statusDes && !nv.trans);
    // "Notas de venta en despacho": OP_Picking asignado, Status des vacío,
    // pero Trans y Auditor (ambos de Corte) ya asignados — listo para salir.
    const enDespacho = universo.filter((nv) => nv.opPickingCorte && !nv.statusDes && nv.trans && nv.auditorCorte);
    // "Notas de venta entregadas": tiene guía o factura asociada y Status
    // des marca "DESPACHADO" — ya salió de bodega, aunque el sistema
    // todavía no la haya pasado a estado C.
    const entregadas = universo.filter((nv) => (nv.guia || nv.factura) && nv.statusDes === 'DESPACHADO');

    // --- Zona 4: Quiebre Stock Notas de Venta — una NV "con quiebre" es la
    // que tiene al menos una línea con stock disponible menor a la cantidad
    // solicitada (mismo criterio que ya usa "Exportar productos con
    // quiebre").
    const tieneQuiebre = (nv) => nv.items.some((it) => it.quiebre);
    const conQuiebre = universo.filter(tieneQuiebre);
    const sinQuiebre = universo.filter((nv) => !tieneQuiebre(nv));

    return { enProcesoPreparacion, enDespacho, entregadas, sinQuiebre, conQuiebre };
  }

  function renderKpisPrincipales(universo, pool) {
    // "Por despachar" (total/preparación/despacho): monto REAL pendiente —
    // Σ montoPorDespachar (Sal_X_Des × nvPrecio de cada línea), no el valor
    // original completo de la NV. "Entregadas" sí muestra el valor completo
    // (lo pendiente ahí sería $0, no aporta nada) — se revisa aparte en el
    // futuro reporte de NV entregadas.
    const montoPorDespachar = (list) => list.reduce((s, nv) => s + (nv.montoPorDespachar || 0), 0);
    const montoCompleto = (list) => list.reduce((s, nv) => s + (nv.montoTotal || 0), 0);
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
        ${cardHtml('entregadas', 'Notas de venta entregadas', pool.entregadas, montoCompleto(pool.entregadas), 'kpi-card--nueva', '<span class="tag-nueva">NUEVA</span>')}
      </div>
    `;
    ['total', 'preparacion', 'despacho', 'entregadas'].forEach((id) => {
      document.getElementById(`np-kpi-${id}-toggle`)?.addEventListener('click', () => setDetalleActivo('zona1', id));
    });
  }

  // Umbrales de las alertas nuevas — pensados como punto de partida
  // razonable, no un dato de negocio ya validado; ajustables a pedido.
  const UMBRAL_HORAS_POR_VENCER = 24; // horas hábiles restantes hasta el compromiso
  const UMBRAL_HORAS_PREPARACION_ESTANCADA = 27; // ~3 días hábiles desde la creación

  function computeAlertas(universo) {
    const ahora = new Date();
    // "Atrasada" = ya pasó su fecha compromiso (que ya es fecha de creación
    // + 48h hábiles) — cualquier atraso, sin umbral adicional.
    const atrasadas = universo.filter((nv) => nv.fechaCompromiso && businessHoursElapsed(nv.fechaCompromiso, ahora) > 0);
    const bloqueadas = universo.filter((nv) => nv.bloqueado);
    return { bloqueadas, atrasadas };
  }

  /** Quiebre "real" por antigüedad (FIFO), para el indicador de Alertas —
   * distinto del flag `quiebre` de cada línea (que marca a TODAS las NV de
   * un SKU por igual si la demanda total supera el stock: ese es el
   * universo de "riesgo" que se muestra en la Zona 4, y se deja así a
   * propósito porque decidir cuál NV se atiende es del área comercial, no
   * del sistema). Acá se calcula, por SKU, cuáles NV específicas quedarían
   * sin stock si se atiende en orden de antigüedad: se ordenan de más
   * antigua a más nueva y se va restando el stock del sistema; la primera
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
        if (!porSku.has(key)) porSku.set(key, { stockSistema: item.stockSistema || 0, lineas: [] });
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
      let remanente = grupo.stockSistema;
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
      if (nv.esRetiro || nv.fCoordinacion || !nv.fechaCompromiso) return false;
      const horasRestantes = businessHoursElapsed(ahora, nv.fechaCompromiso);
      return horasRestantes > 0 && horasRestantes <= umbralHoras;
    });
  }

  // NV con OP_Picking asignado (arrancó picking) que llevan demasiado
  // tiempo sin pasar a "en despacho" — posible cuello de botella.
  function computePreparacionEstancada(enProcesoPreparacion, umbralHoras = UMBRAL_HORAS_PREPARACION_ESTANCADA) {
    const ahora = new Date();
    return enProcesoPreparacion.filter((nv) => businessHoursElapsed(nv.fecCreacion, ahora) > umbralHoras);
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
    const { bloqueadas, atrasadas } = computeAlertas(universo);
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
      ${filaHtml('atrasadas', 'status-badge--danger', 'Atrasadas (pasada la fecha de cumplimiento)', atrasadas)}
      ${filaHtml('quiebreFifo', 'status-badge--danger', 'Quiebre de stock (por antigüedad)', quiebreFifo)}
      ${filaHtml('porVencer', 'status-badge--warning', `Por vencer sin coordinar (< ${UMBRAL_HORAS_POR_VENCER}h hábiles)`, porVencer)}
      ${filaHtml('preparacionEstancada', 'status-badge--warning', `Preparación estancada (+${UMBRAL_HORAS_PREPARACION_ESTANCADA}h hábiles)`, preparacionEstancada)}
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
          porSku.set(key, { codProd: item.codProd, detProd: item.detProd, unidades: 0, stockVigente: item.stockSistema || 0, nvs: new Map(), fechaIngreso: null });
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
          <div class="kpi-card-label">Con quiebre de stock · NV</div>
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
      const listasPorId = { total: universo, preparacion: pool.enProcesoPreparacion, despacho: pool.enDespacho, entregadas: pool.entregadas };
      const titulosPorId = {
        total: 'Total por despachar',
        preparacion: 'Notas en proceso de preparación',
        despacho: 'Notas de venta en despacho',
        entregadas: 'Notas de venta entregadas',
      };
      const list = (listasPorId[detalleActivo.id] || []).filter((nv) => matchesCliente(nv.cliente));
      titulo = titulosPorId[detalleActivo.id];
      exportName = `nv_${detalleActivo.id}`;
      totalCount = list.length;
      // "Entregadas" muestra el valor completo (lo pendiente ahí es $0); las
      // otras 3 muestran lo REAL pendiente por despachar.
      const montoDe = (nv) => (detalleActivo.id === 'entregadas' ? nv.montoTotal : nv.montoPorDespachar);
      headers = ['NV', 'Cliente', 'Canal', 'Guía', 'Monto', 'Fecha compromiso'];
      rows = list.slice(0, 300).map((nv) => [nv.nvNumero, nv.cliente, nv.canal || '', nv.guia || '', fmtMoney(montoDe(nv)), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : 'N/A']);
      xlsxHeaders = ['NV', 'Cliente', 'Vendedor', 'Canal', 'Guia', 'Monto', 'Fecha compromiso'];
      xlsxRows = list.map((nv) => [nv.nvNumero, nv.cliente, nv.vendedor, nv.canal, nv.guia || '', Math.round(montoDe(nv)), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : '']);
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
      // por NV) — unidades pedidas, stock vigente del sistema, qué NV lo
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
      const { bloqueadas, atrasadas } = computeAlertas(universo);
      const quiebreFifoSet = computeQuiebreFifo();
      const listasPorTipo = {
        bloqueadas,
        atrasadas,
        quiebreFifo: universo.filter((nv) => quiebreFifoSet.has(nv)),
        porVencer: computePorVencerSinCoordinar(universo),
        preparacionEstancada: computePreparacionEstancada(pool.enProcesoPreparacion),
        retiroMalMarcado: universo.filter((nv) => nv.retiroMalMarcado),
        lineasDuplicadas: computeLineasDuplicadas(universo),
      };
      const titulosPorTipo = {
        bloqueadas: 'Bloqueadas',
        atrasadas: 'Atrasadas (pasada la fecha de cumplimiento)',
        quiebreFifo: 'Quiebre de stock (por antigüedad)',
        porVencer: 'Por vencer sin coordinar',
        preparacionEstancada: 'Preparación estancada',
        retiroMalMarcado: 'Retiros mal marcados',
        lineasDuplicadas: 'NV con líneas duplicadas',
      };
      const list = (listasPorTipo[detalleActivo.tipo] || []).filter((nv) => matchesCliente(nv.cliente));
      titulo = titulosPorTipo[detalleActivo.tipo] || detalleActivo.tipo;
      exportName = `nv_${detalleActivo.tipo}`;
      totalCount = list.length;
      // Todas estas alertas son sobre NV en estado A (sin entregar) — el
      // monto mostrado/exportado es lo real pendiente por despachar.
      headers = ['NV', 'Cliente', 'Canal', 'Guía', 'Monto', 'Fecha compromiso'];
      rows = list.slice(0, 300).map((nv) => [nv.nvNumero, nv.cliente, nv.canal || '', nv.guia || '', fmtMoney(nv.montoPorDespachar), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : 'N/A']);
      xlsxHeaders = ['NV', 'Cliente', 'Vendedor', 'Canal', 'Guia', 'Monto', 'Fecha compromiso'];
      xlsxRows = list.map((nv) => [nv.nvNumero, nv.cliente, nv.vendedor, nv.canal, nv.guia || '', Math.round(nv.montoPorDespachar), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : '']);
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
const normalizarPatente = (p) => {
  const s = (p || '').toString().trim().toUpperCase();
  return ALIAS_PATENTE[s] || s;
};

// Regla de negocio de "NV entregadas": se consideran solo las NV cuyo
// auditor sea DISTINTO de este nombre (comparado sin mayúsculas). Las NV sin
// auditor asignado sí entran (distinto de Yuvitsa incluye "vacío"). El
// auditor sale de la columna "Auditor" de Desp, o de Corte si Desp no la
// trae (en los datos reales ambas coinciden siempre).
const AUDITOR_EXCLUIDO_ENTREGADAS = 'yuvitsa';
const auditorDe = (nv) => (nv.auditor || nv.auditorCorte || '').toString().trim().toLowerCase();

function renderNotasConcluidas(el, nvRecords, contHodo, horarioCam) {
  const pad = (n) => String(n).padStart(2, '0');
  const toInputDateValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const hodoRecords = contHodo || [];
  const horarioCamRecords = horarioCam || [];

  let fechaModo = 'semana';
  let fechaRefDate = yesterday();
  let mesSeleccionado = { year: new Date().getFullYear(), month: new Date().getMonth() };
  let rangoInicio = new Date(Date.now() - 30 * 86400000);
  let rangoFin = new Date();
  let searchTerm = '';
  let filtrosAbiertos = true;
  let detalleActivo = null; // { tipo } | null
  let transporteDetalleAbierto = false; // tabla patente x día (Cont_Hodo)

  el.innerHTML = `
    <div class="np-header np-header-top">
      <div>
        <h2>NV entregadas</h2>
        <p class="np-header-sub">NV concluidas, más las vigentes que ya tienen guía o factura y al menos una línea despachada.</p>
      </div>
      <div class="np-header-badge" id="nc-fecha-badge"></div>
    </div>

    <div class="np-rendimiento-layout">
      <div class="zone-box zone-box--entregado">
        <h3 class="np-canvas-title">Entregado</h3>
        <div id="nc-entregado"></div>
      </div>
      <div class="np-rendimiento-row">
        <div class="zone-box zone-box--tiempo">
          <h3 class="np-canvas-title">On-Time Delivery</h3>
          <div id="nc-tiempo"></div>
        </div>
        <div class="zone-box zone-box--transporte">
          <h3 class="np-canvas-title">Transporte</h3>
          <div id="nc-transporte"></div>
        </div>
      </div>
    </div>

    <div class="zone-box zone-box--detalle hidden" id="nc-detalle-box">
      <div id="nc-detalle"></div>
    </div>
  `;

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
          <span>Contextuales a "NV entregadas"</span>
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
    if (fechaModo === 'semana') return getDateRange(fechaRefDate, 'semana');
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
      if (auditorDe(nv) === AUDITOR_EXCLUIDO_ENTREGADAS) return false;
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

  function computePool(universo) {
    // "NV Stock al 100%": todas las líneas sin saldo por despachar. Equivale a
    // Cum_INV (cumplimiento de inventario) = 100% en todas las líneas; en
    // toda la base solo difieren 2 NV (líneas con cantidad 0).
    const completa100 = universo.filter((nv) => nv.items.length > 0 && nv.items.every((it) => it.salXDes === 0));
    const completa100Set = new Set(completa100);
    const parcial = universo.filter((nv) => !completa100Set.has(nv));
    const aTiempo = universo.filter((nv) => nv.cumplimiento === 'A_TIEMPO');
    const atrasada = universo.filter((nv) => nv.cumplimiento === 'ATRASADO');
    // "Transporte externo" es SOLO lo marcado explícitamente como "EXTR" en
    // Trans (columna de Corte) — no "cualquier NV sin patente" (eso incluía
    // retiros y otros casos que no son realmente transporte externo).
    const externa = universo.filter((nv) => (nv.trans || '').toString().trim().toUpperCase() === 'EXTR');
    // "Flota propia": tiene patente asignada y NO es "EXTR". En Desp, los
    // despachos con transporte externo también traen "EXTR" en la columna
    // Patente, así que contar "cualquier patente" los sumaba también aquí
    // (doble conteo con "Transporte externo").
    const patenteDe = (nv) => (nv.patente || '').toString().trim().toUpperCase();
    const propia = universo.filter((nv) => patenteDe(nv) && patenteDe(nv) !== 'EXTR');
    return { completa100, parcial, aTiempo, atrasada, propia, externa };
  }

  /** Severidad del atraso: horas hábiles transcurridas entre la fecha
   * compromiso y la fecha en que realmente se coordinó — no desde la
   * creación de la NV. */
  function computeSeveridadAtraso(atrasada) {
    const b0_24 = [];
    const b24_48 = [];
    const b48mas = [];
    atrasada.forEach((nv) => {
      if (!nv.fechaCompromiso || !nv.fCoordinacion) return;
      const horas = businessHoursElapsed(nv.fechaCompromiso, nv.fCoordinacion);
      if (horas <= 24) b0_24.push(nv);
      else if (horas <= 48) b24_48.push(nv);
      else b48mas.push(nv);
    });
    return { b0_24, b24_48, b48mas };
  }

  /** Tiempo promedio de ciclo completo (creación -> coordinación), en horas
   * hábiles, entre las NV del universo que ya tienen fecha coordinada. */
  function computeTiempoPromedio(universo) {
    const conCoordinacion = universo.filter((nv) => nv.fCoordinacion);
    if (conCoordinacion.length === 0) return null;
    const totalHoras = conCoordinacion.reduce((s, nv) => s + businessHoursElapsed(nv.fecCreacion, nv.fCoordinacion), 0);
    return totalHoras / conCoordinacion.length;
  }

  function renderZonaEntregado(universo, pool) {
    const cont = document.getElementById('nc-entregado');
    if (!cont) return;
    const totalUnidades = universo.reduce((s, nv) => s + (nv.unidadesEntregadas || 0), 0);
    const totalMonto = universo.reduce((s, nv) => s + (nv.valorDespacho || 0), 0);
    const pctCumplimiento = universo.length > 0 ? (pool.completa100.length / universo.length) * 100 : 0;
    const monto100 = pool.completa100.reduce((s, nv) => s + (nv.valorDespacho || 0), 0);
    const montoParcial = pool.parcial.reduce((s, nv) => s + (nv.valorDespacho || 0), 0);

    cont.innerHTML = `
      <div class="np-zona4-total-row">
        <div class="np-zona4-total">
          <span class="np-zona4-total-label">Total NV despachadas</span>
          <span class="np-zona4-total-value">${universo.length}</span>
          <span class="np-zona4-total-label">${totalUnidades.toLocaleString('es-CL')} unidades · ${fmtMoney(totalMonto)}</span>
        </div>
        <div class="np-zona4-total">
          <span class="np-zona4-total-label">IN FULL</span>
          <span class="np-zona4-total-value">${fmtPct(pctCumplimiento)}</span>
          <span class="np-zona4-total-label">NV Stock al 100%</span>
        </div>
      </div>
      <div class="np-zona4-grid">
        <div class="kpi-card kpi-card--success">
          <div class="kpi-card-label">NV Stock al 100%</div>
          <div class="kpi-card-value">${pool.completa100.length}</div>
          <button class="pill-btn" id="nc-entregado100-toggle">${isDetalleActivo('entregado100') ? '▴ Ocultar' : '▾ Ver detalle'}</button>
        </div>
        <div class="kpi-card kpi-card--danger">
          <div class="kpi-card-label">NV Stock &lt;100%</div>
          <div class="kpi-card-value">${pool.parcial.length}</div>
          <button class="pill-btn" id="nc-entregadoParcial-toggle">${isDetalleActivo('entregadoParcial') ? '▴ Ocultar' : '▾ Ver detalle'}</button>
        </div>
        <div class="kpi-card kpi-card--success">
          <div class="kpi-card-label">NV Stock al 100% · Monto</div>
          <div class="kpi-card-value">${fmtMoney(monto100)}</div>
        </div>
        <div class="kpi-card kpi-card--danger">
          <div class="kpi-card-label">NV Stock &lt;100% · Monto</div>
          <div class="kpi-card-value">${fmtMoney(montoParcial)}</div>
        </div>
      </div>
    `;
    document.getElementById('nc-entregado100-toggle')?.addEventListener('click', () => setDetalleActivo('entregado100'));
    document.getElementById('nc-entregadoParcial-toggle')?.addEventListener('click', () => setDetalleActivo('entregadoParcial'));
  }

  function renderZonaTiempo(universo, pool) {
    const cont = document.getElementById('nc-tiempo');
    if (!cont) return;
    const pctATiempo = universo.length > 0 ? (pool.aTiempo.length / universo.length) * 100 : 0;
    const pctAtrasada = universo.length > 0 ? (pool.atrasada.length / universo.length) * 100 : 0;
    const severidad = computeSeveridadAtraso(pool.atrasada);
    const tiempoPromedio = computeTiempoPromedio(universo);

    cont.innerHTML = `
      <div class="np-otd-hero">
        <div class="np-otd-hero-cols">
          <div class="np-otd-hero-col">
            <div class="np-otd-hero-label">OTD — On-Time Delivery</div>
            <div class="np-otd-hero-value">${fmtPct(pctATiempo)}</div>
            <div class="np-otd-hero-formula">OTD (%) = (despachos a tiempo / total despachos) × 100</div>
            <div class="np-otd-hero-sub">${pool.aTiempo.length} a tiempo / ${universo.length} total</div>
          </div>
          <div class="np-otd-hero-col">
            <div class="np-otd-hero-label">Tiempo promedio de entrega</div>
            <div class="np-otd-hero-extra-value">${tiempoPromedio === null ? 'N/A' : `${(tiempoPromedio / (WORK_END - WORK_START)).toFixed(2)} días`}</div>
            <div class="np-otd-hero-formula">${tiempoPromedio === null ? '' : `${tiempoPromedio.toFixed(1)}h hábiles · `}creación → coordinación</div>
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
          <div class="kpi-card-label">Atrasada (+48h hábiles) · NV</div>
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
    `;
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

    // Horario_Cam: vueltas por día, velocidad real y horarios promedio —
    // misma flota propia y mismo rango de fecha que Cont_Hodo de arriba,
    // pero es otra fuente (por viaje, no por patente/día) así que se
    // combina con el km de Cont_Hodo solo para la velocidad real.
    const viajesEnRango = computeHorarioCamEnRango();
    const diasPatenteConViaje = new Set();
    let sumaSalidaMin = 0;
    let sumaIngresoMin = 0;
    let sumaDuracionMin = 0;
    viajesEnRango.forEach((v) => {
      if (v.fecha) diasPatenteConViaje.add(`${v.patente}|${startOfDay(v.fecha).getTime()}`);
      sumaSalidaMin += v.salidaMin || 0;
      sumaIngresoMin += v.ingresoMin || 0;
      sumaDuracionMin += v.duracionMin || 0;
    });
    const vueltasPorDia = viajesEnRango.length > 0 && diasPatenteConViaje.size > 0 ? viajesEnRango.length / diasPatenteConViaje.size : null;
    const horasEnRuta = sumaDuracionMin / 60;
    const velocidadReal = horasEnRuta > 0 ? totalKm / horasEnRuta : null;
    const salidaProm = viajesEnRango.length > 0 ? minutosToHora(sumaSalidaMin / viajesEnRango.length) : null;
    const llegadaProm = viajesEnRango.length > 0 ? minutosToHora(sumaIngresoMin / viajesEnRango.length) : null;

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
          <div class="kpi-card-label">Salida promedio</div>
          <div class="kpi-card-value">${salidaProm || 'N/A'}</div>
        </div>
        <div class="kpi-card kpi-card--propia kpi-card--icon">
          <i class="ti ti-login kpi-card-icon"></i>
          <div class="kpi-card-label">Llegada promedio</div>
          <div class="kpi-card-value">${llegadaProm || 'N/A'}</div>
        </div>
      </div>
      <p class="kpi-note">Km y "NV entregadas" vienen de Cont_Hodo; vueltas, velocidad y horarios vienen de Horario_Cam — ambas son bitácoras propias (registro por patente/día y por viaje), fuentes separadas de las NV de Corte, así que sus conteos no tienen por qué coincidir exactamente con los de arriba.</p>
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

    const severidad = computeSeveridadAtraso(pool.atrasada);
    const listasPorTipo = {
      entregado100: pool.completa100,
      entregadoParcial: pool.parcial,
      atrasada: pool.atrasada,
      atraso0_24: severidad.b0_24,
      atraso24_48: severidad.b24_48,
      atraso48mas: severidad.b48mas,
    };
    const titulosPorTipo = {
      entregado100: 'NV Stock al 100%',
      entregadoParcial: 'NV Stock &lt;100% (entregadas parcialmente)',
      atrasada: 'Atrasadas (+48h hábiles)',
      atraso0_24: 'Atrasadas 0–24h hábiles (desde fecha compromiso)',
      atraso24_48: 'Atrasadas 24–48h hábiles (desde fecha compromiso)',
      atraso48mas: 'Atrasadas +48h hábiles (desde fecha compromiso)',
    };
    const list = listasPorTipo[detalleActivo.tipo] || [];
    const titulo = titulosPorTipo[detalleActivo.tipo] || detalleActivo.tipo;
    const totalCount = list.length;
    const headers = ['NV', 'Cliente', 'Canal', 'Guía', 'Unidades', 'Monto', 'Fecha compromiso'];
    const rows = list
      .slice(0, 300)
      .map((nv) => [nv.nvNumero, nv.cliente, nv.canal || '', nv.guia || '', nv.unidadesEntregadas || 0, fmtMoney(nv.valorDespacho), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : 'N/A']);
    const xlsxHeaders = ['NV', 'Cliente', 'Vendedor', 'Canal', 'Guia', 'Unidades', 'Monto', 'Fecha compromiso'];
    const xlsxRows = list.map((nv) => [
      nv.nvNumero,
      nv.cliente,
      nv.vendedor,
      nv.canal,
      nv.guia || '',
      nv.unidadesEntregadas || 0,
      Math.round(nv.valorDespacho || 0),
      nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : '',
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
    renderZonaTiempo(universo, pool);
    renderZonaTransporte(universo, pool);
    renderDetalleCompartido(universo, pool);
  }

  function limpiarFiltros() {
    fechaModo = 'semana';
    fechaRefDate = yesterday();
    mesSeleccionado = { year: new Date().getFullYear(), month: new Date().getMonth() };
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
// "NV entregadas", ahora es su propia pestaña).
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

  const chartAbierto = { picking: false, conductores: false, auditores: false };
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
        plugins: { legend: { position: 'bottom' } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  /** Gráfico propio de Equipo de Picking: 3 métricas agrupadas (NV, líneas,
   * unidades) de UN solo período a la vez (Hoy o Semana, según el switch) —
   * no Hoy vs Semana como en el gráfico genérico de arriba. NV y Líneas
   * comparten el eje izquierdo (órdenes de magnitud parecidos); Unidades va
   * en un eje derecho aparte porque normalmente es un número bastante más
   * grande y aplastaría a los otros dos en un solo eje. */
  function drawChartPicking(canvasId, rows, periodo) {
    destroyChart(canvasId);
    const canvasEl = document.getElementById(canvasId);
    if (!canvasEl || !window.Chart) return;
    const sufijo = periodo === 'dia' ? 'Hoy' : 'Semana';
    chartInstances[canvasId] = new window.Chart(canvasEl, {
      type: 'bar',
      data: {
        labels: rows.map((r) => r.nombre),
        datasets: [
          { label: 'NV', data: rows.map((r) => r[`cant${sufijo}`]), backgroundColor: '#2563EB', yAxisID: 'y' },
          { label: 'Líneas/Ítems', data: rows.map((r) => r[`lineas${sufijo}`]), backgroundColor: '#009E73', yAxisID: 'y' },
          { label: 'Unidades', data: rows.map((r) => r[`unidades${sufijo}`]), backgroundColor: '#E69F00', yAxisID: 'y1' },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom' } },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 }, position: 'left', title: { display: true, text: 'NV / Líneas' } },
          y1: { beginAtZero: true, ticks: { precision: 0 }, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Unidades' } },
        },
      },
    });
  }

  function tabla(key, rows) {
    if (rows.length === 0) return '<p class="kpi-empty">Sin entregas hoy ni esta semana.</p>';
    const canvasId = `re-chart-${key}`;
    const esPicking = key === 'picking';
    return `
      <p class="kpi-note">"Hoy" y "Semana" (últimos 5 días hábiles) son fijos.</p>
      ${tableHtml(
        ['Nombre', 'Hoy · NV', 'Hoy · Monto', 'Semana · NV', 'Semana · Monto'],
        rows.map((r) => [r.nombre, r.cantHoy, fmtMoney(r.montoHoy), r.cantSemana, fmtMoney(r.montoSemana)])
      )}
      <button class="pill-btn" id="re-chart-toggle-${key}">${chartAbierto[key] ? '▴ Ocultar gráfico' : '▾ Gráfico'}</button>
      <div class="np-rendimiento-chart-box${chartAbierto[key] ? '' : ' hidden'}" id="re-chart-box-${key}">
        ${
          esPicking
            ? `<div class="np-rendimiento-chart-switch">
                 <button class="pill-btn${pickingPeriodo === 'dia' ? ' active' : ''}" id="re-picking-periodo-dia">Hoy</button>
                 <button class="pill-btn${pickingPeriodo === 'semana' ? ' active' : ''}" id="re-picking-periodo-semana">Semana</button>
               </div>`
            : ''
        }
        <canvas id="${canvasId}"></canvas>
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

    // Redibuja la tarjeta de una zona y reengancha su propio botón "Gráfico"
    // (el botón es un nodo nuevo cada vez que se reconstruye el innerHTML,
    // así que el listener anterior queda huérfano y hay que reponerlo).
    function renderZona(key) {
      const cont = contenedores[key];
      if (!cont) return;
      cont.innerHTML = tabla(key, datos[key]);
      document.getElementById(`re-chart-toggle-${key}`)?.addEventListener('click', () => {
        chartAbierto[key] = !chartAbierto[key];
        if (!chartAbierto[key]) destroyChart(`re-chart-${key}`);
        renderZona(key);
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
      // requestAnimationFrame: el box del gráfico recién se hizo visible (se
      // le sacó "hidden" en el innerHTML de arriba) — si se crea el Chart en
      // el mismo tick, mide el contenedor ANTES de que el navegador termine
      // el layout y el canvas queda en 0x0. Un frame de margen alcanza.
      if (chartAbierto[key]) {
        requestAnimationFrame(() => {
          if (key === 'picking') drawChartPicking(`re-chart-${key}`, datos[key], pickingPeriodo);
          else drawChart(`re-chart-${key}`, datos[key]);
        });
      }
    }

    Object.keys(contenedores).forEach(renderZona);
  }

  render();
}

