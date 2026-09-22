// kpi.js
// Cálculo de los indicadores de gerencia y render de cada sección
// (tarjetas + tablas + gráficos) en el panel principal del módulo KPI.

import {
  startOfDay,
  endOfDay,
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
  let entregaActiva = 'todos'; // 'todos' | 'RETIRA' | 'DESPACHO'
  let fechaModo = 'semana'; // 'dia' | 'semana' | 'mes' | 'rango' | 'todo'
  let fechaRefDate = yesterday(); // solo se usa si fechaModo === 'dia'; ajustable con el input de fecha
  let fechaCustomRange = null; // { start, end } cuando fechaModo === 'rango'
  let fechaBounds = null; // { min, totalDays } límites del slider de rango (sobre Fec_Cre)
  let searchTerm = ''; // busca por NV / cliente / vendedor
  let kpiDetalleAbierto = null; // 'total' | 'facturar' | 'enProceso' | null — detalle expandible bajo las tarjetas de Estados
  let bloqueadasAbierto = false; // detalle expandible de NV bloqueadas, dentro de Alertas

  el.innerHTML = `
    <div class="np-header">
      <h2>Notas de ventas aceptadas</h2>
      <p class="kpi-note">Todas las NV en estado A: aprobadas por el área comercial, pendientes de que logística las procese.</p>
    </div>

    <div class="np-toolbar">
      <div class="np-toolbar-group">
        <span class="np-toolbar-label">Entrega</span>
        <div class="kpi-filter-buttons" id="np-filtro-entrega">
          <button class="btn-toggle active" data-value="todos">Todos</button>
          <button class="btn-toggle" data-value="RETIRA">Retira</button>
          <button class="btn-toggle" data-value="DESPACHO">Despacho</button>
        </div>
      </div>
      <div class="np-toolbar-sep"></div>
      <div class="np-toolbar-group">
        <span class="np-toolbar-label">Fecha de creación</span>
        <div class="kpi-filter-buttons" id="np-filtro-fecha">
          <button class="btn-toggle" data-value="dia">Día</button>
          <button class="btn-toggle active" data-value="semana">Semana</button>
          <button class="btn-toggle" data-value="mes">Mes</button>
          <button class="btn-toggle" data-value="rango">Rango</button>
          <button class="btn-toggle" data-value="todo">Todo</button>
        </div>
        <input type="date" id="np-fecha-input" class="kpi-filter-select hidden">
        <span class="kpi-range-label" id="np-fecha-label"></span>
      </div>
      <div class="np-toolbar-sep"></div>
      <div class="np-toolbar-group np-search-group">
        <span class="np-toolbar-label">Buscar</span>
        <div class="np-search-box">
          <span class="np-search-icon">🔍</span>
          <input type="text" id="np-search-input" placeholder="NV, cliente o vendedor...">
        </div>
      </div>
      <button id="np-limpiar-filtros" class="btn-clear-filters">✕ Limpiar</button>
    </div>
    <div class="kpi-range-slider hidden" id="np-range-slider">
      <div class="kpi-range-slider-labels">
        <span id="np-range-start-label"></span>
        <span id="np-range-end-label"></span>
      </div>
      <div class="kpi-range-slider-track">
        <input type="range" id="np-range-start" min="0" max="0" value="0">
        <input type="range" id="np-range-end" min="0" max="0" value="0">
      </div>
    </div>

    <div class="np-canvas-row">
      <div class="np-canvas np-canvas--estados">
        <h3 class="np-canvas-title">Estados de Notas de Venta activas</h3>
        <div id="np-kpis"></div>
        <div id="np-kpis-detalle"></div>
      </div>
      <div class="np-canvas np-canvas--alertas">
        <h3 class="np-canvas-title">Alertas</h3>
        <div id="np-alertas"></div>
      </div>
      <div class="np-canvas np-canvas--fillrate">
        <h3 class="np-canvas-title">Fill Rate</h3>
        <div id="np-fillrate"></div>
      </div>
    </div>

    <div class="np-section-label">Notas de venta por canal</div>
    <div class="np-canal-panel" id="np-canal"></div>
  `;

  function isSaneDate(d) {
    if (!d || isNaN(d.getTime())) return false;
    const year = d.getFullYear();
    const nowYear = new Date().getFullYear();
    return year >= nowYear - 10 && year <= nowYear + 2;
  }

  function getFechaBounds() {
    let min = null;
    let max = null;
    nvRecords.forEach((nv) => {
      if (!isSaneDate(nv.fecCreacion)) return;
      if (!min || nv.fecCreacion < min) min = nv.fecCreacion;
      if (!max || nv.fecCreacion > max) max = nv.fecCreacion;
    });
    const today = new Date();
    if (!min) min = today;
    if (!max || max < today) max = today;
    return { min: startOfDay(min), max: startOfDay(max) };
  }

  function syncRangeLabels() {
    const { min } = fechaBounds;
    const startInput = document.getElementById('np-range-start');
    const endInput = document.getElementById('np-range-end');
    const startDate = new Date(min.getTime() + Number(startInput.value) * 86400000);
    const endDate = new Date(min.getTime() + Number(endInput.value) * 86400000);
    document.getElementById('np-range-start-label').textContent = startDate.toLocaleDateString('es-CL');
    document.getElementById('np-range-end-label').textContent = endDate.toLocaleDateString('es-CL');
    fechaCustomRange = { start: startOfDay(startDate), end: endOfDay(endDate) };
  }

  function setupFechaRangeSlider() {
    const startInput = document.getElementById('np-range-start');
    const endInput = document.getElementById('np-range-end');
    if (!startInput || !endInput) return;
    const { min, max } = getFechaBounds();
    const totalDays = Math.max(1, Math.round((max - min) / 86400000));
    startInput.min = 0;
    startInput.max = totalDays;
    endInput.min = 0;
    endInput.max = totalDays;
    startInput.value = Math.max(0, totalDays - 30);
    endInput.value = totalDays;
    fechaBounds = { min, totalDays };
    syncRangeLabels();
  }

  function computeUniverso() {
    const range = fechaModo === 'rango' ? fechaCustomRange || getFechaBounds() : fechaModo === 'todo' ? getFechaBounds() : getDateRange(fechaRefDate, fechaModo);
    const dateInput = document.getElementById('np-fecha-input');
    if (dateInput) {
      dateInput.classList.toggle('hidden', fechaModo !== 'dia');
      const pad = (n) => String(n).padStart(2, '0');
      dateInput.value = `${fechaRefDate.getFullYear()}-${pad(fechaRefDate.getMonth() + 1)}-${pad(fechaRefDate.getDate())}`;
    }
    document.getElementById('np-range-slider')?.classList.toggle('hidden', fechaModo !== 'rango');
    const label = document.getElementById('np-fecha-label');
    if (label) {
      label.textContent =
        fechaModo === 'todo'
          ? 'Todas las fechas'
          : range.start.toLocaleDateString('es-CL') === range.end.toLocaleDateString('es-CL')
          ? range.start.toLocaleDateString('es-CL')
          : `${range.start.toLocaleDateString('es-CL')} – ${range.end.toLocaleDateString('es-CL')}`;
    }
    const term = searchTerm.trim().toLowerCase();
    return nvRecords.filter((nv) => {
      if (nv.nvEstado !== 'A') return false;
      if (entregaActiva !== 'todos' && nv.entrega !== entregaActiva) return false;
      if (fechaModo !== 'todo' && !inRange(nv.fecCreacion, range)) return false;
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
    // Entregada al 100%: todas las líneas con Cum_INV completo.
    const esCompleto = (nv) => nv.items.length > 0 && nv.items.every((it) => (it.inFull || 0) >= 0.999);
    const entregada100 = universo.filter(esCompleto);
    // Pendientes de facturar: salió completo, tiene guía, pero no tiene
    // factura asociada — reemplaza a la antigua tarjeta "Entregadas (pend.
    // rebaja)".
    const pendientesFacturar = entregada100.filter((nv) => nv.guia && !nv.factura);
    const parcial = universo.filter((nv) => nv.statusDes === 'ENT_PARCIAL');
    const sinEntregarTotal = universo.filter((nv) => !nv.statusDes);
    // En proceso: dentro de "sin entregar", aquellas con operario de picking
    // ya asignado en Desp (columna F) pero sin Status de Desp aún (columna
    // Q vacía) — criterio confirmado, usa opPickingDesp (solo Desp, sin
    // combinar con Corte) a propósito.
    const enProceso = sinEntregarTotal.filter((nv) => nv.opPickingDesp && !nv.despStatus);
    const sinAccion = sinEntregarTotal.filter((nv) => !(nv.opPickingDesp && !nv.despStatus));
    return { entregada100, pendientesFacturar, parcial, sinEntregarTotal, enProceso, sinAccion };
  }

  function renderKpisPrincipales(universo, pool) {
    const montoDe = (list) => list.reduce((s, nv) => s + (nv.montoTotal || 0), 0);
    document.getElementById('np-kpis').innerHTML = `
      <div class="kpi-card-row">
        <div class="kpi-card">
          <div class="kpi-card-label">Total pendientes</div>
          <div class="kpi-card-value">${universo.length}</div>
          <div class="kpi-card-sub">${fmtMoney(montoDe(universo))}</div>
          <button class="btn-export kpi-card-action" id="np-kpi-total-toggle">${kpiDetalleAbierto === 'total' ? '▴ Ocultar' : '▾ Ver detalle'}</button>
        </div>
        <div class="kpi-card kpi-card--highlight">
          <div class="kpi-card-label">Pendientes de facturar</div>
          <div class="kpi-card-value">${pool.pendientesFacturar.length}</div>
          <div class="kpi-card-sub">${fmtMoney(montoDe(pool.pendientesFacturar))}</div>
          <button class="btn-export kpi-card-action" id="np-kpi-facturar-toggle">${kpiDetalleAbierto === 'facturar' ? '▴ Ocultar' : '▾ Ver detalle'}</button>
        </div>
        ${kpiCard('Entrega parcial', pool.parcial.length, fmtMoney(montoDe(pool.parcial)))}
        <div class="kpi-card kpi-card--cool">
          <div class="kpi-card-label">Total de NV sin entregar</div>
          <div class="kpi-card-value">${pool.sinEntregarTotal.length}</div>
          <div class="kpi-card-sub">${fmtMoney(montoDe(pool.sinEntregarTotal))}</div>
          <div class="kpi-card-minirow">
            <div class="kpi-card-minibox kpi-card-minibox--progreso">
              <span class="kpi-card-minibox-value">${pool.enProceso.length}</span>
              <span class="kpi-card-minibox-label">en proceso</span>
            </div>
            <div class="kpi-card-minibox kpi-card-minibox--pendiente">
              <span class="kpi-card-minibox-value">${pool.sinAccion.length}</span>
              <span class="kpi-card-minibox-label">por procesar</span>
            </div>
          </div>
          <button class="btn-export kpi-card-action" id="np-kpi-enproceso-toggle">${kpiDetalleAbierto === 'enProceso' ? '▴ Ocultar' : '▾ Ver en proceso'}</button>
        </div>
      </div>
    `;

    document.getElementById('np-kpi-total-toggle')?.addEventListener('click', () => {
      kpiDetalleAbierto = kpiDetalleAbierto === 'total' ? null : 'total';
      renderKpisPrincipales(universo, pool);
    });
    document.getElementById('np-kpi-facturar-toggle')?.addEventListener('click', () => {
      kpiDetalleAbierto = kpiDetalleAbierto === 'facturar' ? null : 'facturar';
      renderKpisPrincipales(universo, pool);
    });
    document.getElementById('np-kpi-enproceso-toggle')?.addEventListener('click', () => {
      kpiDetalleAbierto = kpiDetalleAbierto === 'enProceso' ? null : 'enProceso';
      renderKpisPrincipales(universo, pool);
    });

    renderKpisDetalle(universo, pool);
  }

  function renderKpisDetalle(universo, pool) {
    const cont = document.getElementById('np-kpis-detalle');
    if (!cont) return;
    if (!kpiDetalleAbierto) {
      cont.innerHTML = '';
      return;
    }
    const list = kpiDetalleAbierto === 'total' ? universo : kpiDetalleAbierto === 'facturar' ? pool.pendientesFacturar : pool.enProceso;
    const titulo = kpiDetalleAbierto === 'total' ? 'Total pendientes' : kpiDetalleAbierto === 'facturar' ? 'Pendientes de facturar' : 'En proceso';
    cont.innerHTML = `
      <h4>${titulo}${list.length > 300 ? ` <span class="kpi-note">(mostrando las primeras 300 de ${list.length})</span>` : ''}</h4>
      <button class="btn-export" id="np-kpi-detalle-export">⬇ Exportar Excel</button>
      ${tableHtml(
        ['NV', 'Cliente', 'Canal', 'Guía', 'Monto', 'Fecha compromiso'],
        list
          .slice(0, 300)
          .map((nv) => [nv.nvNumero, nv.cliente, nv.canal || '', nv.guia || '', fmtMoney(nv.montoTotal), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : 'N/A'])
      )}
    `;
    document.getElementById('np-kpi-detalle-export')?.addEventListener('click', (e) => {
      downloadXlsx(
        `nv_${kpiDetalleAbierto}_${new Date().toISOString().slice(0, 10)}.xlsx`,
        ['NV', 'Cliente', 'Vendedor', 'Canal', 'Guia', 'Monto', 'Fecha compromiso'],
        list.map((nv) => [nv.nvNumero, nv.cliente, nv.vendedor, nv.canal, nv.guia || '', Math.round(nv.montoTotal), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : ''])
      );
      flashExportFeedback(e.currentTarget);
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
        <button class="btn-export" id="np-alerta-bloqueadas-toggle">${bloqueadasAbierto ? '▴ Ocultar' : '▾ Ver detalle'}</button>
        <button class="btn-export" id="np-alerta-bloqueadas-export">⬇ Exportar Excel</button>
      </div>
      <div id="np-alerta-bloqueadas-detalle"></div>
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

    document.getElementById('np-alerta-bloqueadas-toggle')?.addEventListener('click', () => {
      bloqueadasAbierto = !bloqueadasAbierto;
      renderAlertasPanel(universo);
    });
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

    const detalleCont = document.getElementById('np-alerta-bloqueadas-detalle');
    if (bloqueadasAbierto && detalleCont) {
      detalleCont.innerHTML = tableHtml(
        ['NV', 'Cliente', 'Canal', 'Monto', 'Fecha compromiso'],
        bloqueadas
          .slice(0, 300)
          .map((nv) => [nv.nvNumero, nv.cliente, nv.canal || '', fmtMoney(nv.montoTotal), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : 'N/A'])
      );
    }
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

  function renderFillRatePanel(universo, pool) {
    const cont = document.getElementById('np-fillrate');
    if (!cont) return;
    const conQuiebreOParcial = universo.filter((nv) => nv.statusDes === 'ENT_PARCIAL' || nv.items.some((it) => it.quiebre));
    const atendidas = universo.length - pool.sinAccion.length;
    const total = universo.length;
    const pct = (n) => (total > 0 ? Math.round((n / total) * 100) : 0);
    const itemHtml = (n, label, extraClass) => `
        <div class="np-fillrate-item${extraClass ? ' ' + extraClass : ''}">
          <span class="np-fillrate-value">${n}<span class="np-fillrate-pct">${pct(n)}%</span></span>
          <span class="np-fillrate-label">${label}</span>
        </div>`;
    cont.innerHTML = `
      <div class="np-fillrate-grid">
        ${itemHtml(total, 'Total NV')}
        ${itemHtml(atendidas, 'Atendidas en el período')}
        ${itemHtml(pool.entregada100.length, 'Al 100%', 'np-fillrate-item--success')}
        ${itemHtml(conQuiebreOParcial.length, 'Con quiebre o parcial', 'np-fillrate-item--warning')}
        ${itemHtml(pool.sinAccion.length, 'Sin atención del período', 'np-fillrate-item--danger')}
      </div>
      <button id="np-fillrate-export-quiebre" class="btn-export btn-export--primary">⬇ Exportar productos con quiebre (Comex)</button>
    `;
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

  function computeCanalBreakdown(universo) {
    const map = new Map();
    universo.forEach((nv) => {
      const key = nv.canal || 'Sin canal';
      if (!map.has(key)) map.set(key, { canal: key, count: 0, monto: 0 });
      const g = map.get(key);
      g.count += 1;
      g.monto += nv.montoTotal || 0;
    });
    const total = universo.length;
    return [...map.values()]
      .map((g) => ({ ...g, pct: total > 0 ? Math.round((g.count / total) * 100) : 0 }))
      .sort((a, b) => b.count - a.count);
  }

  function renderCanalPanel(universo) {
    const cont = document.getElementById('np-canal');
    if (!cont) return;
    const rows = computeCanalBreakdown(universo);
    if (rows.length === 0) {
      cont.innerHTML = '<p class="kpi-empty">No se encontraron notas de venta con estos filtros.</p>';
      return;
    }
    cont.innerHTML = rows
      .map(
        (r) => `
      <div class="np-canal-row">
        <span class="np-canal-name">${r.canal}</span>
        <div class="np-canal-bar-track"><div class="np-canal-bar-fill" style="width:${r.pct}%"></div></div>
        <span class="np-canal-count">${r.count} NV</span>
        <span class="np-canal-monto">${fmtMoney(r.monto)}</span>
        <span class="np-canal-pct">${r.pct}%</span>
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
    renderCanalPanel(universo);
  }

  function wireButtonGroup(containerId, onChange) {
    document.querySelectorAll(`#${containerId} .btn-toggle`).forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll(`#${containerId} .btn-toggle`).forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        onChange(btn.dataset.value);
        renderAll();
      });
    });
  }

  function limpiarFiltros() {
    entregaActiva = 'todos';
    fechaModo = 'semana';
    searchTerm = '';
    kpiDetalleAbierto = null;
    document.querySelectorAll('#np-filtro-entrega .btn-toggle, #np-filtro-fecha .btn-toggle').forEach((b) => {
      b.classList.toggle('active', b.dataset.value === 'todos' || b.dataset.value === 'semana');
    });
    const searchInput = document.getElementById('np-search-input');
    if (searchInput) searchInput.value = '';
    renderAll();
  }

  renderAll();
  wireButtonGroup('np-filtro-entrega', (v) => (entregaActiva = v));
  wireButtonGroup('np-filtro-fecha', (v) => {
    fechaModo = v;
    if (v === 'rango') setupFechaRangeSlider();
  });
  document.getElementById('np-fecha-input')?.addEventListener('change', (e) => {
    fechaRefDate = e.target.value ? new Date(e.target.value + 'T00:00:00') : yesterday();
    renderAll();
  });
  document.getElementById('np-search-input')?.addEventListener('input', (e) => {
    searchTerm = e.target.value;
    renderAll();
  });
  document.getElementById('np-limpiar-filtros')?.addEventListener('click', limpiarFiltros);

  const rangoStart = document.getElementById('np-range-start');
  const rangoEnd = document.getElementById('np-range-end');
  rangoStart?.addEventListener('input', () => {
    if (+rangoStart.value > +rangoEnd.value) rangoStart.value = rangoEnd.value;
    syncRangeLabels();
    renderAll();
  });
  rangoEnd?.addEventListener('input', () => {
    if (+rangoEnd.value < +rangoStart.value) rangoEnd.value = rangoStart.value;
    syncRangeLabels();
    renderAll();
  });
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

