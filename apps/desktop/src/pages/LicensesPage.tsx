import { useI18n } from '../lib/i18n';

interface OssComponent {
  name: string;
  license: string;
  use: string;
  url: string;
}

const COMPONENTS: OssComponent[] = [
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
  const { t } = useI18n();
  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h2 className="page-title">{t('licenses.title')}</h2>
        <p className="page-subtitle">{t('licenses.subtitle')}</p>
      </div>

      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border text-left text-xs text-ink-faint">
            <tr>
              <th className="px-4 py-2">{t('licenses.colComponent')}</th>
              <th className="px-4 py-2">{t('licenses.colLicense')}</th>
              <th className="px-4 py-2">{t('licenses.colUse')}</th>
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
        Распознавание речи выполняется через OpenAI API и регулируется условиями сервиса OpenAI.
      </p>
    </div>
  );
}
