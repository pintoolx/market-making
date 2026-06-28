'use client';

import React from 'react';
import styles from './NodeToolbox.module.css';

export interface NodeDefinition {
  id: string;
  label: string;
  icon: string;
  protocol?: string;
}

export interface NodeCategory {
  name: string;
  color: string;
  nodes: NodeDefinition[];
}

interface NodeToolboxProps {
  categories: NodeCategory[];
  onNodeDrag?: (nodeType: string) => void;
  onNodeSelect?: (nodeType: string) => void;
}

export default function NodeToolbox({ categories, onNodeDrag, onNodeSelect }: NodeToolboxProps) {
  const handleNodeClick = (nodeId: string) => {
    if (onNodeSelect) {
      onNodeSelect(nodeId);
    }
  };

  const handleNodeDragStart = (e: React.DragEvent, nodeId: string) => {
    // Set the data to be transferred
    e.dataTransfer.setData('text/plain', nodeId);
    e.dataTransfer.effectAllowed = 'copy';

    if (onNodeDrag) {
      onNodeDrag(nodeId);
    }
  };

  return (
    <aside className={styles.toolbox}>
      <div className={styles.toolboxHeader}>
        <span className={styles.headerIcon}>🧩</span>
        <span>Node Toolbox</span>
      </div>
      <div className={styles.toolboxDescription}>
        Drag and drop nodes to create a workflow
      </div>
      {categories.map((category) => (
        <div key={category.name} className={styles.toolboxCategory}>
          <div className={styles.categoryTitle} style={{ borderLeftColor: category.color }}>
            <span className={styles.categoryDot} style={{ backgroundColor: category.color }}></span>
            {category.name}
            <span className={styles.categoryCount}>{category.nodes.length}</span>
          </div>
          {category.nodes.map((node) => (
            <div
              key={node.id}
              className={styles.toolboxNode}
              style={{ borderLeftColor: category.color }}
              onClick={() => handleNodeClick(node.id)}
              onDragStart={(e) => handleNodeDragStart(e, node.id)}
              draggable
            >
              <div className={styles.nodeHeader}>
                <span className={styles.nodeIcon} style={{ color: category.color }}>
                  {node.icon}
                </span>
                <div className={styles.nodeInfo}>
                  <span className={styles.nodeLabel}>{node.label}</span>
                  {node.protocol && (
                    <span className={styles.nodeProtocol}>{node.protocol}</span>
                  )}
                </div>
              </div>
              <div className={styles.dragHint}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M5 3H11M5 8H11M5 13H11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.3" />
                </svg>
              </div>
            </div>
          ))}
        </div>
      ))}
    </aside>
  );
}