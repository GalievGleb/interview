/** Resume must succeed before navigation; otherwise keep its error visible. */
export async function resumeHomeQueue<T>(assistant: { applyAll: () => Promise<T> }, openQueue: () => void): Promise<T> {
  const state = await assistant.applyAll();
  openQueue();
  return state;
}
