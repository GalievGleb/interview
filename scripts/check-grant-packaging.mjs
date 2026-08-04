import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const landingRoot = path.join(projectRoot, 'landing');
const grantRoot = path.join(projectRoot, 'docs', 'grants');

const forbidden = [
  { label: 'обещание скрытности от записи или демонстрации экрана', pattern: /скрыт\w* от (?:записи|демонстрации) экрана/giu },
  { label: 'позиционирование как незаметный читинг', pattern: /незаметн\w*[^\n]{0,40}чит/giu },
  { label: 'англоязычное обещание читинга', pattern: /cheat on/giu },
  { label: 'ложная штаб-квартира во Вьетнаме', pattern: /штаб-квартир\w* во вьетнаме/giu },
];

const requiredLandingPhrases = [
  { label: 'подготовка', pattern: /подготов/iu },
  { label: 'пробное собеседование', pattern: /пробн\w* собеседован/iu },
  { label: 'локальная обработка', pattern: /локальн/iu },
  { label: 'ответственное использование', pattern: /ответственн/iu },
  { label: 'стадия MVP', pattern: /\bMVP\b/iu },
];

function listTextFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return listTextFiles(absolute);
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
  if (!path.extname(target)) target = `${target}.html`;
  return target;
}

const failures = [];
const publicFiles = [path.join(projectRoot, 'README.md'), ...listTextFiles(landingRoot), ...listTextFiles(grantRoot)]
  .filter((file) => fs.existsSync(file));

for (const file of publicFiles) {
  const content = fs.readFileSync(file, 'utf8');
  for (const rule of forbidden) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(content)) failures.push(`${relative(file)}: ${rule.label}`);
  }
}

const landingIndex = path.join(landingRoot, 'index.html');
const landingContent = fs.readFileSync(landingIndex, 'utf8');
for (const requirement of requiredLandingPhrases) {
  if (!requirement.pattern.test(landingContent)) {
    failures.push(`landing/index.html: отсутствует обязательный смысловой блок «${requirement.label}»`);
  }
}

for (const file of listTextFiles(landingRoot).filter((candidate) => candidate.endsWith('.html'))) {
  const content = fs.readFileSync(file, 'utf8');
  for (const match of content.matchAll(/href\s*=\s*["']([^"']+)["']/giu)) {
    const target = resolveLandingTarget(file, match[1]);
    if (target && !fs.existsSync(target)) {
      failures.push(`${relative(file)}: не найдена локальная ссылка ${match[1]}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Grant packaging checks failed:');
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Grant packaging checks passed');
