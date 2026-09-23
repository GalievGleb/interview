export async function runStartupRefreshes(
  refreshBackend: () => Promise<void>,
  refreshAccount: () => Promise<void>,
): Promise<void> {
  await Promise.allSettled([refreshBackend(), refreshAccount()]);
}
