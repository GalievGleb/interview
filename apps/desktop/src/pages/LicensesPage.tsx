interface OssComponent {
  name: string;
  license: string;
  use: string;
  url: string;
}

// Bundled / runtime open-source components. This satisfies the attribution
// requirement for shipping a commercial desktop app that embeds local Whisper.
const COMPONENTS: OssComponent[] = [
  { name: 'OpenAI Whisper', license: 'MIT', use: 'Speech recognition model & architecture', url: 'https://github.com/openai/whisper' },
  { name: 'faster-whisper', license: 'MIT', use: 'CTranslate2 Whisper inference', url: 'https://github.com/SYSTRAN/faster-whisper' },
  { name: 'CTranslate2', license: 'MIT', use: 'Optimized local model runtime (CPU/GPU)', url: 'https://github.com/OpenNMT/CTranslate2' },
  { name: 'Hugging Face Hub', license: 'Apache-2.0', use: 'Model download & caching', url: 'https://github.com/huggingface/huggingface_hub' },
  { name: 'FastAPI', license: 'MIT', use: 'Local backend API', url: 'https://github.com/fastapi/fastapi' },
  { name: 'Starlette', license: 'BSD-3-Clause', use: 'ASGI framework / WebSockets', url: 'https://github.com/encode/starlette' },
  { name: 'Uvicorn', license: 'BSD-3-Clause', use: 'ASGI server', url: 'https://github.com/encode/uvicorn' },
  { name: 'Pydantic', license: 'MIT', use: 'Validation & settings', url: 'https://github.com/pydantic/pydantic' },
  { name: 'NumPy', license: 'BSD-3-Clause', use: 'Audio buffer processing', url: 'https://github.com/numpy/numpy' },
  { name: 'React', license: 'MIT', use: 'Desktop UI', url: 'https://github.com/facebook/react' },
  { name: 'Electron', license: 'MIT', use: 'Desktop shell', url: 'https://github.com/electron/electron' },
  { name: 'Vite', license: 'MIT', use: 'Build tooling', url: 'https://github.com/vitejs/vite' },
  { name: 'Tailwind CSS', license: 'MIT', use: 'Styling', url: 'https://github.com/tailwindlabs/tailwindcss' },
  { name: 'React Router', license: 'MIT', use: 'Navigation', url: 'https://github.com/remix-run/react-router' },
];

export default function LicensesPage() {
  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h2 className="page-title">Открытое ПО и лицензии</h2>
        <p className="page-subtitle">
          Приложение использует перечисленные ниже open-source компоненты. Полные тексты лицензий
          доступны в их репозиториях.
        </p>
      </div>

      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border text-left text-xs text-ink-faint">
            <tr>
              <th className="px-4 py-2">Компонент</th>
              <th className="px-4 py-2">Лицензия</th>
              <th className="px-4 py-2">Использование</th>
            </tr>
          </thead>
          <tbody>
            {COMPONENTS.map((c) => (
              <tr key={c.name} className="border-b border-surface-border/50">
                <td className="px-4 py-2">
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-accent hover:underline"
                  >
                    {c.name}
                  </a>
                </td>
                <td className="px-4 py-2 text-ink-muted">{c.license}</td>
                <td className="px-4 py-2 text-ink-muted">{c.use}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-ink-faint">
        Whisper-модели распространяются на условиях MIT (OpenAI). Локальная транскрипция выполняется
        на вашем устройстве; аудио не отправляется на наши серверы.
      </p>
    </div>
  );
}
