// kpi.js
// Cálculo de los 8 indicadores de gerencia y render de cada sección
// (tarjetas + tablas + gráficos) en el panel principal del módulo KPI.

import { startOfDay, endOfDay, startOfWeek, endOfWeek } from './businessDates.js';

const fmtMoney = (v) => '$' + Math.round(v || 0).toLocaleString('es-CL');
const fmtPct = (v) => (v === null || isNaN(v) ? 'N/A' : Math.round(v * 10) / 10 + '%');

let chartInstances = {};

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
// Filtro de fecha (día / semana) sobre F_coordinacion
// ---------------------------------------------------------------------------

export function getDateRange(refDate, mode) {
  if (mode === 'semana') return { start: startOfWeek(refDate), end: endOfWeek(refDate) };
  return { start: startOfDay(refDate), end: endOfDay(refDate) };
}

function inRange(date, range) {
  if (!date) return false;
  return date >= range.start && date <= range.end;
}

// ---------------------------------------------------------------------------
// Cálculo de los 8 indicadores
// ---------------------------------------------------------------------------

export function computeKpis(nvRecords, contHodo, range) {
  // Universo base del período: NV cuya F_coordinacion cae en el rango.
  // Para "sin coordinar" (KPI 1) se usa la fecha compromiso, porque esas NV
  // aún no tienen F_coordinacion.
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

  // ---- 4. NV bajo $300.000 despachadas igual ----
  const nvBajoMonto = nvEnRango.filter((nv) => nv.esBajoMonto);
  const montoTotalDespachado = nvEnRango
    .filter((nv) => nv.nvEstado === 'C')
    .reduce((s, nv) => s + nv.montoTotal, 0);
  const pctBajoMonto =
    nvEnRango.filter((nv) => nv.nvEstado === 'C').length > 0
      ? (nvBajoMonto.length / nvEnRango.filter((nv) => nv.nvEstado === 'C').length) * 100
      : null;
  const bajoMontoPorVendedor = groupSumCount(nvBajoMonto, (nv) => nv.vendedor, (nv) => nv.montoTotal);

  // ---- 5. Ranking de clientes por facturación acumulada ----
  const concluidas = nvEnRango.filter((nv) => nv.nvEstado === 'C');
  const clientesMap = new Map();
  concluidas.forEach((nv) => {
    if (!clientesMap.has(nv.cliente)) {
      clientesMap.set(nv.cliente, { cliente: nv.cliente, monto: 0, vendedores: new Set() });
    }
    const c = clientesMap.get(nv.cliente);
    c.monto += nv.montoTotal;
    c.vendedores.add(nv.vendedor);
  });
  const rankingClientes = [...clientesMap.values()]
    .map((c) => ({ ...c, vendedores: [...c.vendedores].join(', '), bajoUmbral: c.monto < 300000 }))
    .sort((a, b) => b.monto - a.monto);

  // ---- 6. Ranking de operación ----
  const rankingPicking = groupSumCount(nvEnRango, (nv) => nv.opPicking || 'Sin asignar', (nv) => nv.montoTotal);
  const rankingTransportista = groupSumCount(nvEnRango, (nv) => nv.trans || nv.chofer || 'Sin asignar', (nv) => nv.montoTotal);
  const rankingAuditor = groupSumCount(nvEnRango, (nv) => nv.auditor || 'Sin asignar', (nv) => nv.montoTotal);

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

  return {
    cumplimiento: { aTiempo, atrasado, pctCumplimiento, sinCoordinar: nvAtrasadasSinCoordinar },
    fillRate: { fillRatePonderado, sumaMonto },
    quiebreStock: topQuiebres,
    bajoMonto: { nvBajoMonto, pctBajoMonto, montoTotalDespachado, bajoMontoPorVendedor },
    rankingClientes,
    rankingOperacion: { rankingPicking, rankingTransportista, rankingAuditor },
    retiro: { retirosMalMarcados, retiroPorVendedor },
    transporte,
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

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// ---------------------------------------------------------------------------
// Render de secciones
// ---------------------------------------------------------------------------

const SECTIONS = [
  { id: 'cumplimiento', label: 'Cumplimiento de despacho' },
  { id: 'calidad', label: 'Calidad de despacho (fill rate y quiebres)' },
  { id: 'norma300', label: 'Norma de $300.000' },
  { id: 'clientes', label: 'Ranking de clientes' },
  { id: 'operacion', label: 'Ranking de operación' },
  { id: 'retiros', label: 'Retiros mal marcados' },
  { id: 'transporte', label: 'Transporte diario' },
];

export function getSections() {
  return SECTIONS;
}

export function renderKpiSection(sectionId, kpis) {
  const el = document.getElementById('kpi-panel');
  if (!el) return;

  switch (sectionId) {
    case 'cumplimiento':
      renderCumplimiento(el, kpis.cumplimiento);
      break;
    case 'calidad':
      renderCalidad(el, kpis.fillRate, kpis.quiebreStock);
      break;
    case 'norma300':
      renderNorma300(el, kpis.bajoMonto);
      break;
    case 'clientes':
      renderClientes(el, kpis.rankingClientes);
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

function renderCumplimiento(el, data) {
  el.innerHTML = `
    <h2>Cumplimiento de compromiso de despacho</h2>
    <div class="kpi-card-row">
      ${kpiCard('% cumplimiento', fmtPct(data.pctCumplimiento), `${data.aTiempo} a tiempo / ${data.atrasado} atrasadas`)}
      ${kpiCard('Atrasadas sin coordinar', data.sinCoordinar.length, 'Requieren atención inmediata')}
    </div>
    <div class="chart-box"><canvas id="chart-cumplimiento"></canvas></div>
    <h3>NV atrasadas sin coordinar</h3>
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
      datasets: [{ data: [data.aTiempo, data.atrasado], backgroundColor: ['#16a34a', '#d9534f'] }],
    },
    options: { plugins: { legend: { position: 'bottom' } } },
  });
}

function renderCalidad(el, fillRate, quiebres) {
  el.innerHTML = `
    <h2>Calidad de despacho</h2>
    <div class="kpi-card-row">
      ${kpiCard('Fill rate ponderado por monto', fmtPct(fillRate.fillRatePonderado), fmtMoney(fillRate.sumaMonto) + ' facturados en el período')}
    </div>
    <h3>Top productos con quiebre de stock</h3>
    <div class="chart-box"><canvas id="chart-quiebres"></canvas></div>
    ${tableHtml(['Código', 'Producto', 'N° de ocurrencias'], quiebres.map((q) => [q.codProd, q.detProd, q.ocurrencias]))}
  `;
  drawChart('chart-quiebres', {
    type: 'bar',
    data: {
      labels: quiebres.map((q) => q.codProd || q.detProd),
      datasets: [{ label: 'Ocurrencias de quiebre', data: quiebres.map((q) => q.ocurrencias), backgroundColor: '#0284c7' }],
    },
    options: { indexAxis: 'y', plugins: { legend: { display: false } } },
  });
}

function renderNorma300(el, data) {
  el.innerHTML = `
    <h2>Norma de despacho mínimo ($300.000)</h2>
    <div class="kpi-card-row">
      ${kpiCard('NV bajo el mínimo despachadas', data.nvBajoMonto.length, fmtPct(data.pctBajoMonto) + ' de las NV concluidas')}
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

function renderClientes(el, ranking) {
  const top = ranking.slice(0, 15);
  el.innerHTML = `
    <h2>Ranking de clientes por facturación acumulada</h2>
    <div class="chart-box"><canvas id="chart-clientes"></canvas></div>
    ${tableHtml(
      ['Cliente', 'Monto acumulado', 'Vendedor(es)', ''],
      ranking
        .slice(0, 50)
        .map((c) => [c.cliente, fmtMoney(c.monto), c.vendedores, c.bajoUmbral ? '<span class="tag-warning">bajo $300.000</span>' : ''])
    )}
  `;
  drawChart('chart-clientes', {
    type: 'bar',
    data: {
      labels: top.map((c) => c.cliente),
      datasets: [{ label: 'Monto acumulado', data: top.map((c) => c.monto), backgroundColor: '#0284c7' }],
    },
    options: { indexAxis: 'y', plugins: { legend: { display: false } } },
  });
}

function renderOperacion(el, data) {
  el.innerHTML = `
    <h2>Ranking de operación</h2>
    <h3>Operadores de picking</h3>
    <div class="chart-box"><canvas id="chart-picking"></canvas></div>
    ${tableHtml(['Operador', 'N° NV atendidas', 'Monto total'], data.rankingPicking.map((r) => [r.nombre, r.count, fmtMoney(r.monto)]))}
    <h3>Transportistas</h3>
    ${tableHtml(['Transportista', 'N° NV atendidas', 'Monto total'], data.rankingTransportista.map((r) => [r.nombre, r.count, fmtMoney(r.monto)]))}
    <h3>Auditores</h3>
    ${tableHtml(['Auditor', 'N° NV atendidas', 'Monto total'], data.rankingAuditor.map((r) => [r.nombre, r.count, fmtMoney(r.monto)]))}
  `;
  const top = data.rankingPicking.slice(0, 10);
  drawChart('chart-picking', {
    type: 'bar',
    data: {
      labels: top.map((r) => r.nombre),
      datasets: [{ label: 'N° NV atendidas', data: top.map((r) => r.count), backgroundColor: '#16a34a' }],
    },
    options: { plugins: { legend: { display: false } } },
  });
}

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
        { label: 'Km recorridos', data: dias.map((d) => d.km), backgroundColor: '#64748b', yAxisID: 'y' },
        { label: 'N° NV', data: dias.map((d) => d.nv), backgroundColor: '#0284c7', yAxisID: 'y1' },
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
