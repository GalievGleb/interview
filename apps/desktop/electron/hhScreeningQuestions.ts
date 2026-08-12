import type { Page } from 'playwright-core';

export type HhScreeningQuestionKind = 'text' | 'single' | 'multiple' | 'select';

export interface HhScreeningQuestion {
  id: string;
  prompt: string;
  kind: HhScreeningQuestionKind;
  options: string[];
  required: boolean;
  assistantReason?: string;
  suggestedAnswer?: string;
  suggestedOptions?: string[];
}

export interface HhScreeningAnswer {
  id: string;
  answer: string;
  selectedOptions: string[];
  canAutoFill: boolean;
  reason?: string;
  preparationNote?: string;
}

export interface HhScreeningAnswersRequest {
  vacancyTitle: string;
  vacancyCompany: string;
  vacancyDescription: string;
  resumeText?: string;
  questions: HhScreeningQuestion[];
  confirmedAnswers?: Array<{
    question: string;
    answer: string;
    selectedOptions: string[];
  }>;
  /** Interactive drafts may contain a cautious hypothesis that the user must confirm. */
  draftMode?: boolean;
  /** User-authored text that must be polished without changing its facts or position. */
  existingDraft?: {
    questionId: string;
    answer: string;
  };
  language: 'ru' | 'en';
}

export interface HhScreeningAnswersResponse {
  answers: HhScreeningAnswer[];
  model?: string;
}

interface RawControl {
  index: number;
  tag: string;
  type: string;
  name: string;
  id: string;
  dataQa: string;
  prompt: string;
  optionLabel: string;
  optionValue: string;
  selectOptions: Array<{ label: string; value: string }>;
  required: boolean;
}

export interface HhScreeningField {
  question: HhScreeningQuestion;
  controlIndices: number[];
  optionValues: Array<{ label: string; value: string; controlIndex?: number }>;
}

export interface HhUnresolvedScreeningQuestion {
  id: string;
  prompt: string;
  reason: string;
}

const SCREENING_CONTROL_SELECTOR = [
  'form textarea',
  'form select',
  'form input[type="text"]',
  'form input:not([type])',
  'form input[type="radio"]',
  'form input[type="checkbox"]',
].join(', ');

export function normalizeScreeningOption(value: string): string {
  return value
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9+#.]+/gi, ' ')
    .trim();
}

export function screeningQuestionKey(value: string): string {
  return normalizeScreeningOption(value).slice(0, 1_200);
}

export function matchScreeningOptionLabels(
  answer: Pick<HhScreeningAnswer, 'answer' | 'selectedOptions'>,
  options: string[],
  multiple: boolean,
): string[] {
  const requested = (answer.selectedOptions.length > 0
    ? answer.selectedOptions
    : [answer.answer])
    .map(normalizeScreeningOption)
    .filter(Boolean);
  const matches = options.filter((option) => {
    const normalized = normalizeScreeningOption(option);
    return requested.some((item) => item === normalized);
  });
  return multiple ? matches : matches.slice(0, 1);
}

function uniqueQuestionId(base: string, used: Set<string>): string {
  const normalized = base.replace(/[^a-zа-яё0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80)
    || 'question';
  let id = normalized;
  let suffix = 2;
  while (used.has(id)) id = `${normalized}-${suffix++}`;
  used.add(id);
  return id;
}

async function readControls(page: Page): Promise<RawControl[]> {
  const controls = page.locator(SCREENING_CONTROL_SELECTOR);
  const raw = await controls.evaluateAll((elements) => {
    const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const controlSelector = 'textarea, select, input[type="text"], input:not([type]), input[type="radio"], input[type="checkbox"]';
    const textWithoutControls = (element: Element): string => {
      const clone = element.cloneNode(true) as Element;
      clone.querySelectorAll('textarea, select, input, button, script, style, [role="alert"]').forEach((node) => node.remove());
      return clean((clone as HTMLElement).innerText || clone.textContent);
    };
    const promptFor = (control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string => {
      // HH's current test form labels textareas with the generic hint
      // "Писать тут". The real employer question is a sibling inside the
      // task body, so prefer it over aria-labelledby.
      const taskPrompt = clean(
        control.closest('[data-qa="task-body"]')
          ?.querySelector('[data-qa="task-question"]')
          ?.textContent,
      );
      if (taskPrompt.length >= 5) return taskPrompt;
      const labelledBy = control.getAttribute('aria-labelledby');
      if (labelledBy) {
        const labelled = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
        if (clean(labelled).length >= 5) return clean(labelled);
      }
      const directLabel = control.id
        ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)
        : null;
      const type = control instanceof HTMLInputElement ? control.type.toLowerCase() : '';
      if (type !== 'radio' && type !== 'checkbox') {
        const direct = clean(directLabel?.textContent);
        if (direct.length >= 5) return direct;
      }
      const fieldset = control.closest('fieldset');
      const legend = clean(fieldset?.querySelector('legend')?.textContent);
      if (legend.length >= 5) return legend;
      const qaContainer = control.closest(
        '[data-qa*="question"], [data-qa*="test"], [class*="question"], [class*="Question"]',
      );
      if (qaContainer) {
        const text = textWithoutControls(qaContainer);
        if (text.length >= 5) return text;
      }
      let ancestor: Element | null = control.parentElement;
      for (let depth = 0; ancestor && depth < 6; depth += 1, ancestor = ancestor.parentElement) {
        const contained = [...ancestor.querySelectorAll(controlSelector)];
        const sameGroup = contained.every((item) => {
          if (!(item instanceof HTMLInputElement) || !(control instanceof HTMLInputElement)) return item === control;
          return Boolean(control.name) && item.name === control.name && item.type === control.type;
        });
        if (contained.length > 1 && !sameGroup) continue;
        const text = textWithoutControls(ancestor);
        if (text.length >= 5 && text.length <= 1_500) return text;
      }
      return clean(control.getAttribute('placeholder'));
    };
    return elements.map((element, index) => {
      const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const inputType = control instanceof HTMLInputElement ? control.type.toLowerCase() : '';
      const directLabel = control.id
        ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)
        : control.closest('label');
      return {
        index,
        tag: control.tagName.toLowerCase(),
        type: inputType,
        name: control.getAttribute('name') ?? '',
        id: control.id ?? '',
        dataQa: control.getAttribute('data-qa') ?? '',
        prompt: promptFor(control),
        optionLabel: clean(directLabel?.textContent || control.getAttribute('aria-label') || control.getAttribute('value')),
        optionValue: control.getAttribute('value') ?? '',
        selectOptions: control instanceof HTMLSelectElement
          ? [...control.options].filter((option) => !option.disabled && clean(option.textContent)).map((option) => ({
              label: clean(option.textContent),
              value: option.value,
            }))
          : [],
        required: control.required || control.getAttribute('aria-required') === 'true',
      };
    });
  });

  const visible: RawControl[] = [];
  for (const item of raw) {
    const control = controls.nth(item.index);
    if (!(await control.isVisible().catch(() => false))) continue;
    if (await control.isDisabled().catch(() => true)) continue;
    if (/vacancy-response-popup-form-letter-input|cover.?letter/i.test(`${item.dataQa} ${item.name}`)) continue;
    if (/сопроводительн(?:ое|ого)\s+письм/i.test(item.prompt)) continue;
    visible.push(item);
  }
  return visible;
}

export async function collectHhScreeningFields(page: Page): Promise<HhScreeningField[]> {
  const controls = await readControls(page);
  const groups = new Map<string, RawControl[]>();
  for (const control of controls) {
    const grouped = control.type === 'radio' || control.type === 'checkbox';
    const key = grouped
      ? `${control.type}:${control.name || control.prompt}`
      : `control:${control.index}`;
    groups.set(key, [...(groups.get(key) ?? []), control]);
  }

  const usedIds = new Set<string>();
  const fields: HhScreeningField[] = [];
  for (const groupedControls of groups.values()) {
    const first = groupedControls[0];
    if (!first || first.prompt.length < 5) continue;
    const kind: HhScreeningQuestionKind = first.tag === 'select'
      ? 'select'
      : first.type === 'radio'
        ? 'single'
        : first.type === 'checkbox'
          ? 'multiple'
          : 'text';
    const optionValues = first.tag === 'select'
      ? first.selectOptions
      : groupedControls.map((control) => ({
          label: control.optionLabel,
          value: control.optionValue,
          controlIndex: control.index,
        })).filter((option) => option.label);
    const id = uniqueQuestionId(first.name || first.id || first.dataQa || `question-${first.index + 1}`, usedIds);
    fields.push({
      question: {
        id,
        prompt: first.prompt.slice(0, 1_200),
        kind,
        options: optionValues.map((option) => option.label),
        required: groupedControls.some((control) => control.required),
      },
      controlIndices: groupedControls.map((control) => control.index),
      optionValues,
    });
  }
  return fields.slice(0, 60);
}

export async function fillHhScreeningFields(
  page: Page,
  fields: HhScreeningField[],
  answers: HhScreeningAnswer[],
): Promise<{ filled: number; unresolved: HhUnresolvedScreeningQuestion[] }> {
  const controls = page.locator(SCREENING_CONTROL_SELECTOR);
  const answersById = new Map(answers.map((answer) => [answer.id, answer]));
  const unresolved: HhUnresolvedScreeningQuestion[] = [];
  const markUnresolved = (field: HhScreeningField, reason?: string) => {
    unresolved.push({
      id: field.question.id,
      prompt: field.question.prompt,
      reason: reason?.trim() || 'Нужен ответ пользователя.',
    });
  };
  let filled = 0;

  for (const field of fields) {
    const answer = answersById.get(field.question.id);
    if (!answer?.canAutoFill) {
      markUnresolved(field, answer?.reason);
      continue;
    }
    if (field.question.kind === 'text') {
      const text = answer.answer.trim();
      if (!text) {
        markUnresolved(field);
        continue;
      }
      const control = controls.nth(field.controlIndices[0]);
      const maxLength = Number(await control.getAttribute('maxlength'));
      const safeText = Number.isFinite(maxLength) && maxLength > 0 ? text.slice(0, maxLength) : text;
      await control.fill(safeText);
      if ((await control.inputValue()).trim() !== safeText.trim()) {
        markUnresolved(field, 'HH не принял введённый ответ.');
        continue;
      }
      filled += 1;
      continue;
    }

    const labels = matchScreeningOptionLabels(
      answer,
      field.optionValues.map((option) => option.label),
      field.question.kind === 'multiple',
    );
    if (labels.length === 0) {
      markUnresolved(field, 'Нужно выбрать один из вариантов работодателя.');
      continue;
    }
    if (field.question.kind === 'select') {
      const option = field.optionValues.find((candidate) => labels.includes(candidate.label));
      if (!option) {
        markUnresolved(field, 'Не удалось сопоставить выбранный вариант.');
        continue;
      }
      await controls.nth(field.controlIndices[0]).selectOption(option.value);
      filled += 1;
      continue;
    }
    let selected = 0;
    for (const option of field.optionValues) {
      if (!labels.includes(option.label) || option.controlIndex === undefined) continue;
      const control = controls.nth(option.controlIndex);
      if (!(await control.isChecked().catch(() => false))) {
        // Current HH Magritte radios keep the native input visually hidden.
        // Playwright's input.check({ force: true }) clicks it but HH does not
        // update React state. Clicking the containing label follows the same
        // path as a real user and changes the checked value reliably.
        const label = control.locator('xpath=ancestor::label[1]');
        if (await label.count()) {
          await label.click({ timeout: 5_000 }).catch(() => undefined);
        }
        if (!(await control.isChecked().catch(() => false))) {
          await control.evaluate((element) => (element as HTMLInputElement).click()).catch(() => undefined);
        }
        if (!(await control.isChecked().catch(() => false))) {
          await control.check({ force: true }).catch(() => undefined);
        }
      }
      if (await control.isChecked().catch(() => false)) selected += 1;
    }
    if (selected > 0) filled += 1;
    else markUnresolved(field, 'HH не принял выбранный вариант.');
  }
  return { filled, unresolved };
}
