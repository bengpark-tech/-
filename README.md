# GRANDSUN 태양광 종합 사업성 시뮬레이터 (서버 버전)

사용자가 시뮬레이터를 쓰고 **보고서를 생성하면 서버에 이력이 저장**되고,
**관리자가 로그인해서 모든 사용자의 이력**(사용자 이름·접속 IP·시뮬레이터 기초정보)을 조회·삭제·CSV로 내려받습니다.

## 실행

Node.js **22.13 이상**이 필요합니다. 별도 패키지 설치는 없습니다(내장 `node:sqlite` 사용).

```bash
# Windows PowerShell
$env:ADMIN_PASSWORD = "관리자-비밀번호"
node server.js

# macOS / Linux
ADMIN_PASSWORD='관리자-비밀번호' node server.js
```

브라우저에서 http://127.0.0.1:3000 을 엽니다. 상단 **이력관리** 탭에서 관리자 비밀번호로 로그인합니다.

`ADMIN_PASSWORD`를 지정하지 않으면 실행할 때마다 임시 비밀번호가 콘솔에 한 번 출력됩니다.

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `ADMIN_PASSWORD` | (임시 생성) | 이력관리 로그인 비밀번호 |
| `PORT` | `3000` | 포트 |
| `HOST` | `127.0.0.1` | 외부에서 접속하게 하려면 `0.0.0.0` |
| `TRUST_PROXY` | `0` | 앞단에 리버스 프록시(nginx 등)가 있으면 그 개수(보통 `1`). 0이면 `X-Forwarded-For`를 무시합니다 |
| `DB_PATH` | `./data/grandsun.db` | SQLite 파일 위치 |
| `RETENTION_DAYS` | `0` | 지정하면 그 일수가 지난 이력을 자동 삭제(0=삭제 안 함) |
| `COOKIE_SECURE` | - | `1`이면 로그인 쿠키에 Secure 속성 부여(HTTPS 사용 시) |

## 외부 공개 시 꼭 확인

- **HTTPS 필수**: 관리자 비밀번호와 개인정보가 오가므로 nginx·Caddy 등으로 HTTPS를 씌우세요. 이때 `TRUST_PROXY=1`, `COOKIE_SECURE=1`을 같이 설정해야 실제 접속 IP가 기록되고 쿠키가 보호됩니다.
- `TRUST_PROXY`를 프록시 없이 켜면 접속자가 `X-Forwarded-For`를 위조해 IP를 속일 수 있습니다. 반대로 프록시 뒤에서 `0`이면 모든 IP가 프록시 주소로 기록됩니다.
- 서버는 이름·소속·연락처·접속 IP를 저장합니다. 개인정보 처리방침, 보관 기간, 동의 문구는 서비스 운영 주체의 기준에 맞게 검토·수정하세요(화면의 동의 문구는 기본 예시입니다).
- `data/` 폴더(SQLite 파일)는 백업하되 외부에 노출하지 마세요. `public/` 아래 파일만 웹으로 제공됩니다.

## 구조

```
server.js        HTTP 서버, API, SQLite, 관리자 인증
package.json
public/
  index.html     화면
  style.css
  app.js         화면 동작(서버 API 호출)
  model.js       사업성 계산 모델 — 브라우저와 서버가 같은 코드를 사용
data/            실행 시 자동 생성되는 DB
```

## API

| 메서드·경로 | 권한 | 설명 |
|---|---|---|
| `GET /api/whoami` | 공개 | 서버가 본 접속 IP |
| `POST /api/reports` | 공개(IP당 시간당 20회) | 보고서 생성·이력 저장. 입력값은 서버가 다시 검증하고 결과도 서버가 계산합니다 |
| `POST /api/admin/login` · `logout` | - | 관리자 세션(HttpOnly 쿠키, 8시간). 5회 실패 시 15분 잠금 |
| `GET /api/history?q=&limit=&offset=` | 관리자 | 이력 조회·검색 |
| `GET /api/history.csv` | 관리자 | 전체 이력 CSV |
| `DELETE /api/history/:id` · `DELETE /api/history` | 관리자 | 개별·전체 삭제 |
