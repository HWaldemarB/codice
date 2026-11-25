/**
 * Códice Interno — almacenamiento permanente dentro del teléfono (IndexedDB)
 * Imita la API de carpetas (FileSystemDirectoryHandle) para que todo el Códice
 * funcione igual que con una carpeta real, aunque el navegador (Android) no
 * permita abrir carpetas.
 *
 * También: copia completa (.zip) / restaurar, almacenamiento persistente
 * y registro del service worker (modo sin conexión).
 */
(function () {
  'use strict';

  const DB_NAME = 'codice-interno';
  const DB_VERSION = 1;
  const STORE = 'entries';
  const ROOT_NAME = 'Códice';

  let _dbPromise = null;
  function db() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB no disponible')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          const s = d.createObjectStore(STORE, { keyPath: 'path' });
          s.createIndex('parent', 'parent', { unique: false });
        }
      };
      req.onsuccess = () => {
        const d = req.result;
        d.onversionchange = () => { try { d.close(); } catch (e) {} _dbPromise = null; };
        resolve(d);
      };
      req.onerror = () => { _dbPromise = null; reject(req.error); };
    });
    return _dbPromise;
  }

  function reqP(r) {
    return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
  function txDone(tx) {
    return new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error('Transacción abortada'));
    });
  }
  async function getEntry(path) {
    const d = await db();
    return reqP(d.transaction(STORE, 'readonly').objectStore(STORE).get(path));
  }
  async function putEntry(rec) {
    const d = await db();
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    await txDone(tx);
  }
  async function childrenOf(path) {
    const d = await db();
    const idx = d.transaction(STORE, 'readonly').objectStore(STORE).index('parent');
    return reqP(idx.getAll(path));
  }
  async function allEntries() {
    const d = await db();
    return reqP(d.transaction(STORE, 'readonly').objectStore(STORE).getAll());
  }

  function join(parent, name) { return parent ? parent + '/' + name : name; }
  function domErr(name, msg) {
    try { return new DOMException(msg || name, name); } catch (e) { const er = new Error(msg || name); er.name = name; return er; }
  }
  function checkName(name) {
    name = String(name == null ? '' : name);
    if (!name || name === '.' || name === '..' || /[\/\\]/.test(name)) throw new TypeError('Nombre inválido: ' + name);
    return name;
  }
  function mimeFor(name) {
    const n = name.toLowerCase();
    if (n.endsWith('.md')) return 'text/markdown';
    if (n.endsWith('.txt')) return 'text/plain';
    if (/\.jpe?g$/.test(n)) return 'image/jpeg';
    if (n.endsWith('.png')) return 'image/png';
    if (n.endsWith('.gif')) return 'image/gif';
    if (n.endsWith('.webp')) return 'image/webp';
    if (n.endsWith('.svg')) return 'image/svg+xml';
    if (n.endsWith('.bmp')) return 'image/bmp';
    if (n.endsWith('.json')) return 'application/json';
    return 'application/octet-stream';
  }

  async function toBlobPart(data) {
    if (data == null) return '';
    if (typeof data === 'string') return data;
    if (data instanceof Blob) return data;
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) return data;
    if (typeof data === 'object' && data.type) {
      // {type:'write', data} — se ignora position (escritura secuencial)
      if (data.type === 'write') return toBlobPart(data.data);
      return null;
    }
    return String(data);
  }

  class InternoWritable {
    constructor(fileHandle, keep, existing) {
      this._h = fileHandle;
      this._parts = keep && existing ? [existing] : [];
      this._closed = false;
    }
    async write(data) {
      if (this._closed) throw domErr('InvalidStateError', 'Escritura cerrada');
      if (data && typeof data === 'object' && !(data instanceof Blob) && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) {
        if (data.type === 'truncate') {
          const size = data.size | 0;
          const b = new Blob(this._parts);
          this._parts = [b.slice(0, size)];
          return;
        }
        if (data.type === 'seek') return;
      }
      const p = await toBlobPart(data);
      if (p !== null) this._parts.push(p);
    }
    async truncate(size) { return this.write({ type: 'truncate', size: size }); }
    async seek() {}
    async abort() { this._closed = true; this._parts = []; }
    async close() {
      if (this._closed) return;
      this._closed = true;
      const blob = new Blob(this._parts, { type: mimeFor(this._h.name) });
      const rec = await getEntry(this._h._path);
      const parent = this._h._parent;
      await putEntry({
        path: this._h._path, parent: parent, name: this._h.name, kind: 'file',
        data: blob, mtime: Date.now(), ctime: (rec && rec.ctime) || Date.now()
      });
      try { window.dispatchEvent(new CustomEvent('codice-interno-write', { detail: { path: this._h._path } })); } catch (e) {}
    }
  }

  class InternoFileHandle {
    constructor(path, parent, name) {
      this.kind = 'file'; this.name = name; this._path = path; this._parent = parent; this.__codiceInterno = true;
    }
    async getFile() {
      const rec = await getEntry(this._path);
      if (!rec || rec.kind !== 'file') throw domErr('NotFoundError', 'No existe: ' + this._path);
      const data = rec.data instanceof Blob ? rec.data : new Blob([rec.data || '']);
      return new File([data], this.name, { type: data.type || mimeFor(this.name), lastModified: rec.mtime || Date.now() });
    }
    async createWritable(opts) {
      const keep = !!(opts && opts.keepExistingData);
      let existing = null;
      if (keep) { try { existing = await this.getFile(); } catch (e) {} }
      return new InternoWritable(this, keep, existing);
    }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
    async isSameEntry(o) { return !!(o && o.__codiceInterno && o.kind === this.kind && o._path === this._path); }
  }

  class InternoDirHandle {
    constructor(path, parent, name) {
      this.kind = 'directory'; this.name = name; this._path = path; this._parent = parent; this.__codiceInterno = true;
    }
    _handleFor(rec) {
      return rec.kind === 'directory'
        ? new InternoDirHandle(rec.path, rec.parent, rec.name)
        : new InternoFileHandle(rec.path, rec.parent, rec.name);
    }
    async *entries() {
      const kids = await childrenOf(this._path);
      kids.sort((a, b) => a.name.localeCompare(b.name));
      for (const k of kids) yield [k.name, this._handleFor(k)];
    }
    async *values() { for await (const [, h] of this.entries()) yield h; }
    async *keys() { for await (const [n] of this.entries()) yield n; }
    [Symbol.asyncIterator]() { return this.entries(); }

    async getFileHandle(name, opts) {
      name = checkName(name);
      const path = join(this._path, name);
      const rec = await getEntry(path);
      if (rec) {
        if (rec.kind !== 'file') throw domErr('TypeMismatchError', name + ' es una carpeta');
        return new InternoFileHandle(path, this._path, name);
      }
      if (!(opts && opts.create)) throw domErr('NotFoundError', 'No existe: ' + path);
      const now = Date.now();
      await putEntry({ path, parent: this._path, name, kind: 'file', data: new Blob([], { type: mimeFor(name) }), mtime: now, ctime: now });
      return new InternoFileHandle(path, this._path, name);
    }
    async getDirectoryHandle(name, opts) {
      name = checkName(name);
      const path = join(this._path, name);
      const rec = await getEntry(path);
      if (rec) {
        if (rec.kind !== 'directory') throw domErr('TypeMismatchError', name + ' es un archivo');
        return new InternoDirHandle(path, this._path, name);
      }
      if (!(opts && opts.create)) throw domErr('NotFoundError', 'No existe: ' + path);
      const now = Date.now();
      await putEntry({ path, parent: this._path, name, kind: 'directory', mtime: now, ctime: now });
      return new InternoDirHandle(path, this._path, name);
    }
    async removeEntry(name, opts) {
      name = checkName(name);
      const path = join(this._path, name);
      const rec = await getEntry(path);
      if (!rec) throw domErr('NotFoundError', 'No existe: ' + path);
      const d = await db();
      if (rec.kind === 'directory') {
        const all = await allEntries();
        const desc = all.filter(e => e.path.startsWith(path + '/'));
        if (desc.length && !(opts && opts.recursive)) throw domErr('InvalidModificationError', 'La carpeta no está vacía');
        const tx = d.transaction(STORE, 'readwrite');
        const st = tx.objectStore(STORE);
        desc.forEach(e => st.delete(e.path));
        st.delete(path);
        await txDone(tx);
      } else {
        const tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(path);
        await txDone(tx);
      }
    }
    async resolve(child) {
      if (!child || !child._path) return null;
      if (this._path === '') return child._path.split('/');
      if (child._path === this._path) return [];
      if (child._path.startsWith(this._path + '/')) return child._path.slice(this._path.length + 1).split('/');
      return null;
    }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
    async isSameEntry(o) { return !!(o && o.__codiceInterno && o.kind === this.kind && o._path === this._path); }
  }

  async function root() {
    await db();
    return new InternoDirHandle('', null, ROOT_NAME);
  }

  async function stats() {
    const all = await allEntries();
    let notas = 0, archivos = 0, bytes = 0;
    all.forEach(e => {
      if (e.kind !== 'file') return;
      archivos++;
      if (e.name.toLowerCase().endsWith('.md')) notas++;
      if (e.data && e.data.size) bytes += e.data.size;
    });
    return { notas, archivos, bytes };
  }

  // ===== Copias de seguridad (.zip) — funcionan con cualquier carpeta (interna o real) =====
  async function collectFiles(dirHandle, prefix, out) {
    for await (const entry of dirHandle.values()) {
      const p = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.kind === 'directory') {
        out.dirs.push(p);
        await collectFiles(entry, p, out);
      } else {
        out.files.push({ path: p, handle: entry });
      }
    }
    return out;
  }

  function stamp() {
    const d = new Date();
    const z = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + '_' + z(d.getHours()) + z(d.getMinutes());
  }

  async function downloadBlob(blob, filename) {
    // En Android, intentar "Compartir" (Drive, WhatsApp, correo…) si el usuario lo prefiere
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  }

  async function exportZip(dirHandle, opts) {
    opts = opts || {};
    if (typeof JSZip === 'undefined') throw new Error('Falta la librería de copias (JSZip).');
    const out = await collectFiles(dirHandle, '', { files: [], dirs: [] });
    const zip = new JSZip();
    out.dirs.forEach(p => zip.folder(p));
    for (const f of out.files) {
      try {
        const file = await f.handle.getFile();
        zip.file(f.path, file, { date: new Date(file.lastModified || Date.now()) });
      } catch (e) { console.warn('No se pudo leer', f.path, e); }
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const filename = 'Codice-copia_' + stamp() + '.zip';
    const notas = out.files.filter(f => f.path.toLowerCase().endsWith('.md')).length;
    let shared = false;
    if (opts.share && navigator.canShare) {
      try {
        const file = new File([blob], filename, { type: 'application/zip' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'Copia del Códice', text: 'Copia completa del Códice (' + notas + ' notas)' });
          shared = true;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return { cancelled: true };
      }
    }
    if (!shared) await downloadBlob(blob, filename);
    try { localStorage.setItem('codice-ultima-copia', String(Date.now())); } catch (e) {}
    return { filename, notas, archivos: out.files.length, bytes: blob.size, shared };
  }

  async function ensureDirPath(rootHandle, parts) {
    let d = rootHandle;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
    return d;
  }

  const SKIP_RE = /(^|\/)(\.obsidian|\.trash|\.git|__MACOSX)(\/|$)|(^|\/)\.DS_Store$|(^|\/)\._/;

  /** Importa un .zip (copia del Códice o vault de Obsidian comprimido) dentro de dirHandle. */
  async function importZip(dirHandle, zipFile, onProgress) {
    if (typeof JSZip === 'undefined') throw new Error('Falta la librería de copias (JSZip).');
    const zip = await JSZip.loadAsync(zipFile);
    let names = Object.keys(zip.files).filter(n => !SKIP_RE.test(n));
    // Si todo está dentro de una única carpeta raíz (ej. "MiVault/…"), quitarla
    const tops = new Set(names.map(n => n.split('/')[0]));
    let strip = '';
    if (tops.size === 1) {
      const t = [...tops][0];
      const hasRootFiles = names.some(n => !n.includes('/') && !zip.files[n].dir);
      const looksCodice = /^(Folio|Tomo|Aduana|GuIA)/i.test(t);
      if (!hasRootFiles && !looksCodice) strip = t + '/';
    }
    const files = names.filter(n => !zip.files[n].dir);
    let done = 0, notas = 0;
    for (const n of names) {
      if (!zip.files[n].dir) continue;
      const rel = strip && n.startsWith(strip) ? n.slice(strip.length) : n;
      const parts = rel.split('/').filter(Boolean);
      if (parts.length) await ensureDirPath(dirHandle, parts);
    }
    for (const n of files) {
      const rel = strip && n.startsWith(strip) ? n.slice(strip.length) : n;
      const parts = rel.split('/').filter(Boolean);
      if (!parts.length) continue;
      const fname = parts.pop();
      const dir = await ensureDirPath(dirHandle, parts);
      const data = await zip.files[n].async('blob');
      const fh = await dir.getFileHandle(fname, { create: true });
      const w = await fh.createWritable();
      await w.write(data);
      await w.close();
      if (fname.toLowerCase().endsWith('.md')) notas++;
      done++;
      if (onProgress && (done % 10 === 0 || done === files.length)) onProgress(done, files.length);
    }
    return { archivos: done, notas };
  }

  /** Importa archivos sueltos (.md / imágenes) dentro de una subcarpeta. */
  async function importLooseFiles(dirHandle, fileList, subfolder) {
    let dir = dirHandle;
    if (subfolder) dir = await dirHandle.getDirectoryHandle(subfolder, { create: true });
    let n = 0;
    for (const f of fileList) {
      // webkitRelativePath conserva subcarpetas si se eligió una carpeta
      const rel = (f.webkitRelativePath || f.name).split('/').filter(Boolean);
      if (f.webkitRelativePath && rel.length > 1) rel.shift();
      if (rel.some(p => /^(\.obsidian|\.trash|\.git)$/.test(p))) continue;
      const fname = rel.pop();
      const d = rel.length ? await ensureDirPath(dir, rel) : dir;
      const fh = await d.getFileHandle(fname, { create: true });
      const w = await fh.createWritable();
      await w.write(f);
      await w.close();
      n++;
    }
    return n;
  }

  async function requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        const already = await navigator.storage.persisted();
        if (already) return true;
        return await navigator.storage.persist();
      }
    } catch (e) {}
    return false;
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then(reg => {
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              window.dispatchEvent(new CustomEvent('codice-update-ready'));
            }
          });
        });
      }).catch(err => console.warn('SW no registrado:', err));
    });
  }

  window.CodiceInterno = {
    root, stats, exportZip, importZip, importLooseFiles, requestPersistence,
    isInterno: h => !!(h && h.__codiceInterno),
    ROOT_NAME
  };

  registerSW();
})();
