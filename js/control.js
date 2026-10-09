// control.js — panel privado (control.html). Pendiente de confirmar con el
// usuario si esto debe pasar a leer un data_privado.json.gz aparte; por
// ahora, para partir simple, lee el mismo data.json.gz público (sin paso de
// subida adicional) — ver conversación del 2026-10-09.
import { isControlUnlocked, tryUnlockControl } from './authControl.js?v=1';
import { fetchPublishedData } from './dataPublish.js?v=17';
import { esRetiroAmplio } from './kpi.js?v=60';

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
      <p class="kpi-note" style="margin-top:12px;">Datos cargados: ${loadedAt ? loadedAt.toLocaleString('es-CL') : 'N/A'}.</p>
    `;
  } catch (err) {
    body.innerHTML = `<p class="kpi-empty">No se pudo cargar data.json.gz (${err.message}).</p>`;
  }
}

function startOfDayLocal(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

setupLogin();
