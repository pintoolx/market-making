import { CanvasNode, Connection } from '../components/Creator/WorkflowCanvas';
import { TOKEN_PRICES } from '../utils/constants';

/**
 * Workflow format expected by the backend.
 */
export interface BackendWorkflowFormat {
  nodes: BackendNode[];
  connections: BackendConnections;
}

export interface BackendNode {
  id: string;
  name: string;
  type: string;
  parameters: Record<string, string | number | boolean>;
}

export interface BackendConnections {
  [sourceNodeId: string]: {
    [portName: string]: Array<Array<{
      node: string;
      type: string;
      index: number;
    }>>;
  };
}

/**
 * Map frontend node types to backend node types.
 */
const NODE_TYPE_MAPPING: Record<string, string> = {
  'pyth-price-feed': 'pythPriceFeed',
  'binance-price-feed': 'binancePriceFeed',
  'jupiter-swap': 'jupiterSwap',
  'kamino-deposit': 'kamino',
  'marinade-unstake': 'marinadeUnstake',
  'if-else': 'ifElse',
  'telegram-notify': 'telegramNotify',
  'discord-notify': 'discordNotify',
};

/**
 * Convert frontend config to backend parameters.
 */
function transformNodeParameters(
  frontendType: string,
  frontendConfig: Record<string, string | number | boolean> = {}
): Record<string, string | number | boolean> {
  const parameters: Record<string, string | number | boolean> = {};

  switch (frontendType) {
    case 'pyth-price-feed': {
      // Prefer backend parameter names: ticker / targetPrice / condition / hermesEndpoint.
      if (typeof frontendConfig.ticker === 'string' && frontendConfig.ticker !== '') {
        parameters.ticker = frontendConfig.ticker;
        parameters.targetPrice = String(frontendConfig.targetPrice ?? frontendConfig.threshold ?? '0');
        parameters.condition = String(frontendConfig.condition ?? frontendConfig.operator ?? 'above');
        parameters.hermesEndpoint = String(frontendConfig.hermesEndpoint ?? 'https://hermes.pyth.network');
        break;
      }

      // Legacy fallback: asset / operator / threshold.
      const asset = (frontendConfig.asset as string) || 'SOL';
      const operator = (frontendConfig.operator as string) || 'greater_than';
      const threshold = (frontendConfig.threshold as number) || 1000;

      const legacyConditionMap: Record<string, string> = {
        greater_than: 'above',
        less_than: 'below',
        greater_than_or_equal: 'above',
        less_than_or_equal: 'below',
        equal: 'equal',
      };

      parameters.ticker = asset;
      parameters.targetPrice = threshold.toString();
      parameters.condition = legacyConditionMap[operator] ?? 'above';
      parameters.hermesEndpoint = 'https://hermes.pyth.network';
      break;
    }

    case 'jupiter-swap': {
      // Frontend: sourceToken, targetToken, sourceAmount, slippage (percentage), priority (UI only).
      // Backend: accountId, inputToken, outputToken, amount, slippageBps.
      const src = (frontendConfig.sourceToken as string) || 'SOL';
      const dst = (frontendConfig.targetToken as string) || 'USDC';
      const sourceAmount = frontendConfig.sourceAmount;

      // UI label JitoSOL maps to backend TokenTicker JITOSOL.
      const normalizeToken = (t: string) => (t === 'JitoSOL' ? 'JITOSOL' : t);

      if (frontendConfig.accountId !== undefined) {
        parameters.accountId = String(frontendConfig.accountId);
      }
      parameters.inputToken = normalizeToken(src);
      parameters.outputToken = normalizeToken(dst);
      parameters.amount =
        typeof sourceAmount === 'number'
          ? sourceAmount.toString()
          : typeof sourceAmount === 'string' && sourceAmount !== ''
            ? sourceAmount
            : '0';

      const slippagePercent =
        typeof frontendConfig.slippage === 'number'
          ? frontendConfig.slippage
          : typeof frontendConfig.slippage === 'string' && frontendConfig.slippage !== ''
            ? Number(frontendConfig.slippage)
            : 10; // Default: 10%.
      const bps = Math.round(slippagePercent * 100);
      parameters.slippageBps = String(Number.isFinite(bps) ? bps : 1000);
      break;
    }

    case 'kamino-deposit': {
      // Frontend: asset (SOL/JitoSOL/USDC), pool (pool-a/pool-b/pool-c), amount (number).
      // Backend: accountId, operation, vaultName, amount; shareAmount only for withdrawals.
      
      // Map frontend pool values to backend vault names.
      const poolToVaultName: Record<string, string> = {
        'pool-a': 'USDC_Prime',
        'pool-b': 'Allez_USDC', // Verify the actual vault name.
        'pool-c': 'Steakhouse_USDC_High_Yield', // Verify the actual vault name.
      };
      
      const pool = (frontendConfig.pool as string) || 'pool-a';
      const vaultName = poolToVaultName[pool] || 'USDC_Prime'; // fallback
      
      // Convert frontend amounts to backend strings; support auto/all/half.
      const frontendAmount = frontendConfig.amount;
      const amount = frontendAmount === undefined || frontendAmount === ''
        ? 'auto'
        : String(frontendAmount);
      
      // Default to deposit because the current UI only offers deposits.
      const operation = 'deposit';
      
      // WorkflowBuilder supplies accountId automatically.
      if (frontendConfig.accountId !== undefined) {
        parameters.accountId = String(frontendConfig.accountId);
      }
      
      parameters.operation = operation;
      parameters.vaultName = vaultName;
      parameters.amount = amount;
      // Only withdrawals need shareAmount.
      // Do not set shareAmount for deposits.
      break;
    }

    case 'marinade-unstake':
      // Frontend: amount, priority.
      // Verify the actual backend parameter names.
      parameters.amount = (frontendConfig.amount as string || 'all');
      parameters.priority = frontendConfig.priority as string || 'medium';
      break;

    case 'telegram-notify':
      // Frontend: chat_id, message.
      // Verify the actual backend parameter names.
      parameters.chatId = frontendConfig.chat_id as string || '';
      parameters.message = frontendConfig.message as string || '';
      break;

    case 'discord-notify':
      // Frontend: channel, message, mention.
      // Verify the actual backend parameter names.
      parameters.channel = frontendConfig.channel as string || '';
      parameters.message = frontendConfig.message as string || '';
      parameters.mention = frontendConfig.mention as string || 'none';
      break;

    case 'if-else':
      // Frontend: condition, operator, value.
      // Verify the actual backend parameter names.
      parameters.condition = frontendConfig.condition as string || 'price_check';
      parameters.operator = frontendConfig.operator as string || '>';
      parameters.value = (frontendConfig.value as number || 0).toString();
      break;

    default:
      // Use config unchanged when no special conversion applies.
      Object.assign(parameters, frontendConfig);
  }

  return parameters;
}

/**
 * Convert a frontend workflow to backend format.
 * @param accountId - Optional ID supplied to nodes that require it, such as jupiter-swap and kamino-deposit.
 */
export function transformToBackendFormat(
  nodes: CanvasNode[],
  connections: Connection[],
  accountId?: string | null
): BackendWorkflowFormat {
  // Convert nodes.
  const backendNodes: BackendNode[] = nodes.map((node) => {
    const backendType = NODE_TYPE_MAPPING[node.type] || node.type;
    // Supply accountId when required and absent from node config.
    const nodeConfig = node.config || {};
    const configWithAccountId = (node.type === 'jupiter-swap' || node.type === 'kamino-deposit') && 
                                 accountId && 
                                 nodeConfig.accountId === undefined
      ? { ...nodeConfig, accountId }
      : nodeConfig;
    const parameters = transformNodeParameters(node.type, configWithAccountId);

    return {
      id: node.id,
      name: node.label,
      type: backendType,
      parameters,
    };
  });

  // Convert connections.
  const backendConnections: BackendConnections = {};
  
  connections.forEach((conn) => {
    const sourceId = conn.sourceNodeId;
    const targetId = conn.targetNodeId;
    const portName = conn.sourcePort || 'main';

    if (!backendConnections[sourceId]) {
      backendConnections[sourceId] = {};
    }

    if (!backendConnections[sourceId][portName]) {
      // The backend groups outputs by index; main[0] is the first output.
      // The current frontend has no output-index concept, so use index 0.
      backendConnections[sourceId][portName] = [[]];
    }

    // Backend format: { [sourceId]: { main: [[{ node, type, index }, ...]] } }.
    backendConnections[sourceId][portName][0].push({
      node: targetId,
      type: conn.targetPort || 'main',
      index: 0,
    });
  });

  return {
    nodes: backendNodes,
    connections: backendConnections,
  };
}

/**
 * Convert backend format to frontend format when loading a saved workflow.
 */
export function transformFromBackendFormat(
  backendWorkflow: BackendWorkflowFormat
): { nodes: CanvasNode[]; connections: Connection[] } {
  // Reverse-map backend types to frontend types.
  const reverseTypeMapping: Record<string, string> = Object.fromEntries(
    Object.entries(NODE_TYPE_MAPPING).map(([frontend, backend]) => [backend, frontend])
  );

  const GRID_SPACING = 60;
  const snapToGrid = (v: number) => Math.round(v / GRID_SPACING) * GRID_SPACING;
  const startX = snapToGrid(400);
  const startY = snapToGrid(300);

  // Convert nodes.
  const frontendNodes: CanvasNode[] = backendWorkflow.nodes.map((node, index) => {
    const frontendType = reverseTypeMapping[node.type] || node.type;

    // Convert backend parameters to frontend config.
    const config = transformParametersToConfig(frontendType, node.parameters);

    return {
      id: node.id,
      type: frontendType,
      label: node.name,
      icon: getIconForType(frontendType),
      x: startX + index * GRID_SPACING,
      y: startY,
      config,
    };
  });

  // Convert connections.
  const frontendConnections: Connection[] = [];
  
  Object.entries(backendWorkflow.connections).forEach(([sourceId, ports]) => {
    Object.entries(ports).forEach(([portName, connections]) => {
      connections.forEach((connectionGroup) => {
        connectionGroup.forEach((conn) => {
          frontendConnections.push({
            id: `conn-${sourceId}-${conn.node}`,
            sourceNodeId: sourceId,
            targetNodeId: conn.node,
            sourcePort: portName,
            targetPort: conn.type,
          });
        });
      });
    });
  });

  return {
    nodes: frontendNodes,
    connections: frontendConnections,
  };
}

/**
 * Convert backend parameters to frontend config.
 */
function transformParametersToConfig(
  frontendType: string,
  parameters: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  const config: Record<string, string | number | boolean> = {};

  switch (frontendType) {
    case 'pyth-price-feed':
      // Backend to frontend: ticker / targetPrice / condition / hermesEndpoint.
      config.ticker = String(parameters.ticker ?? '');
      config.targetPrice = String(parameters.targetPrice ?? '0');
      config.condition = String(parameters.condition ?? 'above');
      if (parameters.hermesEndpoint !== undefined) {
        config.hermesEndpoint = String(parameters.hermesEndpoint);
      }
      break;

    case 'jupiter-swap': {
      // Backend stores inputToken/outputToken symbols, amount and slippageBps.
      const inputToken = String(parameters.inputToken ?? parameters.inputMint ?? '');
      const outputToken = String(parameters.outputToken ?? parameters.outputMint ?? '');
      const jupAmount = parseFloat(String(parameters.amount ?? '0'));

      // Reverse-map stored mint addresses where necessary.
      const reverseTokenMap: Record<string, string> = {
        'So11111111111111111111111111111111111111112': 'SOL',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
        'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 'JitoSOL',
      };

      const resolvedInput = reverseTokenMap[inputToken] || inputToken;
      const resolvedOutput = reverseTokenMap[outputToken] || outputToken;

      config.sourceToken = resolvedInput;
      config.targetToken = resolvedOutput;
      config.sourceAmount = jupAmount;

      // Convert backend slippage bps to frontend percentage.
      const slippageBps = parseInt(String(parameters.slippageBps ?? '1000'), 10);
      config.slippage = Number.isFinite(slippageBps) ? slippageBps / 100 : 10;

      config.rate_SOL = 1;
      config.rate_JitoSOL = 1.9;
      config.rate_USDC = 200;
      config.priority = 'High';

      // Calculate targetAmount for the expanded canvas view.
      const srcPrice = TOKEN_PRICES[resolvedInput] ?? 0;
      const dstPrice = TOKEN_PRICES[resolvedOutput] ?? 0;
      config.targetAmount = dstPrice > 0 ? (jupAmount * srcPrice) / dstPrice : 0;
      break;
    }

    case 'kamino-deposit': {
      // Backend: operation, vaultName, amount.
      // Frontend: asset, pool, amount.
      const vaultToPool: Record<string, string> = {
        'USDC_Prime': 'pool-a',
        'Allez_USDC': 'pool-b',
        'Steakhouse_USDC_High_Yield': 'pool-c',
      };
      const vaultToAsset: Record<string, string> = {
        'USDC_Prime': 'USDC',
        'Allez_USDC': 'USDC',
        'Steakhouse_USDC_High_Yield': 'USDC',
      };

      const vaultName = String(parameters.vaultName ?? 'USDC_Prime');
      config.pool = vaultToPool[vaultName] || 'pool-a';
      config.asset = vaultToAsset[vaultName] || 'USDC';
      const kamAmount = parameters.amount;
      config.amount = (kamAmount === undefined || kamAmount === '' || kamAmount === 'auto')
        ? 10
        : Number(kamAmount);
      break;
    }

    case 'binance-price-feed':
      config.ticker = String(parameters.ticker ?? '');
      config.targetPrice = String(parameters.targetPrice ?? '0');
      config.condition = String(parameters.condition ?? 'above');
      break;

    case 'if-else':
      config.condition = String(parameters.condition ?? 'price_check');
      config.operator = String(parameters.operator ?? '>');
      config.value = Number(parameters.value ?? 0);
      break;

    case 'telegram-notify':
      config.chat_id = String(parameters.chatId ?? '');
      config.message = String(parameters.message ?? '');
      break;

    case 'discord-notify':
      config.channel = String(parameters.channel ?? '');
      config.message = String(parameters.message ?? '');
      config.mention = String(parameters.mention ?? 'none');
      break;

    default:
      Object.assign(config, parameters);
  }

  return config;
}

/**
 * Get the icon for a node type.
 */
function getIconForType(type: string): string {
  const iconMap: Record<string, string> = {
    'pyth-price-feed': '/pyth.svg',
    'binance-price-feed': '/binance.svg',
    'jupiter-swap': '/jupiter.svg',
    'kamino-deposit': '/kamino.svg',
    'marinade-unstake': '/node.svg',
    'if-else': '/Logicnode.svg',
    'telegram-notify': '/telegram.svg',
    'discord-notify': '/discord.svg',
  };
  return iconMap[type] || '/node.svg';
}
