import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const overlaySource = fs.readFileSync(path.resolve(__dirname, 'OverlayPage.tsx'), 'utf8');
const hookSource = fs.readFileSync(
  path.resolve(__dirname, '../hooks/useLiveCopilot.ts'),
  'utf8',
);
const apiSource = fs.readFileSync(path.resolve(__dirname, '../lib/api.ts'), 'utf8');
const ruSource = fs.readFileSync(path.resolve(__dirname, '../lib/i18n/ru.ts'), 'utf8');
const cssSource = fs.readFileSync(
  path.resolve(__dirname, '../styles/overlay-cockpit.css'),
  'utf8',
);

describe('overlay request behavior', () => {
  it('routes typed requests without silently capturing the screen', () => {
    expect(overlaySource).toContain('resolveOverlayRequestRoute');
  });

  it('does not block a second Ctrl+Enter behind forcePendingRef', () => {
    expect(hookSource).toContain('forceCoordinatorRef.current.press');
    expect(hookSource).not.toContain("if (forcePendingRef.current) return 'finalizing'");
  });

  it('stores final transcript before deciding whether it may answer', () => {
    const appendAt = hookSource.indexOf('appendLine(trimmed, true, speaker)');
    const acceptAt = hookSource.indexOf('forceCoordinatorRef.current.acceptFinal');
    expect(appendAt).toBeGreaterThan(-1);
    expect(acceptAt).toBeGreaterThan(appendAt);
  });

  it('records finals from both audio sources for explicit Ctrl+Enter', () => {
    expect(hookSource).toContain('forcedFinalLedgerRef');
    expect(hookSource).toContain('appendForcedFinal(trimmed, source)');
    const appendAt = hookSource.indexOf('appendForcedFinal(trimmed, source)');
    const nonTriggerAt = hookSource.indexOf('if (speaker !== triggerSpeakerRef.current)', appendAt);
    expect(appendAt).toBeGreaterThan(-1);
    expect(nonTriggerAt).toBeGreaterThan(appendAt);
  });

  it('selects the forced source from speech activity and unconsumed finals', () => {
    expect(hookSource).toContain('speechInProgressRef.current');
    expect(hookSource).toContain('unconsumedForcedFinals');
    expect(hookSource).toContain('selectForceTargetSource(');
  });

  it('treats a partial transcript as active speech for source selection', () => {
    const partialAt = hookSource.indexOf('if (!isFinal) {');
    expect(partialAt).toBeGreaterThan(-1);
    expect(hookSource.slice(partialAt, partialAt + 260)).toContain(
      'speechInProgressRef.current[source] = true',
    );
  });

  it('falls back to the screen when forced speech has no final transcript', () => {
    expect(hookSource).toContain('forceScreenFallbackGeneration');
    expect(overlaySource).toContain('forceScreenFallbackGeneration');
    expect(overlaySource).toContain("void runScreenAssist('', smart ? 'deep' : 'general')");
    expect(overlaySource).not.toContain("text: `⚠ ${t('overlay.forceUnavailable')}`");
  });

  it('invalidates a pending screen capture when a newer Ctrl+Enter starts', () => {
    expect(overlaySource).toContain('screenAssistGenerationRef');
    const captureAt = overlaySource.indexOf('const image = await capture()');
    expect(captureAt).toBeGreaterThan(-1);
    expect(overlaySource.slice(captureAt, captureAt + 240)).toContain(
      'if (requestGeneration !== screenAssistGenerationRef.current) return;',
    );
    const forceAt = overlaySource.indexOf('const submitForcedAnswer');
    expect(forceAt).toBeGreaterThan(-1);
    expect(overlaySource.slice(forceAt, forceAt + 520)).toContain(
      'screenAssistGenerationRef.current += 1;',
    );
  });

  it('cancels the same-generation screen fallback when the delayed transcript arrives', () => {
    expect(hookSource).toContain('forceCoordinatorRef.current.beginScreenFallback(generation)');
    expect(overlaySource).toContain('forceScreenFallbackOwnerRef');
    expect(overlaySource).toContain('cancelOwnedForceScreenFallback(forceGeneration)');
  });

  it('keeps all overlay cards reachable in one vertical scroll area', () => {
    expect(overlaySource).toContain('className="ovl-stack"');
    expect(cssSource).toMatch(/\.ovl-stack\s*\{[^}]*overflow-y:\s*auto/s);
    expect(cssSource).toMatch(/\.ovl-stack\s*\{[^}]*min-height:\s*0/s);
  });

  it('uses deep screen analysis for forced fallback when Smart is enabled', () => {
    const fallbackCalls = overlaySource.match(
      /runScreenAssist\('', smart \? 'deep' : 'general'\)/g,
    );
    expect(fallbackCalls).toHaveLength(2);
  });

  it('replaces the pending card on every forced generation', () => {
    expect(overlaySource).toContain('forceGeneration');
    expect(overlaySource).toContain("request: currentQuestion || t('overlay.forceRequest')");
    expect(overlaySource).not.toContain("setNotice(t('overlay.forceSent'))");
  });

  it('does not submit both the textarea action and the Ctrl+Enter hotkey', () => {
    expect(overlaySource).toContain(
      "e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey",
    );
  });

  it('treats typed Ctrl+Enter as the newest forced generation', () => {
    expect(overlaySource).toContain('forceAnswer(input)');
    expect(overlaySource).not.toContain("if (input.trim()) {\n      runAction('assist', input)");
  });

  it('distinguishes renderer and global shortcut duplicates', () => {
    expect(overlaySource).toContain("submitForcedAnswer('renderer')");
    expect(overlaySource).toContain("submitForcedAnswer('global')");
  });

  it('marks normally processed transcript finals as handled', () => {
    expect(hookSource).toContain('forceCoordinatorRef.current.markHandled(sequence)');
  });

  it('consumes a normal final only after the automatic pipeline accepts it', () => {
    const acceptedAt = hookSource.indexOf('const accepted = requestSuggestion');
    const markAt = hookSource.indexOf('markPendingTriggerHandled();', acceptedAt);
    expect(acceptedAt).toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(acceptedAt);
    expect(hookSource.slice(acceptedAt, markAt)).toContain('if (accepted)');
  });

  it('snapshots whether the ending session has content before another session can start', () => {
    const snapshotAt = hookSource.indexOf('const sessionHasContent = hasSessionContentRef.current');
    const drainAt = hookSource.indexOf('transcriptWriteQueueRef.current.drain(sid)');
    expect(snapshotAt).toBeGreaterThan(-1);
    expect(drainAt).toBeGreaterThan(snapshotAt);
    expect(hookSource.slice(drainAt, drainAt + 240)).toContain('if (sessionHasContent)');
  });

  it('ignores metadata from a superseded stream generation', () => {
    const metaAt = hookSource.indexOf('onMeta: (correctionMeta) => {');
    expect(metaAt).toBeGreaterThan(-1);
    expect(hookSource.slice(metaAt, metaAt + 140)).toContain(
      'if (gen !== streamGenRef.current) return;',
    );
  });

  it('uses explicit hit regions for an always-on transparent-pixel policy', () => {
    expect(overlaySource).toContain('new OverlayPointerController');
    expect(overlaySource).toContain('pointerControllerRef.current?.refresh()');
    expect(overlaySource).toContain('data-overlay-hit="true"');
    expect(overlaySource).not.toContain("if (!avoidFocus) {\n      void ct(false)");
  });

  it('renders one delegated tooltip layer and a fixed clamped main menu', () => {
    expect(overlaySource).toContain('<OverlayTooltipLayer rootRef={rootRef} />');
    expect(overlaySource).toContain('clampFloatingPanel(');
    expect(overlaySource).toContain('ref={menuPanelRef}');
    expect(overlaySource).toContain("position: 'fixed'");
  });

  it('offers explicit persisted analysis after the session ends', () => {
    expect(overlaySource).toContain("['analysis', t('overlay.recap.tab.analysis')]");
    expect(overlaySource).toContain('api.createSessionAnalysis(requestSessionId');
    expect(overlaySource).toContain("t('overlay.recap.analyze')");
    expect(overlaySource).toContain('refreshSessionKnowledge');
  });

  it('starts the persisted AI analysis automatically when a live session ends', () => {
    expect(overlaySource).toContain("setRecapTab(endedSessionId ? 'analysis' : 'summary')");
    expect(overlaySource).toContain('void requestRecapAnalysis(endedSessionId)');
  });

  it('keeps the ended session id in the recap snapshot', () => {
    expect(overlaySource).toContain('const endedSessionId = sessionId');
    expect(overlaySource).toContain('sessionId: endedSessionId');
  });

  it('does not create an analysis without a persisted session id', () => {
    expect(overlaySource).toContain('if (!recap?.sessionId)');
    expect(overlaySource).toContain("t('overlay.recap.analysisUnavailable')");
  });

  it('supports loading, retry, and evidence-based analysis rendering', () => {
    expect(overlaySource).toContain('analysisLoading');
    expect(overlaySource).toContain('analysisError');
    expect(overlaySource).toContain("t('overlay.recap.retryAnalysis')");
    expect(overlaySource).toContain('analysis.strengths.map');
    expect(overlaySource).toContain('analysis.weaknesses.map');
    expect(overlaySource).toContain('analysis.topicAssessments.map');
    expect(cssSource).toContain('.ovl-analysis-score-fill');
  });

  it('uses persisted analysis endpoints with a long creation timeout', () => {
    expect(apiSource).toContain('export interface SessionAssessment');
    expect(apiSource).toContain('createSessionAnalysis:');
    expect(apiSource).toContain('getSessionAnalysis:');
    expect(apiSource).toContain('timeoutMs: LONG_REQUEST_TIMEOUT_MS');
  });

  it('ships Russian analysis copy', () => {
    expect(ruSource).toContain("'overlay.recap.analyze': 'Разобрать сессию'");
    expect(ruSource).toContain("'overlay.recap.strengths': 'Сильные стороны'");
    expect(ruSource).toContain("'overlay.recap.weaknesses': 'Что улучшить'");
  });

  it('uses the configured answer language for the analysis', () => {
    expect(overlaySource).toContain('answerLanguageParam() ?? lang');
  });

  it('does not let an old analysis request overwrite a newer recap', () => {
    expect(overlaySource).toContain('analysisRequestGenerationRef');
    expect(overlaySource).toContain('const requestGeneration = ++analysisRequestGenerationRef.current');
    expect(overlaySource).toContain(
      'if (requestGeneration !== analysisRequestGenerationRef.current) return;',
    );
    const requestAnalysisAt = overlaySource.indexOf('const requestRecapAnalysis');
    const refreshAt = overlaySource.indexOf('void refreshSessionKnowledge()', requestAnalysisAt);
    const staleGuardAt = overlaySource.indexOf(
      'if (requestGeneration !== analysisRequestGenerationRef.current) return;',
      requestAnalysisAt,
    );
    expect(refreshAt).toBeGreaterThan(-1);
    expect(staleGuardAt).toBeGreaterThan(refreshAt);
  });
});
