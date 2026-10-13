# Gemini Web provider for Paseo

Google Pro/Ultra 계정의 Gemini 웹을 사용하는 비공식 Paseo 프로바이더 플러그인입니다. Gemini API 키나 별도 API 결제가 필요하지 않습니다.

## 설치

Paseo Desktop **0.11.2**와 Node.js **24.x (24.15 이상)**에서 설치·검증했습니다. 이 구현은 Paseo 0.11 계열의 데스크톱 브라우저 구조를 사용하므로 지원 버전을 `>=0.11.2 <0.12.0`으로 제한합니다.

```powershell
git clone https://github.com/imsisstupid/paseo-gemini-web.git
cd paseo-gemini-web
npm ci
npm run typecheck
npm test
paseo plugin install .
```

코드 수정 후에는 `paseo plugin reload paseo-gemini-web`로 다시 불러옵니다. 데몬 전체를 재시작할 필요가 없습니다.

## 사용

1. 호스트 설정 → Agents에서 **Paseo tools**, **Browser tools**를 켭니다.
2. 새 에이전트에서 **Gemini Web → Gemini 4 Argon · Web**을 선택합니다.
3. 사고 수준을 **최저가(Low) / 보통(Medium) / 최고가(High)** 중에서 선택합니다.
4. 메시지를 보내면 해당 대화 전용 Gemini 탭이 열립니다. 로그인이 필요하면 그 탭에서 직접 로그인한 뒤 다시 보내세요.
5. Deep Research는 대화 설정에서 켭니다. 조사 계획이 생성되면 Paseo의 승인 창에서 시작 여부를 결정합니다.

Paseo Desktop이 Gemini 탭을 실행하므로 계속 켜 두어야 합니다. 휴대전화에서 Paseo를 조작하더라도 연결된 데스크톱이 필요합니다.

조사 완료 후 연결이 끊겼다면 새 Gemini Web 에이전트에 `/research-result https://gemini.google.com/app/대화ID`를 보내 기존 보고서를 가져올 수 있습니다. 새 조사 요청을 보내지 않으며, 아직 조사 중인 내용은 완료된 보고서로 반환하지 않습니다.

## 권한

| 모드 | 동작 |
| --- | --- |
| 대화 | Gemini 대화만 사용. 로컬 도구 실행 안 함 |
| 읽기 전용 | 작업 폴더의 목록과 파일을 읽어 Gemini에 전달. 쓰기와 명령 실행 차단 |
| 작업마다 승인 | 파일 읽기·쓰기·명령 실행마다 Paseo에서 허용 또는 거절 |

파일 도구는 경로·심볼릭 링크를 검사해 작업 폴더 밖의 파일 접근과 `.git` 수정을 차단합니다. 파일 크기는 256 KiB까지입니다. 셸은 Windows에서 PowerShell, 그 외에는 `/bin/sh`를 사용하며 출력은 32 KiB, 실행 시간은 최대 60초입니다. **셸 명령은 파일 시스템 샌드박스가 아니므로 승인한 명령이 작업 폴더 밖에도 영향을 줄 수 있습니다.**

한 메시지당 로컬 도구는 최대 12회 실행합니다. Deep Research에서는 로컬 도구를 실행하지 않습니다. 이미지·파일 첨부는 현재 직접 지원하지 않으며, 텍스트 파일은 로컬 읽기 도구로 요청할 수 있습니다.

## 연결 방식과 한계

- 직접 프로바이더가 Paseo의 메시지·설정·승인·중지·복원 이벤트를 처리합니다.
- 답변 본문은 생성 완료 후 한 번에 표시합니다. 웹의 임시 Markdown을 Paseo 0.11에 계속 전달하면 수정된 부분이 중복 누적되므로, 생성 중에는 진행 상태를 표시합니다.
- 호스트가 제공한 에이전트 범위의 Paseo MCP 연결로 탭을 엽니다.
- 데스크톱 플러그인이 그 탭의 고정된 Gemini 화면 요소를 읽고 조작합니다. 임의 JavaScript 실행 RPC는 제공하지 않습니다.
- Paseo 0.11.2의 페이지 평가 기능은 Gemini의 Trusted Types 정책에 막힙니다. 데스크톱의 기존 webview에 고정 스크립트를 실행하며, 설치된 Paseo 파일이나 보안 정책은 변경하지 않습니다.
- 데스크톱 브리지는 내부 `data-paseo-browser-id` 속성에 의존합니다. 향후 Paseo 구조 변경 시 수정이 필요합니다.
- 브리지가 제공되지 않으면 접근성 화면 정보로 연결을 시도하지만, 긴 대화나 일부 메뉴는 읽을 수 없습니다. 잘린 답변을 완전한 답변으로 표시하지 않습니다.
- Deep Research의 전체 보고서를 읽으려면 데스크톱 브리지가 필요합니다. 브리지가 없으면 조사 요청을 보내기 전에 중단합니다.
- 웹의 사용량 제한, 로그인 만료, 기능 배포 범위가 그대로 적용됩니다. 다른 모델로 자동 대체하지 않습니다.
- 대화 URL과 제한된 표시 기록을 Paseo에 저장해 재연결합니다. 실제 대화 기록은 Gemini에 남습니다. 탭 닫기는 Google의 대화 삭제를 의미하지 않습니다.
- 중지는 웹의 중지 버튼을 누릅니다. 이미 Google 서버에서 진행 중인 작업이 중단됐는지는 화면 상태에 따라 확인할 수 있는 범위가 제한됩니다.

## 개발 확인

```powershell
npm run typecheck
npm test
npm audit --omit=dev
paseo plugin ls paseo-gemini-web --json
paseo plugin logs paseo-gemini-web
```

테스트는 실제 로컬 MCP 서버, 임시 작업 폴더와 프로세스, 제어된 Gemini DOM을 사용합니다. 실제 Google 계정으로 보내는 검증 메시지는 자동 테스트에 포함하지 않습니다.

2026-10-14 기준 자동 테스트 91개와 타입 검사를 통과했습니다. 실제 Pro 계정으로 Argon 응답·사고 수준 선택·파일 읽기 승인·대화 복원·Deep Research 계획 승인과 시작을 확인했으며, 최종 빌드에서 완료된 조사 보고서와 출처 7개를 Paseo로 회수했습니다. 수정된 전체 조사 흐름을 새 조사 요청으로 반복 실행하지는 않았습니다.
