import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STABLE_VERSION_RE = /^\d+\.\d+\.\d+$/;

export async function verifyReleaseMetadata({ root, tag }) {
  const rootPackagePath = path.join(root, 'package.json');
  const apiPackagePath = path.join(root, 'apps', 'api', 'package.json');
  const packagePath = path.join(root, 'apps', 'desktop', 'package.json');
  const sharedPackagePath = path.join(root, 'packages', 'shared', 'package.json');
  const pythonProjectPath = path.join(root, 'apps', 'api-py', 'pyproject.toml');
  const pythonMainPath = path.join(root, 'apps', 'api-py', 'app', 'main.py');
  const notesPath = path.join(root, 'apps', 'desktop', 'src', 'lib', 'releaseNotes.ts');
  const changelogPath = path.join(root, 'CHANGELOG.md');
  const [rootPackageText, apiPackageText, packageText, sharedPackageText, pythonProject, pythonMain, notes, changelog] = await Promise.all([
    readFile(rootPackagePath, 'utf8'),
    readFile(apiPackagePath, 'utf8'),
    readFile(packagePath, 'utf8'),
    readFile(sharedPackagePath, 'utf8'),
    readFile(pythonProjectPath, 'utf8'),
    readFile(pythonMainPath, 'utf8'),
    readFile(notesPath, 'utf8'),
    readFile(changelogPath, 'utf8'),
  ]);
  const rootPackage = JSON.parse(rootPackageText);
  const version = String(JSON.parse(packageText).version ?? '');
  if (!STABLE_VERSION_RE.test(version)) {
    throw new Error(`Desktop package must use a stable semantic version, got ${version || '<empty>'}.`);
  }
  const expectedTag = `v${version}`;
  if (tag !== expectedTag) {
    throw new Error(`Release tag ${tag || '<empty>'} does not match package version ${version}.`);
  }
  const pythonProjectVersion = pythonProject.match(/^version\s*=\s*['"]([^'"]+)['"]/m)?.[1] ?? '';
  const fastApiVersion = pythonMain.match(/FastAPI\([^)]*?\bversion\s*=\s*['"]([^'"]+)['"]/s)?.[1] ?? '';
  const healthVersion = pythonMain.match(/['"]version['"]\s*:\s*['"]([^'"]+)['"]/)?.[1] ?? '';
  const versionSources = [
    ['package.json', String(rootPackage.version ?? '')],
    ['apps/api/package.json', String(JSON.parse(apiPackageText).version ?? '')],
    ['packages/shared/package.json', String(JSON.parse(sharedPackageText).version ?? '')],
    ['apps/api-py/pyproject.toml', pythonProjectVersion],
    ['apps/api-py/app/main.py', fastApiVersion],
    ['apps/api-py/app/main.py health response', healthVersion],
  ];
  for (const [source, sourceVersion] of versionSources) {
    if (sourceVersion !== version) {
      throw new Error(
        `${source} version ${sourceVersion || '<missing>'} does not match desktop version ${version}.`,
      );
    }
  }
  const packageManager = String(rootPackage.packageManager ?? '');
  const packageManagerVersion = packageManager.match(/^pnpm@(\d+\.\d+\.\d+)$/)?.[1] ?? '';
  if (!packageManagerVersion) {
    throw new Error(
      `package.json packageManager must pin an exact pnpm version, got ${packageManager || '<missing>'}.`,
    );
  }
  const workflowsDirectory = path.join(root, '.github', 'workflows');
  const workflowNames = (await readdir(workflowsDirectory)).filter((name) => /\.ya?ml$/i.test(name));
  for (const workflowName of workflowNames) {
    const workflowPath = path.join(workflowsDirectory, workflowName);
    const workflow = await readFile(workflowPath, 'utf8');
    const lines = workflow.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!/uses:\s*pnpm\/action-setup@/i.test(lines[index])) continue;
      for (let lookahead = index + 1; lookahead < Math.min(lines.length, index + 9); lookahead += 1) {
        if (/^\s*-\s+(?:uses|name):/i.test(lines[lookahead])) break;
        const configuredVersion = lines[lookahead].match(/^\s*version:\s*['"]?([^'"\s#]+)/i)?.[1];
        if (!configuredVersion) continue;
        if (configuredVersion !== packageManagerVersion) {
          throw new Error(
            `.github/workflows/${workflowName} uses pnpm ${configuredVersion} but packageManager is ${packageManager}.`,
          );
        }
        break;
      }
    }
  }
  const firstNote = notes.match(/version:\s*['"]([^'"]+)['"]/i)?.[1];
  if (firstNote !== version) {
    throw new Error(`Top release note ${firstNote || '<missing>'} does not match package version ${version}.`);
  }
  const matchingNotes = [...notes.matchAll(/version:\s*['"]([^'"]+)['"]/gi)].filter(
    (match) => match[1] === version,
  ).length;
  if (matchingNotes !== 1) {
    throw new Error(`Release notes contain ${matchingNotes} entries for version ${version}.`);
  }
  if (!changelog.includes(`## [${version}]`)) {
    throw new Error(`CHANGELOG does not contain a ${version} release section.`);
  }
  return { version };
}

async function main() {
  const root = path.resolve(process.argv[2] || '.');
  const tag = process.argv[3] || process.env.GITHUB_REF_NAME || '';
  const result = await verifyReleaseMetadata({ root, tag });
  process.stdout.write(`Release metadata OK: v${result.version}\n`);
}

if (pathToFileURL(process.argv[1] || '').href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
