import { execFileSync } from 'node:child_process';

/**
 * Assertion Shield:
 * Scans git diffs to detect and block the removal or weakening
 * of test assertions by AI agents.
 */

const BASE_BRANCH = process.env.BASE_BRANCH || 'origin/develop';

function getGitDiff(): string {
  // execFileSync with arg arrays: BASE_BRANCH is env-supplied, so it must
  // never pass through a shell (security-guidance plugin finding).
  const diffs: string[] = [];
  try {
    // Committed work on this branch vs base
    diffs.push(execFileSync('git', ['diff', `${BASE_BRANCH}...HEAD`], { encoding: 'utf8' }));
  } catch {
    try {
      // Fallback: diff last commit if base branch is not fetched or available
      diffs.push(execFileSync('git', ['diff', 'HEAD~1'], { encoding: 'utf8' }));
    } catch {
      // no usable history — staged check below may still apply
    }
  }
  try {
    // Staged-but-uncommitted changes — what a pre-commit hook is actually
    // gating. Without --cached the hook only ever saw prior commits.
    diffs.push(execFileSync('git', ['diff', '--cached'], { encoding: 'utf8' }));
  } catch {
    console.log('Not in a git repository. Skipping assertion check.');
  }
  return diffs.join('\n');
}

interface Violation {
  file: string;
  line: string;
  lineNum?: number;
}

function scanDiffForWeakening(diffText: string): Violation[] {
  const violations: Violation[] = [];
  const lines = diffText.split('\n');
  let currentFile = '';
  let currentNewFile = '';
  // Added-line weakening (F-0009): skipping a test mutes it as effectively as
  // deleting its assertions.
  const skipPatterns = [/\.(only|skip)\s*\(/, /\b(xit|xdescribe|xtest)\s*\(/];

  const testFileRegex = /\.(test|spec)\.(ts|js|py|rs|go|cpp|java)$|__tests__/;
  const assertionKeywords = [
    'expect(',
    'assert.',
    'assert_eq!',
    'self.assert',
    'assert ',
    'it(',
    'test(',
    'describe('
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Deleted lines belong to the OLD side of the diff. Keying on "+++ b/"
    // alone made wholesale test-file deletions invisible: a deleted file's
    // new side is "+++ /dev/null", so the old path was never tracked.
    if (line.startsWith('--- a/')) {
      currentFile = line.substring(6);
      continue;
    }
    if (line.startsWith('--- ')) {
      currentFile = ''; // "--- /dev/null" → newly added file, nothing deletable
      continue;
    }
    if (line.startsWith('+++ b/')) {
      currentNewFile = line.substring(6);
      continue;
    }
    if (line.startsWith('+++ ')) {
      currentNewFile = ''; // "+++ /dev/null" → file deleted
      continue;
    }

    // ADDED lines in test files: flag .skip/.only/xit/xdescribe introductions
    if (currentNewFile && testFileRegex.test(currentNewFile) && line.startsWith('+') && !line.startsWith('+++')) {
      const added = line.substring(1).trim();
      if (!added.startsWith('//') && !added.startsWith('#') && !added.startsWith('/*')) {
        if (skipPatterns.some((re) => re.test(added))) {
          violations.push({ file: currentNewFile, line: `[skip/only added] ${added}` });
        }
      }
    }

    // Check if we are parsing a test file
    if (currentFile && testFileRegex.test(currentFile)) {
      // Check if line was deleted (starts with "-" but not "---")
      if (line.startsWith('-') && !line.startsWith('---')) {
        const cleanedLine = line.substring(1).trim();
        
        // Skip comment-only lines
        if (cleanedLine.startsWith('//') || cleanedLine.startsWith('#') || cleanedLine.startsWith('/*')) {
          continue;
        }

        const containsAssertion = assertionKeywords.some(keyword => cleanedLine.includes(keyword));
        if (containsAssertion) {
          violations.push({
            file: currentFile,
            line: cleanedLine
          });
        }
      }
    }
  }

  return violations;
}

function run() {
  const diff = getGitDiff();
  if (!diff) {
    process.exit(0);
  }

  const violations = scanDiffForWeakening(diff);

  if (violations.length > 0) {
    console.error('\x1b[31m[Assertion Shield] CRITICAL ERROR: Deleted or muted test assertions detected!\x1b[0m');
    console.error('Agents are prohibited from deleting, weakening, or skipping test assertions.');
    console.error('Violations found:');
    
    violations.forEach(v => {
      console.error(`- File: ${v.file}`);
      console.error(`  Line: \x1b[33m${v.line}\x1b[0m`);
    });

    console.error('\nRestore the assertions, or — if removal is genuinely intended (e.g. the tested feature was removed) — a HUMAN may bypass locally with ASSERTION_SHIELD_BYPASS=true. The bypass is ignored in CI, and agents are prohibited from setting it (guard-bash hook).');

    const bypassRequested = process.env.ASSERTION_SHIELD_BYPASS === 'true';
    const inCI = process.env.CI === 'true' || process.env.CI === '1';
    if (bypassRequested && !inCI) {
      console.log('\x1b[33m[Assertion Shield] Warning: local bypass active. CI will still enforce this check.\x1b[0m');
    } else {
      if (bypassRequested && inCI) {
        console.error('\x1b[31m[Assertion Shield] Bypass requested in CI — refused. CI never honors the bypass.\x1b[0m');
      }
      process.exit(1);
    }
  } else {
    console.log('\x1b[32m[Assertion Shield] Check passed. No deleted assertions detected in test files.\x1b[0m');
  }
}

run();
