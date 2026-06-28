const INVITED_BY_PREFIX = 'pintoolInvitedBy:';

export const INVITE_FRIENDS_URL = 'https://t.me/pintoolfam';

export function getInvitedByCode(walletAddress: string): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(`${INVITED_BY_PREFIX}${walletAddress}`);
}

export function setInvitedByCode(walletAddress: string, code: string) {
  localStorage.setItem(`${INVITED_BY_PREFIX}${walletAddress}`, code);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('pintool:invitedByUpdated', { detail: { walletAddress } })
    );
  }
}
