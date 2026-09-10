// main.js
import { loadWorkbookFromArrayBuffer } from './dataLoader.js';
import { renderKanban } from './kanban.js';
import { computeKpis, getDateRange, getSections, renderKpiSection } from './kpi.js';
import { renderDetalle, exportDetalleCsv } from './detalle.js';
import { isUploadUnlocked, tryUnlock } from './auth.js';

const state = {
  nvRecords: [],
  contHodo: [],
  loadedAt: null,
  activeChannel: 'todos',
  searchTermKanban: '',
  activeTab: 'kanban',
  activeKpiSection: 'cumplimiento',
  kpiDateMode: 'semana', // 'dia' | 'semana'
  kpiRefDate: new Date(),
  detalleSearch: '',
  detalleEstado: 'todos',
};

document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupUpload();
  setupKanbanControls();
  setupKpiControls();
  setupDetalleControls();
  buildKpiMenu();
  restoreFromStorage();
});

// ---------------------------------------------------------------------------
// Pestañas principales (Kanban / KPI / Detalle)
// ---------------------------------------------------------------------------

function setupTabs() {
  document.querySelectorAll('.main-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.main-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTab = btn.dataset.tab;
      document.querySelectorAll('.tab-view').forEach((v) => v.classList.remove('visible'));
      document.getElementById('view-' + state.activeTab)?.classList.add('visible');
      renderAll();
    });
  });
}

// ---------------------------------------------------------------------------
// Carga de datos (restringida)
// ---------------------------------------------------------------------------

function setupUpload() {
  const fileInput = document.getElementById('excel-file');
  const uploadLabel = document.getElementById('upload-label');
  const passwordModal = document.getElementById('password-modal');
  const passwordInput = document.getElementById('password-input');
  const passwordSubmit = document.getElementById('password-submit');
  const passwordError = document.getElementById('password-error');

  if (uploadLabel) {
    uploadLabel.addEventListener('click', (e) => {
      if (!isUploadUnlocked()) {
        e.preventDefault();
        passwordModal.classList.add('visible');
        passwordInput?.focus();
      }
    });
  }

  passwordSubmit?.addEventListener('click', async () => {
    const ok = await tryUnlock(passwordInput.value);
    if (ok) {
      passwordModal.classList.remove('visible');
      passwordError.textContent = '';
      fileInput.click();
    } else {
      passwordError.textContent = 'Contraseña incorrecta.';
    }
  });

  passwordInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') passwordSubmit.click();
  });

  fileInput?.addEventListener('change', handleFileUpload);
}

function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const { nvRecords, contHodo, loadedAt } = loadWorkbookFromArrayBuffer(data);

      state.nvRecords = nvRecords;
      state.contHodo = contHodo;
      state.loadedAt = loadedAt;

      persistToStorage();
      updateSyncInfo();
      renderAll();
    } catch (err) {
      console.error('Error al procesar el archivo Excel:', err);
      alert('Ocurrió un error al procesar la planilla. Revisa la consola para más detalle.');
    }
  };
  reader.readAsArrayBuffer(file);
}

function updateSyncInfo() {
  const el = document.getElementById('sync-info');
  if (!el || !state.loadedAt) return;
  const timeStr = state.loadedAt.toLocaleString('es-CL', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  el.textContent = `Actualizado: ${timeStr}`;
}

// Publicación simple: guarda el último dataset cargado en localStorage del
// navegador para que, mientras no se resuelva la publicación al repo (ver
// conversación sobre arquitectura), la sesión no se pierda al recargar la
// página en el mismo equipo. Esto NO reemplaza publicar el archivo al repo
// para que el resto de la gerencia lo vea — ese paso sigue siendo manual.
function persistToStorage() {
  try {
    localStorage.setItem(
      'dashboard_data_cache',
      JSON.stringify({
        nvRecords: state.nvRecords,
        contHodo: state.contHodo,
        loadedAt: state.loadedAt,
      })
    );
  } catch (err) {
    console.warn('No se pudo cachear localmente (archivo muy grande para localStorage).', err);
  }
}

function restoreFromStorage() {
  try {
    const raw = localStorage.getItem('dashboard_data_cache');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.nvRecords = (parsed.nvRecords || []).map(reviveNvDates);
    state.contHodo = (parsed.contHodo || []).map((r) => ({ ...r, fecha: r.fecha ? new Date(r.fecha) : null }));
    state.loadedAt = parsed.loadedAt ? new Date(parsed.loadedAt) : null;
    updateSyncInfo();
    renderAll();
  } catch (err) {
    console.warn('No se pudo restaurar el cache local.', err);
  }
}

function reviveNvDates(nv) {
  return {
    ...nv,
    fecCreacion: nv.fecCreacion ? new Date(nv.fecCreacion) : null,
    fechaCompromiso: nv.fechaCompromiso ? new Date(nv.fechaCompromiso) : null,
    fCoordinacion: nv.fCoordinacion ? new Date(nv.fCoordinacion) : null,
  };
}

// ---------------------------------------------------------------------------
// Kanban
// ---------------------------------------------------------------------------

function setupKanbanControls() {
  document.querySelectorAll('.btn-channel').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-channel').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeChannel = btn.dataset.channel;
      renderKanbanTab();
    });
  });

  document.getElementById('search-input')?.addEventListener('input', (e) => {
    state.searchTermKanban = e.target.value;
    renderKanbanTab();
  });
}

function renderKanbanTab() {
  renderKanban(state.nvRecords, { activeChannel: state.activeChannel, searchTerm: state.searchTermKanban });
}

// ---------------------------------------------------------------------------
// KPI
// ---------------------------------------------------------------------------

function buildKpiMenu() {
  const menu = document.getElementById('kpi-menu');
  if (!menu) return;
  menu.innerHTML = getSections()
    .map((s) => `<button class="kpi-menu-item" data-section="${s.id}">${s.label}</button>`)
    .join('');

  menu.querySelectorAll('.kpi-menu-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      menu.querySelectorAll('.kpi-menu-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeKpiSection = btn.dataset.section;
      renderKpiTab();
    });
  });
  menu.querySelector('.kpi-menu-item')?.classList.add('active');
}

function setupKpiControls() {
  document.getElementById('kpi-mode-dia')?.addEventListener('click', () => setKpiMode('dia'));
  document.getElementById('kpi-mode-semana')?.addEventListener('click', () => setKpiMode('semana'));
  document.getElementById('kpi-date-input')?.addEventListener('change', (e) => {
    state.kpiRefDate = e.target.value ? new Date(e.target.value + 'T00:00:00') : new Date();
    renderKpiTab();
  });
}

function setKpiMode(mode) {
  state.kpiDateMode = mode;
  document.getElementById('kpi-mode-dia')?.classList.toggle('active', mode === 'dia');
  document.getElementById('kpi-mode-semana')?.classList.toggle('active', mode === 'semana');
  renderKpiTab();
}

function renderKpiTab() {
  const range = getDateRange(state.kpiRefDate, state.kpiDateMode);
  const rangeLabel = document.getElementById('kpi-range-label');
  if (rangeLabel) {
    rangeLabel.textContent =
      range.start.toLocaleDateString('es-CL') === range.end.toLocaleDateString('es-CL')
        ? range.start.toLocaleDateString('es-CL')
        : `${range.start.toLocaleDateString('es-CL')} – ${range.end.toLocaleDateString('es-CL')}`;
  }
  const kpis = computeKpis(state.nvRecords, state.contHodo, range);
  renderKpiSection(state.activeKpiSection, kpis);
}

// ---------------------------------------------------------------------------
// Detalle
// ---------------------------------------------------------------------------

function setupDetalleControls() {
  document.getElementById('detalle-search')?.addEventListener('input', (e) => {
    state.detalleSearch = e.target.value;
    renderDetalleTab();
  });
  document.getElementById('detalle-estado')?.addEventListener('change', (e) => {
    state.detalleEstado = e.target.value;
    renderDetalleTab();
  });
  document.getElementById('detalle-export')?.addEventListener('click', () => {
    exportDetalleCsv(state.nvRecords, { searchTerm: state.detalleSearch, estado: state.detalleEstado });
  });
}

function renderDetalleTab() {
  renderDetalle(state.nvRecords, { searchTerm: state.detalleSearch, estado: state.detalleEstado });
}

// ---------------------------------------------------------------------------

function renderAll() {
  if (state.activeTab === 'kanban') renderKanbanTab();
  if (state.activeTab === 'kpi') renderKpiTab();
  if (state.activeTab === 'detalle') renderDetalleTab();
}
