// main.js
import { loadWorkbookFromArrayBuffer } from './dataLoader.js';
import { renderKanban } from './kanban.js';
import { computeKpis, getDateRange, getSections, renderKpiSection } from './kpi.js';
import { renderDetalle, exportDetalleCsv } from './detalle.js';
import { isUploadUnlocked, tryUnlock } from './auth.js';
import { downloadDataJson, fetchPublishedData, reviveNvDates } from './dataPublish.js';
import { yesterday, startOfDay, endOfDay } from './businessDates.js';

// Carpeta "data/" del repo en GitHub (rama main) donde se sube data.json a
// mano. Se abre automáticamente tras generar el archivo para no tener que
// buscarla cada vez (Opción C — flujo manual, sin credenciales expuestas).
const REPO_DATA_UPLOAD_URL = 'https://github.com/Rexsodrilo/Informe2_datos-de-bodega/upload/main/data';

const state = {
  nvRecords: [],
  contHodo: [],
  loadedAt: null,
  activeChannel: 'todos',
  searchTermKanban: '',
  activeTab: 'kpi',
  activeKpiSection: 'notasPendientes',
  kpiDateMode: 'semana', // 'dia' | 'semana' | 'mes' | 'rango'
  kpiRefDate: yesterday(),
  kpiCustomRange: null, // { start, end } cuando kpiDateMode === 'rango'
  kpiRangeBounds: null, // { min, totalDays } límites del slider de rango
  detalleSearch: '',
  detalleEstado: 'todos',
};

document.addEventListener('DOMContentLoaded', async () => {
  // Kanban está oculto y ya no tiene botón que lo active (ver index.html) —
  // su filtro de canal queda escondido de una vez, no hace falta un toggle.
  document.getElementById('kanban-channel-filter')?.classList.add('hidden');
  setupMobileSidebar();
  setupUpload();
  setupKanbanControls();
  setupKpiControls();
  setupDetalleControls();
  buildMainMenu();
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

      // Genera el data.json para publicar y abre directo la carpeta correcta
      // del repo en GitHub (Opción C: sigue siendo manual, pero ya no hay
      // que ir a buscar la carpeta cada vez — solo arrastrar el archivo).
      downloadDataJson({ nvRecords, contHodo, loadedAt });
      window.open(REPO_DATA_UPLOAD_URL, '_blank');
      alert(
        'Datos cargados. Se descargó "data.json" y se abrió GitHub en una pestaña nueva — ' +
        'arrastra el archivo ahí (carpeta "data/") y confirma el cambio ("Commit changes") ' +
        'para que el resto de la gerencia vea esta actualización.\n\n' +
        'Si el navegador bloqueó la pestaña nueva, ábrela manualmente en:\n' + REPO_DATA_UPLOAD_URL
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

// ---------------------------------------------------------------------------
// Menú único (antes había 2 niveles: pestañas principales + submenú KPI).
// Ahora "Detalle" es un ítem más de esta misma lista, junto a las 9
// secciones de KPI — un solo lugar donde navegar toda la app.
//
// Mientras nos concentramos en "Notas de ventas aceptadas", el resto de los
// ítems quedan visibles pero deshabilitados (no clicables) — así quien abre
// el link ve que existen, sin poder entrar a algo que aún no está listo.
// ---------------------------------------------------------------------------

const MENU_SECTION_HABILITADA = 'notasPendientes';

function buildMainMenu() {
  const menu = document.getElementById('kpi-menu');
  if (!menu) return;

  const items = [...getSections().map((s) => ({ kind: 'kpi', id: s.id, label: s.label })), { kind: 'detalle', id: 'detalle', label: 'Detalle' }];

  menu.innerHTML = items
    .map((it) => {
      const habilitado = it.kind === 'kpi' && it.id === MENU_SECTION_HABILITADA;
      return `<button class="kpi-menu-item${habilitado ? '' : ' kpi-menu-item-disabled'}" data-kind="${it.kind}" data-section="${it.id}"${habilitado ? '' : ' disabled'}>${it.label}</button>`;
    })
    .join('');

  menu.querySelectorAll('.kpi-menu-item:not(.kpi-menu-item-disabled)').forEach((btn) => {
    btn.addEventListener('click', () => {
      menu.querySelectorAll('.kpi-menu-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      if (btn.dataset.kind === 'detalle') {
        state.activeTab = 'detalle';
      } else {
        state.activeTab = 'kpi';
        state.activeKpiSection = btn.dataset.section;
      }
      document.querySelectorAll('.tab-view').forEach((v) => v.classList.remove('visible'));
      document.getElementById('view-' + state.activeTab)?.classList.add('visible');
      renderAll();
      closeMobileSidebar();
    });
  });

  const initialSelector = state.activeTab === 'detalle' ? '[data-kind="detalle"]' : `[data-section="${state.activeKpiSection}"]`;
  menu.querySelector(initialSelector)?.classList.add('active');
}

function setupKpiControls() {
  document.getElementById('kpi-mode-dia')?.addEventListener('click', () => setKpiMode('dia'));
  document.getElementById('kpi-mode-semana')?.addEventListener('click', () => setKpiMode('semana'));
  document.getElementById('kpi-mode-mes')?.addEventListener('click', () => setKpiMode('mes'));
  document.getElementById('kpi-mode-rango')?.addEventListener('click', () => setKpiMode('rango'));
  document.getElementById('kpi-date-input')?.addEventListener('change', (e) => {
    state.kpiRefDate = e.target.value ? new Date(e.target.value + 'T00:00:00') : new Date();
    renderKpiTab();
  });

  const startInput = document.getElementById('kpi-range-start');
  const endInput = document.getElementById('kpi-range-end');
  startInput?.addEventListener('input', () => {
    if (+startInput.value > +endInput.value) startInput.value = endInput.value;
    updateRangeFromSlider();
  });
  endInput?.addEventListener('input', () => {
    if (+endInput.value < +startInput.value) endInput.value = startInput.value;
    updateRangeFromSlider();
  });
}

function setKpiMode(mode) {
  state.kpiDateMode = mode;
  ['dia', 'semana', 'mes', 'rango'].forEach((m) => {
    document.getElementById(`kpi-mode-${m}`)?.classList.toggle('active', mode === m);
  });
  document.getElementById('kpi-date-input')?.classList.toggle('hidden', mode !== 'dia');
  document.getElementById('kpi-range-slider')?.classList.toggle('hidden', mode !== 'rango');
  if (mode === 'rango') setupRangeSlider();
  renderKpiTab();
}

function toDateInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---------------------------------------------------------------------------
// Control de "Rango": barra doble arrastrable. El dominio (mínimo/máximo) se
// calcula a partir de las fechas presentes en los datos cargados.
// ---------------------------------------------------------------------------

// Descarta fechas con año absurdo (typos de digitación en la planilla, ej.
// "22026" en vez de "2026") para que no rompan los límites del slider.
function isSaneDate(d) {
  if (!d || isNaN(d.getTime())) return false;
  const year = d.getFullYear();
  const nowYear = new Date().getFullYear();
  return year >= nowYear - 10 && year <= nowYear + 2;
}

function getDataDateBounds() {
  let min = null;
  let max = null;
  state.nvRecords.forEach((nv) => {
    [nv.fecCreacion, nv.fechaCompromiso, nv.fCoordinacion].forEach((d) => {
      if (!isSaneDate(d)) return;
      if (!min || d < min) min = d;
      if (!max || d > max) max = d;
    });
  });
  const today = new Date();
  if (!min) min = today;
  if (!max || max < today) max = today;
  return { min: startOfDay(min), max: startOfDay(max) };
}

function setupRangeSlider() {
  const startInput = document.getElementById('kpi-range-start');
  const endInput = document.getElementById('kpi-range-end');
  if (!startInput || !endInput) return;

  const { min, max } = getDataDateBounds();
  const totalDays = Math.max(1, Math.round((max - min) / 86400000));
  startInput.min = 0;
  startInput.max = totalDays;
  endInput.min = 0;
  endInput.max = totalDays;
  // Por defecto: últimos 30 días del rango disponible.
  startInput.value = Math.max(0, totalDays - 30);
  endInput.value = totalDays;

  state.kpiRangeBounds = { min, totalDays };
  updateRangeFromSlider();
}

function updateRangeFromSlider() {
  if (!state.kpiRangeBounds) return;
  const { min } = state.kpiRangeBounds;
  const startInput = document.getElementById('kpi-range-start');
  const endInput = document.getElementById('kpi-range-end');
  const startDate = new Date(min.getTime() + Number(startInput.value) * 86400000);
  const endDate = new Date(min.getTime() + Number(endInput.value) * 86400000);

  document.getElementById('kpi-range-start-label').textContent = startDate.toLocaleDateString('es-CL');
  document.getElementById('kpi-range-end-label').textContent = endDate.toLocaleDateString('es-CL');

  state.kpiCustomRange = { start: startOfDay(startDate), end: endOfDay(endDate) };
  if (state.kpiDateMode === 'rango') renderKpiTab();
}

function computeActiveRange() {
  if (state.kpiDateMode === 'rango') {
    return state.kpiCustomRange || { start: startOfDay(new Date()), end: endOfDay(new Date()) };
  }
  return getDateRange(state.kpiRefDate, state.kpiDateMode);
}

function renderKpiTab() {
  // "Notas de venta pendientes" tiene su propio filtro de fecha embebido —
  // el selector global de arriba no la afecta, así que se oculta para no
  // duplicar el control. Las demás 8 secciones sí lo usan.
  document.getElementById('kpi-global-header')?.classList.toggle('hidden', state.activeKpiSection === 'notasPendientes');

  const range = computeActiveRange();
  const dateInput = document.getElementById('kpi-date-input');
  if (dateInput) dateInput.value = state.kpiDateMode === 'dia' ? toDateInputValue(state.kpiRefDate) : '';
  const rangeLabel = document.getElementById('kpi-range-label');
  if (rangeLabel) {
    rangeLabel.textContent =
      range.start.toLocaleDateString('es-CL') === range.end.toLocaleDateString('es-CL')
        ? range.start.toLocaleDateString('es-CL')
        : `${range.start.toLocaleDateString('es-CL')} – ${range.end.toLocaleDateString('es-CL')}`;
  }
  const kpis = computeKpis(state.nvRecords, state.contHodo, range);
  renderKpiSection(state.activeKpiSection, kpis, state.nvRecords);
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
