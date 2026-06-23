const MIC_KEY = 'copilot-mic-device';

export function getSelectedMicId(): string {
  return localStorage.getItem(MIC_KEY) ?? '';
}

export function setSelectedMicId(deviceId: string): void {
  if (deviceId) localStorage.setItem(MIC_KEY, deviceId);
  else localStorage.removeItem(MIC_KEY);
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

/** Однократный запрос доступа к микрофону — нужен, чтобы появились названия устройств. */
export async function ensureMicPermission(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
}
