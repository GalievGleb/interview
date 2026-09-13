import googleLogo from '../assets/google-g.png';

export default function GoogleSignInButton({ children, busy, onClick }: {
  children: React.ReactNode;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" disabled={busy} aria-busy={busy} onClick={onClick}
      className="inline-flex min-h-11 w-full items-center justify-center gap-3 rounded-full border border-[#747775] bg-white px-5 py-2.5 text-sm font-medium text-[#1f1f1f] shadow-sm transition-colors hover:bg-[#f2f2f2] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#4285f4] disabled:cursor-wait disabled:opacity-60"
      style={{ fontFamily: "'Google Sans', Roboto, Arial, sans-serif" }}>
      <img src={googleLogo} alt="" aria-hidden="true" width={20} height={20} className="h-5 w-5 shrink-0 object-contain" />
      <span>{children}</span>
    </button>
  );
}
