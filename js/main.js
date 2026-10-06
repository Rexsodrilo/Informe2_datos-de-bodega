// main.js
// ?v=N en cada import: el sitio no manda headers de invalidación de caché,
// así que sin esto el navegador puede seguir usando una versión vieja de
// estos módulos tras subir cambios nuevos a GitHub. Súbele 1 a este número
// (aquí y en index.html) cada vez que edites algún .js/.css del proyecto.
import { loadWorkbookFromArrayBuffer } from './dataLoader.js?v=20';
import { renderKpiSection } from './kpi.js?v=45';
import { isUploadUnlocked, tryUnlock } from './auth.js?v=15';
import { downloadDataJson, fetchPublishedData, reviveNvRecords } from './dataPublish.js?v=17';

// Carpeta "data/" del repo en GitHub (rama main) donde se sube data.json a
// mano. Se abre automáticamente tras generar el archivo para no tener que
// buscarla cada vez (Opción C — flujo manual, sin credenciales expuestas).
const REPO_DATA_UPLOAD_URL = 'https://github.com/Rexsodrilo/Informe2_datos-de-bodega/upload/main/data';

const state = {
  nvRecords: [],
  contHodo: [],
  horarioCam: [],
  loadedAt: null,
  activeKpiSection: 'notasConcluidas',
};

document.addEventListener('DOMContentLoaded', async () => {
  setupMobileSidebar();
  setupAdminModal();
  setupUpload();
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
    state.horarioCam = published.horarioCam;
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
  const dot = document.getElementById('sync-dot');
  const title = document.getElementById('sync-badge-title');
  if (status === 'publicado') {
    if (el) { el.textContent = '✅ Viendo datos publicados (visibles para todos)'; el.className = 'data-status ok'; }
    if (dot) dot.className = 'sync-dot ok';
    if (title) title.textContent = 'Datos cargados';
  } else if (status === 'sin-publicar') {
    if (el) { el.textContent = '⚠️ Cargado solo en este navegador — falta publicar data.json'; el.className = 'data-status warn'; }
    if (dot) dot.className = 'sync-dot warn';
    if (title) title.textContent = 'Datos no sincronizados';
  } else if (status === 'vacio') {
    if (el) { el.textContent = 'Sin datos cargados todavía.'; el.className = 'data-status'; }
    if (dot) dot.className = 'sync-dot';
    if (title) title.textContent = 'Sin datos';
  } else {
    if (el) { el.textContent = ''; el.className = 'data-status'; }
    if (dot) dot.className = 'sync-dot';
    if (title) title.textContent = 'Sin datos';
  }
}

function setupAdminModal() {
  const modal = document.getElementById('admin-modal');
  document.getElementById('admin-open')?.addEventListener('click', () => modal?.classList.add('visible'));
  document.getElementById('admin-close')?.addEventListener('click', () => modal?.classList.remove('visible'));
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('visible');
  });
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
  reader.onload = async (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const { nvRecords, contHodo, horarioCam, loadedAt } = loadWorkbookFromArrayBuffer(data);

      state.nvRecords = nvRecords;
      state.contHodo = contHodo;
      state.horarioCam = horarioCam;
      state.loadedAt = loadedAt;

      persistToStorage();
      updateSyncInfo();
      setDataStatus('sin-publicar');
      renderAll();

      // Genera el data.json.gz (comprimido) para publicar y abre directo la
      // carpeta correcta del repo en GitHub (Opción C: sigue siendo manual,
      // pero ya no hay que ir a buscar la carpeta cada vez — solo arrastrar
      // el archivo).
      await downloadDataJson({ nvRecords, contHodo, horarioCam, loadedAt });
      window.open(REPO_DATA_UPLOAD_URL, '_blank');
      alert(
        'Datos cargados. Se descargó "data.json.gz" y se abrió GitHub en una pestaña nueva — ' +
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
  if (!state.loadedAt) return;
  const timeStr = state.loadedAt.toLocaleString('es-CL', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  const el = document.getElementById('sync-info');
  if (el) el.textContent = `Actualizado: ${timeStr}`;
  const badgeTime = document.getElementById('sync-badge-time');
  if (badgeTime) badgeTime.textContent = `Última actualización: ${timeStr}`;
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
        horarioCam: state.horarioCam,
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
    state.nvRecords = reviveNvRecords(parsed.nvRecords);
    state.contHodo = (parsed.contHodo || []).map((r) => ({ ...r, fecha: r.fecha ? new Date(r.fecha) : null }));
    state.horarioCam = (parsed.horarioCam || []).map((r) => ({ ...r, fecha: r.fecha ? new Date(r.fecha) : null }));
    state.loadedAt = parsed.loadedAt ? new Date(parsed.loadedAt) : null;
    updateSyncInfo();
    setDataStatus('sin-publicar');
    renderAll();
  } catch (err) {
    console.warn('No se pudo restaurar el cache local.', err);
  }
}

// ---------------------------------------------------------------------------
// KPI — menú único con las 3 secciones de negocio: NV entregadas, NV por
// entregar y Rendimiento del equipo.
// ---------------------------------------------------------------------------

const MENU_SECCIONES_HABILITADAS = new Set(['notasConcluidas', 'notasPendientes', 'rendimientoEquipo', 'corte']);

function buildMainMenu() {
  const menu = document.getElementById('kpi-menu');
  if (!menu) return;

  const items = [
    { id: 'notasConcluidas', label: 'NV entregadas' },
    { id: 'notasPendientes', label: 'NV por entregar' },
    { id: 'rendimientoEquipo', label: 'Rendimiento del equipo' },
    { id: 'corte', label: 'Corte' },
  ];

  menu.innerHTML = items
    .map((it) => {
      const habilitado = MENU_SECCIONES_HABILITADAS.has(it.id);
      return `<button class="kpi-menu-item${habilitado ? '' : ' kpi-menu-item-disabled'}" data-section="${it.id}"${habilitado ? '' : ' disabled'}>${it.label}</button>`;
    })
    .join('');

  menu.querySelectorAll('.kpi-menu-item:not(.kpi-menu-item-disabled)').forEach((btn) => {
    btn.addEventListener('click', () => {
      menu.querySelectorAll('.kpi-menu-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeKpiSection = btn.dataset.section;
      renderAll();
      closeMobileSidebar();
    });
  });

  menu.querySelector(`[data-section="${state.activeKpiSection}"]`)?.classList.add('active');
}

function renderKpiTab() {
  renderKpiSection(state.activeKpiSection, state.nvRecords, state.contHodo, state.horarioCam, state.loadedAt);
}

function renderAll() {
  renderKpiTab();
}
