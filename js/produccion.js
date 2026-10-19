// produccion.js — seguimiento de avance de maquila. Dos tipos hoy: armado de
// canastillos y programación DIM (NV vigentes, estado A); pensado para sumar
// otras maquilas más adelante como secciones nuevas en esta misma página.
// Lee NV del mismo data.json.gz público; el avance (lo ingresado a mano
// acá) NO viene del Excel, se guarda aparte en data/produccion_progreso.json.
//
// La conexión con GitHub (token, publicar, ver historial) es compartida con
// el resto del sitio (ghPublish.js) — se configura una sola vez en el modal
// de Administración de index.html, no hay una caja de conexión propia acá
// desde el 2026-10-16.
import { fetchPublishedData } from './dataPublish.js?v=20';
import { getGhToken, publicarArchivo, bytesToBase64 } from './ghPublish.js?v=1';

const RUTA_PROGRESO = 'data/produccion_progreso.json';

const fmtPct = (v) => (v == null || isNaN(v) ? '—' : Math.round(v * 10) / 10 + '%');
const fmtNum = (v) => (v == null || isNaN(v) ? '—' : Number(v).toLocaleString('es-CL'));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fechaInputVal = (iso) => (iso ? String(iso).slice(0, 10) : '');

// ===========================================================================
// Maquila 1: armado de canastillo
// ===========================================================================

// El codigo de "Armado CANASTILLO" siempre empieza con CAN (CAN2500/CAN3000/
// CAN3500/CAN4000/CAN4500) — mas confiable que el texto libre de la
// descripcion, que trae variaciones y errores de tipeo entre "Tubular"/
// "Conico"/"+ canastillo"/"C/Canastillos". Medido en el Excel real el
// 2026-10-14: 532 NV historicas con este codigo, 531 con una linea de poste
// reconocible en la misma NV.
function esLineaCanastillo(item) {
  return (item.codProd || '').toString().trim().toUpperCase().startsWith('CAN');
}
function esLineaPoste(item) {
  if (esLineaCanastillo(item)) return false;
  return /poste/i.test(item.detProd || '');
}

/** Fecha de término posible: pedida como "fecha de creación + 5 días",
 * una estimación simple, no un compromiso real con el cliente. */
function sumarDias(fecha, n) {
  const d = new Date(fecha);
  d.setDate(d.getDate() + n);
  return d;
}
function fechaISO(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Una fila por cada linea "Armado CANASTILLO" de una NV en estado A — una
 * NV puede tener mas de una (distintas medidas de poste en la misma nota). */
function computeFilasCanastillo(nvRecords, progreso) {
  const filas = [];
  nvRecords.forEach((nv) => {
    if (nv.nvEstado !== 'A') return;
    const items = nv.items || [];
    const lineasCan = items.filter(esLineaCanastillo);
    if (!lineasCan.length) return;
    const lineasPoste = items.filter(esLineaPoste);
    lineasCan.forEach((can, idx) => {
      const totalSolicitado = can.cant || 0;
      const despachado = Math.max(0, totalSolicitado - (can.salXDes || 0));
      const codCan = (can.codProd || '').toString().trim();
      // El indice distingue dos lineas del mismo codigo CAN en la misma NV
      // (pasa en pedidos grandes consolidados, ej. NV 329861 con dos lineas
      // CAN4500 de cantidades distintas) — sin esto colisionaban en la misma
      // clave y una pisaba el "producido" de la otra.
      const key = `${nv.nvNumero}__${codCan}__${idx}`;
      const guardado = progreso[key];
      const producido = Math.min(totalSolicitado, Math.max(despachado, guardado ? Number(guardado.producido) || 0 : 0));
      // Ya terminada (producida y/o despachada al 100%): no queda nada
      // pendiente que seguir, se saca del informe entero (KPIs, resumen,
      // tabla y exportable salen todos de este mismo arreglo).
      if (totalSolicitado > 0 && producido >= totalSolicitado) return;
      // Solo se muestra el/los poste(s) cuya cantidad calza exacto con la
      // linea de armado — en una NV con muchas lineas de postes distintos
      // (pedidos grandes consolidados) mostrar "todas las que haya" como
      // alternativa confundía mas de lo que ayudaba.
      const postesCoincidentes = lineasPoste.filter((p) => (p.cant || 0) === totalSolicitado);
      const posteTexto = postesCoincidentes.map((p) => p.detProd).join(' / ') || '—';
      filas.push({
        nvNumero: nv.nvNumero,
        cliente: nv.cliente || '',
        fecCreacion: nv.fecCreacion || null,
        poste: posteTexto,
        armado: can.detProd || '',
        codCan,
        key,
        totalSolicitado,
        despachado,
        producido,
        fechaTermino: nv.fecCreacion ? sumarDias(nv.fecCreacion, 5) : null,
      });
    });
  });
  return filas.sort((a, b) => a.nvNumero.localeCompare(b.nvNumero, 'es', { numeric: true }));
}

// ===========================================================================
// Maquila 2: programación DIM
// ===========================================================================

// El codigo de la linea de trabajo siempre empieza con DIM (mayus o minus:
// "DIM60", "Dim90"...) pero el NUMERO del codigo NO indica a cuantos watts
// se programa — DIM60 aparece programando a 10w, 25w, 30w, 40w Y 60w segun
// la nota. El watt real solo sale del texto libre ("Programar a Xw"), que
// tambien trae variaciones (rangos "DE Xw a Yw", sin la "a", notas pegadas
// como colores o ciudades). Medido el 2026-10-15: 308 NV historicas, 15
// abiertas hoy.
function esLineaDim(item) {
  return (item.codProd || '').toString().trim().toUpperCase().startsWith('DIM');
}
// Candidata a "producto" programable: no es ella misma una linea DIM, y su
// descripcion menciona su propia potencia (ej. "Brisa 100W 4000K/base 7
// pins") — asi se descarta un accesorio sin watts como "SHORTING CAP" o
// "Gancho Luminaria", que a veces coincide por casualidad en cantidad.
function esLineaProductoDim(item) {
  if (esLineaDim(item)) return false;
  return /\d+\s*w\b/i.test(item.detProd || '');
}

/** Una fila por cada linea DIM de una NV en estado A. El producto solo se
 * muestra cuando hay UNA linea no-DIM de la misma NV con cantidad IGUAL —
 * si no hay ninguna, o si hace falta repartir entre varias lineas DIM (ej.
 * NV 338070: un Brisa de 11 unidades se reparte en 9 + 2), se deja sin
 * asignar y queda listada en la alerta de revisión manual en vez de
 * adivinar. Medido el 2026-10-15: de 20 lineas DIM abiertas, 18 calzan solas
 * y 2 quedan sin asignar (el reparto 9+2 de la 338070).
 *
 * Tambien puede pasar al reves: dos lineas DIM de la misma NV piden la
 * MISMA cantidad y esa cantidad calza con una sola linea de producto (ej.
 * NV 337041: tres trabajos de 10 unidades con un solo Brisa de 10 unidades
 * en la NV) — ahi no hay forma de saber cual trabajo es cual, asi que
 * ninguno de los dos se asigna en vez de mostrar el mismo producto
 * repetido en varios trabajos. */
function computeFilasDim(nvRecords, progreso) {
  const filas = [];
  nvRecords.forEach((nv) => {
    if (nv.nvEstado !== 'A') return;
    const items = nv.items || [];
    const lineasDim = items.filter(esLineaDim);
    if (!lineasDim.length) return;
    const lineasProducto = items.filter(esLineaProductoDim);

    const candidatoPorDim = lineasDim.map((dim) => {
      const coincidentes = lineasProducto.filter((p) => (p.cant || 0) === (dim.cant || 0));
      return coincidentes.length === 1 ? coincidentes[0] : null;
    });
    const usosPorCandidato = new Map();
    candidatoPorDim.forEach((c) => {
      if (c) usosPorCandidato.set(c, (usosPorCandidato.get(c) || 0) + 1);
    });

    lineasDim.forEach((dim, idx) => {
      const totalSolicitado = dim.cant || 0;
      const despachado = Math.max(0, totalSolicitado - (dim.salXDes || 0));
      const codDim = (dim.codProd || '').toString().trim();
      const key = `${nv.nvNumero}__${codDim}__${idx}`;
      const guardado = progreso[key];
      const producido = Math.min(totalSolicitado, Math.max(despachado, guardado ? Number(guardado.producido) || 0 : 0));
      // Misma regla que canastillo: terminada al 100% (producida y/o
      // despachada) se saca del informe entero, incluida la alerta de
      // revisión manual — si ya está lista no hay nada que seguir revisando.
      if (totalSolicitado > 0 && producido >= totalSolicitado) return;
      // Fecha de término: sugerencia inicial de creación + 5 días (igual que
      // canastillo), pero queda 100% editable a mano porque acá el tiempo real
      // es muy variable — el valor guardado manualmente manda siempre sobre
      // la sugerencia, y una vez guardado se mantiene aunque pase el tiempo.
      const fechaTermino = (guardado && guardado.fechaTermino) || (nv.fecCreacion ? fechaISO(sumarDias(nv.fecCreacion, 5)) : null);
      const candidato = candidatoPorDim[idx];
      const producto = candidato && usosPorCandidato.get(candidato) === 1 ? candidato.detProd : null;
      filas.push({
        nvNumero: nv.nvNumero,
        cliente: nv.cliente || '',
        fecCreacion: nv.fecCreacion || null,
        producto,
        trabajo: dim.detProd || '',
        codDim,
        key,
        totalSolicitado,
        despachado,
        producido,
        fechaTermino, // string 'AAAA-MM-DD' o null — sugerida (creación+5), editable a mano
        sinProducto: !producto,
      });
    });
  });
  return filas.sort((a, b) => a.nvNumero.localeCompare(b.nvNumero, 'es', { numeric: true }));
}

// ===========================================================================
// Progreso publicado + token + publicación a GitHub (compartido por ambas
// maquilas: la clave NV__codigo__indice ya es unica entre ellas porque el
// codigo de canastillo y el de DIM nunca se repiten).
// ===========================================================================

async function leerProgresoPublicado() {
  try {
    const r = await fetch(`${RUTA_PROGRESO}?v=${Date.now()}`, { cache: 'no-store' });
    if (r.status === 404) return {};
    if (!r.ok) return {};
    return (await r.json()) || {};
  } catch (e) {
    return {};
  }
}

async function guardarProgresoPublicado(progreso) {
  const contenido = JSON.stringify(progreso, null, 2);
  const contenidoBase64 = bytesToBase64(new TextEncoder().encode(contenido));
  const mensaje = 'Actualiza avance de producción (' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ')';
  return publicarArchivo(RUTA_PROGRESO, { contenidoBase64, mensaje });
}

// ===========================================================================
// Estado de la pagina
// ===========================================================================
let filasCanastillo = [];
let filasDim = [];
let progresoBase = {};
const cambios = new Map(); // key -> { producido?, fechaTermino? }

function registrarCambio(key, campo, valor) {
  const previo = cambios.get(key) || {};
  cambios.set(key, { ...previo, [campo]: valor });
}

// --- Canastillo: KPIs + resumen por medida ---

function renderKpisCanastillo(filas) {
  const cont = document.getElementById('prod-kpis');
  if (!cont) return;
  const nvDistintas = new Set(filas.map((f) => f.nvNumero)).size;
  const totalSolicitado = filas.reduce((s, f) => s + f.totalSolicitado, 0);
  const totalDespachado = filas.reduce((s, f) => s + f.despachado, 0);
  const totalProducido = filas.reduce((s, f) => s + f.producido, 0);
  const listoSinDespachar = filas.reduce((s, f) => s + Math.max(0, f.producido - f.despachado), 0);
  const pctProducido = totalSolicitado ? (totalProducido / totalSolicitado) * 100 : null;
  const pctDespachado = totalSolicitado ? (totalDespachado / totalSolicitado) * 100 : null;

  cont.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-card-label">NV con canastillo pendiente</div>
      <div class="kpi-card-value">${fmtNum(nvDistintas)}</div>
      <div class="kpi-card-sub">${fmtNum(filas.length)} líneas de armado</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-card-label">Unidades solicitadas</div>
      <div class="kpi-card-value">${fmtNum(totalSolicitado)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-card-label">% producido</div>
      <div class="kpi-card-value">${fmtPct(pctProducido)}</div>
      <div class="kpi-card-sub">${fmtNum(totalProducido)} de ${fmtNum(totalSolicitado)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-card-label">% despachado</div>
      <div class="kpi-card-value">${fmtPct(pctDespachado)}</div>
      <div class="kpi-card-sub">${fmtNum(totalDespachado)} de ${fmtNum(totalSolicitado)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-card-label">Listo esperando despacho</div>
      <div class="kpi-card-value${listoSinDespachar > 0 ? ' prod-listo-positivo' : ''}">${fmtNum(listoSinDespachar)}</div>
      <div class="kpi-card-sub">Producido menos despachado</div>
    </div>
  `;
}

function computeResumenMedida(filas) {
  const porCodigo = new Map();
  filas.forEach((f) => {
    if (!porCodigo.has(f.codCan)) {
      const medida = f.armado.replace(/^Armado CANASTILLO poste /i, '').trim() || f.armado;
      porCodigo.set(f.codCan, { codCan: f.codCan, medida, nv: 0, solicitado: 0, producido: 0 });
    }
    const g = porCodigo.get(f.codCan);
    g.nv += 1;
    g.solicitado += f.totalSolicitado;
    g.producido += f.producido;
  });
  return Array.from(porCodigo.values()).sort((a, b) => a.codCan.localeCompare(b.codCan));
}

function renderResumenMedida(filas) {
  const cont = document.getElementById('prod-resumen-medida');
  if (!cont) return;
  const grupos = computeResumenMedida(filas);
  if (!grupos.length) {
    cont.innerHTML = '<p class="kpi-empty">No hay NV vigentes con línea de Armado CANASTILLO en este momento.</p>';
    return;
  }
  const filasHtml = grupos
    .map((g) => {
      const pct = g.solicitado ? (g.producido / g.solicitado) * 100 : 0;
      return `
        <div class="progreso-medida-fila">
          <div class="progreso-medida-nombre">${esc(g.medida)}<span>${esc(g.codCan)}</span></div>
          <div class="progreso-medida-track"><div class="progreso-medida-fill" style="width:${Math.min(100, pct).toFixed(1)}%"></div></div>
          <div class="progreso-medida-num"><b>${fmtNum(g.producido)}</b> / ${fmtNum(g.solicitado)} <span>(${fmtPct(pct)})</span></div>
        </div>`;
    })
    .join('');
  cont.innerHTML = `<div class="progreso-medida">${filasHtml}</div>`;
}

function renderTablaCanastillo(filas) {
  const cont = document.getElementById('prod-tabla');
  if (!cont) return;
  if (!filas.length) {
    cont.innerHTML = '<p class="kpi-empty">No hay NV vigentes con línea de Armado CANASTILLO en este momento.</p>';
    return;
  }
  const filasHtml = filas
    .map((f) => {
      const listo = Math.max(0, f.producido - f.despachado);
      const cambiado = cambios.has(f.key);
      const pendienteDespacho = Math.max(0, f.totalSolicitado - f.despachado);
      return `
        <tr>
          <td>${esc(f.nvNumero)}</td>
          <td>${esc(f.cliente)}</td>
          <td>${f.fecCreacion ? f.fecCreacion.toLocaleDateString('es-CL') : 'N/A'}</td>
          <td>${esc(f.poste)}</td>
          <td>${esc(f.armado)}<br><span class="prod-cod">${esc(f.codCan)}</span></td>
          <td>${fmtNum(f.totalSolicitado)}</td>
          <td>${fmtNum(f.despachado)}</td>
          <td>${fmtNum(pendienteDespacho)}</td>
          <td><input type="number" class="prod-input-producido${cambiado ? ' cambiado' : ''}" data-key="${esc(f.key)}"
                min="${f.despachado}" max="${f.totalSolicitado}" step="1" value="${f.producido}"></td>
          <td>${fmtPct(f.totalSolicitado ? (f.producido / f.totalSolicitado) * 100 : null)}</td>
          <td class="${listo > 0 ? 'prod-listo-positivo' : 'prod-listo-cero'}">${fmtNum(listo)}</td>
          <td>${f.fechaTermino ? f.fechaTermino.toLocaleDateString('es-CL') : 'N/A'}</td>
        </tr>`;
    })
    .join('');
  cont.innerHTML = `
    <table class="kpi-table">
      <thead>
        <tr>
          <th>NV</th><th>Cliente</th><th>Fecha de ingreso</th><th>Poste</th><th>Armado</th>
          <th>Solicitado</th><th>Despachado</th><th>Pendiente por despachar</th><th>Producido</th><th>% producido</th><th>Listo sin despachar</th><th>Fecha término posible</th>
        </tr>
      </thead>
      <tbody>${filasHtml}</tbody>
    </table>
  `;
  cont.querySelectorAll('.prod-input-producido').forEach((inp) => {
    inp.addEventListener('change', onCambioProducidoCanastillo);
  });
}

function onCambioProducidoCanastillo(e) {
  const inp = e.target;
  const key = inp.dataset.key;
  const fila = filasCanastillo.find((f) => f.key === key);
  if (!fila) return;
  let v = Math.round(Number(inp.value));
  if (isNaN(v)) v = fila.producido;
  v = Math.max(fila.despachado, Math.min(fila.totalSolicitado, v));
  inp.value = v;
  fila.producido = v;
  const original = (progresoBase[key] && Number(progresoBase[key].producido)) || 0;
  if (v === original) cambios.delete(key);
  else registrarCambio(key, 'producido', v);
  inp.classList.toggle('cambiado', cambios.has(key));

  const fila_tr = inp.closest('tr');
  if (fila_tr) {
    const listo = Math.max(0, fila.producido - fila.despachado);
    fila_tr.children[9].textContent = fmtPct(fila.totalSolicitado ? (fila.producido / fila.totalSolicitado) * 100 : null);
    fila_tr.children[10].textContent = fmtNum(listo);
    fila_tr.children[10].className = listo > 0 ? 'prod-listo-positivo' : 'prod-listo-cero';
  }

  renderKpisCanastillo(filasCanastillo);
  renderResumenMedida(filasCanastillo);
  actualizarBotonGuardar();
}

// --- DIM: KPIs + resumen por trabajo + tabla + alerta ---

function renderKpisDim(filas) {
  const cont = document.getElementById('prod-dim-kpis');
  if (!cont) return;
  const nvDistintas = new Set(filas.map((f) => f.nvNumero)).size;
  const totalSolicitado = filas.reduce((s, f) => s + f.totalSolicitado, 0);
  const totalDespachado = filas.reduce((s, f) => s + f.despachado, 0);
  const totalProducido = filas.reduce((s, f) => s + f.producido, 0);
  const listoSinDespachar = filas.reduce((s, f) => s + Math.max(0, f.producido - f.despachado), 0);
  const sinProducto = filas.filter((f) => f.sinProducto).length;
  const pctProducido = totalSolicitado ? (totalProducido / totalSolicitado) * 100 : null;
  const pctDespachado = totalSolicitado ? (totalDespachado / totalSolicitado) * 100 : null;

  cont.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-card-label">NV con programación pendiente</div>
      <div class="kpi-card-value">${fmtNum(nvDistintas)}</div>
      <div class="kpi-card-sub">${fmtNum(filas.length)} trabajos</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-card-label">Unidades solicitadas</div>
      <div class="kpi-card-value">${fmtNum(totalSolicitado)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-card-label">% producido</div>
      <div class="kpi-card-value">${fmtPct(pctProducido)}</div>
      <div class="kpi-card-sub">${fmtNum(totalProducido)} de ${fmtNum(totalSolicitado)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-card-label">% despachado</div>
      <div class="kpi-card-value">${fmtPct(pctDespachado)}</div>
      <div class="kpi-card-sub">${fmtNum(totalDespachado)} de ${fmtNum(totalSolicitado)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-card-label">Listo esperando despacho</div>
      <div class="kpi-card-value${listoSinDespachar > 0 ? ' prod-listo-positivo' : ''}">${fmtNum(listoSinDespachar)}</div>
      <div class="kpi-card-sub">Producido menos despachado</div>
    </div>
    <div class="kpi-card${sinProducto > 0 ? ' kpi-card--warn' : ''}">
      <div class="kpi-card-label">Sin producto identificado</div>
      <div class="kpi-card-value">${fmtNum(sinProducto)}</div>
      <div class="kpi-card-sub">Ver alerta más abajo</div>
    </div>
  `;
}

/** Agrupa por el texto del trabajo (no por código DIM: el número del código
 * no indica el watt real, ver comentario de esLineaDim). */
function computeResumenTrabajoDim(filas) {
  const porTexto = new Map();
  filas.forEach((f) => {
    const clave = f.trabajo.trim().toLowerCase();
    if (!porTexto.has(clave)) {
      porTexto.set(clave, { texto: f.trabajo.trim(), nv: 0, solicitado: 0, producido: 0 });
    }
    const g = porTexto.get(clave);
    g.nv += 1;
    g.solicitado += f.totalSolicitado;
    g.producido += f.producido;
  });
  return Array.from(porTexto.values()).sort((a, b) => b.solicitado - a.solicitado);
}

function renderResumenTrabajoDim(filas) {
  const cont = document.getElementById('prod-dim-resumen');
  if (!cont) return;
  const grupos = computeResumenTrabajoDim(filas);
  if (!grupos.length) {
    cont.innerHTML = '<p class="kpi-empty">No hay NV vigentes con línea de programación DIM en este momento.</p>';
    return;
  }
  const filasHtml = grupos
    .map((g) => {
      const pct = g.solicitado ? (g.producido / g.solicitado) * 100 : 0;
      return `
        <div class="progreso-medida-fila">
          <div class="progreso-medida-nombre">${esc(g.texto)}</div>
          <div class="progreso-medida-track"><div class="progreso-medida-fill" style="width:${Math.min(100, pct).toFixed(1)}%"></div></div>
          <div class="progreso-medida-num"><b>${fmtNum(g.producido)}</b> / ${fmtNum(g.solicitado)} <span>(${fmtPct(pct)})</span></div>
        </div>`;
    })
    .join('');
  cont.innerHTML = `<div class="progreso-medida">${filasHtml}</div>`;
}

function renderTablaDim(filas) {
  const cont = document.getElementById('prod-dim-tabla');
  if (!cont) return;
  if (!filas.length) {
    cont.innerHTML = '<p class="kpi-empty">No hay NV vigentes con línea de programación DIM en este momento.</p>';
    return;
  }
  const filasHtml = filas
    .map((f) => {
      const listo = Math.max(0, f.producido - f.despachado);
      const cambiado = cambios.has(f.key);
      const pendienteDespacho = Math.max(0, f.totalSolicitado - f.despachado);
      return `
        <tr>
          <td>${esc(f.nvNumero)}</td>
          <td>${esc(f.cliente)}</td>
          <td>${f.fecCreacion ? f.fecCreacion.toLocaleDateString('es-CL') : 'N/A'}</td>
          <td>${f.producto ? esc(f.producto) : '<span class="prod-sin-producto">— revisar manual</span>'}</td>
          <td>${esc(f.trabajo)}<br><span class="prod-cod">${esc(f.codDim)}</span></td>
          <td>${fmtNum(f.totalSolicitado)}</td>
          <td>${fmtNum(f.despachado)}</td>
          <td>${fmtNum(pendienteDespacho)}</td>
          <td><input type="number" class="prod-input-producido${cambiado ? ' cambiado' : ''}" data-key="${esc(f.key)}"
                min="${f.despachado}" max="${f.totalSolicitado}" step="1" value="${f.producido}"></td>
          <td>${fmtPct(f.totalSolicitado ? (f.producido / f.totalSolicitado) * 100 : null)}</td>
          <td class="${listo > 0 ? 'prod-listo-positivo' : 'prod-listo-cero'}">${fmtNum(listo)}</td>
          <td><input type="date" class="prod-input-fecha${cambiado ? ' cambiado' : ''}" data-key="${esc(f.key)}" value="${fechaInputVal(f.fechaTermino)}"></td>
        </tr>`;
    })
    .join('');
  cont.innerHTML = `
    <table class="kpi-table">
      <thead>
        <tr>
          <th>NV</th><th>Cliente</th><th>Fecha de ingreso</th><th>Producto</th><th>Trabajo</th>
          <th>Solicitado</th><th>Despachado</th><th>Pendiente por despachar</th><th>Producido</th><th>% producido</th><th>Listo sin despachar</th><th>Fecha término (ingresar)</th>
        </tr>
      </thead>
      <tbody>${filasHtml}</tbody>
    </table>
  `;
  cont.querySelectorAll('.prod-input-producido').forEach((inp) => {
    inp.addEventListener('change', onCambioProducidoDim);
  });
  cont.querySelectorAll('.prod-input-fecha').forEach((inp) => {
    inp.addEventListener('change', onCambioFechaDim);
  });
}

function renderAlertaDim(filas) {
  const cont = document.getElementById('prod-dim-alerta');
  if (!cont) return;
  const sinProducto = filas.filter((f) => f.sinProducto);
  if (!sinProducto.length) {
    cont.innerHTML = '<p class="kpi-empty">Sin casos pendientes de revisión manual.</p>';
    return;
  }
  const filasHtml = sinProducto
    .map(
      (f) => `
        <tr>
          <td>${esc(f.nvNumero)}</td>
          <td>${esc(f.cliente)}</td>
          <td>${esc(f.trabajo)}<br><span class="prod-cod">${esc(f.codDim)}</span></td>
          <td>${fmtNum(f.totalSolicitado)}</td>
        </tr>`
    )
    .join('');
  cont.innerHTML = `
    <table class="kpi-table">
      <thead><tr><th>NV</th><th>Cliente</th><th>Trabajo</th><th>Cantidad</th></tr></thead>
      <tbody>${filasHtml}</tbody>
    </table>
  `;
}

function onCambioProducidoDim(e) {
  const inp = e.target;
  const key = inp.dataset.key;
  const fila = filasDim.find((f) => f.key === key);
  if (!fila) return;
  let v = Math.round(Number(inp.value));
  if (isNaN(v)) v = fila.producido;
  v = Math.max(fila.despachado, Math.min(fila.totalSolicitado, v));
  inp.value = v;
  fila.producido = v;
  registrarCambio(key, 'producido', v);
  inp.classList.toggle('cambiado', true);

  const fila_tr = inp.closest('tr');
  if (fila_tr) {
    const listo = Math.max(0, fila.producido - fila.despachado);
    fila_tr.children[9].textContent = fmtPct(fila.totalSolicitado ? (fila.producido / fila.totalSolicitado) * 100 : null);
    fila_tr.children[10].textContent = fmtNum(listo);
    fila_tr.children[10].className = listo > 0 ? 'prod-listo-positivo' : 'prod-listo-cero';
  }

  renderKpisDim(filasDim);
  renderResumenTrabajoDim(filasDim);
  actualizarBotonGuardar();
}

function onCambioFechaDim(e) {
  const inp = e.target;
  const key = inp.dataset.key;
  const fila = filasDim.find((f) => f.key === key);
  if (!fila) return;
  fila.fechaTermino = inp.value || null;
  registrarCambio(key, 'fechaTermino', fila.fechaTermino);
  inp.classList.add('cambiado');
  actualizarBotonGuardar();
}

// --- Compartido: conexión GitHub, guardar, toggles, export ---

function actualizarBotonGuardar() {
  const btn = document.getElementById('prod-guardar-btn');
  if (!btn) return;
  btn.disabled = cambios.size === 0;
  btn.textContent = cambios.size ? `Guardar ${cambios.size} cambio${cambios.size === 1 ? '' : 's'}` : 'Guardar cambios';
}

function msg(id, texto, ok) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = texto;
  el.className = 'prod-estado-token' + (ok === true ? ' ok' : ok === false ? ' mal' : '');
}

function setupToggle(btnId, wrapId) {
  const btn = document.getElementById(btnId);
  const wrap = document.getElementById(wrapId);
  btn?.addEventListener('click', () => {
    const oculto = wrap.classList.toggle('hidden');
    btn.textContent = oculto ? '▾ Ver detalle' : '▴ Ocultar';
  });
}

function exportarExcelCanastillo() {
  const headers = ['NV', 'Cliente', 'Fecha de ingreso', 'Poste', 'Armado', 'Código', 'Solicitado', 'Despachado', 'Pendiente por despachar', 'Producido', '% producido', 'Listo sin despachar', 'Fecha término posible'];
  const rows = filasCanastillo.map((f) => [
    f.nvNumero, f.cliente, f.fecCreacion ? f.fecCreacion.toLocaleDateString('es-CL') : '', f.poste, f.armado, f.codCan,
    f.totalSolicitado, f.despachado, Math.max(0, f.totalSolicitado - f.despachado), f.producido,
    f.totalSolicitado ? Math.round((f.producido / f.totalSolicitado) * 1000) / 10 : '',
    Math.max(0, f.producido - f.despachado),
    f.fechaTermino ? f.fechaTermino.toLocaleDateString('es-CL') : '',
  ]);
  const ws = window.XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Canastillos');
  window.XLSX.writeFile(wb, `produccion_canastillos_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function exportarExcelResumenMedida() {
  const headers = ['Medida', 'Código', 'NV', 'Solicitado', 'Producido', 'Falta por producir', '% producido'];
  const rows = computeResumenMedida(filasCanastillo).map((g) => {
    const falta = Math.max(0, g.solicitado - g.producido);
    return [g.medida, g.codCan, g.nv, g.solicitado, g.producido, falta, g.solicitado ? Math.round((g.producido / g.solicitado) * 1000) / 10 : ''];
  });
  const ws = window.XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Resumen por medida');
  window.XLSX.writeFile(wb, `produccion_resumen_canastillos_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function exportarExcelResumenTrabajoDim() {
  const headers = ['Trabajo', 'NV', 'Solicitado', 'Producido', 'Falta por producir', '% producido'];
  const rows = computeResumenTrabajoDim(filasDim).map((g) => {
    const falta = Math.max(0, g.solicitado - g.producido);
    return [g.texto, g.nv, g.solicitado, g.producido, falta, g.solicitado ? Math.round((g.producido / g.solicitado) * 1000) / 10 : ''];
  });
  const ws = window.XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Resumen por trabajo');
  window.XLSX.writeFile(wb, `produccion_resumen_dim_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function exportarExcelDim() {
  const headers = ['NV', 'Cliente', 'Fecha de ingreso', 'Producto', 'Trabajo', 'Código', 'Solicitado', 'Despachado', 'Pendiente por despachar', 'Producido', '% producido', 'Listo sin despachar', 'Fecha término'];
  const rows = filasDim.map((f) => [
    f.nvNumero, f.cliente, f.fecCreacion ? f.fecCreacion.toLocaleDateString('es-CL') : '', f.producto || 'SIN IDENTIFICAR', f.trabajo, f.codDim,
    f.totalSolicitado, f.despachado, Math.max(0, f.totalSolicitado - f.despachado), f.producido,
    f.totalSolicitado ? Math.round((f.producido / f.totalSolicitado) * 1000) / 10 : '',
    Math.max(0, f.producido - f.despachado),
    f.fechaTermino || '',
  ]);
  const ws = window.XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Programacion DIM');
  window.XLSX.writeFile(wb, `produccion_dim_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

async function onGuardarCambios() {
  if (!cambios.size) return;
  if (!getGhToken()) {
    msg('prod-guardar-estado', 'Falta configurar la conexión con GitHub — hazlo una vez en el dashboard principal (⚙ Administración).', false);
    return;
  }
  const btn = document.getElementById('prod-guardar-btn');
  btn.disabled = true;
  msg('prod-guardar-estado', 'Guardando…');
  try {
    const nuevo = { ...progresoBase };
    cambios.forEach((cambio, key) => {
      nuevo[key] = { ...(nuevo[key] || {}), ...cambio, actualizado: new Date().toISOString() };
    });
    await guardarProgresoPublicado(nuevo);
    progresoBase = nuevo;
    cambios.clear();
    renderTablaCanastillo(filasCanastillo);
    renderTablaDim(filasDim);
    actualizarBotonGuardar();
    msg('prod-guardar-estado', 'Guardado. GitHub Pages puede tardar uno o dos minutos en mostrar la versión nueva.', true);
  } catch (err) {
    msg('prod-guardar-estado', 'No se pudo guardar: ' + err.message, false);
    actualizarBotonGuardar();
  }
}

async function iniciar() {
  setupToggle('prod-detalle-toggle', 'prod-tabla-wrap');
  setupToggle('prod-dim-detalle-toggle', 'prod-dim-tabla-wrap');
  setupToggle('prod-resumen-medida-toggle', 'prod-resumen-medida-wrap');
  setupToggle('prod-dim-resumen-toggle', 'prod-dim-resumen-wrap');
  document.getElementById('prod-guardar-btn')?.addEventListener('click', onGuardarCambios);
  document.getElementById('prod-export-btn')?.addEventListener('click', exportarExcelCanastillo);
  document.getElementById('prod-dim-export-btn')?.addEventListener('click', exportarExcelDim);
  document.getElementById('prod-resumen-medida-export-btn')?.addEventListener('click', exportarExcelResumenMedida);
  document.getElementById('prod-dim-resumen-export-btn')?.addEventListener('click', exportarExcelResumenTrabajoDim);

  const [datos, progreso] = await Promise.all([fetchPublishedData(), leerProgresoPublicado()]);
  if (!datos || !datos.nvRecords) {
    document.getElementById('prod-kpis').innerHTML = '<p class="kpi-empty">No se pudieron cargar los datos publicados.</p>';
    document.getElementById('prod-resumen-medida').innerHTML = '';
    document.getElementById('prod-tabla').innerHTML = '';
    document.getElementById('prod-dim-kpis').innerHTML = '';
    document.getElementById('prod-dim-resumen').innerHTML = '';
    document.getElementById('prod-dim-tabla').innerHTML = '';
    document.getElementById('prod-dim-alerta').innerHTML = '';
    return;
  }
  progresoBase = progreso || {};
  filasCanastillo = computeFilasCanastillo(datos.nvRecords, progresoBase);
  filasDim = computeFilasDim(datos.nvRecords, progresoBase);

  renderKpisCanastillo(filasCanastillo);
  renderResumenMedida(filasCanastillo);
  renderTablaCanastillo(filasCanastillo);

  renderKpisDim(filasDim);
  renderResumenTrabajoDim(filasDim);
  renderTablaDim(filasDim);
  renderAlertaDim(filasDim);

  actualizarBotonGuardar();
}

iniciar();
