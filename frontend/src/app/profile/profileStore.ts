'use client';

import { useCallback, useEffect, useState } from 'react';

// avatar is a small square JPEG data URL made in the browser (see resizeAvatar).
export type BasicProfile = { displayName: string; bio: string; xHandle: string; avatar: string };
export const EMPTY_PROFILE: BasicProfile = { displayName: '', bio: '', xHandle: '', avatar: '' };
export const LIMITS = { displayName: 40, bio: 160 } as const;
export const X_HANDLE = /^@?[A-Za-z0-9_]{1,15}$/;

// Kept in this browser, keyed by the Privy user id, until a backend stores profiles.
const key = (userId: string) => `pintool.profile.${userId}`;
const providerKey = (address: string) => `pintool.providerProfile.${address.toLowerCase()}`;
const PROFILE_CHANGED = 'pintool:profile-changed';

const readProfile = (storageKey: string): BasicProfile => {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Partial<BasicProfile> | null;
    return { ...EMPTY_PROFILE, ...stored };
  } catch {
    return EMPTY_PROFILE;
  }
};

export function useBasicProfile(userId: string, address?: string) {
  const [profile, setProfile] = useState<BasicProfile>(EMPTY_PROFILE);

  // Read after mount so server and first client render match.
  useEffect(() => {
    const stored = readProfile(key(userId));
    setProfile(stored);
    if (address && (stored.displayName || stored.avatar || stored.bio || stored.xHandle)) {
      try { localStorage.setItem(providerKey(address), JSON.stringify(stored)); } catch { /* Keep the account profile only. */ }
      window.dispatchEvent(new Event(PROFILE_CHANGED));
    }
  }, [userId, address]);

  const save = useCallback((next: BasicProfile) => {
    const clean = { displayName: next.displayName.trim(), bio: next.bio.trim(), xHandle: next.xHandle.trim().replace(/^@/, ''), avatar: next.avatar };
    try {
      localStorage.setItem(key(userId), JSON.stringify(clean));
      if (address) localStorage.setItem(providerKey(address), JSON.stringify(clean));
    } catch { /* storage unavailable: keep in memory only */ }
    setProfile(clean);
    window.dispatchEvent(new Event(PROFILE_CHANGED));
  }, [userId, address]);

  return { profile, save };
}

export function useProviderProfile(address?: string) {
  const [profile, setProfile] = useState<BasicProfile>(EMPTY_PROFILE);
  useEffect(() => {
    const refresh = () => setProfile(address ? readProfile(providerKey(address)) : EMPTY_PROFILE);
    refresh();
    window.addEventListener(PROFILE_CHANGED, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(PROFILE_CHANGED, refresh); window.removeEventListener('storage', refresh); };
  }, [address]);
  return profile;
}

const AVATAR_SIZE = 160;
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

// Crop the picked image to a centred square and shrink it, so it fits comfortably in localStorage.
export function resizeAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.width, img.height);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = AVATAR_SIZE;
      canvas.getContext('2d')?.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this image.')); };
    img.src = url;
  });
}
