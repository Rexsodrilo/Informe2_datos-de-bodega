// kpi.js
// Cálculo de los indicadores de gerencia y render de cada sección
// (tarjetas + tablas + gráficos) en el panel principal del módulo KPI.

import {
  startOfDay,
  endOfDay,
  startOfMonth,
  endOfMonth,
  businessHoursElapsed,
  lastBusinessDaysRange,
  previousMonthRange,
  yesterday,
  WORK_START,
  WORK_END,
} from './businessDates.js';

const fmtMoney = (v) => '$' + Math.round(v || 0).toLocaleString('es-CL');
const fmtPct = (v) => (v === null || isNaN(v) ? 'N/A' : Math.round(v * 10) / 10 + '%');

// ---------------------------------------------------------------------------
// Paleta apta para daltonismo (Okabe-Ito), azul príncipe como color primario
// (pedido explícito: evitar combinaciones rojo/verde, que son las más
// problemáticas para las formas más comunes de daltonismo).
// ---------------------------------------------------------------------------
const PALETTE = {
  primary: '#2563EB',   // azul primario del sistema de diseño (mismo que botones/badges)
  primaryLight: '#93C5FD', // celeste
  accentWarn: '#E69F00', // naranja (dato secundario neutro, ej. líneas atendidas)
  accentAlt: '#009E73',  // verde azulado (distinguible del naranja/azul)
  accentPurple: '#CC79A7',
  accentDark: '#333333',
  // Vermellón (familia Okabe-Ito, igual que el resto de la paleta): se usa
  // exclusivamente para señalar riesgo/incumplimiento (ej. peor cumplimiento
  // In Full). No es rojo puro y no se combina con verde en ningún gráfico,
  // así se evita el problema clásico rojo/verde de daltonismo.
  accentDanger: '#D55E00',
  series: ['#0B4F9C', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#333333'],
};

let chartInstances = {};
let currentNvRecords = []; // referencia para el buscador de NV en "Cumplimiento"

// Etiquetas de datos visibles sobre los gráficos (chartjs-plugin-datalabels).
// Apagadas por defecto para no llenar de números todos los gráficos del
// sitio — cada gráfico que las quiera las prende explícitamente en su config
// (hoy, solo las 3 tortas de "Notas de ventas aceptadas").
if (window.Chart && window.ChartDataLabels && !window.Chart.registry.plugins.get('datalabels')) {
  window.Chart.register(window.ChartDataLabels);
  window.Chart.defaults.set('plugins.datalabels', { display: false });
}

function destroyChart(id) {
  if (chartInstances[id]) {
    chartInstances[id].destroy();
    delete chartInstances[id];
  }
}

function drawChart(canvasId, config) {
  destroyChart(canvasId);
  const el = document.getElementById(canvasId);
  if (!el) return;
  chartInstances[canvasId] = new window.Chart(el, config);
}

// ---------------------------------------------------------------------------
// Filtro de fecha (día / semana / mes) sobre F_coordinacion
// ---------------------------------------------------------------------------

export function getDateRange(refDate, mode) {
  // "Semana" y "Mes" son ventanas fijas relativas a hoy (no navegables con el
  // selector de fecha): últimos 5 días hábiles contando HOY como el más
  // reciente (si hoy es hábil), y el mes calendario anterior. Solo "Día"
  // usa la fecha elegida (refDate). El modo "rango" se resuelve aparte, en
  // main.js, con el control de barra arrastrable.
  if (mode === 'semana') return lastBusinessDaysRange(5, new Date());
  if (mode === 'mes') return previousMonthRange();
  return { start: startOfDay(refDate), end: endOfDay(refDate) };
}

function inRange(date, range) {
  if (!date) return false;
  return date >= range.start && date <= range.end;
}

// ---------------------------------------------------------------------------
// Cálculo de los indicadores
// ---------------------------------------------------------------------------

export function computeKpis(nvRecords, contHodo, range) {
  currentNvRecords = nvRecords;

  const nvEnRango = nvRecords.filter((nv) => inRange(nv.fCoordinacion, range));
  const nvAtrasadasSinCoordinar = nvRecords.filter(
    (nv) => !nv.esRetiro && nv.cumplimiento === 'SIN_COORDINAR' && inRange(nv.fechaCompromiso, range)
  );

  // ---- 1. Cumplimiento de compromiso ----
  const evaluables = nvEnRango.filter((nv) => !nv.esRetiro && nv.cumplimiento);
  const aTiempo = evaluables.filter((nv) => nv.cumplimiento === 'A_TIEMPO').length;
  const atrasado = evaluables.filter((nv) => nv.cumplimiento === 'ATRASADO').length;
  const pctCumplimiento = aTiempo + atrasado > 0 ? (aTiempo / (aTiempo + atrasado)) * 100 : null;

  // ---- 2. Fill rate ponderado por monto ----
  const sumaMonto = nvEnRango.reduce((s, nv) => s + nv.montoTotal, 0);
  const sumaInFullPonderado = nvEnRango.reduce((s, nv) => s + (nv.inFullPonderadoAcum || 0), 0);
  const fillRatePonderado = sumaMonto > 0 ? (sumaInFullPonderado / sumaMonto) * 100 : null;

  // ---- 3. Quiebre de stock por producto ----
  const quiebrePorProducto = new Map();
  nvEnRango.forEach((nv) => {
    nv.items.forEach((item) => {
      if (!item.quiebre) return;
      const key = item.codProd || item.detProd || '(sin código)';
      if (!quiebrePorProducto.has(key)) {
        quiebrePorProducto.set(key, { codProd: item.codProd, detProd: item.detProd, ocurrencias: 0 });
      }
      quiebrePorProducto.get(key).ocurrencias += 1;
    });
  });
  const topQuiebres = [...quiebrePorProducto.values()].sort((a, b) => b.ocurrencias - a.ocurrencias).slice(0, 10);

  // ---- 4. Valor MIN despacho ($300.000) ----
  // Solo NV cuyo tipo de entrega es despacho (incluye retiros que en
  // realidad se despacharon, ver dataLoader) y cuyo Canal_EN también es
  // Despacho.
  const nvBajoMonto = nvEnRango.filter((nv) => nv.esBajoMonto);
  const universoDespacho = nvEnRango.filter(
    (nv) => nv.nvEstado === 'C' && (nv.entrega === 'DESPACHO' || nv.retiroDebeDespacharse) && (nv.canal || '').toUpperCase().includes('DESPACHO')
  );
  const montoTotalDespachado = universoDespacho.reduce((s, nv) => s + nv.montoTotal, 0);
  const pctBajoMonto = universoDespacho.length > 0 ? (nvBajoMonto.length / universoDespacho.length) * 100 : null;
  const bajoMontoPorVendedor = groupSumCount(nvBajoMonto, (nv) => nv.vendedor, (nv) => nv.montoTotal);

  // ---- 5. Ranking de clientes ----
  // Se incluye una NV si está Concluida, o si ya tiene guía o factura
  // emitida (aunque el estado formal no haya llegado a "C" todavía) — así
  // no se pierden despachos ya salidos/facturados que aún no cambian de
  // estado en el sistema. Como no hay un monto separado por guía vs.
  // factura, se usa el monto de la NV una sola vez (ver nota en el chat).
  const nvParaRanking = nvEnRango.filter((nv) => nv.nvEstado === 'C' || nv.guia || nv.factura);
  const clientesMap = new Map();
  nvParaRanking.forEach((nv) => {
    if (!clientesMap.has(nv.cliente)) {
      clientesMap.set(nv.cliente, { cliente: nv.cliente, monto: 0, vendedores: new Set(), movimientos: new Set() });
    }
    const c = clientesMap.get(nv.cliente);
    c.monto += nv.montoDespachado;
    c.vendedores.add(nv.vendedor);
    c.movimientos.add(nv.tipoMovimiento || 'Despacho');
  });
  const rankingClientes = [...clientesMap.values()]
    .map((c) => ({
      ...c,
      vendedores: [...c.vendedores].join(', '),
      movimientos: [...c.movimientos].join(', '),
      bajoUmbral: c.monto < 300000,
    }))
    .sort((a, b) => b.monto - a.monto);

  // Desglose del mismo universo de NV, pero por tipo de movimiento
  // (Ecommerce, Retail, Retiro, Despacho...) en vez de por cliente.
  const rankingClientesPorTipo = groupSumCount(
    nvParaRanking,
    (nv) => nv.tipoMovimiento || 'Sin canal',
    (nv) => nv.montoDespachado
  );

  // ---- 6. Ranking de operación ----
  const rankingPicking = groupSumCount(nvEnRango, (nv) => nv.opPicking || 'Sin asignar', (nv) => nv.montoTotal);
  const rankingTransportista = groupSumCount(nvEnRango, (nv) => nv.trans || nv.chofer || 'Sin asignar', (nv) => nv.montoTotal);
  const rankingAuditor = groupSumCount(nvEnRango, (nv) => nv.auditor || 'Sin asignar', (nv) => nv.montoTotal);
  // Líneas atendidas (it_at, desde Desp) por operador de picking.
  const lineasPorOperador = groupSumField(nvEnRango, (nv) => nv.opPicking || 'Sin asignar', (nv) => nv.itAt || 0);

  // ---- 7. Retiro mal marcado como despacho ----
  const retirosMalMarcados = nvEnRango.filter((nv) => nv.retiroMalMarcado);
  const retiroPorVendedor = groupSumCount(retirosMalMarcados, (nv) => nv.vendedor, (nv) => nv.montoTotal);

  // ---- 8. Transporte diario ----
  const hodoEnRango = contHodo.filter((r) => inRange(r.fecha, range));
  const transporte = hodoEnRango.map((r) => {
    const nvCount = nvRecords.filter(
      (nv) =>
        nv.fCoordinacion &&
        sameDay(nv.fCoordinacion, r.fecha) &&
        (nv.patente === r.patente || nv.chofer === r.operador)
    ).length;
    return { ...r, nvCount, valorKm: r.kmUso > 0 ? r.montoEntregado / r.kmUso : 0 };
  });

  // ---- 9. Consolidado para Comex (SKU pendientes de despacho) ----
  const pendientes = nvRecords.filter((nv) => nv.nvEstado !== 'C'); // no filtra por rango: es "lo que falta", no "lo del período"
  const skuMap = new Map();
  pendientes.forEach((nv) => {
    nv.items.forEach((item) => {
      const key = item.codProd || item.detProd || '(sin código)';
      if (!skuMap.has(key)) {
        skuMap.set(key, { codProd: item.codProd, detProd: item.detProd, nvSet: new Set(), monto: 0, cant: 0 });
      }
      const s = skuMap.get(key);
      s.nvSet.add(nv.nvNumero);
      s.monto += item.montoLinea || 0;
      s.cant += item.cant || 0;
    });
  });
  const comexConsolidado = [...skuMap.values()]
    .map((s) => ({ ...s, nvCount: s.nvSet.size, nvNumeros: [...s.nvSet].join(' | ') }))
    .sort((a, b) => b.monto - a.monto);

  // ---- 10. Cumplimiento de entregas (In Full) ----
  // Solo NV concluidas (estado C), coordinadas dentro del período
  // seleccionado (mismo criterio de rango que el resto de las secciones de
  // período). El In Full de cada NV es el promedio SIMPLE (no ponderado por
  // monto, a diferencia del fill rate de "Calidad") de sus líneas.
  const nvInFull = nvEnRango
    .filter((nv) => nv.nvEstado === 'C')
    .map((nv) => ({
      ...nv,
      inFullPromedio: nv.items.length
        ? nv.items.reduce((s, it) => s + (it.inFull || 0), 0) / nv.items.length
        : null,
    }));

  const clientesInFullMap = new Map();
  nvInFull.forEach((nv) => {
    if (nv.inFullPromedio === null) return;
    if (!clientesInFullMap.has(nv.cliente)) {
      clientesInFullMap.set(nv.cliente, { cliente: nv.cliente, sum: 0, count: 0 });
    }
    const c = clientesInFullMap.get(nv.cliente);
    c.sum += nv.inFullPromedio;
    c.count += 1;
  });
  const clientesInFull = [...clientesInFullMap.values()].map((c) => ({
    cliente: c.cliente,
    promedio: c.sum / c.count,
  }));
  const top10MejorInFull = [...clientesInFull].sort((a, b) => b.promedio - a.promedio).slice(0, 10);
  const top10PeorInFull = [...clientesInFull].sort((a, b) => a.promedio - b.promedio).slice(0, 10);

  return {
    cumplimiento: { aTiempo, atrasado, pctCumplimiento, sinCoordinar: nvAtrasadasSinCoordinar },
    inFull: { nvInFull, top10MejorInFull, top10PeorInFull },
    fillRate: { fillRatePonderado, sumaMonto },
    quiebreStock: topQuiebres,
    bajoMonto: { nvBajoMonto, pctBajoMonto, montoTotalDespachado, bajoMontoPorVendedor },
    rankingClientes,
    rankingClientesPorTipo,
    rankingOperacion: { rankingPicking, rankingTransportista, rankingAuditor, lineasPorOperador },
    retiro: { retirosMalMarcados, retiroPorVendedor },
    transporte,
    comex: comexConsolidado,
  };
}

function groupSumCount(list, keyFn, montoFn) {
  const map = new Map();
  list.forEach((item) => {
    const key = keyFn(item) || 'Sin dato';
    if (!map.has(key)) map.set(key, { nombre: key, count: 0, monto: 0 });
    const g = map.get(key);
    g.count += 1;
    g.monto += montoFn(item) || 0;
  });
  return [...map.values()].sort((a, b) => b.monto - a.monto);
}

function groupSumField(list, keyFn, valFn) {
  const map = new Map();
  list.forEach((item) => {
    const key = keyFn(item) || 'Sin dato';
    map.set(key, (map.get(key) || 0) + (valFn(item) || 0));
  });
  return [...map.entries()].map(([nombre, valor]) => ({ nombre, valor })).sort((a, b) => b.valor - a.valor);
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// ---------------------------------------------------------------------------
// Exportación CSV genérica
// ---------------------------------------------------------------------------

function csvEscape(val) {
  const s = (val ?? '').toString();
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function downloadCsv(filename, headers, rows) {
  const lines = [headers.join(',')];
  rows.forEach((r) => lines.push(r.map(csvEscape).join(',')));
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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

const SECTIONS = [
  { id: 'notasPendientes', label: 'Notas de ventas aceptadas' },
  { id: 'cumplimiento', label: 'Cumplimiento de compromiso de despacho' },
  { id: 'inFull', label: 'Cumplimiento de entregas (In Full)' },
  { id: 'calidad', label: 'Calidad de despacho (fill rate, quiebres y Comex)' },
  { id: 'norma300', label: 'Valor MIN despacho' },
  { id: 'clientes', label: 'Ranking de clientes' },
  { id: 'operacion', label: 'Ranking de operación' },
  { id: 'retiros', label: 'Retiros mal marcados' },
  { id: 'transporte', label: 'Transporte diario' },
];

export function getSections() {
  return SECTIONS;
}

export function renderKpiSection(sectionId, kpis, nvRecords) {
  const el = document.getElementById('kpi-panel');
  if (!el) return;

  switch (sectionId) {
    case 'notasPendientes':
      renderNotasPendientes(el, nvRecords);
      break;
    case 'cumplimiento':
      renderCumplimiento(el, kpis.cumplimiento);
      break;
    case 'inFull':
      renderInFull(el, kpis.inFull);
      break;
    case 'calidad':
      renderCalidad(el, kpis.fillRate, kpis.quiebreStock, kpis.comex);
      break;
    case 'norma300':
      renderNorma300(el, kpis.bajoMonto);
      break;
    case 'clientes':
      renderClientes(el, kpis.rankingClientes, kpis.rankingClientesPorTipo);
      break;
    case 'operacion':
      renderOperacion(el, kpis.rankingOperacion);
      break;
    case 'retiros':
      renderRetiros(el, kpis.retiro);
      break;
    case 'transporte':
      renderTransporte(el, kpis.transporte);
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

  el.innerHTML = `
    <div class="np-header">
      <h2>Notas de ventas vigentes</h2>
      <p class="np-header-sub">Todas las NV en estado A: aprobadas por el área comercial, pendientes de que logística las procese.</p>
    </div>

    <div class="np-grid-2x2">
      <div class="zone-box zone-box--zona1">
        <h3 class="np-canvas-title">Estados de notas de venta Aceptadas</h3>
        <div id="np-kpis"></div>
      </div>

      <div class="zone-box zone-box--semana">
        <span class="zone-label zone-label--slate">Réplica informe semanal</span>
        <div class="np-semana-panel" id="np-semana"></div>
      </div>

      <div class="zone-box zone-box--zona4">
        <h3 class="np-canvas-title">Quiebre Stock Notas de Venta</h3>
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

  function computeUniverso() {
    let range = null;
    if (fechaModo === 'dia') range = getDateRange(fechaRefDate, 'dia');
    else if (fechaModo === 'semana') range = getDateRange(fechaRefDate, 'semana');
    else if (fechaModo === 'mes') {
      const base = new Date(mesSeleccionado.year, mesSeleccionado.month, 1);
      range = { start: startOfMonth(base), end: endOfMonth(base) };
    } else if (fechaModo === 'rango') {
      range = { start: startOfDay(rangoInicio), end: endOfDay(rangoFin) };
    } // 'todo' -> range queda null (sin filtro de fecha)

    const label = document.getElementById('sb-fecha-label');
    if (label) {
      label.textContent = !range
        ? 'Todas las fechas'
        : range.start.toLocaleDateString('es-CL') === range.end.toLocaleDateString('es-CL')
        ? range.start.toLocaleDateString('es-CL')
        : `${range.start.toLocaleDateString('es-CL')} – ${range.end.toLocaleDateString('es-CL')}`;
    }

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
    const montoDe = (list) => list.reduce((s, nv) => s + (nv.montoTotal || 0), 0);
    const cardHtml = (id, label, list, extraClass, tagHtml) => `
      <div class="kpi-card${extraClass ? ' ' + extraClass : ''}">
        <div class="kpi-card-label">${label}${tagHtml || ''}</div>
        <div class="kpi-card-value">${list.length}</div>
        <div class="kpi-card-sub">${fmtMoney(montoDe(list))}</div>
        <button class="pill-btn" id="np-kpi-${id}-toggle">${isDetalleActivo('zona1', id) ? '▴ Ocultar' : '▾ Ver detalle'}</button>
      </div>`;
    document.getElementById('np-kpis').innerHTML = `
      <div class="np-zona1-grid">
        ${cardHtml('total', 'Total por despachar', universo)}
        ${cardHtml('preparacion', 'Notas en proceso de preparación', pool.enProcesoPreparacion)}
        ${cardHtml('despacho', 'Notas de venta en despacho', pool.enDespacho)}
        ${cardHtml('entregadas', 'Notas de venta entregadas', pool.entregadas, 'kpi-card--nueva', '<span class="tag-nueva">NUEVA</span>')}
      </div>
    `;
    ['total', 'preparacion', 'despacho', 'entregadas'].forEach((id) => {
      document.getElementById(`np-kpi-${id}-toggle`)?.addEventListener('click', () => setDetalleActivo('zona1', id));
    });
  }

  function computeAlertas(universo) {
    const ahora = new Date();
    const horasHabilesPorDia = WORK_END - WORK_START;
    const conAtraso = universo
      .map((nv) => ({ nv, dias: businessHoursElapsed(nv.fechaCompromiso, ahora) / horasHabilesPorDia }))
      .filter((x) => x.dias > 0);
    const buckets = [5, 15, 30, 50].map((umbral) => ({
      umbral,
      items: conAtraso.filter((x) => x.dias > umbral).map((x) => x.nv),
    }));
    const bloqueadas = universo.filter((nv) => nv.bloqueado);
    return { buckets, bloqueadas };
  }

  function renderAlertasPanel(universo) {
    const cont = document.getElementById('np-alertas');
    if (!cont) return;
    const { buckets, bloqueadas } = computeAlertas(universo);
    cont.innerHTML = `
      <div class="np-alerta-list">
        ${buckets
          .map(
            (b, i) => `
          <div class="np-alerta-item np-alerta-item--lvl${i + 1}">
            <span class="np-alerta-item-label">Más de ${b.umbral} días</span>
            <span class="np-alerta-item-value">${b.items.length}</span>
            <button class="btn-export np-alerta-item-export" data-umbral="${b.umbral}"${b.items.length === 0 ? ' disabled' : ''}>⬇</button>
          </div>`
          )
          .join('')}
      </div>
      <div class="np-alerta-bloqueadas">
        <span class="status-badge status-badge--danger">Bloqueadas</span>
        <span><strong>${bloqueadas.length}</strong> NV con bloqueo de Finanzas</span>
        <button class="pill-btn" id="np-alerta-bloqueadas-toggle">${isDetalleActivo('bloqueadas') ? '▴ Ocultar' : '▾ Ver detalle'}</button>
        <button class="pill-btn" id="np-alerta-bloqueadas-export">⬇ Exportar Excel</button>
      </div>
    `;
    buckets.forEach((b) => {
      cont.querySelector(`.np-alerta-item-export[data-umbral="${b.umbral}"]`)?.addEventListener('click', (e) => {
        downloadXlsx(
          `nv_atraso_mas_${b.umbral}dias_${new Date().toISOString().slice(0, 10)}.xlsx`,
          ['NV', 'Cliente', 'Vendedor', 'Canal', 'Fecha compromiso', 'Monto'],
          b.items.map((nv) => [
            nv.nvNumero,
            nv.cliente,
            nv.vendedor,
            nv.canal,
            nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : '',
            Math.round(nv.montoTotal),
          ])
        );
        flashExportFeedback(e.currentTarget);
      });
    });
    document.getElementById('np-alerta-bloqueadas-toggle')?.addEventListener('click', () => setDetalleActivo('bloqueadas'));
    document.getElementById('np-alerta-bloqueadas-export')?.addEventListener('click', (e) => {
      downloadXlsx(
        `nv_bloqueadas_${new Date().toISOString().slice(0, 10)}.xlsx`,
        ['NV', 'Cliente', 'Vendedor', 'Canal', 'Monto', 'Fecha creacion', 'Fecha compromiso'],
        bloqueadas.map((nv) => [
          nv.nvNumero,
          nv.cliente,
          nv.vendedor,
          nv.canal,
          Math.round(nv.montoTotal),
          nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : '',
          nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : '',
        ])
      );
      flashExportFeedback(e.currentTarget);
    });
  }

  function computeQuiebreExport(universo) {
    const map = new Map();
    universo.forEach((nv) => {
      nv.items.forEach((item) => {
        if (!item.quiebre) return;
        const key = item.codProd || item.detProd || '(sin código)';
        if (!map.has(key)) map.set(key, { codProd: item.codProd, detProd: item.detProd, nvSet: new Set(), cant: 0, monto: 0 });
        const s = map.get(key);
        s.nvSet.add(nv.nvNumero);
        s.cant += item.cant || 0;
        s.monto += item.montoLinea || 0;
      });
    });
    return [...map.values()].map((s) => ({ ...s, nvCount: s.nvSet.size, nvNumeros: [...s.nvSet].join(' | ') })).sort((a, b) => b.cant - a.cant);
  }

  // Unidades y dinero que no se podrán atender por falta de stock, más el %
  // promedio de déficit — solo sobre las NV con quiebre (pool.conQuiebre).
  // Déficit por línea = cantidad solicitada - stock disponible (nunca < 0).
  // Dinero perdido por línea = unidades en déficit × precio unitario real
  // (columna "precio"/"nvPrecio" del Excel, leída en dataLoader.js).
  function computeQuiebreStock(universo, conQuiebre) {
    let totalDeficitUnidades = 0;
    let totalDineroPerdido = 0;
    let sumaPctLinea = 0;
    let countLineas = 0;
    conQuiebre.forEach((nv) => {
      nv.items.forEach((item) => {
        if (!item.quiebre) return;
        const deficit = Math.max(0, (item.cant || 0) - (item.stock || 0));
        const pctLinea = item.cant > 0 ? (deficit / item.cant) * 100 : 0;
        totalDeficitUnidades += deficit;
        totalDineroPerdido += deficit * (item.precioUnitario || 0);
        sumaPctLinea += pctLinea;
        countLineas += 1;
      });
    });
    const montoTotalUniverso = universo.reduce((s, nv) => s + (nv.montoTotal || 0), 0);
    return {
      totalDeficitUnidades,
      totalDineroPerdido,
      pctPromedioDeficit: countLineas > 0 ? sumaPctLinea / countLineas : 0,
      pctDineroPerdido: montoTotalUniverso > 0 ? (totalDineroPerdido / montoTotalUniverso) * 100 : 0,
    };
  }

  // Detalle por NV con quiebre: productos afectados y su déficit, para la
  // zona de detalle compartida.
  function computeQuiebreDetalle(conQuiebre) {
    return conQuiebre.map((nv) => {
      const productosTexto = nv.items
        .filter((it) => it.quiebre)
        .map((it) => `${it.detProd || it.codProd || '(sin código)'} (faltan ${Math.max(0, (it.cant || 0) - (it.stock || 0))})`)
        .join(' | ');
      return { nv, productosTexto };
    });
  }

  function renderFillRatePanel(universo, pool) {
    const cont = document.getElementById('np-fillrate');
    if (!cont) return;
    const montoSinQuiebre = pool.sinQuiebre.reduce((s, nv) => s + (nv.montoTotal || 0), 0);
    const montoConQuiebre = pool.conQuiebre.reduce((s, nv) => s + (nv.montoTotal || 0), 0);
    const pctSinQuiebre = universo.length > 0 ? (pool.sinQuiebre.length / universo.length) * 100 : 0;
    const pctConQuiebre = universo.length > 0 ? (pool.conQuiebre.length / universo.length) * 100 : 0;
    const stock = computeQuiebreStock(universo, pool.conQuiebre);
    cont.innerHTML = `
      <div class="np-zona4-total">
        <span class="np-zona4-total-label">Total NV del período</span>
        <span class="np-zona4-total-value">${universo.length}</span>
        <span class="np-zona4-total-label">según filtro de fecha activo</span>
      </div>
      <div class="np-zona4-grid">
        <div class="kpi-card kpi-card--success">
          <div class="kpi-card-label">Atendidas 100% · NV</div>
          <div class="kpi-card-value">${pool.sinQuiebre.length}</div>
          <div class="kpi-card-sub">${fmtPct(pctSinQuiebre)} del total</div>
        </div>
        <div class="kpi-card kpi-card--success">
          <div class="kpi-card-label">Atendidas 100% · Dinero</div>
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
        <div class="kpi-card kpi-card--danger">
          <div class="kpi-card-label">Unidades no atendidas por quiebre</div>
          <div class="kpi-card-value">${stock.totalDeficitUnidades}</div>
          <div class="kpi-card-sub">Promedio ${fmtPct(stock.pctPromedioDeficit)} de déficit por línea</div>
        </div>
        <div class="kpi-card kpi-card--danger">
          <div class="kpi-card-label">Dinero que dejaremos de recibir</div>
          <div class="kpi-card-value">${fmtMoney(stock.totalDineroPerdido)}</div>
          <div class="kpi-card-sub">${fmtPct(stock.pctDineroPerdido)} del monto total del período</div>
        </div>
      </div>
      <button id="np-fillrate-export-quiebre" class="btn-export btn-export--primary">⬇ Exportar productos con quiebre (Comex)</button>
    `;
    document.getElementById('np-quiebre-toggle')?.addEventListener('click', () => setDetalleActivo('quiebre'));
    document.getElementById('np-fillrate-export-quiebre')?.addEventListener('click', (e) => {
      const rows = computeQuiebreExport(universo);
      downloadXlsx(
        `quiebre_stock_comex_${new Date().toISOString().slice(0, 10)}.xlsx`,
        ['Código', 'Producto', 'N° de NV', 'NVs', 'Cantidad', 'Monto'],
        rows.map((s) => [s.codProd, s.detProd, s.nvCount, s.nvNumeros, s.cant, Math.round(s.monto)])
      );
      flashExportFeedback(e.currentTarget);
    });
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
      const list = listasPorId[detalleActivo.id];
      titulo = titulosPorId[detalleActivo.id];
      exportName = `nv_${detalleActivo.id}`;
      totalCount = list.length;
      headers = ['NV', 'Cliente', 'Canal', 'Guía', 'Monto', 'Fecha compromiso'];
      rows = list.slice(0, 300).map((nv) => [nv.nvNumero, nv.cliente, nv.canal || '', nv.guia || '', fmtMoney(nv.montoTotal), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : 'N/A']);
      xlsxHeaders = ['NV', 'Cliente', 'Vendedor', 'Canal', 'Guia', 'Monto', 'Fecha compromiso'];
      xlsxRows = list.map((nv) => [nv.nvNumero, nv.cliente, nv.vendedor, nv.canal, nv.guia || '', Math.round(nv.montoTotal), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : '']);
    } else if (detalleActivo.tipo === 'quiebre') {
      const quiebreList = computeQuiebreDetalle(pool.conQuiebre);
      titulo = 'Con quiebre de stock';
      exportName = 'nv_quiebre_stock';
      totalCount = quiebreList.length;
      headers = ['NV', 'Cliente', 'Productos con quiebre'];
      rows = quiebreList.slice(0, 300).map((d) => [d.nv.nvNumero, d.nv.cliente, d.productosTexto]);
      xlsxHeaders = ['NV', 'Cliente', 'Vendedor', 'Productos con quiebre'];
      xlsxRows = quiebreList.map((d) => [d.nv.nvNumero, d.nv.cliente, d.nv.vendedor, d.productosTexto]);
    } else {
      const bloqueadas = computeAlertas(universo).bloqueadas;
      titulo = 'Bloqueadas';
      exportName = 'nv_bloqueadas';
      totalCount = bloqueadas.length;
      headers = ['NV', 'Cliente', 'Canal', 'Guía', 'Monto', 'Fecha compromiso'];
      rows = bloqueadas.slice(0, 300).map((nv) => [nv.nvNumero, nv.cliente, nv.canal || '', nv.guia || '', fmtMoney(nv.montoTotal), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : 'N/A']);
      xlsxHeaders = ['NV', 'Cliente', 'Vendedor', 'Canal', 'Guia', 'Monto', 'Fecha compromiso'];
      xlsxRows = bloqueadas.map((nv) => [nv.nvNumero, nv.cliente, nv.vendedor, nv.canal, nv.guia || '', Math.round(nv.montoTotal), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : '']);
    }

    cont.innerHTML = `
      <h4>Detalle — ${titulo}${totalCount > 300 ? ` <span class="kpi-note">(mostrando las primeras 300 de ${totalCount})</span>` : ''}</h4>
      <button class="pill-btn" id="np-detalle-export">⬇ Exportar Excel</button>
      ${tableHtml(headers, rows)}
    `;
    document.getElementById('np-detalle-export')?.addEventListener('click', (e) => {
      downloadXlsx(`${exportName}_${new Date().toISOString().slice(0, 10)}.xlsx`, xlsxHeaders, xlsxRows);
      flashExportFeedback(e.currentTarget);
    });
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
    // Los días sin NV coordinadas no se muestran, así los demás días de la
    // semana usan el espacio que dejan libre.
    const diasConNv = dias.map((d, i) => ({ ...d, indice: i })).filter((d) => d.nvs.length > 0);
    if (diasConNv.length === 0) {
      cont.innerHTML = '<span class="np-semana-vacio">Sin notas de venta coordinadas esta semana.</span>';
      return;
    }
    cont.innerHTML = diasConNv
      .map(
        (d) => `
      <div class="np-semana-dia np-semana-dia--${d.indice % 6}">
        <div class="np-semana-dia-header">${nombresDia[d.indice]}<br>${d.fecha.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: '2-digit' })}</div>
        <div class="np-semana-dia-body">
          ${d.nvs
            .map(
              (nv) => `
            <div class="np-semana-nv">
              <span class="np-semana-nv-numero">${nv.nvNumero}</span>
              <span class="np-semana-nv-cliente">${nv.cliente || ''}</span>
            </div>`
            )
            .join('')}
        </div>
      </div>`
      )
      .join('');
  }

  function renderAll() {
    const universo = computeUniverso();
    const pool = computePool(universo);
    renderKpisPrincipales(universo, pool);
    renderAlertasPanel(universo);
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
    filtrosAbiertos = true;
    renderSidebarFiltros();
    renderAll();
  }

  renderSidebarFiltros();
  renderAll();
}

// ---------------------------------------------------------------------------
// 1. Cumplimiento — incluye descarga CSV + buscador de NV con historial
// ---------------------------------------------------------------------------

function renderCumplimiento(el, data) {
  el.innerHTML = `
    <h2>Cumplimiento de compromiso de despacho</h2>
    <div class="kpi-card-row">
      ${kpiCard('% cumplimiento', fmtPct(data.pctCumplimiento), `${data.aTiempo} a tiempo / ${data.atrasado} atrasadas`)}
      ${kpiCard('Atrasadas sin coordinar', data.sinCoordinar.length, 'Requieren atención inmediata')}
    </div>
    <div class="chart-box"><canvas id="chart-cumplimiento"></canvas></div>

    <div class="kpi-lookup">
      <h3>Buscar el historial de una NV</h3>
      <div class="kpi-lookup-row">
        <input type="text" id="nv-lookup-input" placeholder="N° de NV (ej: 332148)">
        <button id="nv-lookup-btn" class="btn-export">Buscar</button>
      </div>
      <div id="nv-lookup-result"></div>
    </div>

    <h3>NV atrasadas sin coordinar</h3>
    <button id="export-sin-coordinar" class="btn-export">⬇️ Exportar CSV</button>
    ${tableHtml(
      ['NV', 'Cliente', 'Vendedor', 'Fecha compromiso'],
      data.sinCoordinar
        .slice(0, 50)
        .map((nv) => [nv.nvNumero, nv.cliente, nv.vendedor, nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleString('es-CL') : 'N/A'])
    )}
  `;

  drawChart('chart-cumplimiento', {
    type: 'doughnut',
    data: {
      labels: ['A tiempo', 'Atrasadas'],
      datasets: [{ data: [data.aTiempo, data.atrasado], backgroundColor: [PALETTE.primary, PALETTE.accentWarn] }],
    },
    options: { plugins: { legend: { position: 'bottom' } } },
  });

  document.getElementById('export-sin-coordinar')?.addEventListener('click', () => {
    downloadCsv(
      `atrasadas_sin_coordinar_${new Date().toISOString().slice(0, 10)}.csv`,
      ['NV', 'Cliente', 'Vendedor', 'Fecha compromiso', 'Monto'],
      data.sinCoordinar.map((nv) => [
        nv.nvNumero,
        nv.cliente,
        nv.vendedor,
        nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleString('es-CL') : '',
        Math.round(nv.montoTotal),
      ])
    );
  });

  const runLookup = () => {
    const term = document.getElementById('nv-lookup-input').value.trim();
    const resultEl = document.getElementById('nv-lookup-result');
    if (!term) { resultEl.innerHTML = ''; return; }
    const nv = currentNvRecords.find((n) => n.nvNumero === term);
    if (!nv) {
      resultEl.innerHTML = `<p class="kpi-empty">No se encontró la NV ${term}.</p>`;
      return;
    }
    resultEl.innerHTML = `
      <div class="nv-detail-card">
        <div class="nv-detail-grid">
          <div><strong>NV:</strong> ${nv.nvNumero}</div>
          <div><strong>Cliente:</strong> ${nv.cliente}</div>
          <div><strong>Vendedor:</strong> ${nv.vendedor}</div>
          <div><strong>Estado:</strong> ${nv.nvEstado}</div>
          <div><strong>Canal:</strong> ${nv.canal} · ${nv.entrega}</div>
          <div><strong>Tipo de movimiento:</strong> ${nv.tipoMovimiento || ''}</div>
          <div><strong>Monto:</strong> ${fmtMoney(nv.montoTotal)}</div>
          <div><strong>Fecha creación:</strong> ${nv.fecCreacion ? nv.fecCreacion.toLocaleString('es-CL') : 'N/A'}</div>
          <div><strong>Fecha compromiso:</strong> ${nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleString('es-CL') : 'N/A'}</div>
          <div><strong>Fecha coordinada:</strong> ${nv.fCoordinacion ? nv.fCoordinacion.toLocaleString('es-CL') : 'Sin coordinar'}</div>
          <div><strong>Cumplimiento:</strong> ${nv.cumplimiento || 'N/A'}</div>
          <div><strong>Operador picking:</strong> ${nv.opPicking || 'Sin asignar'}</div>
          <div><strong>Auditor:</strong> ${nv.auditor || 'Sin asignar'}</div>
          <div><strong>Transportista/Chofer:</strong> ${nv.trans || nv.chofer || 'Sin asignar'}</div>
          <div><strong>Patente:</strong> ${nv.patente || 'Sin asignar'}</div>
        </div>
        <h4>Ítems</h4>
        ${tableHtml(
          ['Código', 'Producto', 'Cantidad', 'Stock disp.'],
          nv.items.map((it) => [it.codProd, it.detProd, it.cant, it.stock])
        )}
      </div>
    `;
  };
  document.getElementById('nv-lookup-btn')?.addEventListener('click', runLookup);
  document.getElementById('nv-lookup-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runLookup();
  });
}

// ---------------------------------------------------------------------------
// 1b. Cumplimiento de entregas (In Full)
// ---------------------------------------------------------------------------

function renderInFull(el, data) {
  el.innerHTML = `
    <h2>Cumplimiento de entregas (In Full)</h2>
    <p class="kpi-note">Solo NV concluidas (estado C), coordinadas dentro del período seleccionado. El In Full de cada NV es el promedio simple del cumplimiento de inventario (Cum_INV) de sus líneas — no ponderado por monto (a diferencia del fill rate de "Calidad de despacho").</p>
    <div class="kpi-card-row">
      ${kpiCard('NV concluidas evaluadas', data.nvInFull.length)}
    </div>

    <h3>Top 10 clientes por cumplimiento In Full</h3>
    <div class="kpi-chart-pair">
      <div>
        <p class="kpi-note" style="text-align:center;margin-bottom:4px;">Mejor cumplimiento</p>
        <div class="chart-box"><canvas id="chart-infull-mejor"></canvas></div>
      </div>
      <div>
        <p class="kpi-note" style="text-align:center;margin-bottom:4px;">Peor cumplimiento</p>
        <div class="chart-box"><canvas id="chart-infull-peor"></canvas></div>
      </div>
    </div>

    <h3>Detalle por NV</h3>
    ${tableHtml(
      ['NV', 'Cliente', 'Vendedor', 'Canal', 'Monto', 'In Full'],
      data.nvInFull
        .slice(0, 500)
        .map((nv) => [
          nv.nvNumero,
          nv.cliente,
          nv.vendedor,
          nv.canal || '',
          fmtMoney(nv.montoTotal),
          nv.inFullPromedio === null ? 'N/A' : fmtPct(nv.inFullPromedio * 100),
        ])
    )}
  `;

  drawChart('chart-infull-mejor', {
    type: 'bar',
    data: {
      labels: data.top10MejorInFull.map((c) => c.cliente),
      datasets: [
        {
          label: 'In Full',
          data: data.top10MejorInFull.map((c) => Math.round(c.promedio * 1000) / 10),
          backgroundColor: PALETTE.primary,
        },
      ],
    },
    options: { indexAxis: 'y', plugins: { legend: { display: false } } },
  });

  drawChart('chart-infull-peor', {
    type: 'bar',
    data: {
      labels: data.top10PeorInFull.map((c) => c.cliente),
      datasets: [
        {
          label: 'In Full',
          data: data.top10PeorInFull.map((c) => Math.round(c.promedio * 1000) / 10),
          backgroundColor: PALETTE.accentDanger,
        },
      ],
    },
    options: { indexAxis: 'y', plugins: { legend: { display: false } } },
  });
}

// ---------------------------------------------------------------------------
// 2. Calidad (incluye fill rate, quiebres de stock y Consolidado Comex)
// ---------------------------------------------------------------------------

function renderCalidad(el, fillRate, quiebres, comex) {
  el.innerHTML = `
    <h2>Calidad de despacho</h2>
    <div class="kpi-card-row">
      ${kpiCard('Fill rate ponderado por monto', fmtPct(fillRate.fillRatePonderado), fmtMoney(fillRate.sumaMonto) + ' facturados en el período')}
    </div>
    <h3>Top productos con quiebre de stock</h3>
    <div class="chart-box"><canvas id="chart-quiebres"></canvas></div>
    ${tableHtml(['Código', 'Producto', 'N° de ocurrencias'], quiebres.map((q) => [q.codProd, q.detProd, q.ocurrencias]))}

    <h3>Consolidado para Comex</h3>
    <p class="kpi-note">SKU que se repiten en varias NV pendientes de despacho, para priorizar embarques. No depende del filtro de fecha — es "lo que falta hoy".</p>
    <button id="export-comex" class="btn-export">⬇️ Exportar CSV</button>
    ${tableHtml(
      ['Código', 'Producto', 'N° de NV', 'Cantidad total', 'Monto a despachar'],
      comex.slice(0, 100).map((s) => [s.codProd, s.detProd, s.nvCount, s.cant, fmtMoney(s.monto)])
    )}
  `;
  drawChart('chart-quiebres', {
    type: 'bar',
    data: {
      labels: quiebres.map((q) => q.codProd || q.detProd),
      datasets: [{ label: 'Ocurrencias de quiebre', data: quiebres.map((q) => q.ocurrencias), backgroundColor: PALETTE.primary }],
    },
    options: { indexAxis: 'y', plugins: { legend: { display: false } } },
  });

  document.getElementById('export-comex')?.addEventListener('click', () => {
    downloadCsv(
      `comex_consolidado_sku_${new Date().toISOString().slice(0, 10)}.csv`,
      ['Codigo', 'Producto', 'N NV', 'NV (detalle)', 'Cantidad total', 'Monto a despachar'],
      comex.map((s) => [s.codProd, s.detProd, s.nvCount, s.nvNumeros, s.cant, Math.round(s.monto)])
    );
  });
}

// ---------------------------------------------------------------------------
// 3. Valor MIN despacho
// ---------------------------------------------------------------------------

function renderNorma300(el, data) {
  el.innerHTML = `
    <h2>Valor MIN despacho ($300.000)</h2>
    <p class="kpi-note">Solo considera NV con tipo de entrega Despacho y Canal_EN Despacho.</p>
    <div class="kpi-card-row">
      ${kpiCard('NV bajo el mínimo despachadas', data.nvBajoMonto.length, fmtPct(data.pctBajoMonto) + ' de las NV de despacho concluidas')}
    </div>
    <h3>Por vendedor</h3>
    ${tableHtml(['Vendedor', 'N° NV', 'Monto'], data.bajoMontoPorVendedor.map((v) => [v.nombre, v.count, fmtMoney(v.monto)]))}
    <h3>Detalle de NV afectadas</h3>
    ${tableHtml(
      ['NV', 'Cliente', 'Vendedor', 'Monto'],
      data.nvBajoMonto.slice(0, 50).map((nv) => [nv.nvNumero, nv.cliente, nv.vendedor, fmtMoney(nv.montoTotal)])
    )}
  `;
}

// ---------------------------------------------------------------------------
// 4. Ranking de clientes
// ---------------------------------------------------------------------------

function renderClientes(el, ranking, porTipo) {
  const top = ranking.slice(0, 15);
  el.innerHTML = `
    <h2>Ranking de clientes</h2>
    <p class="kpi-note">Incluye NV concluidas y NV con guía o factura ya emitida. El monto es el valor realmente despachado (total de la NV menos lo pendiente por despachar). El tipo de movimiento indica si fue retiro, ecommerce, retail o despacho desde bodega.</p>

    <h3>Monto total despachado por tipo</h3>
    ${tableHtml(['Tipo', 'N° de NV', 'Monto'], porTipo.map((t) => [t.nombre, t.count, fmtMoney(t.monto)]))}

    <h3>Top clientes</h3>
    <div class="chart-box"><canvas id="chart-clientes"></canvas></div>
    ${tableHtml(
      ['Cliente', 'Monto', 'Vendedor(es)', 'Tipo de movimiento', ''],
      ranking
        .slice(0, 50)
        .map((c) => [c.cliente, fmtMoney(c.monto), c.vendedores, c.movimientos, c.bajoUmbral ? '<span class="tag-warning">bajo $300.000</span>' : ''])
    )}
  `;
  drawChart('chart-clientes', {
    type: 'bar',
    data: {
      labels: top.map((c) => c.cliente),
      datasets: [{ label: 'Monto', data: top.map((c) => c.monto), backgroundColor: PALETTE.primary }],
    },
    options: { indexAxis: 'y', plugins: { legend: { display: false } } },
  });
}

// ---------------------------------------------------------------------------
// 5. Ranking de operación (columnas agrupadas: N° NV + líneas atendidas)
// ---------------------------------------------------------------------------

function renderOperacion(el, data) {
  el.innerHTML = `
    <h2>Ranking de operación</h2>
    <h3>Operadores de picking — N° de NV y líneas atendidas (it_at)</h3>
    <div class="chart-box"><canvas id="chart-picking"></canvas></div>
    ${tableHtml(['Operador', 'N° NV atendidas', 'Monto total'], data.rankingPicking.map((r) => [r.nombre, r.count, fmtMoney(r.monto)]))}
    <h3>Transportistas</h3>
    ${tableHtml(['Transportista', 'N° NV atendidas', 'Monto total'], data.rankingTransportista.map((r) => [r.nombre, r.count, fmtMoney(r.monto)]))}
    <h3>Auditores</h3>
    ${tableHtml(['Auditor', 'N° NV atendidas', 'Monto total'], data.rankingAuditor.map((r) => [r.nombre, r.count, fmtMoney(r.monto)]))}
  `;

  const topNv = data.rankingPicking.slice(0, 10);
  const lineasPorNombre = new Map(data.lineasPorOperador.map((r) => [r.nombre, r.valor]));

  drawChart('chart-picking', {
    type: 'bar',
    data: {
      labels: topNv.map((r) => r.nombre),
      datasets: [
        { label: 'N° NV atendidas', data: topNv.map((r) => r.count), backgroundColor: PALETTE.primary },
        {
          label: 'Líneas atendidas (it_at)',
          data: topNv.map((r) => lineasPorNombre.get(r.nombre) || 0),
          backgroundColor: PALETTE.accentWarn,
        },
      ],
    },
    options: { plugins: { legend: { position: 'bottom' } } },
  });
}

// ---------------------------------------------------------------------------
// 6. Retiros mal marcados
// ---------------------------------------------------------------------------

function renderRetiros(el, data) {
  el.innerHTML = `
    <h2>Retiros mal marcados como despacho</h2>
    <div class="kpi-card-row">
      ${kpiCard('NV afectadas', data.retirosMalMarcados.length)}
    </div>
    <h3>Por vendedor</h3>
    ${tableHtml(['Vendedor', 'N° NV', 'Monto'], data.retiroPorVendedor.map((v) => [v.nombre, v.count, fmtMoney(v.monto)]))}
    <h3>Detalle</h3>
    ${tableHtml(
      ['NV', 'Cliente', 'Vendedor'],
      data.retirosMalMarcados.slice(0, 50).map((nv) => [nv.nvNumero, nv.cliente, nv.vendedor])
    )}
  `;
}

// ---------------------------------------------------------------------------
// 7. Transporte diario
// ---------------------------------------------------------------------------

function renderTransporte(el, transporte) {
  const porDia = new Map();
  transporte.forEach((t) => {
    const key = t.fecha.toLocaleDateString('es-CL');
    if (!porDia.has(key)) porDia.set(key, { fecha: key, km: 0, monto: 0, nv: 0 });
    const g = porDia.get(key);
    g.km += t.kmUso;
    g.monto += t.montoEntregado;
    g.nv += t.nvCount;
  });
  const dias = [...porDia.values()];

  el.innerHTML = `
    <h2>Transporte diario</h2>
    <div class="chart-box"><canvas id="chart-transporte"></canvas></div>
    ${tableHtml(
      ['Fecha', 'Chofer/Operador', 'Patente', 'Km recorridos', 'Monto entregado', 'Valor/km', 'N° NV'],
      transporte.map((t) => [
        t.fecha.toLocaleDateString('es-CL'),
        t.operador,
        t.patente,
        Math.round(t.kmUso),
        fmtMoney(t.montoEntregado),
        fmtMoney(t.valorKm),
        t.nvCount,
      ])
    )}
  `;
  drawChart('chart-transporte', {
    type: 'bar',
    data: {
      labels: dias.map((d) => d.fecha),
      datasets: [
        { label: 'Km recorridos', data: dias.map((d) => d.km), backgroundColor: PALETTE.primaryLight, yAxisID: 'y' },
        { label: 'N° NV', data: dias.map((d) => d.nv), backgroundColor: PALETTE.primary, yAxisID: 'y1' },
      ],
    },
    options: {
      scales: {
        y: { position: 'left', title: { display: true, text: 'Km' } },
        y1: { position: 'right', title: { display: true, text: 'N° NV' }, grid: { drawOnChartArea: false } },
      },
    },
  });
}

