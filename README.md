# FileBot WebApp

FileBot 스타일의 미디어 파일 리네이머 웹앱. 폴더를 스캔해 파일명에서 메타데이터(제목/연도/시즌/에피소드/해상도/코덱)를 추출하고, Plex 친화적인 포맷 프리셋을 적용해 미리보기한 뒤 실제로 리네임/이동/복사한다.

오프라인으로 동작하며(파일명 기반 파싱), 외부 API 키가 필요 없다.

## 기능

- 📁 폴더 스캔 (하위 폴더 포함 옵션)
- 🔍 파일명 메타데이터 추출 — 영화 `Title (Year)`, TV `S01E02` / `1x02` 패턴
- 🎬 FileBot 스타일 포맷 토큰: `{n} {y} {s} {e} {t} {vf} {vc} {ac}`
- 🔧 메서드 체이닝: `{s.pad(2)}`, `{n.upper()}`, `{n.space('.')}`, `{t.replace('a','b')}`
- 💾 프리셋 저장/편집/삭제 (`presets.json`)
- 👁 미리보기 후 실행 — 이동(move) / 복사(copy) / 드라이런

## 데이터소스 (메타데이터 매칭)

FileBot처럼 외부 DB에서 정식 제목·연도·에피소드 제목을 불러와 파일명에서 추출한 값을 보정한다. 매칭 실패 시 파일명 기반 값으로 자동 폴백한다.

| 소스 | API 키 | 대상 | 언어 | 비고 |
|------|--------|------|------|------|
| **Wikidata** | 불필요 | 영화 + TV 시리즈 | 다국어 | 선택 언어로 제목 반환. 한국어 검색 시 한국 영화·드라마 인식 |
| **TVmaze** | 불필요 | TV 에피소드 | 영어 | 에피소드 제목까지 가져옴 |
| **TheMovieDB** | 필요 | 영화 + TV | 다국어 | K-드라마·한국영화 강함. `ko-KR` 등 현지화 |
| **OMDb** | 필요 | 영화 + 시리즈 | 영어 | |
| **KMDb (영화진흥위원회)** | 필요 | 한국 영화 | 한/영 | 한국영화 전용 DB(KOFIC). [키 발급](https://www.kmdb.or.kr/info/api/apiDetail/6) |

### 언어 선택

UI 상단 언어 드롭다운에서 **English / 한국어 / 日本語 / 中文 / Español / Français / Deutsch** 중 선택한다. 각 소스가 자체 코드로 자동 매핑된다 (예: 한국어 → TheMovieDB `ko-KR`, Wikidata `ko`). 한국 영화/드라마를 한국어 제목으로 인식·정리하려면 **Wikidata + 한국어**(키 불필요) 또는 **TheMovieDB/KMDb + 한국어**(키 필요)를 쓰면 된다.

### API 키 저장 (소스별 자동)

키가 필요한 소스는 API 키를 한 번 입력하면 **브라우저(localStorage)에 소스별로 저장**된다. 소스를 바꾸면 그 소스에 저장된 키가 자동으로 채워지고, 키를 수정하면 자동 저장된다. 키는 디스크/리포에 저장되지 않고 브라우저에만 보관된다.

- 키 없이 바로 쓰려면 **Wikidata**(영화+TV, 다국어)와 **TVmaze**(TV 에피소드)를 쓰면 된다.

## 포함된 프리셋

| 이름 | 타입 | 포맷 |
|------|------|------|
| Plex Movie | movie | `Movie/{n} ({y})/{n} ({y}) [{vf}, {vc}, {ac}]` |
| Plex Movie (simple) | movie | `Movie/{n} ({y})/{n} ({y})` |
| Plex Series | episode | `Series/{n}/Season {s}/{n} - S{s.pad(2)}E{e.pad(2)} - {t}` |
| Plex Series (no episode title) | episode | `Series/{n}/Season {s}/{n} - S{s.pad(2)}E{e.pad(2)}` |
| Plex Animation | movie | `Animation/{n} ({y})/{n} ({y}) [{vf}, {vc}, {ac}]` |

## 실행

```bash
npm install
npm start
# http://localhost:7420
```

포트를 바꾸려면: `PORT=9000 npm start`

## 토큰 레퍼런스

| 토큰 | 의미 | 예 |
|------|------|----|
| `{n}` | 제목 | `Inception` |
| `{y}` | 연도 | `2010` |
| `{s}` | 시즌 번호 | `1` |
| `{e}` | 에피소드 번호 | `5` |
| `{t}` | 에피소드 제목 | `Pilot` |
| `{vf}` | 해상도 | `1080p` |
| `{vc}` | 영상 코덱 | `HEVC` |
| `{ac}` | 오디오 코덱 | `AAC` |

메서드: `pad(n)`, `upper()`, `lower()`, `space(ch)`, `replace(a,b)`

## 주의

- 빈 토큰이 들어간 `{...}` 그룹과 그로 인해 남는 빈 괄호/구분자는 자동 정리된다.
- 대상에 같은 파일이 이미 있으면 덮어쓰지 않고 건너뛴다(skipped).
- 다른 볼륨으로 이동 시 자동으로 복사 후 원본 삭제로 처리한다.

## 라이선스

MIT
