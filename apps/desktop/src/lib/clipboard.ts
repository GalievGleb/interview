/** Native clipboard works even when the overlay deliberately does not take focus. */
export async function writeClipboardText(text: string): Promise<void> {
  if (window.electronAPI?.writeClipboardText) {
    await window.electronAPI.writeClipboardText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}
