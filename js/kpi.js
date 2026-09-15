// kpi.js
// Cálculo de los indicadores de gerencia y render de cada sección
// (tarjetas + tablas + gráficos) en el panel principal del módulo KPI.

import { startOfDay, endOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from './businessDates.js';

const fmtMoney = (v) => '$' + Math.round(v || 0).toLocaleString('es-CL');
const fmtPct = (v) => (v === null || isNaN(v) ? 'N/A' : Math.round(v * 10) / 10 + '%');

// ---------------------------------------------------------------------------
// Paleta apta para daltonismo (Okabe-Ito), azul príncipe como color primario
// (pedido explícito: evitar combinaciones rojo/verde, que son las más
// problemáticas para las formas más comunes de daltonismo).
// ---------------------------------------------------------------------------
const PALETTE = {
  primary: '#0B4F9C',   // azul príncipe (color principal de los gráficos)
  primaryLight: '#56B4E9', // celeste
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
  if (mode === 'semana') return { start: startOfWeek(refDate), end: endOfWeek(refDate) };
  if (mode === 'mes') return { start: startOfMonth(refDate), end: endOfMonth(refDate) };
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

  // ---- 0. Alertas de despacho (SLA 48h) ----
  // Bloque A: NO depende del rango de fechas seleccionado — es "lo que está
  // atrasado ahora mismo", no una foto histórica del período.
  const ahora = new Date();
  const noDespachadasAtrasadas = nvRecords
    .filter((nv) => !nv.esRetiro && nv.cumplimiento === 'SIN_COORDINAR')
    .map((nv) => ({ ...nv, horasAtraso: (ahora - nv.fechaCompromiso) / 3600000 }))
    .sort((a, b) => b.horasAtraso - a.horasAtraso);

  // Bloque B: lo efectivamente despachado en el período, por canal — sí
  // respeta el rango (usa nvEnRango, ya filtrado por F_coordinacion).
  const despachadoPorCanal = groupSumCountClientes(
    nvEnRango,
    (nv) => nv.tipoMovimiento || nv.canal || 'Sin canal',
    (nv) => nv.montoDespachado
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
    alertas: { noDespachadasAtrasadas, despachadoPorCanal },
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

function groupSumCountClientes(list, keyFn, montoFn) {
  const map = new Map();
  list.forEach((item) => {
    const key = keyFn(item) || 'Sin dato';
    if (!map.has(key)) map.set(key, { nombre: key, count: 0, monto: 0, clientesSet: new Set() });
    const g = map.get(key);
    g.count += 1;
    g.monto += montoFn(item) || 0;
    g.clientesSet.add(item.cliente);
  });
  return [...map.values()]
    .map((g) => ({ nombre: g.nombre, count: g.count, monto: g.monto, clientes: g.clientesSet.size }))
    .sort((a, b) => b.monto - a.monto);
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

// ---------------------------------------------------------------------------
// Render de secciones
// ---------------------------------------------------------------------------

const SECTIONS = [
  { id: 'alertas', label: 'Alertas de despacho (SLA 48h)' },
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

export function renderKpiSection(sectionId, kpis) {
  const el = document.getElementById('kpi-panel');
  if (!el) return;

  switch (sectionId) {
    case 'alertas':
      renderAlertas(el, kpis.alertas);
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
// 0. Alertas de despacho (SLA 48h) — bloque A (no depende del período) +
//    bloque B (despachado por canal, sí depende del período)
// ---------------------------------------------------------------------------

function renderAlertas(el, data) {
  const totalAtrasadas = data.noDespachadasAtrasadas.length;
  const montoEnRiesgo = data.noDespachadasAtrasadas.reduce((s, nv) => s + nv.montoTotal, 0);

  el.innerHTML = `
    <h2>Alertas de despacho — SLA 48 horas hábiles</h2>
    <p class="kpi-note">Este bloque NO depende del selector Día/Semana/Mes: muestra el estado actual, no un histórico.</p>
    <div class="kpi-card-row">
      ${kpiCard('NV sin despachar y atrasadas', totalAtrasadas, fmtMoney(montoEnRiesgo) + ' en riesgo')}
    </div>
    <h3>NV que incumplen las 48 horas hábiles</h3>
    <button id="export-alertas" class="btn-export">⬇️ Exportar CSV</button>
    ${tableHtml(
      ['NV', 'Cliente', 'Vendedor', 'Canal', 'Tipo', 'F. creación', 'F. compromiso', 'Horas de atraso'],
      data.noDespachadasAtrasadas.slice(0, 200).map((nv) => [
        nv.nvNumero,
        nv.cliente,
        nv.vendedor,
        nv.canal || '',
        nv.tipoMovimiento || '',
        nv.fecCreacion ? nv.fecCreacion.toLocaleString('es-CL') : 'N/A',
        nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleString('es-CL') : 'N/A',
        Math.round(nv.horasAtraso) + ' h',
      ])
    )}

    <h3>Despachado en el período, por canal</h3>
    <p class="kpi-note">Este bloque sí respeta el selector Día/Semana/Mes de arriba.</p>
    <div class="chart-box"><canvas id="chart-alertas-canal"></canvas></div>
    ${tableHtml(
      ['Canal', 'N° de NV', 'N° de clientes', 'Monto'],
      data.despachadoPorCanal.map((c) => [c.nombre, c.count, c.clientes, fmtMoney(c.monto)])
    )}
  `;

  drawChart('chart-alertas-canal', {
    type: 'bar',
    data: {
      labels: data.despachadoPorCanal.map((c) => c.nombre),
      datasets: [
        { label: 'Monto despachado', data: data.despachadoPorCanal.map((c) => c.monto), backgroundColor: PALETTE.primary },
      ],
    },
    options: { plugins: { legend: { display: false } } },
  });

  document.getElementById('export-alertas')?.addEventListener('click', () => {
    downloadCsv(
      `alertas_despacho_${new Date().toISOString().slice(0, 10)}.csv`,
      ['NV', 'Cliente', 'Vendedor', 'Canal', 'Tipo', 'Fecha creacion', 'Fecha compromiso', 'Horas de atraso', 'Monto'],
      data.noDespachadasAtrasadas.map((nv) => [
        nv.nvNumero,
        nv.cliente,
        nv.vendedor,
        nv.canal,
        nv.tipoMovimiento,
        nv.fecCreacion ? nv.fecCreacion.toLocaleString('es-CL') : '',
        nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleString('es-CL') : '',
        Math.round(nv.horasAtraso),
        Math.round(nv.montoTotal),
      ])
    );
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

