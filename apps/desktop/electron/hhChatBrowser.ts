import fs from 'fs';
import path from 'path';
import type { Frame, Page } from 'playwright-core';
import {
  analyzeInterviewMessage,
  chooseThreadSlot,
  findRecruiterInterviewSlots,
  formatInterviewSlotRu,
  formatRecruiterInterviewSlotRu,
  isInterviewSlotAvailable,
  type InterviewCalendarStore,
  type InterviewType,
} from './interviewCalendar';
import {
  answerExperienceThresholdFromResume,
  buildSalaryExpectationAnswer,
  findSalaryExpectation,
  isSalaryExpectationQuestion,
} from './hhScreeningKnowledge';

export interface HhChatConfig {
  enabled: boolean;
  pollIntervalSec: number;
  dailyReplyLimit: number;
  replyDelaySec: number;
  replyPrompt: string;
  onlyDiscussions: boolean;
  minMessageLength: number;
  ignoredKeywords: string;
}

export interface HhChatState {
  enabled: boolean;
  polling: boolean;
  lastPollAt: string | null;
  repliesToday: number;
  activeNegotiations: number;
  checkedNegotiations: number;
  unreadMessages: number;
  conversations: HhChatConversation[];
  replyHistory: HhChatReplyRecord[];
  pendingDecisions: HhChatPendingDecision[];
  confirmedFacts: HhChatFact[];
  config: HhChatConfig;
  error: string | null;
}

export type HhChatReplySource =
  | 'generated'
  | 'saved_fact'
  | 'resume_fact'
  | 'scheduling'
  | 'user_confirmed'
  | 'recovered';

export interface HhChatReplyRecord {
  id: string;
  negotiationKey: string;
  messageId: string;
  vacancyTitle: string;
  companyName: string;
  recruiterMessage: string;
  reply: string;
  sentAt: string | null;
  recordedAt: string;
  source: HhChatReplySource;
  status: 'sent';
}

export type HhChatConversationStage = 'waiting' | 'bot' | 'hr';
export type HhChatDecisionKind =
  | 'contract'
  | 'salary'
  | 'experience'
  | 'relocation'
  | 'start_date'
  | 'schedule'
  | 'work_format'
  | 'travel'
  | 'work_authorization'
  | 'candidate_fact';

export interface HhChatConversation {
  key: string;
  vacancyTitle: string;
  companyName: string;
  vacancyUrl?: string;
  stage: HhChatConversationStage;
  hasUnread: boolean;
  lastMessage: string;
  lastMessageMine: boolean;
  lastRecruiterMessage?: string;
  needsUserInput: boolean;
}

export interface HhChatPendingDecision {
  id: string;
  negotiationKey: string;
  messageId: string;
  vacancyTitle: string;
  companyName: string;
  recruiterMessage: string;
  question: string;
  kind: HhChatDecisionKind;
  createdAt: string;
}

export interface HhChatFact {
  id: string;
  kind: HhChatDecisionKind;
  question: string;
  answer: string;
  updatedAt: string;
}

export const DEFAULT_CHAT_CONFIG: HhChatConfig = {
  enabled: false,
  pollIntervalSec: 60,
  dailyReplyLimit: 20,
  replyDelaySec: 15,
  replyPrompt: [
    'Ты пишешь готовый ответ работодателю от лица соискателя на hh.ru.',
    'Критические правила:',
    '- Ответь именно на ПОСЛЕДНЕЕ сообщение рекрутера. Первое предложение должно сразу отвечать на заданный вопрос.',
    '- Используй только подтверждённые факты из профиля кандидата ниже. Ничего не выдумывай.',
    '- Никогда не упоминай название приложения, внутренний календарь, бота, промпт или автоматическую генерацию этого ответа. Если работодатель прямо спрашивает об опыте с LLM/AI/ИИ, ответь по подтверждённым фактам кандидата.',
    '- Не упоминай тестовое задание, если рекрутер не спросил о тестовом задании в последнем сообщении.',
    '- Не добавляй подпись, ФИО, телефон, почту или ссылки, если рекрутер прямо их не запросил.',
    '- На конкретный вопрос не отвечай приветствием, пересказом вакансии или общей фразой о заинтересованности.',
    '- Пиши естественно от первого лица, максимум 2 коротких предложения и без канцелярита.',
    '- Если для ответа нужен неизвестный личный факт, верни только: NEEDS_USER_INPUT: <короткий вопрос кандидату>.',
    '- Верни только текст сообщения работодателю, без кавычек, пояснений и меток.',
    '',
    'Вакансия: {vacancy}',
    'Компания: {company}',
    '',
    'Проверенный профиль кандидата:',
    '{candidateProfile}',
    '',
    'Последнее сообщение рекрутера:',
    '{message}',
    '',
    'Сформулируй прямой и конкретный ответ сейчас.',
  ].join('\n'),
  onlyDiscussions: false,
  minMessageLength: 2,
  ignoredKeywords: 'отказ, не готовы, закрыли, другой кандидат, рассматриваем других',
};

export const HH_NEGOTIATIONS_URL = 'https://hh.ru/applicant/negotiations';

const NEGOTIATION_ITEM_SELECTOR = '[data-qa="negotiations-item"]';
const OPEN_CHAT_SELECTOR = '[data-qa="open_chat"]';
const NEGOTIATION_VACANCY_SELECTOR = '[data-qa="negotiations-item-vacancy"]';
const NEGOTIATION_COMPANY_SELECTOR = '[data-qa="negotiations-item-company"]';
const DISCUSSION_STATUS_SELECTOR = '[data-qa*="negotiations-item-interview"]';
const REJECTED_STATUS_SELECTOR = '[data-qa~="negotiations-item-discard"], [data-qa*="negotiations-item-discard"]';
const UNREAD_STATUS_SELECTOR = [
  '[data-qa*="new-message"]',
  '[data-qa*="unread"]',
  '[class*="unread"]',
].join(', ');

const CHAT_FRAME_URL_PART = 'chatik.hh.ru/chat/';
const CHAT_MESSAGE_SELECTOR = '[data-qa^="chatik-chat-message-"]';
const CHAT_INPUT_SELECTOR = '[data-qa="chatik-new-message-text"]';
const CHAT_SEND_SELECTOR = '[data-qa="chatik-do-send-message"]';
const CHAT_VACANCY_SELECTOR = '[data-qa="chatik-header-vacancy-link-text"]';
const OUTGOING_SELECTOR = '[class*="message_my"], [class*="chat-bubble_outgoing"], [class*="outgoing"]';
const CHAT_BATCH_SIZE = 4;
const CHAT_OPEN_TIMEOUT_MS = 5_000;
const CHAT_RECOVERY_PAGE_LIMIT = 3;
const QUESTIONNAIRE_ROUTE_VERSION = 2;

interface PersistedChatState {
  config: HhChatConfig;
  seenMessageIds: string[];
  repliesToday: number;
  replyDate: string;
  replyHistoryVersion?: 1;
  replyHistory?: HhChatReplyRecord[];
  pendingDecisions?: HhChatPendingDecision[];
  confirmedFacts?: HhChatFact[];
  notifiedInterviewMessageIds?: string[];
  pollCursor?: number;
}

export type HhChatNoticeKind = 'interview' | 'telegram' | 'message';

export interface HhInterviewInvitationNotice {
  messageId: string;
  negotiationKey: string;
  vacancyTitle: string;
  companyName: string;
  recruiterMessage: string;
  chatUrl: string;
  kind: HhChatNoticeKind;
}

interface NegotiationSummary {
  index: number;
  key: string;
  vacancyTitle: string;
  companyName: string;
  vacancyUrl?: string;
  isDiscussion: boolean;
  hasUnread: boolean;
  isRejected: boolean;
}

export interface ChatMessage {
  id: string;
  text: string;
  isMine: boolean;
  isSystem?: boolean;
}

export interface HhChatNegotiationContext {
  negotiationKey: string;
  vacancyTitle: string;
  companyName: string;
  vacancyUrl?: string;
}

export interface HhChatCandidateProfile {
  /** Exact résumé persisted for this queue vacancy; salary and tenure facts may only use this field. */
  selectedResumeText: string;
  /** Optional cross-document context for general replies; salary facts are stripped before prompting. */
  supplementalProfileText?: string;
}

export interface HhRecruiterProfileQueueCandidate {
  id: string;
  platform: 'hh' | 'linkedin' | 'avito';
  title: string;
  company: string;
  url: string;
  selectedResumeTitle?: string;
  selectedResumeVerified?: boolean;
}

export interface HhRecruiterProfileSelection<T extends HhRecruiterProfileQueueCandidate> {
  vacancy: T;
  selectedResumeTitle: string;
  cacheKey: string;
}

function chatStatePath(userDataDir: string): string {
  return path.join(userDataDir, 'hh-chat-browser.json');
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function chatFactQuestionKey(value: string): string {
  return compactText(value).toLocaleLowerCase('ru');
}

function normalizeOutboundText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function numberedItemIds(value: string): string[] {
  const ids = [...value.matchAll(/(?:^|[\s\n])(\d{1,2})\s*[.):]\s+/g)]
    .map((match) => match[1]);
  return [...new Set(ids)];
}

/** HH occasionally inserts its own assistant card between an employer question and the input. */
export function isHhPlatformAssistantMessage(value: string): boolean {
  const text = compactText(value);
  return (
    /бот[-\s\u2011]?помощник\s+х[эе]дди/i.test(text) ||
    /ответьте\s+на\s+приглашение[^.]{0,180}рекомендовать\s+вам\s+более\s+подходящие\s+вакансии/i.test(text)
  );
}

/** A batch of recruiter questions must be answered as one questionnaire, not as one detected fact. */
export function isRecruiterQuestionnaire(value: string): boolean {
  const text = compactText(value);
  if (numberedItemIds(text).length >= 2) return true;
  const questionMarks = (text.match(/\?/g) ?? []).length;
  return text.length >= 180 && questionMarks >= 3;
}

const OBJECTIVE_TECHNICAL_QUESTION_RE = /(?:^|[.!?]\s*)(?:что\s+(?:такое|происходит|позволяет|означает|делает|верн[её]т)|почему(?=$|[\s?!,:])|для\s+чего(?=$|[\s?!,:])|чем\s+отлича|в\s+ч[её]м\s+(?:разниц|отлич|различ)|как\s+(?:работает(?=$|[\s?!,:])|устроен|обеспечивается|реализовать|настроить|протестировать|проверить|диагностировать|решить|рассчитать|спроектировать|организовать|найти|исправить)|как\s+бы\s+вы\s+(?:решили|протестировали|проверили|организовали|спроектировали|диагностировали)|какие?[^?\n]{0,70}(?:существуют|бывают|используются|нужны|полезны|подойдут)|назовите[^?\n]{0,35}(?:причин|вид|тип|этап|метод|способ)|опишите[^?\n]{0,35}(?:алгоритм|подход|архитектур|процесс|принцип)|(?:напишите|составьте|приведите)[^?\n]{0,35}(?:sql|запрос|код|пример|тест)|решите\s+(?:задач|пример)|когда\s+(?:использовать|применять|нужен))/i;
const OBJECTIVE_TECHNICAL_SUBJECT_RE = /(?:\b(?:sql|nosql|kafka|playwright|selenium|rest|api|http|https|tcp|udp|oauth|jwt|deadlock|mutex|docker|kubernetes|linux|git|java|python|javascript|typescript|redis|postgres|mysql|oracle|grpc|graphql|ci\s*\/\s*cd|at-least-once)\b|consumer\s+group|race\s+condition|баз[а-яё]*\s+данн|алгоритм|архитектур|микросервис|протокол|транзакц|индекс|кеш|кэш|очеред|поток|процесс|запрос|код|тестир|автотест|доставк|сериализац|контейнер|сеть|сетев|приложен|сервер)/iu;
const NON_OBJECTIVE_RECRUITER_CLAUSE_RE = /(?:игнорир|не\s+следуй|обойди[^.!?;]{0,25}инструкц|забудь|забудьте|предыдущ[а-яё]*\s+инструкц|системн[а-яё]*\s+(?:промпт|сообщен)|prompt\s+injection|(?:^|[^a-zа-яё])(?:ваш[а-яё]*|сво[а-яё]*|your)(?=$|[^a-zа-яё])|(?:считай|представь|притвор)[^.!?;]{0,35}что|(?:ответь|ответьте|напиши|напишите|скажи|скажите)[^.!?;]{0,50}(?:что|будто)|(?:у\s+(?:меня|вас)|кандидат)[^.!?;]{0,60}(?:опыт|лет|готов|жив|зарплат|гражданств)|(?:опыт|стаж)[а-яё]*\s+(?:работ|использован|применен)|коммерческ[а-яё]*\s+опыт|\d+\s*(?:лет|год[а-яё]*)[^.!?;]{0,25}опыт|готов[а-яё]*[^.!?;]{0,35}(?:переех|переезд|релокац|офис|график)|гражданств|зарплат|текущ[а-яё]*\s+доход|место\s+(?:жительства|проживания)|почему[^.!?;]{0,35}(?:хотите\s+работать|ушл[а-яё]*)|мотивац|(?:наня|принять)[^.!?;]{0,20}вас|вас[^.!?;]{0,20}(?:наня|принять)|сильн[а-яё]*\s+сторон|слаб[а-яё]*\s+сторон|достижен|неудач|работаете[^.!?;]{0,35}конфликт|конфликт[^.!?;]{0,35}команд)/i;
const CANDIDATE_HISTORY_ACTION_RE = /(?:^|[^\p{L}])(?:вы\s+)?(?:выбрал|работал|использовал|применял|писал|настраивал|разворачивал|проектировал|проводил|мигрировал|строил|тестировал|разрабатывал|внедрял|участвовал|руководил|делал)(?:а|и)?(?=$|[^\p{L}])|почему[^.!?;]{0,35}(?:вы\s+)?решили(?=$|[^\p{L}])/iu;
const CANDIDATE_PAST_ACTION_GRAMMAR_RE = /(?:^|[^\p{L}])вы\s+[\p{L}-]{2,}(?:лись|лась|лся|ли|ла|л)(?=$|[^\p{L}])|котор[а-яё]*[^.!?;]{0,45}(?:вы\s+)?[\p{L}-]{2,}(?:лись|лась|лся|ли|ла|л)(?=$|[^\p{L}])/iu;

function hhQuestionnaireItems(value: string): string[] {
  return [...value.matchAll(/(?:^|\s)\d{1,2}[.)]\s+([\s\S]*?)(?=(?:\s+\d{1,2}[.)]\s+)|$)/g)]
    .map((match) => compactText(match[1] ?? ''))
    .filter(Boolean);
}

function isObjectiveTechnicalQuestion(value: string): boolean {
  const text = compactText(value);
  const nonHypotheticalText = text.replace(/как\s+бы\s+вы\s+[\p{L}-]+/giu, '');
  if (
    !text
    || NON_OBJECTIVE_RECRUITER_CLAUSE_RE.test(text)
    || CANDIDATE_HISTORY_ACTION_RE.test(text)
    || CANDIDATE_PAST_ACTION_GRAMMAR_RE.test(nonHypotheticalText)
  ) return false;
  const clauses = text
    .split(/[.!?;]\s+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  return clauses.length > 0 && clauses.every((clause) => (
    OBJECTIVE_TECHNICAL_QUESTION_RE.test(clause)
    && OBJECTIVE_TECHNICAL_SUBJECT_RE.test(clause)
  ));
}

/** True unless every free-form answer can be limited to objective technical knowledge. */
export function requiresHhChatFactProvenance(value: string): boolean {
  const text = compactText(value);
  const questionnaireItems = hhQuestionnaireItems(text);
  if (isRecruiterQuestionnaire(text)) {
    // An unnumbered questionnaire cannot be split reliably enough to prove
    // that every requested answer is objective technical knowledge.
    if (questionnaireItems.length < 2) return true;
    return questionnaireItems.some((item) => !isObjectiveTechnicalQuestion(item));
  }
  // Free-form LLM output is allowed only for an explicitly recognized,
  // impersonal technical question. Scheduling and exact candidate facts are
  // handled by deterministic branches before this guard.
  return !isObjectiveTechnicalQuestion(text);
}

export function isCompleteRecruiterQuestionnaireReply(
  questionnaire: string,
  reply: string,
): boolean {
  const normalizedReply = compactText(reply);
  if (!normalizedReply || /^NEEDS_USER_INPUT\s*:/i.test(normalizedReply)) return false;
  const questionIds = numberedItemIds(questionnaire);
  if (questionIds.length > 0) {
    const replyIds = new Set(numberedItemIds(reply));
    return questionIds.every((id) => replyIds.has(id));
  }
  return normalizedReply.length >= 240;
}

function isHhRecommendationAcknowledgement(value: string): boolean {
  const text = compactText(value);
  return (
    /спасибо\s+за\s+приглашение/i.test(text) &&
    /(?:друг(?:ие|ую)\s+ваканси|рекомендац)/i.test(text)
  );
}

/**
 * Repair a recent missed questionnaire even when a later HH assistant card and
 * an unrelated generic applicant reply made the newest bubble look handled.
 */
export function findLatestUnansweredRecruiterQuestionnaire(
  messages: ChatMessage[],
): ChatMessage | null {
  const recentStart = Math.max(0, messages.length - 16);
  for (let index = messages.length - 1; index >= recentStart; index -= 1) {
    const message = messages[index];
    if (
      message.isMine ||
      message.isSystem ||
      isHhPlatformAssistantMessage(message.text) ||
      !isRecruiterQuestionnaire(message.text)
    ) continue;
    const laterMessages = messages.slice(index + 1);
    // Once the employer has continued the conversation, do not resurrect an
    // older questionnaire: the applicant may have answered it in several
    // natural messages without preserving the original numbering.
    if (laterMessages.some((candidate) => (
      !candidate.isMine &&
      !candidate.isSystem &&
      !isHhPlatformAssistantMessage(candidate.text)
    ))) continue;
    const outgoingReplies = laterMessages.filter((candidate) => (
      candidate.isMine && !isHhRecommendationAcknowledgement(candidate.text)
    ));
    if (outgoingReplies.some((candidate) => (
      isCompleteRecruiterQuestionnaireReply(message.text, candidate.text)
    ))) continue;
    const combinedReply = outgoingReplies.map((candidate) => candidate.text).join('\n');
    if (outgoingReplies.length >= 2 || compactText(combinedReply).length >= 240) continue;
    return message;
  }
  return null;
}

export function stripTrailingChatTimestamp(value: string): string {
  return value.replace(/(?:\r?\n|\r)\s*(?:[01]\d|2[0-3]):[0-5]\d\s*$/, '').trim();
}

export function normalizeHhNegotiationVacancyUrl(value: string): string | undefined {
  try {
    const url = new URL(value, 'https://hh.ru');
    if (!/(?:^|\.)hh\.ru$/i.test(url.hostname) || !/^\/vacancy\/\d+\/?$/i.test(url.pathname)) return undefined;
    return `https://hh.ru${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return undefined;
  }
}

function hhRecruiterVacancyId(value: string): string {
  return normalizeHhNegotiationVacancyUrl(value)?.match(/\/vacancy\/(\d+)$/)?.[1] ?? '';
}

function hhRecruiterIdentityText(value: string): string {
  return compactText(value).toLocaleLowerCase('ru');
}

const SUPPLEMENTAL_SALARY_FACT_RE = /(?:зарплат|заработн[а-яё]*\s+плат|оклад|доход|компенсац|денежн[а-яё]*\s+ожидан|salary|compensation|financial\s+expectations?|\bpay\b)/i;
const SUPPLEMENTAL_MONEY_AMOUNT_RE = /(?:\d{2,3}(?:[\s\u00a0]\d{3})+|\d{5,7}|\d{2,4}\s*[кk])\s*(?:₽|руб(?:\.|лей|ля)?|rub\b)?/i;

/** Removes cross-document salary evidence while retaining supplemental experience facts. */
export function sanitizeHhChatSupplementalProfile(value: string): string {
  return value
    .split(/(?:\r?\n)+|(?<=[.!?;])\s+/)
    .map((part) => part.trim())
    .filter((part) => part
      && !SUPPLEMENTAL_SALARY_FACT_RE.test(part)
      && !SUPPLEMENTAL_MONEY_AMOUNT_RE.test(part))
    .join('\n')
    .trim();
}

export function buildHhChatCandidateProfileContent(profile: HhChatCandidateProfile): string {
  const selectedResume = profile.selectedResumeText.trim();
  if (!selectedResume) return '';
  const supplemental = sanitizeHhChatSupplementalProfile(profile.supplementalProfileText ?? '');
  return [
    `ВЫБРАННОЕ РЕЗЮМЕ ДЛЯ ЭТОЙ ВАКАНСИИ (единственный источник зарплаты):\n${selectedResume}`,
    supplemental
      ? `ДОПОЛНИТЕЛЬНЫЙ ПРОФИЛЬ (только для опыта и навыков, не для зарплаты):\n${supplemental}`
      : '',
  ].filter(Boolean).join('\n\n');
}

/** Resolves the one persisted queue entry whose explicitly selected résumé belongs to this chat. */
export function resolveHhRecruiterProfileSelection<T extends HhRecruiterProfileQueueCandidate>(
  queue: readonly T[],
  context: HhChatNegotiationContext,
): HhRecruiterProfileSelection<T> | null {
  const hhQueue = queue.filter((item) => item.platform === 'hh');
  const requestedVacancyId = hhRecruiterVacancyId(context.vacancyUrl ?? '');
  let matches: T[];
  if (requestedVacancyId) {
    matches = hhQueue.filter((item) => {
      const itemVacancyId = hhRecruiterVacancyId(item.url)
        || (/^\d+$/.test(item.id) ? item.id : '');
      return itemVacancyId === requestedVacancyId;
    });
  } else {
    const title = hhRecruiterIdentityText(context.vacancyTitle);
    const company = hhRecruiterIdentityText(context.companyName);
    if (!title || !company) return null;
    matches = hhQueue.filter((item) => (
      hhRecruiterIdentityText(item.title) === title
      && hhRecruiterIdentityText(item.company) === company
    ));
  }
  if (matches.length !== 1) return null;

  const vacancy = matches[0];
  const selectedResumeTitle = vacancy.selectedResumeTitle?.trim() ?? '';
  // Titles inferred during a scan (especially legacy already-applied items) do
  // not prove which résumé was actually sent. Personal recruiter replies may
  // use it only after the HH response form visibly confirmed the exact résumé.
  if (!selectedResumeTitle || vacancy.selectedResumeVerified !== true) return null;
  const vacancyId = requestedVacancyId
    || hhRecruiterVacancyId(vacancy.url)
    || (/^\d+$/.test(vacancy.id) ? vacancy.id : '');
  const vacancyIdentity = vacancyId
    ? `hh-vacancy:${vacancyId}`
    : `hh-chat:${hhRecruiterIdentityText(context.negotiationKey)}:${hhRecruiterIdentityText(vacancy.title)}:${hhRecruiterIdentityText(vacancy.company)}`;
  const cacheKey = `${vacancyIdentity}\u0000resume:${hhRecruiterIdentityText(selectedResumeTitle)}`;
  return { vacancy, selectedResumeTitle, cacheKey };
}

function formatRussianList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} и ${items.at(-1)}`;
}

function cleanStackItem(value: string): string {
  return value
    .replace(/^[\s\-–—•]+/, '')
    .replace(/[.;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract only the explicitly labelled core stack, never items from a gaps section. */
export function extractCandidateCoreStack(candidateProfile: string): string[] {
  const lines = candidateProfile.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/(?:core\s+stack|основн\w*\s+стек|работаю\s+со\s+стеком)\s*[:—-]\s*(.*)$/i);
    if (!match) continue;
    const chunks = [match[1]];
    if (!match[1].trim()) chunks.push(...lines.slice(index + 1, index + 3));
    return [...new Set(
      chunks
        .join(', ')
        .split(/[,;•]/)
        .map(cleanStackItem)
        .filter((item) => item.length > 0 && item.length <= 60),
    )].slice(0, 12);
  }
  return [];
}

export function isTechnologyStackQuestion(message: string): boolean {
  const value = compactText(message).toLocaleLowerCase('ru');
  return (
    /(?:какой|какие|ваш|основн\w*)[^?]{0,80}стек/i.test(value) ||
    /(?:какие|какой)[^?]{0,80}(?:технолог|инструмент)[^?]{0,80}(?:автоматизац|тестирован)/i.test(value) ||
    /на\s+ч[её]м[^?]{0,80}(?:пишете|делаете|строите)[^?]{0,80}автотест/i.test(value)
  );
}

/** Deterministic answer for common factual questions where an LLM must not improvise. */
export function buildGroundedRecruiterReply(
  recruiterMessage: string,
  candidateProfile: string,
): string | null {
  if (!isTechnologyStackQuestion(recruiterMessage)) return null;
  const stack = extractCandidateCoreStack(candidateProfile);
  if (stack.length === 0) return null;

  const testingKinds = stack.filter((item) => /^(?:api|ui)[-\s]+(?:тест|test)/i.test(item));
  const tools = stack.filter((item) => !testingKinds.includes(item));
  const primary = tools.slice(0, 3);
  const secondary = tools.slice(3, 8);
  const first = `Основной стек автоматизации — ${formatRussianList(primary.length > 0 ? primary : stack.slice(0, 3))}.`;
  const details: string[] = [];
  const hasApi = testingKinds.some((item) => /^api/i.test(item));
  const hasUi = testingKinds.some((item) => /^ui/i.test(item));
  if (hasApi && hasUi) details.push('Пишу UI- и API-автотесты');
  else if (hasUi) details.push('Пишу UI-автотесты');
  else if (hasApi) details.push('Пишу API-автотесты');
  if (secondary.length > 0) details.push(`также использую ${formatRussianList(secondary)}`);
  return details.length > 0 ? `${first} ${details.join(', ')}.` : first;
}

/** Final outbound gate: unsafe or obviously irrelevant text is never sent to HH. */
export function prepareRecruiterReply(rawReply: string, recruiterMessage: string): string | null {
  const questionnaire = isRecruiterQuestionnaire(recruiterMessage);
  const asksAboutAi = /(?:\bLLM\b|\bAI\b|(?:^|[^\p{L}])ИИ(?:$|[^\p{L}])|искусственн\w*\s+интеллект)/iu
    .test(recruiterMessage);
  const reply = normalizeOutboundText(rawReply)
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^(?:ответ|сообщение)\s*:\s*/i, '')
    .replace(/\s+(?:с уважением|с наилучшими пожеланиями)[,!]?[\s\S]*$/i, '')
    .trim();
  if (!reply || reply.length > (questionnaire ? 6_000 : 800)) return null;
  if (questionnaire && !isCompleteRecruiterQuestionnaireReply(recruiterMessage, reply)) return null;
  if (/skill\s*cue|skillcue|внутренн\w*\s+календар|через\s+(?:наш|мой)\s+календар/i.test(reply)) return null;
  if (
    !asksAboutAi &&
    (/\b(?:бот|нейросет|промпт)\b|искусственн\w*\s+интеллект|автоматическ\w*\s+генерац/i.test(reply))
  ) return null;
  if (
    !/тестов(?:ое|ого|ому|ым|ом)\s+задани/i.test(recruiterMessage) &&
    /тестов(?:ое|ого|ому|ым|ом)\s+задани/i.test(reply)
  ) return null;
  if (/^(?:здравствуйте|добрый\s+(?:день|вечер|утро))[^.!?]*[.!?]\s*спасибо\s+за\s+(?:информац|сообщен)[^.!?]*ваканси/i.test(reply)) return null;
  if (
    !/(?:телефон|почт|e-?mail|telegram|телеграм|контакт|ссылк)/i.test(recruiterMessage) &&
    /https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+7|8)[\s()-]*\d{3}/i.test(reply)
  ) return null;
  if (/\bс\s+уважением\b/i.test(reply)) return null;
  return reply;
}

export function isRejectedNegotiationStatus(dataQa: string, visibleText: string): boolean {
  const tokens = dataQa.toLocaleLowerCase('ru').split(/\s+/).filter(Boolean);
  if (tokens.includes('negotiations-item-discard')) return true;
  return /^отказ(?:$|\s)/i.test(compactText(visibleText));
}

export function isTerminalChatText(text: string): boolean {
  const value = compactText(text);
  return (
    /переписка будет доступна после приглашения работодателя/i.test(value) ||
    /работодатель[^.]{0,80}(?:отказал|отклонил отклик)/i.test(value) ||
    /к сожалению[^.]{0,180}не готовы пригласить/i.test(value) ||
    /messaging (?:will be|is) available after (?:an )?employer invitation/i.test(value)
  );
}

export function formatChatPollError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/locator\.waitFor|timeout\s+\d+ms exceeded|chatik-new-message-text/i.test(raw)) {
    return 'HH не открыл поле ответа в одном из чатов. Диалог временно пропущен; проверка продолжится.';
  }
  const ansiEscape = String.fromCharCode(27);
  const clean = raw
    .split(ansiEscape)
    .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-9;]*m/, '')))
    .join('');
  const firstLine = clean
    .split(/\r?\n/)[0]
    ?.trim();
  return firstLine || 'Не удалось проверить сообщения HH. Повторю при следующей проверке.';
}

class ChatNotWritableError extends Error {
  constructor() {
    super('Ответ в этом чате недоступен — вероятно, работодатель отказал или ещё не открыл переписку.');
    this.name = 'ChatNotWritableError';
  }
}

export function detectChatDecisionKind(text: string): HhChatDecisionKind | null {
  const value = compactText(text).toLocaleLowerCase('ru');
  if (/(?:^|[^\p{L}])ип(?:$|[^\p{L}])|самозан|смз|гпх|оформлен|договор/iu.test(value)) return 'contract';
  if (/зарплат|заработн.*плат|оклад|доход|компенсац|финансов.*мотивац|ожидан.*₽|желаем.*уров.*(?:заработ|зарплат|оплат|доход)/i.test(value)) return 'salary';
  if (/опыт.*(?:автотест|автоматизац|тестирован).*\d+\s*(?:год|года|лет)|(?:более|свыше|не\s+менее)\s*\d+\s*(?:год|года|лет).*опыт/i.test(value)) return 'experience';
  if (/релокац|переезд|переехать/i.test(value)) return 'relocation';
  if (/когда.*(?:выйти|приступить|начать)|дата выхода|срок выхода/i.test(value)) return 'start_date';
  if (/график|смен|рабоч.*час|выходн|ночн/i.test(value)) return 'schedule';
  if (/удален|удалён|офис|гибрид|формат работы/i.test(value)) return 'work_format';
  if (/командиров/i.test(value)) return 'travel';
  if (/гражданств|разрешен.*работ|разрешён.*работ|work permit|виза/i.test(value)) return 'work_authorization';
  return null;
}

export function chatDecisionQuestion(kind: HhChatDecisionKind): string {
  switch (kind) {
    case 'contract': return 'Готовы ли вы работать по ИП, ГПХ или как самозанятый? Напишите точный ответ для HR.';
    case 'salary': return 'Какие зарплатные ожидания можно назвать HR?';
    case 'experience': return 'Какой стаж из выбранного резюме нужно подтвердить работодателю?';
    case 'relocation': return 'Готовы ли вы к указанной релокации? Уточните условия, если они важны.';
    case 'start_date': return 'Когда вы готовы приступить к работе?';
    case 'schedule': return 'Подходит ли вам предложенный график или смены?';
    case 'work_format': return 'Какой формат работы вам подходит: удалённо, офис или гибрид?';
    case 'travel': return 'Готовы ли вы к командировкам и с какой частотой?';
    case 'work_authorization': return 'Как корректно ответить про гражданство или право на работу?';
    case 'candidate_fact': return 'Какой точный ответ можно отправить работодателю?';
  }
}

export function extractChatUserInputQuestion(reply: string): string | null {
  const match = compactText(reply).match(/^NEEDS_USER_INPUT\s*:\s*(.+)$/i);
  return match?.[1]?.trim().slice(0, 500) || null;
}

export function isBotRecruiterLabel(text: string): boolean {
  return /робот(?:а|ом|у|е)?[-\s]?рекрутер(?:а|ом|у|е)?|виртуальн(?:ый|ого|ому|ым) рекрутер|бот(?:а|ом|у|е)?[-\s]?рекрутер(?:а|ом|у|е)?/i.test(text);
}

export function isTelegramHandoffMessage(text: string): boolean {
  const compact = compactText(text);
  const mentionsTelegram = /(?:telegram|телеграм|(?:^|\W)(?:tg|тг)(?:\W|$)|t\.me\/)/i.test(compact);
  const hasContact = /@[a-z0-9_]{4,}|t\.me\/[a-z0-9_]{4,}|(?:напиш|свяж|перейд|продолж|контакт)/i.test(compact);
  return mentionsTelegram && hasContact;
}

export function isNotifiableRecruiterMessage(
  verifiedBot: boolean,
  message: Pick<ChatMessage, 'text' | 'isMine' | 'isSystem'>,
): boolean {
  if (verifiedBot || message.isMine || message.isSystem) return false;
  return !isHhPlatformAssistantMessage(message.text);
}

export function recruiterNoticeKind(text: string, now = new Date()): HhChatNoticeKind {
  if (isTelegramHandoffMessage(text)) return 'telegram';
  if (analyzeInterviewMessage(text, now).isSchedulingMessage) return 'interview';
  return 'message';
}

export function isOutgoingChatClassName(value: string): boolean {
  return /(?:message_my|chat-bubble_outgoing|(?:^|[_-])outgoing(?:[_-]|$))/i.test(value);
}

export type GetPageFn = (purpose?: 'background' | 'explicit') => Promise<Page | null>;
export type GetCandidateProfileFn = (
  context: HhChatNegotiationContext,
) => Promise<HhChatCandidateProfile | ''>;

export class HhChatBrowser {
  private readonly getPage: GetPageFn;
  private readonly llmCall: (prompt: string) => Promise<string>;
  private config: HhChatConfig;
  private seenMessageIds: Set<string> = new Set();
  private repliesToday = 0;
  private replyDate = '';
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastPollAt: string | null = null;
  private error: string | null = null;
  private activeNegotiations = 0;
  private checkedNegotiations = 0;
  private unreadMessages = 0;
  private conversations: HhChatConversation[] = [];
  private replyHistory: HhChatReplyRecord[] = [];
  private pendingDecisions: HhChatPendingDecision[] = [];
  private confirmedFacts: HhChatFact[] = [];
  private notifiedInterviewMessageIds: Set<string> = new Set();
  private pollCursor = 0;
  private readonly userDataDir: string;

  constructor(
    userDataDir: string,
    getPage: GetPageFn,
    llmCall: (prompt: string) => Promise<string>,
    private readonly interviewCalendar?: InterviewCalendarStore,
    private readonly onInterviewInvitation?: (notice: HhInterviewInvitationNotice) => void,
    private readonly getCandidateProfile?: GetCandidateProfileFn,
    private readonly afterBackgroundAction?: () => Promise<void> | void,
  ) {
    this.userDataDir = userDataDir;
    this.getPage = getPage;
    this.llmCall = llmCall;

    const persisted = this.load();
    this.config = {
      ...DEFAULT_CHAT_CONFIG,
      ...persisted?.config,
      // The prompt is an internal safety contract, not a user preference. Old
      // versions persisted instructions that leaked the product name and
      // mentioned test tasks in unrelated answers, so always migrate it.
      replyPrompt: DEFAULT_CHAT_CONFIG.replyPrompt,
      onlyDiscussions: false,
    };
    this.replyDate = this.todayKey();
    if (persisted?.replyDate === this.replyDate) {
      this.repliesToday = persisted.repliesToday ?? 0;
    }
    if (persisted?.seenMessageIds) {
      this.seenMessageIds = new Set(persisted.seenMessageIds.slice(-500));
    }
    if (Array.isArray(persisted?.pendingDecisions)) {
      this.pendingDecisions = persisted.pendingDecisions.slice(-100);
    }
    if (Array.isArray(persisted?.replyHistory)) {
      this.replyHistory = persisted.replyHistory.slice(-300);
    }
    const shouldMigrateReplyCounter = Boolean(persisted && persisted.replyHistoryVersion !== 1);
    if (shouldMigrateReplyCounter) {
      // Legacy builds counted attempted replies but did not retain their exact
      // text. Start the auditable counter from confirmed records so the number
      // shown in the UI always matches the journal the user can inspect.
      this.repliesToday = this.replyHistory.filter((item) =>
        item.sentAt && this.dateKey(new Date(item.sentAt)) === this.replyDate).length;
    }
    if (Array.isArray(persisted?.confirmedFacts)) {
      this.confirmedFacts = persisted.confirmedFacts.slice(-100);
    }
    if (Array.isArray(persisted?.notifiedInterviewMessageIds)) {
      this.notifiedInterviewMessageIds = new Set(persisted.notifiedInterviewMessageIds.slice(-500));
    }
    this.pollCursor = Math.max(0, Math.round(persisted?.pollCursor ?? 0));
    if (
      persisted && (
        persisted.config?.replyPrompt !== DEFAULT_CHAT_CONFIG.replyPrompt ||
        persisted.config?.onlyDiscussions ||
        shouldMigrateReplyCounter
      )
    ) {
      this.persist();
    }
  }

  getState(): HhChatState {
    this.rollDailyCounter();
    return {
      enabled: this.config.enabled,
      polling: this.polling,
      lastPollAt: this.lastPollAt,
      repliesToday: this.repliesToday,
      activeNegotiations: this.activeNegotiations,
      checkedNegotiations: this.checkedNegotiations,
      unreadMessages: this.unreadMessages,
      conversations: structuredClone(this.conversations),
      replyHistory: structuredClone(this.replyHistory),
      pendingDecisions: structuredClone(this.pendingDecisions),
      confirmedFacts: structuredClone(this.confirmedFacts),
      config: { ...this.config },
      error: this.error,
    };
  }

  getConfig(): HhChatConfig {
    return { ...this.config };
  }

  saveConfig(partial: Partial<HhChatConfig>): HhChatConfig {
    const wasEnabled = this.config.enabled;
    this.config = {
      ...this.config,
      ...partial,
      replyPrompt: DEFAULT_CHAT_CONFIG.replyPrompt,
      onlyDiscussions: false,
      pollIntervalSec: Math.max(30, Math.round(partial.pollIntervalSec ?? this.config.pollIntervalSec)),
      dailyReplyLimit: Math.max(1, Math.round(partial.dailyReplyLimit ?? this.config.dailyReplyLimit)),
      replyDelaySec: Math.max(0, Math.round(partial.replyDelaySec ?? this.config.replyDelaySec)),
      minMessageLength: Math.max(1, Math.round(partial.minMessageLength ?? this.config.minMessageLength)),
    };
    this.persist();

    if (!wasEnabled && this.config.enabled) {
      this.startPolling();
    } else if (wasEnabled && !this.config.enabled) {
      this.stopPolling();
    }
    return this.getConfig();
  }

  setEnabled(enabled: boolean): HhChatState {
    this.saveConfig({ enabled });
    return this.getState();
  }

  async pollNow(): Promise<HhChatState> {
    await this.pollOnce(true);
    return this.getState();
  }

  async answerDecision(
    decisionId: string,
    rawAnswer: string,
    remember = true,
  ): Promise<HhChatState> {
    const answer = compactText(rawAnswer).slice(0, 3_000);
    if (!answer) throw new Error('Напишите ответ для работодателя.');
    if (this.polling) throw new Error('Дождитесь завершения текущей проверки сообщений.');
    const pending = this.pendingDecisions.find((item) => item.id === decisionId);
    if (!pending) throw new Error('Этот вопрос уже обработан или больше не найден.');
    const page = await this.getPage('explicit');
    if (!page || page.isClosed()) throw new Error('Браузер HH не открыт. Подключите HH ещё раз.');
    if (!this.isNegotiationsPage(page.url())) {
      await page.goto(HH_NEGOTIATIONS_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    const negotiations = await this.findNegotiationsPage(
      page,
      new Set([pending.negotiationKey]),
    );
    const negotiation = negotiations.find((item) => item.key === pending.negotiationKey);
    if (!negotiation) throw new Error('Диалог больше не найден в активных откликах HH.');
    if (negotiation.isRejected) {
      this.pendingDecisions = this.pendingDecisions.filter((item) => item.id !== pending.id);
      this.persist();
      throw new Error('Работодатель уже отказал по этой вакансии. Ответ больше не требуется.');
    }
    const frame = await this.openNegotiation(page, negotiation);
    await this.sendChatMessage(frame, answer);
    this.recordReply({
      negotiationKey: pending.negotiationKey,
      messageId: pending.messageId,
      vacancyTitle: pending.vacancyTitle,
      companyName: pending.companyName,
      recruiterMessage: pending.recruiterMessage,
      reply: answer,
      source: 'user_confirmed',
    });
    this.seenMessageIds.add(pending.messageId);
    this.pendingDecisions = this.pendingDecisions.filter((item) => item.id !== pending.id);
    if (remember) {
      const recruiterQuestion = pending.recruiterMessage;
      const recruiterQuestionKey = chatFactQuestionKey(recruiterQuestion);
      const factScopeMatches = (item: HhChatFact) => item.kind === pending.kind
        && chatFactQuestionKey(item.question) === recruiterQuestionKey;
      const previous = this.confirmedFacts.find(factScopeMatches);
      const fact: HhChatFact = {
        id: previous?.id ?? `chat-fact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: pending.kind,
        question: recruiterQuestion,
        answer,
        updatedAt: new Date().toISOString(),
      };
      this.confirmedFacts = [
        ...this.confirmedFacts.filter((item) => !factScopeMatches(item)),
        fact,
      ].slice(-100);
    }
    this.conversations = this.conversations.map((item) => item.key === pending.negotiationKey
      ? { ...item, lastMessage: answer, lastMessageMine: true, hasUnread: false, needsUserInput: false }
      : item);
    this.persist();
    return this.getState();
  }

  forgetFact(factId: string): HhChatState {
    this.confirmedFacts = this.confirmedFacts.filter((item) => item.id !== factId);
    this.persist();
    return this.getState();
  }

  startPolling(): void {
    if (this.pollTimer) return;
    this.scheduleNext();
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.polling = false;
  }

  dispose(): void {
    this.stopPolling();
  }

  private scheduleNext(): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollOnce().finally(() => {
        if (this.config.enabled) this.scheduleNext();
      });
    }, this.config.pollIntervalSec * 1000);
  }

  private async pollOnce(explicit = false): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.error = null;
    this.unreadMessages = 0;
    this.checkedNegotiations = 0;
    this.rollDailyCounter();

    try {
      const page = await this.getPage(explicit ? 'explicit' : 'background');
      if (!page || page.isClosed()) {
        if (!explicit) return;
        throw new Error('Браузер HH не открыт. Сначала подключите HH в разделе автооткликов.');
      }

      if (!this.isNegotiationsPage(page.url())) {
        await page.goto(HH_NEGOTIATIONS_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
      }
      if (page.url().includes('/account/login')) {
        throw new Error('Сессия HH истекла. Повторно подключите аккаунт HH.');
      }

      await page
        .locator(NEGOTIATION_ITEM_SELECTOR)
        .first()
        .waitFor({ state: 'attached', timeout: 10_000 })
        .catch(() => undefined);

      const priorityKeys = new Set([
        ...this.pendingDecisions.map((item) => item.negotiationKey),
        ...[...this.seenMessageIds]
          .filter((messageId) => !this.replyHistory.some((item) => item.messageId === messageId))
          .map((messageId) => messageId.split(':chatik-chat-message-')[0]),
      ]);
      const allNegotiations = await this.findNegotiationsPage(page, priorityKeys);
      const rejectedKeys = new Set(
        allNegotiations.filter((item) => item.isRejected).map((item) => item.key),
      );
      for (const negotiationKey of rejectedKeys) {
        this.interviewCalendar?.cancelNegotiation(negotiationKey);
      }
      const seenCountBeforeRejectCleanup = this.seenMessageIds.size;
      for (const messageId of this.seenMessageIds) {
        const negotiationKey = messageId.split(':chatik-chat-message-')[0];
        if (rejectedKeys.has(negotiationKey)) this.seenMessageIds.delete(messageId);
      }
      const negotiations = allNegotiations.filter((item) => !item.isRejected);
      const pendingCountBeforeRejectCleanup = this.pendingDecisions.length;
      this.pendingDecisions = this.pendingDecisions.filter(
        (pending) => !rejectedKeys.has(pending.negotiationKey),
      );
      this.activeNegotiations = negotiations.length;
      const cursor = negotiations.length > 0 ? this.pollCursor % negotiations.length : 0;
      const rotated = [
        ...negotiations.slice(cursor),
        ...negotiations.slice(0, cursor),
      ];
      const ordered = [
        ...rotated.filter((item) => priorityKeys.has(item.key)),
        ...rotated.filter((item) => !priorityKeys.has(item.key)),
      ].slice(0, CHAT_BATCH_SIZE);
      if (negotiations.length > 0) {
        this.pollCursor = (cursor + Math.min(CHAT_BATCH_SIZE, negotiations.length)) % negotiations.length;
      }
      const conversations = new Map<string, HhChatConversation>(negotiations.map((item) => [item.key, {
        key: item.key,
        vacancyTitle: item.vacancyTitle,
        companyName: item.companyName,
        vacancyUrl: item.vacancyUrl,
        stage: 'waiting',
        hasUnread: item.hasUnread,
        lastMessage: '',
        lastMessageMine: false,
        lastRecruiterMessage: '',
        needsUserInput: this.pendingDecisions.some((pending) => pending.negotiationKey === item.key),
      }]));
      let shouldPersist = negotiations.length > 0 ||
        this.pendingDecisions.length !== pendingCountBeforeRejectCleanup ||
        this.seenMessageIds.size !== seenCountBeforeRejectCleanup;
      let chatFailures = 0;

      for (const negotiation of ordered) {
        try {
          const frame = await this.openNegotiation(page, negotiation);
        const messages = await this.scrapeMessages(frame);
        const latestMessage = await this.scrapeLastMessage(frame, messages);
        const unansweredQuestionnaire = findLatestUnansweredRecruiterQuestionnaire(messages);
        const lastMessage = unansweredQuestionnaire ?? latestMessage;
        const frameLabel = compactText(await frame.locator('body').innerText({ timeout: 1_500 }).catch(() => ''));
        const previousConversation = conversations.get(negotiation.key)!;
        const verifiedBot = isBotRecruiterLabel(frameLabel);
        const hasInboundMessage = messages.some((message) => (
          !message.isMine &&
          !message.isSystem &&
          !isHhPlatformAssistantMessage(message.text)
        ));
        const lastRecruiterMessage = [...messages]
          .reverse()
          .find((message) => (
            !message.isMine &&
            !message.isSystem &&
            !isHhPlatformAssistantMessage(message.text)
          ))?.text ?? '';
        conversations.set(negotiation.key, {
          ...previousConversation,
          stage: verifiedBot ? 'bot' : hasInboundMessage ? 'hr' : 'waiting',
          lastMessage: latestMessage?.text ?? '',
          lastMessageMine: latestMessage?.isMine ?? false,
          lastRecruiterMessage,
        });
        if (this.recoverReplyHistory(negotiation, messages)) shouldPersist = true;
        if (!lastMessage || (!unansweredQuestionnaire && lastMessage.isMine)) continue;

        this.unreadMessages += 1;
        const questionnaire = isRecruiterQuestionnaire(lastMessage.text);
        const messageId = questionnaire
          ? `${negotiation.key}:${lastMessage.id}:questionnaire-v${QUESTIONNAIRE_ROUTE_VERSION}`
          : `${negotiation.key}:${lastMessage.id}`;
        if (questionnaire) {
          // v1 could already contain a calendar answer produced by the old
          // routing order. The v2 id retries the real questionnaire while this
          // removes only calendar state derived from that exact bad message.
          this.interviewCalendar?.discardMistakenQuestionnaireScheduling(
            negotiation.key,
            lastMessage.text,
          );
        }
        if (this.seenMessageIds.has(messageId)) {
          if (this.replyHistory.some((item) => item.messageId === messageId)) continue;
          // Legacy versions could mark an inbound message as seen even when HH
          // never rendered an outgoing answer. Retry it instead of losing it.
          this.seenMessageIds.delete(messageId);
          shouldPersist = true;
        }
        if (lastMessage.text.length < this.config.minMessageLength) continue;
        if (isTerminalChatText(lastMessage.text)) {
          conversations.delete(negotiation.key);
          this.pendingDecisions = this.pendingDecisions.filter(
            (pending) => pending.negotiationKey !== negotiation.key,
          );
          this.interviewCalendar?.cancelNegotiation(negotiation.key);
          this.seenMessageIds.add(messageId);
          shouldPersist = true;
          continue;
        }
        if (this.shouldIgnore(lastMessage.text)) {
          this.seenMessageIds.add(messageId);
          shouldPersist = true;
          continue;
        }
        if (
          isNotifiableRecruiterMessage(verifiedBot, lastMessage)
          && !this.notifiedInterviewMessageIds.has(messageId)
        ) {
          this.notifiedInterviewMessageIds.add(messageId);
          let chatUrl = '';
          try {
            chatUrl = frame.url();
          } catch {
            chatUrl = '';
          }
          try {
            this.onInterviewInvitation?.({
              messageId,
              negotiationKey: negotiation.key,
              vacancyTitle: negotiation.vacancyTitle,
              companyName: negotiation.companyName,
              recruiterMessage: lastMessage.text,
              chatUrl,
              kind: recruiterNoticeKind(lastMessage.text),
            });
          } catch (error) {
            console.warn('[hh-chat-browser] recruiter notification failed:', error);
          }
          shouldPersist = true;
        }
        const chatInputVisible = await frame
          .locator(CHAT_INPUT_SELECTOR)
          .first()
          .isVisible()
          .catch(() => false);
        const quickReplyVisible = chatInputVisible ? false : await this.hasVisibleYesNoReply(frame);
        if (!chatInputVisible && !quickReplyVisible) continue;
        // A numbered questionnaire may contain words such as "интервью",
        // "дата" or "время". It still has to reach the questionnaire prompt
        // and be answered point by point instead of becoming a calendar reply.
        const scheduling = questionnaire
          ? { handled: false }
          : this.handleSchedulingMessage(
            negotiation,
            lastMessage.text,
            this.repliesToday < this.config.dailyReplyLimit,
          );
        if (scheduling.handled) {
          if (!scheduling.reply) {
            if (scheduling.consume) {
              this.seenMessageIds.add(messageId);
              shouldPersist = true;
            }
            continue;
          }
          await this.delay(this.config.replyDelaySec * 1000);
          await this.sendChatMessage(frame, scheduling.reply);
          this.seenMessageIds.add(messageId);
          this.recordReply({
            negotiationKey: negotiation.key,
            messageId,
            vacancyTitle: negotiation.vacancyTitle,
            companyName: negotiation.companyName,
            recruiterMessage: lastMessage.text,
            reply: scheduling.reply,
            source: 'scheduling',
          });
          shouldPersist = true;
          continue;
        }
        if (this.repliesToday >= this.config.dailyReplyLimit) continue;

        // A salary or experience question inside a larger questionnaire must
        // never short-circuit the remaining questions.
        const decisionKind = questionnaire ? null : detectChatDecisionKind(lastMessage.text);
        if (decisionKind) {
          const canAutoAnswerDecision = decisionKind !== 'salary'
            || isSalaryExpectationQuestion(lastMessage.text);
          let resumeAnswer = '';
          if (
            canAutoAnswerDecision
            && (decisionKind === 'salary' || decisionKind === 'experience')
            && this.getCandidateProfile
          ) {
            const candidateProfile = await this.settleWithin<HhChatCandidateProfile | ''>(
              this.getCandidateProfile({
                negotiationKey: negotiation.key,
                vacancyTitle: negotiation.vacancyTitle,
                companyName: negotiation.companyName,
                vacancyUrl: negotiation.vacancyUrl,
              }).catch((error) => {
                console.warn('[hh-chat-browser] salary resume lookup failed:', error);
                return '' as const;
              }),
              8_000,
              '',
            );
            const selectedResumeText = candidateProfile
              ? candidateProfile.selectedResumeText
              : '';
            if (decisionKind === 'salary') {
              const salaryExpectation = findSalaryExpectation(null, [selectedResumeText]);
              if (salaryExpectation) {
                resumeAnswer = buildSalaryExpectationAnswer(
                  salaryExpectation,
                  lastMessage.text,
                  selectedResumeText,
                );
              }
            } else {
              resumeAnswer = answerExperienceThresholdFromResume(lastMessage.text, selectedResumeText) ?? '';
            }
          }
          const recruiterQuestionKey = chatFactQuestionKey(lastMessage.text);
          const confirmed = canAutoAnswerDecision && decisionKind !== 'salary'
            ? this.confirmedFacts.find((item) => item.kind === decisionKind
              && chatFactQuestionKey(item.question) === recruiterQuestionKey)
            : undefined;
          const automaticAnswer = resumeAnswer || confirmed?.answer || '';
          if (automaticAnswer) {
            await this.delay(this.config.replyDelaySec * 1000);
            await this.sendChatAnswer(frame, automaticAnswer);
            this.seenMessageIds.add(messageId);
            this.pendingDecisions = this.pendingDecisions.filter((item) => item.messageId !== messageId);
            this.recordReply({
              negotiationKey: negotiation.key,
              messageId,
              vacancyTitle: negotiation.vacancyTitle,
              companyName: negotiation.companyName,
              recruiterMessage: lastMessage.text,
              reply: automaticAnswer,
              source: resumeAnswer ? 'resume_fact' : 'saved_fact',
            });
            shouldPersist = true;
            conversations.set(negotiation.key, {
              ...conversations.get(negotiation.key)!,
              lastMessage: automaticAnswer,
              lastMessageMine: true,
              hasUnread: false,
              needsUserInput: false,
            });
            continue;
          }
          if (this.pendingDecisions.some((item) => item.messageId === messageId)) {
            conversations.set(negotiation.key, {
              ...conversations.get(negotiation.key)!,
              needsUserInput: true,
            });
            continue;
          }
          if (!this.pendingDecisions.some((item) => item.messageId === messageId)) {
            this.pendingDecisions.push({
              id: `chat-decision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              negotiationKey: negotiation.key,
              messageId,
              vacancyTitle: negotiation.vacancyTitle,
              companyName: negotiation.companyName,
              recruiterMessage: lastMessage.text,
              question: chatDecisionQuestion(decisionKind),
              kind: decisionKind,
              createdAt: new Date().toISOString(),
            });
            this.pendingDecisions = this.pendingDecisions.slice(-100);
            shouldPersist = true;
          }
          conversations.set(negotiation.key, {
            ...conversations.get(negotiation.key)!,
            needsUserInput: true,
          });
          continue;
        }

        const candidateProfilePromise: Promise<HhChatCandidateProfile | ''> =
          this.getCandidateProfile?.({
            negotiationKey: negotiation.key,
            vacancyTitle: negotiation.vacancyTitle,
            companyName: negotiation.companyName,
            vacancyUrl: negotiation.vacancyUrl,
          })
            .catch((error) => {
              console.warn('[hh-chat-browser] candidate profile unavailable:', error);
              return '' as const;
            }) ?? Promise.resolve('' as const);
        const candidateProfileResult = await this.settleWithin<HhChatCandidateProfile | ''>(
          candidateProfilePromise,
          8_000,
          '',
        );
        const candidateProfile = (candidateProfileResult
          ? buildHhChatCandidateProfileContent(candidateProfileResult)
          : '')
          .trim()
          .slice(0, 12_000);
        const selectedResumeProfile = candidateProfileResult
          ? candidateProfileResult.selectedResumeText.trim().slice(0, 12_000)
          : '';
        const confirmedFacts = this.confirmedFacts.length > 0
          ? `\n\nПодтверждённые пользователем условия (используй только когда вопрос совпадает по смыслу):\n${this.confirmedFacts.map((item) => `- ${item.question}: ${item.answer}`).join('\n')}`
          : '';
        const unknownFactRule = this.config.replyPrompt.includes('NEEDS_USER_INPUT:')
          ? ''
          : '\n\nЕсли для ответа нужен неизвестный личный факт кандидата, верни только: NEEDS_USER_INPUT: <короткий вопрос кандидату>.';
        const questionnaireRule = questionnaire
          ? [
            '',
            'Это анкета работодателя из нескольких вопросов.',
            'Для неё правило «максимум 2 предложения» НЕ применяется.',
            'Ответь на КАЖДЫЙ пункт по порядку и сохрани исходную нумерацию в формате 1), 2), 3). Не пропускай ни одного номера.',
            'Технические вопросы объясняй конкретно и по существу. Личный опыт подтверждай только профилем кандидата; знание инструмента не выдавай за практический опыт.',
            'Если в одном из пунктов спрашивают зарплату, возьми сумму из выбранного резюме, но обязательно ответь и на все остальные пункты.',
            'Можно дать по 1–4 коротких предложения на пункт. Не добавляй вступление, подпись и заключение.',
          ].join('\n')
          : '';
        const prompt = (this.config.replyPrompt + confirmedFacts + unknownFactRule + questionnaireRule)
          .replaceAll('{vacancy}', negotiation.vacancyTitle)
          .replaceAll('{company}', negotiation.companyName)
          .replaceAll('{candidateProfile}', candidateProfile || '(подтверждённый профиль пока недоступен)')
          .replaceAll('{message}', lastMessage.text);
        const resumeReplyCandidate = buildGroundedRecruiterReply(
          lastMessage.text,
          selectedResumeProfile,
        );
        const resumeGroundedReply = resumeReplyCandidate
          ? prepareRecruiterReply(resumeReplyCandidate, lastMessage.text)
          : null;
        const recruiterQuestionKey = chatFactQuestionKey(lastMessage.text);
        const exactConfirmedFact = this.confirmedFacts.find((item) => (
          item.kind === 'candidate_fact'
          && chatFactQuestionKey(item.question) === recruiterQuestionKey
        ));
        const exactConfirmedReply = exactConfirmedFact
          ? prepareRecruiterReply(exactConfirmedFact.answer, lastMessage.text)
          : null;
        const trustedReply = resumeGroundedReply ?? exactConfirmedReply;
        const trustedReplySource: HhChatReplySource | null = resumeGroundedReply
          ? 'resume_fact'
          : exactConfirmedReply ? 'saved_fact' : null;

        if (requiresHhChatFactProvenance(lastMessage.text) && !trustedReply) {
          if (!this.pendingDecisions.some((item) => item.messageId === messageId)) {
            this.pendingDecisions.push({
              id: `chat-decision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              negotiationKey: negotiation.key,
              messageId,
              vacancyTitle: negotiation.vacancyTitle,
              companyName: negotiation.companyName,
              recruiterMessage: lastMessage.text,
              question: questionnaire
                ? 'Подтвердите единый ответ на все вопросы работодателя: анкета содержит личные, юридические или карьерные факты.'
                : `Подтвердите личный факт для ответа работодателю: «${lastMessage.text.slice(0, 300)}»`,
              kind: 'candidate_fact',
              createdAt: new Date().toISOString(),
            });
            this.pendingDecisions = this.pendingDecisions.slice(-100);
            shouldPersist = true;
          }
          conversations.set(negotiation.key, {
            ...conversations.get(negotiation.key)!,
            needsUserInput: true,
          });
          continue;
        }

        let rawReply = trustedReply ?? (await this.settleWithin(this.llmCall(prompt), 20_000, ''))
          .trim()
          .slice(0, 6_000);
        let reply = prepareRecruiterReply(rawReply, lastMessage.text);
        if (!reply && !trustedReply) {
          rawReply = (await this.settleWithin(
            this.llmCall(
              `${prompt}\n\nПредыдущий вариант не прошёл проверку безопасности или релевантности. ` +
              (questionnaire
                ? 'Перепиши ответ полностью: сохрани все номера исходной анкеты и ответь на каждый пункт. '
                : 'Перепиши ответ: сразу ответь на вопрос. ') +
              'Не упоминай приложение, календарь, тестовое без вопроса о нём, подпись или общие фразы.',
            ),
            20_000,
            '',
          )).trim().slice(0, 6_000);
          reply = prepareRecruiterReply(rawReply, lastMessage.text);
        }
        if (!reply) {
          if (!this.pendingDecisions.some((item) => item.messageId === messageId)) {
            this.pendingDecisions.push({
              id: `chat-decision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              negotiationKey: negotiation.key,
              messageId,
              vacancyTitle: negotiation.vacancyTitle,
              companyName: negotiation.companyName,
              recruiterMessage: lastMessage.text,
              question: `Как корректно ответить работодателю на сообщение: «${lastMessage.text.slice(0, 300)}»?`,
              kind: 'candidate_fact',
              createdAt: new Date().toISOString(),
            });
            this.pendingDecisions = this.pendingDecisions.slice(-100);
            shouldPersist = true;
          }
          conversations.set(negotiation.key, {
            ...conversations.get(negotiation.key)!,
            needsUserInput: true,
          });
          continue;
        }

        const missingFactQuestion = extractChatUserInputQuestion(reply);
        if (missingFactQuestion) {
          if (!this.pendingDecisions.some((item) => item.messageId === messageId)) {
            this.pendingDecisions.push({
              id: `chat-decision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              negotiationKey: negotiation.key,
              messageId,
              vacancyTitle: negotiation.vacancyTitle,
              companyName: negotiation.companyName,
              recruiterMessage: lastMessage.text,
              question: missingFactQuestion,
              kind: 'candidate_fact',
              createdAt: new Date().toISOString(),
            });
            this.pendingDecisions = this.pendingDecisions.slice(-100);
            shouldPersist = true;
          }
          conversations.set(negotiation.key, {
            ...conversations.get(negotiation.key)!,
            needsUserInput: true,
          });
          continue;
        }

        await this.delay(this.config.replyDelaySec * 1000);
        await this.sendChatMessage(frame, reply);

        this.seenMessageIds.add(messageId);
        this.recordReply({
          negotiationKey: negotiation.key,
          messageId,
          vacancyTitle: negotiation.vacancyTitle,
          companyName: negotiation.companyName,
          recruiterMessage: lastMessage.text,
          reply,
          source: trustedReplySource ?? 'generated',
        });
        shouldPersist = true;
        conversations.set(negotiation.key, {
          ...conversations.get(negotiation.key)!,
          lastMessage: reply,
          lastMessageMine: true,
          hasUnread: false,
          needsUserInput: false,
        });
        } catch (error) {
          if (error instanceof ChatNotWritableError) {
            console.info(
              `[hh-chat-browser] skipped non-writable chat: ${negotiation.vacancyTitle}`,
            );
            continue;
          }
          chatFailures += 1;
          console.warn(
            `[hh-chat-browser] skipped chat after an error: ${negotiation.vacancyTitle}`,
            error,
          );
        } finally {
          this.checkedNegotiations += 1;
        }
      }

      this.conversations = [...conversations.values()];
      this.lastPollAt = new Date().toISOString();
      if (chatFailures > 0) {
        this.error = `Временно пропущено чатов: ${chatFailures}. Остальные чаты проверены; повторю при следующей проверке.`;
      }
      if (shouldPersist) this.persist();
    } catch (error) {
      this.error = formatChatPollError(error);
      console.warn('[hh-chat-browser] poll error:', this.error);
    } finally {
      this.polling = false;
      await Promise.resolve(this.afterBackgroundAction?.()).catch((error) => {
        console.warn('[hh-chat-browser] could not restore the user tab:', error);
      });
    }
  }

  private handleSchedulingMessage(
    negotiation: NegotiationSummary,
    message: string,
    canReply: boolean,
  ): { handled: boolean; reply?: string; consume?: boolean } {
    if (!this.interviewCalendar) return { handled: false };
    if (isRecruiterQuestionnaire(message)) return { handled: false };
    const now = new Date();
    const analysis = analyzeInterviewMessage(message, now);
    const previous = this.interviewCalendar.getThread(negotiation.key);
    if (!analysis.isSchedulingMessage) return { handled: false };
    if (
      !analysis.isCancellation &&
      !analysis.isConfirmation &&
      analysis.slots.length === 0 &&
      !analysis.requestsCandidateAvailability
    ) {
      return { handled: false };
    }

    const type: InterviewType =
      analysis.type !== 'other' ? analysis.type : previous?.type ?? 'other';
    const threadBase = {
      negotiationKey: negotiation.key,
      vacancyTitle: negotiation.vacancyTitle,
      companyName: negotiation.companyName,
      type,
      recruiterMessage: message,
    };

    if (analysis.isCancellation) {
      this.interviewCalendar.cancelNegotiation(negotiation.key);
      this.interviewCalendar.upsertThread({
        ...threadBase,
        stage: 'cancelled',
        offeredSlots: [],
        reason: 'Работодатель отменил встречу. Событие сохранено в истории как отменённое.',
      });
      return canReply
        ? { handled: true, reply: 'Спасибо, понял. Если появится новая дата, буду рад согласовать её.' }
        : { handled: true, consume: true };
    }

    const settings = this.interviewCalendar.getSettings();
    const calendarState = this.interviewCalendar.getState();
    const existingEventId = calendarState.events.find(
      (event) => event.negotiationKey === negotiation.key && event.status !== 'cancelled',
    )?.id;
    let selected = analysis.slots[0] ?? null;
    if (analysis.isConfirmation && previous) {
      selected = analysis.slots[0] ??
        chooseThreadSlot(message, previous.offeredSlots) ??
        (previous.selectedStartAt ? new Date(previous.selectedStartAt) : null);
    }

    if (
      analysis.isConfirmation &&
      selected &&
      (previous?.selectedStartAt === selected.toISOString() ||
        isInterviewSlotAvailable(selected, settings, calendarState.events, settings.defaultDurationMin, now, existingEventId))
    ) {
      this.interviewCalendar.scheduleFromNegotiation({
        ...threadBase,
        start: selected,
        status: 'confirmed',
        meetingUrl: analysis.meetingUrl,
        notes: message,
      });
      this.interviewCalendar.upsertThread({
        ...threadBase,
        stage: 'confirmed',
        offeredSlots: previous?.offeredSlots ?? [selected.toISOString()],
        selectedStartAt: selected.toISOString(),
      });
      return canReply ? {
        handled: true,
        reply: `Спасибо, подтверждаю. Буду на связи ${formatInterviewSlotRu(selected, settings.timezone)}.`,
      } : { handled: true, consume: true };
    }

    if (!settings.availabilityConfigured || settings.availability.length === 0) {
      this.interviewCalendar.upsertThread({
        ...threadBase,
        stage: 'needs_availability',
        offeredSlots: analysis.slots.map((slot) => slot.toISOString()),
        reason: 'Заполните удобное время в календаре — до этого бот не будет предлагать даты от вашего имени.',
      });
      // Не помечаем сообщение обработанным: после сохранения доступности
      // следующий опрос сам вернётся к нему и продолжит согласование.
      return { handled: true };
    }

    if (analysis.isConfirmation && !selected) {
      this.interviewCalendar.upsertThread({
        ...threadBase,
        stage: 'needs_attention',
        offeredSlots: previous?.offeredSlots ?? [],
        reason: 'Работодатель подтвердил встречу без понятной даты или времени. Бот запросил уточнение.',
      });
      return canReply ? {
        handled: true,
        reply: 'Спасибо! Уточните, пожалуйста, дату и время созвона, чтобы я точно добавил встречу в календарь.',
      } : { handled: true };
    }

    if (!canReply) {
      this.interviewCalendar.upsertThread({
        ...threadBase,
        stage: 'needs_attention',
        offeredSlots: analysis.slots.map((slot) => slot.toISOString()),
        reason: 'Достигнут дневной лимит автоответов. Сообщение останется необработанным до следующего запуска.',
      });
      return { handled: true };
    }

    const availableRecruiterSlot = analysis.slots.find((slot) =>
      isInterviewSlotAvailable(
        slot,
        settings,
        calendarState.events,
        settings.defaultDurationMin,
        now,
        existingEventId,
      ),
    );
    if (availableRecruiterSlot) {
      this.interviewCalendar.scheduleFromNegotiation({
        ...threadBase,
        start: availableRecruiterSlot,
        status: 'proposed',
        meetingUrl: analysis.meetingUrl,
        notes: message,
      });
      this.interviewCalendar.upsertThread({
        ...threadBase,
        stage: 'awaiting_confirmation',
        offeredSlots: analysis.slots.map((slot) => slot.toISOString()),
        selectedStartAt: availableRecruiterSlot.toISOString(),
        reason: 'Время подходит. Бот принял слот и ждёт подтверждения работодателя.',
      });
      return {
        handled: true,
        reply: `Спасибо! Мне подходит ${formatInterviewSlotRu(availableRecruiterSlot, settings.timezone)}. Подтверждаю созвон.`,
      };
    }

    const alternatives = findRecruiterInterviewSlots(settings, calendarState.events, now, 3);
    if (alternatives.length === 0) {
      this.interviewCalendar.upsertThread({
        ...threadBase,
        stage: 'needs_attention',
        offeredSlots: analysis.slots.map((slot) => slot.toISOString()),
        reason: 'В ближайшие четыре недели нет свободного интервала. Освободите время или ответьте HR вручную.',
      });
      return { handled: true };
    }

    const offeredSlots = alternatives.map((slot) => slot.toISOString());
    const proposedByRecruiter = analysis.slots.length > 0;
    this.interviewCalendar.upsertThread({
      ...threadBase,
      stage: 'awaiting_recruiter',
      offeredSlots,
      reason: proposedByRecruiter
        ? 'Варианты HR не совпали с вашей доступностью. Бот предложил ближайшие свободные слоты.'
        : 'Бот предложил работодателю ближайшие свободные слоты.',
    });
    const options = formatRussianList(
      alternatives.map((slot) => formatRecruiterInterviewSlotRu(slot, now, settings.timezone)),
    );
    return {
      handled: true,
      reply: proposedByRecruiter
        ? `К сожалению, предложенное время не подойдёт. Могу созвониться: ${options}. Подойдёт ли один из вариантов?`
        : `Спасибо за приглашение! Мне удобно: ${options}. Подойдёт ли один из вариантов?`,
    };
  }

  private isNegotiationsPage(rawUrl: string): boolean {
    try {
      const url = new URL(rawUrl);
      return url.hostname.endsWith('hh.ru') && url.pathname === '/applicant/negotiations';
    } catch {
      return false;
    }
  }

  private negotiationPageIndex(rawUrl: string): number | null {
    try {
      const url = new URL(rawUrl);
      if (!url.hostname.endsWith('hh.ru') || url.pathname !== '/applicant/negotiations') return null;
      const value = Number(url.searchParams.get('page') ?? '0');
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    } catch {
      return null;
    }
  }

  private async findNegotiationsPage(
    page: Page,
    priorityKeys: Set<string>,
  ): Promise<NegotiationSummary[]> {
    let firstPage: NegotiationSummary[] = [];
    for (let pageIndex = 0; pageIndex < CHAT_RECOVERY_PAGE_LIMIT; pageIndex += 1) {
      if (this.negotiationPageIndex(page.url()) !== pageIndex) {
        const target = pageIndex === 0 ? HH_NEGOTIATIONS_URL : `${HH_NEGOTIATIONS_URL}?page=${pageIndex}`;
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page
          .locator(NEGOTIATION_ITEM_SELECTOR)
          .first()
          .waitFor({ state: 'attached', timeout: 7_000 })
          .catch(() => undefined);
      }
      const negotiations = await this.scrapeNegotiations(page);
      if (pageIndex === 0) firstPage = negotiations;
      if (priorityKeys.size === 0 || negotiations.some((item) => priorityKeys.has(item.key))) {
        return negotiations;
      }
    }

    if (this.negotiationPageIndex(page.url()) !== 0) {
      await page.goto(HH_NEGOTIATIONS_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page
        .locator(NEGOTIATION_ITEM_SELECTOR)
        .first()
        .waitFor({ state: 'attached', timeout: 7_000 })
        .catch(() => undefined);
      return this.scrapeNegotiations(page);
    }
    return firstPage;
  }

  private async scrapeNegotiations(page: Page): Promise<NegotiationSummary[]> {
    const result: NegotiationSummary[] = [];
    const items = page.locator(NEGOTIATION_ITEM_SELECTOR);
    const count = Math.min(await items.count(), 40);

    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      const vacancyTitle = compactText(
        await item.locator(NEGOTIATION_VACANCY_SELECTOR).first().innerText({ timeout: 1_500 }).catch(() => ''),
      );
      const vacancyHref = await item
        .locator(NEGOTIATION_VACANCY_SELECTOR)
        .first()
        .getAttribute('href', { timeout: 1_500 })
        .catch(() => null);
      const vacancyUrl = normalizeHhNegotiationVacancyUrl(vacancyHref ?? '');
      const companyName = compactText(
        await item.locator(NEGOTIATION_COMPANY_SELECTOR).first().innerText({ timeout: 1_500 }).catch(() => ''),
      );
      const openChat = item.locator(OPEN_CHAT_SELECTOR).first();
      if ((await openChat.count().catch(() => 0)) === 0) continue;
      const isDiscussion = (await item.locator(DISCUSSION_STATUS_SELECTOR).count().catch(() => 0)) > 0;
      const hasUnread = (await item.locator(UNREAD_STATUS_SELECTOR).count().catch(() => 0)) > 0;
      const rejectedStatus = item.locator(REJECTED_STATUS_SELECTOR).first();
      const hasRejectedStatus = (await rejectedStatus.count().catch(() => 0)) > 0;
      const rejectedDataQa = hasRejectedStatus
        ? (await rejectedStatus.getAttribute('data-qa', { timeout: 1_500 }).catch(() => '')) ?? ''
        : '';
      const rejectedLabel = compactText(
        hasRejectedStatus
          ? await rejectedStatus.innerText({ timeout: 1_500 }).catch(() => '')
          : await item.innerText({ timeout: 1_500 }).catch(() => ''),
      );
      const isRejected = isRejectedNegotiationStatus(rejectedDataQa, rejectedLabel);
      result.push({
        index,
        key: `${vacancyTitle}\u0000${companyName}`,
        vacancyTitle,
        companyName,
        vacancyUrl,
        isDiscussion,
        hasUnread,
        isRejected,
      });
    }
    return result;
  }

  private async openNegotiation(page: Page, negotiation: NegotiationSummary): Promise<Frame> {
    if (negotiation.isRejected) throw new ChatNotWritableError();
    const item = page.locator(NEGOTIATION_ITEM_SELECTOR).nth(negotiation.index);
    const button = item.locator(OPEN_CHAT_SELECTOR).first();
    if ((await button.count().catch(() => 0)) === 0) {
      throw new Error('HH изменил кнопку открытия чата.');
    }
    await button.click({ timeout: 3_000 });

    const deadline = Date.now() + CHAT_OPEN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const frames = page.frames().filter((frame) => frame.url().includes(CHAT_FRAME_URL_PART));
      for (const frame of frames.reverse()) {
        const header = compactText(
          await frame.locator(CHAT_VACANCY_SELECTOR).first().innerText().catch(() => ''),
        );
        // HH currently renders CHAT_VACANCY_SELECTOR as an icon-only arrow for
        // some accounts. The vacancy title is still present in the chat body,
        // so use it as a fallback when deciding that the requested chat opened.
        const chatLabel = header || compactText(
          await frame.locator('body').innerText({ timeout: 1_000 }).catch(() => ''),
        );
        if (
          !negotiation.vacancyTitle ||
          (chatLabel && (
            chatLabel.toLocaleLowerCase('ru').includes(negotiation.vacancyTitle.toLocaleLowerCase('ru')) ||
            negotiation.vacancyTitle.toLocaleLowerCase('ru').includes(chatLabel.toLocaleLowerCase('ru'))
          ))
        ) {
          await frame
            .locator(CHAT_MESSAGE_SELECTOR)
            .first()
            .waitFor({ state: 'attached', timeout: 2_000 })
            .catch(() => undefined);
          return frame;
        }
      }
      await this.delay(150);
    }
    throw new Error('HH не открыл чат с работодателем.');
  }

  private async scrapeMessages(frame: Frame): Promise<ChatMessage[]> {
    const messages = frame.locator(CHAT_MESSAGE_SELECTOR);
    const count = Math.min(await messages.count(), 150);
    const result: ChatMessage[] = [];
    for (let index = 0; index < count; index += 1) {
      const message = messages.nth(index);
      const dataQa = (await message.getAttribute('data-qa', { timeout: 1_000 }).catch(() => '')) ?? '';
      if (!/^chatik-chat-message-\d+$/.test(dataQa)) continue;
      if (!(await message.isVisible().catch(() => false))) continue;
      const textNode = message.locator(`[data-qa="${dataQa}-text"]`).first();
      const hasDedicatedText = (await textNode.count().catch(() => 0)) > 0;
      const rawText = hasDedicatedText
        ? await textNode.innerText({ timeout: 1_000 }).catch(() => '')
        : await message.innerText({ timeout: 1_000 }).catch(() => '');
      const text = compactText(hasDedicatedText ? rawText : stripTrailingChatTimestamp(rawText));
      if (!text) continue;
      const ownClass = await message
        .evaluate((element) => {
          const classNames = [
            typeof element.className === 'string' ? element.className : '',
            ...Array.from(element.querySelectorAll('[class]'), (child) =>
              typeof child.className === 'string' ? child.className : ''),
          ];
          return classNames.join(' ');
        })
        .catch(() => '');
      const hasOutgoingDescendant =
        (await message.locator(OUTGOING_SELECTOR).count().catch(() => 0)) > 0;
      const isSystem =
        (await message.locator('[data-qa^="participant-action-message-"]').count().catch(() => 0)) > 0 ||
        isHhPlatformAssistantMessage(text);
      result.push({
        id: dataQa,
        text,
        isMine: hasOutgoingDescendant || isOutgoingChatClassName(ownClass),
        isSystem,
      });
    }
    return result;
  }

  private async scrapeLastMessage(
    frame: Frame,
    snapshot?: ChatMessage[],
  ): Promise<ChatMessage | null> {
    const messages = snapshot ?? await this.scrapeMessages(frame);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (
        !messages[index].isSystem &&
        !isHhPlatformAssistantMessage(messages[index].text)
      ) return messages[index];
    }
    return null;
  }

  private async sendChatMessage(frame: Frame, text: string): Promise<void> {
    const input = frame.locator(CHAT_INPUT_SELECTOR).first();
    try {
      await input.waitFor({ state: 'visible', timeout: 1_500 });
    } catch {
      throw new ChatNotWritableError();
    }
    const beforeIds = new Set((await this.scrapeMessages(frame)).filter((item) => item.isMine).map((item) => item.id));

    await input.fill(text);
    if (compactText(await input.inputValue()) !== compactText(text)) {
      throw new Error('HH не принял текст ответа в поле чата.');
    }

    const sendButton = frame.locator(CHAT_SEND_SELECTOR).first();
    try {
      await sendButton.waitFor({ state: 'visible', timeout: 1_500 });
    } catch {
      throw new ChatNotWritableError();
    }
    await sendButton.click();

    const expected = compactText(text);
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const outgoing = (await this.scrapeMessages(frame)).filter(
        (item) => item.isMine && !beforeIds.has(item.id),
      );
      if (outgoing.some((item) => compactText(item.text).includes(expected))) return;
      await this.delay(200);
    }
    throw new Error('HH не подтвердил отправку ответа работодателю.');
  }

  private async hasVisibleYesNoReply(frame: Frame): Promise<boolean> {
    try {
      const buttons = frame.locator('button');
      const count = Math.min(await buttons.count(), 30);
      for (let index = 0; index < count; index += 1) {
        const button = buttons.nth(index);
        if (!(await button.isVisible().catch(() => false))) continue;
        const label = compactText(await button.innerText({ timeout: 500 }).catch(() => ''));
        if (/^(?:да|нет)$/i.test(label)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private async sendChatAnswer(frame: Frame, text: string): Promise<void> {
    const expected = compactText(text);
    if (/^(?:да|нет)$/i.test(expected)) {
      try {
        const buttons = frame.locator('button');
        const count = Math.min(await buttons.count(), 30);
        for (let index = 0; index < count; index += 1) {
          const button = buttons.nth(index);
          if (!(await button.isVisible().catch(() => false))) continue;
          const label = compactText(await button.innerText({ timeout: 500 }).catch(() => ''));
          if (label.toLocaleLowerCase('ru') !== expected.toLocaleLowerCase('ru')) continue;
          const beforeIds = new Set(
            (await this.scrapeMessages(frame)).filter((item) => item.isMine).map((item) => item.id),
          );
          await button.click({ timeout: 3_000 });
          const deadline = Date.now() + 12_000;
          while (Date.now() < deadline) {
            const outgoing = (await this.scrapeMessages(frame)).filter(
              (item) => item.isMine && !beforeIds.has(item.id),
            );
            if (outgoing.some((item) => compactText(item.text).includes(expected))) return;
            await this.delay(200);
          }
          throw new Error('HH не подтвердил выбор ответа работодателю.');
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('не подтвердил выбор')) throw error;
      }
    }
    await this.sendChatMessage(frame, text);
  }

  private shouldIgnore(text: string): boolean {
    const lower = text.toLocaleLowerCase('ru');
    return this.config.ignoredKeywords.split(',').some((keyword) => {
      const normalized = keyword.trim().toLocaleLowerCase('ru');
      return Boolean(normalized && lower.includes(normalized));
    });
  }

  private rollDailyCounter(): void {
    const today = this.todayKey();
    if (this.replyDate === today) return;
    this.replyDate = today;
    this.repliesToday = 0;
  }

  private recoverReplyHistory(
    negotiation: NegotiationSummary,
    messages: ChatMessage[],
  ): boolean {
    let changed = false;
    for (let index = 0; index < messages.length; index += 1) {
      const inbound = messages[index];
      if (inbound.isMine) continue;
      const messageId = `${negotiation.key}:${inbound.id}`;
      if (!this.seenMessageIds.has(messageId)) continue;
      if (this.replyHistory.some((item) => item.messageId === messageId)) continue;

      const nextInboundOffset = messages
        .slice(index + 1)
        .findIndex((item) => !item.isMine);
      const replyWindow = nextInboundOffset < 0
        ? messages.slice(index + 1)
        : messages.slice(index + 1, index + 1 + nextInboundOffset);
      const outgoing = replyWindow.find((item) => item.isMine);
      if (!outgoing) {
        if (inbound.isSystem) {
          // Old versions accidentally marked HH's "participant left" row as
          // answered. Remove that stale marker so the preceding real question
          // can be handled on this pass.
          this.seenMessageIds.delete(messageId);
          changed = true;
        }
        continue;
      }

      const recruiterMessage = inbound.isSystem
        ? messages.slice(0, index).reverse().find((item) => !item.isMine && !item.isSystem) ?? inbound
        : inbound;

      this.addReplyHistory({
        negotiationKey: negotiation.key,
        messageId,
        vacancyTitle: negotiation.vacancyTitle,
        companyName: negotiation.companyName,
        recruiterMessage: recruiterMessage.text,
        reply: outgoing.text,
        source: 'recovered',
        sentAt: null,
      });
      changed = true;
    }
    return changed;
  }

  private recordReply(
    entry: Omit<HhChatReplyRecord, 'id' | 'sentAt' | 'recordedAt' | 'status'>,
  ): void {
    if (this.replyHistory.some((item) => item.messageId === entry.messageId)) return;
    this.repliesToday += 1;
    this.addReplyHistory({ ...entry, sentAt: new Date().toISOString() });
  }

  private addReplyHistory(
    entry: Omit<HhChatReplyRecord, 'id' | 'recordedAt' | 'status'>,
  ): void {
    if (this.replyHistory.some((item) => item.messageId === entry.messageId)) return;
    const recordedAt = new Date().toISOString();
    this.replyHistory = [
      ...this.replyHistory,
      {
        ...entry,
        id: `chat-reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        recordedAt,
        status: 'sent' as const,
      },
    ].slice(-300);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async settleWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private dateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private todayKey(): string {
    return this.dateKey(new Date());
  }

  private load(): PersistedChatState | null {
    try {
      return JSON.parse(fs.readFileSync(chatStatePath(this.userDataDir), 'utf8')) as PersistedChatState;
    } catch {
      return null;
    }
  }

  private persist(): void {
    try {
      this.rollDailyCounter();
      fs.mkdirSync(path.dirname(chatStatePath(this.userDataDir)), { recursive: true });
      fs.writeFileSync(
        chatStatePath(this.userDataDir),
        JSON.stringify(
          {
            config: this.config,
            seenMessageIds: [...this.seenMessageIds].slice(-500),
            repliesToday: this.repliesToday,
            replyDate: this.replyDate,
            replyHistoryVersion: 1,
            replyHistory: this.replyHistory,
            pendingDecisions: this.pendingDecisions,
            confirmedFacts: this.confirmedFacts,
            notifiedInterviewMessageIds: [...this.notifiedInterviewMessageIds].slice(-500),
            pollCursor: this.pollCursor,
          } satisfies PersistedChatState,
          null,
          2,
        ),
        'utf8',
      );
    } catch (error) {
      console.warn('[hh-chat-browser] persist failed:', error);
    }
  }
}
