import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const landingRoot = path.join(projectRoot, 'landing');
const grantRoot = path.join(projectRoot, 'docs', 'grants');
const desktopPackagePath = path.join(projectRoot, 'apps', 'desktop', 'package.json');
const leadBotPath = path.join(projectRoot, 'tools', 'leadbot', 'leadbot.py');

const forbidden = [
  { label: 'устаревшее написание ScillCue', pattern: /\bScillCue\b/giu },
  { label: 'устаревший Telegram поддержки', pattern: /SkillCue_support_bot|t\.me\/skillcue_support\b/giu },
  { label: 'неактуальный публичный e-mail поддержки', pattern: /galievgleb99@gmail\.com/giu },
  { label: 'обещание скрытности от записи или демонстрации экрана', pattern: /скрыт\w* от (?:записи|демонстрации) экрана/giu },
  { label: 'позиционирование как незаметный читинг', pattern: /незаметн\w*[^\n]{0,40}чит/giu },
  { label: 'англоязычное обещание читинга', pattern: /cheat on/giu },
  { label: 'ложная штаб-квартира во Вьетнаме', pattern: /штаб-квартир\w* во вьетнаме/giu },
  { label: 'устаревшее упоминание Whisper', pattern: /\bWhisper\b/giu },
  { label: 'ложное обещание локальной обработки аудио', pattern: /(?:(?:полностью|обрабатывается|распозна[её]тся) локальн[^\n<]{0,80}(?:аудио|реч)|распознавание речи[^\n<]{0,50}локальн|raw audio[^\n]{0,80}stay[^\n]{0,30}device|on-device speech recognition)/giu },
];

const requiredLandingPhrases = [
  { label: 'подготовка', pattern: /подготов/iu },
  { label: 'пробное собеседование', pattern: /пробн[^<.\n]{0,20}собеседован/iu },
  { label: 'облачное распознавание', pattern: /облачн/iu },
  { label: 'ответственное использование', pattern: /ответственн/iu },
  { label: 'стадия MVP', pattern: /\bMVP\b/iu },
  { label: 'облачное распознавание OpenAI', pattern: /OpenAI/iu },
];

function listTextFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return listTextFiles(absolute);
    if (/^index\.(?:legacy-dark|prototype-full)\.html$/iu.test(entry.name)) return [];
    return /\.(?:html|md)$/iu.test(entry.name) ? [absolute] : [];
  });
}

function relative(file) {
  return path.relative(projectRoot, file).replaceAll('\\', '/');
}

function resolveLandingTarget(sourceFile, href) {
  const clean = href.split(/[?#]/u, 1)[0];
  if (!clean || clean === '/' || clean.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(clean)) return null;
  if (clean.startsWith('/downloads/')) return null;

  const base = clean.startsWith('/') ? landingRoot : path.dirname(sourceFile);
  let target = path.resolve(base, clean.replace(/^\//u, ''));
  if (target === landingRoot) target = path.join(target, 'index.html');
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  if (!path.extname(target)) target = `${target}.html`;
  return target;
}

const failures = [];
const desktopPackage = JSON.parse(fs.readFileSync(desktopPackagePath, 'utf8'));
if (desktopPackage.build?.publish?.repo !== 'SkillCue') {
  failures.push('apps/desktop/package.json: release repository must be named SkillCue');
}
if (desktopPackage.build?.productName !== 'SkillCue') {
  failures.push('apps/desktop/package.json: productName must preserve the SkillCue spelling');
}
if (desktopPackage.build?.protocols?.some((protocol) => protocol.name !== 'SkillCue')) {
  failures.push('apps/desktop/package.json: protocol display names must preserve the SkillCue spelling');
}
const leadBotContent = fs.readFileSync(leadBotPath, 'utf8');
if (!/GalievGleb\/SkillCue\/releases\/latest\/download\/SkillCue-Setup\.exe/u.test(leadBotContent)) {
  failures.push('tools/leadbot/leadbot.py: download URL must target GalievGleb/SkillCue');
}

const publicFiles = [path.join(projectRoot, 'README.md'), ...listTextFiles(landingRoot), ...listTextFiles(grantRoot)]
  .filter((file) => fs.existsSync(file));

const rootReadme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');
if (!rootReadme.startsWith('# SkillCue\n')) {
  failures.push('README.md: title must be SkillCue');
}

for (const filename of ['index.legacy-dark.html', 'index.prototype-full.html']) {
  if (fs.existsSync(path.join(landingRoot, filename))) {
    failures.push('landing/' + filename + ': archived prototypes must not be deployable');
  }
}

for (const file of publicFiles) {
  const content = fs.readFileSync(file, 'utf8');
  for (const rule of forbidden) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(content)) failures.push(`${relative(file)}: ${rule.label}`);
  }
}

const landingIndex = path.join(landingRoot, 'index.html');
const landingContent = fs.readFileSync(landingIndex, 'utf8');
const englishLanding = path.join(landingRoot, 'en', 'index.html');

if (!/<html\b[^>]*\bdata-theme=["']light["']/iu.test(landingContent)) {
  failures.push('landing/index.html: публичный лендинг должен открываться в светлой теме');
}
if (!/href=["']\/assets\/landing\.css(?:\?[^"']*)?["']/iu.test(landingContent)) {
  failures.push('landing/index.html: не подключен канонический светлый дизайн assets/landing.css');
}
if (!/src=["']\/assets\/landing\.js(?:\?[^"']*)?["']/iu.test(landingContent)) {
  failures.push('landing/index.html: не подключена интерактивность канонического лендинга assets/landing.js');
}
for (const requirement of requiredLandingPhrases) {
  if (!requirement.pattern.test(landingContent)) {
    failures.push(`landing/index.html: отсутствует обязательный смысловой блок «${requirement.label}»`);
  }
}

if (/id=["']live-materials-title["']/iu.test(landingContent)) {
  failures.push('landing/index.html: оверлей вынесен в отдельный промо-блок вместо второстепенной функции');
}
if (/id=["']founder["']|Глеб Галиев|один основатель/iu.test(landingContent)) {
  failures.push('landing/index.html: персональный founder-блок не должен дублировать статус MVP');
}
if (!/https:\/\/t\.me\/SkillCue\b/u.test(landingContent)) {
  failures.push('landing/index.html: отсутствует актуальный Telegram поддержки @SkillCue');
}
if (!/href=["']\/en\/["']/u.test(landingContent)) {
  failures.push('landing/index.html: отсутствует переключатель на English overview');
}
if (!fs.existsSync(englishLanding)) {
  failures.push('landing/en/index.html: отсутствует English overview для международных заявок');
} else {
  const englishContent = fs.readFileSync(englishLanding, 'utf8');
  for (const [label, pattern] of [
    ['MVP stage', /\bMVP\b/u],
    ['OpenAI cloud transcription', /OpenAI[\s\S]{0,120}cloud|cloud[\s\S]{0,120}OpenAI/iu],
    ['zero-user disclosure', /0 (?:external )?users/iu],
    ['responsible use', /responsible use/iu],
  ]) {
    if (!pattern.test(englishContent)) failures.push(`landing/en/index.html: missing ${label}`);
  }
}

for (const file of listTextFiles(landingRoot).filter((candidate) => candidate.endsWith('.html'))) {
  const content = fs.readFileSync(file, 'utf8');
  for (const match of content.matchAll(/(?:href|src|poster)\s*=\s*["']([^"']+)["']/giu)) {
    const target = resolveLandingTarget(file, match[1]);
    if (target && !fs.existsSync(target)) {
      failures.push(`${relative(file)}: не найден локальный ресурс ${match[1]}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Grant packaging checks failed:');
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Grant packaging checks passed');
