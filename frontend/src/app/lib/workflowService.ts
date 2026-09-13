import { supabase, ensureJwtWalletClaimForWorkflowsRls } from './supabase';
import { CanvasNode, Connection } from '../components/Creator/WorkflowCanvas';
import { transformToBackendFormat, BackendWorkflowFormat } from './workflowTransformer';

/** Extract PostgrestError fields because DevTools may otherwise display an empty object. */
function supabaseErrFields(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== 'object') return { raw: String(err) };
  const e = err as Record<string, unknown>;
  return {
    message: e.message,
    code: e.code,
    details: e.details,
    hint: e.hint,
  };
}

function workflowInsertUserMessage(err: {
  message?: string;
  details?: string | null;
  hint?: string | null;
  code?: string;
}): string {
  const parts = [err.message, err.details || undefined, err.hint || undefined].filter(
    (x): x is string => typeof x === 'string' && x.trim().length > 0
  );
  if (parts.length > 0) return parts.join(' — ');
  return `Could not save workflow (database code: ${err.code ?? 'unknown'}). Check RLS policies and table schema.`;
}

// ─── Canvas (Draft) ────────────────────────────────────────

export interface CanvasData {
  id?: string;
  owner_wallet_address: string;
  name: string;
  description?: string;
  definition: {
    nodes: CanvasNode[];
    connections: Connection[];
  };
  created_at?: string;
  updated_at?: string;
}

export async function getUserCanvases(walletAddress: string): Promise<CanvasData[]> {
  const { data, error } = await supabase
    .from('canvases')
    .select('*')
    .eq('owner_wallet_address', walletAddress)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getCanvas(canvasId: string, walletAddress: string): Promise<CanvasData | null> {
  const { data, error } = await supabase
    .from('canvases')
    .select('*')
    .eq('id', canvasId)
    .eq('owner_wallet_address', walletAddress)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function createCanvas(
  walletAddress: string,
  name: string,
  nodes: CanvasNode[] = [],
  connections: Connection[] = []
): Promise<CanvasData> {
  const { data, error } = await supabase
    .from('canvases')
    .insert({
      owner_wallet_address: walletAddress,
      name,
      definition: { nodes, connections },
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateCanvas(
  canvasId: string,
  walletAddress: string,
  updates: { name?: string; nodes?: CanvasNode[]; connections?: Connection[] }
): Promise<void> {
  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (updates.name !== undefined) updateData.name = updates.name;
  if (updates.nodes !== undefined && updates.connections !== undefined) {
    updateData.definition = { nodes: updates.nodes, connections: updates.connections };
  }
  const { error } = await supabase
    .from('canvases')
    .update(updateData)
    .eq('id', canvasId)
    .eq('owner_wallet_address', walletAddress);
  if (error) throw error;
}

export async function deleteCanvas(canvasId: string, walletAddress: string): Promise<void> {
  const { error } = await supabase
    .from('canvases')
    .delete()
    .eq('id', canvasId)
    .eq('owner_wallet_address', walletAddress);
  if (error) throw error;
}

// ─── Workflow (Template) ───────────────────────────────────

export interface WorkflowData {
  id?: string;
  owner_wallet_address: string;
  name: string;
  description?: string;
  definition: BackendWorkflowFormat;
  canvas_id?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * Get the active account ID for this wallet.
 */
export async function getActiveAccountId(walletAddress: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('accounts')
      .select('id')
      .eq('owner_wallet_address', walletAddress)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      // Return null on query errors, indicating no account.
      console.warn('Error fetching active account:', error);
      return null;
    }

    // Return null when there is no data.
    if (!data || data.length === 0) {
      return null;
    }

    return data[0]?.id || null;
  } catch (error) {
    console.error('Error fetching active account:', error);
    return null;
  }
}

/** Match the public.accounts.status constraint: active | inactive | closed. */
export type AccountLifecycleStatus = 'active' | 'inactive' | 'closed';

/**
 * Derive the lifecycle from the account row; no linked row means none.
 * Support the legacy is_active field when it is the only status field.
 */
export function accountLifecycleFromRow(
  row: { status?: string | null; is_active?: boolean | null } | null | undefined
): 'active' | 'inactive' | 'closed' | 'none' {
  if (!row) return 'none';
  const s = typeof row.status === 'string' ? row.status.toLowerCase().trim() : '';
  if (s === 'active' || s === 'inactive' || s === 'closed') return s;
  if (row.is_active === true) return 'active';
  if (row.is_active === false) return 'inactive';
  return 'inactive';
}

export async function updateAccountStatus(
  walletAddress: string,
  accountId: string,
  status: AccountLifecycleStatus
): Promise<void> {
  await ensureJwtWalletClaimForWorkflowsRls(walletAddress);
  const { error } = await supabase
    .from('accounts')
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', accountId)
    .eq('owner_wallet_address', walletAddress);
  if (error) throw error;
}

/**
 * Create a workflow.
 */
export async function createWorkflow(
  walletAddress: string,
  name: string,
  nodes: CanvasNode[],
  connections: Connection[],
  description?: string,
  canvasId?: string
): Promise<WorkflowData> {
  try {
    await ensureJwtWalletClaimForWorkflowsRls(walletAddress);
    const accountId = await getActiveAccountId(walletAddress);
    const backendDefinition = transformToBackendFormat(nodes, connections, accountId);

    const workflowData: Omit<WorkflowData, 'id' | 'created_at' | 'updated_at'> = {
      owner_wallet_address: walletAddress,
      name,
      description: description || undefined,
      definition: backendDefinition,
      canvas_id: canvasId || undefined,
    };

    const { data, error } = await supabase
      .from('workflows')
      .insert(workflowData)
      .select()
      .single();

    if (error) {
      // Handle duplicate-name errors.
      if (error.code === '23505') {
        // The unique wallet-address/name combination already exists.
        // Create a handled error rather than an uncaught console error.
        interface DuplicateError extends Error {
          code: string;
          originalError: unknown;
          isHandled: boolean;
        }
        const duplicateError = new Error(`Workflow name "${name}" already exists. Please choose a different name.`) as DuplicateError;
        duplicateError.code = 'DUPLICATE_NAME';
        duplicateError.originalError = error;
        duplicateError.isHandled = true; // Mark handled to avoid an uncaught console error.
        throw duplicateError;
      }
      const msg = workflowInsertUserMessage(error);
      const wrapped = new Error(msg) as Error & { code?: string };
      wrapped.code = error.code ?? undefined;
      throw wrapped;
    }

    return data;
  } catch (error) {
    console.error('Error creating workflow:', supabaseErrFields(error));
    throw error;
  }
}

/**
 * Update a workflow.
 */
export async function updateWorkflow(
  workflowId: string,
  walletAddress: string,
  updates: {
    name?: string;
    description?: string;
    nodes?: CanvasNode[];
    connections?: Connection[];
  }
): Promise<WorkflowData> {
  try {
    await ensureJwtWalletClaimForWorkflowsRls(walletAddress);
    const updateData: Record<string, string | boolean | BackendWorkflowFormat | null> = {
      updated_at: new Date().toISOString(),
    };

    if (updates.name !== undefined) {
      updateData.name = updates.name;
    }

    if (updates.description !== undefined) {
      updateData.description = updates.description;
    }

    if (updates.nodes !== undefined || updates.connections !== undefined) {
      // Convert updated nodes and connections to the backend format.
      // Updates must contain complete frontend nodes and connections.
      if (updates.nodes !== undefined && updates.connections !== undefined) {
        // Obtain the active accountId if one exists.
        const accountId = await getActiveAccountId(walletAddress);
        const backendDefinition = transformToBackendFormat(updates.nodes, updates.connections, accountId);
        updateData.definition = backendDefinition;
      } else {
        // Read the existing definition if only nodes or connections changed.
        const { data: existing } = await supabase
          .from('workflows')
          .select('definition')
          .eq('id', workflowId)
          .eq('owner_wallet_address', walletAddress)
          .single();

        if (!existing) {
          throw new Error('Workflow not found or access denied');
        }

        // Convert from backend to frontend format before converting back.
        // Prefer providing nodes and connections together.
        throw new Error('Partial update of nodes/connections requires both nodes and connections');
      }
    }

    const { data, error } = await supabase
      .from('workflows')
      .update(updateData)
      .eq('id', workflowId)
      .eq('owner_wallet_address', walletAddress)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return data;
  } catch (error) {
    console.error('Error updating workflow:', error);
    throw error;
  }
}

/**
 * Get all workflows for a user.
 */
export async function getUserWorkflows(walletAddress: string): Promise<WorkflowData[]> {
  try {
    await ensureJwtWalletClaimForWorkflowsRls(walletAddress);
    const { data, error } = await supabase
      .from('workflows')
      .select('*')
      .eq('owner_wallet_address', walletAddress)
      .order('updated_at', { ascending: false });

    if (error) {
      throw error;
    }

    return data || [];
  } catch (error) {
    console.error('Error fetching user workflows:', error);
    throw error;
  }
}

/**
 * Read the earliest workflow_executions.started_at for this workflow and owner_wallet_address.
 */
export async function fetchFirstExecutionStartedAtByWorkflowIds(
  walletAddress: string,
  workflowIds: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = workflowIds.filter((id): id is string => Boolean(id));
  if (ids.length === 0) return out;
  try {
    await ensureJwtWalletClaimForWorkflowsRls(walletAddress);
    const { data, error } = await supabase
      .from('workflow_executions')
      .select('workflow_id, started_at')
      .eq('owner_wallet_address', walletAddress)
      .in('workflow_id', ids)
      .order('started_at', { ascending: true });

    if (error) {
      console.warn('Error fetching workflow_executions:', supabaseErrFields(error));
      return out;
    }
    for (const row of data || []) {
      const wid = row.workflow_id as string | undefined;
      const sa = row.started_at as string | undefined;
      if (wid && sa && !out.has(wid)) {
        out.set(wid, sa);
      }
    }
  } catch (e) {
    console.warn('fetchFirstExecutionStartedAtByWorkflowIds:', e);
  }
  return out;
}

/**
 * Get one workflow.
 */
export async function getWorkflow(
  workflowId: string,
  walletAddress: string
): Promise<WorkflowData | null> {
  try {
    await ensureJwtWalletClaimForWorkflowsRls(walletAddress);
    const { data, error } = await supabase
      .from('workflows')
      .select('*')
      .eq('id', workflowId)
      .eq('owner_wallet_address', walletAddress)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      throw error;
    }

    return data;
  } catch (error) {
    console.error('Error fetching workflow:', error);
    throw error;
  }
}

/**
 * Delete a workflow.
 */
export async function deleteWorkflow(
  workflowId: string,
  walletAddress: string
): Promise<void> {
  try {
    await ensureJwtWalletClaimForWorkflowsRls(walletAddress);
    const { error } = await supabase
      .from('workflows')
      .delete()
      .eq('id', workflowId)
      .eq('owner_wallet_address', walletAddress);

    if (error) {
      throw error;
    }
  } catch (error) {
    console.error('Error deleting workflow:', error);
    throw error;
  }
}
