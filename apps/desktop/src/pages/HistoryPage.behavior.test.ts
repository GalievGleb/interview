import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'HistoryPage.tsx'), 'utf8');
const analysisSource = fs.readFileSync(path.resolve(__dirname, 'SessionAnalysisPage.tsx'), 'utf8');
const appSource = fs.readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf8');

describe('history analysis and privacy behavior', () => {
  it('opens backend sessions on a dedicated review route', () => {
    expect(source).toContain('navigate(`/history/${encodeURIComponent(session.id)}`)');
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
    expect(analysisSource).toContain("(analysis?.answerReviews ?? []).filter");
    expect(analysisSource).toContain('review.candidateAnswer');
    expect(analysisSource).toContain('review.problems');
    expect(analysisSource).toContain('review.missingPoints');
    expect(analysisSource).toContain("ru ? 'Подсказки помощника' : 'Assistant hints'");
    expect(analysisSource).toContain("ru ? 'Не учитываются в оценке.' : 'Excluded from the assessment.'");
  });

  it('does not render empty strength or growth columns for a short call', () => {
    expect(analysisSource).toContain('evidenceLayout.hasAny &&');
    expect(analysisSource).toContain('evidenceLayout.hasStrengths &&');
    expect(analysisSource).toContain('evidenceLayout.hasWeaknesses &&');
    expect(analysisSource).toContain("evidenceLayout.isSplit ? 'is-split' : ''");
    expect(analysisSource).toContain('Недостаточно данных для оценки');
    expect(analysisSource).toContain('reliableScore &&');
    expect(analysisSource).toContain('hasRoleSeparationWarning');
    expect(analysisSource).toContain('!roleSeparationWarning');
  });

  it('updates cached knowledge after deleting one or all sessions', () => {
    expect(source).toContain('refreshSessionKnowledge');
    expect(source).toContain('clearSessionKnowledge');
  });

  it('confirms destructive deletion for one or all interviews', () => {
    expect(source).toContain("title={deleteTarget === 'all' ? 'Очистить историю?' : 'Удалить интервью?'}");
    expect(source).not.toContain('window.confirm');
    expect(source).toContain('api.deleteAllSessions()');
  });

  it('uses one focused empty state before the first saved session', () => {
    expect(source).toContain('sessions.length === 0');
    expect(source).toContain('className="practice-empty"');
    expect(source).toContain('Истории пока нет');
  });

  it('reloads history after the bundled backend finishes a cold start', () => {
    expect(source).toContain('const { backendOnline } = useApp()');
    expect(source).toContain('initialLoadStartedRef');
    expect(source).toContain('if (!initialLoadStartedRef.current || backendOnline)');
  });
});
