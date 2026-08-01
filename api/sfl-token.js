'use strict';
/**
 * sfl-token.js — кодек состояния партии SFL для stateless-режима (`api/`).
 *
 * Цех игр, круг 17. ЭТО ПРЕДЛОЖЕНИЕ, А НЕ ПОРТ. Порт `api/sfl-session.js` — за dev,
 * он его взял. Здесь лежит одна фиддли часть, которую всё равно пришлось бы писать
 * дважды: подпись токена и разбор недоверенного входа по §5 документа
 * `05_документы/SFL_ПОРТ_состояние_сессии.md`. Возьми целиком, возьми кусок или
 * выкинь — гейт `test-sfl-port.js` проверяет КОНТРАКТ, а не этот файл, и остаётся
 * полезным при любом решении.
 *
 * Контракт (выведен из кода и проверен переигровкой):
 *   в токене  v · sc · seed · t0 · picks[{c, ms}]
 *   не в токене  share · fb · sub · trait · priorityTag · variant  — из них выводится ключ
 *
 * Ключ HMAC берётся из SFL_TOKEN_KEY. Без ключа модуль НЕ РАБОТАЕТ И ГОВОРИТ ОБ ЭТОМ:
 * молча выдавать неподписанные токены — это отдать кандидату право дописывать себе ходы.
 */
const crypto = require('crypto');

const VERSION = 1;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** поля, из которых выводится ключ: наружу не уходят ни в токене, ни во view() */
const FORBIDDEN = ['share', 'fb', 'sub', 'trait', 'priorityTag', 'variant', 'key', 'best'];

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function keyOf(key) {
  const k = key ?? process.env.SFL_TOKEN_KEY ?? '';
  if (!k) throw new Error('SFL_TOKEN_KEY не задан: неподписанный токен — это право кандидата дописать себе ходы');
  return k;
}

function sign(payload, key) {
  const body = b64u(JSON.stringify(payload));
  const mac = b64u(crypto.createHmac('sha256', keyOf(key)).update(body).digest());
  return body + '.' + mac;
}

/** подпись доказывает, что токен выдали мы, — и больше ничего. Осмысленность проверяется ниже. */
function unsign(token, key) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) throw new Error('bad token');
  const want = b64u(crypto.createHmac('sha256', keyOf(key)).update(parts[0]).digest());
  const a = Buffer.from(parts[1]), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('bad signature');
  let payload;
  try { payload = JSON.parse(unb64u(parts[0]).toString('utf8')); }
  catch { throw new Error('bad payload'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('bad payload');
  return payload;
}

/**
 * Разбор недоверенного входа (Г21). Всё, что приходит от клиента, проверяется,
 * даже подписанное нами: подпись — про происхождение, а не про смысл.
 */
function decode(token, { key, scenarios, now = Date.now() } = {}) {
  const p = unsign(token, key);
  if (p.v !== VERSION) throw new Error('bad version');

  for (const f of FORBIDDEN) if (f in p) throw new Error('в токене запретное поле ' + f);

  const sc = (scenarios || []).find(s => s.id === p.sc);
  if (!sc) throw new Error('unknown scenario');       // 400, а не «возьму первый»

  if (typeof p.seed !== 'string' || p.seed.length > 64) throw new Error('bad seed');

  if (p.t0 !== null) {
    if (!Number.isFinite(p.t0)) throw new Error('bad t0');
    if (p.t0 > now + 60000) throw new Error('t0 из будущего');
    if (now - p.t0 > MAX_AGE_MS) throw new Error('t0 старше суток');
  }

  if (!Array.isArray(p.picks)) throw new Error('bad picks');
  if (p.picks.length > sc.steps.length) throw new Error('picks длиннее сценария'); // подделанная длина, а не таймаут

  let sum = 0;
  for (const pick of p.picks) {
    if (!pick || typeof pick !== 'object' || Array.isArray(pick)) throw new Error('bad pick');
    if (!Number.isFinite(pick.ms) || pick.ms < 0) throw new Error('bad ms');
    sum += pick.ms;
    const okChoice = typeof pick.c === 'string' || (Array.isArray(pick.c) && pick.c.every(x => typeof x === 'string'));
    if (!okChoice) throw new Error('bad choice');
  }
  if (sum > sc.timerMs) throw new Error('сумма ms больше таймера');

  return { v: p.v, sc, seed: p.seed, t0: p.t0 === undefined ? null : p.t0, picks: p.picks };
}

/**
 * Восстановление сессии переигровкой. stepIndex, branch, stepStartedAt, finished
 * не хранятся — они выводятся отсюда. Проверено: reveal() восстановленной сессии
 * побайтно совпадает с reveal() прожившей в памяти.
 */
function restore(state, SFLSession) {
  const s = new SFLSession(state.sc, { now: state.t0 ?? 0, seed: state.seed });
  if (state.t0 !== null) s.begin(state.t0);
  let t = state.t0 ?? 0;
  for (const pick of state.picks) {
    t += pick.ms;
    s.answer(pick.c, t);                    // негодный ход — это ответ на 0, а не 500
  }
  return s;
}

/** обратное: из состояния собрать токен на выдачу клиенту */
function encode(state, key) {
  return sign({ v: VERSION, sc: state.sc.id ?? state.sc, seed: state.seed,
                t0: state.t0 ?? null, picks: state.picks.map(p => ({ c: p.c, ms: p.ms })) }, key);
}

module.exports = { VERSION, FORBIDDEN, sign, unsign, encode, decode, restore };
