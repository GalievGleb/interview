/**
 * Печатная версия отчёта готовности: чистый HTML → диалог печати системы
 * (пользователь сохраняет в PDF). Через скрытый iframe, чтобы работать одинаково
 * в Electron и в браузере без window.open и настроек попапов.
 */
import type { ReadinessReport, VacancyAnalysis } from './types';
import { readinessLabelText } from './readiness';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function list(items: string[]): string {
  if (!items.length) return '<p class="muted">—</p>';
  return `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
}

export function buildReportHtml(analysis: VacancyAnalysis, report: ReadinessReport): string {
  const date = new Date(report.generatedAt).toLocaleDateString('ru-RU');
  const topics = report.topicScores
    .map(
      (t) => `<tr>
        <td>${esc(t.title)}</td>
        <td class="num">${t.score}</td>
        <td>${esc(t.missingPoints.join('; ') || '—')}</td>
      </tr>`,
    )
    .join('');
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>Готовность: ${esc(analysis.targetRole)}</title>
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; color: #17233b; margin: 32px; line-height: 1.45; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  h2 { font-size: 15px; margin: 22px 0 6px; text-transform: uppercase; letter-spacing: 0.04em; color: #3b4a68; }
  .score { font-size: 34px; font-weight: 700; }
  .muted { color: #6b7891; }
  .meta { color: #6b7891; font-size: 13px; margin-bottom: 14px; }
  ul { margin: 4px 0; padding-left: 20px; }
  li { margin: 2px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #d6dce8; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f2f5fa; }
  .num { text-align: center; font-weight: 700; white-space: nowrap; }
  .verdict { background: #f2f5fa; border-radius: 8px; padding: 12px 14px; margin-top: 6px; }
  @media print { body { margin: 12mm; } }
</style></head><body>
  <h1>Готовность к вакансии: ${esc(analysis.targetRole)}</h1>
  <p class="meta">SkillCue · отчёт мок-интервью · ${date}</p>
  <p><span class="score">${report.overallScore}/100</span> &nbsp; ${esc(readinessLabelText(report.status))}</p>
  ${
    report.narrativeVerdict
      ? `<h2>Вердикт коуча</h2><div class="verdict">${esc(report.narrativeVerdict)}${
          report.interviewerImpression
            ? `<p class="muted" style="margin:8px 0 0">Как вас видит интервьюер: ${esc(report.interviewerImpression)}</p>`
            : ''
        }</div>`
      : ''
  }
  <h2>Сильные стороны</h2>${list(report.strengths)}
  <h2>Слабые места</h2>${list(report.weakAreas)}
  <h2>Критичные пробелы</h2>${list(report.criticalGaps)}
  <h2>Темы по результатам ответов</h2>
  <table><thead><tr><th>Тема</th><th>Балл</th><th>Чего не хватило</th></tr></thead><tbody>${topics}</tbody></table>
  <h2>План подготовки</h2>${list(report.nextPracticePlan)}
</body></html>`;
}

export function printReadinessReport(analysis: VacancyAnalysis, report: ReadinessReport): void {
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(buildReportHtml(analysis, report));
  doc.close();
  // Даём макету отрисоваться, затем печать; iframe убираем после диалога.
  setTimeout(() => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    setTimeout(() => iframe.remove(), 60_000);
  }, 150);
}
