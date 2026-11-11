#!/usr/bin/env python3
"""SSAFY 점심(중식) 식단을 Mattermost에 올리는 봇. 웰스토리 API를 직접 호출한다.

환경변수:
  WELSTORY_USERNAME, WELSTORY_PASSWORD  (필수)
  MM_WEBHOOK_URL                        (실제 전송 시 필수, --dry-run이면 불필요)
  RESTAURANT_CODE, RESTAURANT_NAME      (선택)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from datetime import date, datetime, timedelta, timezone

import requests

BASE_URL = "https://welplus.welstory.com"
KST = timezone(timedelta(hours=9))  # 한국은 DST 없음 → 고정 오프셋 (Windows tzdata 불필요)
TIMEOUT = 15            # 초, 모든 요청 공통
RETRIES = 3             # 네트워크 오류/5xx 재시도 횟수
POLL_INTERVAL = 300     # 사진 대기 중 재조회 간격 (5분)
DEADLINE_HM = (11, 40)  # 이 시각(KST)까지 사진 없으면 있는 것만으로 전송
WEEKDAYS = "월화수목금토일"


class BotError(Exception):
    """정상 종료할 수 없는 오류."""


class AuthOrApiError(BotError):
    """빈 본문 / JSON 아님 / 구조 다름 → 인증 실패 또는 API 변경."""


def log(msg: str) -> None:
    print(f"[{datetime.now(KST):%H:%M:%S}] {msg}", file=sys.stderr, flush=True)


def request_with_retry(session: requests.Session, method: str, url: str, *,
                       label: str, retry_read_timeout: bool = True,
                       **kwargs) -> requests.Response:
    """timeout + 짧은 재시도. 4xx와 정상 응답은 그대로 반환, 네트워크 오류/5xx만 재시도."""
    kwargs.setdefault("timeout", TIMEOUT)
    last_err: object = None
    for attempt in range(1, RETRIES + 1):
        try:
            resp = session.request(method, url, **kwargs)
        except requests.ReadTimeout as e:
            # 서버가 이미 처리했을 수 있는 요청(웹훅 전송)은 중복 방지를 위해 재시도하지 않음
            if not retry_read_timeout:
                raise BotError(f"{label}: 응답 대기 시간 초과 (중복 방지를 위해 재시도 안 함): {e}")
            last_err = e
        except (requests.ConnectionError, requests.Timeout) as e:
            last_err = e
        else:
            if resp.status_code < 500:
                return resp
            last_err = f"HTTP {resp.status_code}"
        log(f"{label}: 실패 ({attempt}/{RETRIES}) - {last_err}")
        if attempt < RETRIES:
            time.sleep(2 * attempt)
    raise BotError(f"{label}: {RETRIES}회 시도 모두 실패 - {last_err}")


def check_waf_block(resp: requests.Response, label: str) -> None:
    """웰스토리 앞단 Imperva(Incapsula) 방화벽 차단 페이지 감지. 인증 오류와 구분하기 위함."""
    if "Incapsula" in resp.text[:3000] or resp.headers.get("X-Iinfo"):
        if resp.status_code >= 400 or "Incapsula incident" in resp.text:
            raise BotError(
                f"{label}: 웰스토리 방화벽(Incapsula)이 요청 차단 (HTTP {resp.status_code}). "
                "아이디/비번 문제가 아님. 실행 IP/요청 형태가 막힌 것"
            )


class WelstoryClient:
    def __init__(self, username: str, password: str, debug: bool = False):
        self.username = username
        self.password = password
        self.debug = debug
        self.token: str | None = None
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Welplus",
            "X-Device-Id": str(uuid.uuid4()),
        })

    # ---- 저수준 ----
    def login(self) -> None:
        resp = request_with_retry(
            self.session, "POST", f"{BASE_URL}/login", label="로그인",
            headers={"Content-Type": "application/x-www-form-urlencoded", "X-Autologin": "N"},
            data={"username": self.username, "password": self.password, "remember-me": "false"},
        )
        check_waf_block(resp, "로그인")
        token = resp.headers.get("Authorization")
        if not token:
            raise AuthOrApiError(
                f"로그인 실패: 응답 헤더에 Authorization 없음 (HTTP {resp.status_code}). "
                f"아이디/비밀번호 확인. 응답 앞부분: {resp.text[:200]!r}"
            )
        self.token = token
        log(f"로그인 성공 (토큰 길이 {len(token)})")

    def _call(self, method: str, path: str, *, params=None, json_body=None, headers=None):
        if not self.token:
            raise BotError("로그인 전에 API 호출")
        h = {"Authorization": self.token}
        h.update(headers or {})
        resp = request_with_retry(
            self.session, method, f"{BASE_URL}{path}", label=path,
            params=params, json=json_body, headers=h,
        )
        check_waf_block(resp, path)
        body = resp.text.strip()
        if not body:
            raise AuthOrApiError(
                f"{path}: 빈 응답 (HTTP {resp.status_code}) → 인증 실패 또는 API 변경"
            )
        try:
            payload = resp.json()
        except ValueError:
            raise AuthOrApiError(
                f"{path}: JSON이 아닌 응답 (HTTP {resp.status_code}, "
                f"Content-Type={resp.headers.get('Content-Type')}) → 인증 실패 또는 API 변경. "
                f"앞부분: {body[:200]!r}"
            ) from None
        if self.debug:
            log(f"[debug] {method} {path} params={params} →\n"
                + json.dumps(payload, ensure_ascii=False, indent=2))
        if resp.status_code >= 400:
            raise BotError(f"{path}: HTTP {resp.status_code} - {body[:300]}")
        if not isinstance(payload, dict) or "data" not in payload:
            raise AuthOrApiError(
                f"{path}: 응답에 data 필드 없음 → API 변경 가능성. 앞부분: {body[:300]!r}"
            )
        return payload["data"]

    # ---- API ----
    def my_restaurants(self) -> list[dict]:
        return self._call("GET", "/api/mypage/rest-my-list") or []

    def search_restaurants(self, name: str) -> list[dict]:
        return self._call("GET", "/api/mypage/rest-list", params={"restaurantName": name}) or []

    def register_restaurant(self, code: str, order_seq: int) -> None:
        self._call("POST", "/api/mypage/rest-regi",
                   json_body=[{"mainDiv": "N", "restaurantId": code, "orderSeq": order_seq}])

    def lunch_meal_type(self, restaurant_code: str) -> str:
        items = self._call("GET", "/api/menu/getMealTimeList",
                           headers={"Cookie": f"cafeteriaActiveId={restaurant_code}"}) or []
        for it in items:
            if "중식" in str(it.get("codeNm", "")):
                return str(it["code"])
        names = [it.get("codeNm") for it in items]
        raise AuthOrApiError(f"식사 시간 목록에 '중식' 없음: {names}")

    def meals(self, day: date, meal_type: str, restaurant_code: str) -> list[dict]:
        data = self._call("GET", "/api/meal", params={
            "menuDt": day.strftime("%Y%m%d"),
            "menuMealType": meal_type,
            "restaurantCode": restaurant_code,
        })
        if data is None:
            return []
        if not isinstance(data, dict):
            raise AuthOrApiError(f"/api/meal: data가 객체가 아님: {str(data)[:200]!r}")
        return data.get("mealList") or []


# ---------------- 식당 결정 ----------------
def _name_of(r: dict) -> str:
    return str(r.get("restaurantName") or r.get("restaurantNm") or "")


def resolve_restaurant(client: WelstoryClient, code: str | None, name: str | None) -> str:
    mine = client.my_restaurants()
    my_ids = {str(r.get("restaurantId")) for r in mine}
    log(f"내 식당 목록: {[(r.get('restaurantId'), _name_of(r)) for r in mine]}")

    if code:
        target = code
    else:
        if name:
            hit = [r for r in mine if name in _name_of(r)]
            if len(hit) == 1:
                log(f"내 식당 목록에서 '{name}' 찾음")
                return str(hit[0]["restaurantId"])
        elif mine:
            log("RESTAURANT_CODE/NAME 없음 → 내 식당 목록 첫 번째 사용")
            return str(mine[0]["restaurantId"])
        else:
            raise BotError("RESTAURANT_CODE 또는 RESTAURANT_NAME을 설정해야 함 (내 식당 목록 비어 있음)")

        results = client.search_restaurants(name)
        exact = [r for r in results if _name_of(r) == name]
        cands = exact or results
        if len(cands) != 1:
            listing = [(r.get("restaurantCode"), _name_of(r)) for r in results]
            raise BotError(f"'{name}' 검색 결과가 {len(cands)}개라 하나로 못 정함: {listing}. "
                           "RESTAURANT_NAME을 정확히 쓰거나 RESTAURANT_CODE를 지정")
        target = str(cands[0]["restaurantCode"])
        log(f"검색으로 식당 찾음: {target} {_name_of(cands[0])}")

    if target not in my_ids:
        log(f"계정에 {target} 미등록 → 등록 (orderSeq={len(mine) + 1})")
        client.register_restaurant(target, len(mine) + 1)
    return target


# ---------------- 메시지 ----------------
def photo_url(m: dict) -> str | None:
    url, cd = m.get("photoUrl"), m.get("photoCd")
    return f"{url}{cd}" if url and cd else None


def _text(v) -> str:
    return "" if v is None else str(v).strip()


def build_payload(day: date, meals: list[dict]) -> dict:
    attachments = []
    for m in meals:
        course, main = _text(m.get("courseTxt")), _text(m.get("menuName"))
        title = " · ".join(p for p in (course, main) if p) or "메뉴"
        kcal = _text(m.get("kcal"))
        att = {
            "fallback": title,
            "color": "#2E7D32",
            "title": title,
            "text": _text(m.get("subMenuTxt")) or "(세부 메뉴 정보 없음)",
            "fields": [{"short": True, "title": "칼로리",
                        "value": f"{kcal} kcal" if kcal else "정보 없음"}],
        }
        url = photo_url(m)
        if url:
            att["image_url"] = url
        attachments.append(att)

    header = f"#### 🍚 {day.month}월 {day.day}일 ({WEEKDAYS[day.weekday()]}) 점심"
    no_photo = sum(1 for m in meals if not photo_url(m))
    if no_photo:
        header += f"\n_사진 없는 코스 {no_photo}개_"
    return {"text": header, "attachments": attachments}


def send_to_mattermost(webhook_url: str, payload: dict) -> None:
    resp = request_with_retry(
        requests.Session(), "POST", webhook_url, label="Mattermost 웹훅",
        retry_read_timeout=False,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    if resp.status_code != 200:
        raise BotError(f"Mattermost 전송 실패: HTTP {resp.status_code} - {resp.text[:200]}")
    log("Mattermost 전송 완료")


# ---------------- 메인 ----------------
def load_dotenv(path: str) -> None:
    """KEY=VALUE 형식 .env 읽기. 이미 설정된 환경변수(Actions Secrets 등)는 덮어쓰지 않음."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            if value and not os.environ.get(key):
                os.environ[key] = value


def env(name: str, required: bool = True) -> str | None:
    v = os.environ.get(name, "").strip() or None
    if required and not v:
        raise BotError(f"환경변수 {name} 없음")
    return v


def run(args: argparse.Namespace) -> int:
    username, password = env("WELSTORY_USERNAME"), env("WELSTORY_PASSWORD")
    webhook = None if args.dry_run else env("MM_WEBHOOK_URL")
    day = datetime.strptime(args.date, "%Y%m%d").date() if args.date else datetime.now(KST).date()
    day_key = day.strftime("%Y%m%d")

    # 하루 한 번만 전송: 마커 파일에 날짜가 있으면 건너뜀
    if not args.dry_run and args.sent_marker and os.path.exists(args.sent_marker):
        with open(args.sent_marker, encoding="utf-8") as f:
            if f.read().strip() == day_key:
                log(f"{day_key} 이미 전송됨 (마커 {args.sent_marker}) → 종료")
                return 0

    client = WelstoryClient(username, password, debug=args.debug)
    client.login()
    code = resolve_restaurant(client, env("RESTAURANT_CODE", False), env("RESTAURANT_NAME", False))
    meal_type = client.lunch_meal_type(code)
    log(f"식당 코드={code}, 중식 code={meal_type}, 날짜={day_key}")

    deadline = datetime(day.year, day.month, day.day, *DEADLINE_HM, tzinfo=KST)
    wait = not (args.dry_run or args.no_wait)
    while True:
        try:
            meals = client.meals(day, meal_type, code)
        except AuthOrApiError as e:  # 대기 중 토큰 만료 대비: 재로그인 1회
            log(f"식단 조회 실패, 재로그인 후 재시도: {e}")
            client.login()
            meals = client.meals(day, meal_type, code)

        if not meals:
            log("식단 없음 (주말/휴일) → 전송 없이 종료")
            return 0

        missing = sum(1 for m in meals if not photo_url(m))
        log(f"코스 {len(meals)}개, 사진 없는 코스 {missing}개")
        now = datetime.now(KST)
        if missing == 0 or not wait or now >= deadline:
            break
        sleep_s = min(POLL_INTERVAL, (deadline - now).total_seconds())
        log(f"사진 대기: {int(sleep_s)}초 후 재조회 (마감 {deadline:%H:%M})")
        time.sleep(sleep_s)

    payload = build_payload(day, meals)
    if args.dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    send_to_mattermost(webhook, payload)
    if args.sent_marker:
        with open(args.sent_marker, "w", encoding="utf-8") as f:
            f.write(day_key)
    return 0


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description="SSAFY 점심 식단 Mattermost 봇")
    p.add_argument("--dry-run", action="store_true", help="전송하지 않고 payload만 출력 (사진 대기 없음)")
    p.add_argument("--debug", action="store_true", help="웰스토리 API 원본 응답 출력")
    p.add_argument("--no-wait", action="store_true", help="사진 대기 없이 즉시 전송")
    p.add_argument("--date", help="조회 날짜 YYYYMMDD (기본: 오늘 KST)")
    p.add_argument("--sent-marker", help="전송 기록 파일 경로 (같은 날 중복 전송 방지)")
    args = p.parse_args()
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
    try:
        return run(args)
    except BotError as e:
        log(f"오류: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
