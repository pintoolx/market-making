'use client';

import { useRef, useState } from 'react';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import FormInput from '../components/shared/FormInput';
import Avatar from '../components/shared/Avatar';
import CopyAddress from './CopyAddress';
import { LIMITS, MAX_AVATAR_BYTES, X_HANDLE, resizeAvatar, type BasicProfile } from './profileStore';
import aqua from '../marketplace/aqua.module.css';

// Account tab: editable photo, name, bio and X handle, plus the read-only login details from Privy.
export default function AccountDetails({ profile, onSave, loginMethod, email, wallet, walletNote }: { profile: BasicProfile; onSave: (next: BasicProfile) => void; loginMethod: string; email?: string; wallet?: string; walletNote?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<BasicProfile>(profile);
  const [photoError, setPhotoError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const handleValid = !draft.xHandle.trim() || X_HANDLE.test(draft.xHandle.trim());
  const pickPhoto = async (file?: File) => {
    setPhotoError('');
    if (!file) return;
    if (!file.type.startsWith('image/')) return setPhotoError('Choose an image file.');
    if (file.size > MAX_AVATAR_BYTES) return setPhotoError('Choose an image under 5 MB.');
    try { const avatar = await resizeAvatar(file); setDraft(current => ({ ...current, avatar })); } catch { setPhotoError('Could not read this image.'); }
  };

  const startEditing = () => { setDraft(profile); setPhotoError(''); setEditing(true); };
  const update = (field: keyof BasicProfile, value: string) => setDraft(current => ({ ...current, [field]: value }));

  return (
    <section className={aqua.panel} aria-labelledby="basic-info-title">
      <div className={aqua.panelHead}>
        <h2 id="basic-info-title" className={aqua.sectionTitle}>Basic information</h2>
        {!editing && <Secondary onClick={startEditing}>Edit</Secondary>}
      </div>

      {editing ? <form className={aqua.infoForm} onSubmit={event => { event.preventDefault(); if (handleValid) { onSave(draft); setEditing(false); } }}>
        <div className={aqua.photoRow}>
          <Avatar name={draft.displayName || 'P'} src={draft.avatar} size={72} />
          <div className={aqua.cardButtons}>
            <Secondary onClick={() => fileInput.current?.click()}>{draft.avatar ? 'Change photo' : 'Add photo'}</Secondary>
            {draft.avatar && <Secondary onClick={() => setDraft(current => ({ ...current, avatar: '' }))}>Remove</Secondary>}
          </div>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={e => { void pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
          {photoError && <span className={aqua.fieldError}>{photoError}</span>}
        </div>
        <label>Display name<FormInput maxLength={LIMITS.displayName} value={draft.displayName} placeholder="How Makers see you" onChange={e => update('displayName', e.target.value)} /></label>
        <label>Bio<textarea maxLength={LIMITS.bio} rows={3} value={draft.bio} placeholder="One or two lines about your strategies" onChange={e => update('bio', e.target.value)} /><span className={aqua.muted}>{draft.bio.length}/{LIMITS.bio}</span></label>
        <label>X handle<FormInput value={draft.xHandle} placeholder="@yourhandle" aria-invalid={!handleValid} onChange={e => update('xHandle', e.target.value)} />{!handleValid && <span className={aqua.fieldError}>Use up to 15 letters, numbers or underscores.</span>}</label>
        <div className={aqua.actionRow}>
          <Primary type="submit" disabled={!handleValid}>Save</Primary>
          <Secondary onClick={() => setEditing(false)}>Cancel</Secondary>
        </div>
      </form> : <dl className={aqua.infoList}>
        <dt>Photo</dt><dd><Avatar name={profile.displayName || 'P'} src={profile.avatar} size={48} /></dd>
        <dt>Display name</dt><dd>{profile.displayName || <span className={aqua.muted}>Not set</span>}</dd>
        <dt>Bio</dt><dd>{profile.bio || <span className={aqua.muted}>Not set</span>}</dd>
        <dt>X</dt><dd>{profile.xHandle ? <a href={`https://x.com/${profile.xHandle}`} target="_blank" rel="noopener noreferrer">@{profile.xHandle}</a> : <span className={aqua.muted}>Not set</span>}</dd>
      </dl>}

      <dl className={`${aqua.infoList} ${aqua.infoAccount}`}>
        <dt>Logged in with</dt><dd>{loginMethod}</dd>
        <dt>Email</dt><dd>{email ?? <span className={aqua.muted}>Not linked</span>}</dd>
        <dt>Wallet</dt><dd className={aqua.walletRow}>{wallet ? <><CopyAddress address={wallet} />{walletNote && <span className={aqua.muted}>{walletNote}</span>}</> : <span className={aqua.muted}>Not linked</span>}</dd>
      </dl>
      <p className={aqua.muted}>Photo, name, bio and X handle are saved in this browser for now. Email and wallet come from your login.</p>
    </section>
  );
}
