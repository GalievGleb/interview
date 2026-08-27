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
const enSource = fs.readFileSync(path.resolve(__dirname, '../lib/i18n/en.ts'), 'utf8');
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

  it('starts live without blocking on readiness and still surfaces startup failures', () => {
    expect(overlaySource).toMatch(/\{error && \([\s\S]*?role="alert"[\s\S]*?\{error\}/);
    expect(overlaySource).toContain('if (!active && error) void refreshLicense();');
    expect(overlaySource).toContain('void liveStartupWarmup.warm();');
    expect(overlaySource).not.toContain('const readiness = await api.providerReadiness();');
    expect(overlaySource).not.toContain('Проверяю ИИ перед созвоном…');
    expect(overlaySource).toContain('Завершить созвон и запись');
    expect(overlaySource).toContain("license?.plan === 'trial'");
  });

  it('shows silent requested system audio as a non-fatal warning only', () => {
    expect(hookSource).toContain('sourceHealthWarning');
    expect(overlaySource).toContain("t('overlay.sourceHealth.systemSilent')");
    expect(ruSource).toContain("'overlay.sourceHealth.systemSilent'");
    expect(enSource).toContain("'overlay.sourceHealth.systemSilent'");

    const warningAt = overlaySource.indexOf("t('overlay.sourceHealth.systemSilent')");
    const warningUi = overlaySource.slice(Math.max(0, warningAt - 300), warningAt + 300);
    expect(warningUi).toContain('role="status"');
    expect(warningUi).not.toContain('onClick');
    expect(warningUi).not.toContain('stopSession');
    expect(warningUi).not.toContain('setSources');
    expect(warningUi).not.toContain('forceAnswer');
  });

  it('tags source-handler diagnostics independently from the displayed speaker', () => {
    expect(hookSource).toContain("withAudioSource(source, { speaker })");
    const lowQualityAt = hookSource.indexOf('onLowQuality:');
    const lowQualityBody = hookSource.slice(lowQualityAt, lowQualityAt + 1500);
    expect(lowQualityBody).toContain('withAudioSource(source, {');
    expect(lowQualityBody).toContain('speaker,');
    expect(lowQualityBody).toContain('meta: toSttDiagnosticMeta(metadata)');
    expect(hookSource).not.toContain(
      "debugRef.current.event('low_quality', { text: question, reason })",
    );
    expect(hookSource).toContain("'source_warning',");
    expect(hookSource).toContain("'source_recovered',");
  });

  it('starts health timing after capture permission and schedules the exact deadline', () => {
    expect(hookSource).toContain('onCaptureReady:');
    expect(hookSource).toContain('sourceHealthRef.current.markCaptureReady(');
    expect(hookSource).toContain('sourceHealthRef.current.nextEvaluationAtMs()');
    expect(hookSource).toContain('sourceHealthTimerRef');
    expect(hookSource).not.toContain(
      'applySourceHealthResult(sourceHealthRef.current.markReady(source))',
    );
  });

  it('invalidates source health when a fatal source removal stops that stream', () => {
    const removeStart = hookSource.indexOf('const removeStream = useCallback');
    const removeEnd = hookSource.indexOf('const runStream = useCallback', removeStart);
    const removeBody = hookSource.slice(removeStart, removeEnd);

    expect(removeBody).toContain(
      'updateSourceHealth(sourceHealthRef.current.markSourceRemoved(source))',
    );
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
    expect(hookSource).toContain('appendForcedFinal(trimmed, source, metadata)');
    const appendAt = hookSource.indexOf('appendForcedFinal(trimmed, source, metadata)');
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

  it('does not let noisy VAD hide an already finalized Ctrl+Enter question', () => {
    expect(hookSource).toContain('shouldFinalizeCurrentSpeech(');
    expect(hookSource).toContain('unconsumedForcedFinals');
  });

  it('stabilizes a recent final so a split continuation stays in one Ctrl+Enter question', () => {
    expect(hookSource).toContain('latestUnconsumedFinal?.receivedAt');
    expect(hookSource).toContain('FORCE_PREFIX_STABILIZATION_MS');
    expect(hookSource).toContain('commitFinalizedPrefix');
  });

  it('keeps Ctrl+Enter on the conversation path while its final transcript is delayed', () => {
    expect(hookSource).toContain('forceScreenFallback');
    expect(overlaySource).toContain('forceScreenFallback');
    expect(hookSource).toContain('notifyDelayedForcedTranscript');
    expect(hookSource).not.toContain(
      'forceCoordinatorRef.current.beginScreenFallback(scheduledGeneration)',
    );
    const forceAt = overlaySource.indexOf('const submitForcedAnswer');
    const forceBody = overlaySource.slice(forceAt, forceAt + 900);
    expect(forceBody).toContain("setNotice(t('overlay.forceUnavailable'))");
    expect(forceBody).not.toContain("runScreenAssist('', smart ? 'deep' : 'general'");
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

  it('reserves screen fallback ownership for explicit visual questions', () => {
    expect(hookSource).toContain('routeVisualQuestionToScreen');
    expect(hookSource).toContain("forceSnapshot.phase === 'screen-fallback'");
    expect(hookSource).toContain("if (decision.action !== 'submit')");
    expect(overlaySource).toContain('forceScreenFallbackOwnerRef');
    expect(overlaySource).toContain("forcePhase === 'waiting-first-token'");
    expect(overlaySource).toContain('cancelOwnedForceScreenFallback(ownedGeneration)');
  });

  it('commits the first nonempty screen chunk before rendering it', () => {
    expect(hookSource).toContain('commitScreenFirstOutput');
    const chunkAt = overlaySource.indexOf('onChunk: (t) => {', overlaySource.indexOf('streamScreenAssist'));
    const chunkSource = overlaySource.slice(chunkAt, chunkAt + 800);
    expect(chunkSource).toContain('commitScreenFirstOutput');
    expect(chunkSource.indexOf('commitScreenFirstOutput')).toBeLessThan(
      chunkSource.indexOf('setExchange'),
    );
  });

  it('keeps a long visual question from squeezing the streamed answer out of view', () => {
    const rules = Array.from(cssSource.matchAll(/\.ovl-(?:bubble|answer-body)\s*\{[\s\S]*?\}/g))
      .map((match) => match[0]);
    const bubbleRule = rules.find((rule) => rule.startsWith('.ovl-bubble') && rule.includes('@apply')) ?? '';
    const answerRule = rules.find((rule) => rule.startsWith('.ovl-answer-body') && rule.includes('@apply')) ?? '';

    expect(bubbleRule).toContain('max-height:');
    expect(bubbleRule).toContain('overflow-y: auto');
    expect(answerRule).toContain('min-height:');
  });

  it('revalidates every forced-screen chunk instead of trusting a prior commit', () => {
    const chunkAt = overlaySource.indexOf('onChunk: (t) => {', overlaySource.indexOf('streamScreenAssist'));
    const chunkSource = overlaySource.slice(chunkAt, chunkAt + 900);
    expect(chunkSource).toContain('commitScreenFirstOutput(forceOwner.generation');
    expect(chunkSource).not.toContain("forceChunkAuthority === 'committed'");
  });

  it('cancels the old screen owner when a newer generation is still finalizing', () => {
    expect(overlaySource).toContain('shouldCancelScreenFallbackOwner(');
    expect(overlaySource).toContain('cancelOwnedForceScreenFallback(ownedGeneration)');
    const cancelAt = overlaySource.indexOf('const cancelOwnedForceScreenFallback');
    const cancelSource = overlaySource.slice(cancelAt, cancelAt + 420);
    expect(cancelSource).toContain('manualBusyRef.current = false');
  });

  it('keeps stale finals diagnostic-only without asking text LLM or cancelling screen', () => {
    const acceptAt = hookSource.indexOf('export function dispatchForcedSttAcceptDecision');
    const decisionSource = hookSource.slice(acceptAt, acceptAt + 500);
    expect(decisionSource).toContain("if (decision.action !== 'submit')");
    expect(decisionSource.indexOf("if (decision.action !== 'submit')")).toBeLessThan(
      decisionSource.indexOf('dispatchForcedSttSubmission(decision'),
    );
    expect(hookSource).toContain('dispatchAcceptedForceDecision(decision)');
    expect(overlaySource).not.toContain(
      "forcePhase === 'screen-fallback' && cancelOwnedForceScreenFallback",
    );
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

  it('uses deep screen analysis for an explicit visual question when Smart is enabled', () => {
    expect(
      overlaySource.match(
        /runScreenAssist\(forceScreenFallback\.question, smart \? 'deep' : 'general', \{/g,
      ),
    ).toHaveLength(1);
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

  it('uses a minimal raw-question fast path for every Ctrl+Enter answer', () => {
    expect(hookSource).toContain('const q = prepared.rawTranscript.trim()');
    expect(hookSource).toContain('fastAnswer: true');
    expect(hookSource).not.toContain('getWeakTopicTitles()');
    expect(apiSource).toContain('body: JSON.stringify(fastAnswer ? fastPayload : enrichedPayload)');
    expect(apiSource).toContain('const fastPayload = {');
    const fastPayloadBlock = apiSource.match(/const fastPayload = \{([\s\S]*?)\n\s{8}\};/)?.[1] ?? '';
    expect(fastPayloadBlock).toContain('question,');
    expect(fastPayloadBlock).toContain('fast_answer: true');
    expect(fastPayloadBlock).not.toContain('question_intent');
    expect(fastPayloadBlock).not.toContain('weak_topics');
    expect(fastPayloadBlock).not.toContain('resolved_follow_up_question');
  });

  it('routes deictic code-on-screen questions to vision after Ctrl+Enter', () => {
    expect(hookSource).toContain('requiresScreenContext(question)');
    expect(hookSource).toContain('routeQuestionToScreen(generation)');
    expect(hookSource).toContain(
      'routeVisualQuestionToScreen(decision.question, decision.generation)',
    );
    expect(hookSource).toContain('routeVisualToScreen: (question, generation) =>');
    expect(hookSource).toContain('routeVisualQuestionToScreen(question, generation)');
    expect(hookSource).toContain(
      'setForceScreenFallback({ generation, screenRevision, question: question.trim() })',
    );
    expect(overlaySource).toContain('runScreenAssist(forceScreenFallback.question');
  });

  it('restarts the same-generation screen fallback when a late exact question arrives', () => {
    expect(overlaySource).toContain('const requestKey = JSON.stringify(forceScreenFallback)');
    expect(overlaySource).toContain('lastForceScreenFallbackRef.current === requestKey');
    expect(overlaySource).toContain('lastForceScreenFallbackRef.current = requestKey');
  });

  it('captures the uncovered desktop before rendering a loading answer card', () => {
    const runAt = overlaySource.indexOf('const runScreenAssist = useCallback');
    const captureAt = overlaySource.indexOf('const image = await capture()', runAt);
    const exchangeAt = overlaySource.indexOf('setExchange({', runAt);
    expect(captureAt).toBeGreaterThan(runAt);
    expect(exchangeAt).toBeGreaterThan(captureAt);
    expect(overlaySource.slice(captureAt, captureAt + 900)).toContain('effectiveQuestion,');
    expect(mainSource).toContain('captureScreenWithoutOverlay(');
    expect(mainSource).toContain('screenCaptureCoordinator.run(');
    expect(mainSource).toContain("showOverlayWindow(currentOverlay, 'inactive')");
  });

  it('blocks every legacy or queued LLM start without a Ctrl+Enter generation', () => {
    const runStreamAt = hookSource.indexOf('const runStream = useCallback');
    const requestTimingAt = hookSource.indexOf('const requestTimings = request.serverTimings', runStreamAt);
    expect(runStreamAt).toBeGreaterThan(-1);
    expect(requestTimingAt).toBeGreaterThan(runStreamAt);
    const guard = hookSource.slice(runStreamAt, requestTimingAt);
    expect(guard).toContain('if (requestForceGeneration == null)');
    expect(guard).toContain("reason: 'manual_only_without_force_generation'");
    expect(guard).toContain('return;');
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

  it('persists the selected session diagnostic timeline before ending it', () => {
    const saveAt = hookSource.indexOf('api.saveSessionDiagnostics(sid');
    const endAt = hookSource.indexOf('api.endSession(sid)', saveAt);
    expect(saveAt).toBeGreaterThan(-1);
    expect(endAt).toBeGreaterThan(saveAt);
  });

  it('owns one epoch-safe coalescing diagnostics writer and flushes the final snapshot before end', () => {
    expect(hookSource).toContain('SerializedDiagnosticsWriter');
    expect(hookSource).toContain('diagnosticsEpochRef');
    expect(hookSource).toContain('enqueueDiagnosticsSnapshot');
    const endAt = hookSource.indexOf('const endInterviewSession = useCallback');
    const endBody = hookSource.slice(endAt, hookSource.indexOf('const removeStream', endAt));
    expect(endBody).toContain('activeScreenCancellationRef.current.cancelAndClear()');
    expect(endBody).toContain('await diagnosticsWriterRef.current.flush(');
    expect(endBody.indexOf('await diagnosticsWriterRef.current.flush(')).toBeLessThan(
      endBody.indexOf('await api.endSession(sid)'),
    );
  });

  it('waits for an in-progress prior end before resetting or activating a reused session epoch', () => {
    expect(hookSource).toContain('endingSessionRef');
    const startAt = hookSource.indexOf('const start = useCallback');
    const epochAt = hookSource.indexOf('const diagnosticsEpoch =', startAt);
    const startPrefix = hookSource.slice(startAt, epochAt);
    expect(startPrefix).toContain('await endingSessionRef.current');
    expect(startPrefix).toContain('await endInterviewSession()');
  });

  it('cancels any standalone screen owner before a new live diagnostics reset', () => {
    const startAt = hookSource.indexOf('const start = useCallback');
    const epochAt = hookSource.indexOf('const diagnosticsEpoch =', startAt);
    const resetAt = hookSource.indexOf('screenAssistDiagnosticsRef.current.reset(', epochAt);
    const startPrefix = hookSource.slice(startAt, resetAt);
    expect(startPrefix).toContain('activeScreenCancellationRef.current.cancelAndClear()');
    expect(startPrefix.indexOf('activeScreenCancellationRef.current.cancelAndClear()')).toBeLessThan(
      startPrefix.indexOf('const diagnosticsEpoch ='),
    );
  });

  it('invalidates frozen partial hints on rejection and across capture lifecycle changes', () => {
    const lowQualityAt = hookSource.indexOf('onLowQuality:');
    const forceEmptyAt = hookSource.indexOf('onForceEmpty:', lowQualityAt);
    const pauseAt = hookSource.indexOf('const pause = useCallback');
    const resumeAt = hookSource.indexOf('const resume = useCallback');
    const captureReadyAt = hookSource.indexOf('onCaptureReady:');
    expect(hookSource.slice(lowQualityAt, forceEmptyAt)).toContain('clearGeneration(');
    expect(hookSource.slice(forceEmptyAt, forceEmptyAt + 500)).toContain('clearGeneration(');
    expect(hookSource.slice(pauseAt, resumeAt)).toContain('clearCandidates()');
    expect(hookSource.slice(resumeAt, resumeAt + 500)).toContain('clearCandidates()');
    expect(hookSource.slice(captureReadyAt, captureReadyAt + 500)).toContain('clearCandidate(source)');
  });

  it('records every screen lifecycle transition through hook-owned diagnostics', () => {
    const runAt = overlaySource.indexOf('const runScreenAssist = useCallback');
    const runBody = overlaySource.slice(runAt, overlaySource.indexOf('const runAction', runAt));
    expect(runBody).toContain('screenAssistDiagnostics.request(');
    expect(runBody).toContain('screenAssistDiagnostics.captured(');
    expect(runBody).toContain('screenAssistDiagnostics.firstOutput(');
    expect(runBody).toContain('screenAssistDiagnostics.done(');
    expect(runBody).toContain('screenAssistDiagnostics.error(');
    expect(overlaySource).toContain('screenAssistDiagnostics.cancel(');
  });

  it('passes only a frozen labelled timeout partial to screen context and never text LLM', () => {
    expect(hookSource).toContain('freezeGeneration(');
    expect(hookSource).toContain('untrustedPartialHint');
    expect(overlaySource).toContain('UNTRUSTED CURRENT PARTIAL HINT');
    const interviewAt = hookSource.indexOf('api.streamInterview(');
    const interviewBody = hookSource.slice(interviewAt, interviewAt + 2200);
    expect(interviewBody).not.toContain('untrustedPartialHint');
  });

  it('records the exact prefixed screen question and keeps manual triggers manual', () => {
    const runAt = overlaySource.indexOf('const runScreenAssist = useCallback');
    const runBody = overlaySource.slice(runAt, overlaySource.indexOf('const runAction', runAt));
    expect(runBody).toContain("const effectiveTrigger = trigger ?? 'manual'");
    expect(runBody).toContain('const effectiveQuestion = `${modeInstructionPrefix()}${request}`.trim()');
    expect(runBody).toContain('effectiveQuestion,');
    expect(runBody).toContain('api.streamScreenAssist(\n        image,\n        effectiveQuestion,');
    expect(overlaySource).not.toContain("runScreenAssist('', smart ? 'deep' : 'general', undefined, 'stt_timeout')");
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

  it('starts at seventy-percent opacity and gives floating panels real elevation', () => {
    expect(overlaySource).toContain('return saved === null ? 70');
    const shadows = [...cssSource.matchAll(/box-shadow:\s*([^;]+);/g)].map((match) => match[1].trim());
    // Аудит: панели поверх чужого экрана обязаны отделяться тенью, а не
    // растворяться в фоне (box-shadow: none остался только у logo/status dot).
    expect(shadows.length).toBeGreaterThan(0);
    expect(shadows.filter((value) => value !== 'none').length).toBeGreaterThan(0);
    expect(cssSource).toContain('0 28px 70px');
  });

  it('keeps the top pill limited to app identity and recording', () => {
    expect(overlaySource).toContain('className="ovl-logo tip"');
    expect(overlaySource).toContain('className={`ovl-rec tip');
    expect(overlaySource).not.toContain('className="ovl-pill-btn tip"');
    expect(overlaySource).not.toContain('className="ovl-hide-caret');
  });

  it('pauses capture separately from ending the session and opening recap', () => {
    expect(hookSource).toContain('entry.session.pause()');
    expect(hookSource).toContain('entry.session.resume()');
    expect(overlaySource).toContain('if (paused) void resume()');
    expect(overlaySource).toContain('else pause()');
    expect(overlaySource).toContain('onClick={stopSession}');
    expect(overlaySource).toContain("t('overlay.rec.pauseTip')");
    expect(overlaySource).toContain("t('overlay.rec.resumeTip')");
  });

  it('keeps the finish control clickable inside the draggable overlay pill', () => {
    expect(overlaySource).toMatch(/className="[^"]*overlay-no-drag[^"]*"\s+onClick=\{stopSession\}/);
  });

  it('draws the pause symbol as one balanced SVG instead of separate rasterized bars', () => {
    expect(overlaySource).toContain('<Icon d="M8 5v14|M16 5v14" size={16} />');
    expect(overlaySource).not.toContain('<i className="h-3 w-[3px] rounded-full bg-slate-200" />');
  });

  it('does not paint a green halo behind the real app icon', () => {
    const logoRule = cssSource.match(/\.ovl-logo\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(logoRule).toContain('background: transparent');
    expect(logoRule).not.toContain('background: var(--accent)');
  });

  it('keeps the active pause control neutral and reserves red for ending the session', () => {
    const livePauseRule = cssSource.match(/\.ovl-rec--live\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(livePauseRule).toContain('background: rgba(255, 255, 255, 0.12)');
    expect(livePauseRule).not.toMatch(/248,\s*113,\s*113|239,\s*68,\s*68|red/i);
    expect(overlaySource).toContain('bg-red-500/20');
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
    expect(toggleSource).toContain('attachNearestInterviewContext();');
    expect(toggleSource).toContain('showOverlayWindow(win);');
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
