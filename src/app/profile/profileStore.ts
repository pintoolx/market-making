'use client';

import { useCallback, useEffect, useState } from 'react';

// avatar is a small square JPEG data URL made in the browser (see resizeAvatar).
export type BasicProfile = { displayName: string; bio: string; xHandle: string; avatar: string };
export const EMPTY_PROFILE: BasicProfile = { displayName: '', bio: '', xHandle: '', avatar: '' };
export const LIMITS = { displayName: 40, bio: 160 } as const;
export const X_HANDLE = /^@?[A-Za-z0-9_]{1,15}$/;

// Kept in this browser, keyed by the Privy user id, until a backend stores profiles.
const key = (userId: string) => `pintool.profile.${userId}`;

export function useBasicProfile(userId: string) {
  const [profile, setProfile] = useState<BasicProfile>(EMPTY_PROFILE);

  // Read after mount so server and first client render match.
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(key(userId)) ?? 'null') as Partial<BasicProfile> | null;
      setProfile({ ...EMPTY_PROFILE, ...stored });
    } catch {
      setProfile(EMPTY_PROFILE);
    }
  }, [userId]);

  const save = useCallback((next: BasicProfile) => {
    const clean = { displayName: next.displayName.trim(), bio: next.bio.trim(), xHandle: next.xHandle.trim().replace(/^@/, ''), avatar: next.avatar };
    try { localStorage.setItem(key(userId), JSON.stringify(clean)); } catch { /* storage unavailable: keep in memory only */ }
    setProfile(clean);
  }, [userId]);

  return { profile, save };
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
