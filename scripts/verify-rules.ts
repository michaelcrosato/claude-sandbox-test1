import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * RuleForge-Lite: Automatically syncs and validates build/test commands
 * in CLAUDE.md against local package configuration files.
 */

const CLAUDE_PATH = path.join(process.cwd(), 'CLAUDE.md');

function detectStack(): { buildCmd: string; testCmd: string; hasBuild: boolean; hasTest: boolean } {
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  const cargoTomlPath = path.join(process.cwd(), 'Cargo.toml');
  const pyprojectPath = path.join(process.cwd(), 'pyproject.toml');

  if (fs.existsSync(packageJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const isPnpm = fs.existsSync(path.join(process.cwd(), 'pnpm-lock.yaml'));
    const isYarn = fs.existsSync(path.join(process.cwd(), 'yarn.lock'));
    const runner = isPnpm ? 'pnpm' : isYarn ? 'yarn' : 'npm';

    return {
      buildCmd: `${runner} run build`,
      testCmd: `${runner} test`,
      hasBuild: Boolean(pkg.scripts?.build),
      hasTest: Boolean(pkg.scripts?.test)
    };
  }

  if (fs.existsSync(cargoTomlPath)) {
    return { buildCmd: 'cargo build', testCmd: 'cargo test', hasBuild: true, hasTest: true };
  }

  if (fs.existsSync(pyprojectPath)) {
    return { buildCmd: 'pip install .', testCmd: 'pytest', hasBuild: true, hasTest: true };
  }

  return { buildCmd: 'make build', testCmd: 'make test', hasBuild: false, hasTest: false };
}

function verifyClaudeMd() {
  if (!fs.existsSync(CLAUDE_PATH)) {
    console.log('CLAUDE.md not found. Generating default...');
    const stack = detectStack();
    const template = `# Agent Constitution

## 1. Commands
- **Build**: ${stack.buildCmd}
- **Test**: ${stack.testCmd}

## 2. Guidelines
- Keep code clean and modular.
- Always run the test command before committing.
`;
    fs.writeFileSync(CLAUDE_PATH, template, 'utf8');
    console.log('CLAUDE.md generated successfully.');
    return;
  }

  const content = fs.readFileSync(CLAUDE_PATH, 'utf8');
  const stack = detectStack();

  // Only warn about commands that actually exist in this repo. Warning about
  // guessed defaults ("npm build" with no build script) injected false-positive
  // noise into every session brief.
  if (stack.hasBuild && !content.includes(stack.buildCmd)) {
    console.warn(`[Warning] CLAUDE.md might be missing the current build command: "${stack.buildCmd}"`);
  }
  if (stack.hasTest && !content.includes(stack.testCmd)) {
    console.warn(`[Warning] CLAUDE.md might be missing the current test command: "${stack.testCmd}"`);
  }
}

try {
  verifyClaudeMd();
} catch (error) {
  console.error('Error running RuleForge-Lite verification:', error);
  process.exit(1);
}
