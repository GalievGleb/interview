import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'HistoryPage.tsx'), 'utf8');
const analysisSource = fs.readFileSync(path.resolve(__dirname, 'SessionAnalysisPage.tsx'), 'utf8');
const appSource = fs.readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf8');

describe('history analysis and privacy behavior', () => {
  it('opens backend sessions on a dedicated review route', () => {
    expect(source).toContain('navigate(`/history/${encodeURIComponent(row.id)}`)');
    expect(appSource).toContain('path="/history/:sessionId"');
    expect(analysisSource).toContain('api.getSessionAnalysis(sessionId)');
  });

  it('can rebuild an old or incorrect analysis', () => {
    expect(analysisSource).toContain('api.createSessionAnalysis(sessionId, lang, force)');
    expect(analysisSource).toContain('saved.analysisVersion !== 2');
    expect(analysisSource).toContain('generate(Boolean(saved))');
    expect(analysisSource).toContain('saved.analysisLanguage !== lang');
  });

  it('reviews actual candidate answers and keeps generated hints separate', () => {
    expect(analysisSource).toContain("const reviews = analysis?.answerReviews ?? []");
    expect(analysisSource).toContain('review.candidateAnswer');
    expect(analysisSource).toContain('review.problems');
    expect(analysisSource).toContain('review.missingPoints');
    expect(analysisSource).toContain('Подсказки ИИ во время созвона — не учитываются в оценке');
  });

  it('does not render empty strength or growth columns for a short call', () => {
    expect(analysisSource).toContain('evidenceLayout.hasAny &&');
    expect(analysisSource).toContain('evidenceLayout.hasStrengths &&');
    expect(analysisSource).toContain('evidenceLayout.hasWeaknesses &&');
    expect(analysisSource).toContain("evidenceLayout.isSplit ? 'lg:grid-cols-2' : ''");
  });

  it('updates cached knowledge after deleting one or all sessions', () => {
    expect(source).toContain('refreshSessionKnowledge');
    expect(source).toContain('clearSessionKnowledge');
  });

  it('invalidates an in-flight session open before deleting one or all sessions', () => {
    const removeAt = source.indexOf('const remove = async');
    const removeAllAt = source.indexOf('const removeAll = async');
    expect(source.slice(removeAt, removeAllAt)).toContain('invalidatePendingOpen();');
    expect(source.slice(removeAllAt, source.indexOf('const exportData'))).toContain(
      'invalidatePendingOpen();',
    );
  });

  it('uses one focused empty state before the first saved session', () => {
    expect(source).toContain('!loading && rows.length === 0');
    expect(source).toContain('className="prep-history-zero"');
    expect(source).toContain('ПЕРВАЯ СЕССИЯ');
  });
});
