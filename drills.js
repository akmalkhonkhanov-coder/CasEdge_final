/* CasEdge — Case Math Drills (curated). Self-injecting, self-contained.
   Thin client: the drill library, answer keys, checklists and reference
   solutions live server-side in /api/drills. The browser receives only the
   prompt + exhibit + step prompts, and per graded answer a verdict + the
   bilingual reference. Bilingual EN/RU via state.aiLang. */
(function () {
  "use strict";

  /* ---------- inject CSS + screen ---------- */
  var CSS = `
/* 2026-07-27: --ink — цвет ТЕКСТА НА СВЕТЛОМ. В тёмной теме (она по умолчанию)
   --ink = #141413, а фон экрана --surface-dark = #181715: чёрным по чёрному.
   Экран строился под светлую тему. Текст на тёмных поверхностях берёт --on-dark. */
#screen-cmdrill { position:fixed; inset:0; z-index:50; height:100vh; height:100dvh; overflow:hidden; background:var(--surface-dark); display:none; flex-direction:column; }
#screen-cmdrill.active { display:flex; }
#cmFeed { flex:1; overflow-y:auto; padding:22px 16px 28px; display:flex; flex-direction:column; }
/* A drill is not a chat. The feed used to stretch full height with the card
   pinned top and the answer box pinned bottom, leaving ~150px of dead space
   between the question and where you answer it. margin auto centres the
   card while it is shorter than the feed and falls back to normal top-anchored
   scrolling the moment the content grows past it. */
.cm-wrap { margin:auto auto; width:100%; }
.cm-wrap { max-width:760px; }
.cm-top { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--sv-line,rgba(31,41,55,.12)); background:var(--surface-dark-elevated,#fbf8f2); }
.cm-top .cm-x { background:none; border:none; font-size:22px; line-height:1; color:var(--on-dark-soft,#5b6472); cursor:pointer; }
.cm-top .cm-lbl { font-size:13px; font-weight:700; color:var(--on-dark,#faf9f5); }
.cm-top .cm-prog { margin-left:14px; font-size:12px; color:var(--on-dark-soft,#9db3ad); }
/* SOFT TIMER: counts up, shows the drill's own budget, and never interrupts.
   The chip promised "6 MIN" with no clock at all — pressure is half of what an
   interview tests, but a timer that cuts you off mid-answer just teaches you to
   abandon drills. It turns amber past budget and the elapsed time is sent with
   the answer, so the telemetry can eventually say "passes, but never in time". */
.cm-timer { font-size:12px; font-variant-numeric:tabular-nums; color:var(--on-dark-soft,#9db3ad); margin-left:14px; }
.cm-timer.over { color:#c98a3a; font-weight:700; }
.cm-card { background:var(--surface-dark-elevated,#16241f); border:1px solid var(--sv-line,rgba(255,255,255,.08)); border-radius:14px; padding:18px; margin:0 0 16px; }
.cm-meta { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
.cm-tag { font-size:12px; font-weight:600; letter-spacing:.01em; padding:4px 11px; border-radius:999px; background:rgba(93,184,166,.12); color:var(--coral,#5db8a6); }
.cm-tag.trap { background:rgba(232,124,124,.12); color:#ef9a9a; } .cm-tag.clean { background:rgba(95,191,107,.14); color:#7fd68e; }
.cm-title { font-size:18px; font-weight:800; color:var(--on-dark,#faf9f5); margin:0 0 10px; }
.cm-prompt { font-size:15px; line-height:1.65; color:var(--on-dark,#faf9f5); } .cm-prompt b { color:var(--on-dark,#faf9f5); }
.cm-exh { margin:16px 0 6px; }
.cm-exh-name { font-size:12.5px; font-weight:600; letter-spacing:.01em; color:var(--coral,#5db8a6); margin-bottom:8px; }
.cm-tbl { width:100%; border-collapse:collapse; font-size:13.5px; }
.cm-tbl th, .cm-tbl td { padding:8px 10px; border-bottom:1px solid var(--sv-line,rgba(31,41,55,.10)); color:var(--on-dark,#faf9f5); text-align:left; }
.cm-tbl th { font-weight:600; color:var(--on-dark-soft,#6b7c76); font-size:12.5px; letter-spacing:.01em; }
.cm-tbl td:not(:first-child), .cm-tbl th:not(:first-child) { text-align:right; font-variant-numeric:tabular-nums; }
.cm-steps { margin:14px 0 0; padding:12px 14px; background:rgba(93,184,166,.06); border-radius:10px; }
.cm-steps .cm-sh { font-size:12.5px; font-weight:600; letter-spacing:.01em; color:var(--on-dark-soft,#6b7c76); margin-bottom:6px; }
.cm-steps ol { margin:0; padding-left:20px; } .cm-steps li { font-size:14px; line-height:1.55; color:var(--on-dark,#faf9f5); margin:2px 0; }
#cmInput { border-top:1px solid var(--sv-line,rgba(31,41,55,.12)); background:var(--surface-dark-elevated,#fbf8f2); padding:14px 16px; }
.cm-iz { max-width:760px; margin:0 auto; }
.cm-ta { width:100%; min-height:88px; max-height:44vh; resize:vertical; overflow-y:auto; background:var(--surface-dark-soft,#efe9dd); border:1.5px solid var(--sv-line,rgba(31,41,55,.16)); border-radius:12px; padding:12px 14px; color:var(--on-dark,#faf9f5); font-size:15px; font-family:inherit; line-height:1.5; box-sizing:border-box; }
.cm-ta:focus { outline:none; border-color:var(--coral,#5db8a6); }
.cm-row { display:flex; justify-content:space-between; align-items:center; margin-top:10px; gap:10px; }
.cm-hint { font-size:12.5px; color:var(--on-dark-soft,#9db3ad); }
.cm-btn { background:var(--coral,#5db8a6); color:#04201b; border:none; border-radius:11px; padding:12px 24px; font-size:14.5px; font-weight:700; cursor:pointer; }
.cm-btn:disabled { opacity:.45; cursor:default; } .cm-btn.ghost { background:transparent; color:var(--coral,#5db8a6); border:1.5px solid rgba(93,184,166,.45); }
.cm-fb { border-radius:12px; padding:13px 15px; margin:0 0 16px; font-size:14px; line-height:1.6; }
.cm-fb.ok { background:rgba(95,191,107,.10); border:1px solid rgba(95,191,107,.4); color:#7fd68e; }
.cm-fb.no { background:rgba(232,124,124,.10); border:1px solid rgba(232,124,124,.4); color:#ef9a9a; }
.cm-fb b { color:var(--on-dark,#faf9f5); }
.cm-ref { background:var(--surface-dark-elevated,#16241f); border:1px solid var(--sv-line,rgba(31,41,55,.10)); border-radius:12px; padding:15px 16px; margin:0 0 16px; }
.cm-ref-h { font-size:12.5px; font-weight:600; letter-spacing:.01em; color:var(--coral,#5db8a6); margin-bottom:8px; }
.cm-ref-body { font-size:13.8px; line-height:1.65; color:var(--on-dark,#faf9f5); } .cm-ref-body b { color:var(--on-dark,#faf9f5); }
.cm-ref-body p { margin:0 0 7px; } .cm-ref-body p:last-child { margin:0; }
/* Таблица разбора. Раньше её не было вовсе: авторы писали таблицу markdown,
   а рендер печатал пайпы текстом. Стиль тихий - разбор читают, а не любуются. */
.cm-tbl { width:100%; border-collapse:collapse; margin:4px 0 8px; font-size:13.2px; }
.cm-tbl th { text-align:left; font-weight:600; color:var(--on-dark-soft,#b8c4bf); padding:5px 10px 5px 0; border-bottom:1px solid var(--sv-line,rgba(255,255,255,.12)); white-space:nowrap; }
.cm-tbl td { padding:6px 10px 6px 0; border-bottom:1px solid var(--sv-line,rgba(255,255,255,.06)); vertical-align:top; color:var(--on-dark,#faf9f5); }
.cm-tbl tr:last-child td { border-bottom:0; }
.cm-tbl td:first-child { color:var(--on-dark-soft,#b8c4bf); white-space:nowrap; width:1%; }
.cm-exh-sub { font-size:12.5px; font-weight:700; color:var(--on-dark,#faf9f5); margin:12px 0 6px; }
.cm-exh-sub:first-child { margin-top:0; }
/* ASCII-графики CI нарисованы пробелами: любой перенос ломает картинку.
   Моноширинный шрифт + горизонтальный скролл вместо переноса. */
.cm-ascii { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; line-height:1.45;
  white-space:pre; overflow-x:auto; margin:8px 0; padding:10px 12px; border-radius:8px;
  background:rgba(93,184,166,.06); color:var(--on-dark,#faf9f5); }
.cm-exh-note { font-size:13px; line-height:1.6; color:var(--on-dark,#faf9f5); margin:8px 0; }
/* Ожидание грейдера - самое долгое место дрилла. Три точки молчат; нитка идёт
   и называет этап. Подписи по тому, что грейдер делает по порядку. */
.cm-thread { display:inline-flex; align-items:center; gap:11px; }
.cm-thread svg { width:44px; height:23px; flex-shrink:0; overflow:visible; }
.cm-thread path { fill:none; stroke:var(--coral,#5db8a6); stroke-width:2.6; stroke-linecap:round; stroke-linejoin:round;
  stroke-dasharray:26 100; animation:cmwrite 1.9s cubic-bezier(.5,.05,.5,.95) infinite; }
.cm-thread path.ghost { opacity:.16; animation:none; stroke-dasharray:none; }
@keyframes cmwrite { 0%{stroke-dashoffset:100;} 100%{stroke-dashoffset:-26;} }
.cm-thread-l span { display:inline-block; animation:cmfade .5s ease both; }
@keyframes cmfade { from{opacity:0;transform:translateY(3px);} to{opacity:1;transform:none;} }
.cm-trap { font-size:12.5px; color:var(--on-dark-soft,#8fa39d); font-style:italic; margin-top:10px; }
`;
  var SCREEN = `<div class="cm-top">
    <button class="cm-x" onclick="CaseMathDrills.exit()" title="Exit">&times;</button>
    <span class="cm-lbl" id="cmLbl">Case Math · Drills</span>
    <span style="flex:1"></span>
    <span class="cm-timer" id="cmTimer"></span>
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
  // Inline markdown for list items — same escaping as md(), but no <p> wrapper.
  function mdi(s) {
    return esc2(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  }
  /* Разбор дрилла авторы пишут таблицей markdown, а md() таблиц не знал —
     кандидат читал на экране «| поле | текст |» и строку из дефисов. Найдено
     игрой, а не чтением: сыграл SY-001 на проде и увидел пайпы. Чиню здесь,
     а не в телах: поле одно, тел сорок один, и в остальных пяти библиотеках
     таблицы появятся ровно так же. */
  function mdTable(block) {
    var rows = block.split('\n').filter(function (r) { return r.trim().indexOf('|') === 0 || r.indexOf('|') >= 0; });
    if (rows.length < 2) return null;
    var isSep = function (r) { return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(r) && r.indexOf('-') >= 0; };
    if (!isSep(rows[1])) return null;
    var cells = function (r) {
      return r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
    };
    var head = cells(rows[0]);
    var body = rows.slice(2).filter(function (r) { return r.indexOf('|') >= 0; }).map(cells);
    var inline = function (t) { return esc2(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>'); };
    var html = '<table class="cm-tbl"><thead><tr>' + head.map(function (h) { return '<th>' + inline(h) + '</th>'; }).join('') + '</tr></thead><tbody>';
    body.forEach(function (r) { html += '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>'; });
    return html + '</tbody></table>';
  }
  function md(s) {
    return String(s == null ? '' : s).split(/\n{2,}/).map(function (p) {
      var t = mdTable(p);
      if (t) return t;
      var e = esc2(p).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
      return '<p>' + e.replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }
  // Which language the FEEDBACK side speaks. The product has three independent
  // axes — uiLang (chrome), aiLang (the case/drill itself), fbLang (feedback and
  // debrief). Reference solutions and the "provoked" note are feedback, so they
  // follow fbLang; 'same' means follow the case language. Before 2026-07-25 this
  // read aiLang only, so "case in English, debrief in Russian" was silently ignored.
  function fbCode() {
    var st = (typeof state !== 'undefined' && state) ? state : {};
    var fb = st.fbLang && st.fbLang !== 'same' ? st.fbLang : st.aiLang;
    return fb === 'ru' ? 'ru' : 'en';
  }
  function L(v) {
    if (v && typeof v === 'object' && ('en' in v || 'ru' in v)) {
      var lang = fbCode();
      // Fall through on an ABSENT *or EMPTY* side. An empty string used to count as
      // a valid translation, so a one-sided payload ({en:'…', ru:''} — every BR
      // model answer) rendered a headed block with no body, or no block at all.
      var pick = v[lang];
      if (typeof pick === 'string' ? pick.trim() : pick != null) return pick;
      var alt = lang === 'ru' ? v.en : v.ru;
      if (typeof alt === 'string' ? alt.trim() : alt != null) return alt;
      return '';
    }
    return v;
  }
  /* ---------- soft timer ---------- */
  var T = { t0: 0, budget: 0, tick: null };
  function budgetMs(t) {                       // "6 min" / "7 MIN" → ms, 0 if absent
    var m = /(\d+(?:\.\d+)?)/.exec(String(t || ''));
    return m ? Math.round(parseFloat(m[1]) * 60000) : 0;
  }
  function fmt(ms) {
    var s2 = Math.floor(ms / 1000);
    return Math.floor(s2 / 60) + ':' + ('0' + (s2 % 60)).slice(-2);
  }
  function timerStart(timeStr) {
    timerStop();
    T.t0 = Date.now(); T.budget = budgetMs(timeStr);
    var el = E('cmTimer'); if (!el) return;
    function paint() {
      var d = Date.now() - T.t0;
      el.textContent = fmt(d) + (T.budget ? ' / ' + fmt(T.budget) : '');
      el.classList.toggle('over', !!T.budget && d > T.budget);
    }
    paint(); T.tick = setInterval(paint, 1000);
  }
  function timerStop() { if (T.tick) { clearInterval(T.tick); T.tick = null; } }
  function elapsedMs() { return T.t0 ? (Date.now() - T.t0) : null; }

  // The answer box used to sit at a fixed 4 lines: a long answer scrolled inside
  // it and you could no longer see the start of your own reasoning. You reread
  // your answer before you hand it over — that is the point of the drill.
  function autoGrow(el) {
    if (!el) return;
    function fit() { el.style.height = 'auto'; el.style.height = Math.max(88, el.scrollHeight + 2) + 'px'; }
    el.addEventListener('input', fit); fit();
  }

  // Нитка ожидания. Первая подпись держится дольше: если ответ пришёл быстро,
  // кандидат не увидит мельтешения. Последняя не сменяется - «почти готово»
  // было бы обещанием, которого никто не давал.
  function cmL(v){ var l=(typeof state!=='undefined'&&state&&state.uiLang==='ru')?'ru':'en'; return (v&&typeof v==='object')?(v[l]||v.en):v; }
  /* Подписи интерфейса дрилла. Держим в одном месте и на двух языках: экран,
     который кричит капслоком и говорит «Grader hiccup», читается как студенческий
     проект, а не как тренажёр, за который платят. */
  var W = {
    given:    {ru:'Дано',                   en:'Given'},
    solve:    {ru:'Что нужно посчитать',    en:'What to work out'},
    exhibit:  {ru:'Экзибит',                en:'Exhibit'},
    exLocked: {ru:'Экзибит пока закрыт',    en:'Exhibit withheld'},
    exOpened: {ru:'Экзибит открыт',         en:'Exhibit released'},
    exHint:   {ru:'Сначала построй дерево. Данные выдаются после того, как ты зафиксировал структуру — смысл в том, выдержит ли она встречу с ними.',
               en:'Build your tree first. The data is released only after you commit — the point is whether your structure survives contact with it.'},
    pass:     {ru:'Засчитано.',             en:'Passed.'},
    fail:     {ru:'Не засчитано.',          en:'Not yet.'},
    refSol:   {ru:'Эталонный разбор',       en:'Reference solution'},
    refAns:   {ru:'Эталонный ответ',        en:'Model answer'},
    trap:     {ru:'Ловушка',                en:'The trap'},
    newFact:  {ru:'Новый факт',             en:'A new fact'},
    teamSaid: {ru:'Команда клиента предложила', en:'The client team proposed'},
    twist:    {ru:'Теперь поворот.',        en:'Now the twist.'},
    twistSub: {ru:'Появился новый факт. Твой список уже сдан — посмотрим, что из него уцелеет.',
               en:'A new fact has landed. Your list is already in — let us see what survives it.'},
    done:     {ru:'Библиотека пройдена',    en:'Library complete'},
    doneSub:  {ru:'Ты прошёл все задачи этого набора. Начинаем сначала — вторым проходом задачи читаются иначе.',
               en:'You have worked through every drill in this set. Starting again — a second pass reads differently.'},
    conn:     {ru:'Не удалось связаться с сервером.', en:'Could not reach the server.'},
    connSub:  {ru:'Попробуй ещё раз.',      en:'Please try again.'},
    ungraded: {ru:'Оценка не сформировалась. Ответ сохранён — отправь его ещё раз.',
               en:'The answer was not scored. Your text is kept — send it again.'},
    submit:   {ru:'Ответить',               en:'Submit'},
    nextD:    {ru:'Следующая задача',       en:'Next drill'},
    skip:     {ru:'Пропустить',             en:'Skip'},
    cullBtn:  {ru:'Ответить',               en:'Submit'},
    loadFail: {ru:'Задача не загрузилась. Проверь, что ты вошёл в аккаунт, и попробуй снова.',
               en:'The drill did not load. Check that you are signed in and try again.'},
    grading:  {ru:'Оцениваю',               en:'Grading'}
  };
  function W_(k){ return cmL(W[k]); }

  var CM_STEPS = [[0,{ru:'читаю твой ответ',en:'reading your answer'}],[2800,{ru:'сверяю с эталоном',en:'comparing with the model answer'}],
    [6500,{ru:'считаю, где потеряно',en:'working out where it was lost'}],[11000,{ru:'пишу разбор',en:'writing the debrief'}]];
  var _cmT = null;
  function threadHTML(first) {
    return '<span class="cm-thread"><svg viewBox="0 0 46 24"><path class="ghost" pathLength="100" d="M2 15 C5 5, 13 4, 14 12 C15 20, 8 21, 10 12 C12 4, 20 3, 21 12 C22 20, 15 21, 17 12 C19 4, 27 3, 28 12 C29 20, 22 21, 24 12 C26 5, 34 6, 38 13 C40 17, 42 18, 44 17"/><path pathLength="100" d="M2 15 C5 5, 13 4, 14 12 C15 20, 8 21, 10 12 C12 4, 20 3, 21 12 C22 20, 15 21, 17 12 C19 4, 27 3, 28 12 C29 20, 22 21, 24 12 C26 5, 34 6, 38 13 C40 17, 42 18, 44 17"/></svg>' +
           '<span class="cm-hint cm-thread-l" id="cmThreadL"><span>' + first + '</span></span></span>';
  }
  function threadRun(steps) {
    if (_cmT) { clearTimeout(_cmT); _cmT = null; }
    var t0 = Date.now();
    (function paint() {
      var l = E('cmThreadL'); if (!l) return;
      var gone = Date.now() - t0, cur = steps[0], next = null;
      for (var i = 0; i < steps.length; i++) {
        if (gone >= steps[i][0]) cur = steps[i]; else { next = steps[i]; break; }
      }
      if (l.getAttribute('data-at') !== String(cur[0])) {
        l.setAttribute('data-at', String(cur[0]));
        l.innerHTML = '<span>' + cmL(cur[1]) + '</span>';
      }
      if (next) _cmT = setTimeout(paint, next[0] - gone);
    })();
  }
  function threadStop() { if (_cmT) { clearTimeout(_cmT); _cmT = null; } }

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

  // Cells carry the same inline markup as prose: [BOLD] marks the load-bearing
  // number. Rendering cells with esc2() alone printed `**1,600**` literally to
  // the candidate — 179 cells across ST and CI. mdi() escapes first, so this is
  // no less safe than esc2; it just also honours ** and `.
  function tableHTML(ex) {
    var h = '<table class="cm-tbl"><thead><tr>' + (ex.header || []).map(function (c) { return '<th>' + mdi(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
    h += (ex.rows || []).map(function (row) { return '<tr>' + row.map(function (c) { return '<td>' + mdi(c) + '</td>'; }).join('') + '</tr>'; }).join('');
    return h + '</tbody></table>';
  }

  // Two exhibit shapes live in the libraries:
  //   legacy  {header, rows}                     — CM / MS / ST
  //   parts   {title, parts:[{type,…}]}          — CI, where one exhibit is a
  //           sequence of blocks: `table`, `text` (markdown lines) and `ascii`
  //           (a drawn chart that MUST keep its own spacing — hence <pre>).
  // Anything unknown is skipped rather than dumped raw: a chart the candidate
  // cannot read is worse than no chart.
  function partsHTML(parts) {
    var out = '';
    (parts || []).forEach(function (p) {
      if (!p) return;
      if (p.type === 'table') out += tableHTML(p);
      else if (p.type === 'ascii') out += '<pre class="cm-ascii">' + esc2((p.lines || []).join('\n')) + '</pre>';
      else if (p.type === 'text') out += '<div class="cm-exh-note">' + (p.lines || []).map(mdi).join('<br>') + '</div>';
    });
    return out;
  }
  function exhibitHTML(ex) {
    if (!ex) return '';
    if (ex.blocks) {                       // multi-exhibit slot: Exhibit A / B / C
      return (ex.blocks || []).map(function (b) {
        return (b && b.title ? '<div class="cm-exh-sub">' + esc2(b.title) + '</div>' : '') + partsHTML(b && b.parts);
      }).join('');
    }
    if (ex.parts) return (ex.title ? '<div class="cm-exh-sub">' + esc2(ex.title) + '</div>' : '') + partsHTML(ex.parts);
    return ex.rows ? tableHTML(ex) : '';
  }
  function hasExhibit(ex) {
    return !!(ex && (ex.rows || (ex.parts && ex.parts.length) || (ex.blocks && ex.blocks.length)));
  }

  /* ---------- libraries ---------- */
  // Two curated libraries share this one thin client. 'cm' = Case Math (default),
  // 'ms' = Market Sizing. The server picks the library from the `set` field.
  var LIBS = {
    cm: { set: 'cm', label: 'Case Math · Drills',      rec: 'Case Math',     doneKey: 'casedge_cmdrills_done', complete: 'every Case Math drill in this batch' },
    ms: { set: 'ms', label: 'Market Sizing · Drills',  rec: 'Market Sizing', doneKey: 'casedge_msdrills_done', complete: 'every Market Sizing drill in this batch' },
    st: { set: 'st', label: 'Structuring · Drills',    rec: 'Structuring',   doneKey: 'casedge_stdrills_done', complete: 'every Structuring drill in this batch' },
    br: { set: 'br', label: 'Brainstorm · Drills',     rec: 'Brainstorm',    doneKey: 'casedge_brdrills_done', complete: 'every Brainstorm drill in this batch' },
    ci: { set: 'ci', label: 'Chart Interpretation · Drills', rec: 'Chart Interpretation', doneKey: 'casedge_cidrills_done', complete: 'every Chart Interpretation drill in this batch' },
    sy: { set: 'sy', label: 'Synthesis · Drills',      rec: 'Synthesis',     doneKey: 'casedge_sydrills_done', complete: 'every Synthesis drill in this batch' }
  };

  /* ---------- state ---------- */
  var S = { done: [], drill: null, lib: 'cm', move1: null };
  function cfg() { return LIBS[S.lib] || LIBS.cm; }
  function loadDone() { try { S.done = JSON.parse(localStorage.getItem(cfg().doneKey) || '[]'); } catch (e) { S.done = []; } }
  function saveDone(id) { if (S.done.indexOf(id) < 0) S.done.push(id); try { localStorage.setItem(cfg().doneKey, JSON.stringify(S.done)); } catch (e) {} }

  /* ---------- flow ---------- */
  function open(lib) {
    S.lib = LIBS[lib] ? lib : 'cm';
    inject();
    var lbl = E('cmLbl'); if (lbl) lbl.textContent = cfg().label;
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
    var pr = E('cmProg'); if (pr) pr.textContent = cmL({en:'Loading…',ru:'Загружаю…'});
    var pick={ru:'подбираю задачу',en:'picking a drill'};
    iz(threadHTML(cmL(pick))); threadRun([[0,pick]]);
    api({ action: 'next', doneIds: S.done, set: cfg().set }).then(function (r) {
      if (r && r.error) { if (w) w.innerHTML = '<div class="cm-card"><div class="cm-title">' + esc2(cfg().rec) + '</div><div class="cm-prompt">' + W_("loadFail") + '</div></div>'; return; }
      var d = r && r.drill;
      if (!d) {   // all done → recycle
        S.done = []; try { localStorage.removeItem(cfg().doneKey); } catch (e) {}
        feed('<div class="cm-card"><div class="cm-title">' + W_("done") + '</div><div class="cm-prompt">' + W_("doneSub") + '</div></div>');
        return void setTimeout(loadNext, 900);
      }
      S.drill = d;
      renderDrill(d);
    }).catch(function () { if (w) w.innerHTML = '<div class="cm-card"><div class="cm-title">' + esc2(cfg().rec) + '</div><div class="cm-prompt">' + W_("loadFail") + '</div></div>'; });
  }

  function renderDrill(d) {
    var pr = E('cmProg'); if (pr) pr.textContent = cmL({en:'Drill ',ru:'Задача '}) + d.index + ' / ' + d.total;
    // NO-SPOILER META (2026-07-25): the candidate used to see Trap/Clean, the
    // difficulty tier and the `focus` code (e.g. "F05(A) PERPETUITY VS DECAY").
    // Each one hands over the answer before a single number is written: "Trap"
    // says do not take the obvious route, and `focus` names the exact mechanism.
    // Real interviews label nothing. Only the time budget survives.
    var html = '<div class="cm-card">' +
      '<div class="cm-meta">' +
        (d.time ? '<span class="cm-tag">' + esc2(d.time) + '</span>' : '') +
      '</div>' +
      '<div class="cm-title">' + esc2(d.title || 'Drill') + '</div>' +
      '<div class="cm-prompt">' + md(d.prompt || '') + '</div>' +
      ((d.facts && d.facts.length) ? '<div class="cm-steps"><div class="cm-sh">' + W_("given") + '</div><ul>' + d.facts.map(function (s) { return '<li>' + mdi(s) + '</li>'; }).join('') + '</ul></div>' : '') +
      (hasExhibit(d.exhibit) ? '<div class="cm-exh"><div class="cm-exh-name">' + W_("exhibit") + '</div>' + exhibitHTML(d.exhibit) + '</div>' : '') +
      (d.exhibit_withheld ? '<div class="cm-steps"><div class="cm-sh">' + W_("exLocked") + '</div><div class="cm-hint">' + W_("exHint") + '</div></div>' : '') +
      ((d.step_prompts && d.step_prompts.length) ? '<div class="cm-steps"><div class="cm-sh">' + W_("solve") + '</div><ol>' + d.step_prompts.map(function (s) { return '<li>' + mdi(s) + '</li>'; }).join('') + '</ol></div>' : '') +
      '</div>';
    feed(html);
    var isST = (d.type || '') === 'Structuring';
    var isBR = (d.type || '') === 'Brainstorm';
    var isCI = S.lib === 'ci';
    // Synthesis branches on the LIBRARY, not on d.type: the server sanitises
    // every type except 'Structuring' down to the neutral token 'Drill', so a
    // check against 'Synthesis' here would never fire and the slot would
    // silently take the Case Math placeholder - "show your numbers" on a drill
    // where nothing is counted.
    var isSY = S.lib === 'sy';
    // Заглушка поля ответа и подсказка под ним — самый читаемый текст экрана:
    // кандидат смотрит на них, пока думает. До 2026-08-01 они были только
    // по-английски, и на русском интерфейсе экран говорил на двух языках сразу.
    var PH = {
      sy: {en:'The record is someone else\'s work. Give your verdict first, then the facts that carry it, the risks, and the next step.',
           ru:'Это чужая работа. Сначала вывод, затем факты, которые его держат, риски и следующий шаг.'},
      br: {en:'List your options — one per line. Tie each to a fact. Lead with the load-bearing idea, not a reflex.',
           ru:'Перечисли варианты — по одному в строке. Каждый привяжи к факту. Первым — несущий, а не рефлекторный.'},
      st: {en:'Build your MECE tree: name each top branch and one line on why it belongs. State which branch you attack first and your criterion.',
           ru:'Построй MECE-дерево: назови верхние ветки и по строке, почему каждая нужна. Скажи, с какой начинаешь и по какому критерию.'},
      ci: {en:'Read the exhibit: the one insight that matters, what it implies for the business, and the next thing you would check.',
           ru:'Прочитай экзибит: один значимый вывод, что он означает для бизнеса и что проверишь следующим.'},
      cm: {en:'Show your numbers and your one-sentence recommendation…',
           ru:'Покажи расчёт и рекомендацию одной фразой…'}
    };
    var HINT = {
      sy: {en:'Conclusion first. Name the figure that decides it, and say which fact in the record does not matter.',
           ru:'Вывод первым. Назови цифру, которая его решает, и скажи, какой факт здесь не важен.'},
      brC:{en:'Give your options; a new fact will then test them.',
           ru:'Дай варианты — затем их проверит новый факт.'},
      br: {en:'Options tied to the facts — quality over volume.',
           ru:'Варианты, привязанные к фактам, — качество важнее количества.'},
      st: {en:'List your branches (MECE), justify each, and pick a defensible starting branch.',
           ru:'Назови ветки (MECE), обоснуй каждую и выбери ветку, с которой начнёшь.'},
      ci: {en:'Do not describe the chart — extract the insight, tie it to a business implication, name the next check.',
           ru:'Не описывай график — вытащи вывод, свяжи его с бизнесом, назови следующую проверку.'},
      cm: {en:'Give the number(s) the drill asks for, then your read of the trap.',
           ru:'Дай запрошенные числа, затем свой разбор ловушки.'}
    };
    var phK = isSY ? 'sy' : isBR ? 'br' : isST ? 'st' : isCI ? 'ci' : 'cm';
    var ph = cmL(PH[phK]);
    var hint = cmL(HINT[(isBR && d.cull) ? 'brC' : phK]);
    iz('<textarea class="cm-ta" id="cmTa" placeholder="' + esc2(ph) + '"></textarea>' +
       '<div class="cm-row"><span class="cm-hint">' + esc2(hint) + '</span>' +
       '<button class="cm-btn" id="cmSubmit" onclick="CaseMathDrills._submit()">' + W_("submit") + '</button></div>');
    timerStart(d.time);
    setTimeout(function () { var el = E('cmTa'); if (el) { el.focus(); autoGrow(el); } }, 60);
  }

  function _submit() {
    var el = E('cmTa'); if (!el) return; var answer = el.value.trim(); if (!answer) return;
    var b = E('cmSubmit'); if (b) b.disabled = true;
    var spent = elapsedMs(); timerStop();
    iz(threadHTML(cmL(CM_STEPS[0][1]))); threadRun(CM_STEPS);
    var d = S.drill;
    api({ action: 'grade', drillId: d.id, answer: answer, set: cfg().set, fbLang: fbCode(), elapsedMs: spent }).then(function (r) {
      if (r && r.error) { feed('<div class="cm-fb no"><b>' + W_("conn") + '</b> ' + esc2(r.error.message || W_("connSub")) + '</div>'); return void nextButton(); }
      // grader hiccup (couldn't parse a verdict) — NOT a fail. Let the candidate resubmit,
      // keep their answer, don't mark the drill done.
      if (r && r.graded === false) {
        iz('<div class="cm-hint" style="margin-bottom:8px;">' + W_("ungraded") + '</div>' +
           '<textarea class="cm-ta" id="cmTa">' + esc2(answer) + '</textarea>' +
           '<div class="cm-row"><span class="cm-hint"></span><button class="cm-btn" id="cmSubmit" onclick="CaseMathDrills._submit()">' + W_("submit") + '</button></div>');
        return;
      }
      // Brainstorm two-move CULL: the server withheld the client team's ideas + the
      // new fact until now. Show them, keep the candidate's idea list, and ask which
      // ideas the new fact kills — the whole point is the fact breaking their list.
      if (r && r.stage === 'cull') {
        S.move1 = r.move1Answer != null ? r.move1Answer : answer;
        feed('<div class="cm-fb ok" style="background:rgba(93,184,166,.10);border-color:rgba(93,184,166,.4);color:var(--on-dark,#faf9f5)"><b>' + W_("twist") + '</b> ' + W_("twistSub") + '</div>');
        feed('<div class="cm-ref"><div class="cm-ref-h">' + W_("newFact") + '</div><div class="cm-ref-body">' + md(r.cull && r.cull.new_fact || '') + '</div></div>');
        var teams = (r.cull && r.cull.team_ideas) || [];
        feed('<div class="cm-steps"><div class="cm-sh">' + W_("teamSaid") + '</div><ol>' + teams.map(function (t) { return '<li>' + esc2(t) + '</li>'; }).join('') + '</ol></div>');
        iz('<textarea class="cm-ta" id="cmCull" placeholder="Which of these ideas does the new fact kill? Give the numbers and, for each, why it dies. Naming a survivor as killed fails as hard as a miss."></textarea>' +
           '<div class="cm-row"><span class="cm-hint">Name exactly the ideas the fact kills — with a reason for each.</span>' +
           '<button class="cm-btn" id="cmCullBtn" onclick="BrainstormDrills._submitCull()">' + W_("cullBtn") + '</button></div>');
        setTimeout(function () { var el = E('cmCull'); if (el) { el.focus(); autoGrow(el); } }, 60);
        return;
      }
      var ok = !!r.pass;
      feed('<div class="cm-fb ' + (ok ? 'ok' : 'no') + '">' + (ok ? '<b>' + W_("pass") + '</b> ' : '<b>' + W_("fail") + '</b> ') + esc2(r.coaching || '') + '</div>');
      // ST E-after: the exhibit is released only now — show it before the debrief
      // so the candidate sees how the data breaks (or confirms) the tree they built.
      if (hasExhibit(r.exhibit)) {
        feed('<div class="cm-exh"><div class="cm-exh-name">' + W_("exOpened") + '</div>' + exhibitHTML(r.exhibit) + '</div>');
      }
      var ref = L(r.reference); var prov = L(r.provoked);
      feed('<div class="cm-ref"><div class="cm-ref-h">' + W_("refSol") + '</div><div class="cm-ref-body">' + md(ref || '') + '</div>' +
           (prov ? '<div class="cm-trap"><b>' + W_("trap") + ':</b> ' + esc2(prov) + '</div>' : '') + '</div>');
      saveDone(d.id);
      // Record this rep in the shared Progress tracker (Drills completed + "Case Math" by-type + streak, synced to cloud).
      try { if (typeof recordSession === 'function') recordSession('drill', cfg().rec); } catch (e) {}
      nextButton();
    }).catch(function () { feed('<div class="cm-fb no"><b>' + W_("conn") + '</b> ' + W_("connSub") + '</div>'); nextButton(); });
  }

  // Final debrief shared by single-move slots and the CULL second move.
  function _renderFinal(d, r) {
    if (r && r.error) { feed('<div class="cm-fb no"><b>' + W_("conn") + '</b> ' + esc2(r.error.message || W_("connSub")) + '</div>'); return void nextButton(); }
    if (r && r.graded === false) {
      iz('<div class="cm-hint" style="margin-bottom:8px;">' + W_("ungraded") + '</div>' +
         '<div class="cm-row" style="justify-content:flex-end"><button class="cm-btn" onclick="BrainstormDrills._next()">' + W_("skip") + ' →</button></div>');
      return;
    }
    var ok = !!r.pass;
    feed('<div class="cm-fb ' + (ok ? 'ok' : 'no') + '">' + (ok ? '<b>' + W_("pass") + '</b> ' : '<b>' + W_("fail") + '</b> ') + esc2(r.coaching || '') + '</div>');
    var ref = L(r.reference), prov = L(r.provoked);
    if (ref) feed('<div class="cm-ref"><div class="cm-ref-h">' + W_("refAns") + '</div><div class="cm-ref-body">' + md(ref) + '</div>' +
                  (prov ? '<div class="cm-trap"><b>' + W_("trap") + ':</b> ' + esc2(prov) + '</div>' : '') + '</div>');
    saveDone(d.id);
    try { if (typeof recordSession === 'function') recordSession('drill', cfg().rec); } catch (e) {}
    nextButton();
  }

  function _submitCull() {
    var el = E('cmCull'); if (!el) return; var cull = el.value.trim(); if (!cull) return;
    var b = E('cmCullBtn'); if (b) b.disabled = true;
    iz(threadHTML(cmL(CM_STEPS[0][1]))); threadRun(CM_STEPS);
    var d = S.drill;
    api({ action: 'grade', drillId: d.id, set: cfg().set, stage: 'cull', answer: cull, move1Answer: S.move1, fbLang: fbCode(), elapsedMs: elapsedMs() })
      .then(function (r) { _renderFinal(d, r); })
      .catch(function () { feed('<div class="cm-fb no"><b>' + W_("conn") + '</b> ' + W_("connSub") + '</div>'); nextButton(); });
  }

  function nextButton() {
    threadStop();
    iz('<div class="cm-row" style="justify-content:flex-end"><button class="cm-btn" onclick="CaseMathDrills._next()">' + W_("nextD") + ' →</button></div>');
  }
  function _next() { S.move1 = null; loadNext(); }

  window.CaseMathDrills = { open: function () { return open('cm'); }, exit: exit, _submit: _submit, _next: _next };
  window.MarketSizingDrills = { open: function () { return open('ms'); }, exit: exit, _submit: _submit, _next: _next };
  window.StructuringDrills = { open: function () { return open('st'); }, exit: exit, _submit: _submit, _next: _next };
  window.BrainstormDrills = { open: function () { return open('br'); }, exit: exit, _submit: _submit, _submitCull: _submitCull, _next: _next };
  window.ChartDrills = { open: function () { return open('ci'); }, exit: exit, _submit: _submit, _next: _next };
  window.SynthesisDrills = { open: function () { return open('sy'); }, exit: exit, _submit: _submit, _next: _next };
})();
