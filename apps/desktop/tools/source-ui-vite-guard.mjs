function childExitError(code, signal) {
  const detail = signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
  return new Error(
    `Vite exited before serving the current source identity (${detail})`,
  );
}

function childAlreadyExited(child) {
  if (child.exitCode != null) return childExitError(child.exitCode, child.signalCode);
  return null;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function failWhenChildExits(child) {
  let rejectFailure;
  const failure = new Promise((_resolve, reject) => {
    rejectFailure = reject;
  });
  const onExit = (code, signal) => rejectFailure(childExitError(code, signal));
  const onError = (error) => rejectFailure(
    new Error(`Vite failed before serving the current source identity: ${error.message}`),
  );
  child.once('exit', onExit);
  child.once('error', onError);

  const alreadyExited = childAlreadyExited(child);
  if (alreadyExited) queueMicrotask(() => rejectFailure(alreadyExited));

  return {
    failure,
    dispose() {
      child.off('exit', onExit);
      child.off('error', onError);
    },
  };
}

export async function waitForOwnedVite({
  child,
  probeUrl,
  expectedNonce,
  timeoutMs = 30_000,
  pollMs = 150,
  fetchImpl = fetch,
}) {
  const deadline = Date.now() + timeoutMs;
  let exitFailure = childAlreadyExited(child);
  let spawnFailure = null;
  const onExit = (code, signal) => {
    exitFailure = childExitError(code, signal);
  };
  const onError = (error) => {
    spawnFailure = new Error(
      `Vite failed before serving the current source identity: ${error.message}`,
    );
  };
  child.once('exit', onExit);
  child.once('error', onError);

  try {
    while (Date.now() < deadline) {
      if (spawnFailure) throw spawnFailure;
      if (exitFailure) throw exitFailure;

      try {
        const response = await fetchImpl(`${probeUrl}?run=${encodeURIComponent(expectedNonce)}`, {
          cache: 'no-store',
        });
        const body = response.ok ? await response.text() : '';
        if (spawnFailure) throw spawnFailure;
        if (exitFailure) throw exitFailure;
        if (response.ok && body.includes(JSON.stringify(expectedNonce))) {
          await delay(0);
          if (spawnFailure) throw spawnFailure;
          if (exitFailure) throw exitFailure;
          return;
        }
      } catch (error) {
        if (spawnFailure) throw spawnFailure;
        if (exitFailure) throw exitFailure;
        if (error instanceof TypeError) {
          // The owned Vite process is still starting; retry until its nonce appears.
        } else {
          throw error;
        }
      }
      await delay(pollMs);
    }
  } finally {
    child.off('exit', onExit);
    child.off('error', onError);
  }

  throw new Error(
    `Owned Vite did not serve the current source identity before timeout: ${probeUrl}`,
  );
}
