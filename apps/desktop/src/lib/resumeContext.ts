import { api } from './api';
import { listSessions } from './vacancyReview/vacancyReviewStore';
import type { ResumeSourceRef } from './vacancyReview/types';

export const RESUME_SOURCE_STORAGE_KEY = 'skillcue.prepare.resume-source';

export interface ResumePickInput {
  hhResumes: Array<{ id: string; title: string }>;
  preferredHhTitle?: string;
  localResumes: Array<{ id: string; title: string }>;
  sessions: Array<{ id: string; resumeTitle?: string; resumeText?: string }>;
  stored?: string;
  initialResumeTitle?: string;
}

export interface PreferredResumeContext {
  text: string;
  source?: ResumeSourceRef;
}

function storedSourceExists(stored: string, input: ResumePickInput): boolean {
  if (stored === 'none' || stored === 'manual') return true;
  if (stored.startsWith('hh:')) {
    return input.hhResumes.some((resume) => `hh:${resume.id}` === stored);
  }
  if (stored.startsWith('doc:')) {
    return input.localResumes.some((document) => `doc:${document.id}` === stored);
  }
  if (stored.startsWith('session:')) {
    return input.sessions.some((session) => `session:${session.id}` === stored);
  }
  return false;
}

/** Same source order as vacancy setup: requested title, saved choice, HH, file, session. */
export function pickPreferredResumeSource(input: ResumePickInput): string {
  const title = input.initialResumeTitle?.trim() ?? '';
  if (title) {
    const hh = input.hhResumes.find((resume) => resume.title === title);
    if (hh) return `hh:${hh.id}`;
    const doc = input.localResumes.find((document) => document.title === title);
    if (doc) return `doc:${doc.id}`;
    const session = input.sessions.find((item) => item.resumeTitle === title);
    if (session) return `session:${session.id}`;
  }
  const stored = input.stored?.trim() ?? '';
  if (stored && storedSourceExists(stored, input)) return stored;
  const preferredHh = input.hhResumes.find((resume) => resume.title === input.preferredHhTitle)
    ?? input.hhResumes[0];
  if (preferredHh) return `hh:${preferredHh.id}`;
  if (input.localResumes[0]) return `doc:${input.localResumes[0].id}`;
  if (input.sessions[0]) return `session:${input.sessions[0].id}`;
  return 'none';
}

export function resumeSourceRef(
  source: string,
  input: Pick<ResumePickInput, 'hhResumes' | 'localResumes' | 'sessions'>,
): ResumeSourceRef | undefined {
  if (source.startsWith('hh:')) {
    const resume = input.hhResumes.find((item) => `hh:${item.id}` === source);
    return { kind: 'hh', id: source.slice(3), title: resume?.title || 'Резюме HH' };
  }
  if (source.startsWith('doc:')) {
    const document = input.localResumes.find((item) => `doc:${item.id}` === source);
    return { kind: 'document', id: source.slice(4), title: document?.title || 'Резюме' };
  }
  if (source.startsWith('session:')) {
    const session = input.sessions.find((item) => item.id === source.slice(8));
    return {
      kind: 'session',
      id: session?.id,
      title: session?.resumeTitle || 'Резюме из практики',
    };
  }
  if (source === 'manual') return { kind: 'manual', title: 'Резюме, введённое вручную' };
  return undefined;
}

export async function loadResumeTextForSource(
  source: string,
  input: {
    sessions: Array<{ id: string; resumeText?: string }>;
    getHhResumeText?: (id: string) => Promise<string>;
    getDocumentText?: (id: string) => Promise<string>;
  },
): Promise<string> {
  if (source.startsWith('hh:')) {
    return (await input.getHhResumeText?.(source.slice(3)))?.trim() ?? '';
  }
  if (source.startsWith('doc:')) {
    return (await input.getDocumentText?.(source.slice(4)))?.trim() ?? '';
  }
  if (source.startsWith('session:')) {
    const session = input.sessions.find((item) => item.id === source.slice(8));
    return session?.resumeText?.trim() ?? '';
  }
  return '';
}

/** Load the same résumé Home/Prepare would count as present, including HH. */
export async function resolvePreferredResume(
  initialResumeTitle = '',
): Promise<PreferredResumeContext> {
  const sessions = listSessions()
    .filter((session) => session.vacancyAnalysis.resumeText?.trim())
    .map((session) => ({
      id: session.id,
      resumeTitle: session.vacancyAnalysis.resumeSource?.title,
      resumeText: session.vacancyAnalysis.resumeText,
    }));
  const documentResult = await api.listDocuments().catch(() => ({ documents: [] }));
  const localResumes = documentResult.documents.filter((document) => document.kind === 'resume');
  const assistant = window.electronAPI?.hhAssistant;
  let hhResumes: Array<{ id: string; title: string }> = [];
  let preferredHhTitle = '';
  if (assistant) {
    try {
      preferredHhTitle = (await assistant.getState()).config.resumeTitles[0] ?? '';
      hhResumes = await assistant.getResumes();
    } catch {
      hhResumes = [];
    }
  }
  let stored: string;
  try {
    stored = localStorage.getItem(RESUME_SOURCE_STORAGE_KEY) ?? '';
  } catch {
    stored = '';
  }
  const pickInput: ResumePickInput = {
    hhResumes,
    preferredHhTitle,
    localResumes,
    sessions,
    stored,
    initialResumeTitle,
  };
  const source = pickPreferredResumeSource(pickInput);
  const text = await loadResumeTextForSource(source, {
    sessions,
    getHhResumeText: async (id) => {
      if (!assistant) return '';
      return (await assistant.getResumeContent(id)).text;
    },
    getDocumentText: async (id) => (await api.getDocument(id)).text,
  }).catch(() => '');
  return {
    text,
    source: text ? resumeSourceRef(source, pickInput) : undefined,
  };
}
