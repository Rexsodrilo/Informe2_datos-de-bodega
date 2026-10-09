// control.js — panel privado (control.html). Pendiente de confirmar con el
// usuario si esto debe pasar a leer un data_privado.json.gz aparte; por
// ahora, para partir simple, lee el mismo data.json.gz público (sin paso de
// subida adicional) — ver conversación del 2026-10-09.
import { isControlUnlocked, tryUnlockControl } from './authControl.js?v=1';
import { fetchPublishedData } from './dataPublish.js?v=17';
import { esRetiroAmplio, esSinRastro, normalizarPatente, getDateRange } from './kpi.js?v=63';

function setupLogin() {
  const wrap = document.getElementById('control-login-wrap');
  const page = document.getElementById('control-page');
  const input = document.getElementById('control-password-input');
  const submit = document.getElementById('control-password-submit');
  const error = document.getElementById('control-password-error');

  function unlocked() {
    wrap.classList.add('hidden');
    page.classList.remove('hidden');
    renderContenido();
  }

  if (isControlUnlocked()) {
    unlocked();
    return;
  }

  input?.focus();
  submit?.addEventListener('click', async () => {
    const ok = await tryUnlockControl(input.value);
    if (ok) {
      error.textContent = '';
      unlocked();
    } else {
      error.textContent = 'Contraseña incorrecta.';
    }
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit.click();
  });
}

// Mismo criterio de "entregada" que usa kpi.js en NV entregadas
// Despacho/Retira (no exportado desde ahí — es una línea estable, igual se
// repite inline dentro de kpi.js en varios lugares).
function baseEntregadas(nv) {
  const esConcluida = nv.nvEstado === 'C';
  const esVigenteEntregada = nv.nvEstado === 'A' && (nv.guia || nv.factura) && nv.items.some((it) => it.salXDes === 0);
  return esConcluida || esVigenteEntregada;
}

function fmtMoney(n) {
  return (n || 0).toLocaleString('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 });
}

function auditorDe(nv) {
  return (nv.auditor || nv.auditorCorte || '').toString().trim().toLowerCase();
}

// "Universo Despacho" tal como lo cuenta la pestaña pública "NV entregadas
// Despacho" desde el 2026-10-09: entregada, no-retiro, y sin ser una NV "sin
// rastro" (ver esSinRastro en kpi.js) — esas se muestran aparte, más abajo.
function esDespachoUniverso(nv) {
  return baseEntregadas(nv) && !esRetiroAmplio(nv) && !esSinRastro(nv);
}

// "NV sin rastro": estado C sin ningún indicio de despacho real (sin
// chofer, patente, guía, factura, auditor ni OP_Picking). El usuario
// confirmó el 2026-10-09 que es un error de creación o una cancelación de
// pedido, no un despacho real, y que mientras no exista un tratamiento
// definitivo se deben ver aparte, acá, sin contarse en el panel público.
// `esSinRastro` ya trae su propia ventana fija de 15 días (ver kpi.js): sin
// eso, la condición coincidía con el 72% de todo el histórico (14.598 NV) —
// medido antes de aplicarse, ver Reglas de negocio y su ubicación.
function computeNvSinRastro(nvRecords) {
  return nvRecords
    .filter((nv) => esSinRastro(nv))
    .slice()
    .sort((a, b) => (b.fecCreacion?.getTime() || 0) - (a.fecCreacion?.getTime() || 0));
}

// "Retira atrasadas con stock": dentro del universo Retira (mismo criterio
// que la pestaña NV entregadas Retira), las que tienen fecha compromiso
// vencida en los últimos 15 días (igual que la alerta "Atrasadas" de NV por
// entregar) Y alguna línea pendiente con stock disponible al corte — o sea,
// no es falta de inventario lo que las tiene atrasadas.
function computeRetiraAtrasadasConStock(nvRecords) {
  const fin = new Date();
  fin.setHours(23, 59, 59, 999);
  const inicio = new Date();
  inicio.setDate(inicio.getDate() - 14);
  inicio.setHours(0, 0, 0, 0);

  const universoRetira = nvRecords.filter((nv) => baseEntregadas(nv) && esRetiroAmplio(nv));
  const atrasadas = universoRetira.filter((nv) => {
    if (!nv.fechaCompromiso || nv.fechaCompromiso < inicio || nv.fechaCompromiso > fin) return false;
    const saldo = nv.items.reduce((s, it) => s + (it.salXDes || 0), 0);
    return saldo !== 0;
  });
  return atrasadas.filter((nv) => nv.items.some((it) => (it.salXDes || 0) > 0 && !it.quiebre));
}

const FECHA_MINIMA_COORDINACION = new Date('2020-01-01');
function coordinacionValida(fecha) {
  return fecha && !isNaN(fecha.getTime()) && fecha >= FECHA_MINIMA_COORDINACION ? fecha : null;
}
function startOfDayLocal(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// "Coordinadas el mismo día de creación, sin hora registrada": F_coordinacion
// no trae hora (siempre 00:00), así que para esos casos no se puede medir el
// tiempo real de entrega — "Tiempo promedio de entrega" (pestaña NV
// entregadas Despacho) ya las excluye del promedio; esto muestra cuántas son
// y de qué canal, para seguimiento interno. Verificado 2026-10-09: es sobre
// todo canal Despacho (92,5%), NO Ecommerce (45,7%, el más bajo de los 3).
function computeCoordinadasMismoDia(nvRecords) {
  const universoDespacho = nvRecords.filter(esDespachoUniverso);
  const conCoordinacion = universoDespacho.filter((nv) => nv.fecCreacion && coordinacionValida(nv.fCoordinacion));
  const mismoDia = conCoordinacion.filter(
    (nv) => startOfDayLocal(nv.fecCreacion).getTime() === startOfDayLocal(nv.fCoordinacion).getTime()
  );
  const porCanal = {};
  mismoDia.forEach((nv) => {
    const c = nv.canal || '(sin canal)';
    porCanal[c] = (porCanal[c] || 0) + 1;
  });
  return { total: conCoordinacion.length, mismoDia: mismoDia.length, porCanal };
}

// Clasifica una NV de "NV entregadas Despacho" por patente, igual que la
// zona Transporte del dashboard público (Flota propia / Transporte externo),
// pero dejando cada NV identificable (no solo el conteo) para poder filtrar
// por patente y bajar el detalle. "Sin clasificar" es el caso que el usuario
// pidió poder revisar manualmente: no tiene patente, no es transporte
// externo y no es Ecommerce (auditor vacío o Matías) — no hay cómo saber
// cómo salió esa NV.
function categorizarTransporte(nv) {
  const trans = (nv.trans || '').toString().trim().toUpperCase();
  if (trans === 'EXTR') return 'Externa';
  const patente = (nv.patente || '').toString().trim().toUpperCase();
  if (patente && patente !== 'EXTR') return normalizarPatente(patente);
  const isEcom = (nv.canal || '').toString().toUpperCase().includes('ECOM');
  const auditor = auditorDe(nv);
  if (isEcom && (auditor === '' || auditor === 'matias')) return 'Ecommerce (sin patente)';
  return 'Sin clasificar';
}

// Semana actual (lunes a domingo), mismo rango que usa por defecto la
// pestaña pública "NV entregadas Despacho" — el panel privado no tiene
// selector de fecha propio, así que se deja fijo en la semana vigente.
function computeTransporteDespachoSemana(nvRecords) {
  const range = getDateRange(new Date(), 'semana');
  const universo = nvRecords.filter(
    (nv) => esDespachoUniverso(nv) && nv.fecCreacion && nv.fecCreacion >= range.start && nv.fecCreacion <= range.end
  );
  return { range, filas: universo.map((nv) => ({ nv, categoria: categorizarTransporte(nv) })) };
}

let transporteDespachoCache = null;
let filtroPatenteActivo = 'Todas';

function renderTransporteDetalle() {
  const cont = document.getElementById('control-transporte');
  if (!cont || !transporteDespachoCache) return;
  const { range, filas } = transporteDespachoCache;
  const categorias = ['Todas', ...new Set(filas.map((f) => f.categoria))].sort((a, b) => (a === 'Todas' ? -1 : b === 'Todas' ? 1 : a.localeCompare(b)));
  const filasFiltradas = filtroPatenteActivo === 'Todas' ? filas : filas.filter((f) => f.categoria === filtroPatenteActivo);
  const monto = filasFiltradas.reduce((s, f) => s + (f.nv.valorDespacho || f.nv.montoTotal || 0), 0);

  const filasTabla = filasFiltradas
    .slice()
    .sort((a, b) => (a.nv.cliente || '').localeCompare(b.nv.cliente || ''))
    .map(
      ({ nv, categoria }) => `<tr>
        <td>${nv.nvNumero}</td>
        <td>${nv.cliente || ''}</td>
        <td>${nv.canal || ''}</td>
        <td>${categoria}</td>
        <td>${auditorDe(nv) || '(vacío)'}</td>
        <td>${nv.statusDes || ''}</td>
        <td>${fmtMoney(nv.valorDespacho || nv.montoTotal)}</td>
        <td>${nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : ''}</td>
        <td>${nv.vendedor || ''}</td>
      </tr>`
    )
    .join('');

  cont.innerHTML = `
    <h3 class="np-canvas-title">Transporte Despacho — detalle por patente</h3>
    <p class="kpi-note">Semana vigente (${range.start.toLocaleDateString('es-CL')} – ${range.end.toLocaleDateString('es-CL')}), mismo universo que "NV entregadas Despacho" pública. "Sin clasificar" son las NV sin patente, sin transporte externo y sin la excepción de Ecommerce — vale la pena revisarlas a mano.</p>
    <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px;" id="control-transporte-pills">
      ${categorias.map((c) => `<button class="pill-btn${c === filtroPatenteActivo ? ' active' : ''}" data-categoria="${c}">${c}${c !== 'Todas' ? ` (${filas.filter((f) => f.categoria === c).length})` : ` (${filas.length})`}</button>`).join('')}
    </div>
    <div class="kpi-card" style="max-width:260px; margin-bottom:10px;">
      <div class="kpi-card-label">${filtroPatenteActivo}</div>
      <div class="kpi-card-value">${filasFiltradas.length} NV</div>
      <div class="kpi-card-sub">${fmtMoney(monto)}</div>
    </div>
    <button class="pill-btn" id="control-transporte-export">⬇ Exportar Excel</button>
    <div class="kpi-table-scroll" style="margin-top:8px;">
      <table class="kpi-table">
        <thead><tr><th>NV</th><th>Cliente</th><th>Canal</th><th>Categoría</th><th>Auditor</th><th>Status des</th><th>Monto</th><th>Fecha creación</th><th>Vendedor</th></tr></thead>
        <tbody>${filasTabla || '<tr><td colspan="9">Sin NV en esta categoría.</td></tr>'}</tbody>
      </table>
    </div>
  `;

  cont.querySelectorAll('[data-categoria]').forEach((btn) => {
    btn.addEventListener('click', () => {
      filtroPatenteActivo = btn.dataset.categoria;
      renderTransporteDetalle();
    });
  });
  document.getElementById('control-transporte-export')?.addEventListener('click', (e) => {
    const xlsxRows = filasFiltradas.map(({ nv, categoria }) => [
      nv.nvNumero, nv.cliente, nv.canal, categoria, auditorDe(nv) || '', nv.statusDes || '',
      Math.round(nv.valorDespacho || nv.montoTotal || 0), nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : '', nv.vendedor || '',
    ]);
    downloadXlsxSimple(
      `transporte_despacho_${filtroPatenteActivo.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().slice(0, 10)}.xlsx`,
      ['NV', 'Cliente', 'Canal', 'Categoría', 'Auditor', 'Status des', 'Monto', 'Fecha creación', 'Vendedor'],
      xlsxRows
    );
  });
}

function downloadXlsxSimple(filename, headers, rows) {
  const ws = window.XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Detalle');
  window.XLSX.writeFile(wb, filename);
}

async function renderContenido() {
  const body = document.getElementById('control-body');
  try {
    const data = await fetchPublishedData();
    if (!data) {
      body.innerHTML = '<p class="kpi-empty">No se pudo cargar data/data.json.gz.</p>';
      return;
    }
    const { nvRecords, loadedAt } = data;
    const lista = computeRetiraAtrasadasConStock(nvRecords)
      .slice()
      .sort((a, b) => (a.cliente || '').localeCompare(b.cliente || ''));
    const monto = lista.reduce((s, nv) => s + (nv.montoPorDespachar || 0), 0);
    const hoy = startOfDayLocal(new Date());
    const mismoDiaStats = computeCoordinadasMismoDia(nvRecords);
    const filasPorCanal = Object.entries(mismoDiaStats.porCanal)
      .sort((a, b) => b[1] - a[1])
      .map(([canal, n]) => `<tr><td>${canal}</td><td>${n}</td><td>${((n / mismoDiaStats.mismoDia) * 100).toFixed(1)}%</td></tr>`)
      .join('');

    const sinRastro = computeNvSinRastro(nvRecords);
    const montoSinRastro = sinRastro.reduce((s, nv) => s + (nv.montoTotal || 0), 0);
    const filasSinRastro = sinRastro
      .map((nv) => `<tr>
          <td>${nv.nvNumero}</td>
          <td>${nv.cliente || ''}</td>
          <td>${nv.canal || ''}</td>
          <td>${fmtMoney(nv.montoTotal)}</td>
          <td>${nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : ''}</td>
          <td>${nv.vendedor || ''}</td>
        </tr>`)
      .join('');

    const filas = lista
      .map((nv) => {
        const dias = Math.round((hoy - startOfDayLocal(nv.fechaCompromiso)) / 86400000);
        return `<tr>
          <td>${nv.nvNumero}</td>
          <td>${nv.cliente || ''}</td>
          <td>${auditorDe(nv) || '(vacío)'}</td>
          <td>${fmtMoney(nv.montoPorDespachar)}</td>
          <td>${nv.fechaCompromiso.toLocaleDateString('es-CL')}</td>
          <td>${dias}</td>
          <td>${nv.vendedor || ''}</td>
        </tr>`;
      })
      .join('');

    body.innerHTML = `
      <div class="zone-box zone-box--entregado" style="margin-bottom:16px;">
        <h3 class="np-canvas-title">Retira atrasadas con stock disponible (últimos 15 días)</h3>
        <p class="kpi-note">Dentro del universo "NV entregadas Retira" (auditor Yuvitsa, o sin chofer/patente pero con guía o factura): compromiso vencido y con stock al corte en alguna línea pendiente — no es falta de inventario.</p>
        <div class="kpi-card" style="max-width:260px;">
          <div class="kpi-card-label">NV</div>
          <div class="kpi-card-value">${lista.length}</div>
          <div class="kpi-card-sub">${fmtMoney(monto)} pendiente</div>
        </div>
      </div>
      <div class="kpi-table-scroll">
        <table class="kpi-table">
          <thead><tr><th>NV</th><th>Cliente</th><th>Auditor</th><th>Monto pendiente</th><th>Fecha compromiso</th><th>Días de atraso</th><th>Vendedor</th></tr></thead>
          <tbody>${filas || '<tr><td colspan="7">Sin casos ahora mismo.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="zone-box zone-box--tiempo" style="margin-top:16px;">
        <h3 class="np-canvas-title">Coordinadas el mismo día de creación (sin hora registrada)</h3>
        <p class="kpi-note">F_coordinacion no trae hora (siempre 00:00), así que para estas NV no se puede medir el tiempo real de entrega — "Tiempo promedio de entrega" (NV entregadas Despacho) ya las excluye del promedio. No es un problema de Ecommerce: es sobre todo canal Despacho.</p>
        <div class="kpi-card" style="max-width:260px; margin-bottom:12px;">
          <div class="kpi-card-label">NV (todo el histórico)</div>
          <div class="kpi-card-value">${mismoDiaStats.mismoDia}</div>
          <div class="kpi-card-sub">de ${mismoDiaStats.total} con coordinación válida (${((mismoDiaStats.mismoDia / mismoDiaStats.total) * 100).toFixed(1)}%)</div>
        </div>
        <table class="kpi-table" style="max-width:420px;">
          <thead><tr><th>Canal</th><th>NV</th><th>%</th></tr></thead>
          <tbody>${filasPorCanal}</tbody>
        </table>
      </div>
      <div class="zone-box zone-box--detalle" style="margin-top:16px;">
        <h3 class="np-canvas-title">NV sin rastro (revisión manual)</h3>
        <p class="kpi-note">Estado C, sin chofer, sin patente, sin guía ni factura, sin auditor y sin OP_Picking — ningún indicio de qué pasó con la NV (posible error de creación o cancelación de pedido). No se cuentan en "NV entregadas Despacho" desde el 2026-10-09, mientras no se defina un tratamiento definitivo. Últimos 15 días por fecha de creación (igual ventana que "Atrasadas").</p>
        <div class="kpi-card" style="max-width:260px; margin-bottom:10px;">
          <div class="kpi-card-label">NV</div>
          <div class="kpi-card-value">${sinRastro.length}</div>
          <div class="kpi-card-sub">${fmtMoney(montoSinRastro)}</div>
        </div>
        <button class="pill-btn" id="control-sinrastro-export">⬇ Exportar Excel</button>
        <div class="kpi-table-scroll" style="margin-top:8px;">
          <table class="kpi-table">
            <thead><tr><th>NV</th><th>Cliente</th><th>Canal</th><th>Monto</th><th>Fecha de creación</th><th>Vendedor</th></tr></thead>
            <tbody>${filasSinRastro || '<tr><td colspan="6">Sin casos ahora mismo.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
      <div class="zone-box zone-box--transporte" style="margin-top:16px;" id="control-transporte"></div>
      <p class="kpi-note" style="margin-top:12px;">Datos cargados: ${loadedAt ? loadedAt.toLocaleString('es-CL') : 'N/A'}.</p>
    `;

    document.getElementById('control-sinrastro-export')?.addEventListener('click', () => {
      const xlsxRows = sinRastro.map((nv) => [
        nv.nvNumero, nv.cliente, nv.canal, Math.round(nv.montoTotal || 0),
        nv.fecCreacion ? nv.fecCreacion.toLocaleDateString('es-CL') : '', nv.vendedor || '',
      ]);
      downloadXlsxSimple(
        `nv_sin_rastro_${new Date().toISOString().slice(0, 10)}.xlsx`,
        ['NV', 'Cliente', 'Canal', 'Monto', 'Fecha de creación', 'Vendedor'],
        xlsxRows
      );
    });

    transporteDespachoCache = computeTransporteDespachoSemana(nvRecords);
    filtroPatenteActivo = 'Todas';
    renderTransporteDetalle();
  } catch (err) {
    body.innerHTML = `<p class="kpi-empty">No se pudo cargar data.json.gz (${err.message}).</p>`;
  }
}

setupLogin();
