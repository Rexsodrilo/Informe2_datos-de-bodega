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
  // "Semana" y "Mes" son ventanas fijas relativas a hoy (no navegables con el
  // selector de fecha): últimos 5 días hábiles, y el mes calendario anterior.
  // Solo "Día" usa la fecha elegida (refDate). El modo "rango" se resuelve
  // aparte, en main.js, con el control de barra arrastrable.
  if (mode === 'semana') return lastBusinessDaysRange(5);
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
  { id: 'notasPendientes', label: 'Notas de venta pendientes' },
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

const NP_TITULOS = {
  despachado: 'Entregadas (pendiente de rebaja en sistema)',
  parcial: 'Entrega parcial',
  vacio: 'Sin entregar',
};

function renderNotasPendientes(el, nvRecords) {
  let bloqueadoActivo = 'todos'; // 'todos' | 'S' | 'N'
  let entregaActiva = 'todos'; // 'todos' | 'RETIRA' | 'DESPACHO'
  let fechaModo = 'semana'; // 'dia' | 'semana' | 'mes' — mismas reglas ya definidas en getDateRange
  const fechaRefDate = yesterday(); // solo se usa si fechaModo === 'dia'
  let tablaAbierta = false; // la tabla de detalle parte cerrada, para no enterrar las tortas de abajo
  const detalleAbierto = { despachado: false, parcial: false, vacio: false };

  el.innerHTML = `
    <div class="np-header">
      <h2>Notas de venta pendientes</h2>
      <p class="kpi-note">Todas las NV en estado A: aprobadas por el área comercial, pendientes de que logística las procese. No es sinónimo de "atrasada" — el atraso es una condición dentro de este universo, no lo que lo define.</p>
    </div>

    <div class="np-filtros">
      <div class="kpi-filter-group">
        <span class="kpi-filter-label">Bloqueado (Finanzas)</span>
        <div class="kpi-filter-buttons" id="np-filtro-bloqueado">
          <button class="btn-toggle active" data-value="todos">Todos</button>
          <button class="btn-toggle" data-value="S">Bloqueado</button>
          <button class="btn-toggle" data-value="N">No bloqueado</button>
        </div>
      </div>
      <div class="kpi-filter-group">
        <span class="kpi-filter-label">Tipo de entrega</span>
        <div class="kpi-filter-buttons" id="np-filtro-entrega">
          <button class="btn-toggle active" data-value="todos">Todos</button>
          <button class="btn-toggle" data-value="RETIRA">Retira</button>
          <button class="btn-toggle" data-value="DESPACHO">Despacho</button>
        </div>
      </div>
      <div class="kpi-filter-group">
        <span class="kpi-filter-label">Fecha (creación)</span>
        <div class="kpi-filter-buttons" id="np-filtro-fecha">
          <button class="btn-toggle" data-value="dia">Día</button>
          <button class="btn-toggle active" data-value="semana">Semana</button>
          <button class="btn-toggle" data-value="mes">Mes</button>
        </div>
        <span class="kpi-range-label" id="np-fecha-label"></span>
      </div>
    </div>

    <div id="np-tabla"></div>

    <h3>Estado de despacho — notas de venta pendientes</h3>
    <p class="kpi-note">Cada torta agrupa por Canal (Canal_EN). El caso "Despachado" con inventario incompleto no aparece en ninguna de las 3 — su detalle vive en Fill Rate, dentro de "Calidad de despacho".</p>
    <div class="np-pie-row" id="np-pie-row"></div>
    <div id="np-detalle-panel"></div>
  `;

  function computeUniverso() {
    const range = getDateRange(fechaRefDate, fechaModo);
    const label = document.getElementById('np-fecha-label');
    if (label) {
      label.textContent =
        range.start.toLocaleDateString('es-CL') === range.end.toLocaleDateString('es-CL')
          ? range.start.toLocaleDateString('es-CL')
          : `${range.start.toLocaleDateString('es-CL')} – ${range.end.toLocaleDateString('es-CL')}`;
    }
    return nvRecords.filter((nv) => {
      if (nv.nvEstado !== 'A') return false;
      if (bloqueadoActivo !== 'todos' && (nv.bloqueado ? 'S' : 'N') !== bloqueadoActivo) return false;
      if (entregaActiva !== 'todos' && nv.entrega !== entregaActiva) return false;
      if (!inRange(nv.fecCreacion, range)) return false;
      return true;
    });
  }

  function renderTabla(universo) {
    const ahora = new Date();
    const horasHabilesPorDia = WORK_END - WORK_START;
    const filas = universo
      .map((nv) => ({ ...nv, diasAtrasoHabiles: businessHoursElapsed(nv.fechaCompromiso, ahora) / horasHabilesPorDia }))
      .sort((a, b) => b.diasAtrasoHabiles - a.diasAtrasoHabiles);

    document.getElementById('np-tabla').innerHTML = `
      <div class="kpi-card-row">
        ${kpiCard('NV pendientes (estado A)', filas.length, fmtMoney(filas.reduce((s, nv) => s + nv.montoTotal, 0)))}
      </div>
      <div class="np-tabla-acciones">
        <button id="np-toggle-tabla" class="btn-export">${tablaAbierta ? '▴ Ocultar detalle' : '▾ Ver detalle'}</button>
        <button id="np-export-tabla" class="btn-export">⬇️ Exportar Excel</button>
      </div>
      ${
        tablaAbierta
          ? tableHtml(
              ['NV', 'Cliente', 'Vendedor', 'Canal', 'Bloqueado', 'Entrega', 'Fecha<br>Creación', 'Días de atraso hábiles', 'Status'],
              filas.slice(0, 300).map((nv) => [
                nv.nvNumero,
                nv.cliente,
                nv.vendedor,
                nv.canal || '',
                nv.bloqueado ? 'Sí' : 'No',
                nv.entrega || '',
                nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : 'N/A',
                Math.round(nv.diasAtrasoHabiles * 10) / 10,
                nv.statusDes || '(vacío)',
              ])
            )
          : ''
      }
    `;

    document.getElementById('np-toggle-tabla')?.addEventListener('click', () => {
      tablaAbierta = !tablaAbierta;
      renderTabla(universo);
    });

    document.getElementById('np-export-tabla')?.addEventListener('click', () => {
      downloadXlsx(
        `notas_pendientes_${new Date().toISOString().slice(0, 10)}.xlsx`,
        ['NV', 'Cliente', 'Vendedor', 'Canal', 'Bloqueado', 'Entrega', 'Fecha creacion', 'Fecha compromiso', 'Dias de atraso habiles', 'Status', 'Monto'],
        filas.map((nv) => [
          nv.nvNumero,
          nv.cliente,
          nv.vendedor,
          nv.canal,
          nv.bloqueado ? 'Si' : 'No',
          nv.entrega,
          nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : '',
          nv.fechaCompromiso ? nv.fechaCompromiso.toLocaleDateString('es-CL') : '',
          Math.round(nv.diasAtrasoHabiles * 10) / 10,
          nv.statusDes || '',
          Math.round(nv.montoTotal),
        ])
      );
    });
  }

  function buildPieGroup(list) {
    const map = new Map();
    list.forEach((nv) => {
      const key = nv.canal || 'Sin canal';
      if (!map.has(key)) map.set(key, { count: 0, monto: 0 });
      const g = map.get(key);
      g.count += 1;
      g.monto += nv.montoTotal || 0;
    });
    const entries = [...map.entries()].sort((a, b) => b[1].count - a[1].count);
    return {
      labels: entries.map(([k]) => k),
      counts: entries.map(([, v]) => v.count),
      montos: entries.map(([, v]) => v.monto),
      totalCount: list.length,
      totalMonto: list.reduce((s, nv) => s + (nv.montoTotal || 0), 0),
    };
  }

  function pieCardHtml(id) {
    return `
      <div class="np-pie-card">
        <h4>${NP_TITULOS[id]}</h4>
        <div class="chart-box np-pie-chart"><canvas id="chart-np-${id}"></canvas></div>
        <div class="np-pie-totales" id="np-totales-${id}"></div>
        <button class="btn-export np-detalle-btn" data-id="${id}">Detalle</button>
      </div>
    `;
  }

  function renderPies(universo) {
    const esCompleto = (nv) => nv.items.length > 0 && nv.items.every((it) => (it.inFull || 0) >= 0.999);
    const pool = {
      despachado: universo.filter((nv) => nv.statusDes === 'DESPACHADO' && esCompleto(nv)),
      parcial: universo.filter((nv) => nv.statusDes === 'ENT_PARCIAL'),
      vacio: universo.filter((nv) => !nv.statusDes),
    };

    document.getElementById('np-pie-row').innerHTML = Object.keys(pool).map(pieCardHtml).join('');

    Object.keys(pool).forEach((id) => {
      const g = buildPieGroup(pool[id]);
      document.getElementById(`np-totales-${id}`).innerHTML = `<strong>${g.totalCount}</strong> NV · <strong>${fmtMoney(g.totalMonto)}</strong>`;

      drawChart(`chart-np-${id}`, {
        type: 'pie',
        data: { labels: g.labels, datasets: [{ data: g.counts, backgroundColor: PALETTE.series }] },
        options: {
          plugins: {
            legend: { position: 'bottom' },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const i = ctx.dataIndex;
                  const pct = g.totalCount > 0 ? Math.round((g.counts[i] / g.totalCount) * 1000) / 10 : 0;
                  return `${ctx.label}: ${pct}% · ${g.counts[i]} NV · ${fmtMoney(g.montos[i])}`;
                },
              },
            },
          },
        },
      });
    });

    document.querySelectorAll('.np-detalle-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        detalleAbierto[btn.dataset.id] = !detalleAbierto[btn.dataset.id];
        renderDetallePanel(pool);
      });
    });

    renderDetallePanel(pool);
  }

  function renderDetallePanel(pool) {
    const panel = document.getElementById('np-detalle-panel');
    const abiertos = Object.keys(detalleAbierto).filter((id) => detalleAbierto[id]);
    if (abiertos.length === 0) {
      panel.innerHTML = '';
      return;
    }

    panel.innerHTML = abiertos
      .map(
        (id) => `
      <h3>Detalle — ${NP_TITULOS[id]}</h3>
      <button class="btn-export" id="np-export-${id}">⬇️ Exportar Excel</button>
      ${tableHtml(
        ['NV', 'Cliente', 'Vendedor', 'Canal', 'Monto', 'Fecha<br>Creación'],
        pool[id]
          .slice(0, 300)
          .map((nv) => [
            nv.nvNumero,
            nv.cliente,
            nv.vendedor,
            nv.canal || '',
            fmtMoney(nv.montoTotal),
            nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : 'N/A',
          ])
      )}
    `
      )
      .join('');

    abiertos.forEach((id) => {
      document.getElementById(`np-export-${id}`)?.addEventListener('click', () => {
        downloadXlsx(
          `notas_pendientes_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`,
          ['NV', 'Cliente', 'Vendedor', 'Canal', 'Monto', 'Fecha creacion'],
          pool[id].map((nv) => [
            nv.nvNumero,
            nv.cliente,
            nv.vendedor,
            nv.canal,
            Math.round(nv.montoTotal),
            nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : '',
          ])
        );
      });
    });
  }

  function renderAll() {
    const universo = computeUniverso();
    renderTabla(universo);
    renderPies(universo);
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

  renderAll();
  wireButtonGroup('np-filtro-bloqueado', (v) => (bloqueadoActivo = v));
  wireButtonGroup('np-filtro-entrega', (v) => (entregaActiva = v));
  wireButtonGroup('np-filtro-fecha', (v) => (fechaModo = v));
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

