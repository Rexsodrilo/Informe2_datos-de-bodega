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
} from './businessDates.js?v=7';

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

export function renderKpiSection(sectionId, kpis, nvRecords, contHodo) {
  const el = document.getElementById('kpi-panel');
  if (!el) return;

  switch (sectionId) {
    case 'notasPendientes':
      renderNotasPendientes(el, nvRecords);
      break;
    case 'notasConcluidas':
      renderNotasConcluidas(el, nvRecords, contHodo);
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
        <span class="zone-label zone-label--slate">Notas de ventas coordinadas</span>
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

  function computeAlertas(universo, conQuiebre) {
    const ahora = new Date();
    const horasHabilesPorDia = WORK_END - WORK_START;
    // "Atrasada" = ya pasó su fecha compromiso (cualquier atraso, sin
    // umbral) — se usa solo para cruzarla con quiebre/bloqueo abajo; el
    // desglose por rango de días (5/15/30/50) se sacó por ocupar espacio
    // sin aportar más que estos cruces.
    const conAtraso = universo
      .map((nv) => ({ nv, dias: businessHoursElapsed(nv.fechaCompromiso, ahora) / horasHabilesPorDia }))
      .filter((x) => x.dias > 0);
    const atrasadasSet = new Set(conAtraso.map((x) => x.nv));
    const bloqueadas = universo.filter((nv) => nv.bloqueado);
    // Cruces: la combinación es más urgente que cada alerta por separado.
    const bloqueadasAtrasadas = bloqueadas.filter((nv) => atrasadasSet.has(nv));
    const quiebreAtrasadas = conQuiebre.filter((nv) => atrasadasSet.has(nv));
    return { bloqueadas, bloqueadasAtrasadas, quiebreAtrasadas };
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
    const { bloqueadas, bloqueadasAtrasadas, quiebreAtrasadas } = computeAlertas(universo, pool.conQuiebre);
    const porVencer = computePorVencerSinCoordinar(universo);
    const retirosMalMarcados = universo.filter((nv) => nv.retiroMalMarcado);
    const preparacionEstancada = computePreparacionEstancada(pool.enProcesoPreparacion);
    const lineasDuplicadas = computeLineasDuplicadas(universo);

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
      ${filaHtml('quiebreAtrasadas', 'status-badge--danger', 'Atrasada + quiebre de stock', quiebreAtrasadas)}
      ${filaHtml('bloqueadasAtrasadas', 'status-badge--danger', 'Bloqueada + atrasada', bloqueadasAtrasadas)}
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

  // Unidades y dinero en líneas con quiebre — la cantidad/valor de CADA
  // línea es lo REALMENTE pendiente de esa línea (Sal_X_Des × nvPrecio), no
  // la cantidad/valor original pedido: sumar el original ahí infla el
  // número con unidades que ya se despacharon. El flag `quiebre` en sí
  // sigue viniendo de comparar el stock comprometido (Σ Sal_X_Des) contra
  // el stock del sistema (dataLoader.js); esto solo decide qué se MUESTRA
  // para cada línea ya marcada.
  function computeQuiebreStock(universo, conQuiebre) {
    let totalUnidades = 0;
    let totalDinero = 0;
    conQuiebre.forEach((nv) => {
      nv.items.forEach((item) => {
        if (!item.quiebre) return;
        totalUnidades += item.salXDes || 0;
        totalDinero += item.montoPorDespachar || 0;
      });
    });
    const unidadesTotalUniverso = universo.reduce((s, nv) => s + nv.items.reduce((s2, it) => s2 + (it.salXDes || 0), 0), 0);
    const montoTotalUniverso = universo.reduce((s, nv) => s + (nv.montoPorDespachar || 0), 0);
    return {
      totalUnidades,
      totalDinero,
      pctUnidades: unidadesTotalUniverso > 0 ? (totalUnidades / unidadesTotalUniverso) * 100 : 0,
      pctDinero: montoTotalUniverso > 0 ? (totalDinero / montoTotalUniverso) * 100 : 0,
    };
  }

  // Detalle por NV con quiebre, en formato planilla: una fila por cada
  // producto con quiebre de cada NV (si una NV tiene 3 productos con
  // quiebre, aparece 3 veces, una por línea) — reemplaza al antiguo botón
  // "Exportar productos con quiebre (Comex)". Cantidad y valor son lo
  // pendiente real de esa línea (Sal_X_Des × nvPrecio).
  function computeQuiebreDetalle(conQuiebre) {
    const filas = [];
    conQuiebre.forEach((nv) => {
      nv.items
        .filter((it) => it.quiebre)
        .forEach((it) => {
          filas.push({
            nvNumero: nv.nvNumero,
            cliente: nv.cliente,
            codProd: it.codProd,
            detProd: it.detProd,
            cant: it.salXDes,
            montoLinea: it.montoPorDespachar,
          });
        });
    });
    return filas;
  }

  function renderFillRatePanel(universo, pool) {
    const cont = document.getElementById('np-fillrate');
    if (!cont) return;
    const montoSinQuiebre = pool.sinQuiebre.reduce((s, nv) => s + (nv.montoPorDespachar || 0), 0);
    const montoConQuiebre = pool.conQuiebre.reduce((s, nv) => s + (nv.montoPorDespachar || 0), 0);
    const pctSinQuiebre = universo.length > 0 ? (pool.sinQuiebre.length / universo.length) * 100 : 0;
    const pctConQuiebre = universo.length > 0 ? (pool.conQuiebre.length / universo.length) * 100 : 0;
    const stock = computeQuiebreStock(universo, pool.conQuiebre);
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
          <div class="kpi-card-label">Unidades en líneas con quiebre</div>
          <div class="kpi-card-value">${stock.totalUnidades}</div>
          <div class="kpi-card-sub">${fmtPct(stock.pctUnidades)} de las unidades del período</div>
        </div>
        <div class="kpi-card kpi-card--danger">
          <div class="kpi-card-label">Dinero en líneas con quiebre</div>
          <div class="kpi-card-value">${fmtMoney(stock.totalDinero)}</div>
          <div class="kpi-card-sub">${fmtPct(stock.pctDinero)} del monto total del período</div>
        </div>
      </div>
    `;
    document.getElementById('np-quiebre-toggle')?.addEventListener('click', () => setDetalleActivo('quiebre'));
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
      // "Entregadas" muestra el valor completo (lo pendiente ahí es $0); las
      // otras 3 muestran lo REAL pendiente por despachar.
      const montoDe = (nv) => (detalleActivo.id === 'entregadas' ? nv.montoTotal : nv.montoPorDespachar);
      headers = ['NV', 'Cliente', 'Canal', 'Guía', 'Monto', 'Fecha compromiso'];
      rows = list.slice(0, 300).map((nv) => [nv.nvNumero, nv.cliente, nv.canal || '', nv.guia || '', fmtMoney(montoDe(nv)), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : 'N/A']);
      xlsxHeaders = ['NV', 'Cliente', 'Vendedor', 'Canal', 'Guia', 'Monto', 'Fecha compromiso'];
      xlsxRows = list.map((nv) => [nv.nvNumero, nv.cliente, nv.vendedor, nv.canal, nv.guia || '', Math.round(montoDe(nv)), nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : '']);
    } else if (detalleActivo.tipo === 'quiebre') {
      // Formato planilla: una fila por cada producto con quiebre de cada
      // NV (si una NV tiene varios productos con quiebre, se repite una vez
      // por producto) — reemplaza al antiguo "Exportar productos con
      // quiebre (Comex)".
      const filas = computeQuiebreDetalle(pool.conQuiebre);
      titulo = 'Con quiebre de stock';
      exportName = 'nv_quiebre_stock';
      totalCount = filas.length;
      headers = ['NV', 'Cliente', 'Código', 'Producto', 'Cantidad', 'Valor'];
      rows = filas.slice(0, 300).map((f) => [f.nvNumero, f.cliente, f.codProd, f.detProd, f.cant, fmtMoney(f.montoLinea)]);
      xlsxHeaders = ['NV', 'Cliente', 'Código', 'Producto', 'Cantidad', 'Valor'];
      xlsxRows = filas.map((f) => [f.nvNumero, f.cliente, f.codProd, f.detProd, f.cant, Math.round(f.montoLinea)]);
    } else {
      // Resto de las alertas de Zona 3 (Bloqueadas y los 5 cruces/alertas
      // nuevas): todas son listas simples de NV, mismo formato de tabla.
      const { bloqueadas, bloqueadasAtrasadas, quiebreAtrasadas } = computeAlertas(universo, pool.conQuiebre);
      const listasPorTipo = {
        bloqueadas,
        bloqueadasAtrasadas,
        quiebreAtrasadas,
        porVencer: computePorVencerSinCoordinar(universo),
        preparacionEstancada: computePreparacionEstancada(pool.enProcesoPreparacion),
        retiroMalMarcado: universo.filter((nv) => nv.retiroMalMarcado),
        lineasDuplicadas: computeLineasDuplicadas(universo),
      };
      const titulosPorTipo = {
        bloqueadas: 'Bloqueadas',
        bloqueadasAtrasadas: 'Bloqueada + atrasada',
        quiebreAtrasadas: 'Atrasada + quiebre de stock',
        porVencer: 'Por vencer sin coordinar',
        preparacionEstancada: 'Preparación estancada',
        retiroMalMarcado: 'Retiros mal marcados',
        lineasDuplicadas: 'NV con líneas duplicadas',
      };
      const list = listasPorTipo[detalleActivo.tipo] || [];
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
// = 0). Zonas: 1 "Entregado" (arriba-derecha), 2 "Cumplimiento en tiempo"
// (arriba-izquierda), 3 "Transporte" (abajo-izquierda), 4 "Top 10 clientes"
// (abajo-derecha) — mismo patrón de filtros/zona de detalle que "Notas de
// ventas vigentes".
// ---------------------------------------------------------------------------

function renderNotasConcluidas(el, nvRecords, contHodo) {
  const pad = (n) => String(n).padStart(2, '0');
  const toInputDateValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const hodoRecords = contHodo || [];

  let fechaModo = 'semana';
  let fechaRefDate = yesterday();
  let mesSeleccionado = { year: new Date().getFullYear(), month: new Date().getMonth() };
  let rangoInicio = new Date(Date.now() - 30 * 86400000);
  let rangoFin = new Date();
  let searchTerm = '';
  let filtrosAbiertos = true;
  let detalleActivo = null; // { tipo } | null
  let clientesAbierto = false; // desplegable del ranking financiero (Zona 4)
  let parcialesAbierto = false; // lista de clientes con entregas parciales (6 meses)
  let sinFacturarAbierto = false; // lista de NV con guía emitida pero sin facturar (6 meses)
  let transporteDetalleAbierto = false; // tabla patente x día (Cont_Hodo)

  el.innerHTML = `
    <div class="np-header">
      <h2>NV entregadas</h2>
      <p class="np-header-sub">NV concluidas, más las vigentes que ya tienen guía o factura y al menos una línea despachada.</p>
    </div>

    <div class="np-grid-2x2 np-grid-2x2--top-align">
      <div class="zone-box zone-box--entregado">
        <h3 class="np-canvas-title">Entregado</h3>
        <div id="nc-entregado"></div>
      </div>
      <div class="zone-box zone-box--tiempo">
        <h3 class="np-canvas-title">On-Time Delivery</h3>
        <div id="nc-tiempo"></div>
      </div>
      <div class="zone-box zone-box--transporte">
        <h3 class="np-canvas-title">Transporte</h3>
        <div id="nc-transporte"></div>
      </div>
      <div class="zone-box zone-box--clientes">
        <h3 class="np-canvas-title">Financiero — ranking de clientes (6 meses)</h3>
        <div id="nc-clientes"></div>
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

    const term = searchTerm.trim().toLowerCase();
    return nvRecords.filter((nv) => {
      // Concluida, o vigente con guía/factura y al menos una línea ya
      // despachada (Sal_X_Des = 0 en esa línea).
      const esConcluida = nv.nvEstado === 'C';
      const esVigenteEntregada = nv.nvEstado === 'A' && (nv.guia || nv.factura) && nv.items.some((it) => it.salXDes === 0);
      if (!esConcluida && !esVigenteEntregada) return false;
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
    const completa100 = universo.filter((nv) => nv.items.length > 0 && nv.items.every((it) => it.salXDes === 0));
    const completa100Set = new Set(completa100);
    const parcial = universo.filter((nv) => !completa100Set.has(nv));
    const aTiempo = universo.filter((nv) => nv.cumplimiento === 'A_TIEMPO');
    const atrasada = universo.filter((nv) => nv.cumplimiento === 'ATRASADO');
    const propia = universo.filter((nv) => (nv.patente || '').toString().trim());
    const externa = universo.filter((nv) => !(nv.patente || '').toString().trim());
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
          <span class="np-zona4-total-label">Total NV entregadas</span>
          <span class="np-zona4-total-value">${universo.length}</span>
          <span class="np-zona4-total-label">${totalUnidades.toLocaleString('es-CL')} unidades · ${fmtMoney(totalMonto)}</span>
        </div>
        <div class="np-zona4-total">
          <span class="np-zona4-total-label">Cumplimiento</span>
          <span class="np-zona4-total-value">${fmtPct(pctCumplimiento)}</span>
          <span class="np-zona4-total-label">NV entregadas al 100%</span>
        </div>
      </div>
      <div class="np-zona4-grid">
        <div class="kpi-card kpi-card--success">
          <div class="kpi-card-label">100% · NV</div>
          <div class="kpi-card-value">${pool.completa100.length}</div>
          <button class="pill-btn" id="nc-entregado100-toggle">${isDetalleActivo('entregado100') ? '▴ Ocultar' : '▾ Ver detalle'}</button>
        </div>
        <div class="kpi-card kpi-card--danger">
          <div class="kpi-card-label">&lt;100% · NV</div>
          <div class="kpi-card-value">${pool.parcial.length}</div>
          <button class="pill-btn" id="nc-entregadoParcial-toggle">${isDetalleActivo('entregadoParcial') ? '▴ Ocultar' : '▾ Ver detalle'}</button>
        </div>
        <div class="kpi-card kpi-card--success">
          <div class="kpi-card-label">100% · Monto</div>
          <div class="kpi-card-value">${fmtMoney(monto100)}</div>
        </div>
        <div class="kpi-card kpi-card--danger">
          <div class="kpi-card-label">&lt;100% · Monto</div>
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
        <div class="np-otd-hero-label">OTD — On-Time Delivery</div>
        <div class="np-otd-hero-value">${fmtPct(pctATiempo)}</div>
        <div class="np-otd-hero-formula">OTD (%) = (despachos a tiempo / total despachos) × 100</div>
        <div class="np-otd-hero-sub">${pool.aTiempo.length} a tiempo / ${universo.length} total</div>
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
        <div class="kpi-card">
          <div class="kpi-card-label">Tiempo promedio de entrega</div>
          <div class="kpi-card-value">${tiempoPromedio === null ? 'N/A' : `${(tiempoPromedio / (WORK_END - WORK_START)).toFixed(2)} días`}</div>
          <div class="kpi-card-sub">${tiempoPromedio === null ? '' : `${tiempoPromedio.toFixed(1)}h hábiles · `}creación → coordinación</div>
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

    const hodoEnRango = computeContHodoEnRango();
    const porPatente = new Map();
    hodoEnRango.forEach((r) => {
      if (!porPatente.has(r.patente)) porPatente.set(r.patente, { patente: r.patente, km: 0, nvEntregadas: 0, monto: 0 });
      const p = porPatente.get(r.patente);
      p.km += r.kmUso || 0;
      p.nvEntregadas += r.nvEntregadas || 0;
      p.monto += r.montoEntregado || 0;
    });
    const flota = [...porPatente.values()].sort((a, b) => b.km - a.km);
    const totalKm = flota.reduce((s, p) => s + p.km, 0);
    const totalNvHodo = flota.reduce((s, p) => s + p.nvEntregadas, 0);
    const eficienciaGlobal = totalKm > 0 ? totalNvHodo / totalKm : null;

    cont.innerHTML = `
      <div class="np-zona4-grid">
        <div class="kpi-card kpi-card--propia">
          <div class="kpi-card-label">Flota propia (patente) · NV</div>
          <div class="kpi-card-value">${pool.propia.length}</div>
        </div>
        <div class="kpi-card kpi-card--externa">
          <div class="kpi-card-label">Transporte externo · NV</div>
          <div class="kpi-card-value">${pool.externa.length}</div>
        </div>
        <div class="kpi-card kpi-card--propia">
          <div class="kpi-card-label">Flota propia · Monto</div>
          <div class="kpi-card-value">${fmtMoney(montoPropia)}</div>
        </div>
        <div class="kpi-card kpi-card--externa">
          <div class="kpi-card-label">Transporte externo · Monto</div>
          <div class="kpi-card-value">${fmtMoney(montoExterna)}</div>
        </div>
        <div class="kpi-card kpi-card--propia">
          <div class="kpi-card-label">Km recorridos (flota propia)</div>
          <div class="kpi-card-value">${totalKm.toLocaleString('es-CL')}</div>
        </div>
        <div class="kpi-card kpi-card--propia">
          <div class="kpi-card-label">Eficiencia (NV Hodo / km)</div>
          <div class="kpi-card-value">${eficienciaGlobal === null ? 'N/A' : eficienciaGlobal.toFixed(3)}</div>
        </div>
      </div>
      <p class="kpi-note">Km y "NV entregadas" de esta sección vienen de la bitácora Cont_Hodo (registro propio por patente/día) — es una fuente separada de las NV de Corte, así que sus conteos no tienen por qué coincidir exactamente con los de arriba.</p>
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
        r.patente,
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
          r.patente,
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

  /** Universo del ranking financiero: ventana fija de los últimos 6 meses,
   * independiente del filtro de fecha del panel (igual criterio "entregada"
   * que el resto del reporte, pero sin depender de fechaModo/searchTerm —
   * pedido explícito: este ranking no debe responder al filtro activo). */
  function computeUniversoFinanciero() {
    const fin = new Date();
    const inicio = new Date(fin);
    inicio.setMonth(inicio.getMonth() - 6);
    const range = { start: startOfDay(inicio), end: endOfDay(fin) };
    return nvRecords.filter((nv) => {
      const esConcluida = nv.nvEstado === 'C';
      const esVigenteEntregada = nv.nvEstado === 'A' && (nv.guia || nv.factura) && nv.items.some((it) => it.salXDes === 0);
      if (!esConcluida && !esVigenteEntregada) return false;
      return inRange(nv.fecCreacion, range);
    });
  }

  function computeTopClientes(universoFin) {
    const porCliente = new Map();
    universoFin.forEach((nv) => {
      const cliente = nv.cliente || 'Cliente no especificado';
      if (!porCliente.has(cliente)) porCliente.set(cliente, { cliente, monto: 0, count: 0, aTiempo: 0, atrasado: 0, vendedores: new Set() });
      const c = porCliente.get(cliente);
      c.monto += nv.valorDespacho || 0;
      c.count += 1;
      if (nv.cumplimiento === 'A_TIEMPO') c.aTiempo += 1;
      else if (nv.cumplimiento === 'ATRASADO') c.atrasado += 1;
      if (nv.vendedor) c.vendedores.add(nv.vendedor);
    });
    const todos = [...porCliente.values()]
      .map((c) => {
        const denom = c.aTiempo + c.atrasado;
        return {
          ...c,
          otd: denom > 0 ? (c.aTiempo / denom) * 100 : null,
          vendedoresTxt: [...c.vendedores].join(', ') || 'Sin vendedor',
        };
      })
      .sort((a, b) => b.monto - a.monto);
    return { todos, top10: todos.slice(0, 10) };
  }

  function renderZonaClientes() {
    const cont = document.getElementById('nc-clientes');
    if (!cont) return;
    const universoFin = computeUniversoFinanciero();
    const { todos, top10 } = computeTopClientes(universoFin);

    if (todos.length === 0) {
      cont.innerHTML = '<p class="kpi-empty">No hay datos en los últimos 6 meses.</p>';
      return;
    }

    const poolFin = computePool(universoFin);
    const totalMonto = todos.reduce((s, c) => s + c.monto, 0);
    const top10Monto = top10.reduce((s, c) => s + c.monto, 0);
    const concentracion = totalMonto > 0 ? (top10Monto / totalMonto) * 100 : 0;
    const ticketPromedio = universoFin.length > 0 ? totalMonto / universoFin.length : 0;

    const parcialesPorCliente = new Map();
    poolFin.parcial.forEach((nv) => {
      const cliente = nv.cliente || 'Cliente no especificado';
      parcialesPorCliente.set(cliente, (parcialesPorCliente.get(cliente) || 0) + 1);
    });
    const parcialesList = [...parcialesPorCliente.entries()].sort((a, b) => b[1] - a[1]);

    // NV con guía emitida (ya despachada) pero sin factura asociada todavía
    // — backlog de facturación, útil para el área financiera.
    const sinFacturarConGuia = universoFin.filter((nv) => nv.guia && !nv.factura);

    cont.innerHTML = `
      <p class="kpi-note">Ranking de los últimos 6 meses — independiente del filtro de fecha del panel.</p>
      <div class="np-zona4-grid">
        <div class="kpi-card">
          <div class="kpi-card-label">Ticket promedio por NV</div>
          <div class="kpi-card-value">${fmtMoney(ticketPromedio)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-card-label">Concentración de cartera (top 10)</div>
          <div class="kpi-card-value">${fmtPct(concentracion)}</div>
          <div class="kpi-card-sub">del monto entregado en 6 meses</div>
        </div>
        <div class="kpi-card kpi-card--warn">
          <div class="kpi-card-label">Con guía sin facturar</div>
          <div class="kpi-card-value">${sinFacturarConGuia.length}</div>
          <div class="kpi-card-sub">NV con guía emitida y sin factura</div>
        </div>
      </div>
      <button class="pill-btn" id="nc-clientes-toggle">${clientesAbierto ? '▴ Ocultar ranking' : `▾ Ver ranking top 10 (${top10.length} clientes)`}</button>
      <div id="nc-clientes-ranking" class="${clientesAbierto ? '' : 'hidden'}"></div>
      ${
        parcialesList.length > 0
          ? `<button class="pill-btn" id="nc-parciales-toggle">${
              parcialesAbierto ? '▴ Ocultar clientes con entregas parciales' : `▾ Clientes con entregas parciales (${parcialesList.length})`
            }</button>
      <div id="nc-parciales-list" class="${parcialesAbierto ? '' : 'hidden'}"></div>`
          : ''
      }
      ${
        sinFacturarConGuia.length > 0
          ? `<button class="pill-btn" id="nc-sinfacturar-toggle">${
              sinFacturarAbierto ? '▴ Ocultar NV con guía sin facturar' : `▾ Ver NV con guía sin facturar (${sinFacturarConGuia.length})`
            }</button>
      <div id="nc-sinfacturar-list" class="${sinFacturarAbierto ? '' : 'hidden'}"></div>`
          : ''
      }
    `;

    if (clientesAbierto) {
      const rankingCont = document.getElementById('nc-clientes-ranking');
      if (rankingCont) {
        rankingCont.innerHTML = `
          <button class="pill-btn" id="nc-clientes-export">⬇ Exportar Excel</button>
          ${tableHtml(
            ['#', 'Cliente', 'Monto entregado', 'Participación %', 'OTD', 'NV', 'Vendedores'],
            top10.map((c, i) => [
              i + 1,
              c.cliente,
              fmtMoney(c.monto),
              fmtPct(totalMonto > 0 ? (c.monto / totalMonto) * 100 : 0),
              c.otd === null ? 'N/A' : fmtPct(c.otd),
              c.count,
              c.vendedoresTxt,
            ])
          )}
        `;
        document.getElementById('nc-clientes-export')?.addEventListener('click', (e) => {
          const xlsxRows = top10.map((c, i) => [
            i + 1,
            c.cliente,
            Math.round(c.monto),
            totalMonto > 0 ? Math.round((c.monto / totalMonto) * 1000) / 10 : 0,
            c.otd === null ? '' : Math.round(c.otd * 10) / 10,
            c.count,
            c.vendedoresTxt,
          ]);
          downloadXlsx(
            `ranking_clientes_6meses_${new Date().toISOString().slice(0, 10)}.xlsx`,
            ['#', 'Cliente', 'Monto entregado', 'Participación %', 'OTD %', 'NV', 'Vendedores'],
            xlsxRows
          );
          flashExportFeedback(e.currentTarget);
        });
      }
    }
    if (parcialesAbierto) {
      const parcialesCont = document.getElementById('nc-parciales-list');
      if (parcialesCont) {
        parcialesCont.innerHTML = tableHtml(
          ['Cliente', 'NV con entrega parcial'],
          parcialesList.map(([cliente, n]) => [cliente, n])
        );
      }
    }
    if (sinFacturarAbierto) {
      const sinFacturarCont = document.getElementById('nc-sinfacturar-list');
      if (sinFacturarCont) {
        sinFacturarCont.innerHTML = tableHtml(
          ['NV', 'Cliente', 'Guía', 'Monto', 'Fecha creación'],
          sinFacturarConGuia.map((nv) => [
            nv.nvNumero,
            nv.cliente,
            nv.guia || '',
            fmtMoney(nv.valorDespacho || nv.montoTotal),
            nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : '',
          ])
        );
      }
    }

    document.getElementById('nc-clientes-toggle')?.addEventListener('click', () => {
      clientesAbierto = !clientesAbierto;
      renderZonaClientes();
    });
    document.getElementById('nc-parciales-toggle')?.addEventListener('click', () => {
      parcialesAbierto = !parcialesAbierto;
      renderZonaClientes();
    });
    document.getElementById('nc-sinfacturar-toggle')?.addEventListener('click', () => {
      sinFacturarAbierto = !sinFacturarAbierto;
      renderZonaClientes();
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
      entregado100: 'Entregadas al 100%',
      entregadoParcial: 'Entregadas parcialmente (menos del 100%)',
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
    renderZonaClientes();
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

