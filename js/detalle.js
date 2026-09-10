// detalle.js
// Tabla resumida (una fila por NV) para la pestaña de detalle, con filtro de
// texto/estado y exportación a CSV.

const fmtMoney = (v) => '$' + Math.round(v || 0).toLocaleString('es-CL');
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('es-CL') : '');
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('es-CL') : '');

const CUMPLIMIENTO_LABEL = {
  A_TIEMPO: 'A tiempo',
  ATRASADO: 'Atrasado',
  SIN_COORDINAR: 'Sin coordinar',
};

function cumplimientoLabel(nv) {
  if (nv.esRetiro) return 'N/A (retiro)';
  return CUMPLIMIENTO_LABEL[nv.cumplimiento] || 'Pendiente';
}

export function filterDetalle(nvRecords, { searchTerm, estado }) {
  const term = (searchTerm || '').toLowerCase().trim();
  return nvRecords.filter((nv) => {
    if (estado && estado !== 'todos' && nv.nvEstado !== estado) return false;
    if (!term) return true;
    return (
      nv.nvNumero.toLowerCase().includes(term) ||
      (nv.cliente || '').toLowerCase().includes(term) ||
      (nv.vendedor || '').toLowerCase().includes(term)
    );
  });
}

export function renderDetalle(nvRecords, filters) {
  const filtered = filterDetalle(nvRecords, filters);
  const tbody = document.getElementById('detalle-tbody');
  const countEl = document.getElementById('detalle-count');
  if (countEl) countEl.textContent = filtered.length;
  if (!tbody) return filtered;

  tbody.innerHTML = filtered
    .slice(0, 500) // límite de render para no congelar el navegador con miles de filas
    .map(
      (nv) => `<tr>
        <td>${nv.nvNumero}</td>
        <td>${nv.cliente}</td>
        <td>${nv.vendedor}</td>
        <td>${nv.canal || ''}</td>
        <td>${nv.nvEstado}</td>
        <td>${fmtMoney(nv.montoTotal)}</td>
        <td>${fmtDateTime(nv.fecCreacion)}</td>
        <td>${fmtDateTime(nv.fechaCompromiso)}</td>
        <td>${fmtDate(nv.fCoordinacion)}</td>
        <td>${cumplimientoLabel(nv)}</td>
        <td>${nv.opPicking || ''}</td>
        <td>${nv.trans || nv.chofer || ''}</td>
      </tr>`
    )
    .join('');

  if (filtered.length > 500) {
    tbody.innerHTML += `<tr><td colspan="12" style="text-align:center;color:#64748b;">
      Mostrando 500 de ${filtered.length} filas — usa el buscador o exporta a CSV para ver el resto.
    </td></tr>`;
  }

  return filtered;
}

const CSV_HEADERS = [
  'NV', 'Cliente', 'Vendedor', 'Canal', 'Estado', 'Monto',
  'Fecha creacion', 'Fecha compromiso', 'Fecha coordinada', 'Cumplimiento',
  'Operador picking', 'Transportista',
];

function csvEscape(val) {
  const s = (val ?? '').toString();
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function exportDetalleCsv(nvRecords, filters) {
  const filtered = filterDetalle(nvRecords, filters);
  const lines = [CSV_HEADERS.join(',')];

  filtered.forEach((nv) => {
    lines.push(
      [
        nv.nvNumero,
        nv.cliente,
        nv.vendedor,
        nv.canal,
        nv.nvEstado,
        Math.round(nv.montoTotal),
        fmtDateTime(nv.fecCreacion),
        fmtDateTime(nv.fechaCompromiso),
        fmtDate(nv.fCoordinacion),
        cumplimientoLabel(nv),
        nv.opPicking,
        nv.trans || nv.chofer,
      ]
        .map(csvEscape)
        .join(',')
    );
  });

  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `detalle_nv_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
