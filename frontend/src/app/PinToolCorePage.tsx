import React, { useState } from 'react';
import styles from './PinToolCorePage.module.css';

// Placeholder node data
const NODE_CATEGORIES = [
  {
    name: 'Triggers',
    color: '#FF6B6B',
    nodes: [
      { id: 'price-trigger', label: 'Price Trigger', icon: '💹' },
      { id: 'time-trigger', label: 'Time Trigger', icon: '⏰' },
    ],
  },
  {
    name: 'Actions',
    color: '#4ECDC4',
    nodes: [
      { id: 'swap', label: 'Swap', icon: '🔄' },
      { id: 'transfer', label: 'Transfer', icon: '💸' },
    ],
  },
  {
    name: 'Logic',
    color: '#FFD166',
    nodes: [
      { id: 'if', label: 'If', icon: '🔀' },
      { id: 'wait', label: 'Wait', icon: '⏳' },
    ],
  },
  {
    name: 'Notifications',
    color: '#6A4C93',
    nodes: [
      { id: 'email', label: 'Email', icon: '📧' },
      { id: 'sms', label: 'SMS', icon: '📱' },
    ],
  },
];

// Placeholder nodes on canvas
const INITIAL_CANVAS_NODES = [
  {
    id: 'node-1',
    type: 'price-trigger',
    label: 'Price Trigger',
    icon: '💹',
    x: 120,
    y: 100,
  },
  {
    id: 'node-2',
    type: 'swap',
    label: 'Swap',
    icon: '🔄',
    x: 320,
    y: 220,
  },
];

const NODE_CONFIGS: Record<string, React.ReactElement> = {
  'price-trigger': (
    <>
      <h3>Price Trigger</h3>
      <label>
        Asset
        <input type="text" placeholder="e.g. ETH" />
      </label>
      <label>
        Threshold
        <input type="number" placeholder="$2000" />
      </label>
    </>
  ),
  swap: (
    <>
      <h3>Swap</h3>
      <label>
        From
        <input type="text" placeholder="e.g. USDC" />
      </label>
      <label>
        To
        <input type="text" placeholder="e.g. ETH" />
      </label>
      <label>
        Amount
        <input type="number" placeholder="100" />
      </label>
    </>
  ),
};

export default function PinToolCorePage() {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [canvasNodes] = useState(INITIAL_CANVAS_NODES);

  return (
    <div className={styles.pageWrapper}>
      {/* Left Panel: Node Toolbox */}
      <aside className={styles.toolbox}>
        <div className={styles.toolboxHeader}>Nodes</div>
        {NODE_CATEGORIES.map((cat) => (
          <div key={cat.name} className={styles.toolboxCategory}>
            <div className={styles.categoryTitle} style={{ color: cat.color }}>{cat.name}</div>
            {cat.nodes.map((node) => (
              <div key={node.id} className={styles.toolboxNode} style={{ borderColor: cat.color }}>
                <span className={styles.nodeIcon} style={{ color: cat.color }}>{node.icon}</span>
                <span>{node.label}</span>
              </div>
            ))}
          </div>
        ))}
      </aside>

      {/* Center Panel: Workflow Canvas */}
      <main className={styles.canvasArea}>
        <div className={styles.canvasBg}>
          {canvasNodes.map((node) => (
            <div
              key={node.id}
              className={
                styles.canvasNode +
                (selectedNodeId === node.id ? ' ' + styles.selectedNode : '')
              }
              style={{ left: node.x, top: node.y }}
              onClick={() => setSelectedNodeId(node.id)}
            >
              <span className={styles.nodeIcon}>{node.icon}</span>
              <span>{node.label}</span>
            </div>
          ))}
          {/* Example connection line (static for mockup) */}
          <svg className={styles.connectionLine}>
            <line x1="170" y1="120" x2="320" y2="240" stroke="#4ECDC4" strokeWidth="3" markerEnd="url(#arrowhead)" />
            <defs>
              <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
                <polygon points="0 0, 10 3.5, 0 7" fill="#4ECDC4" />
              </marker>
            </defs>
          </svg>
        </div>
      </main>

      {/* Right Panel: Configuration Panel */}
      <aside className={styles.configPanel}>
        {selectedNodeId ? (
          <div className={styles.configContent}>
            {(() => {
              const node = canvasNodes.find((n) => n.id === selectedNodeId);
              return node && NODE_CONFIGS[node.type]
                ? NODE_CONFIGS[node.type]
                : <div>No config available.</div>;
            })()}
          </div>
        ) : (
          <div className={styles.configPlaceholder}>Select a node to configure</div>
        )}
      </aside>
    </div>
  );
}
