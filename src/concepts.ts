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
    'customers', 'traction', '런칭', '출시', '사용자', '유저',
  ],
  testing: ['test', 'tests', 'testing', 'spec', 'vitest', 'jest', 'pytest', 'mocha', 'coverage', 'unit test', 'e2e', '테스트'],
  packages: [
    'install', 'dependency', 'dependencies', 'package manager', 'pnpm', 'npm', 'yarn', 'bun', 'lockfile', '설치', '패키지',
  ],
  git: ['commit', 'commits', 'commit message', 'branch', 'rebase', 'pull request', 'git', '커밋'],
  ci: ['ci', 'github actions', 'workflow', 'workflows', 'pipeline', 'runner', 'runners', 'lint', 'typecheck'],
  writing: [
    'post', 'draft', 'release notes', 'announcement', 'blog', 'newsletter', 'email', 'essay', 'tone', 'voice',
    'copy', 'writes', 'writing', 'sentences', 'tweet', '글', '공지', '이메일',
  ],
  format: ['summary', 'summarize', 'bullet', 'bullets', 'bullet-point', 'tldr', 'paragraph', 'paragraphs', '요약'],
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
};

const HANGUL = /[가-힣]/;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MATCHERS: Array<[string, RegExp]> = Object.entries(LEXICON).map(([concept, words]) => {
  const latin = words.filter((w) => !HANGUL.test(w)).map((w) => escape(w).replace(/ /g, '\\s+'));
  const hangul = words.filter((w) => HANGUL.test(w)).map(escape); // Korean attaches particles: match inside words
  const parts = [latin.length ? `(?<![\\p{L}\\p{N}])(?:${latin.join('|')})(?![\\p{L}\\p{N}])` : '', ...hangul].filter(Boolean);
  return [concept, new RegExp(parts.join('|'), 'iu')];
});

export function conceptsOf(text: string): string[] {
  return MATCHERS.filter(([, re]) => re.test(text)).map(([concept]) => concept);
}

export const CONCEPT_PREFIX = '#';
export const conceptTokens = (text: string) => conceptsOf(text).map((c) => CONCEPT_PREFIX + c);
