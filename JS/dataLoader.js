// dataLoader.js
// Lee el workbook (SheetJS) y normaliza las hojas Corte, Desp y Cont_Hodo a
// una estructura común de datos que el resto de la app (Kanban, KPI, Detalle)
// puede consumir sin preocuparse por nombres de columna, posición de la fila
// de encabezado, ni por si viene de Corte o de Desp.
//
// IMPORTANTE (detectado al comparar el archivo de prueba .xlsx contra el
// archivo real .xlsm con macro): la fila donde empiezan los encabezados de
// una misma hoja puede NO ser siempre la misma — en el archivo de prueba
// "Desp" tenía sus encabezados en la fila 2 y sin columna "Estado"; en el
// archivo real están en la fila 1 y aparece una columna "Estado" nueva al
// inicio. Como la macro que actualiza "Desp" solo agrega filas al final,
// esto no debería volver a moverse, pero para no depender de una posición
// fija se detecta automáticamente la fila de encabezado de cada hoja
// buscando cuál fila contiene más columnas reconocibles (ver
// detectHeaderRow). La resolución de columnas sigue siendo por nombre
// (alias), no por letra de columna, así que una columna nueva o reordenada
// no rompe el mapeo mientras el nombre siga siendo reconocible.

import { computeCommitmentDate } from './businessDates.js';

function normalizeKey(k) {
  return k
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[áàä]/g, 'a')
    .replace(/[éèë]/g, 'e')
    .replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o')
    .replace(/[úùü]/g, 'u')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Indexa un objeto fila como lista de pares [claveNormalizada, valor]. */
function indexRow(row) {
  return Object.keys(row).map((k) => [normalizeKey(k), row[k]]);
}

function getField(rowIdx, aliases) {
  const normAliases = aliases.map(normalizeKey);
  // 1) match exacto
  for (const alias of normAliases) {
    const hit = rowIdx.find(([key]) => key === alias);
    if (hit && hit[1] !== undefined && hit[1] !== null && hit[1] !== '') return hit[1];
  }
  // 2) match por substring (encabezados largos tipo "N Interno Patente")
  for (const alias of normAliases) {
    const hit = rowIdx.find(([key]) => key.includes(alias));
    if (hit && hit[1] !== undefined && hit[1] !== null && hit[1] !== '') return hit[1];
  }
  return '';
}

/**
 * Detecta cuál de las primeras `maxScan` filas de una hoja es la fila de
 * encabezado real, buscando la que contenga más coincidencias con los
 * `signatureTokens` esperados para ese tipo de hoja.
 */
function detectHeaderRow(worksheet, signatureTokens, maxScan = 5) {
  const rows = window.XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    range: 0,
    defval: '',
    raw: false,
  });
  const normTokens = signatureTokens.map(normalizeKey);
  let bestRow = 0;
  let bestScore = -1;

  for (let i = 0; i < Math.min(maxScan, rows.length); i++) {
    const cells = rows[i].map((c) => normalizeKey(c));
    const score = normTokens.reduce(
      (acc, token) => acc + (cells.some((c) => c.includes(token)) ? 1 : 0),
      0
    );
    if (score > bestScore) {
      bestScore = score;
      bestRow = i;
    }
  }
  return bestRow;
}

function toNumber(val) {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  const cleaned = val.toString().replace(/[^0-9.-]+/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function toDate(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

/** Combina una fecha (solo día) con una hora (string "HH:mm" o Date) en un solo Date. */
function combineDateTime(dateVal, timeVal) {
  const d = toDate(dateVal);
  if (!d) return null;
  const result = new Date(d);
  if (timeVal instanceof Date) {
    result.setHours(timeVal.getHours(), timeVal.getMinutes(), timeVal.getSeconds(), 0);
  } else if (typeof timeVal === 'string' && timeVal.includes(':')) {
    const [h, m] = timeVal.split(':').map((n) => parseInt(n, 10));
    if (!isNaN(h)) result.setHours(h, isNaN(m) ? 0 : m, 0, 0);
  }
  return result;
}

function isYes(val) {
  if (!val) return false;
  const s = val.toString().trim().toUpperCase();
  return s === 'SI' || s === 'S' || s === '1' || s === 'TRUE';
}

/** En esta planilla, "0" se usa como placeholder de "sin asignar" en varios
 * campos (Patente, Chofer, OP_Picking) — se trata igual que vacío. */
function emptyIfZero(val) {
  const s = (val ?? '').toString().trim();
  return s === '0' ? '' : s;
}

// ---------------------------------------------------------------------------
// Lectura de hojas crudas
// ---------------------------------------------------------------------------

function sheetToRows(workbook, sheetName, signatureTokens) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) return { rows: [], headerRow: 0 };
  const headerRow = detectHeaderRow(ws, signatureTokens);
  const rows = window.XLSX.utils.sheet_to_json(ws, {
    defval: '',
    raw: false,
    range: headerRow,
  });
  return { rows: rows.map(indexRow), headerRow };
}

// ---------------------------------------------------------------------------
// Corte (línea a línea) -> agrupado por NV
// ---------------------------------------------------------------------------

const ALIASES = {
  nvNumero: ['NVNumero', 'nv numero', 'nv', 'n venta'],
  nvEstado: ['nvEstado', 'estado'],
  canal: ['Canal_EN', 'canal', 'tipo de cliente'],
  entrega: ['ENTREGA', 'entrega'],
  bloqueado: ['Bloqueado', 'bloqueado'],
  fecCre: ['Fec_Cre', 'fecha creacion', 'fechacreacion'],
  horCre: ['Hor_Cr', 'hora creacion', 'horacreacion'],
  nomAux: ['NomAux', 'nombre cliente', 'cliente'],
  venDes: ['VenDes', 'vendedor'],
  ordenCompra: ['O_C_Clien', 'orden de compra', 'oc'],
  codProd: ['CodProd', 'codigo'],
  detProd: ['DetProd', 'producto'],
  nvCant: ['nvCant', 'cantidad'],
  nvPrecio: ['nvPrecio', 'precio'],
  nvTotLinea: ['nvTotLinea', 'total linea'],
  stockDisp: ['Stock_Dis', 'stockdisponible', 'stock'],
  montoPendiente: ['BaseExte.Total Linea', 'baseexte total linea', 'total linea pendiente'],
  opPicking: ['OP_Picking', 'operador picking'],
  fCoordinacion: ['F_coordinacion', 'fecha coordinada', 'fechacoordinada'],
  horaCoor: ['Hora_Coor', 'hora coordinada'],
  conductor: ['Conductor', 'chofer'],
  trans: ['Trans', 'transportista'],
  guia: ['Guia', 'guia'],
  factu: ['Factu', 'factura'],
  statusDes: ['Status des', 'status_des'],
  inFull: ['in full', 'infull'],
};

const CORTE_SIGNATURE = ['nvestado', 'nvnumero', 'canal', 'nvtotlinea'];

function parseCorte(workbook) {
  const { rows } = sheetToRows(workbook, 'Corte', CORTE_SIGNATURE);
  const groups = new Map();

  rows.forEach((row) => {
    const nvEstado = getField(row, ALIASES.nvEstado).toString().toUpperCase().trim();
    if (nvEstado === 'N') return; // Nulo: excluido de todo el análisis
    const nvNumero = getField(row, ALIASES.nvNumero).toString().trim();
    if (!nvNumero) return;

    if (!groups.has(nvNumero)) {
      groups.set(nvNumero, {
        nvNumero,
        nvEstado,
        canal: getField(row, ALIASES.canal).toString().trim(),
        entrega: getField(row, ALIASES.entrega).toString().trim().toUpperCase(),
        bloqueado: getField(row, ALIASES.bloqueado).toString().trim().toUpperCase() === 'S',
        fecCre: toDate(getField(row, ALIASES.fecCre)),
        horCre: getField(row, ALIASES.horCre),
        nomAux: getField(row, ALIASES.nomAux).toString().trim() || 'Cliente no especificado',
        venDes: getField(row, ALIASES.venDes).toString().trim() || 'Sin vendedor',
        ordenCompra: getField(row, ALIASES.ordenCompra).toString().trim(),
        opPicking: emptyIfZero(getField(row, ALIASES.opPicking)),
        fCoordinacionCorte: toDate(getField(row, ALIASES.fCoordinacion)),
        horaCoorCorte: getField(row, ALIASES.horaCoor),
        conductor: getField(row, ALIASES.conductor).toString().trim(),
        trans: getField(row, ALIASES.trans).toString().trim(),
        statusDes: getField(row, ALIASES.statusDes).toString().trim().toUpperCase(),
        guia: emptyIfZero(getField(row, ALIASES.guia)),
        factura: emptyIfZero(getField(row, ALIASES.factu)),
        montoTotal: 0,
        montoDespachadoAcum: 0, // Σ (nvTotLinea - BaseExte.Total Linea) por línea
        inFullPonderadoAcum: 0, // acumula in_full * monto de línea
        items: [],
      });
    }

    const g = groups.get(nvNumero);
    const montoLinea = toNumber(getField(row, ALIASES.nvTotLinea));
    const montoPendienteLinea = toNumber(getField(row, ALIASES.montoPendiente));
    const inFull = parseFloat(getField(row, ALIASES.inFull)) || 0;
    const cant = toNumber(getField(row, ALIASES.nvCant));
    const stock = toNumber(getField(row, ALIASES.stockDisp));

    g.montoTotal += montoLinea;
    // Valor realmente despachado = total de la línea menos lo que aún está
    // pendiente por despachar (BaseExte.Total Linea). Se acota a >=0 por si
    // hay inconsistencias de datos (pendiente > total).
    g.montoDespachadoAcum += Math.max(0, montoLinea - montoPendienteLinea);
    g.inFullPonderadoAcum += inFull * montoLinea;
    g.items.push({
      codProd: getField(row, ALIASES.codProd).toString().trim(),
      detProd: getField(row, ALIASES.detProd).toString().trim(),
      cant,
      stock,
      montoLinea,
      quiebre: stock < cant,
    });
  });

  return groups;
}

// ---------------------------------------------------------------------------
// Desp (resumen por NV, encabezados en fila 2)
// ---------------------------------------------------------------------------

const DESP_ALIASES = {
  nv: ['NV', 'nv'],
  cliente: ['Cliente'],
  chofer: ['Chofer'],
  patente: ['Patente'],
  opPicking: ['OP_Picking'],
  auditor: ['Auditor'],
  fCrea: ['F_Crea'],
  fCom: ['F_COM'],
  fCoordinacion: ['F_coordinacion'],
  horaCoor: ['Hora_Coor'],
  diasEntrega: ['Dias_entreg'],
  itSol: ['it_sol'],
  itAt: ['it_at'],
  status: ['Status'],
};

const DESP_SIGNATURE = ['chofer', 'patente', 'status', 'auditor'];

function parseDesp(workbook) {
  const { rows } = sheetToRows(workbook, 'Desp', DESP_SIGNATURE);
  const byNv = new Map();

  rows.forEach((row) => {
    const nv = getField(row, DESP_ALIASES.nv).toString().trim();
    if (!nv) return;

    const fCoordVal = getField(row, DESP_ALIASES.fCoordinacion);
    const fCoord = toDate(fCoordVal);
    // Un valor "00:00:00" sin fecha real se interpreta como vacío.
    const fCoordEsValida = fCoord && fCoord.getFullYear() > 1990;

    byNv.set(nv, {
      nv,
      cliente: getField(row, DESP_ALIASES.cliente).toString().trim(),
      chofer: emptyIfZero(getField(row, DESP_ALIASES.chofer)),
      patente: emptyIfZero(getField(row, DESP_ALIASES.patente)),
      opPicking: emptyIfZero(getField(row, DESP_ALIASES.opPicking)),
      auditor: getField(row, DESP_ALIASES.auditor).toString().trim(),
      fCoordinacion: fCoordEsValida ? fCoord : null,
      horaCoor: getField(row, DESP_ALIASES.horaCoor),
      itSol: toNumber(getField(row, DESP_ALIASES.itSol)),
      itAt: toNumber(getField(row, DESP_ALIASES.itAt)),
      status: getField(row, DESP_ALIASES.status).toString().trim().toUpperCase(),
    });
  });

  return byNv;
}

// ---------------------------------------------------------------------------
// Cont_Hodo (bitácora diaria de kilometraje / entregas por vehículo)
// ---------------------------------------------------------------------------

const HODO_ALIASES = {
  fecha: ['Fecha'],
  patente: ['patente'],
  operador: ['operador', 'conductor'],
  usoDiario: ['uso diario'],
  montoEntregado: ['Columna1'],
  valorKm: ['valor kilometro'],
  tipoEquipo: ['tipo de equipo'],
};

const HODO_SIGNATURE = ['fecha', 'patente', 'operador', 'uso diario'];

function parseContHodo(workbook) {
  const { rows } = sheetToRows(workbook, 'Cont_Hodo', HODO_SIGNATURE);
  const records = [];

  rows.forEach((row) => {
    const fecha = toDate(getField(row, HODO_ALIASES.fecha));
    const patente = getField(row, HODO_ALIASES.patente).toString().trim();
    if (!fecha || !patente) return; // filas vacías/plantilla

    records.push({
      fecha,
      patente,
      operador: getField(row, HODO_ALIASES.operador).toString().trim(),
      tipoEquipo: getField(row, HODO_ALIASES.tipoEquipo).toString().trim(),
      kmUso: toNumber(getField(row, HODO_ALIASES.usoDiario)),
      montoEntregado: toNumber(getField(row, HODO_ALIASES.montoEntregado)),
    });
  });

  return records;
}

// ---------------------------------------------------------------------------
// Merge final: una fila por NV, con Corte + Desp + fecha compromiso
// ---------------------------------------------------------------------------

function mergeNvData(corteGroups, despByNv) {
  const result = [];

  corteGroups.forEach((c) => {
    const d = despByNv.get(c.nvNumero) || null;

    const fCreacionCompleta = combineDateTime(c.fecCre, c.horCre) || c.fecCre;
    const fechaCompromiso = fCreacionCompleta ? computeCommitmentDate(fCreacionCompleta) : null;

    // Desp es la fuente preferida para fecha/hora coordinada (según regla
    // acordada); si no está disponible, se cae a lo que trae Corte.
    const fCoordinacion = (d && d.fCoordinacion) || c.fCoordinacionCorte || null;

    const chofer = (d && d.chofer) || c.conductor;
    const patente = d && d.patente;
    const tienePatente = !!(patente && patente.toString().trim());

    // REGLA NUEVA: una NV marcada como "RETIRA" que sí tiene patente
    // asignada en Desp en realidad se despachó (no la retiró el cliente) —
    // es un caso de mal ingreso al revés del KPI 7. Se distingue:
    //   - esRetiroReal: retiro genuino (RETIRA y sin patente asignada).
    //   - retiroDebeDespacharse: dice "retira" pero tiene patente -> tratar
    //     como despacho para efectos de SLA y del filtro de canal.
    const marcadoComoRetira = c.entrega === 'RETIRA';
    const esRetiroReal = marcadoComoRetira && !tienePatente;
    const retiroDebeDespacharse = marcadoComoRetira && tienePatente;

    // KPI "Valor mínimo de despacho" ($300.000): solo aplica a NV cuyo tipo
    // de entrega es DESPACHO y cuyo canal (Canal_EN) también es DESPACHO.
    const esTipoDespacho = c.entrega === 'DESPACHO' || retiroDebeDespacharse;
    const esCanalDespacho = (c.canal || '').toUpperCase().includes('DESPACHO');
    const esBajoMonto =
      c.montoTotal < 300000 &&
      esTipoDespacho &&
      esCanalDespacho &&
      (c.nvEstado === 'C' || c.statusDes === 'DESPACHADO');

    // KPI 7: Desp marca "DESPACHADO" pero sin chofer/patente asignados ->
    // probable retiro mal registrado como despacho.
    const retiroMalMarcado = !!d && d.status === 'DESPACHADO' && !d.chofer && !d.patente;

    // Tipo de movimiento, para mostrar en rankings/detalle.
    let tipoMovimiento;
    if (retiroMalMarcado) tipoMovimiento = 'Retiro (posible mal ingreso)';
    else if (esRetiroReal) tipoMovimiento = 'Retiro';
    else if ((c.canal || '').toUpperCase().includes('ECOM')) tipoMovimiento = 'Ecommerce';
    else if ((c.canal || '').toUpperCase().includes('RETAIL')) tipoMovimiento = 'Retail';
    else if (esCanalDespacho) tipoMovimiento = 'Despacho';
    else tipoMovimiento = c.canal || 'Sin canal';

    // Cumplimiento de compromiso (excluye solo retiros genuinos).
    let cumplimiento = null; // 'A_TIEMPO' | 'ATRASADO' | 'SIN_COORDINAR' | null (n/a)
    if (!esRetiroReal && fechaCompromiso) {
      if (fCoordinacion) {
        cumplimiento = fCoordinacion <= fechaCompromiso ? 'A_TIEMPO' : 'ATRASADO';
      } else {
        cumplimiento = new Date() > fechaCompromiso ? 'SIN_COORDINAR' : null;
      }
    }

    const inFullPonderado = c.montoTotal > 0 ? c.inFullPonderadoAcum / c.montoTotal : null;

    result.push({
      nvNumero: c.nvNumero,
      nvEstado: c.nvEstado,
      canal: c.canal,
      entrega: c.entrega,
      esRetiro: esRetiroReal,
      retiroDebeDespacharse,
      tipoMovimiento,
      bloqueado: c.bloqueado,
      fecCreacion: fCreacionCompleta,
      fechaCompromiso,
      fCoordinacion,
      cliente: c.nomAux,
      vendedor: c.venDes,
      ordenCompra: c.ordenCompra,
      guia: c.guia,
      factura: c.factura,
      montoTotal: c.montoTotal,
      montoDespachado: c.montoDespachadoAcum,
      inFullPonderado,
      inFullPonderadoAcum: c.inFullPonderadoAcum,
      items: c.items,
      opPicking: (d && d.opPicking) || c.opPicking,
      auditor: d && d.auditor,
      chofer,
      patente,
      trans: c.trans,
      statusDes: c.statusDes,
      despStatus: d && d.status,
      itSol: d && d.itSol,
      itAt: d && d.itAt,
      esBajoMonto,
      retiroMalMarcado,
      cumplimiento,
    });
  });

  return result;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export function loadWorkbookFromArrayBuffer(arrayBuffer) {
  const workbook = window.XLSX.read(arrayBuffer, { type: 'array', cellDates: true });

  const corteGroups = parseCorte(workbook);
  const despByNv = parseDesp(workbook);
  const nvRecords = mergeNvData(corteGroups, despByNv);
  const contHodo = parseContHodo(workbook);

  return { nvRecords, contHodo, loadedAt: new Date() };
}
