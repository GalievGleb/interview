import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'HistoryPage.tsx'), 'utf8');
const settingsSource = fs.readFileSync(path.resolve(__dirname, 'SettingsPage.tsx'), 'utf8');

describe('history analysis and privacy behavior', () => {
  it('reopens and renders persisted analysis for a selected session', () => {
    expect(source).toContain('api.getSessionAnalysis(id)');
    expect(source).toContain('selectedAnalysis');
    expect(source).toContain('<MarkdownText text={selectedAnalysis.markdown}');
  });

  it('can create or retry an AI analysis from the selected session', () => {
    expect(source).toContain('api.createSessionAnalysis(selected.id');
    expect(source).toContain("t('history.analysis.create')");
    expect(source).toContain('analysisError');
  });

  it('updates cached knowledge after deleting one or all sessions', () => {
    expect(source).toContain('refreshSessionKnowledge');
    expect(source).toContain('clearSessionKnowledge');
    expect(settingsSource).toContain('clearSessionKnowledge();');
  });

  it('invalidates an in-flight session open before deleting one or all sessions', () => {
    const removeAt = source.indexOf('const remove = async');
    const removeAllAt = source.indexOf('const removeAll = async');
    expect(source.slice(removeAt, removeAllAt)).toContain('invalidatePendingOpen();');
    expect(source.slice(removeAllAt, source.indexOf('const exportData'))).toContain(
      'invalidatePendingOpen();',
    );
  });
});
