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
const mainSource = fs.readFileSync(path.resolve(__dirname, '../../electron/main.ts'), 'utf8');
const preloadSource = fs.readFileSync(path.resolve(__dirname, '../../electron/preload.ts'), 'utf8');
const cssSource = fs.readFileSync(
  path.resolve(__dirname, '../styles/overlay-cockpit.css'),
  'utf8',
);

describe('overlay request behavior', () => {
  it('blocks live before opening sockets when the licence has no live entitlement', () => {
    expect(overlaySource).toContain("const liveBlocked = license?.live_allowed === false");
    expect(overlaySource).toContain("setNotice(t('overlay.rec.needLicense'))");
    expect(overlaySource).toContain("overlay.openSettings?.('billing')");
  });

  it('shows live startup failures instead of silently returning to the record button', () => {
    expect(overlaySource).toMatch(/\{error && \([\s\S]*?role="alert"[\s\S]*?\{error\}/);
    expect(overlaySource).toContain('if (!active && error) void refreshLicense();');
  });

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
    expect(hookSource).toContain('speechActivityRef.current.snapshot()');
    expect(hookSource).toContain('unconsumedForcedFinals');
    expect(hookSource).toContain('selectForceTargetSource(');
  });

  it('treats a partial transcript as active speech for source selection', () => {
    const partialAt = hookSource.indexOf('if (!isFinal) {');
    expect(partialAt).toBeGreaterThan(-1);
    expect(hookSource.slice(partialAt, partialAt + 260)).toContain(
      'speechActivityRef.current.partial(source)',
    );
  });

  it('forces the active utterance to finish instead of reusing the previous final', () => {
    expect(hookSource).toContain(
      'Boolean(targetSource && speechActivity[targetSource])',
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
    expect(hookSource).toContain("forceSnapshot.phase === 'screen-fallback'");
    expect(overlaySource).toContain('forceScreenFallbackOwnerRef');
    expect(overlaySource).toContain('cancelOwnedForceScreenFallback(forceGeneration)');
  });

  it('keeps all overlay cards reachable in one vertical scroll area', () => {
    expect(overlaySource).toContain('className="ovl-stack"');
    expect(cssSource).toMatch(/\.ovl-stack\s*\{[^}]*overflow-y:\s*auto/s);
    expect(cssSource).toMatch(/\.ovl-stack\s*\{[^}]*min-height:\s*0/s);
  });

  it('keeps the live transcript at the latest line without defeating manual scroll', () => {
    expect(overlaySource).toContain('ref={transcriptScrollRef}');
    expect(overlaySource).toContain('onScroll={handleTranscriptScroll}');
    expect(overlaySource).toContain('distanceFromBottom <= 24');
    expect(overlaySource).toContain(
      'if (transcriptFollowsTailRef.current) scroller.scrollTop = scroller.scrollHeight',
    );
    expect(cssSource).toMatch(/\.ovl-transcript\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
    expect(cssSource).toMatch(/\.ovl-transcript\s*\{[^}]*overscroll-behavior:\s*contain/s);
  });

  it('keeps calendar context internal instead of covering the call with its title', () => {
    expect(overlaySource).toContain('const linkedEvent = interviewContext');
    expect(overlaySource).not.toContain('<strong>{interviewContext.companyName}</strong>');
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

  it('does not generate from plain Enter in the textarea', () => {
    expect(overlaySource).not.toContain(
      "e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey",
    );
    expect(overlaySource).toContain("onClick={() => submitForcedAnswer('button')}");
  });

  it('keeps typed instructions instead of replacing them with an empty screen fallback', () => {
    expect(overlaySource).toContain("runAction('assist', custom)");
    expect(overlaySource).toContain('const custom = input.trim()');
    expect(overlaySource).not.toContain('forceAnswer(input)');
  });

  it('uses native global movement without a duplicate renderer move', () => {
    expect(overlaySource).not.toContain("mod && !e.shiftKey && e.key.startsWith('Arrow')");
    expect(mainSource).toContain('move: moveOverlay');
  });

  it('distinguishes renderer and global shortcut duplicates', () => {
    expect(overlaySource).toContain("submitForcedAnswer('renderer')");
    expect(overlaySource).toContain("submitForcedAnswer('global')");
  });

  it('never starts an answer from speech recognition without Ctrl+Enter', () => {
    expect(hookSource).not.toContain('scheduleSpeechFinal(trimmed, speaker');
    expect(hookSource).not.toContain('scheduleFinalFallback(trimmed, speaker');
    const utteranceEndAt = hookSource.indexOf('onUtteranceEnd:');
    const lowQualityAt = hookSource.indexOf('onLowQuality:', utteranceEndAt);
    expect(utteranceEndAt).toBeGreaterThan(-1);
    expect(hookSource.slice(utteranceEndAt, lowQualityAt)).not.toContain('flushQuestion()');
    expect(hookSource).toContain('Manual-only policy');
  });

  it('opens the detailed real-answer review in the main window', () => {
    expect(overlaySource).toContain('overlay.openSessionAnalysis?.(recap.sessionId!)');
    expect(preloadSource).toContain("ipcRenderer.invoke('overlay:openSessionAnalysis', sessionId)");
    expect(mainSource).toContain("mainWindow.webContents.send('app:navigate', `/history/${encodeURIComponent(sessionId)}`)");
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

  it('keeps a dismissible quick guide available after first launch', () => {
    expect(overlaySource).toContain('skillcue.overlayQuickGuideSeen.v1');
    expect(overlaySource).toContain('Ctrl+Enter');
    expect(overlaySource).toContain('Ctrl+Shift+H');
    expect(overlaySource).toContain('setShowQuickGuide(true)');
    expect(overlaySource).toContain('localStorage.setItem(QUICK_GUIDE_KEY');
  });

  it('offers explicit persisted analysis after the session ends', () => {
    expect(overlaySource).toContain("['analysis', t('overlay.recap.tab.analysis')]");
    expect(overlaySource).toContain('api.createSessionAnalysis(requestSessionId');
    expect(overlaySource).toContain("t('overlay.recap.analyze')");
    expect(overlaySource).toContain('refreshSessionKnowledge');
  });

  it('stores a compact outcome for a linked calendar call without replacing it with a generic analysis', () => {
    expect(overlaySource).toContain("setRecapTab('summary')");
    expect(overlaySource).toContain('if (linkedEvent && endedSessionId)');
    expect(overlaySource).toContain(
      'void generateInterviewOutcome(snapshot, endedSessionId, linkedEvent)',
    );
    expect(overlaySource).toContain('api.interviewOutcome({');
    expect(overlaySource).toContain('interviewCalendar?.saveOutcome(event.id, saved)');
    expect(overlaySource).toContain('if (endedSessionId) void requestRecapAnalysis(endedSessionId)');
  });

  it('persists one reusable full analysis after every ended session, including calendar calls', () => {
    const openRecapAt = overlaySource.indexOf('const openRecap = useCallback');
    const closeRecapAt = overlaySource.indexOf('const closeRecap = useCallback', openRecapAt);
    const openRecapSource = overlaySource.slice(openRecapAt, closeRecapAt);
    const summaryBranchEnd = openRecapSource.indexOf('generateSummary(snapshot);');
    const analysisAt = openRecapSource.indexOf(
      'if (endedSessionId) void requestRecapAnalysis(endedSessionId);',
    );

    expect(summaryBranchEnd).toBeGreaterThan(-1);
    expect(analysisAt).toBeGreaterThan(summaryBranchEnd);
    expect(openRecapSource.match(/requestRecapAnalysis\(endedSessionId\)/g)).toHaveLength(1);
  });

  it('reuses the calendar session when starting again or changing audio sources', () => {
    expect(overlaySource).toContain('sessionId: linkedEvent?.sessionId');
    expect(overlaySource).toContain('const linkedSessionId = sessionId ?? linkedEvent?.sessionId');
    expect(overlaySource).toContain('sessionId: linkedSessionId');
    expect(overlaySource).toContain('interviewCalendar?.attachSession(');
  });

  it('keeps the ended session id in the recap snapshot', () => {
    expect(overlaySource).toContain('const endedSessionId = sessionId');
    expect(overlaySource).toContain('sessionId: endedSessionId');
  });

  it('opens a finished hidden overlay as a clean new practice while preserving an active call', () => {
    expect(overlaySource).toContain('overlay.onOpenRequested?.(() => {');
    expect(overlaySource).toContain('if (!active) resetInactiveOverlay()');
    expect(overlaySource).toContain('setRecap(null)');
    expect(overlaySource).toContain('setUsageLog([])');
    expect(overlaySource).not.toContain('setCollapsed(');
  });

  it('starts at sixty-percent opacity and ships without floating shadows', () => {
    expect(overlaySource).toContain('return saved === null ? 60');
    const shadows = [...cssSource.matchAll(/box-shadow:\s*([^;]+);/g)].map((match) => match[1].trim());
    expect(shadows.length).toBeGreaterThan(0);
    expect(shadows.every((value) => value === 'none')).toBe(true);
  });

  it('keeps the top pill limited to app identity and recording', () => {
    expect(overlaySource).toContain('className="ovl-logo tip"');
    expect(overlaySource).toContain('className={`ovl-rec tip');
    expect(overlaySource).not.toContain('className="ovl-pill-btn tip"');
    expect(overlaySource).not.toContain('className="ovl-hide-caret');
  });

  it('receives global answer scrolling from the native window', () => {
    expect(overlaySource).toContain('overlay.onScroll?.((direction) => scrollOverlayContent(direction))');
    expect(preloadSource).toContain("ipcRenderer.on('overlay:scroll', handler)");
    expect(mainSource).toContain("win.webContents.send('overlay:scroll', direction)");
  });

  it('restores the same renderer state after the global visibility toggle', () => {
    const toggleAt = mainSource.indexOf('function toggleOverlay(): void');
    const retryAt = mainSource.indexOf('function scheduleToggleOverlayShortcutRetry', toggleAt);
    const toggleSource = mainSource.slice(toggleAt, retryAt);
    expect(toggleSource).toContain('else showOverlayWindow(win);');
    expect(toggleSource).not.toContain('prepareOverlayForOpen(win)');
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

  it('hides empty analysis groups and expands the only known group', () => {
    expect(overlaySource).toContain('analysisEvidenceLayout.hasAny &&');
    expect(overlaySource).toContain('analysisEvidenceLayout.hasStrengths &&');
    expect(overlaySource).toContain('analysisEvidenceLayout.hasWeaknesses &&');
    expect(overlaySource).toContain("' ovl-analysis-columns--single'");
    expect(overlaySource).toContain('analysis.topicAssessments.length > 0 &&');
    expect(cssSource).toContain('.ovl-analysis-columns--single');
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
