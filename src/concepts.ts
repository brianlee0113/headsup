// A small concept lexicon that bridges words which mean the same task but never co-occur:
// "cover letter" and "internship", "install" and "pnpm", "restaurant" and "vegetarian".
// Both notes and prompts are tagged, and a shared tag counts as a match in search.

const LEXICON: Record<string, string[]> = {
  profile: [
    'resume', 'résumé', 'cv', 'cover letter', 'bio', 'about me', 'introduce myself', 'linkedin', 'portfolio',
    'interview', 'recruiter', 'impact', 'proud of', 'accomplishment', 'achievement', 'internship', 'intern',
    'career', 'side project', 'shipped', 'student', '이력서', '자소서', '자기소개', '경력', '면접', '인턴', '성과', '포트폴리오',
  ],
  traction: [
    'launch', 'launched', 'launching', 'announce', 'announcing', 'users', 'weekly', 'growth', 'signups', 'mvp',
    'customers', 'traction', 'how many people', 'people use', '런칭', '출시', '사용자', '유저',
  ],
  // Korean 테스트 alone mostly means trying something out ("배포하면 셀프로 테스트 가능해?"), so it counts as
  // testing only beside a sign of test code.
  testing: [
    'test', 'tests', 'testing', 'spec', 'vitest', 'jest', 'pytest', 'mocha', 'coverage', 'unit test', 'e2e',
    '유닛 테스트', '단위 테스트', '테스트 코드', '테스트 케이스', '테스트 파일', '테스트 작성', '테스트 추가', '테스트를 추가',
    '테스트를 작성', '테스트 돌', '테스트를 돌', '테스트 실행', '테스트를 실행', '테스트 통과', '테스트가 통과', '테스트가 깨', '테스트 실패',
  ],
  // The package manager shapes every command: running tests, scripts, CI steps.
  packages: [
    'install', 'dependency', 'dependencies', 'package manager', 'pnpm', 'npm', 'yarn', 'bun', 'lockfile', 'script', 'scripts',
    'test script', 'watch mode', '설치', '패키지', '스크립트',
  ],
  git: ['commit', 'commits', 'commit message', 'branch', 'rebase', 'pull request', 'git', '커밋'],
  ci: ['ci', 'github actions', 'workflow', 'workflows', 'pipeline', 'runner', 'runners', 'lint', 'typecheck'],
  writing: [
    'post', 'draft', 'release notes', 'announcement', 'blog', 'newsletter', 'email', 'essay', 'tone', 'voice',
    'copy', 'writes', 'writing', 'sentences', 'tweet', 'report', 'memo', '글', '공지', '메일', '보고서', '보고 초안', '주간 보고', '초안', '문구',
  ],
  format: [
    'summary', 'summarize', 'bullet', 'bullets', 'bullet-point', 'tldr', 'paragraph', 'paragraphs', 'table', 'tables', 'compare',
    'comparison', '요약', '표로', '표 형식', '테이블', '비교', '형식',
  ],
  data: ['sql', 'query', 'queries', 'database', 'window function', '쿼리', '데이터 분석', '윈도우 함수', '윈도 함수'],
  fitness: ['running', 'run', 'marathon', 'half marathon', 'workout', 'training plan', '러닝', '달리기', '마라톤', '훈련', '운동'],
  food: [
    'restaurant', 'dinner', 'lunch', 'breakfast', 'food', 'recipe', 'eat', 'meal', 'cook', 'vegetarian', 'vegan',
    'allergic', 'allergy', 'menu', '식당', '음식', '저녁', '점심', '레시피',
  ],
  travel: ['trip', 'travel', 'flight', 'hotel', 'itinerary', '여행', '항공', '숙소'],
  education: ['school', 'university', 'degree', 'master', "master's", 'phd', 'course', 'thesis', '학교', '대학원'],
};

// Usage-profile topics ("I use ChatGPT for writing") resolve to concepts, so the same lexicon
// decides both "what is this prompt about" and "which notes are about it".
export const TOPIC_CONCEPTS: Record<string, string[]> = {
  coding: ['testing', 'packages', 'git', 'ci'],
  'side projects': ['traction'],
  writing: ['writing', 'format'],
  everyday: ['food', 'travel'],
  career: ['profile'],
  learning: ['data', 'education'],
  work: ['writing', 'format'],
};

const HANGUL = /[가-힣]/;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MATCHERS: Array<[string, RegExp]> = Object.entries(LEXICON).map(([concept, words]) => {
  const latin = words.filter((w) => !HANGUL.test(w)).map((w) => escape(w).replace(/ /g, '\\s+'));
  // Korean attaches particles: match inside words. Spacing in Korean varies, so a space may be left out.
  const hangul = words.filter((w) => HANGUL.test(w)).map((w) => escape(w).replace(/ /g, '\\s*'));
  const parts = [latin.length ? `(?<![\\p{L}\\p{N}])(?:${latin.join('|')})(?![\\p{L}\\p{N}])` : '', ...hangul].filter(Boolean);
  return [concept, new RegExp(parts.join('|'), 'iu')];
});

export function conceptsOf(text: string): string[] {
  return MATCHERS.filter(([, re]) => re.test(text)).map(([concept]) => concept);
}

export const CONCEPT_PREFIX = '#';
export const conceptTokens = (text: string) => conceptsOf(text).map((c) => CONCEPT_PREFIX + c);

// Kinds of writing. A style preference usually holds for one kind ("emails short and polite", "commit
// messages imperative"): stated for one, it misleads another, so gap.ts adds a how-you-work note that
// names a kind only when the request is the same kind.
const GENRES: Record<string, string[]> = {
  email: ['email', 'e-mail', 'mail', '메일', '이메일'],
  chat: ['slack', 'teams message', 'dm', 'text message', '슬랙', '메신저', '카톡'],
  ticket: ['jira', 'ticket', 'issue', 'user story', '티켓', '이슈'],
  report: ['report', 'status update', 'weekly update', 'memo', '보고서', '리포트', '주간 보고', '업무 보고', '보고 초안', '상황 보고', '결과 보고', '보고 메일'],
  social: ['linkedin', 'instagram', 'tweet', 'twitter', 'x post', 'social post', '인스타', '링크드인', 'sns'],
  // The style of commit messages, not committing as an action ("commit and record it in PLAN.md").
  commit: ['commit message', 'commit messages', '커밋 메시지', '커밋 메세지'],
  docs: ['readme', 'documentation', 'docs', '문서'],
};
const GENRE_MATCHERS: Array<[string, RegExp]> = Object.entries(GENRES).map(([g, words]) => {
  const latin = words.filter((w) => !HANGUL.test(w)).map((w) => escape(w).replace(/ /g, '\\s+'));
  const hangul = words.filter((w) => HANGUL.test(w)).map(escape);
  const parts = [latin.length ? `(?<![\\p{L}\\p{N}])(?:${latin.join('|')})(?![\\p{L}\\p{N}])` : '', ...hangul].filter(Boolean);
  return [g, new RegExp(parts.join('|'), 'iu')];
});
export const genresOf = (text: string): string[] => GENRE_MATCHERS.filter(([, re]) => re.test(text)).map(([g]) => g);
