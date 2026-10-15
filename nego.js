'use strict';
/* Negociación: documentos propios, comparador sin conexión, calculadora de costes y análisis con Claude.
   Se carga antes que app.js; solo usa funciones de app.js dentro de funciones (no al cargar). */

function lawColor(l) { return /^D\d+$/.test(l) ? 'var(--doc)' : `var(--${l === 'CONV' ? 'conv' : String(l).toLowerCase()})`; }
const KIND = { convenio: 'Convenio de otra empresa o sector', oferta: 'Oferta o propuesta de la empresa', acta: 'Acta o acuerdo', otro: 'Otro documento' };
const fmtE = n => (Math.round(n)).toLocaleString('es-ES') + ' €';
const fmtP = (n, d = 1) => (n >= 0 ? '+' : '') + n.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }) + ' %';
const num = v => { const x = parseFloat(String(v).replace(/\./g, '').replace(',', '.')); return isFinite(x) ? x : 0; };
const pnum = v => { const x = parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : 0; };
const list = v => String(v || '').split(/[\/;\s]+/).map(x => x.trim()).filter(Boolean).map(pnum);

/* ---------- IndexedDB para documentos ---------- */
const IDB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      if (!('indexedDB' in window)) return rej(new Error('Este navegador no guarda documentos'));
      const r = indexedDB.open('asesor-convenio', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('docs', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  run(mode, fn) {
    return this.open().then(db => new Promise((res, rej) => {
      const t = db.transaction('docs', mode); const req = fn(t.objectStore('docs'));
      t.oncomplete = () => res(req ? req.result : undefined); t.onerror = () => rej(t.error);
    }));
  }
};
async function loadUserDocs() {
  const all = await IDB.run('readonly', s => s.getAll());
  USERDOCS.length = 0;
  (all || []).sort((a, b) => +a.id.slice(1) - +b.id.slice(1)).forEach(d => { d.arts = chunkDoc(d.text, d); USERDOCS.push(d); });
}
async function saveUserDoc(doc) {
  if (!doc.id || USERDOCS.some(d => d.id === doc.id && d.text !== doc.text)) {
    const max = USERDOCS.reduce((m, d) => Math.max(m, +d.id.slice(1)), 0); doc.id = 'D' + (max + 1);
  }
  const rec = { id: doc.id, name: doc.name, full: doc.full || doc.name, kind: doc.kind || 'otro', added: doc.added || Date.now(), text: doc.text };
  await IDB.run('readwrite', s => s.put(rec));
  rec.arts = chunkDoc(rec.text, rec);
  const i = USERDOCS.findIndex(d => d.id === rec.id); if (i >= 0) USERDOCS[i] = rec; else USERDOCS.push(rec);
  return rec;
}
async function deleteUserDoc(id) { await IDB.run('readwrite', s => s.delete(id)); const i = USERDOCS.findIndex(d => d.id === id); if (i >= 0) USERDOCS.splice(i, 1); }
async function clearUserDocs() { try { await IDB.run('readwrite', s => s.clear()); } catch (e) { } USERDOCS.length = 0; }

/* ---------- texto: limpieza y troceo en artículos ---------- */
const HEADLINE = /^(?:Art[íi]culo|ART[ÍI]CULO|Art\.|CAP[ÍI]TULO|Cap[íi]tulo|T[ÍI]TULO|T[íi]tulo|Disposici[óo]n|DISPOSICI[ÓO]N|DISPOSICIONES|Disposiciones|ANEXO|Anexo|[a-zñ]\)|\d{1,2}[.)º]\s|\d{1,2}\.\d|[•\-–—]\s)/;
function cleanText(raw) {
  let t = String(raw).replace(/\r\n?/g, '\n').replace(/­/g, '').replace(/[•●▪]/g, '• ').replace(/\t/g, ' ');
  const lines = t.split('\n').map(l => l.replace(/\s+$/, '').replace(/ {2,}/g, ' '));
  const keep = lines.filter(l => !/^\s*(p[áa]g(ina)?\.?\s*)?\d{1,3}(\s*(de|\/)\s*\d{1,3})?\s*$/i.test(l) && !/^\s*(BOB|BOE|BOPV|cve:|Verificable en|https?:\/\/|Bizkaiko Aldizkari|Boletín Oficial de Bizkaia\s*$|— \d+ —)/i.test(l));
  const paras = []; let cur = '';
  for (const raw of keep) {
    const l = raw.trim();
    if (!l) { if (cur) { paras.push(cur); cur = ''; } continue; }
    if (!cur) { cur = l; continue; }
    if (cur.length < 130 && /^(?:Art[íi]culo|ART[ÍI]CULO)\s*\d+/.test(cur) && !/^(?:Art[íi]culo|ART[ÍI]CULO)\s*\d+\s*[.ºª°:\-–—]*\s*$/.test(cur)) { paras.push(cur); cur = l; continue; }
    if (/[a-záéíóúñ]-$/.test(cur)) { cur = cur.slice(0, -1) + l; continue; }
    if (/[.:;!?»)]$/.test(cur) || HEADLINE.test(l)) { paras.push(cur); cur = l; continue; }
    cur += ' ' + l;
  }
  if (cur) paras.push(cur);
  return paras.join('\n');
}
function packParts(paras, max = 2300) {
  const parts = []; let buf = [];
  const flush = () => { if (buf.length) { parts.push({ text: buf.join('\n'), ap: '' }); buf = []; } };
  paras.forEach(p => {
    while (p.length > max * 1.3) { flush(); const cut = p.lastIndexOf('. ', max) > max * 0.5 ? p.lastIndexOf('. ', max) + 1 : max; parts.push({ text: p.slice(0, cut).trim(), ap: '' }); p = p.slice(cut).trim(); }
    if (buf.join('\n').length + p.length > max && buf.length) flush();
    buf.push(p);
  });
  flush();
  return parts.length ? parts : [{ text: '', ap: '' }];
}
function chunkDoc(text, doc) {
  const paras = cleanText(text).split('\n').filter(Boolean);
  const ART = /^(?:Art[íi]culo|ART[ÍI]CULO|Art\.)\s*(\d{1,3})(?:\s*(bis|ter))?\s*[.ºª°:\-–—]*\s*(.*)$/;
  const OTHER = /^((?:Disposici[óo]n|DISPOSICI[ÓO]N)\s+(?:adicional|transitoria|final|derogatoria|ADICIONAL|TRANSITORIA|FINAL|DEROGATORIA)[^.]{0,40}|(?:ANEXO|Anexo)\s*[IVXLC\d]+)\s*[.:\-–—]*\s*(.*)$/;
  const heads = [];
  let last = 0;
  paras.forEach((p, i) => {
    let m = p.match(ART);
    if (m) {
      const n = +m[1];
      if (n === 1 || n === last + 1 || n === last + 2 || (m[2] && n === last)) { heads.push({ i, num: m[1] + (m[2] ? ' ' + m[2] : ''), rest: m[3] }); last = n; }
      return;
    }
    m = p.match(OTHER);
    if (m && p.length < 400) heads.push({ i, label: m[1].trim(), rest: m[2] });
  });
  const arts = [];
  const mk = (label, num, title, body, key) => {
    let id = `${doc.id}-${key}`; let k = 2; while (arts.some(a => a.id === id)) id = `${doc.id}-${key}-${k++}`;
    arts.push({ ley: doc.id, id, label, num, title, ctx: doc.name + ' · ' + (KIND[doc.kind] || ''), parts: packParts(body) });
  };
  if (heads.filter(h => h.num).length >= 4) {
    if (heads[0].i > 0) { const pre = paras.slice(0, heads[0].i); if (pre.join(' ').length > 200) mk('Preámbulo', null, 'Texto inicial', pre, 'P'); }
    heads.forEach((h, k) => {
      const end = k + 1 < heads.length ? heads[k + 1].i : paras.length;
      let rest = (h.rest || '').trim(), title = '', body = paras.slice(h.i + 1, end);
      const dot = rest.search(/\.(\s|$)/);
      if (rest.length <= 110 && (dot < 0 || dot === rest.length - 1)) title = rest.replace(/\.$/, '');
      else if (dot > 0 && dot <= 110) { title = rest.slice(0, dot); body = [rest.slice(dot + 1).trim(), ...body]; }
      else { title = rest.slice(0, 60) + '…'; body = [rest, ...body]; }
      body = body.filter(Boolean);
      if (body.join(' ').length < 40) return; // índice o encabezado vacío
      if (h.num) mk('Artículo ' + h.num, h.num, title, body, h.num.replace(/\s/g, ''));
      else mk(h.label, null, title, body, 'X' + (k + 1));
    });
  }
  if (!arts.length) {
    const parts = packParts(paras, 2000);
    parts.forEach((p, k) => arts.push({ ley: doc.id, id: `${doc.id}-${k + 1}`, label: 'Parte ' + (k + 1), num: null, title: p.text.slice(0, 70).replace(/\s\S*$/, '') + '…', ctx: doc.name + ' · ' + (KIND[doc.kind] || ''), parts: [p] }));
  }
  return arts;
}

/* ---------- lectura de PDF (pdf.js incluido en la app, funciona sin conexión) ---------- */
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('No se pudo cargar ' + src)); document.head.appendChild(s); }); }
async function pdfText(file, onProg) {
  if (!window.pdfjsLib) await loadScript('lib/pdf.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    const lines = []; let line = '', lastY = null;
    for (const it of tc.items) {
      const y = it.transform ? it.transform[5] : lastY;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && line.trim()) { lines.push(line); line = ''; }
      line += it.str || ''; lastY = y;
      if (it.hasEOL) { if (line.trim()) lines.push(line); line = ''; lastY = null; }
    }
    if (line.trim()) lines.push(line);
    pages.push(lines.join('\n'));
    onProg && onProg(i, pdf.numPages);
  }
  return { text: pages.join('\n'), pages: pdf.numPages };
}

/* ---------- estado de la pestaña Negociar ---------- */
const NS = { sub: 'analizar', task: 'oferta', text: '', docId: '', compare: true, useCost: true, topic: '' };
NS.thread = []; NS.first = null; NS.busy = false;
function nsLoad() { const s = store.get('nego', {}); ['task', 'text', 'docId', 'compare', 'useCost', 'topic'].forEach(k => { if (s[k] !== undefined) NS[k] = s[k]; }); nsLoad.done = true; }
function nsSave() { store.set('nego', { task: NS.task, text: NS.text, docId: NS.docId, compare: NS.compare, useCost: NS.useCost, topic: NS.topic }); }

const SUBS = { analizar: 'Analizar', comparar: 'Comparar', costes: 'Costes', docs: 'Documentos' };
function viewNego(sub) {
  if (!nsLoad.done) nsLoad();
  if (SUBS[sub]) NS.sub = sub;
  setTab('negociar');
  main.innerHTML = `<div class="pills" role="tablist" aria-label="Negociar">${Object.entries(SUBS).map(([k, v]) => `<button type="button" role="tab" data-sub="${k}" aria-pressed="${NS.sub === k}">${v}${k === 'docs' && USERDOCS.length ? ` (${USERDOCS.length})` : ''}</button>`).join('')}</div><div id="nv"></div>`;
  main.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => { location.hash = '#/negociar/' + b.dataset.sub; });
  ({ analizar: nAnalyze, comparar: nCompare, costes: nCosts, docs: nDocs })[NS.sub]();
}

/* ---------- Documentos ---------- */
function nDocs() {
  const v = $('#nv');
  v.innerHTML = `
    <p class="lead" style="margin-top:6px">Mete aquí convenios de otras empresas o del sector, las ofertas que os haga la empresa y actas. Se guardan solo en este dispositivo y entran en el buscador, en el comparador y en los análisis.</p>
    <section class="askbox">
      <div class="setting" style="margin-bottom:10px"><label for="dname">Nombre corto</label>
        <input class="field" id="dname" maxlength="28" placeholder="Ej.: Bilbobus 2023, Oferta 12-nov"></div>
      <div class="setting" style="margin-bottom:10px"><label for="dkind">Qué es</label>
        <select class="field" id="dkind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <div class="row" style="margin-top:0"><button class="btn primary" id="dpick" type="button">Elegir PDF o texto</button><button class="btn" id="dpastebtn" type="button">Pegar texto</button>
        <input type="file" id="dfile" accept=".pdf,.txt,.md,application/pdf,text/plain" hidden></div>
      <div id="dpaste" hidden><textarea class="field" id="dtext" rows="7" placeholder="Pega aquí el texto (una oferta que os mandaron por correo o WhatsApp, un acta…)"></textarea>
        <div class="row"><button class="btn primary" id="dsave" type="button">Guardar documento</button></div></div>
      <p class="note" id="dprog" aria-live="polite" style="margin:8px 2px 0">El PDF se lee en el móvil, sin subirlo a ningún sitio. Si es un escaneo (una foto del papel) no tiene texto: ábrelo con Google Drive → «Abrir con Documentos de Google», que lo pasa a texto, y pégalo aquí.</p>
    </section>
    <h2 class="section-title">Tus documentos</h2>
    ${USERDOCS.length ? USERDOCS.map(d => `<div class="item doc" style="--c:var(--doc)"><h3>${esc(d.name)} <span class="note">· ${esc(d.id)}</span></h3>
      <p class="note" style="margin:0">${esc(KIND[d.kind] || '')} · ${d.arts.length} ${d.arts.some(a => a.num) ? 'artículos detectados' : 'fragmentos'} · ${Math.round(d.text.length / 1000)} mil caracteres · ${esc(new Date(d.added).toLocaleDateString('es-ES'))}</p>
      <div class="row"><button class="btn small" data-dopen="${d.id}">Leer</button>${d.kind === 'oferta' ? `<button class="btn small" data-dval="${d.id}">Valorar con Claude</button>` : ''}${d.kind === 'convenio' ? `<button class="btn small" data-dcmp="${d.id}">Comparar</button>` : ''}<button class="btn small" data-ddel="${d.id}">Borrar</button></div></div>`).join('')
      : '<p class="lead" style="margin-top:0">Aún no hay documentos. Los convenios publicados están en el Boletín Oficial de Bizkaia y en REGCON (registro estatal de convenios).</p>'}`;
  const prog = $('#dprog');
  const meta = () => ({ name: ($('#dname').value.trim() || 'Documento').slice(0, 28), kind: $('#dkind').value });
  const done = async (text, m, extra) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length < 80) { prog.textContent = 'No hay texto que leer en ese archivo. Si es un escaneo, sigue el truco de Google Drive y pega el texto.'; return; }
    const rec = await saveUserDoc({ ...m, text });
    buildIndex(); toast('Documento guardado');
    viewNego('docs');
    const p2 = $('#dprog'); if (p2) p2.textContent = `«${rec.name}» guardado: ${rec.arts.length} ${rec.arts.some(a => a.num) ? 'artículos' : 'fragmentos'}${extra || ''}.`;
  };
  $('#dpick').onclick = () => { if (!$('#dname').value.trim()) { toast('Pon primero un nombre corto'); $('#dname').focus(); return; } $('#dfile').click(); };
  $('#dpastebtn').onclick = () => { $('#dpaste').hidden = false; $('#dtext').focus(); };
  $('#dsave').onclick = () => { if (!$('#dname').value.trim()) { toast('Pon primero un nombre corto'); $('#dname').focus(); return; } done($('#dtext').value, meta()).catch(e => prog.textContent = 'Error: ' + e.message); };
  $('#dfile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return; const m = meta();
    try {
      if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
        prog.textContent = 'Leyendo el PDF…';
        const r = await pdfText(f, (i, n) => { prog.textContent = `Leyendo el PDF: página ${i} de ${n}`; });
        if (r.text.replace(/\s/g, '').length < r.pages * 150) prog.textContent = 'Aviso: este PDF tiene muy poco texto; puede que alguna página sea una imagen.';
        await done(r.text, m, ` de ${r.pages} páginas`);
      } else await done(await f.text(), m);
    } catch (er) { prog.textContent = 'No he podido leer el archivo: ' + er.message; }
  };
  $('#nv').querySelectorAll('[data-dopen]').forEach(b => b.onclick = () => { state.law = b.dataset.dopen; state.filter = ''; location.hash = '#/leer'; });
  $('#nv').querySelectorAll('[data-ddel]').forEach(b => b.onclick = async () => { const d = USERDOCS.find(x => x.id === b.dataset.ddel); if (!confirm(`¿Borrar «${d.name}» de este dispositivo?`)) return; await deleteUserDoc(d.id); if (NS.docId === d.id) NS.docId = ''; buildIndex(); viewNego('docs'); toast('Documento borrado'); });
  $('#nv').querySelectorAll('[data-dval]').forEach(b => b.onclick = () => { NS.task = 'oferta'; NS.docId = b.dataset.dval; nsSave(); location.hash = '#/negociar/analizar'; });
  $('#nv').querySelectorAll('[data-dcmp]').forEach(b => b.onclick = () => { location.hash = '#/negociar/comparar'; });
}

/* ---------- Comparador sin conexión ---------- */
const TOPICS = [
  ['Subida salarial', 'incremento salarial IPC revision tablas retribuciones'], ['Jornada', 'jornada anual horas trabajo efectivo'], ['Descansos', 'descanso semanal franqueo libranza'],
  ['Vacaciones', 'vacaciones dias disfrute'], ['Baja (IT)', 'incapacidad temporal complemento subsidio'], ['Permisos', 'licencias permisos retribuidos'],
  ['Horas extra', 'horas extraordinarias'], ['Nocturnidad y festivos', 'plus nocturnidad festivo domingo'], ['Jubilación', 'jubilacion parcial contrato relevo'],
  ['Retirada de carnet', 'retirada permiso conducir carnet'], ['Seguros', 'seguro accidentes muerte incapacidad'], ['Conciliación', 'reduccion jornada excedencia cuidado hijos conciliacion'],
  ['Antigüedad y premios', 'antiguedad premio permanencia'], ['Contratación y bolsa', 'bolsa de trabajo contratacion eventual interino'], ['Derechos sindicales', 'credito horario comite representantes sindical'],
  ['Salud laboral', 'salud laboral revision medica prevencion'], ['Ropa de trabajo', 'ropa uniforme prendas'], ['Formación', 'formacion cursos CAP']
];
function convLaws() { return ['CONV', ...USERDOCS.filter(d => d.kind === 'convenio').map(d => d.id)]; }
function nCompare() {
  const v = $('#nv'); const laws = convLaws();
  v.innerHTML = `
    <section class="askbox">
      <label for="ctopic" class="note" style="display:block;margin:0 0 4px">Tema a comparar entre convenios</label>
      <input class="field" id="ctopic" value="${esc(NS.topic)}" placeholder="Ej.: complemento de baja, días de asuntos propios" autocomplete="off">
      <div class="modes">${TOPICS.map(([l]) => `<button type="button" data-topic="${esc(l)}" aria-pressed="${NS.topic === l}">${esc(l)}</button>`).join('')}</div>
      <div class="row"><button class="btn primary" id="cgo" type="button">Comparar</button></div>
      <p class="note" style="margin:8px 2px 0">${laws.length > 1 ? `Comparo el convenio EMB con ${laws.length - 1} convenio${laws.length > 2 ? 's' : ''} tuyo${laws.length > 2 ? 's' : ''} y con el Estatuto. Funciona sin conexión.` : 'Ahora solo comparo el convenio EMB con el Estatuto. Importa otros convenios en «Documentos» para ver qué tienen otros.'}</p>
    </section><div id="cout"></div>`;
  const run = () => {
    const t = NS.topic.trim(); if (!t) return;
    const q = (TOPICS.find(x => x[0] === t) || [t, t])[1] + ' ' + t;
    const cols = [...laws, 'ET'].map(l => ({ l, r: search(q, 1, l)[0] }));
    $('#cout').innerHTML = `<h2 class="section-title">${esc(t)}</h2>` + cols.map(c => `<h3 class="cmp-h" style="--c:${lawColor(c.l)}">${esc(C.laws[c.l] ? C.laws[c.l].name : c.l)}</h3>` + (c.r ? ticket(c.r, { terms: new Set(toks(q)) }) : '<p class="note">No encuentro nada sobre esto en este texto.</p>')).join('')
      + `<p class="note">Es el fragmento que mejor encaja en cada texto, no un análisis. Con conexión, «Analizar» → «Qué podemos pedir» lo hace Claude punto por punto.</p>`;
  };
  $('#ctopic').addEventListener('input', e => { NS.topic = e.target.value; nsSave(); });
  $('#ctopic').addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  v.querySelectorAll('[data-topic]').forEach(b => b.onclick = () => { NS.topic = b.dataset.topic; nsSave(); $('#ctopic').value = NS.topic; v.querySelectorAll('[data-topic]').forEach(x => x.setAttribute('aria-pressed', x === b)); run(); });
  $('#cgo').onclick = run;
  if (NS.topic) run();
}

/* ---------- Calculadora de costes ---------- */
function costDefaults() {
  return { ipc: C.ref.ipc.map(x => ({ y: x.y, v: x.v })), plant: {}, cargas: 33, prev: '3 / 2,5 / 2,5',
    A: { name: 'Oferta de la empresa', pct: '2 / 2 / 2', lin: 0, unico: 0 }, B: { name: 'Vuestra propuesta', pct: '4 / 3,5 / 3,5', lin: 0, unico: 0 } };
}
function costState() { const d = costDefaults(), s = store.get('costes', null); return s ? Object.assign(d, s, { A: Object.assign(d.A, s.A), B: Object.assign(d.B, s.B) }) : d; }
function baseSalaries(cs) {
  const f = cs.ipc.reduce((m, x) => m * (1 + pnum(x.v) / 100), 1);
  const lastY = cs.ipc.length ? cs.ipc[cs.ipc.length - 1].y : 2024;
  return { year: lastY, rows: C.tabla.map(r => ({ cat: r.cat, s0: r.anual2024 * f, n: num(cs.plant[r.cat] || 0) })) };
}
function runScenario(sc, base, cs) {
  const pct = list(sc.pct); const prev = list(cs.prev); const years = Math.max(1, pct.length);
  const P = k => pct[Math.min(k, pct.length - 1)] || 0, I = k => prev.length ? prev[Math.min(k, prev.length - 1)] : 0;
  const load = 1 + pnum(cs.cargas) / 100, lin = num(sc.lin), unico = num(sc.unico);
  const yrs = []; let price = 1;
  const S = base.rows.map(r => r.s0);
  for (let k = 0; k < years; k++) {
    price *= 1 + I(k) / 100;
    let cost = 0, payroll = 0;
    base.rows.forEach((r, i) => { S[i] = S[i] * (1 + P(k) / 100) + (k === 0 ? lin : 0); const pay = S[i] + (k === 0 ? unico : 0); cost += r.n * (pay - r.s0) * load; payroll += r.n * pay; });
    yrs.push({ y: base.year + k + 1, pct: P(k), ipc: I(k), cost, price });
  }
  const per = base.rows.map((r, i) => ({ cat: r.cat, s0: r.s0, sN: S[i], gainY1: (r.s0 * (1 + P(0) / 100) + lin + unico) - r.s0, real: (S[i] / r.s0) / price - 1, total: 0 }));
  // ganancia acumulada por persona en el periodo (bruto, frente a congelar)
  base.rows.forEach((r, i) => { let s = r.s0, acc = 0; for (let k = 0; k < years; k++) { s = s * (1 + P(k) / 100) + (k === 0 ? lin : 0); acc += s - r.s0 + (k === 0 ? unico : 0); } per[i].total = acc; });
  return { years, yrs, per, total: yrs.reduce((m, x) => m + x.cost, 0), heads: base.rows.reduce((m, r) => m + r.n, 0), price };
}
function costSummaryText() {
  const cs = costState(), base = baseSalaries(cs);
  const A = runScenario(cs.A, base, cs), B = runScenario(cs.B, base, cs);
  const cond = base.rows.findIndex(r => r.cat === 'Conductor');
  const line = (sc, R) => `- ${sc.name}: subidas ${sc.pct}${num(sc.lin) ? `, ${fmtE(num(sc.lin))} lineales consolidables el primer año` : ''}${num(sc.unico) ? `, pago único ${fmtE(num(sc.unico))}` : ''}. ` +
    (R.heads ? `Coste extra para la empresa (con ${cs.cargas} % de cargas sociales, frente a congelar): ${R.yrs.map(y => `${y.y}: ${fmtE(y.cost)}`).join('; ')}; total ${fmtE(R.total)}. ` : 'Sin plantilla introducida: no hay coste total. ') +
    `Conductor: de ${fmtE(base.rows[cond].s0)} a ${fmtE(R.per[cond].sN)} brutos al año; poder adquisitivo al final ${fmtP(R.per[cond].real * 100)} con el IPC previsto.`;
  return `CÁLCULO DE COSTES (calculadora de la app; solo salario anual de tablas, sin antigüedad, horas extra ni pluses variables; base ${base.year} estimada actualizando las tablas 2024 con IPC ${cs.ipc.map(x => `${x.y}: ${x.v} %`).join(', ')}).\nPlantilla introducida: ${A.heads} personas. IPC previsto para los años del nuevo convenio: ${cs.prev}.\n${line(cs.A, A)}\n${line(cs.B, B)}\nDiferencia de coste total B − A: ${fmtE(B.total - A.total)}.`;
}
function costConfigured() { const cs = store.get('costes', null); return !!(cs && cs.plant && Object.values(cs.plant).some(v => num(v) > 0)); }
function nCosts() {
  const v = $('#nv'); const cs = costState(); const base = baseSalaries(cs);
  const scBox = k => `<fieldset class="sc"><legend><input class="field slim" data-sc="${k}.name" value="${esc(cs[k].name)}" aria-label="Nombre del escenario ${k}"></legend>
      <label>Subida % por año <input class="field slim" data-sc="${k}.pct" value="${esc(cs[k].pct)}" inputmode="decimal" placeholder="3 / 2,5 / 2,5"></label>
      <label>€ lineales el 1.er año, consolidan <input class="field slim" data-sc="${k}.lin" value="${esc(cs[k].lin)}" inputmode="decimal"></label>
      <label>Pago único el 1.er año, no consolida <input class="field slim" data-sc="${k}.unico" value="${esc(cs[k].unico)}" inputmode="decimal"></label></fieldset>`;
  v.innerHTML = `
    <p class="lead" style="margin-top:6px">Pon las dos posturas y la plantilla: te digo cuánto le cuesta a la empresa, cuánto gana cada categoría y si se pierde poder adquisitivo. Todo sin conexión.</p>
    <div class="sc2">${scBox('A')}${scBox('B')}</div>
    <div class="setting"><label for="cprev">IPC previsto por año del nuevo convenio (%)</label><input class="field" id="cprev" value="${esc(cs.prev)}" inputmode="decimal">
      <p class="note">Separa los años con «/». El número de años lo marca la subida que más años tenga.</p></div>
    <div id="cres"></div>
    <details class="item"><summary><strong>Salarios de partida (${base.year})</strong> · tablas 2024 actualizadas con IPC</summary>
      <div class="ipcs">${cs.ipc.map((x, i) => `<label>Subida ${x.y} <input class="field slim" data-ipc="${i}" value="${esc(x.v)}" inputmode="decimal"></label>`).join('')}</div>
      <p class="note">${C.ref.ipc.map(x => `${x.y}: ${esc(x.src)}`).join('. ')}. Cámbialos por lo que se aplicó de verdad en vuestras tablas.</p>
      <label class="note" for="ccar">Cargas sociales de la empresa (%)</label><input class="field slim" id="ccar" value="${esc(cs.cargas)}" inputmode="decimal">
      <p class="note">Aproximado: contingencias comunes, desempleo, FOGASA, formación, MEI y accidentes. Si la empresa da su cifra, usa la suya.</p></details>
    <details class="item" ${costConfigured() ? '' : 'open'}><summary><strong>Plantilla por categoría</strong> · <span id="pcount">${base.rows.reduce((m, r) => m + r.n, 0)}</span> personas</summary>
      <p class="note">Cuántas personas hay en cada categoría. Lo tenéis en el comité (TC2 o listado de plantilla). Sin esto solo calculo por persona.</p>
      <div class="plant">${base.rows.map(r => `<label><span>${esc(r.cat)}<small>${fmtE(r.s0)}</small></span><input class="field slim" data-plant="${esc(r.cat)}" value="${num(cs.plant[r.cat] || 0) || ''}" inputmode="numeric" placeholder="0"></label>`).join('')}</div></details>
    <p class="note">Solo cuenta el salario anual de tablas (art. 7): no incluye antigüedad, horas extra, nocturnidad variable ni otros pluses. Sirve para comparar propuestas, no para hacer nóminas.</p>`;
  const save = () => { store.set('costes', cs); renderRes(); const pc = $('#pcount'); if (pc) pc.textContent = Object.values(cs.plant).reduce((m, x) => m + num(x), 0); };
  const renderRes = () => {
    const b = baseSalaries(cs), A = runScenario(cs.A, b, cs), B = runScenario(cs.B, b, cs);
    const years = Math.max(A.years, B.years);
    const ci = b.rows.findIndex(r => r.cat === 'Conductor');
    const lo = b.rows.reduce((m, r, i) => r.s0 < b.rows[m].s0 ? i : m, 0), hi = b.rows.reduce((m, r, i) => r.s0 > b.rows[m].s0 ? i : m, 0);
    const heads = A.heads;
    const pt1 = b.rows.reduce((m, r) => m + r.n * r.s0, 0) * 0.01 * (1 + pnum(cs.cargas) / 100) * years;
    const row = (lbl, fa, fb, cls = '') => `<tr class="${cls}"><th scope="row">${lbl}</th><td>${fa}</td><td>${fb}</td></tr>`;
    let h = `<div class="tblwrap"><table class="calc"><thead><tr><th></th><th>${esc(cs.A.name)}</th><th>${esc(cs.B.name)}</th></tr></thead><tbody>`;
    if (heads) {
      for (let k = 0; k < years; k++) { const a = A.yrs[k], bb = B.yrs[k]; h += row(`Coste extra ${(a || bb).y}`, a ? fmtE(a.cost) : '—', bb ? fmtE(bb.cost) : '—'); }
      h += row('Coste total del periodo', fmtE(A.total), fmtE(B.total), 'strong');
    }
    h += row('Conductor: sueldo final', fmtE(A.per[ci].sN), fmtE(B.per[ci].sN));
    h += row('Conductor: gana en el periodo', fmtE(A.per[ci].total), fmtE(B.per[ci].total));
    h += row('Conductor: poder adquisitivo al final', fmtP(A.per[ci].real * 100), fmtP(B.per[ci].real * 100), 'strong');
    h += row(`Categoría más baja (${esc(b.rows[lo].cat)})`, fmtP(A.per[lo].real * 100), fmtP(B.per[lo].real * 100));
    h += row(`Categoría más alta (${esc(b.rows[hi].cat)})`, fmtP(A.per[hi].real * 100), fmtP(B.per[hi].real * 100));
    h += `</tbody></table></div>`;
    const diff = B.total - A.total;
    h += heads ? `<p class="callout">Pasar de «${esc(cs.A.name)}» a «${esc(cs.B.name)}» le cuesta a la empresa <strong>${fmtE(diff)}</strong> en ${years} año${years > 1 ? 's' : ''}${pt1 ? `, más o menos lo que ${(diff / pt1).toLocaleString('es-ES', { maximumFractionDigits: 1 })} punto${Math.abs(diff / pt1) >= 1.5 ? 's' : ''} de subida extra desde el primer año` : ''}. Cada punto de subida consolidada cuesta unos <strong>${fmtE(pt1 / years)}</strong> al año.</p>`
      : `<p class="callout">Sin plantilla solo veo lo que gana cada persona. Rellena «Plantilla por categoría» para saber cuánto le cuesta a la empresa cada propuesta.</p>`;
    h += `<p class="note">«Poder adquisitivo» compara el sueldo final con el IPC previsto acumulado (${fmtP((A.price - 1) * 100)}). Un pago único no cuenta: no queda en tablas. Una cantidad lineal en euros sube más, en porcentaje, a quien menos cobra.</p>
      <div class="row"><button class="btn small" id="cuse" type="button">Usar en un análisis con Claude</button><button class="btn small" id="ccopy" type="button">Copiar resumen</button></div>`;
    $('#cres').innerHTML = h;
    $('#cuse').onclick = () => { NS.useCost = true; nsSave(); location.hash = '#/negociar/analizar'; };
    $('#ccopy').onclick = () => copy(costSummaryText());
  };
  v.querySelectorAll('[data-sc]').forEach(i => i.addEventListener('input', () => { const [k, f] = i.dataset.sc.split('.'); cs[k][f] = i.value; save(); }));
  v.querySelectorAll('[data-ipc]').forEach(i => i.addEventListener('input', () => { cs.ipc[+i.dataset.ipc].v = i.value; save(); }));
  v.querySelectorAll('[data-plant]').forEach(i => i.addEventListener('input', () => { cs.plant[i.dataset.plant] = i.value; save(); }));
  $('#cprev').addEventListener('input', e => { cs.prev = e.target.value; save(); });
  $('#ccar').addEventListener('input', e => { cs.cargas = e.target.value; save(); });
  renderRes();
}

/* ---------- Analizar con Claude ---------- */
const NTASK = {
  oferta: {
    label: 'Valorar oferta', ph: 'Pega aquí la oferta de la empresa o elígela abajo si la guardaste en Documentos. Añade lo que dijeron en la mesa.',
    desc: 'Qué mejora y qué empeora, la letra pequeña, el coste real y una contrapropuesta mejor.',
    seed: 'retribuciones incremento salarial jornada vigencia', always: ['CONV-2', 'CONV-7', 'ET-82', 'ET-85', 'ET-86', 'ET-89'],
    prompt: `TAREA: VALORAR LA OFERTA DE LA EMPRESA.
Formato (usa estos títulos con ##):
## Veredicto
Una o dos líneas: firmable, mejorable o rechazable, y la verdad incómoda.
## Qué cambia respecto al convenio actual
Tabla: | Punto | Ahora [ID] | Oferta | La plantilla gana o pierde |
## Letra pequeña y riesgos
## Números
Coste para la empresa, ganancia por persona y comparación con el IPC. Usa el CÁLCULO DE COSTES si viene; si no, di exactamente qué meter en la calculadora de la app (pestaña Costes).
## Contrapropuesta
2 o 3 paquetes de coste parecido para la empresa y más valor para la plantilla, cada uno escrito como se diría en la mesa.
## Argumentos para la mesa
Sus objeciones previsibles y la respuesta a cada una.
## Preguntas para la empresa y datos que faltan`
  },
  pedir: {
    label: 'Qué podemos pedir', ph: 'Tema concreto (opcional): «complemento de baja», «jornada», «descansos»… Vacío = repaso de todo el convenio.',
    desc: 'Compara el convenio EMB con tus otros convenios y con la ley, y ordena las mejoras por valor y posibilidad.',
    seed: '', always: ['CONV-2', 'CONV-7'],
    prompt: `TAREA: QUÉ PODEMOS PEDIR EN EL PRÓXIMO CONVENIO.
Compara el convenio EMB con los otros convenios y con la ley de los pasajes. Formato (usa estos títulos con ##):
## Lo más importante
Tres líneas: dónde está EMB por debajo y por encima de las referencias.
## Mejoras posibles
Tabla ordenada por prioridad: | Mejora | Ahora [ID] | Referencia [ID] | Valor para la plantilla | Coste o resistencia de la empresa | Posibilidad (alta, media, baja) |
## Lo que conviene no tocar
Puntos donde EMB ya está mejor y la empresa podría intentar recortar.
## Peticiones baratas para la empresa
Mejoras de mucho valor para la plantilla y poco coste.
## Datos que faltan`
  },
  propuesta: {
    label: 'Preparar propuesta', ph: 'Qué queréis conseguir, qué estaríais dispuestos a ceder y cómo está la plantilla. Si es contrapropuesta, pega también lo que ofreció la empresa.',
    desc: 'Plataforma con máximo, objetivo y mínimo por punto, y el texto de los artículos listo para presentar.',
    seed: 'retribuciones jornada', always: ['CONV-2', 'CONV-7', 'ET-85', 'ET-86', 'ET-89'],
    prompt: `TAREA: PREPARAR PROPUESTA O CONTRAPROPUESTA.
Formato (usa estos títulos con ##):
## Estrategia
## Plataforma
Para cada punto: máximo (lo que se pide), objetivo (lo que se espera cerrar), mínimo (punto de ruptura) y por qué. Puede ir en tabla.
## Redacción articulada
Texto propuesto para los artículos nuevos o modificados, listo para presentar, con [DATOS PENDIENTES] donde falte información.
## Qué ofrecer a cambio
## Argumentario de un minuto para la asamblea`
  },
  acuerdo: {
    label: 'Buscar acuerdo', ph: 'El problema o conflicto, lo que pide cada parte y lo que sabéis de lo que preocupa a la empresa.',
    desc: 'Opciones que convengan a empresa y plantilla a la vez, con criterios objetivos y una propuesta puente.',
    seed: '', always: ['ET-86', 'ET-89'],
    prompt: `TAREA: BUSCAR UN ACUERDO QUE CONVENGA A EMPRESA Y PLANTILLA.
Formato (usa estos títulos con ##):
## El problema en una frase
## Intereses de cada parte
Tabla: | Parte | Lo que pide | Lo que de verdad necesita |
## Opciones
De 3 a 5 opciones distintas; en cada una: qué gana la plantilla, qué gana la empresa, coste aproximado y riesgo.
## Criterios objetivos para decidir
## Propuesta puente
La opción recomendada, redactada para llevar a la mesa.
## Si no hay acuerdo
Alternativa de cada parte y siguiente paso.`
  }
};
function negoSystem() {
  const ipc = C.ref.ipc.map(x => `${x.y}: ${x.v} % (${x.src})`).join('; ');
  return systemPrompt() + `

PAPEL: NEGOCIACIÓN COLECTIVA
Ahora actúas como asesor sindical sénior en negociación de convenios del transporte de viajeros por carretera. Estás de parte de la plantilla, pero buscas el mejor acuerdo firmable: una propuesta que la empresa no puede asumir no mejora nada y desgasta al comité.

Contexto de la mesa (no son pasajes; úsalo como contexto y etiquétalo):
- ${C.ref.nota}
- Subidas por IPC del convenio actual: ${ipc}.
- EMB presta servicio de Bizkaibus por contrato con la Diputación Foral de Bizkaia. El coste laboral repercute en el contrato público, así que lo que la empresa puede pagar depende de cómo se revise el precio de ese contrato. Si eso es decisivo, márcalo [Adivinando] y di qué dato pedir.

Método obligatorio:
1. Cuantifica. Usa el CÁLCULO DE COSTES si viene. No inventes plantilla, salarios ni costes: si falta un número, di cuál y cómo conseguirlo.
2. Separa posiciones de intereses en las dos partes. Plantilla: poder adquisitivo, descanso, previsibilidad de turnos y franqueos, salud, estabilidad. Empresa: coste, cubrir el servicio, absentismo, cumplir con la Diputación, paz social.
3. Busca intercambios de poco coste para la empresa y mucho valor para la plantilla (calendarios conocidos con antelación, cambios de turno entre compañeros, permisos no retribuidos, formación en jornada, procedimientos más rápidos…) y qué podéis ceder que a ellos les valga y a vosotros os cueste poco.
4. Nada se cede sin contrapartida. Ofrece paquetes de valor equivalente (2 o 3) en vez de un único punto.
5. Revisa la letra pequeña: absorción y compensación, pagos únicos que no consolidan en tablas, doble escala para nuevos ingresos, topes de IPC o revisiones sin atrasos, subida con un año de retraso frente a la inflación, vigencias largas sin cláusula de revisión, subidas condicionadas a absentismo o productividad, cambios de jornada encubiertos, renuncias a derechos, comisiones donde decide la empresa, pérdida de ultraactividad.
6. Define qué pasa si no hay acuerdo para cada parte (convenio vencido y ultraactividad según los pasajes del ET, movilización, mediación; en Euskadi existe el PRECO) y úsalo para fijar el punto de ruptura.
7. Distingue lo que es mínimo legal (no se puede pactar a la baja) de lo que es mejora pactada.
8. Si citas otros convenios importados por el usuario (IDs que empiezan por D), avisa de que el troceo en artículos es automático y que hay que confirmar la cifra en el original.`;
}
function negoPassages(task, text, docId) {
  const T = NTASK[task]; const chosen = []; const seen = new Set(); let size = 0; const LIM = 60000;
  const add = (a, pi) => { if (!a) return; const k = a.id + '#' + pi; const p = a.parts[pi]; if (!p || seen.has(k) || size + p.text.length > LIM) return; seen.add(k); chosen.push([a, pi]); size += p.text.length; };
  T.always.forEach(id => add(BYID.get(id), 0));
  const q = (text || '').slice(0, 900) + ' ' + T.seed;
  const others = convLaws().slice(1).filter(l => l !== docId);
  if (task === 'pedir' && (text || '').trim().split(/\s+/).length < 4) {
    TOPICS.forEach(([l, s]) => { const qq = s + ' ' + (text || ''); ['CONV', ...others].forEach(law => { const r = search(qq, 1, law)[0]; if (r) add(r.art, r.partIdx); }); });
    TOPICS.slice(0, 8).forEach(([l, s]) => { const r = search(s, 1, 'ET')[0]; if (r) add(r.art, r.partIdx); });
  } else {
    search(q, 8).forEach(r => add(r.art, r.partIdx));
    search(q, 4, 'CONV').forEach(r => add(r.art, r.partIdx));
    if (NS.compare) others.forEach(l => search(q, 3, l).forEach(r => add(r.art, r.partIdx)));
  }
  return chosen;
}
function nAnalyze() {
  const v = $('#nv'); const key = !!store.get('key', ''); const T = NTASK[NS.task];
  const docs = USERDOCS; const hasConv = convLaws().length > 1; const hasCost = costConfigured();
  v.innerHTML = `
    <section class="askbox">
      <div class="modes" role="group" aria-label="Qué quieres hacer">${Object.entries(NTASK).map(([k, t]) => `<button type="button" data-task="${k}" aria-pressed="${NS.task === k}">${t.label}</button>`).join('')}</div>
      <p class="note" style="margin:8px 2px">${esc(T.desc)}</p>
      <textarea id="nt" rows="6" placeholder="${esc(T.ph)}">${esc(NS.text)}</textarea>
      ${docs.length ? `<label class="note" for="ndoc" style="display:block;margin:8px 0 4px">Documento que va entero a Claude (opcional)</label>
        <select class="field" id="ndoc"><option value="">Ninguno</option>${docs.map(d => `<option value="${d.id}" ${NS.docId === d.id ? 'selected' : ''}>${esc(d.name)} · ${esc(KIND[d.kind])}</option>`).join('')}</select>` : ''}
      <div class="checks">
        ${hasConv ? `<label><input type="checkbox" id="ncmp" ${NS.compare ? 'checked' : ''}> Comparar con mis otros convenios</label>` : ''}
        ${hasCost ? `<label><input type="checkbox" id="ncost" ${NS.useCost ? 'checked' : ''}> Añadir el cálculo de costes</label>` : `<span class="note">Sin datos de plantilla: rellena «Costes» para que el análisis lleve números reales.</span>`}
      </div>
      <div class="row"><button class="btn primary" id="ngo" type="button" ${NS.busy ? 'disabled' : ''}>Analizar con Claude</button>${NS.thread.length ? '<button class="btn small" id="nnew" type="button">Empezar de nuevo</button>' : ''}</div>
      <p class="note" style="margin:8px 2px 0">${key ? 'Claude recibe tu texto, los artículos relevantes, el documento elegido y, si lo marcas, el cálculo de costes. No pongas nombres ni datos personales de compañeros.' : 'Necesita la clave de Claude (Ajustes) y conexión. Sin ellas tienes «Comparar» y «Costes».'}</p>
    </section><div id="nout"></div>`;
  v.querySelectorAll('[data-task]').forEach(b => b.onclick = () => { NS.task = b.dataset.task; nsSave(); nAnalyze(); });
  $('#nt').addEventListener('input', e => { NS.text = e.target.value; nsSave(); });
  const nd = $('#ndoc'); if (nd) nd.onchange = e => { NS.docId = e.target.value; nsSave(); };
  const nc = $('#ncmp'); if (nc) nc.onchange = e => { NS.compare = e.target.checked; nsSave(); };
  const nk = $('#ncost'); if (nk) nk.onchange = e => { NS.useCost = e.target.checked; nsSave(); };
  $('#ngo').onclick = () => negoRun();
  const nn = $('#nnew'); if (nn) nn.onclick = () => { NS.thread = []; NS.first = null; NS.text = ''; nsSave(); nAnalyze(); };
  nRenderOut();
}
function nRenderOut() {
  const out = $('#nout'); if (!out) return;
  let h = '';
  NS.thread.forEach((t, i) => {
    h += `<section class="answer" data-i="${i}"><div class="who"><span>Claude · ${esc(t.label)}</span><span><button class="btn small" data-nact="copy" data-i="${i}">Copiar</button> <button class="btn small" data-nact="save" data-i="${i}">Guardar</button></span></div><p class="q">${esc(t.q.length > 280 ? t.q.slice(0, 280) + '…' : t.q)}</p><div class="prose ${t.streaming ? 'typing' : ''}">${t.err ? '' : md(t.a)}</div>${t.err ? `<div class="err">${esc(t.err)}</div>` : ''}</section>`;
  });
  if (NS.thread.length && !NS.busy) {
    h += `<section class="askbox"><label for="nf" class="note" style="display:block;margin:0 0 4px">Repregunta, dale un dato nuevo o pídele que se ponga en el lugar de la empresa</label>
      <textarea id="nf" rows="3" placeholder="Ej.: la empresa dice que la Diputación no le sube el contrato; ¿qué hacemos?"></textarea>
      <div class="row"><button class="btn primary" id="nfgo" type="button">Enviar</button></div></section>`;
  }
  if (NS.used && NS.used.length) h += `<h2 class="section-title">Textos que ha recibido Claude</h2>` + NS.used.map(([a, pi]) => ticket({ art: a, partIdx: pi }, {})).join('');
  out.innerHTML = h;
  out.querySelectorAll('[data-nact]').forEach(b => b.onclick = () => {
    const t = NS.thread[+b.dataset.i];
    if (b.dataset.nact === 'copy') copy(t.a);
    else { const l = store.get('answers', []); l.unshift({ q: t.q.slice(0, 400), a: t.a, mode: 'n-' + t.task, t: Date.now() }); store.set('answers', l.slice(0, 100)); toast('Respuesta guardada'); }
  });
  const f = $('#nfgo'); if (f) f.onclick = () => { const q = $('#nf').value.trim(); if (q) negoRun(q); };
}
async function negoRun(follow) {
  if (!store.get('key', '')) { toast('Falta la clave de Claude: ponla en Ajustes'); location.hash = '#/ajustes'; return; }
  if (!navigator.onLine) { toast('Sin conexión: usa Comparar o Costes'); return; }
  if (NS.busy) return;
  const T = NTASK[NS.task];
  let q, messages;
  if (!follow) {
    const doc = USERDOCS.find(d => d.id === NS.docId);
    if (!NS.text.trim() && !doc && NS.task !== 'pedir') { toast('Escribe o elige primero qué analizar'); return; }
    const chosen = negoPassages(NS.task, NS.text + (doc ? ' ' + doc.text.slice(0, 1500) : ''), doc && doc.id);
    NS.used = chosen;
    const docBlock = doc ? `\n\nDOCUMENTO DEL USUARIO [${doc.id}] «${doc.name}» (${KIND[doc.kind]}). Texto completo${doc.text.length > 45000 ? ' (recortado a 45.000 caracteres)' : ''}:\n${cleanText(doc.text).slice(0, 45000)}` : '';
    const costBlock = (NS.useCost && costConfigured()) ? `\n\n${costSummaryText()}` : '';
    q = NS.text.trim() || (doc ? `Analiza «${doc.name}».` : 'Repaso general del convenio.');
    NS.first = `${T.prompt}\n\nPASAJES DISPONIBLES (convenio EMB, leyes y documentos del usuario)\n\n${passagesText(chosen)}${docBlock}${costBlock}\n\n=====\nLO QUE PLANTEA EL USUARIO\n${q}`;
    NS.thread = [];
    messages = [{ role: 'user', content: NS.first }];
  } else {
    q = follow;
    const ok = NS.thread.filter(t => !t.err && t.a);
    if (!ok.length || !NS.first) { toast('Empieza un análisis nuevo'); return; }
    messages = [{ role: 'user', content: NS.first }, { role: 'assistant', content: ok[0].a }];
    ok.slice(1).slice(-3).forEach(t => { messages.push({ role: 'user', content: t.q }); messages.push({ role: 'assistant', content: t.a }); });
    messages.push({ role: 'user', content: follow });
  }
  const turn = { q, a: '', task: NS.task, label: T.label, streaming: true, err: '' };
  NS.thread.push(turn); NS.busy = true;
  nAnalyze();
  const el = () => $(`#nout .answer[data-i="${NS.thread.length - 1}"] .prose`);
  el() && el().scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    turn.a = await streamClaude({ system: negoSystem(), messages, maxTokens: 6000, onDelta: txt => { turn.a = txt; const e = el(); if (e) e.innerHTML = md(txt); } });
  } catch (e) {
    turn.err = e.name === 'TypeError' ? 'No he podido conectar con la API de Anthropic. Comprueba la conexión.' : e.message;
  }
  turn.streaming = false; NS.busy = false;
  nAnalyze();
  const t = $('#nout .answer:last-of-type'); if (t) t.scrollIntoView({ block: 'start' });
}
