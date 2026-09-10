// kanban.js
// Clasificación y render del tablero Kanban operativo.
//
// Reglas de columna (nvEstado real: C=Concluido, A=Aceptado, P=Pendiente;
// N=Nulo ya viene excluido desde dataLoader):
//   - Pendiente:            nvEstado = P, o bloqueado = true
//   - Entregado/Concluido:  nvEstado = C
//   - En Despacho/Tránsito: nvEstado = A y statusDes = DESPACHADO
//   - Programado:           nvEstado = A, tiene F_coordinacion, no despachado aún
//   - Por Programar:        nvEstado = A, resto de los casos
//
// NOTA: estas sub-reglas para las etapas operativas del Kanban (Programado /
// Por Programar / En Despacho) no quedaron tan detalladas como las de KPI en
// la conversación — quedan como propuesta razonable a validar contigo.

const fmtMoney = (v) => '$' + Math.round(v || 0).toLocaleString('es-CL');

export function classifyKanban(nvRecords) {
  const cols = {
    entregado: [],
    programado: [],
    porProgramar: [],
    despacho: [],
    pendiente: [],
  };

  nvRecords.forEach((nv) => {
    if (nv.nvEstado === 'P' || nv.bloqueado) {
      cols.pendiente.push(nv);
    } else if (nv.nvEstado === 'C') {
      cols.entregado.push(nv);
    } else if (nv.nvEstado === 'A' && nv.statusDes === 'DESPACHADO') {
      cols.despacho.push(nv);
    } else if (nv.nvEstado === 'A' && nv.fCoordinacion) {
      cols.programado.push(nv);
    } else {
      cols.porProgramar.push(nv);
    }
  });

  return cols;
}

function matchesChannel(nv, activeChannel) {
  const canal = (nv.canal || '').toLowerCase();
  switch (activeChannel) {
    case 'todos':
      return true;
    case 'retail':
      return canal.includes('retail');
    case 'a despachar':
      return nv.entrega === 'DESPACHO';
    case 'a retirar por cliente':
      return nv.entrega === 'RETIRA';
    case 'ecommerce':
      return canal.includes('ecom') || canal.includes('web');
    case 'pendiente':
      return nv.nvEstado === 'P' || nv.bloqueado;
    default:
      return true;
  }
}

export function filterNvRecords(nvRecords, { activeChannel, searchTerm }) {
  const term = (searchTerm || '').toLowerCase().trim();
  return nvRecords.filter((nv) => {
    if (!matchesChannel(nv, activeChannel)) return false;
    if (!term) return true;
    return (
      nv.nvNumero.toLowerCase().includes(term) ||
      (nv.cliente || '').toLowerCase().includes(term) ||
      (nv.vendedor || '').toLowerCase().includes(term) ||
      (nv.ordenCompra || '').toLowerCase().includes(term)
    );
  });
}

function cardHtml(nv) {
  const ocHtml = nv.ordenCompra
    ? `<div class="card-field" style="color:#d9534f;font-weight:bold;">O.C.: ${nv.ordenCompra}</div>`
    : '';

  const itemsRows = nv.items
    .map(
      (p) => `<tr class="${p.quiebre ? 'row-quiebre' : ''}">
        <td>${p.codProd}</td><td>${p.detProd}</td><td>${p.cant}</td><td>${p.stock}</td>
      </tr>`
    )
    .join('');

  return `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span class="card-nv">NV: #${nv.nvNumero}</span>
        <span class="badge-ontime" style="cursor:pointer;" onclick="toggleDetails(this)">📦 ${nv.items.length} Prod. ▾</span>
      </div>
      <div class="card-client">${nv.cliente}</div>
      ${ocHtml}
      <div class="card-field">Vendedor: <strong>${nv.vendedor}</strong></div>
      <div class="card-field">Canal: <strong>${nv.canal || 'N/A'}</strong> · ${nv.entrega || ''}</div>
      <div class="card-field">Monto NV: <strong>${fmtMoney(nv.montoTotal)}</strong></div>
      <div class="card-field">Estado: <strong>${nv.nvEstado}</strong></div>
      <div class="card-items-detail" style="display:none;margin-top:10px;font-size:12px;border-top:1px solid #ddd;padding-top:5px;">
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="text-align:left;background:#f5f5f5;"><th>Cód</th><th>Producto</th><th>Cant</th><th>Stock</th></tr></thead>
          <tbody>${itemsRows}</tbody>
        </table>
      </div>
    </div>`;
}

export function renderKanban(nvRecords, filters) {
  const filtered = filterNvRecords(nvRecords, filters);
  const cols = classifyKanban(filtered);

  const map = [
    ['entregado', 'cards-entregado', 'count-entregado'],
    ['programado', 'cards-programado', 'count-programado'],
    ['porProgramar', 'cards-por-programar', 'count-por-programar'],
    ['despacho', 'cards-despacho', 'count-despacho'],
    ['pendiente', 'cards-pendiente', 'count-pendiente'],
  ];

  map.forEach(([key, containerId, countId]) => {
    const container = document.getElementById(containerId);
    const countBadge = document.getElementById(countId);
    const items = cols[key];
    if (countBadge) countBadge.textContent = items.length;
    if (!container) return;
    container.innerHTML = items.map(cardHtml).join('');
  });

  const totalMonto = filtered.reduce((sum, nv) => sum + nv.montoTotal, 0);
  const elSemana = document.getElementById('kpi-semana');
  if (elSemana) elSemana.textContent = fmtMoney(totalMonto);
}

window.toggleDetails = function (btnElement) {
  const card = btnElement.closest('.card');
  const details = card.querySelector('.card-items-detail');
  const open = details.style.display !== 'none';
  details.style.display = open ? 'none' : 'block';
  btnElement.textContent = btnElement.textContent.replace(open ? '▴' : '▾', open ? '▾' : '▴');
};
