/* CasEdge — Case Math Drills (curated). Self-injecting, self-contained.
   Thin client: the drill library, answer keys, checklists and reference
   solutions live server-side in /api/drills. The browser receives only the
   prompt + exhibit + step prompts, and per graded answer a verdict + the
   bilingual reference. Bilingual EN/RU via state.aiLang. */
(function () {
  "use strict";

  /* ---------- inject CSS + screen ---------- */
  var CSS = `#screen-cmdrill { position:fixed; inset:0; z-index:50; height:100vh; height:100dvh; overflow:hidden; background:var(--surface-dark); display:none; flex-direction:column; }
#screen-cmdrill.active { display:flex; }
#cmFeed { flex:1; overflow-y:auto; padding:22px 16px 28px; }
.cm-wrap { max-width:760px; margin:0 auto; }
.cm-top { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--sv-line,rgba(31,41,55,.12)); background:var(--surface-dark-elevated,#fbf8f2); }
.cm-top .cm-x { background:none; border:none; font-size:22px; line-height:1; color:var(--on-dark-soft,#5b6472); cursor:pointer; }
.cm-top .cm-lbl { font-size:13px; font-weight:700; color:var(--ink,#1f2937); }
.cm-top .cm-prog { margin-left:auto; font-size:12px; color:var(--on-dark-soft,#9db3ad); }
.cm-card { background:var(--surface-dark-elevated,#16241f); border:1px solid var(--sv-line,rgba(255,255,255,.08)); border-radius:14px; padding:18px; margin:0 0 16px; }
.cm-meta { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
.cm-tag { font-size:10.5px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; padding:3px 9px; border-radius:999px; background:rgba(93,184,166,.12); color:var(--coral,#5db8a6); }
.cm-tag.trap { background:rgba(232,124,124,.12); color:#c9564a; } .cm-tag.clean { background:rgba(95,191,107,.14); color:#3f9a4c; }
.cm-title { font-size:18px; font-weight:800; color:var(--ink,#1f2937); margin:0 0 10px; }
.cm-prompt { font-size:15px; line-height:1.65; color:var(--ink,#28303c); } .cm-prompt b { color:var(--ink,#1f2937); }
.cm-exh { margin:16px 0 6px; }
.cm-exh-name { font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--coral,#5db8a6); margin-bottom:8px; }
.cm-tbl { width:100%; border-collapse:collapse; font-size:13.5px; }
.cm-tbl th, .cm-tbl td { padding:8px 10px; border-bottom:1px solid var(--sv-line,rgba(31,41,55,.10)); color:var(--ink,#28303c); text-align:left; }
.cm-tbl th { font-weight:700; color:var(--on-dark-soft,#6b7c76); font-size:11.5px; text-transform:uppercase; letter-spacing:.03em; }
.cm-tbl td:not(:first-child), .cm-tbl th:not(:first-child) { text-align:right; font-variant-numeric:tabular-nums; }
.cm-steps { margin:14px 0 0; padding:12px 14px; background:rgba(93,184,166,.06); border-radius:10px; }
.cm-steps .cm-sh { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:var(--on-dark-soft,#6b7c76); margin-bottom:6px; }
.cm-steps ol { margin:0; padding-left:20px; } .cm-steps li { font-size:14px; line-height:1.55; color:var(--ink,#28303c); margin:2px 0; }
#cmInput { border-top:1px solid var(--sv-line,rgba(31,41,55,.12)); background:var(--surface-dark-elevated,#fbf8f2); padding:14px 16px; }
.cm-iz { max-width:760px; margin:0 auto; }
.cm-ta { width:100%; min-height:88px; resize:vertical; background:var(--surface-dark-soft,#efe9dd); border:1.5px solid var(--sv-line,rgba(31,41,55,.16)); border-radius:12px; padding:12px 14px; color:var(--ink,#1f2937); font-size:15px; font-family:inherit; line-height:1.5; box-sizing:border-box; }
.cm-ta:focus { outline:none; border-color:var(--coral,#5db8a6); }
.cm-row { display:flex; justify-content:space-between; align-items:center; margin-top:10px; gap:10px; }
.cm-hint { font-size:12.5px; color:var(--on-dark-soft,#9db3ad); }
.cm-btn { background:var(--coral,#5db8a6); color:#04201b; border:none; border-radius:11px; padding:12px 24px; font-size:14.5px; font-weight:700; cursor:pointer; }
.cm-btn:disabled { opacity:.45; cursor:default; } .cm-btn.ghost { background:transparent; color:var(--coral,#5db8a6); border:1.5px solid rgba(93,184,166,.45); }
.cm-fb { border-radius:12px; padding:13px 15px; margin:0 0 16px; font-size:14px; line-height:1.6; }
.cm-fb.ok { background:rgba(95,191,107,.10); border:1px solid rgba(95,191,107,.4); color:#2f7d3a; }
.cm-fb.no { background:rgba(232,124,124,.10); border:1px solid rgba(232,124,124,.4); color:#b23b3b; }
.cm-fb b { color:var(--ink,#1f2937); }
.cm-ref { background:var(--surface-dark-elevated,#16241f); border:1px solid var(--sv-line,rgba(31,41,55,.10)); border-radius:12px; padding:15px 16px; margin:0 0 16px; }
.cm-ref-h { font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--coral,#5db8a6); margin-bottom:8px; }
.cm-ref-body { font-size:13.8px; line-height:1.65; color:var(--ink,#28303c); } .cm-ref-body b { color:var(--ink,#1f2937); }
.cm-ref-body p { margin:0 0 7px; } .cm-ref-body p:last-child { margin:0; }
.cm-trap { font-size:12.5px; color:var(--on-dark-soft,#8fa39d); font-style:italic; margin-top:10px; }
`;
  var SCREEN = `<div class="cm-top">
    <button class="cm-x" onclick="CaseMathDrills.exit()" title="Exit">&times;</button>
    <span class="cm-lbl">Case Math · Drills</span>
    <span class="cm-prog" id="cmProg"></span>
  </div>
  <div id="cmFeed"><div class="cm-wrap" id="cmWrap"></div></div>
  <div id="cmInput" style="display:none"><div class="cm-iz" id="cmIz"></div></div>`;

  function inject() {
    if (!document.getElementById('screen-cmdrill')) {
      var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
      var d = document.createElement('div'); d.id = 'screen-cmdrill'; d.className = 'screen';
      d.setAttribute('data-screen-label', 'Case Math Drills'); d.innerHTML = SCREEN;
      document.body.appendChild(d);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject); else inject();

  /* ---------- helpers ---------- */
  function E(id) { return document.getElementById(id); }
  function esc2(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function md(s) {
    s = esc2(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
    return s.split(/\n{2,}/).map(function (p) { return '<p>' + p.replace(/\n/g, '<br>') + '</p>'; }).join('');
  }
  function L(v) {
    if (v && typeof v === 'object' && ('en' in v || 'ru' in v)) {
      var lang = (typeof state !== 'undefined' && state && state.aiLang === 'ru') ? 'ru' : 'en';
      return v[lang] != null ? v[lang] : (v.en != null ? v.en : v.ru);
    }
    return v;
  }
  function scrollFeed() { var f = E('cmFeed'); if (f) setTimeout(function () { f.scrollTop = f.scrollHeight; }, 40); }

  function freshToken() {
    if (typeof sb === 'undefined' || !sb) return Promise.resolve(null);
    return sb.auth.getSession().then(function (r) {
      var s = r && r.data && r.data.session;
      if (s && s.expires_at && (s.expires_at * 1000 - Date.now() < 60000)) return sb.auth.refreshSession().then(function (rr) { return (rr && rr.data && rr.data.session) || s; });
      return s;
    }).then(function (s) { return s ? s.access_token : null; }).catch(function () { return null; });
  }
  function api(payload) {
    return freshToken().then(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      return fetch('/api/drills', { method: 'POST', headers: headers, body: JSON.stringify(payload) });
    }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }

  function tableHTML(ex) {
    var h = '<table class="cm-tbl"><thead><tr>' + (ex.header || []).map(function (c) { return '<th>' + esc2(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
    h += (ex.rows || []).map(function (row) { return '<tr>' + row.map(function (c) { return '<td>' + esc2(c) + '</td>'; }).join('') + '</tr>'; }).join('');
    return h + '</tbody></table>';
  }

  /* ---------- state ---------- */
  var S = { done: [], drill: null };
  function loadDone() { try { S.done = JSON.parse(localStorage.getItem('casedge_cmdrills_done') || '[]'); } catch (e) { S.done = []; } }
  function saveDone(id) { if (S.done.indexOf(id) < 0) S.done.push(id); try { localStorage.setItem('casedge_cmdrills_done', JSON.stringify(S.done)); } catch (e) {} }

  /* ---------- flow ---------- */
  function open() {
    inject();
    if (typeof showScreen === 'function') showScreen('cmdrill');
    loadDone();
    var w = E('cmWrap'); if (w) w.innerHTML = '';
    izHide();
    loadNext();
  }
  function exit() { if (typeof showScreen === 'function') showScreen('mode'); }

  function iz(html) { var z = E('cmInput'), i = E('cmIz'); if (!z || !i) return; z.style.display = 'block'; i.innerHTML = html; }
  function izHide() { var z = E('cmInput'); if (z) z.style.display = 'none'; }
  function feed(html) { var w = E('cmWrap'); if (!w) return; var d = document.createElement('div'); d.innerHTML = html; w.appendChild(d.firstElementChild || d); scrollFeed(); }

  function loadNext() {
    var w = E('cmWrap'); if (w) w.innerHTML = '';
    izHide();
    var pr = E('cmProg'); if (pr) pr.textContent = 'Loading…';
    api({ action: 'next', doneIds: S.done }).then(function (r) {
      if (r && r.error) { if (w) w.innerHTML = '<div class="cm-card"><div class="cm-title">Case Math</div><div class="cm-prompt">Could not load — please make sure you are signed in, then try again.</div></div>'; return; }
      var d = r && r.drill;
      if (!d) {   // all done → recycle
        S.done = []; try { localStorage.removeItem('casedge_cmdrills_done'); } catch (e) {}
        feed('<div class="cm-card"><div class="cm-title">Set complete 🎉</div><div class="cm-prompt">You have worked through every Case Math drill in this batch. Starting again from the top.</div></div>');
        return void setTimeout(loadNext, 900);
      }
      S.drill = d;
      renderDrill(d);
    }).catch(function () { if (w) w.innerHTML = '<div class="cm-card"><div class="cm-title">Case Math</div><div class="cm-prompt">Could not load this drill — please try again.</div></div>'; });
  }

  function renderDrill(d) {
    var pr = E('cmProg'); if (pr) pr.textContent = 'Drill ' + d.index + ' / ' + d.total;
    var tcls = (d.type || '').toLowerCase() === 'clean' ? 'clean' : 'trap';
    var html = '<div class="cm-card">' +
      '<div class="cm-meta">' +
        '<span class="cm-tag ' + tcls + '">' + esc2(d.type || '') + '</span>' +
        '<span class="cm-tag">' + esc2(d.difficulty || '') + '</span>' +
        (d.time ? '<span class="cm-tag">' + esc2(d.time) + '</span>' : '') +
        (d.focus ? '<span class="cm-tag">' + esc2(d.focus) + '</span>' : '') +
      '</div>' +
      '<div class="cm-title">' + esc2(d.title || 'Drill') + '</div>' +
      '<div class="cm-prompt">' + md(d.prompt || '') + '</div>' +
      (d.exhibit && d.exhibit.rows ? '<div class="cm-exh"><div class="cm-exh-name">Exhibit</div>' + tableHTML(d.exhibit) + '</div>' : '') +
      ((d.step_prompts && d.step_prompts.length) ? '<div class="cm-steps"><div class="cm-sh">Solve</div><ol>' + d.step_prompts.map(function (s) { return '<li>' + esc2(s) + '</li>'; }).join('') + '</ol></div>' : '') +
      '</div>';
    feed(html);
    iz('<textarea class="cm-ta" id="cmTa" placeholder="Show your numbers and your one-sentence recommendation…"></textarea>' +
       '<div class="cm-row"><span class="cm-hint">Give the number(s) the drill asks for, then your read of the trap.</span>' +
       '<button class="cm-btn" id="cmSubmit" onclick="CaseMathDrills._submit()">Submit</button></div>');
    setTimeout(function () { var el = E('cmTa'); if (el) el.focus(); }, 60);
  }

  function _submit() {
    var el = E('cmTa'); if (!el) return; var answer = el.value.trim(); if (!answer) return;
    var b = E('cmSubmit'); if (b) b.disabled = true;
    iz('<div class="cm-hint">Grading your answer…</div>');
    var d = S.drill;
    api({ action: 'grade', drillId: d.id, answer: answer }).then(function (r) {
      if (r && r.error) { feed('<div class="cm-fb no"><b>Connection issue.</b> ' + esc2(r.error.message || 'Please try again.') + '</div>'); return void nextButton(); }
      var ok = !!r.pass;
      feed('<div class="cm-fb ' + (ok ? 'ok' : 'no') + '">' + (ok ? '<b>✓ Pass.</b> ' : '<b>Not quite.</b> ') + esc2(r.coaching || '') + '</div>');
      var ref = L(r.reference); var prov = L(r.provoked);
      feed('<div class="cm-ref"><div class="cm-ref-h">Reference solution</div><div class="cm-ref-body">' + md(ref || '') + '</div>' +
           (prov ? '<div class="cm-trap"><b>Trap:</b> ' + esc2(prov) + '</div>' : '') + '</div>');
      saveDone(d.id);
      nextButton();
    }).catch(function () { feed('<div class="cm-fb no"><b>Connection issue.</b> Please try again.</div>'); nextButton(); });
  }

  function nextButton() {
    iz('<div class="cm-row" style="justify-content:flex-end"><button class="cm-btn" onclick="CaseMathDrills._next()">Next drill →</button></div>');
  }
  function _next() { loadNext(); }

  window.CaseMathDrills = { open: open, exit: exit, _submit: _submit, _next: _next };
})();
