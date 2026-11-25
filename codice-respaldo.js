/**
 * Códice — Respaldo automático en una carpeta del teléfono (v1.60).
 *
 * Las notas viven dentro de la app. Acá se elige UNA carpeta (por ejemplo
 * "Documentos/Códice" o la tarjeta SD) y la app copia ahí todo, con las mismas
 * carpetas. Después de cada cambio vuelve a copiar solo lo que cambió.
 *
 * Android (Chrome) se olvida del permiso al cerrar la app: al abrirla aparece
 * una barra «Activar» — un toque y sigue copiando sola durante toda la sesión.
 */
(function () {
  'use strict';

  const KEY = 'respaldo-carpeta';          // clave en el IndexedDB del vault
  const LS_MAN = 'codice-respaldo-manifest'; // { path: mtime } de lo ya copiado
  const LS_LAST = 'codice-respaldo-ultima';
  const LS_OFF = 'codice-respaldo-barra-oculta';

  const R = { handle: null, name: '', activo: false, ocupado: false, pendiente: false, timer: null, pendientes: 0, error: '' };
  window.CodiceRespaldo = R;

  const hayPicker = () => !!window.showDirectoryPicker;
  // `directoryHandle` es una variable global del script principal (let), no window.*
  const vaultActual = () => { try { return directoryHandle; } catch (e) { return null; } };
  const vaultEsInterno = () => { const h = vaultActual(); return !!(h && window.CodiceInterno && CodiceInterno.isInterno(h)); };

  // ---------- guardar / leer la carpeta elegida ----------
  async function idbPut(val) {
    const db = await openVaultIDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(VAULT_IDB_STORE, 'readwrite');
      if (val == null) tx.objectStore(VAULT_IDB_STORE).delete(KEY); else tx.objectStore(VAULT_IDB_STORE).put(val, KEY);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    db.close();
  }
  async function idbGet() {
    const db = await openVaultIDB();
    const v = await new Promise((res, rej) => {
      const r = db.transaction(VAULT_IDB_STORE, 'readonly').objectStore(VAULT_IDB_STORE).get(KEY);
      r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
    });
    db.close();
    return v;
  }
  function manifest() { try { return JSON.parse(localStorage.getItem(LS_MAN) || '{}'); } catch (e) { return {}; } }
  function setManifest(m) { try { localStorage.setItem(LS_MAN, JSON.stringify(m)); } catch (e) {} }

  function haceCuanto(ts) {
    if (!ts) return 'nunca';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'recién';
    const m = Math.round(s / 60);
    if (m < 60) return 'hace ' + m + ' min';
    const h = Math.round(m / 60);
    if (h < 24) return 'hace ' + h + ' h';
    const d = Math.round(h / 24);
    return 'hace ' + d + ' día' + (d === 1 ? '' : 's');
  }

  // ---------- cuántas cosas faltan copiar ----------
  async function calcularPendientes() {
    if (!window.CodiceInterno) return 0;
    const all = await CodiceInterno.listAll();
    const man = manifest();
    let n = 0;
    const vivos = new Set();
    for (const e of all) {
      if (e.kind !== 'file') continue;
      vivos.add(e.path);
      if (man[e.path] !== e.mtime) n++;
    }
    for (const p in man) if (!p.startsWith('d:') && !vivos.has(p)) n++;
    R.pendientes = n;
    return n;
  }

  // ---------- la copia en sí ----------
  async function dirDe(root, parts, crear) {
    let d = root;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create: !!crear });
    return d;
  }

  async function sincronizar(opts) {
    opts = opts || {};
    if (!R.handle || !R.activo || !vaultEsInterno()) return null;
    if (R.ocupado) { R.pendiente = true; return null; }
    R.ocupado = true; R.error = '';
    pintar();
    let escritos = 0, borrados = 0;
    try {
      if (opts.guardarNotaAbierta && typeof silentAutosaveCurrent === 'function') { try { await silentAutosaveCurrent(); } catch (e) {} }
      const all = await CodiceInterno.listAll();
      const man = opts.todo ? {} : manifest();
      const vivos = new Set();
      // carpetas primero (así queda la estructura aunque estén vacías)
      const dirs = all.filter(e => e.kind === 'directory').sort((a, b) => a.path.length - b.path.length);
      for (const d of dirs) {
        vivos.add('d:' + d.path);
        if (man['d:' + d.path]) continue;
        await dirDe(R.handle, d.path.split('/'), true);
        man['d:' + d.path] = 1;
      }
      const files = all.filter(e => e.kind === 'file');
      for (const f of files) {
        vivos.add(f.path);
        if (man[f.path] === f.mtime) continue;
        const blob = await CodiceInterno.readBlob(f.path);
        if (!blob) continue;
        const parts = f.path.split('/');
        const name = parts.pop();
        const dir = await dirDe(R.handle, parts, true);
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
        man[f.path] = f.mtime;
        escritos++;
        if (escritos % 15 === 0) { setManifest(man); if (opts.onProgress) opts.onProgress(escritos); }
      }
      // Notas borradas o renombradas en la app: se borran también de la carpeta,
      // pero SOLO archivos que copió esta app (nunca otros archivos tuyos).
      const notasVivas = files.filter(f => /\.md$/i.test(f.path)).length;
      const notasMan = Object.keys(man).filter(p => /\.md$/i.test(p)).length;
      const seguro = notasVivas >= 3 && notasVivas >= notasMan * 0.5;
      const muertos = Object.keys(man).filter(p => !vivos.has(p));
      if (muertos.length && seguro) {
        for (const p of muertos.filter(p => !p.startsWith('d:'))) {
          const parts = p.split('/'); const name = parts.pop();
          try { const dir = await dirDe(R.handle, parts, false); await dir.removeEntry(name); } catch (e) {}
          delete man[p]; borrados++;
        }
        for (const p of muertos.filter(p => p.startsWith('d:')).sort((a, b) => b.length - a.length)) {
          const parts = p.slice(2).split('/'); const name = parts.pop();
          try { const dir = await dirDe(R.handle, parts, false); await dir.removeEntry(name); } catch (e) {}
          delete man[p];
        }
      }
      setManifest(man);
      const ahora = Date.now();
      try { localStorage.setItem(LS_LAST, String(ahora)); localStorage.setItem('codice-ultima-copia', String(ahora)); } catch (e) {}
      R.pendientes = 0;
      return { escritos, borrados };
    } catch (e) {
      console.warn('Respaldo:', e);
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
        R.activo = false;
        R.error = 'Android pidió de nuevo el permiso.';
      } else if (e && e.name === 'NotFoundError') {
        R.activo = false;
        R.error = 'No encuentro la carpeta «' + R.name + '». ¿La borraste o sacaste la tarjeta SD?';
      } else {
        R.error = 'No se pudo copiar: ' + (e.message || e);
      }
      await calcularPendientes().catch(() => {});
      return null;
    } finally {
      R.ocupado = false;
      pintar();
      if (R.pendiente) { R.pendiente = false; programar(1500); }
    }
  }

  function programar(ms) {
    if (!R.handle) return;
    clearTimeout(R.timer);
    if (!R.activo) { calcularPendientes().then(pintar).catch(() => {}); return; }
    R.timer = setTimeout(() => sincronizar(), ms == null ? 2500 : ms);
  }

  // ---------- acciones del usuario ----------
  async function activar() {
    if (!R.handle) return false;
    let p = 'denied';
    try {
      p = await R.handle.queryPermission({ mode: 'readwrite' });
      if (p !== 'granted') p = await R.handle.requestPermission({ mode: 'readwrite' });
    } catch (e) { p = 'denied'; }
    R.activo = p === 'granted';
    pintar();
    if (R.activo) {
      const r = await sincronizar({ guardarNotaAbierta: true });
      if (r && window.codiceToast) codiceToast('✔ Respaldo al día en «' + R.name + '»' + (r.escritos ? ' (' + r.escritos + ' archivos copiados)' : '') + '.', 4000);
    }
    return R.activo;
  }

  async function elegirCarpeta() {
    const msg = document.getElementById('copias-msg');
    if (!hayPicker()) { msg.textContent = 'Este navegador no permite elegir carpetas. Usá «Descargar copia completa».'; return; }
    if (!vaultEsInterno()) { msg.textContent = 'El respaldo automático funciona cuando el Códice está guardado en la app.'; return; }
    const ok = confirm('Elegí (o creá) una carpeta para el respaldo, por ejemplo «Documentos/Códice» o una carpeta en la tarjeta SD.\n\n' +
      'La app va a copiar ahí todas tus notas y fotos, con las mismas carpetas (0 Folio Cero, 1 Botánica…). ' +
      'Después, cada vez que escribas o cambies algo, se copia solo.\n\n' +
      'Si elegís tu carpeta vieja del Códice, las notas que tengan el mismo nombre se actualizan con la versión de la app. Los demás archivos de esa carpeta no se tocan.');
    if (!ok) return;
    let h;
    try { h = await window.showDirectoryPicker({ id: 'codice-respaldo', mode: 'readwrite', startIn: 'documents' }); } catch (e) { return; }
    R.handle = h; R.name = h.name; R.activo = true;
    try { await idbPut({ handle: h, name: h.name, desde: Date.now() }); } catch (e) { console.warn(e); }
    setManifest({});
    try { localStorage.removeItem(LS_OFF); } catch (e) {}
    msg.textContent = 'Copiando todo a «' + h.name + '»…';
    const r = await sincronizar({ todo: true, guardarNotaAbierta: true, onProgress: n => { msg.textContent = 'Copiando… ' + n + ' archivos'; } });
    msg.textContent = r ? '✔ Listo: ' + r.escritos + ' archivos copiados en «' + h.name + '». Desde ahora se copia solo.' : ('✖ ' + (R.error || 'No se pudo copiar.'));
    pintar();
  }

  async function copiarTodoDeNuevo() {
    const msg = document.getElementById('copias-msg');
    if (!R.activo && !(await activar())) { msg.textContent = 'Hace falta dar permiso a la carpeta.'; return; }
    msg.textContent = 'Copiando todo de nuevo…';
    const r = await sincronizar({ todo: true, guardarNotaAbierta: true, onProgress: n => { msg.textContent = 'Copiando… ' + n + ' archivos'; } });
    msg.textContent = r ? '✔ ' + r.escritos + ' archivos copiados en «' + R.name + '».' : ('✖ ' + (R.error || 'No se pudo copiar.'));
  }

  async function desactivar() {
    if (!confirm('¿Dejar de copiar automáticamente a «' + R.name + '»?\n\nLo que ya está copiado en la carpeta queda ahí, no se borra nada.')) return;
    R.handle = null; R.name = ''; R.activo = false; R.pendientes = 0;
    try { await idbPut(null); } catch (e) {}
    setManifest({});
    pintar();
  }

  // ---------- interfaz ----------
  function barra() {
    let b = document.getElementById('respaldo-bar');
    if (!b) {
      b = document.createElement('div');
      b.id = 'respaldo-bar';
      b.setAttribute('role', 'status');
      b.innerHTML = '<span></span><button type="button" class="rb-ok">Activar</button><button type="button" class="rb-x" title="Ocultar" aria-label="Ocultar">✕</button>';
      document.body.appendChild(b);
      b.querySelector('.rb-ok').addEventListener('click', async () => { b.classList.remove('visible'); await activar(); });
      b.querySelector('.rb-x').addEventListener('click', () => {
        b.classList.remove('visible');
        try { sessionStorage.setItem(LS_OFF, '1'); } catch (e) {}
      });
    }
    return b;
  }

  function pintar() {
    // Barra de arriba: solo si hay carpeta elegida pero falta el permiso de hoy
    const b = barra();
    let oculta = false;
    try { oculta = !!sessionStorage.getItem(LS_OFF); } catch (e) {}
    if (R.handle && !R.activo && vaultEsInterno() && !oculta) {
      const n = R.pendientes;
      b.querySelector('span').textContent = '💾 Respaldo en «' + R.name + '» en pausa' +
        (n ? ' · ' + n + ' cambio' + (n === 1 ? '' : 's') + ' sin copiar' : '') + '. Tocá Activar y dale permiso.';
      b.classList.add('visible');
    } else {
      b.classList.remove('visible');
    }
    // Caja dentro de 💾
    const box = document.getElementById('respaldo-box');
    if (!box) return;
    if (!hayPicker() || !vaultEsInterno()) { box.style.display = 'none'; return; }
    box.style.display = '';
    let last = 0;
    try { last = parseInt(localStorage.getItem(LS_LAST) || '0', 10); } catch (e) {}
    if (!R.handle) {
      box.innerHTML = '<p><strong>🔁 Respaldo automático</strong><br>Elegí una carpeta del teléfono y la app copia ahí todas tus notas, con sus carpetas. Después se copia solo cada cambio.</p>' +
        '<button type="button" class="btn-primary" id="rb-elegir">📂 Elegir carpeta de respaldo</button>';
    } else {
      const estado = R.ocupado ? '⏳ Copiando…' :
        (R.activo ? '✅ Activo: cada cambio se copia solo.' : '⏸ En pausa hasta que des permiso.');
      box.innerHTML = '<p><strong>🔁 Respaldo automático en «' + esc(R.name) + '»</strong><br>' + estado +
        '<br>Última copia: ' + haceCuanto(last) +
        (R.pendientes && !R.activo ? ' · ' + R.pendientes + ' cambio' + (R.pendientes === 1 ? '' : 's') + ' sin copiar' : '') +
        (R.error ? '<br>⚠ ' + esc(R.error) : '') + '</p>' +
        (R.activo ? '' : '<button type="button" class="btn-primary" id="rb-activar">▶ Activar ahora</button>') +
        '<div class="respaldo-row">' +
        '<button type="button" class="btn-secondary" id="rb-todo">⟳ Copiar todo de nuevo</button>' +
        '<button type="button" class="btn-secondary" id="rb-cambiar">📂 Cambiar carpeta</button>' +
        '<button type="button" class="btn-secondary" id="rb-quitar">✕ Dejar de copiar</button></div>';
    }
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    on('rb-elegir', elegirCarpeta);
    on('rb-cambiar', elegirCarpeta);
    on('rb-activar', activar);
    on('rb-todo', copiarTodoDeNuevo);
    on('rb-quitar', desactivar);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---------- arranque ----------
  async function iniciar() {
    // El botón viejo «Guardar todo en una carpeta» queda reemplazado por el respaldo automático
    const viejo = document.getElementById('btn-guardar-carpeta');
    if (viejo) viejo.style.display = 'none';
    let rec = null;
    try { rec = await idbGet(); } catch (e) {}
    if (rec && rec.handle) {
      R.handle = rec.handle; R.name = rec.name || rec.handle.name;
      try { R.activo = (await R.handle.queryPermission({ mode: 'readwrite' })) === 'granted'; } catch (e) { R.activo = false; }
    }
    // esperar a que abra el Códice interno
    for (let i = 0; i < 40 && !vaultActual(); i++) await new Promise(r => setTimeout(r, 250));
    if (R.handle) {
      await calcularPendientes().catch(() => {});
      if (R.activo) programar(1000);
    }
    pintar();
  }

  window.addEventListener('codice-interno-write', () => programar());
  window.addEventListener('codice-interno-remove', () => programar());
  document.addEventListener('visibilitychange', () => {
    // al salir de la app, copiar ya lo que falte
    if (document.visibilityState === 'hidden' && R.activo) { clearTimeout(R.timer); setTimeout(() => sincronizar(), 400); }
  });
  // refrescar la caja cuando se abre 💾
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest && e.target.closest('#btn-copias, #btn-copias-main, #toast-copia');
    if (t) setTimeout(() => { calcularPendientes().then(pintar).catch(pintar); }, 50);
  }, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
  Object.assign(R, { sincronizar, activar, elegirCarpeta, copiarTodoDeNuevo, desactivar, pintar, calcularPendientes });
})();
