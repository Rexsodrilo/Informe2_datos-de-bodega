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
  accentWarn: '#E69F00', // naranja (en vez de rojo, para "atrasado"/alerta)
  accentAlt: '#009E73',  // verde azulado (distinguible del naranja/azul)
  accentPurple: '#CC79A7',
  accentDark: '#333333',
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

  return {
    cumplimiento: { aTiempo, atrasado, pctCumplimiento, sinCoordinar: nvAtrasadasSinCoordinar },
    fillRate: { fillRatePonderado, sumaMonto },
    quiebreStock: topQuiebres,
    bajoMonto: { nvBajoMonto, pctBajoMonto, montoTotalDespachado, bajoMontoPorVendedor },
    rankingClientes,
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

// ---------------------------------------------------------------------------
// Render de secciones
// ---------------------------------------------------------------------------

const SECTIONS = [
  { id: 'cumplimiento', label: 'Cumplimiento de despacho' },
  { id: 'calidad', label: 'Calidad de despacho (fill rate y quiebres)' },
  { id: 'norma300', label: 'Valor MIN despacho' },
  { id: 'clientes', label: 'Ranking de clientes' },
  { id: 'operacion', label: 'Ranking de operación' },
  { id: 'retiros', label: 'Retiros mal marcados' },
  { id: 'transporte', label: 'Transporte diario' },
  { id: 'comex', label: 'Consolidado para Comex' },
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
    case 'comex':
      renderComex(el, kpis.comex);
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
// 2. Calidad
// ---------------------------------------------------------------------------

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
      datasets: [{ label: 'Ocurrencias de quiebre', data: quiebres.map((q) => q.ocurrencias), backgroundColor: PALETTE.primary }],
    },
    options: { indexAxis: 'y', plugins: { legend: { display: false } } },
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

function renderClientes(el, ranking) {
  const top = ranking.slice(0, 15);
  el.innerHTML = `
    <h2>Ranking de clientes</h2>
    <p class="kpi-note">Incluye NV concluidas y NV con guía o factura ya emitida. El monto es el valor realmente despachado (total de la NV menos lo pendiente por despachar). El tipo de movimiento indica si fue retiro, ecommerce, retail o despacho desde bodega.</p>
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
// 5. Ranking de operación (con segundo gráfico de líneas atendidas)
// ---------------------------------------------------------------------------

function renderOperacion(el, data) {
  el.innerHTML = `
    <h2>Ranking de operación</h2>
    <h3>Operadores de picking — N° de NV</h3>
    <div class="chart-box"><canvas id="chart-picking"></canvas></div>
    <h3>Operadores de picking — Líneas atendidas (it_at)</h3>
    <div class="chart-box"><canvas id="chart-lineas"></canvas></div>
    ${tableHtml(['Operador', 'N° NV atendidas', 'Monto total'], data.rankingPicking.map((r) => [r.nombre, r.count, fmtMoney(r.monto)]))}
    <h3>Transportistas</h3>
    ${tableHtml(['Transportista', 'N° NV atendidas', 'Monto total'], data.rankingTransportista.map((r) => [r.nombre, r.count, fmtMoney(r.monto)]))}
    <h3>Auditores</h3>
    ${tableHtml(['Auditor', 'N° NV atendidas', 'Monto total'], data.rankingAuditor.map((r) => [r.nombre, r.count, fmtMoney(r.monto)]))}
  `;
  const topNv = data.rankingPicking.slice(0, 10);
  drawChart('chart-picking', {
    type: 'bar',
    data: {
      labels: topNv.map((r) => r.nombre),
      datasets: [{ label: 'N° NV atendidas', data: topNv.map((r) => r.count), backgroundColor: PALETTE.primary }],
    },
    options: { plugins: { legend: { display: false } } },
  });

  const topLineas = data.lineasPorOperador.slice(0, 10);
  drawChart('chart-lineas', {
    type: 'line',
    data: {
      labels: topLineas.map((r) => r.nombre),
      datasets: [{
        label: 'Líneas atendidas (it_at)',
        data: topLineas.map((r) => r.valor),
        borderColor: PALETTE.accentAlt,
        backgroundColor: PALETTE.accentAlt,
        tension: 0.25,
      }],
    },
    options: { plugins: { legend: { display: false } } },
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

// ---------------------------------------------------------------------------
// 8. Consolidado para Comex
// ---------------------------------------------------------------------------

function renderComex(el, comex) {
  el.innerHTML = `
    <h2>Consolidado para Comex</h2>
    <p class="kpi-note">SKU que se repiten en varias NV pendientes de despacho, para priorizar embarques. No depende del filtro de fecha — es "lo que falta hoy".</p>
    <button id="export-comex" class="btn-export">⬇️ Exportar CSV</button>
    ${tableHtml(
      ['Código', 'Producto', 'N° de NV', 'Cantidad total', 'Monto a despachar'],
      comex.slice(0, 100).map((s) => [s.codProd, s.detProd, s.nvCount, s.cant, fmtMoney(s.monto)])
    )}
  `;
  document.getElementById('export-comex')?.addEventListener('click', () => {
    downloadCsv(
      `comex_consolidado_sku_${new Date().toISOString().slice(0, 10)}.csv`,
      ['Codigo', 'Producto', 'N NV', 'NV (detalle)', 'Cantidad total', 'Monto a despachar'],
      comex.map((s) => [s.codProd, s.detProd, s.nvCount, s.nvNumeros, s.cant, Math.round(s.monto)])
    );
  });
}
