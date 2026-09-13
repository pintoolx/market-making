'use client';

import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { adminCreateReferralCodes } from '../../lib/pintoolApi';

const DEFAULT_EXPIRES = '2026-12-31T23:59:59.000Z';

/**
 * Development-only: POST /api/referrals/admin/codes with Bearer JWT, signed challenge and full request body.
 * Stack above InviteCodeModal. Used only by /adminref; remove the route and component before release if unnecessary.
 */
export default function DevReferralAdminToolbar() {
  const { accessToken, isAuthenticated, walletAddress, getBusinessSignature } = useAuth();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [count, setCount] = useState(1);
  const [targetWalletAddress, setTargetWalletAddress] = useState('');
  const [expiresAt, setExpiresAt] = useState(DEFAULT_EXPIRES);
  const [campaign, setCampaign] = useState('test');

  if (process.env.NODE_ENV !== 'development') {
    return null;
  }

  const handleMint = async () => {
    if (!accessToken) {
      window.alert('Need Supabase session: connect wallet and sign in first.');
      return;
    }
    if (!walletAddress) {
      window.alert('Wallet address missing.');
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const signature = await getBusinessSignature();
      const data = await adminCreateReferralCodes(accessToken, {
        adminWalletAddress: walletAddress,
        signature,
        targetWalletAddress: targetWalletAddress.trim(),
        count: Math.max(1, Math.floor(Number(count)) || 1),
        expiresAt,
        metadata: { campaign: campaign.trim() || 'test' },
      });
      const text = JSON.stringify(data, null, 2);
      setResult(text);
      console.info('[dev] adminCreateReferralCodes', data);
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes('rejected') || message.includes('User rejected')) {
        return;
      }
      window.alert(message);
    } finally {
      setLoading(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 8px',
    fontSize: 11,
    borderRadius: 6,
    border: '1px solid #4A4A4A',
    background: '#1a1c3a',
    color: '#E4EAF2',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    color: '#a8b0c4',
    marginBottom: 2,
  };

  return (
    <div
      style={{
        position: 'fixed',
        right: 12,
        bottom: 12,
        zIndex: 10200,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 320,
        pointerEvents: 'auto',
        padding: 10,
        borderRadius: 10,
        background: 'rgba(14, 15, 40, 0.92)',
        border: '1px solid #4A4A4A',
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 700, color: '#E4EAF2' }}>Dev: admin referral codes</div>

      <div>
        <div style={labelStyle}>count</div>
        <input
          type="number"
          min={1}
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          style={inputStyle}
        />
      </div>
      <div>
        <div style={labelStyle}>targetWalletAddress (optional)</div>
        <input
          type="text"
          value={targetWalletAddress}
          onChange={(e) => setTargetWalletAddress(e.target.value)}
          placeholder=""
          style={inputStyle}
        />
      </div>
      <div>
        <div style={labelStyle}>expiresAt (ISO)</div>
        <input
          type="text"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          style={inputStyle}
        />
      </div>
      <div>
        <div style={labelStyle}>metadata.campaign</div>
        <input
          type="text"
          value={campaign}
          onChange={(e) => setCampaign(e.target.value)}
          style={inputStyle}
        />
      </div>

      <button
        type="button"
        onClick={handleMint}
        disabled={loading || !isAuthenticated}
        style={{
          padding: '8px 12px',
          fontSize: 12,
          fontWeight: 600,
          cursor: loading || !isAuthenticated ? 'not-allowed' : 'pointer',
          borderRadius: 8,
          border: '2px solid #0E0F28',
          background: '#2050F2',
          color: '#E4EAF2',
          boxShadow: '0 3px 0 #0E0F28',
        }}
      >
        {loading ? 'Signing / minting…' : 'Mint (challenge + sign)'}
      </button>
      {result ? (
        <pre
          style={{
            margin: 0,
            padding: 8,
            fontSize: 11,
            lineHeight: 1.35,
            overflow: 'auto',
            maxHeight: 200,
            background: '#0E0F28',
            color: '#E4EAF2',
            borderRadius: 8,
            border: '1px solid #4A4A4A',
          }}
        >
          {result}
        </pre>
      ) : null}
    </div>
  );
}
