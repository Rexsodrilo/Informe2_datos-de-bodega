// main.js
import { loadWorkbookFromArrayBuffer } from './dataLoader.js';
import { renderKanban } from './kanban.js';
import { computeKpis, getDateRange, getSections, renderKpiSection } from './kpi.js';
import { renderDetalle, exportDetalleCsv } from './detalle.js';
import { isUploadUnlocked, tryUnlock } from './auth.js';
import { downloadDataJson, fetchPublishedData, reviveNvDates } from './dataPublish.js';

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

document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupMobileSidebar();
  setupUpload();
  setupKanbanControls();
  setupKpiControls();
  setupDetalleControls();
  buildKpiMenu();
  await loadInitialData();
});

// ---------------------------------------------------------------------------
// Carga inicial: primero intenta el dataset PUBLICADO (data/data.json), que
// es lo que ve cualquier visitante del link público. Si no existe todavía
// (primera vez que se publica el sitio), cae al cache local de este
// navegador, útil solo para el responsable antes de la primera publicación.
// ---------------------------------------------------------------------------

async function loadInitialData() {
  const published = await fetchPublishedData();
  if (published) {
    state.nvRecords = published.nvRecords;
    state.contHodo = published.contHodo;
    state.loadedAt = published.loadedAt;
    setDataStatus('publicado');
    updateSyncInfo();
    renderAll();
    return;
  }
  restoreFromStorage();
}

function setDataStatus(status) {
  const el = document.getElementById('data-status');
  if (!el) return;
  if (status === 'publicado') {
    el.textContent = '✅ Viendo datos publicados (visibles para todos)';
    el.className = 'data-status ok';
  } else if (status === 'sin-publicar') {
    el.textContent = '⚠️ Cargado solo en este navegador — falta publicar data.json';
    el.className = 'data-status warn';
  } else if (status === 'vacio') {
    el.textContent = 'Sin datos cargados todavía.';
    el.className = 'data-status';
  } else {
    el.textContent = '';
    el.className = 'data-status';
  }
}

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
      document.getElementById('kanban-channel-filter')?.classList.toggle('hidden', state.activeTab !== 'kanban');
      renderAll();
      closeMobileSidebar();
    });
  });
  document.getElementById('kanban-channel-filter')?.classList.toggle('hidden', state.activeTab !== 'kanban');
}

function setupMobileSidebar() {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('mobile-menu-toggle');
  const overlay = document.getElementById('sidebar-overlay');
  toggle?.addEventListener('click', () => {
    sidebar?.classList.toggle('open');
    overlay?.classList.toggle('visible');
  });
  overlay?.addEventListener('click', closeMobileSidebar);
}

function closeMobileSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('visible');
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
      setDataStatus('sin-publicar');
      renderAll();

      // Genera el data.json para publicar y avisa el paso que falta.
      downloadDataJson({ nvRecords, contHodo, loadedAt });
      alert(
        'Datos cargados. Se descargó "data.json" — súbelo (arrástralo) a la carpeta ' +
        '"data/" de tu repositorio en GitHub, reemplazando el anterior, para que el ' +
        'resto de la gerencia vea esta actualización.'
      );
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
    if (!raw) {
      setDataStatus('vacio');
      return;
    }
    const parsed = JSON.parse(raw);
    state.nvRecords = (parsed.nvRecords || []).map(reviveNvDates);
    state.contHodo = (parsed.contHodo || []).map((r) => ({ ...r, fecha: r.fecha ? new Date(r.fecha) : null }));
    state.loadedAt = parsed.loadedAt ? new Date(parsed.loadedAt) : null;
    updateSyncInfo();
    setDataStatus('sin-publicar');
    renderAll();
  } catch (err) {
    console.warn('No se pudo restaurar el cache local.', err);
  }
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
      closeMobileSidebar();
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
  document.getElementById('kpi-mode-mes')?.addEventListener('click', () => setKpiMode('mes'));
  document.getElementById('kpi-date-input')?.addEventListener('change', (e) => {
    state.kpiRefDate = e.target.value ? new Date(e.target.value + 'T00:00:00') : new Date();
    renderKpiTab();
  });
}

function setKpiMode(mode) {
  state.kpiDateMode = mode;
  document.getElementById('kpi-mode-dia')?.classList.toggle('active', mode === 'dia');
  document.getElementById('kpi-mode-semana')?.classList.toggle('active', mode === 'semana');
  document.getElementById('kpi-mode-mes')?.classList.toggle('active', mode === 'mes');
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
