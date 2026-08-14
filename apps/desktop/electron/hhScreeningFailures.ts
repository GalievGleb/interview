export function partitionUnresolvedScreeningQuestions<T extends { id: string }>(
  questions: readonly T[],
  unresolvedIds: ReadonlySet<string>,
  transientQuestionIds: ReadonlySet<string>,
): { pendingQuestions: T[]; transientUnresolved: number } {
  const pendingQuestions: T[] = [];
  let transientUnresolved = 0;
  for (const question of questions) {
    if (!unresolvedIds.has(question.id)) continue;
    if (transientQuestionIds.has(question.id)) {
      transientUnresolved += 1;
      continue;
    }
    pendingQuestions.push(question);
  }
  return { pendingQuestions, transientUnresolved };
}
