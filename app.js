'use strict';
/* Asesor del convenio · PWA personal. Todo local salvo la llamada opcional a la API de Anthropic. */
const C = window.CORPUS;
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- almacenamiento ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('asesor.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('asesor.' + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem('asesor.' + k); } catch (e) { } }
};
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const state = {
  mode: store.get('mode', 'sencilla'),
  thread: [], results: [], pinned: [], q: '', busy: false, lastQ: '',
  law: 'CONV', filter: ''
};

/* ---------- índice de búsqueda (BM25 con raíz de palabra) ---------- */
const STOP = new Set('de la que el en y a los del se las por un para con no una su al lo como mas pero sus le ya o este si porque esta entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mi antes algunos unos yo otro otras otra tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros es son ser puede pueden tiene tienen hacer cuanto cuantos cuales quiero saber dice dicen segun cuando'.split(' '));
const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]+/g, ' ').trim();
const SUF = ['amientos', 'imientos', 'amiento', 'imiento', 'aciones', 'uciones', 'adores', 'adoras', 'ancias', 'encias', 'idades', 'mente', 'acion', 'ucion', 'ador', 'adora', 'ancia', 'encia', 'idad', 'ables', 'ibles', 'able', 'ible', 'ivos', 'ivas', 'ivo', 'iva', 'ando', 'iendo', 'ados', 'adas', 'idos', 'idas', 'ado', 'ada', 'ido', 'ida', 'ar', 'er', 'ir', 'es', 'os', 'as', 'a', 'o', 's'];
function stem(w) {
  if (w.length <= 4) return w;
  for (const s of SUF) { if (w.length - s.length >= 4 && w.endsWith(s)) return w.slice(0, -s.length); }
  return w;
}
const toks = s => norm(s).split(' ').filter(w => w.length > 1 && !STOP.has(w)).map(stem);

const SYN = [
  [/\b(baja|bajas|enfermo|enfermedad|incapacidad)\b/, 'incapacidad temporal subsidio'],
  [/\bit\b/, 'incapacidad temporal baja'],
  [/\bfranque\w*|descanso semanal|libranza|libro\b/, 'descanso semanal franqueo'],
  [/\b(fiesta|festivo|festivos)\b/, 'festivo fiestas laborales'],
  [/\bpaga\w* extra\w*|extras\b/, 'gratificaciones extraordinarias pagas'],
  [/\bhoras? extras?\b/, 'horas extraordinarias'],
  [/\b(sueldo|salario|nomina|cobrar|cobro|pagan)\b/, 'retribuciones salario'],
  [/\b(despido|despedir|despiden)\b/, 'despido extincion'],
  [/\b(sancion|sancionar|multa|expediente)\b/, 'sancion infraccion falta'],
  [/\b(huelga|conflicto)\b/, 'huelga conflicto colectivo'],
  [/\b(comite|delegado|delegados|sindicato|sindical)\b/, 'representantes trabajadores comite empresa seccion sindical'],
  [/\b(credito horario|horas sindicales)\b/, 'credito horario representantes'],
  [/\b(carnet|carne|permiso de conducir)\b/, 'permiso conducir retirada carnet'],
  [/\b(turno|turnos|horario|horarios)\b/, 'turnos jornada horario'],
  [/\b(linea|lineas|plaza|plazas)\b/, 'lineas plazas adjudicacion comision de lineas antiguedad'],
  [/\b(eventual|eventuales|interino|interinos|bolsa)\b/, 'bolsa de trabajo contrato temporal eventual interino'],
  [/\b(jubilacion|jubilar|jubilarse|relevo)\b/, 'jubilacion parcial contrato de relevo'],
  [/\b(permiso|permisos|licencia|licencias|boda|matrimonio|fallecimiento|muerte|hospital|hospitalizacion|mudanza)\b/, 'licencias permisos retribuidos'],
  [/\b(anticipo|adelanto|prenomina)\b/, 'anticipos'],
  [/\b(uniforme|ropa)\b/, 'ropa de trabajo'],
  [/\b(noche|nocturno|nocturnidad)\b/, 'plus nocturnidad noche'],
  [/\b(excedencia|reduccion de jornada|conciliacion|hijos|cuidado)\b/, 'excedencia reduccion jornada cuidado'],
  [/\b(acoso|mobbing|discriminacion)\b/, 'acoso protocolo discriminacion'],
  [/\b(vacaciones|vacas)\b/, 'vacaciones'],
  [/\b(modificar|modificacion|cambiar|cambio|cambian)\b/, 'modificacion sustancial condiciones de trabajo'],
  [/\b(descuelgue|inaplicacion)\b/, 'inaplicacion convenio'],
  [/\b(antiguedad|trienios|bienios|quinquenios)\b/, 'antiguedad bienios quinquenios'],
  [/\b(contador|acumulador|horas vivas|dha)\b/, 'horas acumuladas contador jornada quincenas'],
  [/\b(prevencion|riesgos|accidente|seguridad)\b/, 'prevencion riesgos laborales seguridad salud'],
  [/\b(subrogacion|subrogar|concesion|nueva empresa)\b/, 'subrogacion sucesion de empresa'],
  [/\b(recaudacion|billetaje|dinero|atraco)\b/, 'recaudacion billetaje dinero robo atraco'],
  [/\b(reclamar|reclamacion|denuncia|denunciar)\b/, 'reclamacion comision mixta inspeccion trabajo'],
  [/\b(prescrib\w*|plazo|plazos|caducidad)\b/, 'plazo prescripcion caducidad dias']
];
const LAWW = { CONV: 1.25, ET: 1.0, LOLS: 0.95, LPRL: 0.95, LISOS: 0.8 };

let DOCS = [], POST = new Map(), BYID = new Map(), ORDER = {};
const USERDOCS = []; // documentos importados por el usuario (IndexedDB)
function allArts() { return C.arts.concat(...USERDOCS.map(d => d.arts)); }
function buildIndex() {
  DOCS = []; POST = new Map(); BYID = new Map(); ORDER = {};
  Object.keys(C.laws).forEach(k => { if (/^D\d+$/.test(k)) delete C.laws[k]; });
  USERDOCS.forEach(d => {
    C.laws[d.id] = { name: d.name, full: d.full || d.name, note: d.note || '', kind: d.kind, user: true };
    LAWNAME[d.id] = d.name; LAWSHORT[d.id] = d.name; LAWW[d.id] = d.kind === 'convenio' ? 1.0 : 0.9;
  });
  allArts().forEach((a, ai) => {
    BYID.set(a.id, a);
    (ORDER[a.ley] = ORDER[a.ley] || []).push(a);
    a.parts.forEach((p, pi) => {
      const t = [...toks(a.title), ...toks(a.title), ...toks(a.title), ...toks(a.label + ' ' + (a.num || '')), ...toks(p.text)];
      const di = DOCS.length; DOCS.push({ a, p: pi, len: t.length });
      const tf = new Map(); t.forEach(w => tf.set(w, (tf.get(w) || 0) + 1));
      tf.forEach((n, w) => { let l = POST.get(w); if (!l) POST.set(w, l = []); l.push([di, n]); });
    });
  });
  DOCS.avg = DOCS.reduce((s, d) => s + d.len, 0) / DOCS.length;
}
function directRefs(qn) {
  const out = [];
  const re = /\b(?:art|arts|articulo|articulos)\s*(\d{1,3})(?:\s*(bis|ter))?(?:\s+(?:del?|en)?\s*(convenio|estatuto|et|lols|lprl|prl|lisos))?/g;
  let m;
  while ((m = re.exec(qn))) {
    let law = m[3] ? ({ convenio: 'CONV', estatuto: 'ET', et: 'ET', lols: 'LOLS', lprl: 'LPRL', prl: 'LPRL', lisos: 'LISOS' }[m[3]]) : null;
    if (!law) law = /\bestatuto\b|\bet\b/.test(qn) ? 'ET' : /libertad sindical|\blols\b/.test(qn) ? 'LOLS' : /\blprl\b|prevencion de riesgos/.test(qn) ? 'LPRL' : /\blisos\b/.test(qn) ? 'LISOS' : 'CONV';
    const id = `${law}-${m[1]}${m[2] ? m[2] : ''}`;
    if (BYID.has(id)) out.push(id);
  }
  return out;
}
function search(q, n = 8, only) {
  const qn = norm(q);
  const base = toks(q);
  const extra = [];
  SYN.forEach(([re, add]) => { if (re.test(qn)) extra.push(...toks(add)); });
  const W = new Map();
  base.forEach(w => W.set(w, Math.max(W.get(w) || 0, 1)));
  extra.forEach(w => { if (!W.has(w)) W.set(w, 0.45); });
  const N = DOCS.length, scores = new Map();
  W.forEach((wt, w) => {
    const l = POST.get(w); if (!l) return;
    const idf = Math.log(1 + (N - l.length + .5) / (l.length + .5));
    for (const [di, tf] of l) {
      const d = DOCS[di], k = 1.4, b = .75;
      const s = idf * wt * (tf * (k + 1)) / (tf + k * (1 - b + b * d.len / DOCS.avg));
      scores.set(di, (scores.get(di) || 0) + s);
    }
  });
  const byArt = new Map();
  scores.forEach((s, di) => {
    const d = DOCS[di]; if (only && d.a.ley !== only) return;
    const sc = s * (LAWW[d.a.ley] || 0.9);
    const cur = byArt.get(d.a.id);
    if (!cur) byArt.set(d.a.id, { art: d.a, partIdx: d.p, score: sc, sum: 0 });
    else { if (sc > cur.score) { cur.sum += cur.score; cur.score = sc; cur.partIdx = d.p; } else cur.sum += sc; }
  });
  let res = [...byArt.values()].map(r => ({ ...r, total: r.score + 0.12 * r.sum }));
  res.sort((x, y) => y.total - x.total);
  const direct = directRefs(qn).filter(id => !only || BYID.get(id).ley === only).map(id => ({ art: BYID.get(id), partIdx: 0, total: 1e6, direct: true }));
  const seen = new Set(direct.map(d => d.art.id));
  res = direct.concat(res.filter(r => !seen.has(r.art.id)));
  // asegura presencia del convenio y de la ley general
  const top = res.slice(0, n);
  if (!only && !top.some(r => r.art.ley === 'CONV')) { const c = res.find(r => r.art.ley === 'CONV'); if (c) top.splice(n - 1, 1, c); }
  top.terms = new Set(base);
  return top;
}
function highlight(text, terms) {
  return text.replace(/[\p{L}\p{N}]+/gu, w => {
    const k = stem(norm(w).replace(/ /g, ''));
    return (k.length > 1 && terms && terms.has(k)) ? `<mark>${esc(w)}</mark>` : esc(w);
  }).replace(/\n/g, '\n');
}
function renderParas(text, terms) {
  const h = (terms && terms.size) ? highlight : (t => esc(t));
  return text.split('\n').filter(Boolean).map(p => `<p>${terms && terms.size ? highlight(p, terms) : esc(p)}</p>`).join('');
}
const LAWNAME = { CONV: 'Convenio EMB', ET: 'Estatuto', LOLS: 'Libertad Sindical', LPRL: 'Prevención', LISOS: 'LISOS' };
const LAWSHORT = { CONV: 'Convenio', ET: 'ET', LOLS: 'LOLS', LPRL: 'LPRL', LISOS: 'LISOS' };
function shortCite(id, extra = '') {
  const a = BYID.get(id); if (!a) return id + extra;
  const pre = LAWSHORT[a.ley] || a.ley;
  return (a.num ? `${pre} art. ${a.num}` : `${pre} ${a.label.toLowerCase()}`) + extra;
}

/* ---------- utilidades de interfaz ---------- */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }
function copy(text) {
  const done = () => toast('Copiado');
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done)); else fallbackCopy(text, done);
}
function fallbackCopy(text, done) { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('No se pudo copiar'); } t.remove(); }
function setStatus() {
  const online = navigator.onLine, key = !!store.get('key', '');
  $('#status').innerHTML = `<span><span class="dot ${online ? '' : 'off'}"></span>${online ? 'En línea' : 'Sin conexión'}</span><span>${key ? 'Claude listo' : 'Solo offline'}</span>`;
}
function applyTheme() { const t = store.get('theme', 'auto'); if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); }

/* ---------- markdown mínimo para la respuesta de Claude ---------- */
function inline(t) {
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[(Seguro|Probable|Adivinando)\]/g, (m, x) => `<span class="tag ${x[0].toLowerCase()}">${x}</span>`);
  t = t.replace(/\[((?:CONV|ET|LOLS|LPRL|LISOS|D\d+)-[A-Za-z0-9\-áéíóú]+)([^\]]*)\]/g, (m, id, extra) => {
    const a = BYID.get(id); const ley = a ? a.ley : id.split('-')[0];
    return `<a class="cite" data-ley="${ley}" href="#/art/${encodeURIComponent(id)}">${esc(shortCite(id, extra.replace(/&amp;/g, '&')))}</a>`;
  });
  return t;
}
function md(src) {
  const lines = esc(src).split('\n'); const out = []; let list = null, para = [], tbl = null;
  const fp = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const cl = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const ft = () => {
    if (!tbl) return;
    const rows = tbl.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r)).map(r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim())));
    if (rows.length) out.push(`<div class="tblwrap"><table><thead><tr>${rows[0].map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    tbl = null;
  };
  for (const line of lines) {
    let m;
    if (/^\s*\|.*\|\s*$/.test(line)) { fp(); cl(); (tbl = tbl || []).push(line); continue; }
    ft();
    if (/^\s*$/.test(line)) { fp(); cl(); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { fp(); cl(); out.push('<hr>'); continue; }
    if ((m = line.match(/^#{1,4}\s+(.*)$/))) { fp(); cl(); out.push('<h3>' + inline(m[1]) + '</h3>'); continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { fp(); if (list !== 'ul') { cl(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + inline(m[1]) + '</li>'); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { fp(); if (list !== 'ol') { cl(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + inline(m[1]) + '</li>'); continue; }
    if ((m = line.match(/^&gt;\s?(.*)$/))) { fp(); cl(); out.push('<blockquote>' + inline(m[1]) + '</blockquote>'); continue; }
    cl(); para.push(line.trim());
  }
  ft(); fp(); cl(); return out.join('');
}

/* ---------- billete (pasaje citado) ---------- */
function ticket(r, opts = {}) {
  const a = r.art, part = a.parts[r.partIdx] || a.parts[0];
  const terms = opts.terms, long = part.text.length > 650;
  const ficha = C.fichas[a.id];
  const label = a.num ? `Art. ${a.num}` : a.label.replace('Disposición', 'Disp.').replace('Anexo 1, artículo', 'Anexo 1 · art.');
  const apTxt = part.ap ? ` · apartado${part.ap.includes('-') ? 's' : ''} ${part.ap}` : '';
  const more = a.parts.length > 1 ? `<button class="btn small" data-act="open" data-id="${esc(a.id)}">Ver artículo completo (${a.parts.length} fragmentos)</button>` : `<button class="btn small" data-act="open" data-id="${esc(a.id)}">Abrir</button>`;
  return `<article class="ticket" data-ley="${a.ley}" data-id="${esc(a.id)}">
    <div class="stub"><span class="law">${esc(LAWNAME[a.ley])}</span><span class="art">${esc(label)}</span><span class="ttl">${esc(a.title || a.ctx)}${esc(apTxt)}</span></div>
    <div class="legal ${long && !opts.full ? 'clamp' : ''}" data-part="${r.partIdx}">${renderParas(part.text, terms)}</div>
    <div class="foot">
      ${long && !opts.full ? `<button class="btn small" data-act="expand">Leer todo el fragmento</button>` : ''}
      ${ficha ? `<button class="btn small" data-act="ficha">Explicación sencilla</button>` : ''}
      ${more}
      <button class="btn small" data-act="copycite" data-id="${esc(a.id)}" data-part="${r.partIdx}">Copiar cita</button>
      <button class="btn small" data-act="fav" data-id="${esc(a.id)}">${isFav(a.id) ? 'Quitar' : 'Guardar'}</button>
      <button class="btn small" data-act="pin" data-id="${esc(a.id)}">Preguntar sobre este</button>
    </div></article>`;
}
function isFav(id) { return (store.get('favs', [])).includes(id); }
function toggleFav(id) { let f = store.get('favs', []); f = f.includes(id) ? f.filter(x => x !== id) : [id, ...f]; store.set('favs', f); return f.includes(id); }

/* ---------- Claude (opcional) ---------- */
const MODES = {
  sencilla: 'MODO SENCILLO: explica como a compañeros sin formación jurídica. Frases cortas, sin jerga; si usas un término técnico, tradúcelo entre paréntesis. Termina con un ejemplo concreto con números o fechas si los pasajes los permiten.',
  tecnica: 'MODO TÉCNICO: fundamento jurídico preciso. Estructura: 1) Norma aplicable y cita literal breve entre comillas con su [ID]; 2) Jerarquía y relación convenio / ley (el convenio no puede empeorar los mínimos legales de derecho necesario; si ambos regulan lo mismo, indica qué prevalece y por qué, solo si los pasajes lo permiten); 3) Interpretación y puntos dudosos; 4) Qué falta para cerrar la cuestión (otro texto, convenio anterior, jurisprudencia).',
  debate: 'MODO DEBATE: prepara al usuario para discutir con compañeros o con la empresa. Estructura: 1) Postura más defendible y por qué; 2) Argumentos a favor, cada uno con cita [ID]; 3) Contraargumentos que probablemente usará la otra parte y cómo responder a cada uno; 4) El punto débil de la postura (riesgo concreto); 5) Qué pedir o proponer y por qué cauce (Comisión Mixta art. 3, Comisión de Líneas, CSSL, Inspección de Trabajo, etc., solo si constan en los pasajes); 6) Plazos o requisitos formales que no se deben perder.',
  escrito: 'MODO ESCRITO: redacta el escrito que se pide (comunicado a la plantilla, petición de reunión, reclamación previa a la Comisión Mixta, acta, correo a la empresa…). Tono formal y claro, con las citas literales necesarias entre comillas y su [ID]. Deja [DATOS PENDIENTES] entre corchetes donde falte información. Antes del escrito, en 2-3 líneas, avisa de lo que el usuario debería comprobar.'
};
function systemPrompt() {
  const ctx = (store.get('ctx', '') || '').trim();
  const exigente = store.get('exigente', true);
  let s = `Eres el asesor técnico de un trabajador de EMB (Ezkerraldea Meatzaldea Bus, S.A.) que usa esta herramienta a diario para entender el Convenio Colectivo 2024-2027, el Estatuto de los Trabajadores y las funciones sindicales, y para debatir con compañeros y con la empresa. Respondes siempre en español de España.

REGLAS DE FUENTES (innegociables)
- Usa SOLO los pasajes que te llegan en el mensaje (convenio EMB, Estatuto de los Trabajadores, Ley Orgánica de Libertad Sindical, Ley de Prevención de Riesgos Laborales, LISOS). Cada pasaje lleva un ID entre corchetes, p. ej. [CONV-11] o [ET-37].
- Cada afirmación sustantiva sobre lo que dice una norma lleva su cita con ese ID. Cuando cites el texto, cópialo literal entre comillas y breve. No parafrasees un número, plazo o porcentaje: cópialo.
- Si los pasajes no bastan para responder, dilo en la primera frase y di exactamente qué falta (otro artículo, el convenio 2021-2023 que el artículo 11 menciona, jurisprudencia, otra norma). No inventes artículos, sentencias, plazos ni cifras.
- Texto del Estatuto: consolidado del BOE a 8-oct-2026; puede incluir cambios que entran en vigor el 23-oct-2026. Los anexos 2 a 5 del convenio son transcripciones de imágenes: si una cifra de esos anexos es decisiva, avisa de que hay que verificarla en el original.
- No eres abogado: si la cuestión es un conflicto serio, plazos de caducidad o un despido, termina con una línea recomendando el asesor jurídico del sindicato.`;
  if (exigente) s += `

ESTILO DE ASESOR (el usuario lo pide así)
1. Nunca empieces dándole la razón. La primera frase cuestiona su suposición, señala lo que se le escapa o formula la pregunta que expone el hueco.
2. Etiqueta cada afirmación sustantiva con [Seguro] (está en los pasajes), [Probable] (inferencia fuerte a partir de ellos) o [Adivinando] (rellenas huecos). Si casi toda tu respuesta es adivinar, dilo antes de nada.
3. Prohibido escribir: "Gran pregunta", "Tienes toda la razón", "Tiene mucho sentido", "Sin duda", "Definitivamente".
4. Cuando se equivoque: "No estoy de acuerdo porque [razón]. Esto es lo que yo haría en su lugar [alternativa]. El riesgo de tu enfoque es [desventaja concreta]."
5. Si hay una verdad incómoda, va en la primera línea, no enterrada.
6. Sin párrafos de calentamiento: empieza con lo más útil.
7. Si te contradice sin aportar información nueva, mantén tu posición.`;
  if (ctx) s += `\n\nCONTEXTO QUE EL USUARIO HA ESCRITO SOBRE SÍ MISMO\n${ctx}`;
  return s;
}
function passagesFor(question, pinned) {
  const res = search(question + (state.lastQ && question.split(/\s+/).length < 6 ? ' ' + state.lastQ : ''), 8);
  const chosen = []; const seen = new Set();
  const add = (a, pi) => { const k = a.id + '#' + pi; if (!seen.has(k) && chosen.length < 10) { seen.add(k); chosen.push([a, pi]); } };
  pinned.forEach(id => { const a = BYID.get(id); if (a) a.parts.slice(0, 3).forEach((p, i) => add(a, i)); });
  res.forEach(r => add(r.art, r.partIdx));
  return chosen;
}
function passagesText(chosen) {
  return chosen.map(([a, pi]) => {
    const p = a.parts[pi];
    return `[${a.id}] ${LAWNAME[a.ley]}, ${a.label}${a.title ? '. ' + a.title : ''}${p.ap ? ' (apartados ' + p.ap + ')' : ''}\n${p.text}`;
  }).join('\n\n---\n\n');
}
async function callClaude({ question, mode, thread, pinned, onDelta, signal }) {
  const key = store.get('key', '');
  const model = store.get('model', DEFAULT_MODEL) || DEFAULT_MODEL;
  const chosen = passagesFor(question, pinned);
  const messages = [];
  thread.slice(-4).forEach(t => { messages.push({ role: 'user', content: t.q }); messages.push({ role: 'assistant', content: t.a }); });
  messages.push({ role: 'user', content: `${MODES[mode]}\n\nPASAJES DISPONIBLES (fuente oficial)\n\n${passagesText(chosen)}\n\n=====\nPREGUNTA DEL USUARIO\n${question}` });
  const text = await streamClaude({ system: systemPrompt(), messages, maxTokens: 3000, onDelta, signal });
  return { text, chosen };
}
async function streamClaude({ system, messages, maxTokens, onDelta, signal }) {
  const key = store.get('key', '');
  const model = store.get('model', DEFAULT_MODEL) || DEFAULT_MODEL;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, system, messages })
  });
  if (!resp.ok) {
    let detail = ''; try { const j = await resp.json(); detail = j.error && j.error.message || ''; } catch (e) { }
    const map = { 401: 'La clave API no es válida. Revísala en Ajustes.', 403: 'Tu clave no tiene permiso para este modelo.', 404: `El modelo «${model}» no existe o tu clave no tiene acceso. Cámbialo en Ajustes.`, 429: 'Has llegado al límite de uso o de velocidad. Espera un minuto y reintenta.', 529: 'Anthropic está saturado ahora mismo. Reintenta en un momento.' };
    const e = new Error((map[resp.status] || `Error ${resp.status} de la API.`) + (detail ? ` (${detail})` : '')); e.status = resp.status; throw e;
  }
  const reader = resp.body.getReader(), dec = new TextDecoder(); let buf = '', full = '';
  for (; ;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim(); if (!data || data === '[DONE]') continue;
      try {
        const ev = JSON.parse(data);
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { full += ev.delta.text; onDelta(full); }
        if (ev.type === 'error') throw new Error(ev.error && ev.error.message || 'Error en la respuesta');
      } catch (e) { if (e.message && !/JSON/.test(e.message)) throw e; }
    }
  }
  return full;
}

/* ---------- vistas ---------- */
const main = $('#main');
function setTab(t) { document.querySelectorAll('.tabs a').forEach(a => a.removeAttribute('aria-current')); const el = $(`.tabs a[data-tab="${t}"]`); if (el) el.setAttribute('aria-current', 'page'); }

const IDEAS = [
  '¿Cuánto cobro los tres primeros días de una baja por enfermedad?',
  '¿Puede la empresa cambiarme el turno o el descanso sin avisar?',
  '¿Qué plazo tengo para reclamar en la Comisión de Líneas?',
  '¿Qué dice el Estatuto sobre el crédito horario de los representantes?',
  'Si rechazo una llamada de la bolsa, ¿qué me pasa?'
];
const MODE_LABEL = { sencilla: 'Sencilla', tecnica: 'Técnica', debate: 'Debate', escrito: 'Escrito', 'n-oferta': 'Valorar oferta', 'n-pedir': 'Qué podemos pedir', 'n-propuesta': 'Propuesta', 'n-acuerdo': 'Buscar acuerdo' };

function viewAsk() {
  setTab('preguntar');
  const key = !!store.get('key', '');
  main.innerHTML = `
    <section class="askbox">
      <label for="q" class="note" style="display:block;margin:0 0 4px">Tu duda, o la postura que quieres debatir</label>
      <textarea id="q" placeholder="Escribe con tus palabras. Por ejemplo: «creo que la empresa no puede obligarme a…»" enterkeyhint="send">${esc(state.q)}</textarea>
      <div class="modes" role="group" aria-label="Tipo de respuesta de Claude">
        ${Object.keys(MODES).map(m => `<button type="button" data-mode="${m}" aria-pressed="${state.mode === m}">${MODE_LABEL[m]}</button>`).join('')}
      </div>
      <div id="pins">${state.pinned.map(id => `<span class="pin">${esc(shortCite(id))}<button type="button" data-unpin="${esc(id)}" aria-label="Quitar ${esc(shortCite(id))}">×</button></span>`).join('')}</div>
      <div class="row">
        <button class="btn primary" id="go" type="button">Buscar artículos</button>
        <button class="btn" id="ai" type="button" ${state.busy ? 'disabled' : ''}>Preguntar a Claude</button>
        ${state.thread.length ? '<button class="btn small" id="newq" type="button">Nueva consulta</button>' : ''}
      </div>
      <p class="note" style="margin:8px 2px 0">${key ? 'Claude recibe solo tu pregunta y los artículos encontrados.' : 'Sin clave de Claude: la búsqueda funciona igual, sin conexión.'}</p>
    </section>
    <div id="out"></div>`;
  $('#go').onclick = () => doSearch();
  $('#ai').onclick = () => doAsk();
  const nq = $('#newq'); if (nq) nq.onclick = () => { state.thread = []; state.results = []; state.q = ''; state.lastQ = ''; state.pinned = []; viewAsk(); };
  $('#q').addEventListener('input', e => { state.q = e.target.value; });
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doSearch(); });
  main.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { state.mode = b.dataset.mode; store.set('mode', state.mode); main.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-pressed', x.dataset.mode === state.mode)); });
  main.querySelectorAll('[data-unpin]').forEach(b => b.onclick = () => { state.pinned = state.pinned.filter(x => x !== b.dataset.unpin); viewAsk(); renderOut(); });
  renderOut();
}
function renderOut() {
  const out = $('#out'); if (!out) return;
  let h = '';
  if (!state.results.length && !state.thread.length) {
    h = `<p class="lead">Pregunta con tus palabras. Sin conexión te enseño los artículos exactos. Con conexión, Claude los explica y te prepara el debate, siempre citando el texto.</p>
      <ul class="ideas">${IDEAS.map(i => `<li><button type="button" data-idea="${esc(i)}">${esc(i)}</button></li>`).join('')}</ul>`;
    const hist = store.get('hist', []);
    if (hist.length) h += `<h2 class="section-title">Últimas consultas</h2><ul class="ideas">${hist.slice(0, 5).map(i => `<li><button type="button" data-idea="${esc(i)}">${esc(i)}</button></li>`).join('')}</ul>`;
  }
  state.thread.forEach((t, i) => {
    h += `<section class="answer" data-i="${i}"><div class="who"><span>Claude · ${MODE_LABEL[t.mode]}</span><span><button class="btn small" data-act="copyans" data-i="${i}">Copiar</button> <button class="btn small" data-act="savans" data-i="${i}">Guardar</button></span></div><p class="q">${esc(t.q)}</p><div class="prose ${t.streaming ? 'typing' : ''}">${t.err ? '' : md(t.a)}</div>${t.err ? `<div class="err">${esc(t.err)}</div>` : ''}</section>`;
  });
  if (state.results.length) {
    h += `<h2 class="section-title">${state.thread.length ? 'Artículos usados' : 'Artículos encontrados'}</h2>` + state.results.map(r => ticket(r, { terms: state.results.terms })).join('');
    h += `<p class="note">Texto literal del convenio y de las leyes. Si no aparece lo que buscas, prueba con otras palabras o abre «Leer».</p>`;
  } else if (state.q && state.searched) {
    h += `<p class="lead">No he encontrado nada con esas palabras. Prueba con otros términos o con un número de artículo («art. 11 convenio»).</p>`;
  }
  out.innerHTML = h;
  out.querySelectorAll('[data-idea]').forEach(b => b.onclick = () => { state.q = b.dataset.idea; $('#q').value = state.q; doSearch(); });
}
function remember(q) { let h = store.get('hist', []); h = [q, ...h.filter(x => x !== q)].slice(0, 30); store.set('hist', h); }
function doSearch() {
  const q = (state.q || '').trim(); if (!q) { toast('Escribe primero tu duda'); return null; }
  state.results = search(q); state.searched = true; remember(q); renderOut();
  const t = $('#out .ticket'); if (t && !state.thread.length) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return q;
}
async function doAsk() {
  const q = (state.q || '').trim(); if (!q) { toast('Escribe primero tu duda'); return; }
  if (!store.get('key', '')) { toast('Falta la clave de Claude: ponla en Ajustes'); location.hash = '#/ajustes'; return; }
  if (!navigator.onLine) { doSearch(); toast('Sin conexión: te enseño los artículos'); return; }
  if (state.busy) return;
  state.busy = true; state.results = search(q); state.searched = true; remember(q);
  const turn = { q, a: '', mode: state.mode, streaming: true, err: '' }; state.thread.push(turn);
  $('#ai').disabled = true; renderOut();
  const el = () => $(`#out .answer[data-i="${state.thread.length - 1}"] .prose`);
  el() && el().scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const { text, chosen } = await callClaude({
      question: q, mode: state.mode, thread: state.thread.slice(0, -1).filter(t => !t.err), pinned: state.pinned,
      onDelta: txt => { turn.a = txt; const e = el(); if (e) e.innerHTML = md(txt); }
    });
    turn.a = text; turn.streaming = false;
    // los artículos mostrados son los que Claude recibió
    state.results = chosen.map(([a, pi]) => ({ art: a, partIdx: pi })); state.results.terms = new Set(toks(q));
    const seen = new Set(); state.results = state.results.filter(r => !seen.has(r.art.id) && seen.add(r.art.id));
    state.lastQ = q; state.q = '';
  } catch (e) {
    turn.streaming = false; turn.err = e.name === 'TypeError' ? 'No he podido conectar con la API de Anthropic. Comprueba la conexión. Si usas el móvil con datos, desactiva el ahorro de datos o el bloqueo de anuncios para este sitio.' : e.message;
  }
  state.busy = false; viewAsk();
  const t = $('#out .answer:last-of-type'); if (t) t.scrollIntoView({ block: 'start' });
}

/* Leer */
function viewRead() {
  setTab('leer');
  const laws = Object.keys(C.laws); if (!C.laws[state.law]) state.law = 'CONV';
  const list = (ORDER[state.law] || []).filter(a => {
    if (!state.filter) return true; const f = norm(state.filter);
    return norm(a.label + ' ' + a.title + ' ' + (a.num || '')).includes(f);
  });
  main.innerHTML = `
    <div class="pills" role="group" aria-label="Norma">${laws.map(l => `<button type="button" data-law="${l}" aria-pressed="${state.law === l}">${esc(LAWNAME[l])}</button>`).join('')}</div>
    <p class="note" style="margin:8px 2px">${esc((C.laws[state.law] || C.laws.CONV).full)}${C.laws[state.law] && C.laws[state.law].user ? ' · documento tuyo' : ''}</p>
    <input class="field" id="flt" type="search" placeholder="Filtrar por número o título (ej. 37, licencias)" value="${esc(state.filter)}" autocomplete="off">
    <ul class="list" style="--c:${lawColor(state.law)}">
      ${list.map(a => `<li><a href="#/art/${encodeURIComponent(a.id)}"><span class="n">${esc(a.num ? 'Art. ' + a.num : a.label.replace('Disposición', 'Disp.').replace('Anexo 1, artículo', 'Anexo 1 ·'))}</span><span class="t">${esc(a.title || a.ctx)}</span></a></li>`).join('') || '<li class="note" style="padding:12px 4px">Nada con ese filtro.</li>'}
    </ul>`;
  main.querySelectorAll('[data-law]').forEach(b => b.onclick = () => { state.law = b.dataset.law; state.filter = ''; viewRead(); });
  $('#flt').addEventListener('input', e => { state.filter = e.target.value; const pos = e.target.selectionStart; viewRead(); const f = $('#flt'); f.focus(); f.setSelectionRange(pos, pos); });
}
function viewArt(id) {
  setTab('leer');
  const a = BYID.get(id); if (!a) { main.innerHTML = '<p class="lead">No encuentro ese artículo.</p>'; return; }
  const order = ORDER[a.ley], i = order.indexOf(a), prev = order[i - 1], next = order[i + 1];
  const ficha = C.fichas[a.id], law = C.laws[a.ley];
  main.innerHTML = `
    <a class="back" href="#/leer">‹ ${esc(LAWNAME[a.ley])}</a>
    <div class="reader-head"><h2>${esc(a.label)}</h2><p>${esc(a.title || '')}</p><p class="note">${esc(a.ctx)}</p></div>
    ${law.note && a.ley !== 'LOLS' ? `<div class="warn">${esc(law.note)}</div>` : ''}${law.user ? `<p class="note">Documento importado por ti. El troceo en artículos es automático: si algo se ve cortado, ábrelo en el original.</p>` : ''}
    <article class="ticket" data-ley="${a.ley}" data-id="${esc(a.id)}" style="--notch:0px">
      <div class="stub" style="border-bottom:0;padding-bottom:0"><span class="law">${esc(law.full)}</span></div>
      <div class="legal">${a.parts.map(p => `${p.ap ? `<p class="note">Apartado${p.ap.includes('-') ? 's' : ''} ${esc(p.ap)}</p>` : ''}${renderParas(p.text)}`).join('')}</div>
      <div class="foot">
        <button class="btn small" data-act="copyart" data-id="${esc(a.id)}">Copiar texto</button>
        <button class="btn small" data-act="fav" data-id="${esc(a.id)}">${isFav(a.id) ? 'Quitar' : 'Guardar'}</button>
        <button class="btn small" data-act="pin" data-id="${esc(a.id)}">Preguntar sobre este</button>
        ${law.url ? `<a class="btn small" style="text-decoration:none;display:inline-flex;align-items:center" href="${law.url}" target="_blank" rel="noopener">Ver en el BOE</a>` : ''}
      </div>
    </article>
    ${ficha ? `<h2 class="section-title">Explicación sencilla</h2><div class="item"><p><strong>${esc(ficha.frase)}</strong></p><div class="prose">${ficha.html}</div></div>` : ''}
    <div class="row" style="justify-content:space-between">
      ${prev ? `<a class="btn" style="text-decoration:none" href="#/art/${encodeURIComponent(prev.id)}">‹ ${esc(prev.num ? 'Art. ' + prev.num : prev.label)}</a>` : '<span></span>'}
      ${next ? `<a class="btn" style="text-decoration:none" href="#/art/${encodeURIComponent(next.id)}">${esc(next.num ? 'Art. ' + next.num : next.label)} ›</a>` : '<span></span>'}
    </div>`;
  window.scrollTo(0, 0);
}
/* Guardados */
function viewSaved() {
  setTab('guardados');
  const favs = store.get('favs', []).map(id => BYID.get(id)).filter(Boolean);
  const ans = store.get('answers', []);
  main.innerHTML = `
    <h2 class="section-title" style="margin-top:4px">Artículos guardados</h2>
    ${favs.length ? favs.map(a => `<div class="item"><h3><a href="#/art/${encodeURIComponent(a.id)}">${esc(shortCite(a.id))}</a></h3><p class="note" style="margin:0">${esc(a.title)}</p><div class="row"><button class="btn small" data-act="fav" data-id="${esc(a.id)}" data-refresh="1">Quitar</button><button class="btn small" data-act="pin" data-id="${esc(a.id)}">Preguntar sobre este</button></div></div>`).join('') : '<p class="lead" style="margin-top:0">Aún no has guardado artículos. Pulsa «Guardar» en cualquier artículo.</p>'}
    <h2 class="section-title">Respuestas guardadas</h2>
    ${ans.length ? ans.map((r, i) => `<div class="item"><h3>${esc(r.q)}</h3><p class="note" style="margin:0">${esc(new Date(r.t).toLocaleDateString('es-ES'))} · ${esc(MODE_LABEL[r.mode] || '')}</p><div class="prose" style="margin-top:6px">${md(r.a)}</div><div class="row"><button class="btn small" data-act="copysaved" data-i="${i}">Copiar</button><button class="btn small" data-act="delsaved" data-i="${i}">Borrar</button></div></div>`).join('') : '<p class="lead" style="margin-top:0">Aquí aparecerán las respuestas de Claude que guardes.</p>'}`;
}
/* Ajustes */
function viewSettings() {
  setTab('ajustes');
  const key = store.get('key', ''), model = store.get('model', DEFAULT_MODEL);
  main.innerHTML = `
    <div class="setting"><label for="key">Clave API de Anthropic (opcional)</label>
      <input class="field" id="key" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(key)}">
      <p class="note">Solo para el botón «Preguntar a Claude». La clave se guarda en este dispositivo y viaja únicamente a api.anthropic.com. Se crea en console.anthropic.com y se paga por uso, aparte de tu suscripción a Claude. Sin clave, el buscador funciona igual.</p>
      <div class="row"><button class="btn small" id="savekey">Guardar clave</button><button class="btn small" id="test">Probar conexión</button><button class="btn small" id="delkey">Borrar clave</button></div></div>
    <div class="setting"><label for="model">Modelo</label>
      <input class="field" id="model" list="models" value="${esc(model)}"><datalist id="models"><option value="claude-sonnet-5-5"><option value="claude-opus-5-5"><option value="claude-haiku-5-5"><option value="claude-fable-5-1"></datalist>
      <p class="note">Sonnet equilibra coste y calidad. Opus razona mejor en casos difíciles y cuesta más.</p></div>
    <div class="setting"><label for="ctx">Contexto sobre ti (opcional)</label>
      <textarea class="field" id="ctx" rows="3" placeholder="Ej.: soy conductor, línea…, turno…, y quiero que me respondas pensando en…">${esc(store.get('ctx', ''))}</textarea>
      <p class="note">Se envía a Claude con cada pregunta. Escribe solo lo necesario.</p></div>
    <div class="setting"><label><input type="checkbox" id="ex" ${store.get('exigente', true) ? 'checked' : ''}> Asesor exigente</label>
      <p class="note">Claude cuestiona tu suposición antes de darte la razón, etiqueta cada afirmación como Seguro, Probable o Adivinando y discrepa con razones.</p></div>
    <div class="setting"><label for="theme">Tema</label>
      <select class="field" id="theme"><option value="auto">Automático</option><option value="light">Claro</option><option value="dark">Oscuro (conducción nocturna)</option></select></div>
    <h2 class="section-title">Textos incluidos</h2>
    ${Object.entries(C.laws).map(([k, l]) => `<div class="item"><h3>${esc(l.name)}</h3><p class="note" style="margin:0">${esc(l.full)}</p><p class="note" style="margin:4px 0 0">${esc(l.note)}</p></div>`).join('')}
    <p class="note">Base de datos generada el ${esc(C.built)}. Los textos legales vuelven a cambiar: antes de citar una norma ante la empresa, comprueba la vigencia en el BOE.</p>
    <div class="setting"><label>Copia de seguridad</label>
      <p class="note">Incluye tus documentos importados y los datos de costes. Úsala para pasar todo al móvil.</p>
      <div class="row"><button class="btn small" id="exp">Exportar guardados</button><button class="btn small" id="imp">Importar</button><input type="file" id="file" accept="application/json" hidden></div></div>
    <div class="row"><button class="btn small" id="wipe">Borrar todos mis datos</button></div>`;
  $('#theme').value = store.get('theme', 'auto');
  $('#theme').onchange = e => { store.set('theme', e.target.value); applyTheme(); };
  $('#savekey').onclick = () => { store.set('key', $('#key').value.trim()); store.set('model', $('#model').value.trim() || DEFAULT_MODEL); setStatus(); toast('Guardado'); };
  $('#delkey').onclick = () => { store.del('key'); $('#key').value = ''; setStatus(); toast('Clave borrada'); };
  $('#model').onchange = e => store.set('model', e.target.value.trim() || DEFAULT_MODEL);
  $('#ctx').onchange = e => store.set('ctx', e.target.value);
  $('#ex').onchange = e => store.set('exigente', e.target.checked);
  $('#test').onclick = async () => {
    store.set('key', $('#key').value.trim()); store.set('model', $('#model').value.trim() || DEFAULT_MODEL);
    if (!store.get('key', '')) return toast('Escribe la clave primero');
    if (!navigator.onLine) return toast('Sin conexión');
    toast('Probando…');
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': store.get('key', ''), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model: store.get('model', DEFAULT_MODEL), max_tokens: 8, messages: [{ role: 'user', content: 'Responde: OK' }] }) });
      if (r.ok) toast('Conexión correcta'); else { const j = await r.json().catch(() => ({})); toast((j.error && j.error.message) || ('Error ' + r.status)); }
    } catch (e) { toast('No se pudo conectar'); }
    setStatus();
  };
  $('#exp').onclick = () => {
    const data = { favs: store.get('favs', []), answers: store.get('answers', []), hist: store.get('hist', []), costes: store.get('costes', null), docs: USERDOCS.map(d => ({ id: d.id, name: d.name, full: d.full, kind: d.kind, added: d.added, text: d.text })) };
    const b = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), u = URL.createObjectURL(b);
    const a = document.createElement('a'); a.href = u; a.download = 'asesor-convenio-copia.json'; a.click(); setTimeout(() => URL.revokeObjectURL(u), 2000);
  };
  $('#imp').onclick = () => $('#file').click();
  $('#file').onchange = e => { const f = e.target.files[0]; if (!f) return; f.text().then(t => { try { const d = JSON.parse(t); if (d.favs) store.set('favs', d.favs); if (d.answers) store.set('answers', d.answers); if (d.hist) store.set('hist', d.hist); if (d.costes) store.set('costes', d.costes); if (d.docs) Promise.all(d.docs.map(x => saveUserDoc(x))).then(() => { buildIndex(); toast('Importado'); }); else toast('Importado'); } catch (er) { toast('Archivo no válido'); } }); };
  $('#wipe').onclick = () => { if (confirm('¿Borrar clave, guardados, historial, documentos importados y costes de este dispositivo?')) { ['key', 'favs', 'answers', 'hist', 'ctx', 'model', 'theme', 'mode', 'exigente', 'costes', 'nego'].forEach(store.del); clearUserDocs().then(buildIndex); setStatus(); applyTheme(); viewSettings(); toast('Datos borrados'); } };
}

/* ---------- acciones delegadas ---------- */
document.addEventListener('click', e => {
  const cite = e.target.closest('a.cite'); if (cite) return; // navega por hash
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;
  const tk = b.closest('.ticket');
  if (act === 'expand') { tk.querySelector('.legal').classList.remove('clamp'); b.remove(); }
  else if (act === 'ficha') {
    const ex = tk.querySelector('.ficha'); if (ex) { ex.remove(); return; }
    const f = C.fichas[tk.dataset.id]; const d = document.createElement('div'); d.className = 'ficha'; d.innerHTML = `<p><strong>${esc(f.frase)}</strong></p>${f.html}`; tk.querySelector('.foot').before(d);
  }
  else if (act === 'open') location.hash = '#/art/' + encodeURIComponent(id);
  else if (act === 'copycite') { const a = BYID.get(id), p = a.parts[+b.dataset.part]; copy(`«${p.text.replace(/\n/g, ' ')}»\n(${LAWNAME[a.ley] === 'Convenio EMB' ? 'Convenio EMB 2024-2027' : C.laws[a.ley].full}, ${a.label}${a.title ? '. ' + a.title : ''})`); }
  else if (act === 'copyart') { const a = BYID.get(id); copy(`${a.label}${a.title ? '. ' + a.title : ''}\n\n` + a.parts.map(p => p.text).join('\n') + `\n\n(${C.laws[a.ley].full})`); }
  else if (act === 'fav') { const on = toggleFav(id); toast(on ? 'Guardado' : 'Quitado'); if (b.dataset.refresh) viewSaved(); else b.textContent = on ? 'Quitar' : 'Guardar'; }
  else if (act === 'pin') { if (!state.pinned.includes(id)) state.pinned.push(id); toast(shortCite(id) + ' añadido a tu pregunta'); location.hash = '#/preguntar'; }
  else if (act === 'copyans') copy(state.thread[+b.dataset.i].a);
  else if (act === 'savans') { const t = state.thread[+b.dataset.i]; const l = store.get('answers', []); l.unshift({ q: t.q, a: t.a, mode: t.mode, t: Date.now() }); store.set('answers', l.slice(0, 100)); toast('Respuesta guardada'); }
  else if (act === 'copysaved') copy(store.get('answers', [])[+b.dataset.i].a);
  else if (act === 'delsaved') { const l = store.get('answers', []); l.splice(+b.dataset.i, 1); store.set('answers', l); viewSaved(); }
});

/* ---------- ruta ---------- */
function route() {
  const h = decodeURIComponent(location.hash || '#/preguntar');
  if (h.startsWith('#/art/')) return viewArt(h.slice(6));
  if (h === '#/leer') return viewRead();
  if (h === '#/guardados') return viewSaved();
  if (h === '#/ajustes') return viewSettings();
  if (h.startsWith('#/negociar')) return viewNego(h.split('/')[2] || '');
  viewAsk();
}
window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });
window.addEventListener('online', setStatus); window.addEventListener('offline', setStatus);
applyTheme(); setStatus();
loadUserDocs().then(() => { buildIndex(); route(); }).catch(() => { buildIndex(); route(); });
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => { });
