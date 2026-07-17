/* CasEdge — Casey Simulator (BCG). Self-contained, self-injecting. */
/* Uses the app theme variables so it follows the single app theme. */

window.CASEY_VOICE_SYSTEM = [
"Ты — строгий, но справедливый экзаменатор BCG-кейс-интервью. Тебе дают ТРАНСКРИПТ устной финальной рекомендации кандидата (речь → текст, поэтому в нём БУДУТ ошибки распознавания: числа словами, опечатки, слипшиеся слова, пропущенная пунктуация). Оцени транскрипт против чеклиста из 4 критериев. Каждый критерий — строго pass/fail. Верни ТОЛЬКО JSON, без преамбулы и markdown.",
"ПРАВИЛА ИНТЕРПРЕТАЦИИ:",
"1. Смысл важнее точных слов — кандидат говорил вслух, оценивай суть.",
"2. Числа в любой форме ('fifty five and a half thousand' = 55,500; 'минус сто двадцать тысяч восемьсот' = -120,800). Округления кандидата в пределах ±2% от якоря засчитываются.",
"3. Порядок высказывания имеет значение ТОЛЬКО для критерия 1 (вывод-первым). Для 2-4 — засчитывай где угодно в транскрипте.",
"4. Критерий 1 (вывод в первых 1-2 фразах): ищи рекомендацию-действие в первых ~2 предложениях. Если кандидат идёт от фактов к выводу в конце — c1 FAIL, даже если вывод верный.",
"5. Критерий 2 (anchor): должно прозвучать >=2 чисел, и >=1 из них — из списка anchor_numbers рубрики. Два случайных числа не по делу → c2 FAIL.",
"6. Критерий 3 (mechanisms): для multi-insight оба названы; для single-insight — один требуемый тезис (см. mechanisms_required).",
"7. Критерий 4: >=1 internal + >=1 external риск, привязанные к тезису, И >=1 конкретный time-bound следующий шаг.",
"8. Clean-кейсы (clean_special=true, C6/C15): якорь = подтверждение ОБОИХ путей. Если кандидат 'нашёл разворот', которого нет — c1 И c2 FAIL.",
"9. НЕ штрафуй за: акцент, грамматику, филлеры, длину, стиль. Только за отсутствие требуемого содержания.",
"10. НЕ добавляй требований сверх чеклиста.",
"ФОРМАТ ОТВЕТА (строгий JSON):",
'{"case_id":"Cxx","criteria":{"c1_conclusion_first":{"pass":true,"evidence":"цитата"},"c2_anchor_number":{"pass":true,"evidence":"цитата"},"c3_mechanisms":{"pass":false,"evidence":"цитата"},"c4_risks_nextstep":{"pass":true,"evidence":"цитата"}},"score":3,"verdict":"partial","coaching":"1-3 предложения по-русски: что засчитано, что провалено, как починить."}',
"score = число pass (0-4). verdict: 4->strong, 3->partial, <=2->weak. Всегда возвращай evidence-цитату из транскрипта на каждый критерий."
].join("\n");

window.CASEY_RUBRICS = {
  "C1":  {"conclusion":"keep Valtona + add Herdal top-up (hybrid); NOT full move","anchor_numbers":["55,500","52,000-vs-55,000"],"mechanisms_required":["cost advantage kept + insurance against shortfall"],"internal_examples":["two-site quality/consistency"],"external_examples":["Valtona deviation/contract, excise"]},
  "C2":  {"conclusion":"run promo WITH the 500-unit cap (not uncapped, not reject)","anchor_numbers":["27,500","9,500-vs-87,500","33.65%"],"mechanisms_required":["expected refund cost overstated the gain; cap limits exposure"],"internal_examples":["cap communication/backlash"],"external_examples":["consumer-protection regulation; probability drift past breakeven"]},
  "C3":  {"conclusion":"keep the kit (± reprice); NOT discontinue","anchor_numbers":["−8,400","33.33%-vs-45%"],"mechanisms_required":["basket margin","attribution/defection share"],"internal_examples":["survey overstates true defection; test-store measurement"],"external_examples":["competitor rival kit; food-cost inflation"]},
  "C4":  {"conclusion":"ADD the 4th flight on incremental/marginal logic","anchor_numbers":["505","184,325","43.86%"],"mechanisms_required":["marginal vs fully-allocated cost","cannibalization/incrementality"],"internal_examples":["crew/maintenance/ops strain"],"external_examples":["competitor frequency match; fuel; slots"]},
  "C5":  {"conclusion":"decline at $38 / keep in-house","anchor_numbers":["−120,800","34.79","34-35"],"mechanisms_required":["avoidable vs unavoidable fixed","TAT leakage"],"internal_examples":["molecular staff retention/capability"],"external_examples":["reference-lab repricing; payer reimbursement"]},
  "C6":  {"conclusion":"implement the rate cut / yes","anchor_numbers":["94,900","350,400-vs-94,900"],"mechanisms_required":["both paths agree (revenue AND contribution)","≥1 checked-and-cleared reversal: parity $110 OR breakeven 72.63%-vs-74%"],"internal_examples":["forecast is the weak joint; re-underwrite 74%"],"external_examples":["competitor matching the cut"],"clean_special":true},
  "C7":  {"conclusion":"do NOT implement flat +20% as proposed (restructure, not reject)","anchor_numbers":["−168,869","−169K","+2M-vs-minus","16.48%"],"mechanisms_required":["annual-lock/mix","churn compounding"],"internal_examples":["churn estimates from one study; A/B first"],"external_examples":["competitor holds price → acquisition"]},
  "C8":  {"conclusion":"keep Rural","anchor_numbers":["−12,200","0.38%-vs-5%","10,000→1,000→−12,200"],"mechanisms_required":["avoidable vs allocated fixed","network/anchor-client risk"],"internal_examples":["needs variable-cost program"],"external_examples":["anchor client renegotiation"]},
  "C9":  {"conclusion":"reject the dormant-for-premium swap","anchor_numbers":["−68,250","38.75-vs-35.00","59.55-vs-55"],"mechanisms_required":["usage-cost margin (dormant > premium)","adverse retention on Casual"],"internal_examples":["premium real usage may exceed 8 visits; pilot"],"external_examples":["regulator views mass termination as unfair"]},
  "C10": {"conclusion":"selective / A-only migration (not everyone, not no one)","anchor_numbers":["−66,600-vs-+18,000","4.13"],"mechanisms_required":["segment winners/losers (only A pays more; B,C get unjustified cut)"],"internal_examples":["two pricing models → fairness pushback; packaging"],"external_examples":["B/C demand cheaper usage model → set rate ≥4.13¢"]},
  "C11": {"conclusion":"do NOT approve $12 across the board (targeted/peak pricing instead, not reject-all)","anchor_numbers":["−20,960","9.84-15-16.67","4.16"],"mechanisms_required":["naive ticket math is CORRECT within its perimeter but incomplete (concession leak)"],"internal_examples":["validate 15% elasticity via 2-theatre pilot"],"external_examples":["streaming release-window shift moves attendance"]},
  "C12": {"conclusion":"rent B1 and B3 only (not all five, not reject)","anchor_numbers":["13,000-vs-7,000","$10×participants"],"mechanisms_required":["capacity shadow-price","per-building selection"],"internal_examples":["relocate displaced programs before signing"],"external_examples":["operator demands all-five package → walk/counter"]},
  "C13": {"conclusion":"approve 24-mo cycle at HONEST size (not reject, not $4.9M)","anchor_numbers":["384,000-vs-4.86M","20,573"],"mechanisms_required":["naive frame counts only the selling side of the cycle"],"internal_examples":["doubled purchasing strains supply/logistics"],"external_examples":["used-car market is the single point of failure; hedge disposals"]},
  "C14": {"conclusion":"decline exclusivity / counter (not accept)","anchor_numbers":["−47,240","87.99%-vs-55%","88%","8.50-vs-7.16"],"mechanisms_required":["channel margin difference","partial migration/churn"],"internal_examples":["own-channel ops must stay <$4.90/order"],"external_examples":["Mealgate ranking retaliation → placement guarantees"]},
  "C15": {"conclusion":"kill the discount / implement","anchor_numbers":["1,543,200","2.7M-vs-1,543,200"],"mechanisms_required":["both paths agree (CFO direction AND cohort model)","≥1 checked-and-cleared reversal: scale/allocation $20→$21.13 OR j*=8,482-vs-12,000"],"internal_examples":["marketing's 12,000 projection is weak joint; pilot"],"external_examples":["competitor weaponizes removed discount in ads"],"clean_special":true}
};


window.caseyCalc = (function(){
  var expr = '';
  function disp(){ var el=document.getElementById('cyCalcDisp'); if(el) el.value = expr || '0'; }
  function press(k){
    if (k==='C'){ expr=''; }
    else if (k==='DEL'){ expr = expr==='Error' ? '' : expr.slice(0,-1); }
    else if (k==='='){
      try {
        var s = expr.replace(/×/g,'*').replace(/÷/g,'/').replace(/%/g,'/100').replace(/[^0-9+\-*/.() ]/g,'');
        if (!s){ return; }
        var r = Function('"use strict";return ('+s+')')();
        if (r===Infinity || r===-Infinity || (typeof r==='number' && isNaN(r))) { expr='Error'; }
        else { expr = String(Math.round((r + Number.EPSILON)*1e6)/1e6); }
      } catch(e){ expr='Error'; }
    }
    else { if (expr==='Error') expr=''; expr += k; }
    disp();
  }
  function toggle(){ var el=document.getElementById('cyCalc'); if(!el) return; el.style.display = (el.style.display==='none'||!el.style.display) ? 'block' : 'none'; if(el.style.display==='block') disp(); }
  return { press:press, toggle:toggle };
})();


(function(){
  var CSS = `#screen-casey { position:relative; height:100vh; height:100dvh; overflow:hidden; background:var(--surface-dark); display:flex; flex-direction:column; }
#screen-casey.active { display:flex; }
#cyFeed { flex:1; overflow-y:auto; padding:20px 16px 28px; }
.cy-wrap { max-width:760px; margin:0 auto; }
#cyInputZone { border-top:1px solid var(--sv-line, rgba(255,255,255,.08)); background:var(--surface-dark-elevated,#12201d); padding:14px 16px; }
.cy-iz-inner { max-width:760px; margin:0 auto; }
/* chat bubbles */
.cy-msg { display:flex; gap:11px; margin:0 0 16px; align-items:flex-start; }
.cy-av { width:30px; height:30px; border-radius:50%; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:700; }
.cy-av.ai { background:rgba(93,184,166,.14); color:var(--coral,#5db8a6); font-family:var(--font-display,inherit); }
.cy-av.me { background:rgba(255,255,255,.07); color:var(--on-dark,#eaf2f0); }
.cy-bbl { background:var(--surface-dark-elevated,#16241f); border:1px solid var(--sv-line,rgba(255,255,255,.07)); border-radius:4px 14px 14px 14px; padding:11px 15px; color:var(--on-dark,#eaf2f0); font-size:14.5px; line-height:1.6; max-width:calc(100% - 44px); }
.cy-msg.me .cy-bbl { background:rgba(93,184,166,.10); border-color:rgba(93,184,166,.22); border-radius:14px 4px 14px 14px; }
.cy-msg.me { flex-direction:row-reverse; }
.cy-bbl p { margin:0 0 7px; } .cy-bbl p:last-child { margin:0; }
.cy-bbl b { color:var(--ink,#1f2937); } .cy-bbl code { background:rgba(255,255,255,.08); padding:1px 5px; border-radius:4px; font-size:.92em; }
/* exhibit card */
.cy-ex { background:var(--surface-dark-elevated,#16241f); border:1px solid var(--sv-line,rgba(255,255,255,.09)); border-radius:12px; padding:16px 16px 14px; margin:0 0 16px; }
.cy-ex-tag { display:inline-block; font-size:10px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--coral,#5db8a6); background:rgba(93,184,166,.10); padding:3px 9px; border-radius:999px; margin-bottom:9px; }
.cy-ex-title { font-size:15px; font-weight:700; color:var(--ink,#1f2937); margin-bottom:12px; }
.cy-ex-block { margin:0 0 16px; } .cy-ex-block:last-child { margin:0; }
.cy-ex-bname { font-size:11.5px; font-weight:600; letter-spacing:.02em; text-transform:uppercase; color:var(--on-dark-soft,#9db3ad); margin:0 0 8px; }
.cy-ex-note { font-size:12px; color:var(--on-dark-soft,#8fa39d); margin-top:10px; font-style:italic; }
.cy-tbl { width:100%; border-collapse:collapse; font-size:13.5px; }
.cy-tbl td { padding:7px 10px; border-bottom:1px solid var(--sv-line,rgba(255,255,255,.06)); color:var(--on-dark,#eaf2f0); }
.cy-tbl tr:last-child td { border-bottom:none; }
.cy-tbl td:last-child { text-align:right; font-variant-numeric:tabular-nums; font-weight:600; }
.cy-tbl tr.cy-tbl-total td { border-top:1.5px solid rgba(93,184,166,.4); font-weight:700; color:var(--ink,#1f2937); }
.cy-legend { display:flex; flex-wrap:wrap; gap:14px; margin-top:10px; font-size:11.5px; color:var(--on-dark-soft,#9db3ad); }
.cy-legend i { display:inline-block; width:11px; height:11px; border-radius:3px; margin-right:5px; vertical-align:-1px; }
.cy-chart svg { width:100%; height:auto; display:block; }
/* input widgets */
.cy-opt { display:flex; align-items:center; gap:10px; padding:11px 13px; margin:0 0 8px; border:1.5px solid var(--sv-line,rgba(255,255,255,.12)); border-radius:10px; cursor:pointer; color:var(--on-dark,#eaf2f0); font-size:14px; line-height:1.45; transition:border-color .12s, background .12s; }
.cy-opt:hover { border-color:rgba(93,184,166,.5); }
.cy-opt.sel { border-color:var(--coral,#5db8a6); background:rgba(93,184,166,.10); }
.cy-opt .cy-box { width:20px; height:20px; border-radius:5px; border:1.6px solid rgba(255,255,255,.3); flex-shrink:0; display:flex; align-items:center; justify-content:center; }
.cy-opt.radio .cy-box { border-radius:50%; }
.cy-opt.sel .cy-box { background:var(--coral,#5db8a6); border-color:var(--coral,#5db8a6); }
.cy-opt.sel .cy-box svg { display:block; } .cy-opt .cy-box svg { display:none; width:12px; height:12px; }
.cy-opt.correct { border-color:#5fbf6b; background:rgba(95,191,107,.10); }
.cy-opt.wrong { border-color:#e87c7c; background:rgba(232,124,124,.10); }
.cy-numrow { display:flex; gap:10px; align-items:center; }
.cy-numin, .cy-txtin { flex:1; background:var(--surface-dark-soft,#efe9dd); border:1.5px solid var(--sv-line,rgba(255,255,255,.14)); border-radius:10px; padding:12px 14px; color:var(--ink,#1f2937); font-size:15px; font-family:inherit; }
.cy-numin:focus, .cy-txtin:focus { outline:none; border-color:var(--coral,#5db8a6); }
.cy-txtin { width:100%; min-height:74px; resize:vertical; line-height:1.5; }
.cy-hint { font-size:12.5px; color:var(--on-dark-soft,#9db3ad); margin:8px 2px 0; }
.cy-send { background:var(--coral,#5db8a6); color:#04201b; border:none; border-radius:10px; padding:12px 22px; font-size:14.5px; font-weight:700; cursor:pointer; }
.cy-send:disabled { opacity:.45; cursor:default; }
.cy-send.ghost { background:transparent; color:var(--coral,#5db8a6); border:1.5px solid rgba(93,184,166,.4); }
.cy-fb { border-radius:10px; padding:11px 14px; margin:0 0 16px; font-size:13.5px; line-height:1.55; }
.cy-fb.ok { background:rgba(95,191,107,.10); border:1px solid rgba(95,191,107,.35); color:#2f7d3a; }
.cy-fb.no { background:rgba(232,124,124,.10); border:1px solid rgba(232,124,124,.35); color:#b23b3b; }
.cy-fb b { color:var(--ink,#1f2937); }
/* case picker */
.cy-pick-h { text-align:center; margin:6px 0 22px; }
.cy-pick-h .eyebrow { font-size:12px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; color:var(--coral,#5db8a6); }
.cy-pick-h h2 { font-size:24px; color:var(--ink,#1f2937); margin:8px 0 6px; }
.cy-pick-h p { color:var(--on-dark-soft,#9db3ad); font-size:14px; margin:0; }
.cy-card { background:var(--surface-dark-elevated,#16241f); border:1px solid var(--sv-line,rgba(255,255,255,.09)); border-radius:12px; padding:15px 16px; margin:0 0 10px; cursor:pointer; display:flex; align-items:center; gap:14px; transition:border-color .12s; }
.cy-card:hover { border-color:rgba(93,184,166,.5); }
.cy-card .cy-num { width:38px; height:38px; border-radius:9px; background:rgba(93,184,166,.13); color:var(--coral,#5db8a6); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:15px; flex-shrink:0; }
.cy-card .cy-cn { font-size:15px; font-weight:700; color:var(--ink,#1f2937); }
.cy-card .cy-cd { font-size:12.5px; color:var(--on-dark-soft,#9db3ad); margin-top:2px; }
.cy-card.done { opacity:.62; }
.cy-card .cy-badge { margin-left:auto; font-size:11px; font-weight:700; color:#5fbf6b; }
/* voice */
.cy-rec { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.cy-recbtn { background:#e87c7c; color:#2a0d0d; border:none; border-radius:999px; padding:12px 20px; font-weight:700; font-size:14px; cursor:pointer; display:flex; align-items:center; gap:8px; }
.cy-recbtn.recording { background:#c94b4b; color:var(--ink,#1f2937); animation:cyPulse 1.1s infinite; }
@keyframes cyPulse { 0%,100%{box-shadow:0 0 0 0 rgba(201,75,75,.5);} 50%{box-shadow:0 0 0 8px rgba(201,75,75,0);} }
.cy-recstat { font-size:12.5px; color:var(--on-dark-soft,#9db3ad); }
.cy-grade { background:var(--surface-dark-elevated,#16241f); border:1px solid var(--sv-line,rgba(255,255,255,.1)); border-radius:12px; padding:16px; margin:0 0 16px; }
.cy-crit { display:flex; gap:9px; align-items:flex-start; margin:0 0 9px; font-size:13px; color:var(--on-dark,#eaf2f0); line-height:1.5; }
.cy-crit .ic { width:19px; height:19px; border-radius:50%; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; margin-top:1px; }
.cy-crit.pass .ic { background:rgba(95,191,107,.2); color:#5fbf6b; } .cy-crit.fail .ic { background:rgba(232,124,124,.2); color:#e87c7c; }
.cy-score { font-size:13px; font-weight:700; color:var(--ink,#1f2937); margin:4px 0 12px; }

#cyInputZone { border-top:1px solid var(--sv-line, rgba(31,41,55,.14)); background:var(--surface-dark-elevated,#fbf8f2); }
.cy-calc-fab { position:absolute; right:18px; bottom:104px; z-index:30; width:48px; height:48px; border-radius:50%; background:var(--coral,#5db8a6); color:#04201b; border:none; cursor:pointer; box-shadow:0 6px 18px rgba(31,41,55,.18); display:flex; align-items:center; justify-content:center; }
.cy-calc-fab:hover { filter:brightness(1.06); }
.cy-calc { position:absolute; right:18px; bottom:162px; z-index:31; width:236px; background:var(--surface-dark-elevated,#fbf8f2); border:1px solid var(--sv-line, rgba(31,41,55,.14)); border-radius:14px; padding:12px; box-shadow:0 14px 40px rgba(31,41,55,.22); }
.cy-calc-head { display:flex; justify-content:space-between; align-items:center; color:var(--ink,#1f2937); font-size:11px; font-weight:700; letter-spacing:.07em; text-transform:uppercase; margin-bottom:9px; }
.cy-calc-head button { background:none; border:none; color:var(--on-dark-soft,#5b6472); font-size:19px; line-height:1; cursor:pointer; }
.cy-calc-disp { width:100%; background:var(--surface-dark-soft,#efe9dd); border:1px solid var(--sv-line, rgba(31,41,55,.14)); border-radius:9px; color:var(--ink,#1f2937); font-size:22px; text-align:right; padding:9px 11px; margin-bottom:10px; font-variant-numeric:tabular-nums; box-sizing:border-box; }
.cy-calc-keys { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; }
.cy-calc-keys button { padding:12px 0; border:1px solid var(--sv-line-soft, rgba(31,41,55,.08)); border-radius:9px; background:var(--surface-dark-soft,#efe9dd); color:var(--ink,#1f2937); font-size:15px; font-weight:600; cursor:pointer; }
.cy-calc-keys button:hover { background:var(--sv-fill-hover, rgba(31,41,55,.12)); }
.cy-calc-keys button.op { background:rgba(93,184,166,.16); color:var(--coral,#5db8a6); border-color:transparent; }
.cy-calc-keys button.eq { background:var(--coral,#5db8a6); color:#04201b; border-color:transparent; }
.cy-calc-keys button.wide { grid-column:span 2; }
`;
  var SCREEN = `  <div class="bcg-topbar">
    <button class="bcg-exit" onclick="Casey.exit()" title="Exit">&times;</button>
    <div class="bcg-progress-wrap">
      <div class="bcg-progress-track"><div class="bcg-progress-fill" id="cyProgFill" style="width:0%"></div></div>
      <div class="bcg-progress-label" id="cyProgLabel">Test Completed 0%</div>
    </div>
    <div class="bcg-interviewer" title="Your interviewer">Casey</div>
    <div class="bcg-timer" id="cyTimer">BCG &middot; Casey</div>
  </div>
  <div id="cyFeed"><div class="cy-wrap" id="cyWrap"></div></div>
  <button class="cy-calc-fab" onclick="caseyCalc.toggle()" title="Calculator" aria-label="Calculator"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"></rect><line x1="8" y1="6" x2="16" y2="6"></line><line x1="8" y1="14" x2="8" y2="14"></line><line x1="12" y1="14" x2="12" y2="14"></line><line x1="16" y1="14" x2="16" y2="18"></line><line x1="8" y1="18" x2="12" y2="18"></line></svg></button>
  <div class="cy-calc" id="cyCalc" style="display:none">
    <div class="cy-calc-head"><span>Calculator</span><button onclick="caseyCalc.toggle()" aria-label="Close">&times;</button></div>
    <input class="cy-calc-disp" id="cyCalcDisp" readonly value="0">
    <div class="cy-calc-keys"><button onclick="caseyCalc.press('C')">C</button><button onclick="caseyCalc.press('DEL')">&#9003;</button><button class="op" onclick="caseyCalc.press('%')">%</button><button class="op" onclick="caseyCalc.press('÷')">÷</button><button onclick="caseyCalc.press('7')">7</button><button onclick="caseyCalc.press('8')">8</button><button onclick="caseyCalc.press('9')">9</button><button class="op" onclick="caseyCalc.press('×')">×</button><button onclick="caseyCalc.press('4')">4</button><button onclick="caseyCalc.press('5')">5</button><button onclick="caseyCalc.press('6')">6</button><button class="op" onclick="caseyCalc.press('-')">−</button><button onclick="caseyCalc.press('1')">1</button><button onclick="caseyCalc.press('2')">2</button><button onclick="caseyCalc.press('3')">3</button><button class="op" onclick="caseyCalc.press('+')">+</button><button class="wide" onclick="caseyCalc.press('0')">0</button><button onclick="caseyCalc.press('.')">.</button><button class="eq" onclick="caseyCalc.press('=')">=</button></div>
  </div>
  <div id="cyInputZone" style="display:none"><div class="cy-iz-inner" id="cyIz"></div></div>`;
  var CARD = `          <div class="firm-initial" style="background:rgba(93,184,166,.15);color:var(--accent-teal);"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path><line x1="8" y1="9" x2="16" y2="9"></line><line x1="8" y1="13" x2="13" y2="13"></line></svg></div>
          <div>
            <div class="firm-name">Casey Simulator <span class="firm-tag">BCG</span> <span class="soon-badge" style="background:rgba(93,184,166,.18);color:var(--accent-teal);">Premium</span></div>
            <div class="firm-desc">The real BCG Casey chatbot - 15 interviewee-led cases, live exhibits, expected-value math, and a spoken final recommendation graded on the Pyramid Principle.</div>
          </div>
          <div class="firm-check"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg></div>`;
  function run(){
    if (!document.getElementById('screen-casey')){
      var st=document.createElement('style'); st.textContent=CSS; document.head.appendChild(st);
      var d=document.createElement('div'); d.id='screen-casey'; d.className='screen'; d.setAttribute('data-screen-label','Casey Chat'); d.innerHTML=SCREEN; document.body.appendChild(d);
    }
    var grid=document.querySelector('#screen-mode .firm-grid');
    if (grid && !document.getElementById('caseyModeCard')){ var c=document.createElement('div'); c.id='caseyModeCard'; c.className='firm-card'; c.setAttribute('tabindex','0'); c.setAttribute('role','button'); c.setAttribute('onclick','Casey.open()'); c.innerHTML=CARD; grid.appendChild(c); }
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',run); else run();
})();

(function () {
  "use strict";
  var PALETTE = ['#5db8a6', '#e8a55a', '#7c8ce8', '#5fbf6b', '#e87c7c', '#4fb0c9'];
  var CASES = null;          // loaded from /casey_cases.json
  var S = null;              // active session state

  function E(id){ return document.getElementById(id); }
  function esc2(s){ return (typeof esc === 'function') ? esc(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"]/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function md(s){
    s = esc2(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
    return s.split(/\n{2,}/).map(function(p){ return '<p>' + p.replace(/\n/g, '<br>') + '</p>'; }).join('');
  }
  function scrollFeed(){ var f = E('cyFeed'); if (f) setTimeout(function(){ f.scrollTop = f.scrollHeight; }, 40); }

  // ---------- chat / exhibit rendering ----------
  function say(role, text){
    var w = E('cyWrap'); if (!w) return;
    var d = document.createElement('div');
    d.className = 'cy-msg ' + (role === 'ai' ? 'ai' : 'me');
    d.innerHTML = '<div class="cy-av ' + (role === 'ai' ? 'ai' : 'me') + '">' + (role === 'ai' ? 'C' : 'You'.charAt(0)) + '</div><div class="cy-bbl">' + md(text) + '</div>';
    w.appendChild(d); scrollFeed();
  }
  function feedNode(html){ var w = E('cyWrap'); if (!w) return; var d = document.createElement('div'); d.innerHTML = html; w.appendChild(d.firstElementChild || d); scrollFeed(); }

  function num(v){
    if (typeof v !== 'number') { var n = parseFloat(String(v).replace(/[, ]/g,'')); return isNaN(n) ? v : n; }
    return v;
  }
  function fmtVal(v){ var n = num(v); return (typeof n === 'number') ? n.toLocaleString('en-US') : esc2(v); }

  // axis helper
  function niceMax(m){ if (m <= 0) return 1; var p = Math.pow(10, Math.floor(Math.log10(m))); var f = m / p; var nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10; return nf * p; }

  function barSVG(b, histogram){
    var labels = b.labels || [], series = b.series || [];
    var W = 620, H = 250, pL = 48, pR = 20, pT = 20, pB = 46;
    var pw = W - pL - pR, ph = H - pT - pB, n = labels.length, sc = series.length;
    var maxv = 0; series.forEach(function(s){ (s.values||[]).forEach(function(v){ if (num(v) > maxv) maxv = num(v); }); });
    var mx = niceMax(maxv), slot = pw / n, gap = histogram ? 0.02 : 0.18, groupW = slot * (1 - gap*2), bw = groupW / sc;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc2(b.name||'chart') + '">';
    for (var i = 0; i <= 4; i++){ var y = pT + ph - (i/4)*ph; svg += '<line x1="'+pL+'" y1="'+y.toFixed(1)+'" x2="'+(W-pR)+'" y2="'+y.toFixed(1)+'" stroke="var(--sv-line-soft)"/>'; svg += '<text x="'+(pL-7)+'" y="'+(y+3.5).toFixed(1)+'" text-anchor="end" font-size="9.5" fill="var(--on-dark-soft)">'+Math.round(mx*i/4).toLocaleString()+'</text>'; }
    labels.forEach(function(lab, li){
      series.forEach(function(s, si){
        var v = num((s.values||[])[li]); var h = (v/mx)*ph;
        var x = pL + li*slot + slot*gap + si*bw + (histogram?0:bw*0.08);
        var bwidth = bw * (histogram ? 1 : 0.84);
        var y = pT + ph - h;
        svg += '<rect x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+bwidth.toFixed(1)+'" height="'+Math.max(0,h).toFixed(1)+'" rx="'+(histogram?0:3)+'" fill="'+PALETTE[si % PALETTE.length]+'" opacity="0.92"/>';
        if (sc <= 2){ svg += '<text x="'+(x+bwidth/2).toFixed(1)+'" y="'+(y-5).toFixed(1)+'" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--on-dark)">'+esc2((s.values||[])[li])+'</text>'; }
      });
      svg += '<text x="'+(pL+li*slot+slot/2).toFixed(1)+'" y="'+(H-pB+16).toFixed(1)+'" text-anchor="middle" font-size="10" fill="var(--on-dark-soft)">'+esc2(lab)+'</text>';
    });
    svg += '</svg>';
    return svg + legend(series);
  }

  function lineSVG(b){
    var labels = b.labels || [], series = b.series || [];
    var W = 620, H = 250, pL = 48, pR = 20, pT = 20, pB = 46;
    var pw = W - pL - pR, ph = H - pT - pB, n = labels.length;
    var maxv = 0, minv = Infinity; series.forEach(function(s){ (s.values||[]).forEach(function(v){ v = num(v); if (v>maxv) maxv=v; if (v<minv) minv=v; }); });
    minv = Math.min(minv, 0); var mx = niceMax(maxv), rng = mx - minv || 1;
    var xw = n > 1 ? pw/(n-1) : pw;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc2(b.name||'chart') + '">';
    for (var i = 0; i <= 4; i++){ var y = pT + ph - (i/4)*ph; var val = minv + (mx-minv)*i/4; svg += '<line x1="'+pL+'" y1="'+y.toFixed(1)+'" x2="'+(W-pR)+'" y2="'+y.toFixed(1)+'" stroke="var(--sv-line-soft)"/>'; svg += '<text x="'+(pL-7)+'" y="'+(y+3.5).toFixed(1)+'" text-anchor="end" font-size="9.5" fill="var(--on-dark-soft)">'+Math.round(val).toLocaleString()+'</text>'; }
    labels.forEach(function(lab, li){ var x = pL + li*xw; svg += '<text x="'+x.toFixed(1)+'" y="'+(H-pB+16).toFixed(1)+'" text-anchor="middle" font-size="10" fill="var(--on-dark-soft)">'+esc2(lab)+'</text>'; });
    series.forEach(function(s, si){
      var col = PALETTE[si % PALETTE.length];
      var pts = (s.values||[]).map(function(v, li){ v = num(v); return { x: pL + li*xw, y: pT + ph - ((v-minv)/rng)*ph, v: (s.values||[])[li] }; });
      var d = pts.map(function(p, i){ return (i?'L':'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1); }).join(' ');
      svg += '<path d="'+d+'" fill="none" stroke="'+col+'" stroke-width="2.4"/>';
      pts.forEach(function(p){ svg += '<circle cx="'+p.x.toFixed(1)+'" cy="'+p.y.toFixed(1)+'" r="3.4" fill="'+col+'"/>'; svg += '<text x="'+p.x.toFixed(1)+'" y="'+(p.y-8).toFixed(1)+'" text-anchor="middle" font-size="9" font-weight="700" fill="'+col+'">'+esc2(p.v)+'</text>'; });
    });
    svg += '</svg>';
    return svg + legend(series);
  }

  function stackedSVG(b){
    var labels = b.labels || [], series = b.series || [];
    var W = 620, H = 250, pL = 48, pR = 20, pT = 20, pB = 46;
    var pw = W - pL - pR, ph = H - pT - pB, n = labels.length;
    var totals = labels.map(function(_, li){ var t=0; series.forEach(function(s){ t += num((s.values||[])[li]); }); return t; });
    var mx = niceMax(Math.max.apply(null, totals)), slot = pw/n, bw = slot*0.5;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc2(b.name||'chart') + '">';
    for (var i = 0; i <= 4; i++){ var y = pT + ph - (i/4)*ph; svg += '<line x1="'+pL+'" y1="'+y.toFixed(1)+'" x2="'+(W-pR)+'" y2="'+y.toFixed(1)+'" stroke="var(--sv-line-soft)"/>'; svg += '<text x="'+(pL-7)+'" y="'+(y+3.5).toFixed(1)+'" text-anchor="end" font-size="9.5" fill="var(--on-dark-soft)">'+Math.round(mx*i/4).toLocaleString()+'</text>'; }
    labels.forEach(function(lab, li){
      var x = pL + li*slot + slot/2 - bw/2, acc = 0;
      series.forEach(function(s, si){ var v = num((s.values||[])[li]); var h = (v/mx)*ph; var y = pT + ph - ((acc+v)/mx)*ph; svg += '<rect x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(0,h).toFixed(1)+'" fill="'+PALETTE[si % PALETTE.length]+'" opacity="0.92"/>'; if (h > 16) svg += '<text x="'+(x+bw/2).toFixed(1)+'" y="'+(y+h/2+3).toFixed(1)+'" text-anchor="middle" font-size="9.5" font-weight="700" fill="#04201b">'+esc2((s.values||[])[li])+'</text>'; acc += v; });
      svg += '<text x="'+(pL+li*slot+slot/2).toFixed(1)+'" y="'+(H-pB+16).toFixed(1)+'" text-anchor="middle" font-size="10" fill="var(--on-dark-soft)">'+esc2(lab)+'</text>';
    });
    svg += '</svg>';
    return svg + legend(series);
  }

  function pieSVG(b){
    var s = (b.series||[])[0] || { values: [] }; var labels = b.labels || [];
    var vals = (s.values||[]).map(num), total = vals.reduce(function(a,c){ return a+c; }, 0) || 1;
    var W = 360, H = 230, cx = 115, cy = 115, r = 96, a0 = -Math.PI/2;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc2(b.name||'pie') + '">';
    vals.forEach(function(v, i){
      var frac = v/total, a1 = a0 + frac*2*Math.PI, large = frac > 0.5 ? 1 : 0;
      var x0 = cx + r*Math.cos(a0), y0 = cy + r*Math.sin(a0), x1 = cx + r*Math.cos(a1), y1 = cy + r*Math.sin(a1);
      svg += '<path d="M'+cx+' '+cy+' L'+x0.toFixed(1)+' '+y0.toFixed(1)+' A'+r+' '+r+' 0 '+large+' 1 '+x1.toFixed(1)+' '+y1.toFixed(1)+' Z" fill="'+PALETTE[i % PALETTE.length]+'" opacity="0.92"/>';
      var am = (a0+a1)/2, lx = cx + (r*0.62)*Math.cos(am), ly = cy + (r*0.62)*Math.sin(am);
      if (frac > 0.05) svg += '<text x="'+lx.toFixed(1)+'" y="'+ly.toFixed(1)+'" text-anchor="middle" font-size="10.5" font-weight="700" fill="#04201b">'+Math.round(frac*100)+'%</text>';
      a0 = a1;
    });
    svg += '</svg>';
    var leg = labels.map(function(l, i){ return '<span><i style="background:'+PALETTE[i%PALETTE.length]+'"></i>'+esc2(l)+' ('+fmtVal(vals[i])+')</span>'; }).join('');
    return svg + '<div class="cy-legend">' + leg + '</div>';
  }

  function legend(series){
    if (!series || series.length < 2) return '';
    return '<div class="cy-legend">' + series.map(function(s, i){ return '<span><i style="background:'+PALETTE[i%PALETTE.length]+'"></i>'+esc2(s.name||('Series '+(i+1)))+'</span>'; }).join('') + '</div>';
  }

  function tableHTML(b){
    var rows = b.rows || [];
    return '<table class="cy-tbl">' + rows.map(function(r){
      var isTotal = String(r[0]).toLowerCase() === 'total';
      return '<tr class="' + (isTotal ? 'cy-tbl-total' : '') + '">' + r.map(function(c){ return '<td>' + esc2(c) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</table>';
  }

  function renderBlock(b){
    var body;
    try {
      if (b.type === 'table') body = tableHTML(b);
      else if (b.type === 'bar') body = barSVG(b, false);
      else if (b.type === 'histogram') body = barSVG(b, true);
      else if (b.type === 'line' || b.type === 'cohort_line') body = lineSVG(b);
      else if (b.type === 'stacked_bar') body = stackedSVG(b);
      else if (b.type === 'pie') body = pieSVG(b);
      else body = b.rows ? tableHTML(b) : '';           // degrade_to table
    } catch (e) { body = b.rows ? tableHTML(b) : '<div class="cy-ex-note">[exhibit]</div>'; }
    return '<div class="cy-ex-block">' + (b.name ? '<div class="cy-ex-bname">' + esc2(b.name) + '</div>' : '') +
      '<div class="cy-chart">' + body + '</div>' +
      (b.note ? '<div class="cy-ex-note">' + esc2(b.note) + '</div>' : '') + '</div>';
  }

  function showExhibit(ex){
    if (!ex || S.shown[ex.id]) return; S.shown[ex.id] = true;
    var html = '<div class="cy-ex"><span class="cy-ex-tag">Exhibit</span><div class="cy-ex-title">' + esc2(ex.title || 'Exhibit') + '</div>' +
      (ex.blocks || []).map(renderBlock).join('') + '</div>';
    feedNode(html);
  }

  // ---------- server grading ----------
  function freshToken2(){
    if (typeof sb === 'undefined' || !sb) return Promise.resolve(null);
    return sb.auth.getSession().then(function(r){
      var s = r && r.data && r.data.session;
      if (s && s.expires_at && (s.expires_at*1000 - Date.now() < 60000)) return sb.auth.refreshSession().then(function(rr){ return (rr && rr.data && rr.data.session) || s; });
      return s;
    }).then(function(s){ return s ? s.access_token : null; }).catch(function(){ return null; });
  }
  function claude(system, userText){
    return freshToken2().then(function(token){
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      return fetch('/api/claude', { method:'POST', headers: headers, body: JSON.stringify({ model:'claude-sonnet-5', max_tokens:1000, system: system, messages: [{ role:'user', content: userText }] }) });
    }).then(function(r){ return r.json().catch(function(){ return {}; }); })
      .then(function(d){ return (d.content && d.content[0] && d.content[0].text) || ''; });
  }
  function parseJSON(txt){ try { var m = txt.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch (e) { return null; } }

  function gradeOpen(step, answer){
    var sys = 'Ты — строгий, но справедливый экзаменатор BCG-кейс-интервью. Оцени ответ кандидата по бинарному критерию. Верни ТОЛЬКО JSON: {"pass":true|false,"feedback":"1 короткое предложение по-русски: что засчитано/провалено"}.';
    var u = 'КРИТЕРИЙ ЗАЧЁТА: ' + (step.validation || 'разумный ответ по существу') +
      '\nЭТАЛОН: ' + (step.model_answer || '—') +
      '\nОТВЕТ КАНДИДАТА: ' + answer;
    return claude(sys, u).then(function(t){ var j = parseJSON(t); return j || { pass:true, feedback:'Ответ принят.' }; });
  }

  // ---------- flow ----------
  function flatten(c){
    var flat = [];
    c.steps.forEach(function(st){
      if (st.type === 'multipart'){
        (st.parts||[]).forEach(function(p, i){ var q = Object.assign({}, p); if (i === 0){ q._wrap = st.prompt; q._reveal = st.reveal_exhibits_on_enter; } flat.push(q); });
      } else {
        var q = Object.assign({}, st); if (st.reveal_exhibits_on_enter) q._reveal = st.reveal_exhibits_on_enter; flat.push(q);
      }
    });
    return flat;
  }

  function progress(){
    var pct = Math.round((S.idx / S.flat.length) * 100);
    var f = E('cyProgFill'); if (f) f.style.width = pct + '%';
    var l = E('cyProgLabel'); if (l) l.textContent = 'Test Completed ' + pct + '%';
  }

  function iz(html){ var z = E('cyInputZone'), i = E('cyIz'); if (!z || !i) return; z.style.display = 'block'; i.innerHTML = html; }
  function izHide(){ var z = E('cyInputZone'); if (z) z.style.display = 'none'; }

  function step(){
    progress();
    if (S.idx >= S.flat.length){ return finish(); }
    var q = S.flat[S.idx];
    // reveal auto_at_step exhibits tied to this step
    if (q._reveal) q._reveal.forEach(function(id){ showExhibit(exById(id)); });
    if (q._wrap) say('ai', q._wrap);
    say('ai', q.prompt || '(question)');
    renderWidget(q);
  }

  function exById(id){ return (S.case.exhibits || []).filter(function(e){ return e.id === id; })[0]; }

  function renderWidget(q){
    var t = q.type;
    if (t === 'select_all' || t === 'select_fewest' || t === 'single_choice'){
      var single = t === 'single_choice';
      var opts = (q.options||[]).map(function(o, i){ return '<div class="cy-opt ' + (single?'radio':'') + '" data-i="' + i + '" onclick="Casey._pick(' + i + ',' + single + ')"><span class="cy-box"><svg viewBox="0 0 24 24" fill="none" stroke="#04201b" stroke-width="3.5"><path d="M20 6L9 17l-5-5"/></svg></span><span>' + esc2(o.text) + '</span></div>'; }).join('');
      var help = t === 'select_all' ? 'Select all that apply.' : t === 'select_fewest' ? 'Select the fewest items that fit.' : 'Choose one.';
      iz(opts + '<div class="cy-hint">' + help + '</div><div style="margin-top:12px;text-align:right"><button class="cy-send" id="cySendBtn" disabled onclick="Casey._submit()">Submit</button></div>');
    } else if (t === 'enter_number'){
      iz('<div class="cy-numrow"><input class="cy-numin" id="cyNumIn" type="text" inputmode="decimal" placeholder="Enter a number" onkeydown="if(event.key===\'Enter\')Casey._submit()"><button class="cy-send" onclick="Casey._submit()">Submit</button></div><div class="cy-hint">Enter the number the question asks for (no need to type the currency symbol).</div>');
      setTimeout(function(){ var el = E('cyNumIn'); if (el) el.focus(); }, 50);
    } else if (t === 'voice'){
      renderVoice(q);
    } else { // open_text, elicitation, brainstorm
      var ph = t === 'open_text_brainstorm' ? 'List your ideas — group them (e.g. Revenue side / Cost side)…' : 'Type your answer…';
      iz('<textarea class="cy-txtin" id="cyTxtIn" placeholder="' + ph + '"></textarea><div style="margin-top:10px;text-align:right"><button class="cy-send" onclick="Casey._submit()">Submit</button></div>');
      setTimeout(function(){ var el = E('cyTxtIn'); if (el) el.focus(); }, 50);
    }
  }

  function fb(ok, html){ feedNode('<div class="cy-fb ' + (ok?'ok':'no') + '">' + html + '</div>'); }

  function advance(){ S.idx++; izHide(); setTimeout(step, 350); }

  function _pick(i, single){
    var els = document.querySelectorAll('#cyIz .cy-opt');
    if (single){ els.forEach(function(e){ e.classList.remove('sel'); }); }
    var el = document.querySelector('#cyIz .cy-opt[data-i="' + i + '"]'); if (el) el.classList.toggle('sel');
    var any = document.querySelectorAll('#cyIz .cy-opt.sel').length > 0;
    var b = E('cySendBtn'); if (b) b.disabled = !any;
  }

  function _submit(){
    var q = S.flat[S.idx], t = q.type;
    if (t === 'select_all' || t === 'select_fewest' || t === 'single_choice'){
      var sel = [].slice.call(document.querySelectorAll('#cyIz .cy-opt.sel')).map(function(e){ return Number(e.dataset.i); });
      if (!sel.length) return;
      var req = []; (q.options||[]).forEach(function(o, i){ if (o.correct) req.push(i); });
      var ok = req.length === sel.length && req.every(function(i){ return sel.indexOf(i) >= 0; });
      say('me', sel.map(function(i){ return q.options[i].text; }).join('  •  '));
      // mark options
      (q.options||[]).forEach(function(o, i){ var el = document.querySelector('#cyIz .cy-opt[data-i="' + i + '"]'); if (!el) return; if (o.correct) el.classList.add('correct'); else if (sel.indexOf(i) >= 0) el.classList.add('wrong'); });
      if (ok) S.score++;
      fb(ok, (ok ? '<b>✓ Correct.</b> ' : '<b>Not quite.</b> ') + 'Verified against: ' + esc2(q.validation || ''));
      return void setTimeout(advance, 500);
    }
    if (t === 'enter_number'){
      var raw = E('cyNumIn').value.trim().replace(/[$,%\s]/g, '');
      if (raw === '' || isNaN(Number(raw))) return;
      var val = Number(raw), ans = num(q.answer);
      var tol = Math.max(0.01, Math.abs(ans) * 0.005);
      var ok = Math.abs(val - ans) <= tol;
      say('me', raw);
      if (ok) S.score++;
      var expl = q.answer_explain ? '<div style="margin-top:6px">' + md(q.answer_explain) + '</div>' : '';
      fb(ok, (ok ? '<b>✓ ' + fmtVal(ans) + '</b> — correct.' : '<b>Not quite — the answer is ' + fmtVal(ans) + '.</b>') + expl);
      return void setTimeout(advance, 600);
    }
    // text-based
    var el = E('cyTxtIn'); if (!el) return; var answer = el.value.trim(); if (!answer) return;
    say('me', answer); izHide();
    // elicitation: fast path via trigger phrases, else LLM
    if (t === 'open_text_elicitation'){
      var trg = (q.trigger_phrases || []).some(function(p){ return answer.toLowerCase().indexOf(String(p).toLowerCase()) >= 0; });
      var proceedReveal = function(passed){
        if (passed){ S.score++; fb(true, '<b>Good ask.</b> ' + esc2(q.validation || 'Right thing to probe.')); }
        else { fb(false, '<b>Hint:</b> ' + esc2((q.fallback ? '' : '') + 'Think about what you still need to know — revealing the exhibit anyway.')); }
        if (q.reveal_exhibit){ setTimeout(function(){ say('ai', 'Here is what that surfaces:'); showExhibit(exById(q.reveal_exhibit)); setTimeout(advance, 400); }, 300); }
        else setTimeout(advance, 400);
      };
      if (trg) return proceedReveal(true);
      return void gradeOpen(q, answer).then(function(r){ proceedReveal(!!r.pass); });
    }
    // open_text / brainstorm → LLM grade
    izBusy();
    gradeOpen(q, answer).then(function(r){ if (r.pass) S.score++; fb(!!r.pass, (r.pass ? '<b>✓ </b>' : '<b>✗ </b>') + esc2(r.feedback || '')); setTimeout(advance, 500); });
  }

  function izBusy(){ iz('<div class="cy-recstat">Grading your answer…</div>'); }

  // ---------- voice finale ----------
  var mic = null;
  function renderVoice(q){
    iz('<div class="cy-rec"><button class="cy-recbtn" id="cyRecBtn" onclick="Casey._rec()"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/><path d="M19 11a7 7 0 0 1-14 0" fill="none" stroke="currentColor" stroke-width="2"/></svg><span id="cyRecLbl">Record recommendation</span></button><span class="cy-recstat" id="cyRecStat">~60–90 seconds. Conclusion first.</span></div><div style="margin-top:10px"><textarea class="cy-txtin" id="cyVoiceTxt" placeholder="…or type your recommendation here if you prefer."></textarea><div style="margin-top:8px;text-align:right"><button class="cy-send ghost" onclick="Casey._submitVoice()">Submit recommendation</button></div></div>');
  }
  function _rec(){
    if (mic){ stopRec(); return; }
    var stat = E('cyRecStat');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined'){ if (stat) stat.textContent = 'Mic not supported — type your answer instead.'; return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream){
      var rec = new MediaRecorder(stream), chunks = [];
      rec.ondataavailable = function(e){ if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = function(){
        stream.getTracks().forEach(function(t){ t.stop(); });
        var blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        var fr = new FileReader();
        fr.onloadend = function(){
          var b64 = String(fr.result).split(',')[1];
          if (stat) stat.textContent = 'Transcribing…';
          if (typeof callTranscribe === 'function'){
            callTranscribe(b64, rec.mimeType || 'audio/webm').then(function(txt){ var ta = E('cyVoiceTxt'); if (ta) ta.value = txt; if (stat) stat.textContent = 'Transcribed — review and submit.'; }).catch(function(){ if (stat) stat.textContent = 'Transcription failed — type your answer instead.'; });
          } else if (stat) stat.textContent = 'Transcription unavailable — type your answer.';
        };
        fr.readAsDataURL(blob);
      };
      rec.start(); mic = { rec: rec, stream: stream };
      var btn = E('cyRecBtn'), lbl = E('cyRecLbl'); if (btn) btn.classList.add('recording'); if (lbl) lbl.textContent = 'Stop recording';
      if (stat) stat.textContent = 'Recording…';
    }).catch(function(){ if (stat) stat.textContent = 'Mic access denied — type your answer instead.'; });
  }
  function stopRec(){ if (!mic) return; try { mic.rec.stop(); } catch (e) {} mic = null; var btn = E('cyRecBtn'), lbl = E('cyRecLbl'); if (btn) btn.classList.remove('recording'); if (lbl) lbl.textContent = 'Record recommendation'; }

  function _submitVoice(){
    if (mic) stopRec();
    var ta = E('cyVoiceTxt'); if (!ta) return; var transcript = ta.value.trim(); if (!transcript) return;
    say('me', transcript); izBusy();
    var q = S.flat[S.idx];
    var rubric = (window.CASEY_RUBRICS && window.CASEY_RUBRICS[q.rubric_ref]) || null;
    var sys = window.CASEY_VOICE_SYSTEM || 'You grade a BCG case voice recommendation. Return JSON {criteria:{c1_conclusion_first:{pass},c2_anchor_number:{pass},c3_mechanisms:{pass},c4_risks_nextstep:{pass}},score,verdict,coaching}.';
    var u = 'case_id: ' + q.rubric_ref + '\nrubric: ' + JSON.stringify(rubric) + '\ntranscript: ' + transcript;
    claude(sys, u).then(function(t){
      var j = parseJSON(t) || { criteria:{}, score:0, verdict:'weak', coaching:'Не удалось оценить — попробуйте ещё раз.' };
      renderGrade(j, q);
    });
  }

  function renderGrade(j, q){
    izHide();
    var labels = { c1_conclusion_first:'Вывод — первым (Пирамида)', c2_anchor_number:'Якорное число', c3_mechanisms:'Механизм(ы)', c4_risks_nextstep:'Риски + next step' };
    var crit = j.criteria || {};
    var rows = Object.keys(labels).map(function(k){ var c = crit[k] || {}; var pass = !!c.pass; return '<div class="cy-crit ' + (pass?'pass':'fail') + '"><span class="ic">' + (pass?'✓':'✗') + '</span><span><b>' + labels[k] + '</b>' + (c.evidence ? ' — ' + esc2(c.evidence) : '') + '</span></div>'; }).join('');
    var score = typeof j.score === 'number' ? j.score : Object.keys(crit).filter(function(k){ return crit[k] && crit[k].pass; }).length;
    var verdict = j.verdict || (score >= 4 ? 'strong' : score >= 3 ? 'partial' : 'weak');
    feedNode('<div class="cy-grade"><div class="cy-score">Голосовой финал: ' + score + '/4 · ' + esc2(verdict) + '</div>' + rows + (j.coaching ? '<div class="cy-fb ' + (score>=3?'ok':'no') + '" style="margin-top:12px">' + esc2(j.coaching) + '</div>' : '') + '</div>');
    if (score >= 3) S.score++;
    // reveal partner model answer
    if (q.model_answer){ setTimeout(function(){ feedNode('<div class="cy-ex"><span class="cy-ex-tag">Partner-level model answer</span><div class="cy-bbl" style="max-width:100%;margin-top:4px">' + md(q.model_answer) + '</div></div>'); S.idx++; setTimeout(finish, 500); }, 400); }
    else { S.idx++; setTimeout(finish, 500); }
  }

  function finish(){
    progress();
    izHide();
    var maxScore = S.flat.length;
    say('ai', '**Case complete.** You scored **' + S.score + ' / ' + maxScore + '** on this run. Review the exhibits and the model recommendation above — then try another case.');
    feedNode('<div style="text-align:center;margin:18px 0"><button class="cy-send" onclick="Casey.open()">← Back to case list</button></div>');
    try { var done = JSON.parse(localStorage.getItem('casedge_casey_done') || '[]'); if (done.indexOf(S.case.id) < 0) done.push(S.case.id); localStorage.setItem('casedge_casey_done', JSON.stringify(done)); } catch (e) {}
  }

  // ---------- case picker / entry ----------
  function loadCases(){
    if (CASES) return Promise.resolve(CASES);
    return fetch('/casey_cases.json').then(function(r){ return r.json(); }).then(function(d){ CASES = d.cases || []; return CASES; });
  }

  function open(){
    if (typeof showScreen === 'function') showScreen('casey');
    izHide();
    var w = E('cyWrap'); if (w) w.innerHTML = '';
    E('cyProgFill').style.width = '0%'; E('cyProgLabel').textContent = 'Choose a case';
    loadCases().then(function(cases){
      var done = []; try { done = JSON.parse(localStorage.getItem('casedge_casey_done') || '[]'); } catch (e) {}
      var cards = cases.map(function(c, i){ var d = done.indexOf(c.id) >= 0;
        return '<div class="cy-card ' + (d?'done':'') + '" onclick="Casey.play(\'' + c.id + '\')"><div class="cy-num">' + (i+1) + '</div><div><div class="cy-cn">' + esc2(c.title) + '</div><div class="cy-cd">' + esc2(c.meta_tag || '') + '</div></div>' + (d?'<span class="cy-badge">✓ done</span>':'') + '</div>'; }).join('');
      w.innerHTML = '<div class="cy-pick-h"><div class="eyebrow">BCG · Casey Simulator</div><h2>Pick a case</h2><p>15 interviewee-led cases · exhibits · voice recommendation, graded like the real thing.</p></div>' + cards;
      scrollFeed();
    }).catch(function(){ w.innerHTML = '<div class="cy-pick-h"><p>Could not load cases. Please try again.</p></div>'; });
  }

  function play(id){
    var c = CASES.filter(function(x){ return x.id === id; })[0]; if (!c) return;
    S = { case: c, flat: flatten(c), idx: 0, score: 0, shown: {} };
    var w = E('cyWrap'); if (w) w.innerHTML = '';
    E('cyProgLabel').textContent = 'Test Completed 0%';
    say('ai', "I'm Casey. Let's work through **" + c.title + "**. Read the brief, use the exhibits — the math is real. You'll close with a spoken recommendation.");
    say('ai', c.scenario);
    // auto exhibits
    (c.exhibits || []).forEach(function(ex){ if (ex.reveal === 'auto') showExhibit(ex); });
    setTimeout(step, 500);
  }

  function exit(){ if (typeof showScreen === 'function') showScreen('mode'); }

  window.Casey = { open: open, play: play, exit: exit, _pick: _pick, _submit: _submit, _rec: _rec, _submitVoice: _submitVoice };
})();
