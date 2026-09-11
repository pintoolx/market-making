'use client';

import React from 'react';
import styles from './ConfigPanel.module.css';
import { CanvasNode } from './WorkflowCanvas';
import CustomSelect from './CustomSelect';
import PrioritySelect from './PrioritySelect';
import PoolSelect from './PoolSelect';
import { TOKEN_PRICES, PRIORITY_ESTIMATED_NETWORK_FEE, KAMINO_POOL_OPTIONS } from '../../utils/constants';
import NumberInputWithOperators from './NumberInputWithOperators';
import FormInput from '../shared/FormInput';
import Primary from '../shared/Primary';
import Secondary from '../shared/Secondary';

interface ConfigField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'number-with-operators';
  placeholder?: string;
  options?: string[];
  value?: string | number;
}

interface NodeConfigSchema {
  title: string;
  fields: ConfigField[];
}

interface ConfigPanelProps {
  selectedNode: CanvasNode | null;
  onConfigChange: (nodeId: string, config: Record<string, string | number | boolean>) => void;
  onClose?: () => void;
  nodeConfigs?: Record<string, NodeConfigSchema>;
  viewport?: { x: number; y: number; zoom: number };
}

// Asset options built from centralized TOKEN_PRICES
const ASSET_OPTIONS = [
  { value: 'SOL', label: 'SOL', icon: '/solana.svg', price: `$${TOKEN_PRICES.SOL.toLocaleString('en-US')}` },
  // 後端 TOKEN_ADDRESS 用的是 JITOSOL（全大寫），這裡 value 對齊後端
  { value: 'JITOSOL', label: 'JitoSOL', icon: '/jitosol.svg', price: `$${TOKEN_PRICES.JitoSOL.toLocaleString('en-US')}` },
  { value: 'USDC', label: 'USDC', icon: '/usdc.svg', price: `$${TOKEN_PRICES.USDC.toLocaleString('en-US')}` },
];

// Jupiter Swap 支援的 token 清單（對齊後端 TokenTicker = keyof TOKEN_ADDRESS）
const JUPITER_TICKERS = ['USDC', 'SOL', 'JITOSOL', 'mSOL', 'bSOL', 'jupSOL', 'INF', 'hSOL', 'stSOL'] as const;

// Jupiter token options: 對有 icon/price 的 token 做美化，其他用預設 icon + 不顯示價格
const JUPITER_TOKEN_OPTIONS = JUPITER_TICKERS.map((t) => {
  const pretty = ASSET_OPTIONS.find((o) => o.value === t);
  return (
    pretty ?? {
      value: t,
      label: t,
      icon: '/logo.svg',
      price: '',
    }
  );
});

// DeFi Protocol Node Configurations
const DEFI_NODE_CONFIGS: Record<string, NodeConfigSchema> = {
  'pyth-price-feed': {
    title: 'Pyth Price Feed Configuration',
    fields: [
      {
        name: 'ticker',
        label: 'Token',
        type: 'select',
        options: ['SOL', 'JITOSOL', 'USDC'],
        value: 'SOL'
      },
      {
        name: 'targetPrice',
        label: 'Price Threshold ($)',
        type: 'number-with-operators',
        value: 1000,
        placeholder: '1,000'
      }
    ]
  },
  'marinade-unstake': {
    title: 'Marinade Unstaking Configuration',
    fields: [
      {
        name: 'amount',
        label: 'Amount to Unstake',
        type: 'select',
        options: ['all', 'percentage', 'fixed_amount'],
        value: 'all'
      },
      {
        name: 'priority',
        label: 'Transaction Priority',
        type: 'select',
        options: ['low', 'medium', 'high'],
        value: 'medium'
      }
    ]
  },
  'jupiter-swap': {
    title: 'Jupiter Swap Configuration',
    fields: [
      {
        name: 'sourceToken',
        label: 'Swap Token',
        type: 'select',
        options: ['SOL', 'JitoSOL', 'USDC'],
        value: 'SOL'
      },
      {
        name: 'targetToken',
        label: '', // No label for targetToken
        type: 'select',
        options: ['USDC', 'SOL', 'JitoSOL'],
        value: 'USDC'
      },
      {
        name: 'slippage',
        label: 'Slippage Tolerance (%)',
        type: 'number',
        value: 10
      },
      {
        name: 'priority',
        label: 'Transaction Priority Fee',
        type: 'select',
        options: ['Low', 'Medium', 'High'],
        value: 'High'
      },
      // Editable rates for computing targetAmount = sourceAmount * rate_{targetToken}
      {
        name: 'rate_SOL',
        label: 'Rate (SOL)',
        type: 'number',
        value: 1
      },
      {
        name: 'rate_JitoSOL',
        label: 'Rate (JitoSOL)',
        type: 'number',
        value: 1.9
      },
      {
        name: 'rate_USDC',
        label: 'Rate (USDC)',
        type: 'number',
        value: 200
      }
    ]
  },
  'kamino-deposit': {
    title: 'Kamino Lending Configuration',
    fields: [
      {
        name: 'asset',
        label: 'Asset to Deposit',
        type: 'select',
        options: ['SOL', 'JitoSOL', 'USDC'],
        value: 'USDC'
      },
      {
        name: 'pool',
        label: 'Lending Pool',
        type: 'select',
        options: ['USDC', 'SOL', 'JitoSOL'],
        value: 'USDC'
      },
      {
        name: 'amount',
        label: 'Amount',
        type: 'number',
        value: 10
      }
    ]
  },
  'if-else': {
    title: 'Conditional Logic',
    fields: [
      {
        name: 'condition',
        label: 'Condition Type',
        type: 'select',
        options: ['price_check', 'balance_check', 'time_check'],
        value: 'price_check'
      },
      {
        name: 'operator',
        label: 'Operator',
        type: 'select',
        options: ['>', '<', '>=', '<=', '=='],
        value: '<'
      },
      {
        name: 'value',
        label: 'Comparison Value',
        type: 'number',
        value: 150
      }
    ]
  },
  'discord-notify': {
    title: 'Discord Notification',
    fields: [
      {
        name: 'channel',
        label: 'Discord Channel',
        type: 'text',
        value: '#trading-alerts'
      },
      {
        name: 'message',
        label: 'Message Template',
        type: 'text',
        value: 'SOL hedging strategy executed successfully'
      },
      {
        name: 'mention',
        label: 'Mention Role',
        type: 'select',
        options: ['none', '@everyone', '@traders', '@admin'],
        value: 'none'
      }
    ]
  },
  'telegram-notify': {
    title: 'Telegram Notification',
    fields: [
      {
        name: 'chat_id',
        label: 'Username',
        type: 'text',
        placeholder: '@username'
      },
      {
        name: 'message',
        label: 'Message',
        type: 'text',
        value: 'Workflow Executed!'
      }
    ]
  }
};

export default function ConfigPanel({ 
  selectedNode, 
  onConfigChange, 
  onClose,
  nodeConfigs = DEFI_NODE_CONFIGS,
  viewport = { x: 0, y: 0, zoom: 1 }
}: ConfigPanelProps) {
  // Local state to track temporary changes before saving
  const [localConfig, setLocalConfig] = React.useState<Record<string, string | number | boolean | '' | undefined>>(
    selectedNode?.config || {}
  );

  // Update local config when selected node changes or its config is updated (e.g. workflow loaded from backend)
  const configFingerprint = selectedNode?.config ? JSON.stringify(selectedNode.config) : '';
  React.useEffect(() => {
    setLocalConfig(selectedNode?.config || {});
  }, [selectedNode?.id, configFingerprint]);

  // Derived value for Jupiter Swap:
  // targetAmount = sourceAmount * price(sourceToken) / price(targetToken)
  React.useEffect(() => {
    if (selectedNode?.type !== 'jupiter-swap') return;
    setLocalConfig(prev => {
      const sourceAmount = Number(prev.sourceAmount ?? 0);
      const sourceToken = (prev.sourceToken ?? 'SOL') as string;
      const targetToken = (prev.targetToken ?? 'USDC') as string;

      const srcPrice = TOKEN_PRICES[sourceToken] ?? 0;
      const dstPrice = TOKEN_PRICES[targetToken] ?? 0;

      const computed = dstPrice > 0
        ? (sourceAmount * srcPrice) / dstPrice
        : 0;

      if (prev.targetAmount === computed) return prev;
      return { ...prev, targetAmount: computed };
    });
  }, [selectedNode?.type, localConfig.sourceAmount, localConfig.sourceToken, localConfig.targetToken]);

  const handleFieldChange = (fieldName: string, value: string | number | undefined) => {
    if (!selectedNode) return;
    if (value === undefined) return;
    
    // Update local config only, don't save to actual node yet
    setLocalConfig(prev => ({
      ...prev,
      [fieldName]: value
    }));
  };

  const handleOperatorChange = (value: string) => {
    if (!selectedNode) return;

    // Update local config only, don't save to actual node yet
    setLocalConfig(prev => ({
      ...prev,
      operator: value
    }));
  };

  const handleSave = () => {
    if (!selectedNode) return;

    // Sanitize local config: drop undefined/empty-string values
    const sanitized: Record<string, string | number | boolean> = {};
    Object.entries(localConfig).forEach(([k, v]) => {
      if (v === undefined || v === '') return;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        sanitized[k] = v;
      }
    });

    // Apply local config changes to the actual node
    onConfigChange(selectedNode.id, sanitized);

    if (onClose) {
      onClose();
    }
  };

  const handleCancel = () => {
    // Reset local config to original values
    setLocalConfig(selectedNode?.config || {});

    if (onClose) {
      onClose();
    }
  };

  const renderField = (field: ConfigField) => {
    const rawCandidate = localConfig[field.name] !== undefined ? localConfig[field.name] : (field.value ?? '');
    // Coerce string-encoded numbers back to number for numeric field types
    const isNumericField = field.type === 'number' || field.type === 'number-with-operators';
    let rawValue: string | number | boolean | '' | undefined = rawCandidate ?? '';
    if (isNumericField && typeof rawValue === 'string' && rawValue !== '' && !isNaN(Number(rawValue))) {
      rawValue = Number(rawValue);
    }
    const currentValue = typeof rawValue === 'boolean' ? rawValue.toString() : String(rawValue);
    const operator = (typeof localConfig.operator === 'string' && localConfig.operator !== '')
      ? localConfig.operator
      : 'less_than_or_equal';

    // Handle kamino-deposit asset field (uses CustomSelect)
    if (selectedNode?.type === 'kamino-deposit' && field.name === 'asset' && field.type === 'select') {
      return (
        <CustomSelect
          value={currentValue}
          onChange={(value) => handleFieldChange('asset', value)}
          options={ASSET_OPTIONS}
        />
      );
    }

    // Handle kamino-deposit pool field (uses PoolSelect)
    if (selectedNode?.type === 'kamino-deposit' && field.name === 'pool' && field.type === 'select') {
      return (
        <PoolSelect
          value={currentValue}
          onChange={(value) => handleFieldChange(field.name, value)}
          options={KAMINO_POOL_OPTIONS}
        />
      );
    }

    if (selectedNode?.type === 'pyth-price-feed' && field.name === 'ticker' && field.type === 'select') {
      return (
        <CustomSelect
          value={currentValue}
          onChange={(value) => handleFieldChange('ticker', value)}
          options={ASSET_OPTIONS}
        />
      );
    }

    // Asset Symbol / Token selects with overlay amount input for Jupiter Swap
    if (field.type === 'select' && field.name === 'sourceToken' && selectedNode?.type === 'jupiter-swap') {
      const rawAmount = localConfig.sourceAmount;
      const amountValue = rawAmount === '' || rawAmount === undefined
        ? ''
        : String(rawAmount);
      return (
        <div className={styles.selectOverlayRow}>
          <CustomSelect
            value={currentValue}
            onChange={(value) => handleFieldChange('sourceToken', value)}
            options={ASSET_OPTIONS}
            hideLabel
          />
          <input
            type="text"
            className={styles.overlayInput}
            value={amountValue}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '') {
                handleFieldChange('sourceAmount', '');
              } else {
                if (/^\d*(\.)?\d*$/.test(v)) {
                  handleFieldChange('sourceAmount', v);
                }
              }
            }}
          />
        </div>
      );
    }

    if (field.name === 'targetToken' && selectedNode?.type === 'jupiter-swap') {
      // For targetToken in jupiter-swap, render select with computed targetAmount displayed in the middle
      const computed = Number(localConfig?.targetAmount ?? 0);
      return (
        <CustomSelect
          value={currentValue}
          onChange={(value) => handleFieldChange('targetToken', value)}
          options={ASSET_OPTIONS}
          displayValue={computed.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 })}
        />
      );
    }

    // Pyth targetPrice uses NumberInputWithOperators, but condition is stored as 'above'/'below'
    if (selectedNode?.type === 'pyth-price-feed' && field.type === 'number-with-operators' && field.name === 'targetPrice') {
      const cond = typeof localConfig.condition === 'string' ? localConfig.condition : 'below';
      const opFromCond = cond === 'above' ? 'greater_than_or_equal' : 'less_than_or_equal';
      return (
        <NumberInputWithOperators
          value={typeof rawValue === 'number' ? rawValue : (field.value as number) || 0}
          operator={opFromCond}
          onFinalChange={(value, fieldName) => fieldName && handleFieldChange(fieldName, value)}
          onFinalOperatorChange={(op) => {
            const nextCond = op === 'greater_than_or_equal' ? 'above' : 'below';
            handleFieldChange('condition', nextCond);
          }}
          placeholder={field.placeholder}
          fieldName={field.name}
        />
      );
    }

    // Special handling for number input with operators (Pyth threshold)
    if (field.type === 'number-with-operators') {
      return (
        <NumberInputWithOperators
          value={typeof rawValue === 'number' ? rawValue : (field.value as number) || 0}
          operator={operator}
          onFinalChange={(value, fieldName) => fieldName && handleFieldChange(fieldName, value)}
          onFinalOperatorChange={handleOperatorChange}
          placeholder={field.placeholder}
          fieldName={field.name}
        />
      );
    }

    // Specialized rendering for Transaction Priority Fee (Jupiter)
    if (selectedNode?.type === 'jupiter-swap' && field.name === 'priority') {
      const currentPriority = (localConfig.priority || field.value || 'High') as 'Low' | 'Medium' | 'High';
      const getFeeLabel = (p: 'Low' | 'Medium' | 'High') =>
        `~${PRIORITY_ESTIMATED_NETWORK_FEE[p].toLocaleString('en-US', {
          minimumFractionDigits: 6,
          maximumFractionDigits: 6,
        })} SOL`;
      return (
        <PrioritySelect
          value={currentPriority}
          onChange={(v) => handleFieldChange('priority', v)}
          getFeeLabel={getFeeLabel}
        />
      );
    }

    // Special handling for Slippage: allow empty string, no blue focus effect (Jupiter)
    if (field.type === 'number' && field.name === 'slippage') {
      const display = typeof rawValue === 'number' ? String(rawValue) : (rawValue as string);
      return (
        <FormInput
          type="text"
          fullWidth
          value={display}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '') {
              handleFieldChange(field.name, '');
            } else if (/^\d*(\.)?\d*$/.test(v)) {
              handleFieldChange(field.name, v);
            }
          }}
          placeholder={field.placeholder}
        />
      );
    }
    // Special handling for Kamino amount: allow empty string + quick select buttons
    if (selectedNode?.type === 'kamino-deposit' && field.name === 'amount' && field.type === 'number') {
      const display = typeof rawValue === 'number' ? String(rawValue) : (rawValue as string || '');
      const is50 = String(display) === '50';
      const is100 = String(display) === '100';
      return (
        <div className={styles.kaminoAmountContainer}>
          <FormInput
            type="text"
            fullWidth
            value={display}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '') {
                handleFieldChange(field.name, '');
              } else if (/^\d*(\.)?\d*$/.test(v)) {
                handleFieldChange(field.name, v);
              }
            }}
            placeholder={field.placeholder}
          />
          <div className={styles.quickSelectButtons}>
            <Secondary
              type="button"
              className={is50 ? styles.kaminoQuickSecondaryOn : undefined}
              onClick={() => handleFieldChange(field.name, '50')}
            >
              50%
            </Secondary>
            <Secondary
              type="button"
              className={is100 ? styles.kaminoQuickSecondaryOn : undefined}
              onClick={() => handleFieldChange(field.name, '100')}
            >
              100%
            </Secondary>
          </div>
        </div>
      );
    }

    switch (field.type) {
      case 'select':
        return (
          <select
            value={currentValue}
            onChange={(e) => handleFieldChange(field.name, e.target.value)}
            className={styles.configSelect}
          >
            <option value="">Select {field.label}</option>
            {field.options?.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        );
      case 'number':
        return (
          <FormInput
            type="number"
            fullWidth
            value={
              typeof rawValue === 'number'
                ? String(rawValue)
                : rawValue === '' || rawValue === undefined
                  ? ''
                  : String(rawValue)
            }
            placeholder={field.placeholder}
            onChange={(e) => handleFieldChange(field.name, parseFloat(e.target.value) || 0)}
          />
        );
      default:
        return (
          <FormInput
            type="text"
            fullWidth
            value={currentValue}
            placeholder={field.placeholder}
            onChange={(e) => handleFieldChange(field.name, e.target.value)}
          />
        );
    }
  };

  // Calculate panel position based on node position and viewport
  const nodeScreenX = (selectedNode?.x ?? 0) * viewport.zoom + viewport.x;
  const nodeScreenY = (selectedNode?.y ?? 0) * viewport.zoom + viewport.y;
  const panelLeft = nodeScreenX + 100 * viewport.zoom; // 100px to the right of node
  const panelTop = nodeScreenY;

  // Keep panel fully visible vertically
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [clampedTop, setClampedTop] = React.useState<number>(panelTop);

  React.useEffect(() => {
    // Measure panel height after render and clamp top so bottom stays within viewport
    const raf = requestAnimationFrame(() => {
      const panelEl = panelRef.current;
      const viewportHeight = window.innerHeight;
      const panelHeight = panelEl ? panelEl.getBoundingClientRect().height : 0;
      const margin = 16; // minimal margin from viewport edges

      let nextTop = panelTop;
      if (panelHeight > 0) {
        nextTop = Math.min(panelTop, viewportHeight - panelHeight - margin);
      }
      nextTop = Math.max(margin, nextTop);
      setClampedTop(nextTop);
    });
    return () => cancelAnimationFrame(raf);
  }, [panelTop, viewport.x, viewport.y, viewport.zoom, selectedNode?.id]);

  if (!selectedNode) {
    return null;
  }

  const nodeConfig = nodeConfigs[selectedNode.type];
  
  if (!nodeConfig) {
    return (
      <aside
        className={styles.configPanel}
        style={{
          left: `${panelLeft}px`,
          top: `${panelTop}px`
        }}
      >
        <div className={styles.configContent}>
          <h3>{selectedNode.label}</h3>
          <div>No configuration available for this node type.</div>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={styles.configPanel}
      ref={panelRef}
      style={{
        left: `${panelLeft}px`,
        top: `${clampedTop}px`
      }}
    >
      <div className={styles.configContent}>
        <h3>{nodeConfig.title}</h3>

        {nodeConfig.fields.map((field, index) => {
          // Skip internal rate fields for jupiter-swap (no input boxes for these)
          if (selectedNode.type === 'jupiter-swap' && field.name.startsWith('rate_')) {
            return null;
          }
          // For jupiter-swap, combine sourceToken and targetToken fields with no gap
          // For jupiter-swap sourceToken, wrap it with a special container
          if (selectedNode.type === 'jupiter-swap' && field.name === 'sourceToken') {
            const targetTokenField = nodeConfig.fields.find(f => f.name === 'targetToken');
            return (
              <div key={`jupiter-swap-tokens-${field.name}`} className={styles.jupiterSwapTokensContainer}>
                <div key={field.name} className={styles.fieldGroup}>
                  {field.label && (
                    <label className={styles.configLabel}>
                      {field.label}
                    </label>
                  )}
                  {renderField(field)}
                </div>
                {targetTokenField && (
                  <div key={targetTokenField.name} className={styles.fieldGroupNoGap}>
                    {renderField(targetTokenField)}
                  </div>
                )}
              </div>
            );
          }

          // Skip targetToken if we've already rendered it with sourceToken
          if (selectedNode.type === 'jupiter-swap' && field.name === 'targetToken') {
            return null;
          }

          return (
            <div key={field.name} className={styles.fieldGroup}>
              {field.label && (
                <label className={styles.configLabel}>
                  {field.label}
                </label>
              )}
              {renderField(field)}
            </div>
          );
        })}

        {selectedNode.type === 'jupiter-swap' && (
          <div className={styles.summaryGroup}>
            <hr className={styles.sectionDivider} />
            <div className={styles.summaryRow}>
              <div className={styles.summaryLabel}>Transaction Priority Fee</div>
              <div className={styles.summaryValue}>0.00%</div>
            </div>
            <div className={styles.summaryRow}>
              <div className={styles.summaryLabel}>Price Impact</div>
              <div className={styles.summaryValue}>~0.01%</div>
            </div>
            <div className={styles.summaryRow}>
              <div className={styles.summaryLabel}>Total Est. Cost</div>
              <div className={styles.summaryValue}>~$0.012</div>
            </div>
          </div>
        )}
        
        <div className={styles.buttonGroup}>
          <Secondary type="button" onClick={handleCancel} aria-label="Cancel">
            Cancel
          </Secondary>
          {selectedNode.type === 'telegram-notify' && (
            <Secondary
              type="button"
              onClick={() => {
                /* Optional: hook for testing chat id or sending a test message */
              }}
              aria-label="Check configuration"
            >
              Check
            </Secondary>
          )}
          <Primary type="button" onClick={handleSave} aria-label="Save configuration">
            Save
          </Primary>
        </div>
      </div>
    </aside>
  );
}