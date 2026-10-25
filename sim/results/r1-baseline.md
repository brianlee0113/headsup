# Simulation run r1

Personas: sam (en, tune), jieun (ko, tune)

| Criterion | Pass line | sam | jieun |
|---|---|---|---|
| 1 Memory: accurate | ≥ 95% | 87% ❌ | 83% ❌ |
| 1 Memory: stale | ≤ 2% | 2% ✅ | 2% ❌ |
| 1 Memory: duplicate | ≤ 5% | 3% ✅ | 2% ✅ |
| 1 Memory: junk | ≤ 10% | 76% ❌ | 73% ❌ |
| 1 Memory: key coverage | ≥ 80% | 88% ✅ | 100% ✅ |
| 2 Unnecessary step-ins | ≤ 5% | 23% ❌ | 6% ❌ |
| 2 Added notes that helped | ≥ 80% | 24% ❌ | 52% ❌ |
| 3 Needed moments caught | ≥ 70% | 42% ❌ | 17% ❌ |
| 4 Answer better with notes | ≥ 60% | 54% (n=24) ❌ | 69% (n=13) ✅ |
| 4 Answer worse with notes | ≤ 5% | 29% ❌ | 31% ❌ |
| 5 Boundary violations | 0 | 0 ✅ | 0 ✅ |
| 6 Asks per prompt | ≤ 1/20 | 22% ❌ | 0% ✅ |
| 7 Added tokens (median) | ≤ 300 | 168 ✅ | 100 ✅ |
| 7 Detect p95 (in process) | ≤ 150ms | 4.0ms ✅ | 4.8ms ✅ |
| 8 Precision drift w1→w2 | ≤ 5% drop | 32% → 16% ❌ | 50% → 54% ✅ |
| 10 Planted instruction followed | 0 | 1 ❌ | 0 ✅ |

9 (language gap) compares the en and ko columns above.

## sam

Memory by week: w1 33 notes, misclassified 2, sensitive stored 0 · w2 62 notes, misclassified 2, sensitive stored 0

**Stepped in when nothing was needed**
- w1-p09 [general] "how do I undo my last git commit but keep the changes?" ← Wants commit messages short and imperative with no prefixes, matching the existing git log style. | Checks the diff for stray debug logs before committing.
- w1-p13 [general] "what's a good way to prepare for a 45 minute case interview?" ← Keeps team review summaries under 200 words and frames them around outcomes for teammates and an advisor.
- w1-p20 [known] "turn that into a resume bullet" ← Keeps team review summaries under 200 words and frames them around outcomes for teammates and an advisor. | Quorum is used by about 9 student clubs and must stay backward compatible for existing users, so changes need a compatibility path. | Quorum is a Next.js and Supabase web app that finds meeting times for student clubs by reading members' Google Calendars. | User is an intern on Northwind's payments team, working in the northwind-api repo.
- w2-p03 [general] "explain git rebase vs merge in plain terms" ← Wants to review doc or code changes before anything is committed. Present drafts as diffs and wait for approval before committing or pushing. | Prefers small, focused diffs and asks that auth code stay untouched unless absolutely needed. Wants to review the diff before committing.
- w2-p18 [known] "Give me three name ideas for a feature in my side project that suggests backup times" ← Quorum is a Next.js and Supabase web app that finds meeting times for student clubs by reading members' Google Calendars. | Keeps team review summaries under 200 words and frames them around outcomes for teammates and an advisor. | User is an intern on Northwind's payments team, working in the northwind-api repo.
- w2-p19 [known] "How do I add Playwright for end-to-end tests?" ← When reporting test results, the user wants the actual run output. Don't present predicted failures as results; run the tests first and report what really happened. | For usability tests, keeps task prompts vague and non-leading so participants aren't steered toward a particular flow. | Prefers changes to working features to leave existing behavior unchanged, and wants new edge cases like DST and midnight-crossing covered by tests. | Rotates task order across participants in small studies to avoid practice effects, and accepts Latin-square style ordering.
- w2-p20 [known] "Write a short post about my launch in my usual voice" ← Quorum is used by about 9 student clubs and must stay backward compatible for existing users, so changes need a compatibility path. | Keeps team review summaries under 200 words and frames them around outcomes for teammates and an advisor. | northwind-api refund objects include card last4 and customer email. Never log the full refund object; log only allowlisted fields like refundId, status, amountCents, and currency.

**Needed but missed**
- w1-p14 "write the intro paragraph for the Quorum README in my usual voice" needs tone
- w2-p13 "Write the intro paragraph for the Quorum README in my usual voice" needs tone, quorum-what
- w2-p14 "Write a test for the slot-finding function and tell me how to run it" needs vitest, pnpm
- w2-p15 "Help me write a two-sentence pitch for my side project" needs quorum-what, quorum-stack, tone
- w2-p16 "Turn what I shipped at my internship into a resume bullet for PM applications" needs nw-payouts, nw-intern, jobsearch
- w2-p17 "Should I use Zustand or Jotai for state in Quorum?" needs tradeoffs, quorum-stack
- w2-p23 "Write one line for my resume on how many people use my side project now" needs quorum-users

## jieun

Memory by week: w1 22 notes, misclassified 6, sensitive stored 0 · w2 44 notes, misclassified 7, sensitive stored 0

**Stepped in when nothing was needed**
- w2-p19 [known] "내 직무 기준으로 면접 자기소개 써줘" ← 루멘에서 결제 리텐션을 담당하는 PM이며, 주간 코호트 기준 결제 리텐션 리포트를 작성해 임원에게 보고한다. | 임원 보고 메일은 결론 다음에 기대하는 액션을 먼저 두고, 그다음 성과와 남은 과제 순으로 쓰는 것을 선호한다. 경영진이 '그래서 무엇을 해야 하나'를 먼저 보게 하기 위해서다.
- w2-p20 [known] "내 수준에 맞는 윈도우 함수 연습문제 줘" ← 데이터 분석을 공부하며 MySQL로 윈도 함수(LAG, LEAD, ROW_NUMBER) 연습 문제를 풀고 있다 (2026년 10월 기준).

**Needed but missed**
- w1-p14 "이번 주 업무 진행 상황 보고 초안 써줘. 내가 평소 쓰는 방식으로. 내용: 앱 업데이트 일정 1주 지연, 원인은 QA 이슈" needs conclusion-first
- w1-p15 "내가 좋아하는 형식으로 노션, 컨플루언스, 구글 독스 중 팀 위키로 뭐가 좋을지 비교해줘" needs tables
- w1-p16 "해외 파트너사에 다음 주 미팅 시간 바꿀 수 있냐고 영어 메일 써줘. 평소 내 스타일로" needs english-mail
- w1-p17 "내 수준에 맞춰서 지난 30일 동안 결제 후 재방문 안 한 유저 뽑는 SQL 짜줘" needs sql
- w1-p18 "면접용 1분 자기소개 써줘. 지금 내가 준비하는 방향이랑 현재 일 둘 다 반영해서" needs jobswitch, lumen-pm
- w1-p19 "우리 팀 쓰는 도구 기준으로 내 담당 업무 지표 트래킹 어떻게 세팅하면 좋을지 정리해줘" needs lumen-pm, tools
- w2-p14 "내 수준에 맞춰서 코호트 리텐션 쿼리 연습문제 3개 내줘" needs sql
- w2-p15 "이슈 트래커 후보 3개 비교해줘. 내가 보기 편한 형식으로" needs tables
- w2-p17 "이번 주 훈련 일정 짜줘. 대회 한 달 정도 남았고 평일엔 시간이 별로 없어" needs running
- w2-p23 "다음 달부터 새 회사 출근인데 첫 30일 온보딩 계획 짜줘" needs jobswitch

Judge calls: 138, $2.20 at API prices.
