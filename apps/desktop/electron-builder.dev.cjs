const { execFileSync } = require('node:child_process');
const path = require('node:path');
const packageJson = require('./package.json');

function gitShortSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 8);
  try {
    return execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  } catch {
    return 'local';
  }
}

function nextPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (!match) throw new Error(`Unsupported SkillCue version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

const base = packageJson.build;
const devVersion = `${nextPatchVersion(packageJson.version)}-dev.g${gitShortSha()}`;

module.exports = {
  ...base,
  appId: 'com.interview.assistant.dev',
  productName: 'SkillCue Dev',
  directories: {
    ...base.directories,
    output: 'release-dev',
  },
  nsis: {
    ...base.nsis,
    artifactName: 'SkillCue-Dev-Setup.${ext}',
  },
  // A developer installer is private and never participates in public updates.
  publish: null,
  protocols: [
    {
      name: 'SkillCue Dev',
      schemes: ['skillcue-dev'],
    },
  ],
  extraMetadata: {
    ...(base.extraMetadata ?? {}),
    name: 'skillcue-dev',
    version: devVersion,
    buildChannel: 'dev',
  },
};
