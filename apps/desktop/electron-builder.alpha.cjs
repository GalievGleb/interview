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
const alphaVersion = `${nextPatchVersion(packageJson.version)}-alpha.g${gitShortSha()}`;

module.exports = {
  ...base,
  appId: 'com.interview.assistant.alpha',
  productName: 'SkillCue Alpha',
  directories: {
    ...base.directories,
    output: 'release-alpha',
  },
  nsis: {
    ...base.nsis,
    artifactName: 'SkillCue-Alpha-Setup.${ext}',
  },
  extraResources: [
    ...(base.extraResources ?? []),
    {
      from: '../../tests/stt-benchmark/cases.json',
      to: 'tests/stt-benchmark/cases.json',
    },
    {
      from: '../../tests/voice/audio',
      to: 'tests/voice/audio',
      filter: ['*.wav'],
    },
  ],
  publish: null,
  protocols: [
    {
      name: 'SkillCue Alpha',
      schemes: ['skillcue-alpha'],
    },
  ],
  extraMetadata: {
    ...(base.extraMetadata ?? {}),
    name: 'skillcue-alpha',
    version: alphaVersion,
    buildChannel: 'alpha',
  },
};
