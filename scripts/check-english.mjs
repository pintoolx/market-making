import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Scan tracked product sources, documentation and fixtures, not runtime user data.
// This catches accidental CJK copy; English editorial review is still required.
const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const nonEnglishCopy = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
let failures = 0;
for (const path of paths) {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const lines = bytes.toString('utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!nonEnglishCopy.test(lines[i])) continue;
    // Report location only: source lines can contain sensitive fixture content.
    console.error(`${path}:${i + 1}: use English for repository and product copy`);
    failures++;
  }
}
if (failures) process.exitCode = 1;
else console.log('English copy check passed for tracked text files.');
