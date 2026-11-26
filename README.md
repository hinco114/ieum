# 이음

어느 AI에서든 하던 일을 이어서. Python 3.9 이상으로 실행하는 로컬 CLI와 stdio MCP 서버다.

## 시작하기

저장소 폴더에서 실행한다. 처음 선택한 기억 폴더는 세 클라이언트가 공유한다.

```sh
python3 ieum.py setup
python3 ieum.py remember '위키는 읽기 전용으로 연결한다' --project 이음
python3 ieum.py search 위키
python3 ieum.py project_update 이음 '다음 작업은 검색 품질 검증'
python3 ieum.py overview
```

설정은 `~/.config/ieum/config.json`에 저장된다. 테스트 환경에서는 `IEUM_CONFIG`로 위치를 지정한다. 기억은 선택한 폴더의 `memory/ieum/`에 저장하고 기존 `wiki/`는 읽기만 한다.

기억 폴더가 Git 작업 트리에 있으면 `remember`와 `project_update`가 `memory/ieum/`에 남아 있는 모든 Git 변경을 커밋한다. 원격이 설정돼 있으면 현재 브랜치의 기본 push 설정을 사용한다. 추적 중인 원격 브랜치에 새 커밋이 있으면 Git 2.38 이상에서 충돌 여부를 확인하고, 안전하게 병합할 수 있을 때 반영한 뒤 push를 다시 시도한다.

결과의 `sync` 필드에서 push가 완료됐는지 확인할 수 있다. 실패한 push를 다시 시도하거나 직접 편집한 기억 파일을 동기화하려면 `python3 ieum.py sync` 또는 플러그인의 `sync` 도구를 사용한다. 다음 기억 저장 때도 동기화를 다시 시도한다. 개인 데이터에 맞는 원격을 선택한다.

## 플러그인 설치

Python 3.9 이상, Node.js 18 이상과 이 저장소의 로컬 사본을 준비한다. 저장소 최상위 폴더에서 사용하는 에이전트의 명령을 실행한다.

### Codex

```sh
codex plugin marketplace add "$PWD"
codex plugin add ieum@ieum
```

새 Codex 세션에서 스킬 선택기(`$`)에 `ieum`을 입력하거나 “이음 설정해 줘”라고 요청한다. 설정 이후에는 “이음에 이 결정 기억해 줘”나 “이음에서 지난 결정 찾아줘”처럼 대화로 사용한다. Python은 플러그인 내부에서 실행된다.

### Claude Code

```sh
claude plugin marketplace add "$PWD"
claude plugin install ieum@ieum
```

### Antigravity CLI

```sh
agy plugin install "$PWD/plugins/ieum"
```

설치 후 새 세션에서 “이음 설정해 줘”라고 요청하고 기억 폴더의 절대 경로를 알려준다. 세 클라이언트가 한 사용자 설정을 공유한다. “이건 기억해”, “위키에서 찾아줘”, “프로젝트별 최신 상태를 보여줘”로 도구를 호출할 수 있다.

배포할 때는 개인 기억 폴더와 별개로 이 코드 저장소를 전달한다. 첫 설정 또는 기존 설정의 첫 검색에서 로컬 검색 엔진을 백그라운드로 준비한다. 공개 배포처에서 Qwen3 임베딩과 Kiwi 한국어 모델을 내려받아 검증하고 기억과 위키의 초기 색인을 만든다. 모델 파일은 합계 약 735 MB이며 런타임은 추가 공간을 사용한다. 준비 중에는 기본 키워드 검색을 사용할 수 있다. `search_status`로 상태와 로그 위치를 확인하고 설치 실패 후에는 같은 폴더로 setup을 다시 실행한다. 준비 후에는 형태소 BM25와 의미 검색의 순위를 결합한다. 전체 목표는 [제품 명세](SPEC.md)에 정리했다.
