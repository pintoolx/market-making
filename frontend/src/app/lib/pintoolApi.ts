/**
 * PinTool API Client
 *
 * Part 1 (Sign In): 由前端直接呼叫 supabase.auth.signInWithWeb3() 完成
 * Part 2 (業務操作): getChallenge -> sign -> API with Supabase JWT Bearer + signature
 */

const API_BASE = process.env.NEXT_PUBLIC_PINTOOL_API_URL || 'https://pintool-backend-production.up.railway.app';

// ─── Types ───────────────────────────────────────────────

export interface ChallengeResponse {
  success: boolean;
  data: {
    challenge: string;
    expiresIn: number; // seconds
  };
}

export interface InitWalletResponse {
  id: string;
  owner_wallet_address: string;
  name: string;
  current_workflow_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  crossmint_wallet_locator: string;
  crossmint_wallet_address: string;
  message?: string;
}

export interface DeleteWalletResponse {
  success: boolean;
  message?: string;
}

export interface ExportWalletResponse {
  success: boolean;
  privateKey?: string;
  message?: string;
}

export interface WithdrawWalletResponse {
  success: boolean;
  message?: string;
}

export interface RedeemReferralCodeResponse {
  success: boolean;
  message?: string;
}

/** POST /api/referrals/admin/codes — 需先 getChallenge + 錢包簽名，再帶入 signature */
export interface AdminCreateReferralCodesRequest {
  adminWalletAddress: string;
  signature: string;
  targetWalletAddress: string;
  count: number;
  expiresAt: string;
  metadata: {
    campaign: string;
  };
}

export async function adminCreateReferralCodes(
  jwtToken: string,
  body: AdminCreateReferralCodesRequest
): Promise<unknown> {
  const res = await fetch(`${API_BASE}/api/referrals/admin/codes`, {
    method: 'POST',
    headers: authHeaders(jwtToken),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(
      (errorData as { message?: string }).message || `Admin create referral codes failed: ${res.status}`
    );
  }

  return res.json();
}

export interface ExecuteWorkflowResponse {
  success: boolean;
  data?: {
    executionId: string;
    status: string;
    startedAt: string;
  };
  message?: string;
}

// ─── Helper ─────────────────────────────────────────────

/** 建立帶 Supabase JWT Bearer token 的 headers */
function authHeaders(jwtToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${jwtToken}`,
  };
}

// ─── Auth Challenge (用於業務操作的即時簽名) ─────────────

/**
 * 取得 business challenge
 * 用於需要額外授權的操作（init/delete/export wallet）
 * 後端會將 challenge 存入 auth_challenges 表
 */
export async function getChallenge(walletAddress: string): Promise<ChallengeResponse> {
  const res = await fetch(`${API_BASE}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress }),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.message || `Challenge request failed: ${res.status}`);
  }

  return res.json();
}

// ─── Crossmint Wallets (Part 2 業務操作) ────────────────

/**
 * 初始化錢包（建立 Crossmint 託管錢包）
 * 需要：Supabase JWT Bearer + 業務 challenge 簽名
 */
export async function initWallet(
  jwtToken: string,
  walletAddress: string,
  signature: string,
  accountName: string
): Promise<InitWalletResponse> {
  const res = await fetch(`${API_BASE}/api/crossmint/wallets/init`, {
    method: 'POST',
    headers: authHeaders(jwtToken),
    body: JSON.stringify({ walletAddress, signature, accountName }),
  });

  if (!res.ok) {
    if (res.status === 401) throw new Error('Unauthorized. Please sign in again.');
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.message || `Init wallet failed: ${res.status}`);
  }

  return res.json();
}

/**
 * 刪除（關閉）錢包帳戶
 * 需要：Supabase JWT Bearer + 業務 challenge 簽名
 */
export async function deleteWallet(
  jwtToken: string,
  id: string,
  walletAddress: string,
  signature: string
): Promise<DeleteWalletResponse> {
  const res = await fetch(`${API_BASE}/api/crossmint/wallets/${id}`, {
    method: 'DELETE',
    headers: authHeaders(jwtToken),
    body: JSON.stringify({ walletAddress, signature }),
  });

  if (!res.ok) {
    if (res.status === 401) throw new Error('Unauthorized');
    if (res.status === 403) throw new Error('Not authorized (not the owner)');
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.message || `Delete wallet failed: ${res.status}`);
  }

  return res.json();
}

/**
 * 導出錢包私鑰
 * 需要：Supabase JWT Bearer + 業務 challenge 簽名
 * 注意：MPC 錢包可能不支援此操作
 */
export async function exportWallet(
  jwtToken: string,
  id: string,
  walletAddress: string,
  signature: string
): Promise<ExportWalletResponse> {
  const res = await fetch(`${API_BASE}/api/crossmint/wallets/${id}/export`, {
    method: 'POST',
    headers: authHeaders(jwtToken),
    body: JSON.stringify({ walletAddress, signature }),
  });

  if (!res.ok) {
    if (res.status === 400) throw new Error('Export not supported for this wallet type');
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.message || `Export wallet failed: ${res.status}`);
  }

  return res.json();
}

/**
 * 從 Crossmint 託管錢包提領資金
 * 需要：Supabase JWT Bearer + 業務 challenge 簽名
 */
export async function withdrawWallet(
  jwtToken: string,
  id: string,
  walletAddress: string,
  signature: string,
  amount: number
): Promise<WithdrawWalletResponse> {
  const res = await fetch(`${API_BASE}/api/crossmint/wallets/${id}/withdraw`, {
    method: 'POST',
    headers: authHeaders(jwtToken),
    body: JSON.stringify({ walletAddress, signature, amount }),
  });

  if (!res.ok) {
    if (res.status === 400) throw new Error('Invalid withdraw request');
    if (res.status === 403) throw new Error('Not authorized (not the owner)');
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.message || `Withdraw failed: ${res.status}`);
  }

  return res.json();
}

// ─── Referrals ──────────────────────────────────────────

export interface MyReferralCodeItem {
  code: string;
  used: boolean;
}

/**
 * 取得目前使用者可分享的邀請碼列表。
 * GET /api/referrals/my-codes — Authorization: Bearer Supabase JWT（不需錢包簽名）。
 */
export async function fetchMyReferralCodes(jwtToken: string): Promise<MyReferralCodeItem[]> {
  const res = await fetch(`${API_BASE}/api/referrals/my-codes`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${jwtToken}` },
  });
  if (!res.ok) {
    throw new Error(`My referral codes failed: ${res.status}`);
  }
  const json: unknown = await res.json();
  const raw = Array.isArray(json)
    ? json
    : json && typeof json === 'object' && 'data' in json && Array.isArray((json as { data: unknown }).data)
      ? (json as { data: unknown[] }).data
      : json && typeof json === 'object' && 'codes' in json && Array.isArray((json as { codes: unknown }).codes)
        ? (json as { codes: unknown[] }).codes
        : [];
  return raw
    .map((row): MyReferralCodeItem | null => {
      if (!row || typeof row !== 'object') return null;
      const o = row as Record<string, unknown>;
      const code = typeof o.code === 'string' ? o.code : typeof o.referral_code === 'string' ? o.referral_code : '';
      if (!code) return null;
      const used =
        o.used === true ||
        o.isRedeemed === true ||
        o.status === 'used' ||
        o.status === 'redeemed';
      return { code, used };
    })
    .filter((x): x is MyReferralCodeItem => x !== null);
}

/**
 * 兌換邀請碼
 * POST /api/referrals/redeem — Authorization: Bearer Supabase JWT。
 * 後端從 JWT 解析 walletAddress；body 只接受 { code, metadata }。
 */
export async function redeemReferralCode(
  jwtToken: string,
  code: string,
  metadata?: { source: string }
): Promise<RedeemReferralCodeResponse> {
  const res = await fetch(`${API_BASE}/api/referrals/redeem`, {
    method: 'POST',
    headers: authHeaders(jwtToken),
    body: JSON.stringify({ code, ...(metadata && { metadata }) }),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(
      (errorData as { message?: string }).message || `Redeem referral code failed: ${res.status}`
    );
  }

  return res.json();
}

// ─── Workflows ──────────────────────────────────────────

/**
 * 執行 workflow
 * 只需要 Supabase JWT Bearer token
 */
export async function executeWorkflow(
  jwtToken: string,
  workflowId: string,
  accountId?: string
): Promise<ExecuteWorkflowResponse> {
  const res = await fetch(`${API_BASE}/api/workflows/${workflowId}/execute`, {
    method: 'POST',
    headers: authHeaders(jwtToken),
    body: JSON.stringify({
      ...(accountId && { accountId }),
    }),
  });

  if (!res.ok) {
    if (res.status === 401) throw new Error('Unauthorized');
    if (res.status === 404) throw new Error('Workflow not found');
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.message || `Execute workflow failed: ${res.status}`);
  }

  return res.json();
}

// ─── Health Check ───────────────────────────────────────

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}
