import { execFileSync } from 'node:child_process';

/**
 * Assertion Shield:
 * Scans git diffs to detect and block the removal or weakening
 * of test assertions by AI agents.
 */

const BASE_BRANCH = process.env.BASE_BRANCH || 'origin/develop';

function refExists(ref: string): boolean {
  // --verify --quiet resolves the ref without printing anything; stdio 'pipe'
  // keeps git's stderr off the console so a missing upstream is silent.
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getGitDiff(): string {
  // execFileSync with arg arrays: BASE_BRANCH is env-supplied, so it must
  // never pass through a shell (security-guidance plugin finding).
  const diffs: string[] = [];
  if (refExists(BASE_BRANCH)) {
    // Committed work on this branch vs base.
    // -M (--find-renames) enables git rename detection: a pure .test.js→.test.ts
    // rename emits only a "rename from/to" header with no "-expect(...)" content
    // lines, so the shield sees no deleted assertions and correctly passes.
    // A rename that ALSO removes/weakens an assertion still emits the "-expect(...)"
    // deletion line in the diff hunk, so the parser flags it as usual (BLOCK).
    // Laundering is not enabled: removing an assertion always surfaces a "-" line
    // (whether in a rename hunk or a plain deletion). A deletion too dissimilar to
    // pair as a rename is shown as a full file delete (all assertions flagged).
    try {
      diffs.push(execFileSync('git', ['diff', '-M', `${BASE_BRANCH}...HEAD`], { encoding: 'utf8' }));
    } catch {
      // base resolved but the range diff failed — fall through to staged check
    }
  } else if (refExists('HEAD~1')) {
    // base not fetched/available but prior history exists — diff the last commit
    try {
      diffs.push(execFileSync('git', ['diff', '-M', 'HEAD~1'], { encoding: 'utf8' }));
    } catch {
      // no usable history — staged check below may still apply
    }
  } else {
    // First commit before the upstream base exists yet — not an error, just no
    // base to diff against. The staged check below still guards this commit.
    console.log(`[Assertion Shield] No '${BASE_BRANCH}' upstream and no prior commit yet (first commit) — auditing staged changes only.`);
  }
  try {
    // Staged-but-uncommitted changes — what a pre-commit hook is actually
    // gating. Without --cached the hook only ever saw prior commits.
    diffs.push(execFileSync('git', ['diff', '-M', '--cached'], { encoding: 'utf8' }));
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

  // F-0027: distinguish "a pre-existing test lost coverage" (a real weakening, block)
  // from "a test file created in THIS branch is being removed/edited" (removes no
  // pre-existing coverage, so not a weakening). We only relax when BASE is available
  // to compare against — with no upstream we cannot tell, so we stay strict.
  const baseAvailable = refExists(BASE_BRANCH);
  const baseExistsCache = new Map<string, boolean>();
  const existedOnBase = (file: string): boolean => {
    if (!file) return false;
    const cached = baseExistsCache.get(file);
    if (cached !== undefined) return cached;
    let exists = false;
    try {
      // git cat-file -e BASE:path exits 0 iff the path exists on BASE. BASE_BRANCH is
      // env-supplied → execFileSync arg array (no shell), same hardening as getDiff().
      execFileSync('git', ['cat-file', '-e', `${BASE_BRANCH}:${file}`], { stdio: 'pipe' });
      exists = true;
    } catch {
      exists = false;
    }
    baseExistsCache.set(file, exists);
    return exists;
  };
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

        // Skip CJS module import/require declarations (CJS→ESM migration boilerplate, not assertions):
        // 'const|let|var X = require(...);' or a destructuring 'const { a, b } = require(...);',
        // plus a bare 'use strict' pragma. These carry no test coverage.
        // SECURITY (security-review): the pattern is anchored at BOTH ends — require(...) must be
        // the ENTIRE right-hand side and the line must END there (optional ';'). Without the end
        // anchor, a line like `const _ = require('x'); expect(role).toBe('admin');` would match the
        // prefix and let a real deleted assertion slip past. A single LHS binding only (a bare
        // identifier or one {...} destructure) — no ','-chained second binding, no trailing code.
        const isModuleDecl =
          /^(?:const|let|var)\s+(?:[A-Za-z_$][\w$]*|\{[^}]*\})\s*=\s*require\([^)]*\)\s*;?\s*$/.test(cleanedLine)
          || cleanedLine === "'use strict';";
        if (isModuleDecl) {
          continue;
        }

        const containsAssertion = assertionKeywords.some(keyword => cleanedLine.includes(keyword));
        // F-0027: only a deletion from a file that EXISTED on BASE is a weakening
        // (when base is unavailable, stay strict and flag). A branch-new test file
        // being removed/edited removes no pre-existing coverage → not flagged. The
        // strict scan is otherwise unchanged, so content-gutting in an existing test
        // (a deleted assertion line) is still blocked.
        if (containsAssertion && (!baseAvailable || existedOnBase(currentFile))) {
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
