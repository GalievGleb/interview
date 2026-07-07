import { describe, expect, it } from 'vitest';
import { pythonConceptSignals } from './vacancyReviewService';

// Регресс: локальная оценка грейдила вопрос про КОНКРЕТНЫЙ Python-концепт по
// generic-пунктам всей темы «Основы Python» (Базовые типы, ООП…). Верный ответ
// про контекстный менеджер получал 0 покрытия. Сигналы должны идти от ВОПРОСА.
describe('pythonConceptSignals', () => {
  it('распознаёт контекстный менеджер (баг из отчёта пользователя)', () => {
    const s = pythonConceptSignals('Что такое контекстный менеджер и где ты его применял?');
    expect(s).not.toBeNull();
    const joined = (s ?? []).join(' ').toLowerCase();
    expect(joined).toContain('__enter__');
    expect(joined).toContain('with');
    // не generic-пункты темы
    expect(joined).not.toContain('list/dict comprehensions');
  });

  it('распознаёт декоратор, генератор, GIL, mutable, исключения', () => {
    expect(pythonConceptSignals('Объясни декораторы')).not.toBeNull();
    expect(pythonConceptSignals('Чем генератор отличается от списка?')).not.toBeNull();
    expect(pythonConceptSignals('Что такое GIL?')).not.toBeNull();
    expect(pythonConceptSignals('list vs tuple — в чём разница?')).not.toBeNull();
    expect(pythonConceptSignals('Как обрабатываешь исключения?')).not.toBeNull();
  });

  it('русские основы со склонением (регресс: \\w не матчит кириллицу)', () => {
    // Полные словоформы с суффиксами — \w* тут матчил ноль и всё ломалось.
    expect(pythonConceptSignals('Расскажи про глобальную блокировку интерпретатора')).not.toBeNull();
    expect(pythonConceptSignals('Как устроена обработка ошибок в Python?')).not.toBeNull();
    expect(pythonConceptSignals('list — изменяемый тип, а tuple?')).not.toBeNull();
  });

  it('распознаёт по-английски (context manager / decorator)', () => {
    expect(pythonConceptSignals('What is a context manager?')).not.toBeNull();
    expect(pythonConceptSignals('Explain Python decorators')).not.toBeNull();
  });

  it('возвращает null для не-Python-вопроса (падение в общий путь)', () => {
    expect(pythonConceptSignals('Расскажи про CI/CD пайплайн')).toBeNull();
    expect(pythonConceptSignals('Как ты разделяешь smoke и regression?')).toBeNull();
  });
});
