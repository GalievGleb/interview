import type { I18nKey } from './ru';

/** English dictionary — must cover every key from ru (enforced by the type). */
export const en: Record<I18nKey, string> = {
  'nav.group.prep': 'Preparation',
  'nav.group.live': 'Live',
  'nav.group.context': 'Context',
  'nav.group.system': 'System',
  'nav.home': 'Dashboard',
  'nav.prepare': 'Vacancy review',
  'nav.interview': 'Live interview',
  'nav.documents': 'Resume & experience',
  'nav.history': 'History',
  'nav.settings': 'Settings',
  'nav.search': 'Search',

  'shell.liveSession': 'Live session',
  'shell.idle': 'Idle',
  'shell.focus': 'Focus',
  'shell.localPrivate': 'Local · Private',
  'shell.backendConnecting':
    'Connecting to backend… it starts automatically. If it does not come up, run manually:',

  'common.copy': 'Copy',
  'common.delete': 'Delete',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.loading': 'Loading…',
  'common.language': 'Interface language',

  'settings.language.title': 'Interface language',
  'settings.language.subtitle':
    'Changes the UI chrome language. AI answers follow the session language.',

  'onboarding.firstRun': 'First run',
  'onboarding.skip': 'Skip',
  'onboarding.back': 'Back',
  'onboarding.stt.eyebrow': 'Speech recognition',
  'onboarding.stt.title': 'Set up local speech recognition',
  'onboarding.stt.subtitle':
    'SkillCue listens to interview questions and transcribes them in real time. Choose how it works — by default everything stays on your device.',
  'onboarding.stt.whisperTitle': 'Local Whisper',
  'onboarding.stt.recommended': 'Recommended',
  'onboarding.stt.whisperDesc.pre': 'Audio is transcribed locally on your device and ',
  'onboarding.stt.whisperDesc.strong': 'never leaves for the cloud',
  'onboarding.stt.whisperDesc.post': ' in local mode. Recognition runs on your CPU/GPU.',
  'onboarding.stt.expect': 'What to expect',
  'onboarding.stt.expect.offline': 'Works offline once the model is downloaded',
  'onboarding.stt.expect.cpu': 'Uses CPU/GPU — may affect battery, fan noise and performance',
  'onboarding.stt.expect.download': 'You need to download a local speech model first',
  'onboarding.ethics.strong': 'Ethical use.',
  'onboarding.ethics.body':
    ' The app helps you prepare and work on permitted calls. Do not use it to deceive interviewers, and disclose recording to participants when the rules require it.',
  'onboarding.stt.choose': 'Choose a speech model',
  'onboarding.key.eyebrow': 'AI key',
  'onboarding.key.title': 'Connect AI — the heart of the copilot',
  'onboarding.key.subtitle':
    'A key powers live answers and smart scoring in mock interviews. Speech recognition stays local. The key is stored only on your device.',
  'onboarding.key.openrouter': 'OpenRouter (recommended)',
  'onboarding.key.openai': 'OpenAI',
  'onboarding.key.hint':
    'An OpenRouter key unlocks many models at once. Get one at openrouter.ai — it takes a couple of minutes. You can skip and add it later in Settings.',
  'onboarding.key.saveError': 'Failed to save the key',
  'onboarding.key.saving': 'Saving…',
  'onboarding.key.save': 'Save and start',
  'onboarding.key.skipLater': 'Skip — I will add it later',

  'onboarding.sttStep.title': 'Choose your speech recognition mode',
  'onboarding.sttStep.localTitle': 'Local Whisper — recommended',
  'onboarding.sttStep.b1': 'Audio is transcribed locally on your device',
  'onboarding.sttStep.b2': 'In local mode audio never leaves for the cloud',
  'onboarding.sttStep.b3': 'Uses CPU/GPU during recognition',
  'onboarding.sttStep.b4': 'May affect battery and fan noise',
  'onboarding.sttStep.b5': 'Requires downloading a speech model',
  'onboarding.sttStep.autoChoose': 'Choose automatically',
  'onboarding.sttStep.ramUnknown': 'RAM unknown',
  'onboarding.sttStep.gpuFound': 'GPU detected',
  'onboarding.sttStep.cpuOnly': 'CPU only',
  'onboarding.sttStep.modelReady': 'Model downloaded — local mode is ready.',
  'onboarding.sttStep.downloading': 'Downloading model…',
  'onboarding.sttStep.downloadNow': 'Download the model now (optional)',
  'onboarding.sttStep.changeLater': 'You can download or change the model later in Settings → Speech.',
  'onboarding.sttStep.downloadError': 'Failed to start the download',
  'onboarding.sttStep.modelError': 'Failed to download the model',
  'onboarding.sttStep.privacyLocal':
    'Audio is processed on your device and is not sent to our servers for recognition.',
  'onboarding.sttStep.resourceLocal':
    'Local recognition uses the CPU/GPU and may affect battery, performance and fan noise.',
  'onboarding.continue': 'Continue',

  // Whisper model cards (labels/descriptions; data fallback lives in shared)
  'whisper.fast.label': 'Fast',
  'whisper.fast.desc':
    'For low-powered laptops or battery-saver mode. Minimal resource usage and the fastest start; lower accuracy on technical terms. A good fit for quick testing or older devices.',
  'whisper.balanced.label': 'Balanced',
  'whisper.balanced.desc':
    'For most modern laptops. A good balance of speed and accuracy — the recommended default for live interviews. Handles QA/Python terms well together with glossary correction.',
  'whisper.quality.label': 'Quality',
  'whisper.quality.desc':
    'For powerful laptops/desktops. Higher accuracy, but more load on the CPU/GPU and memory. Better for noisy audio or complex terminology.',
  'whisper.max.label': 'Maximum accuracy',
  'whisper.max.desc':
    'Maximum accuracy for speech and technical terms. Needs an NVIDIA GPU for speed (~1s per question on a modern GPU; very slow on CPU). The largest download. Recommended when a GPU is available.',

  'unit.mb': 'MB',
  'unit.gbRam': 'GB RAM',
};
