import DevReferralAdminToolbar from '../components/shared/DevReferralAdminToolbar';

export default function AdminRefPage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        padding: 24,
        fontFamily: 'var(--font-space-grotesk), system-ui, sans-serif',
        color: '#0E0F28',
      }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 8px' }}>/adminref</h1>
      <p style={{ fontSize: 14, margin: 0, opacity: 0.75 }}>
        Development-only referral admin tools (panel fixed bottom-right in dev).
      </p>
      <DevReferralAdminToolbar />
    </main>
  );
}
