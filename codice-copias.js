/**
 * Códice — UI de Códice interno + copias de seguridad.
 * Se carga después del script principal: usa sus globales
 * (directoryHandle, notes, activateVaultFromHandle, ensureVaultStructure, renderTree…).
 */

/** Activa el Códice interno (almacenamiento permanente dentro de este dispositivo). */
async function useInternalVault(firstRun) {
  const root = await CodiceInterno.root();
  const st = await CodiceInterno.stats();
  await activateVaultFromHandle(root, { offerStructure: false });
  if (firstRun && st.archivos === 0) {
    // Primera vez: crear la estructura del Códice sin preguntar (no borra nada)
    try { await ensureVaultStructure(); } catch (e) { console.warn(e); }
    renderTree();
  }
  refreshEmptyStateForMode();
}

async function codiceInternoAutostart(rec) {
  if (!window.CodiceInterno) return;
  try {
    CodiceInterno.requestPersistence().then(ok => { window.__codicePersistente = ok; });
    if (rec && rec.interno) {
      await activateVaultFromHandle(rec.handle, { offerStructure: false });
    } else if (!window.showDirectoryPicker && !rec) {
      await useInternalVault(true);
    }
    refreshEmptyStateForMode();
    setTimeout(maybeRemindBackup, 2500);
  } catch (e) { console.warn('Códice interno:', e); }
}

function refreshEmptyStateForMode() {
  const msg = document.getElementById('empty-msg');
  const warn = document.getElementById('iframe-warn');
  const isInt = directoryHandle && window.CodiceInterno && CodiceInterno.isInterno(directoryHandle);
  if (isInt) {
    if (warn) warn.style.display = 'none';
    if (msg) msg.innerHTML = 'Tus notas se guardan en este teléfono, también sin señal.<br>Tocá ☰ para ver las carpetas o ＋ para una nota nueva.';
  }
}

function codiceToast(html, ms) {
  let t = document.getElementById('codice-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'codice-toast';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.innerHTML = html;
  t.classList.add('visible');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('visible'), ms || 4000);
  t.onclick = () => t.classList.remove('visible');
}

function diasDesdeUltimaCopia() {
  let v = 0;
  try { v = parseInt(localStorage.getItem('codice-ultima-copia') || '0', 10); } catch (e) {}
  if (!v) return null;
  return Math.floor((Date.now() - v) / 86400000);
}

function maybeRemindBackup() {
  if (!directoryHandle || !CodiceInterno.isInterno(directoryHandle)) return;
  if (notes.size < 3) return;
  const d = diasDesdeUltimaCopia();
  if (d === null || d >= 7) {
    codiceToast('💾 ' + (d === null ? 'Todavía no hiciste una copia del Códice.' : 'Tu última copia es de hace ' + d + ' días.') +
      ' <button type="button" id="toast-copia">Hacer copia</button>', 9000);
    const b = document.getElementById('toast-copia');
    if (b) b.addEventListener('click', (ev) => { ev.stopPropagation(); openCopiasModal(); });
  }
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

async function openCopiasModal(keepMsg) {
  const m = document.getElementById('copias-modal');
  if (!m) return;
  m.classList.add('visible');
  const info = document.getElementById('copias-info');
  const isInt = directoryHandle && CodiceInterno.isInterno(directoryHandle);
  let html = '';
  if (isInt) {
    const st = await CodiceInterno.stats();
    let persist = window.__codicePersistente;
    try { if (navigator.storage && navigator.storage.persisted) persist = await navigator.storage.persisted(); } catch (e) {}
    html += '<p><strong>📱 Guardado en este teléfono</strong></p>';
    html += '<p>' + st.notas + ' notas · ' + (st.archivos - st.notas) + ' otros archivos · ' + fmtBytes(st.bytes) + '</p>';
    html += '<p>' + (persist ? '🔒 Almacenamiento protegido: el teléfono no lo borra solo.' :
      '⚠ Almacenamiento aún no protegido. Instalá el Códice como app (menú ⋮ → «Instalar app» o «Agregar a pantalla principal»).') + '</p>';
  } else if (directoryHandle) {
    html += '<p><strong>📂 Carpeta abierta: «' + (directoryHandle.name || '') + '»</strong></p>';
  } else {
    html += '<p>No hay ningún Códice abierto.</p>';
  }
  const d = diasDesdeUltimaCopia();
  html += '<p>Última copia: ' + (d === null ? 'nunca' : (d === 0 ? 'hoy' : 'hace ' + d + ' día' + (d === 1 ? '' : 's'))) + '</p>';
  info.innerHTML = html;
  document.getElementById('btn-copia-share').style.display = (navigator.canShare ? '' : 'none');
  document.getElementById('btn-usar-interno').style.display = isInt ? 'none' : '';
  if (!keepMsg) document.getElementById('copias-msg').textContent = '';
}

function closeCopiasModal() {
  const m = document.getElementById('copias-modal');
  if (m) m.classList.remove('visible');
}

async function hacerCopia(share) {
  const msg = document.getElementById('copias-msg');
  if (!directoryHandle) { msg.textContent = 'Primero abrí un Códice.'; return; }
  try {
    if (typeof silentAutosaveCurrent === 'function') { try { await silentAutosaveCurrent(); } catch (e) {} }
    msg.textContent = 'Preparando copia…';
    const r = await CodiceInterno.exportZip(directoryHandle, { share: !!share });
    if (r.cancelled) { msg.textContent = 'Copia cancelada.'; return; }
    msg.textContent = '✔ Copia lista: ' + r.notas + ' notas (' + fmtBytes(r.bytes) + ')' +
      (r.shared ? '.' : ' · quedó en Descargas: ' + r.filename);
    openCopiasModal(true);
  } catch (e) {
    console.error(e);
    msg.textContent = '✖ No se pudo hacer la copia: ' + (e.message || e);
  }
}

async function restaurarCopia(file) {
  const msg = document.getElementById('copias-msg');
  if (!file) return;
  if (!directoryHandle) await useInternalVault(false);
  const ok = confirm('¿Importar «' + file.name + '» dentro del Códice abierto?\n\n' +
    'Se agregan las notas y fotos de la copia. Si una nota ya existe con el mismo nombre y carpeta, se reemplaza por la de la copia.\n\nNo se borra nada más.');
  if (!ok) return;
  try {
    msg.textContent = 'Importando…';
    const r = await CodiceInterno.importZip(directoryHandle, file, (n, t) => { msg.textContent = 'Importando… ' + n + ' / ' + t; });
    await activateVaultFromHandle(directoryHandle, { offerStructure: false });
    refreshEmptyStateForMode();
    msg.textContent = '✔ Importadas ' + r.notas + ' notas (' + r.archivos + ' archivos en total).';
    openCopiasModal(true);
  } catch (e) {
    console.error(e);
    msg.textContent = '✖ No se pudo importar: ' + (e.message || e);
  }
}

async function importarSueltos(files) {
  const msg = document.getElementById('copias-msg');
  if (!files || !files.length) return;
  if (!directoryHandle) await useInternalVault(false);
  try {
    msg.textContent = 'Importando…';
    const n = await CodiceInterno.importLooseFiles(directoryHandle, Array.from(files), '');
    await activateVaultFromHandle(directoryHandle, { offerStructure: false });
    refreshEmptyStateForMode();
    msg.textContent = '✔ Importados ' + n + ' archivos.';
    openCopiasModal(true);
  } catch (e) {
    console.error(e);
    msg.textContent = '✖ No se pudo importar: ' + (e.message || e);
  }
}

function initCopiasUI() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('btn-copias', () => openCopiasModal());
  on('btn-copias-main', () => openCopiasModal());
  on('btn-copias-close', closeCopiasModal);
  on('btn-copia-zip', () => hacerCopia(false));
  on('btn-copia-share', () => hacerCopia(true));
  on('btn-copia-restore', () => { const i = document.getElementById('copias-zip-input'); i.value = ''; i.click(); });
  on('btn-copia-sueltos', () => { const i = document.getElementById('copias-files-input'); i.value = ''; i.click(); });
  on('btn-usar-interno', async () => {
    if (!confirm('¿Usar el Códice guardado dentro de este dispositivo?\n\nLa carpeta actual no se modifica. Para pasar tus notas: hacé una copia (.zip) acá y después restaurala en el Códice interno.')) return;
    await useInternalVault(true);
    openCopiasModal();
  });
  const zi = document.getElementById('copias-zip-input');
  if (zi) zi.addEventListener('change', (e) => restaurarCopia(e.target.files && e.target.files[0]));
  const fi = document.getElementById('copias-files-input');
  if (fi) fi.addEventListener('change', (e) => importarSueltos(e.target.files));
  const m = document.getElementById('copias-modal');
  if (m) m.addEventListener('click', (e) => { if (e.target === m) closeCopiasModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCopiasModal(); });
  window.addEventListener('codice-update-ready', () => {
    codiceToast('✨ Hay una versión nueva del Códice. <button type="button" id="toast-reload">Actualizar</button>', 15000);
    const b = document.getElementById('toast-reload');
    if (b) b.addEventListener('click', (ev) => { ev.stopPropagation(); location.reload(); });
  });
  // Antes de que Android cierre/oculte la app, guardar la nota abierta
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && typeof silentAutosaveCurrent === 'function') {
      try { silentAutosaveCurrent(); } catch (e) {}
    }
  });
}

document.addEventListener('DOMContentLoaded', () => { try { initCopiasUI(); } catch (e) { console.warn(e); } });
