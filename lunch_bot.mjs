#!/usr/bin/env node
/**
 * SSAFY 점심(중식) 식단을 Mattermost에 올리는 봇. 웰스토리 API를 직접 호출한다.
 * Node 20+ 내장 fetch만 사용 (외부 패키지 없음).
 *
 * 환경변수 (.env 파일도 읽음, 이미 설정된 값은 덮어쓰지 않음):
 *   WELSTORY_USERNAME, WELSTORY_PASSWORD  (필수)
 *   MM_WEBHOOK_URL                        (실제 전송 시 필수, --dry-run이면 불필요)
 *   RESTAURANT_CODE, RESTAURANT_NAME      (선택)
 *   HALL_NO                               (선택, 기본 E32M = 점심 코스 홀)
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const BASE_URL = 'https://welplus.welstory.com';
const KST_OFFSET_MS = 9 * 3600 * 1000; // 한국은 DST 없음
const TIMEOUT_MS = 15_000;             // 모든 요청 공통
const RETRIES = 3;                     // 네트워크 오류/5xx 재시도 횟수
const POLL_INTERVAL_MS = 5 * 60_000;   // 사진 대기 중 재조회 간격
const DEADLINE_HM = [11, 40];          // 이 시각(KST)까지 사진 없으면 있는 것만으로 전송
const WEEKDAYS = '일월화수목금토';
const DEFAULT_HALL_NO = 'E32M';        // 점심 코스 홀 (전기부산 기준). 환경변수 HALL_NO로 변경, 쉼표로 여러 개

class BotError extends Error {}
/** 빈 본문 / JSON 아님 / 구조 다름 → 인증 실패 또는 API 변경 */
class AuthOrApiError extends BotError {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 현재 KST 시각을 "UTC 필드에 KST 값이 들어간 Date"로 반환 */
const nowKst = () => new Date(Date.now() + KST_OFFSET_MS);
const pad = (n) => String(n).padStart(2, '0');

function log(msg) {
  const t = nowKst();
  console.error(`[${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}] ${msg}`);
}

/**
 * timeout + 짧은 재시도. 4xx와 정상 응답은 그대로 반환, 네트워크 오류/5xx만 재시도.
 * retryTimeout=false면 타임아웃 시 재시도하지 않음 (웹훅 중복 게시 방지).
 */
async function fetchWithRetry(url, options, { label, retryTimeout = true }) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = await res.text();
      if (res.status < 500) return { res, text };
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      if (e.name === 'TimeoutError' && !retryTimeout) {
        throw new BotError(`${label}: 응답 대기 시간 초과 (중복 방지를 위해 재시도 안 함)`);
      }
      lastErr = e.cause?.code ?? e.message;
    }
    log(`${label}: 실패 (${attempt}/${RETRIES}) - ${lastErr}`);
    if (attempt < RETRIES) await sleep(2000 * attempt);
  }
  throw new BotError(`${label}: ${RETRIES}회 시도 모두 실패 - ${lastErr}`);
}

/** 웰스토리 앞단 Imperva(Incapsula) 방화벽 차단 페이지 감지. 인증 오류와 구분하기 위함. */
function checkWafBlock(res, text, label) {
  if (text.slice(0, 3000).includes('Incapsula') && (res.status >= 400 || text.includes('Incapsula incident'))) {
    throw new BotError(
      `${label}: 웰스토리 방화벽(Incapsula)이 요청 차단 (HTTP ${res.status}). 아이디/비번 문제가 아님`,
    );
  }
}

class WelstoryClient {
  constructor(username, password, debug = false) {
    this.username = username;
    this.password = password;
    this.debug = debug;
    this.token = null;
    this.baseHeaders = { 'User-Agent': 'Welplus', 'X-Device-Id': randomUUID() };
  }

  async login() {
    const { res, text } = await fetchWithRetry(`${BASE_URL}/login`, {
      method: 'POST',
      headers: {
        ...this.baseHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Autologin': 'N',
      },
      body: new URLSearchParams({
        username: this.username,
        password: this.password,
        'remember-me': 'false',
      }).toString(),
    }, { label: '로그인' });
    checkWafBlock(res, text, '로그인');
    const token = res.headers.get('authorization');
    if (!token) {
      let message = text.slice(0, 200);
      try { message = JSON.parse(text).message ?? message; } catch { /* JSON 아니면 원문 */ }
      throw new AuthOrApiError(`로그인 실패 (HTTP ${res.status}): ${message}`);
    }
    this.token = token;
    log(`로그인 성공 (토큰 길이 ${token.length})`);
  }

  async call(method, path, { params, jsonBody, headers } = {}) {
    if (!this.token) throw new BotError('로그인 전에 API 호출');
    const url = new URL(path, BASE_URL);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    const opts = {
      method,
      headers: { ...this.baseHeaders, Authorization: this.token, ...headers },
    };
    if (jsonBody !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(jsonBody);
    }
    const { res, text } = await fetchWithRetry(url, opts, { label: path });
    checkWafBlock(res, text, path);

    const body = text.trim();
    if (!body) {
      throw new AuthOrApiError(`${path}: 빈 응답 (HTTP ${res.status}) → 인증 실패 또는 API 변경`);
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new AuthOrApiError(
        `${path}: JSON이 아닌 응답 (HTTP ${res.status}, Content-Type=${res.headers.get('content-type')}) `
        + `→ 인증 실패 또는 API 변경. 앞부분: ${JSON.stringify(body.slice(0, 200))}`,
      );
    }
    if (this.debug) {
      log(`[debug] ${method} ${path} params=${JSON.stringify(params ?? {})} →\n${JSON.stringify(payload, null, 2)}`);
    }
    if (res.status >= 400) throw new BotError(`${path}: HTTP ${res.status} - ${body.slice(0, 300)}`);
    if (payload === null || typeof payload !== 'object' || !('data' in payload)) {
      throw new AuthOrApiError(`${path}: 응답에 data 필드 없음 → API 변경 가능성. 앞부분: ${body.slice(0, 300)}`);
    }
    return payload.data;
  }

  async myRestaurants() {
    return (await this.call('GET', '/api/mypage/rest-my-list')) ?? [];
  }

  async searchRestaurants(name) {
    return (await this.call('GET', '/api/mypage/rest-list', { params: { restaurantName: name } })) ?? [];
  }

  async registerRestaurant(code, orderSeq) {
    await this.call('POST', '/api/mypage/rest-regi', {
      jsonBody: [{ mainDiv: 'N', restaurantId: code, orderSeq }],
    });
  }

  async lunchMealType(restaurantCode) {
    const items = (await this.call('GET', '/api/menu/getMealTimeList', {
      headers: { Cookie: `cafeteriaActiveId=${restaurantCode}` },
    })) ?? [];
    // 실제 응답은 '점심' (명세는 '중식'), 둘 다 허용
    const lunch = items.find((it) => /중식|점심/.test(String(it.codeNm ?? '')));
    if (!lunch) throw new AuthOrApiError(`식사 시간 목록에 '중식/점심' 없음: ${JSON.stringify(items.map((i) => i.codeNm))}`);
    return String(lunch.code);
  }

  async meals(dayKey, mealType, restaurantCode) {
    const data = await this.call('GET', '/api/meal', {
      params: { menuDt: dayKey, menuMealType: mealType, restaurantCode },
    });
    if (data == null) return [];
    if (typeof data !== 'object' || Array.isArray(data)) {
      throw new AuthOrApiError(`/api/meal: data가 객체가 아님: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return data.mealList ?? [];
  }
}

// ---------------- 식당 결정 ----------------
const nameOf = (r) => String(r.restaurantName ?? r.restaurantNm ?? '');

async function resolveRestaurant(client, code, name) {
  const mine = await client.myRestaurants();
  const myIds = new Set(mine.map((r) => String(r.restaurantId)));
  log(`내 식당 목록: ${JSON.stringify(mine.map((r) => [r.restaurantId, nameOf(r)]))}`);

  let target = code;
  if (!target) {
    if (name) {
      const hit = mine.filter((r) => nameOf(r).includes(name));
      if (hit.length === 1) {
        log(`내 식당 목록에서 '${name}' 찾음`);
        return String(hit[0].restaurantId);
      }
    } else if (mine.length > 0) {
      log('RESTAURANT_CODE/NAME 없음 → 내 식당 목록 첫 번째 사용');
      return String(mine[0].restaurantId);
    } else {
      throw new BotError('RESTAURANT_CODE 또는 RESTAURANT_NAME을 설정해야 함 (내 식당 목록 비어 있음)');
    }

    const results = await client.searchRestaurants(name);
    const exact = results.filter((r) => nameOf(r) === name);
    const cands = exact.length > 0 ? exact : results;
    if (cands.length !== 1) {
      const listing = JSON.stringify(results.map((r) => [r.restaurantCode, nameOf(r)]));
      throw new BotError(
        `'${name}' 검색 결과가 ${cands.length}개라 하나로 못 정함: ${listing}. `
        + 'RESTAURANT_NAME을 정확히 쓰거나 RESTAURANT_CODE를 지정',
      );
    }
    target = String(cands[0].restaurantCode);
    log(`검색으로 식당 찾음: ${target} ${nameOf(cands[0])}`);
  }

  if (!myIds.has(target)) {
    log(`계정에 ${target} 미등록 → 등록 (orderSeq=${mine.length + 1})`);
    await client.registerRestaurant(target, mine.length + 1);
  }
  return target;
}

// ---------------- 메시지 ----------------
function photoUrl(m) {
  return m.photoUrl && m.photoCd ? `${m.photoUrl}${m.photoCd}` : null;
}

const text = (v) => (v == null ? '' : String(v).trim());

function buildPayload(day, meals) {
  const attachments = meals.map((m) => {
    const title = [text(m.courseTxt), text(m.menuName)].filter(Boolean).join(' · ') || '메뉴';
    // 실제 응답: kcal = 메인 메뉴만, sumKcal = 코스 전체 ("1,020" 같은 문자열). 코스 전체 우선, 0은 정보 없음 취급
    const kcal = [text(m.sumKcal), text(m.kcal)].find((v) => v && v !== '0') ?? '';
    const att = {
      fallback: title,
      color: '#2E7D32',
      title,
      text: text(m.subMenuTxt) || '(세부 메뉴 정보 없음)',
    };
    // "[라면 14종 중 택1]" 같은 선택형 코스는 sumKcal이 전 품목 합계라 의미 없음 → 칼로리 표시 안 함
    if (!/택\s*1/.test(text(m.menuName))) {
      att.fields = [{ short: true, title: '칼로리', value: kcal ? `${kcal} kcal` : '정보 없음' }];
    }
    const url = photoUrl(m);
    if (url) att.image_url = url;
    return att;
  });

  let header = `#### 🍚 ${day.month}월 ${day.day}일 (${WEEKDAYS[day.weekday]}) 점심`;
  const noPhoto = meals.filter((m) => !photoUrl(m)).length;
  if (noPhoto) header += `\n_사진 없는 코스 ${noPhoto}개_`;
  return { text: header, attachments };
}

async function sendToMattermost(webhookUrl, payload) {
  const { res, text: body } = await fetchWithRetry(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  }, { label: 'Mattermost 웹훅', retryTimeout: false });
  if (res.status !== 200) throw new BotError(`Mattermost 전송 실패: HTTP ${res.status} - ${body.slice(0, 200)}`);
  log('Mattermost 전송 완료');
}

// ---------------- 메인 ----------------
/** KEY=VALUE 형식 .env 읽기. 이미 설정된 환경변수(Actions Secrets 등)는 덮어쓰지 않음. */
function loadDotenv(path) {
  if (!existsSync(path)) return;
  for (let line of readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && `'"`.includes(value[0])) value = value.slice(1, -1);
    if (value && !process.env[key]) process.env[key] = value;
  }
}

function env(name, required = true) {
  const v = (process.env[name] ?? '').trim() || null;
  if (required && !v) throw new BotError(`환경변수 ${name} 없음`);
  return v;
}

/** YYYYMMDD → { year, month, day, weekday, key }. 없으면 오늘(KST). */
function resolveDay(arg) {
  let y, m, d;
  if (arg) {
    if (!/^\d{8}$/.test(arg)) throw new BotError(`--date 형식 오류: ${arg} (YYYYMMDD)`);
    [y, m, d] = [+arg.slice(0, 4), +arg.slice(4, 6), +arg.slice(6, 8)];
  } else {
    const t = nowKst();
    [y, m, d] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  }
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { year: y, month: m, day: d, weekday, key: `${y}${pad(m)}${pad(d)}` };
}

async function run(args) {
  const username = env('WELSTORY_USERNAME');
  const password = env('WELSTORY_PASSWORD');
  const webhook = args['dry-run'] ? null : env('MM_WEBHOOK_URL');
  const day = resolveDay(args.date);
  const marker = args['sent-marker'];

  // 하루 한 번만 전송: 마커 파일에 날짜가 있으면 건너뜀
  if (!args['dry-run'] && marker && existsSync(marker) && readFileSync(marker, 'utf8').trim() === day.key) {
    log(`${day.key} 이미 전송됨 (마커 ${marker}) → 종료`);
    return 0;
  }

  const client = new WelstoryClient(username, password, args.debug);
  await client.login();
  const code = await resolveRestaurant(client, env('RESTAURANT_CODE', false), env('RESTAURANT_NAME', false));
  const mealType = await client.lunchMealType(code);
  log(`식당 코드=${code}, 중식 code=${mealType}, 날짜=${day.key}`);

  // 마감 시각(KST)의 실제 epoch ms
  const deadline = Date.UTC(day.year, day.month - 1, day.day, ...DEADLINE_HM) - KST_OFFSET_MS;
  const wait = !(args['dry-run'] || args['no-wait']);
  const halls = (env('HALL_NO', false) ?? DEFAULT_HALL_NO).split(',').map((s) => s.trim()).filter(Boolean);
  let meals;
  for (;;) {
    try {
      meals = await client.meals(day.key, mealType, code);
    } catch (e) {
      if (!(e instanceof AuthOrApiError)) throw e;
      log(`식단 조회 실패, 재로그인 후 재시도: ${e.message}`); // 대기 중 토큰 만료 대비
      await client.login();
      meals = await client.meals(day.key, mealType, code);
    }

    if (meals.length === 0) {
      log('식단 없음 (주말/휴일) → 전송 없이 종료');
      return 0;
    }
    // 점심 코스 홀만 (테이크아웃/코인 메뉴 제외). 필터 후 0개면 홀 코드가 바뀐 것 → 조용히 넘어가지 않고 실패
    const all = meals;
    meals = all.filter((m) => halls.includes(String(m.hallNo)));
    if (meals.length === 0) {
      const found = [...new Set(all.map((m) => m.hallNo))];
      throw new BotError(`HALL_NO=${halls.join(',')} 에 해당하는 코스 없음. 응답에 있는 홀: ${JSON.stringify(found)}`);
    }
    const missing = meals.filter((m) => !photoUrl(m)).length;
    log(`코스 ${meals.length}개, 사진 없는 코스 ${missing}개`);
    const now = Date.now();
    if (missing === 0 || !wait || now >= deadline) break;
    const sleepMs = Math.min(POLL_INTERVAL_MS, deadline - now);
    log(`사진 대기: ${Math.round(sleepMs / 1000)}초 후 재조회 (마감 ${DEADLINE_HM.map(pad).join(':')})`);
    await sleep(sleepMs);
  }

  const payload = buildPayload(day, meals);
  if (args['dry-run']) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  await sendToMattermost(webhook, payload);
  if (marker) writeFileSync(marker, day.key, 'utf8');
  return 0;
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false }, // 전송하지 않고 payload만 출력 (사진 대기 없음)
      debug: { type: 'boolean', default: false },     // 웰스토리 API 원본 응답 출력
      'no-wait': { type: 'boolean', default: false }, // 사진 대기 없이 즉시 전송
      date: { type: 'string' },                       // 조회 날짜 YYYYMMDD (기본: 오늘 KST)
      'sent-marker': { type: 'string' },              // 전송 기록 파일 (같은 날 중복 전송 방지)
    },
  });
  loadDotenv(join(dirname(fileURLToPath(import.meta.url)), '.env'));
  try {
    return await run(args);
  } catch (e) {
    if (e instanceof BotError) {
      log(`오류: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

export { WelstoryClient, buildPayload, resolveDay, loadDotenv };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
