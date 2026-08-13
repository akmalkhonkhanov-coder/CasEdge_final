// Гейт долга №1: разбор Analysis отдаётся только по валидным билетам и нигде
// не течёт в санитайзере. Проверяется БОЕВОЙ файл api/redrock-session.js:
// он читается с диска и исполняется, копий его кода здесь нет.
//
// Порядок по норме: сперва ПОЛОЖИТЕЛЬНЫЙ контроль (правда известна заранее:
// честный набор билетов ОБЯЗАН пройти), затем пять мутаций, каждая обязана
// покраснеть. У каждой проверки печатается знаменатель.
import fs from 'fs';
import vm from 'vm';
import { createRequire } from 'module';

// require разрешается ОТНОСИТЕЛЬНО боевого файла, а не гейта: иначе './_auth.js'
// не найдётся и гейт упадёт до первой проверки.
const require_ = createRequire(new URL('./api/', import.meta.url));
const SRC = './api/redrock-session.js';
let code = fs.readFileSync(SRC, 'utf8');
if (!/export default async function handler/.test(code)) { console.error('НЕ НАЙДЕН handler в ' + SRC); process.exit(1); }
code = code.replace('export default async function handler', 'async function handler');
code += '\n;({ rkTicket, rkTicketValid, analysisFieldIds, sanitizeGame, GAMES_DATA, fieldMap });';

process.env.REDROCK_SECRET = process.env.REDROCK_SECRET || 'gate-test-secret';
const ctx = { require: require_, process, console, Buffer, module: {}, exports: {}, fetch, setTimeout, clearTimeout, AbortController };
const api = vm.runInNewContext(code, ctx, { filename: SRC });

const games = api.GAMES_DATA.games || [];
let fail = 0;
const ok = (name, cond, denom) => { console.log((cond ? '  зелёное  ' : '  КРАСНОЕ  ') + name + (denom ? '   (' + denom + ')' : '')); if (!cond) fail++; };

console.log('ГЕЙТ РАЗБОРА ANALYSIS · игр в библиотеке: ' + games.length);

// 0. материал вообще есть
const withRev = games.filter(g => Array.isArray(g.analysis_review) && g.analysis_review.length);
ok('analysis_review есть у каждой игры', withRev.length === games.length, withRev.length + ' из ' + games.length);

// 1. ПОЛОЖИТЕЛЬНЫЙ КОНТРОЛЬ: честные билеты на все поля обязаны пройти у ВСЕХ игр
const U = 'user-aaa';
let posOK = 0, fieldsChecked = 0;
for (const g of games) {
  const need = api.analysisFieldIds(g);
  fieldsChecked += need.length;
  const tickets = {}; for (const f of need) tickets[f] = api.rkTicket(U, g.id, f);
  if (need.length && need.every(f => api.rkTicketValid(U, g.id, f, tickets[f]))) posOK++;
}
ok('честный набор билетов открывает разбор', posOK === games.length, posOK + ' из ' + games.length + ' игр, полей ' + fieldsChecked);

// 2. каждое поле игры покрыто картой оценивания — иначе билет выдать не за что
let mapped = 0, mapTotal = 0;
for (const g of games) { const m = api.fieldMap(g); for (const f of api.analysisFieldIds(g)) { mapTotal++; if (m.get(f)) mapped++; } }
ok('каждое аналитическое поле оценивается сервером', mapped === mapTotal, mapped + ' из ' + mapTotal);

// 3. МУТАЦИИ. Каждая обязана быть КРАСНОЙ (то есть билет НЕ принят).
const g0 = games[0], f0 = api.analysisFieldIds(g0)[0];
const good = api.rkTicket(U, g0.id, f0);
const mut = [
  ['чужой пользователь',   api.rkTicketValid('user-bbb', g0.id, f0, good)],
  ['чужая игра',           api.rkTicketValid(U, games[1].id, f0, good)],
  ['чужое поле',           api.rkTicketValid(U, g0.id, api.analysisFieldIds(g0)[1] || 'a:zzz', good)],
  ['билета нет',           api.rkTicketValid(U, g0.id, f0, undefined)],
  ['билет подрисован',     api.rkTicketValid(U, g0.id, f0, good.slice(0, -1) + (good.slice(-1) === 'A' ? 'B' : 'A'))],
  ['пустая строка',        api.rkTicketValid(U, g0.id, f0, '')]
];
let red = 0; for (const [n, accepted] of mut) { if (!accepted) red++; else console.log('  КРАСНОЕ  мутация ПРОШЛА: ' + n); }
ok('мутации отбиты', red === mut.length, red + ' из ' + mut.length);

// 4. неполный набор: не хватает одного билета из всех — разбор закрыт
let partialBlocked = 0;
for (const g of games) {
  const need = api.analysisFieldIds(g); if (need.length < 2) { partialBlocked++; continue; }
  const t = {}; for (const f of need.slice(1)) t[f] = api.rkTicket(U, g.id, f);
  const missing = need.filter(f => !api.rkTicketValid(U, g.id, f, t[f]));
  if (missing.length === 1) partialBlocked++;
}
ok('неполная сдача не открывает разбор', partialBlocked === games.length, partialBlocked + ' из ' + games.length);

// 5. САНИТАЙЗЕР: ни разбора, ни ответа, ни наива в срезе для браузера
const KEYS = ['analysis_review', 'answer', 'naive', 'naive_reason', 'trap', 'lesson', 'justify_rubric', 'distractors', 'hidden'];
function scanKeys(v, hits) {
  if (Array.isArray(v)) { v.forEach(x => scanKeys(x, hits)); return hits; }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) { if (KEYS.includes(k)) hits.push(k); scanKeys(v[k], hits); } }
  return hits;
}
let leaks = 0, scanned = 0;
for (const g of games) { scanned++; const s = api.sanitizeGame(g, new Set()); const h = scanKeys(s, []); if (h.length) { leaks++; if (leaks <= 3) console.log('    течёт #' + g.id + ': ' + [...new Set(h)].join(',')); } }
ok('ключей разбора в срезе для браузера нет', leaks === 0, 'проверено игр ' + scanned + ', с утечкой ' + leaks);

// 6. отрицательный контроль самого сканера: подложный срез обязан покраснеть
const fake = api.sanitizeGame(g0, new Set()); fake.analysis_review = g0.analysis_review;
ok('сканер утечки видит подложенный разбор (отрицательный контроль)', scanKeys(fake, []).length > 0, '1 из 1');

console.log(fail === 0 ? '\nИТОГ: ЗЕЛЁНО, проверок 7' : '\nИТОГ: КРАСНОЕ, провалов ' + fail);
process.exit(fail === 0 ? 0 : 1);
