import { describe, expect, it } from 'vitest';
import {
  loadResumeTextForSource,
  pickPreferredResumeSource,
  resumeSourceRef,
} from './resumeContext';

const hh = { id: 'hh-1', title: 'QA Automation Python' };
const local = { id: 'doc-1', title: 'Локальное резюме' };
const session = { id: 'sess-1', resumeTitle: 'Из практики', resumeText: 'Python, Pytest' };

describe('preferred resume source', () => {
  it('prefers the HH résumé Home already counts as present', () => {
    expect(pickPreferredResumeSource({
      hhResumes: [hh],
      preferredHhTitle: hh.title,
      localResumes: [local],
      sessions: [session],
    })).toBe('hh:hh-1');
  });

  it('keeps a saved source when it still exists', () => {
    expect(pickPreferredResumeSource({
      hhResumes: [hh],
      localResumes: [local],
      sessions: [session],
      stored: 'doc:doc-1',
    })).toBe('doc:doc-1');
  });

  it('falls back to a local file, then a previous practice session', () => {
    expect(pickPreferredResumeSource({
      hhResumes: [],
      localResumes: [local],
      sessions: [session],
    })).toBe('doc:doc-1');
    expect(pickPreferredResumeSource({
      hhResumes: [],
      localResumes: [],
      sessions: [session],
    })).toBe('session:sess-1');
  });

  it('honours an explicit title from a vacancy or calendar link', () => {
    expect(pickPreferredResumeSource({
      hhResumes: [hh, { id: 'hh-2', title: 'Java Developer' }],
      localResumes: [],
      sessions: [],
      initialResumeTitle: 'Java Developer',
    })).toBe('hh:hh-2');
  });

  it('loads text for HH, document and session sources', async () => {
    await expect(loadResumeTextForSource('hh:hh-1', {
      sessions: [session],
      getHhResumeText: async () => '  HH text  ',
    })).resolves.toBe('HH text');
    await expect(loadResumeTextForSource('doc:doc-1', {
      sessions: [session],
      getDocumentText: async () => 'File text',
    })).resolves.toBe('File text');
    await expect(loadResumeTextForSource('session:sess-1', {
      sessions: [session],
    })).resolves.toBe('Python, Pytest');
    expect(resumeSourceRef('hh:hh-1', {
      hhResumes: [hh],
      localResumes: [],
      sessions: [],
    })).toEqual({ kind: 'hh', id: 'hh-1', title: 'QA Automation Python' });
  });
});
