# SSAFY 점심 식단 Mattermost 봇

평일 오전, 웰스토리(웰플러스)에서 오늘 점심 메뉴를 가져와 Mattermost 채널에 표 한 장으로 올립니다.
GitHub Actions에서 돌아가므로 서버가 필요 없습니다. 외부 패키지 없이 Node 20 내장 기능만 씁니다.

```
## :shark_food: 2026-11-11 점심 메뉴 :food-fried-egg:
| (사진) | (사진) | (사진) | ...
| **브라운그릴** | **동방식객** | **별미공방** | ...
| 연어구이&브로콜리,컬리플라워 (925kcal) | 수엔_유니자장면 (1,020kcal) | ...
| 캘리포이나라이스 / 호밀브레드 / ... | 짬뽕국 / 만두튀김&간장 / 단무지 | ...
```

## 빠른 설정 (약 10분)

1. 이 레포를 본인 계정에 복사합니다 (private 권장).
   - 추천: **Use this template → Create a new repository**. 원본과 연결이 끊긴 독립 레포가 됩니다.
   - 포크도 되지만, private 레포의 포크는 원본이 지워지거나 접근 권한이 빠지면 같이 사라집니다.
2. Mattermost에서 보낼 채널의 **웹훅 URL**을 만듭니다 → [웹훅 만들기](#mattermost-웹훅-만들기)
3. 레포 **Settings → Secrets and variables → Actions → New repository secret**에 아래 값을 넣습니다.
   - `WELSTORY_USERNAME`, `WELSTORY_PASSWORD`, `MM_WEBHOOK_URL` (필수)
   - 나머지는 [설정값](#설정값) 참고
4. **Actions** 탭에서 워크플로를 켭니다. 복사한 레포는 Actions가 꺼져 있을 수 있습니다.
   - "I understand my workflows, go ahead and enable them" 버튼이 보이면 누릅니다.
   - **Lunch menu**가 Disabled면 **Enable workflow**를 누릅니다.
   - `gh` CLI: `gh workflow enable lunch.yml`
5. **Actions → Lunch menu → Run workflow**에서 `dry_run` 체크 후 실행 → 로그에 메뉴 표가 나오면 성공
6. 이제 평일 11:30(KST)마다 자동으로 올라갑니다.

`gh` CLI를 쓴다면 3번은 `.env` 파일로 한 번에 넣을 수 있습니다. 값이 빈 줄은 지우고 실행하세요.

```sh
gh secret set -f .env
gh workflow run lunch.yml -f dry_run=true
```

### 처음 켜는 날

- **11:30 전에 켜면 그날부터 돕니다.** 예: 오전 10시에 켜면 그날 11:30 정기 실행부터 올라갑니다.
- **켜기 전에 Secrets 3개를 먼저 넣습니다.** `gh secret list`로 `WELSTORY_USERNAME`, `WELSTORY_PASSWORD`, `MM_WEBHOOK_URL`이 있는지 확인하세요. 없으면 11:30 실행이 실패합니다.
- **켠 직후 `dry_run`으로 한 번 돌려봅니다.** `dry_run`은 전송 기록을 남기지 않으므로 그날 11:30 실제 전송에 영향이 없습니다.
- **첫날은 11:45쯤 Actions 탭을 확인합니다.** 막 만든 레포는 첫 정기 실행이 늦거나 빠지는 경우가 있습니다. 안 돌았으면 수동으로 바로 보냅니다.
  ```sh
  gh workflow run lunch.yml -f no_wait=true
  ```
  수동으로 보낸 뒤에 정기 실행이 늦게 돌아도, 하루 1회 기록 때문에 중복으로 올라가지 않습니다.
- **11:30 이후에 켰다면** 그날 정기 실행은 이미 지나갔으니 위 수동 실행으로 보냅니다.

## Mattermost 웹훅 만들기

1. Mattermost 왼쪽 위 메뉴(☰) → **통합(Integrations)** → **Incoming Webhooks** → **Add Incoming Webhook**
2. 제목 입력, 보낼 **채널** 선택 → 저장
3. 나온 `https://meeting.ssafy.com/hooks/xxxxxxxx` 주소를 복사

- 채널 주소(`.../channels/채널이름`)가 아니라 `/hooks/`가 들어간 주소여야 합니다.
- **여러 채널에 보내려면** 웹훅을 채널마다 만들고 쉼표로 이어서 한 값으로 넣습니다.
  `https://meeting.ssafy.com/hooks/aaa,https://meeting.ssafy.com/hooks/bbb`
- 웹훅 URL을 알면 누구나 그 채널에 글을 쓸 수 있습니다. Secrets에만 넣고 공유하지 마세요.
- 통합 메뉴가 안 보이면 그 팀에서 일반 사용자의 웹훅 생성이 막혀 있는 것입니다. 팀 관리자에게 요청하세요.

## 설정값

GitHub Actions에서는 Secrets로, 로컬에서는 `.env` 파일로 넣습니다 (`.env.example` 참고).

| 이름 | 필수 | 설명 |
|---|---|---|
| `WELSTORY_USERNAME` | 필수 | 웰플러스 앱 아이디 |
| `WELSTORY_PASSWORD` | 필수 | 웰플러스 앱 비밀번호 |
| `MM_WEBHOOK_URL` | 전송 시 필수 | 웹훅 URL. 여러 개면 쉼표로 구분 |
| `RESTAURANT_CODE` | 선택 | 식당 코드 (예: `REST000595` 전기부산). 우선 적용 |
| `RESTAURANT_NAME` | 선택 | 식당 이름으로 검색 (예: `멀티캠퍼스`). 결과가 여럿이면 후보를 로그에 출력하고 멈춤 |
| `HALL_NO` | 선택 | 보낼 코스의 홀 코드. 기본 `E32M` (점심 코스 6개, 테이크아웃/코인 메뉴 제외) |

식당을 둘 다 비우면 웰플러스 계정의 "내 식당" 첫 번째를 씁니다. 지정한 식당이 계정에 없으면 자동으로 등록합니다.

## 동작 방식

- **실행 시각:** 평일 11:30 KST (cron `30 2 * * 1-5`, UTC 기준). 수동 실행도 가능합니다.
- **사진 대기:** 사진은 보통 11시 전후에 올라옵니다. 5분마다 다시 조회해서 모든 코스에 사진이 생기면 바로 보냅니다.
  11:40까지 안 생기면 있는 사진만 넣어 보냅니다. 11:40 이후에 시작되면 기다리지 않고 바로 보냅니다.
- **하루 한 번:** 웹훅마다 "오늘 보냄" 기록을 Actions 캐시에 남깁니다. 같은 날 다시 실행해도 이미 보낸 채널은 건너뛰고, 실패한 채널에만 다시 보냅니다.
  정기 실행과 수동 실행이 겹치면 하나씩 차례로 실행됩니다.
- **주말/휴일:** 메뉴가 없으면 아무것도 보내지 않고 정상 종료합니다.
- **표 내용:** 사진 / 코스명 / 메인 메뉴(코스 전체 칼로리) / 반찬. 라면 같은 선택형 코스("택1")는 칼로리를 빼고, 라면 종류 대신 토핑 목록만 보여줍니다.

### 알아둘 점

- **cron은 늦게 시작될 수 있습니다.** GitHub Actions 정기 실행은 수 분~수십 분 늦는 경우가 흔하고, 혼잡하면 건너뛰기도 합니다. 꼭 올라가야 하는 날은 Actions 탭에서 확인하고, 안 돌았으면 수동 실행하세요.
- **Actions 사용 시간:** 사진을 기다리는 동안에도 실행 시간이 쌓입니다. 정기 실행은 11:30 시작이라 대기가 최대 약 10분이고, 하루 약 10분 × 평일 22일 ≈ 월 220분입니다.
  private 레포 무료 한도(월 2,000분, GitHub Free 기준)를 다른 작업과 나눠 쓰니 확인하세요. public 레포는 무료입니다.
- **public 레포는 60일 동안 커밋이 없으면 정기 실행이 자동으로 꺼집니다.** GitHub에서 메일이 오면 Actions 탭에서 다시 켜세요. private 레포는 해당 없습니다.
- **왜 Python이 아니라 Node인가:** 웰스토리 로그인 경로 앞단의 방화벽(Imperva Incapsula)이 Python `requests` 요청을 403으로 막습니다. 같은 요청을 Node 내장 `fetch`와 curl로 보내면 통과합니다.

## 로컬 실행

Node 20 이상이 필요합니다. 설치할 패키지는 없습니다.

```sh
cp .env.example .env        # 값 채우기
node lunch_bot.mjs --dry-run            # 전송 없이 payload만 출력
node lunch_bot.mjs --dry-run --debug    # 웰스토리 API 원본 응답까지 출력
node lunch_bot.mjs --no-wait            # 사진 기다리지 않고 바로 전송
```

| 옵션 | 설명 |
|---|---|
| `--dry-run` | 보내지 않고 Mattermost payload(JSON)만 출력. 사진 대기 없음 |
| `--debug` | 웰스토리 API 응답 원문을 로그에 출력 |
| `--no-wait` | 사진 대기 없이 바로 전송 |
| `--date YYYYMMDD` | 다른 날짜 조회 (기본: 오늘 KST) |
| `--sent-marker 파일` | 전송 기록 파일. 같은 날 같은 웹훅으로 두 번 보내지 않음 |

로그는 stderr, payload는 stdout으로 나옵니다. 비밀번호, 토큰, 웹훅 URL은 로그에 찍지 않습니다 (웹훅은 해시 8자리로 표시).

## 장애 시 확인할 점

먼저 **Actions 탭 → 실패한 실행 → `식단 조회 및 전송` 단계 로그**의 `오류:` 줄을 봅니다.

| 로그 | 원인 | 조치 |
|---|---|---|
| `환경변수 ... 없음` | Secret 미등록 또는 이름 오타 | Settings → Secrets에서 이름 확인 |
| `로그인 실패 (HTTP 200): 아이디/비밀번호를 확인해주세요.` | 계정 정보 틀림 | 웰플러스 앱으로 로그인되는지 확인 후 Secret 수정 |
| `방화벽(Incapsula)이 요청 차단` | 웰스토리 방화벽이 실행 환경을 막음 | 잠시 후 수동 재실행. 계속되면 웰스토리 쪽 정책 변경 |
| `빈 응답 → 인증 실패 또는 API 변경` / `JSON이 아닌 응답` | 토큰이 안 먹히거나 API 주소/형식 변경 | `dry_run`으로 실행해 `--debug` 로그 확인 |
| `식사 시간 목록에 '중식/점심' 없음` | 식사 시간 이름 변경 | 로그에 찍힌 이름 목록 확인 후 코드 수정 |
| `HALL_NO=... 에 해당하는 코스 없음. 응답에 있는 홀: [...]` | 식당 홀 코드 변경 | 로그의 홀 목록을 보고 `HALL_NO` Secret 설정 |
| `'...' 검색 결과가 N개라 하나로 못 정함` | `RESTAURANT_NAME`이 모호함 | 로그의 후보 중 코드를 골라 `RESTAURANT_CODE`에 설정 |
| `MM_WEBHOOK_URL 형식 오류` | 채널 주소를 넣었거나 오타 | `/hooks/`가 들어간 웹훅 주소인지 확인 |
| `웹훅 xxxxxxxx ... 실패: HTTP 4xx` | 웹훅이 삭제/비활성화됨 | Mattermost 통합 메뉴에서 웹훅 확인 |
| 실행 기록 자체가 없음 | cron 지연/누락, 또는 workflow 비활성화 | Actions 탭에서 수동 실행. 워크플로가 Disabled면 Enable |
| 성공했는데 메시지 없음 | 휴일이라 메뉴 없음 (`식단 없음` 로그) | 정상 |

같은 날 실수로 두 번 보내야 하면 수동 실행에서 `force`를 체크합니다. 이미 보낸 채널에도 다시 올라갑니다.
