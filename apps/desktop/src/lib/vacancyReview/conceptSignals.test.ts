import { describe, expect, it } from 'vitest';
import { conceptSignalsForQuestion, CONCEPT_RULES } from './conceptSignals';

// Регресс: локальная оценка грейдила вопрос про КОНКРЕТНЫЙ концепт по generic-
// пунктам всей темы. Сигналы должны идти от ВОПРОСА и покрывать много ролей.
describe('conceptSignalsForQuestion', () => {
  it('Python: контекстный менеджер (баг из отчёта пользователя)', () => {
    const s = conceptSignalsForQuestion('Что такое контекстный менеджер и где ты его применял?');
    expect(s).not.toBeNull();
    const joined = (s ?? []).join(' ').toLowerCase();
    expect(joined).toContain('__enter__');
    expect(joined).toContain('with');
    expect(joined).not.toContain('list/dict comprehensions');
  });

  it('Python: декоратор, генератор, GIL, mutable, исключения', () => {
    expect(conceptSignalsForQuestion('Объясни декораторы')).not.toBeNull();
    expect(conceptSignalsForQuestion('Чем генератор отличается от списка?')).not.toBeNull();
    expect(conceptSignalsForQuestion('Что такое GIL?')).not.toBeNull();
    expect(conceptSignalsForQuestion('list vs tuple — в чём разница?')).not.toBeNull();
    expect(conceptSignalsForQuestion('Как обрабатываешь исключения?')).not.toBeNull();
  });

  it('русские основы со склонением (регресс: \\w не матчит кириллицу)', () => {
    expect(conceptSignalsForQuestion('Расскажи про глобальную блокировку интерпретатора')).not.toBeNull();
    expect(conceptSignalsForQuestion('Как устроена обработка ошибок в Python?')).not.toBeNull();
    expect(conceptSignalsForQuestion('list — изменяемый тип, а tuple?')).not.toBeNull();
  });

  it('JS/Frontend: замыкания, event loop, React-хуки, ре-рендеры', () => {
    expect(conceptSignalsForQuestion('Что такое замыкание в JavaScript?')).not.toBeNull();
    expect(conceptSignalsForQuestion('Объясни event loop и микротаски')).not.toBeNull();
    expect(conceptSignalsForQuestion('Как работает useEffect?')).not.toBeNull();
    expect(conceptSignalsForQuestion('Почему происходят лишние ре-рендеры?')).not.toBeNull();
  });

  it('SQL/БД: join, индексы, транзакции, оптимизация', () => {
    expect(conceptSignalsForQuestion('Чем LEFT JOIN отличается от INNER JOIN?')).not.toBeNull();
    expect(conceptSignalsForQuestion('Когда индекс не используется?')).not.toBeNull();
    expect(conceptSignalsForQuestion('Что такое уровни изоляции транзакций?')).not.toBeNull();
    expect(conceptSignalsForQuestion('Как оптимизировать медленный запрос?')).not.toBeNull();
  });

  it('Docker/k8s, REST/API, system design', () => {
    expect(conceptSignalsForQuestion('В чём разница между образом и контейнером Docker?')).not.toBeNull();
    expect(conceptSignalsForQuestion('Что такое pod в Kubernetes?')).not.toBeNull();
    expect(conceptSignalsForQuestion('Что значит идемпотентность HTTP-метода?')).not.toBeNull();
    expect(conceptSignalsForQuestion('Чем отличается JWT от сессий?')).not.toBeNull();
    expect(conceptSignalsForQuestion('Как масштабировать сервис под высокой нагрузкой?')).not.toBeNull();
  });

  it('возвращает null для вопроса без известного концепта', () => {
    expect(conceptSignalsForQuestion('Расскажи о себе')).toBeNull();
    expect(conceptSignalsForQuestion('Почему хочешь у нас работать?')).toBeNull();
  });

  it('у каждого правила есть непустые сигналы и уникальный id', () => {
    const ids = new Set<string>();
    for (const rule of CONCEPT_RULES) {
      expect(rule.signals.length).toBeGreaterThan(0);
      expect(ids.has(rule.id)).toBe(false);
      ids.add(rule.id);
    }
  });
});
