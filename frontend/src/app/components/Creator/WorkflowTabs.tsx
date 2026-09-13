'use client';

import React, { useState } from 'react';
import styles from './WorkflowTabs.module.css';

export interface WorkflowTab {
  id: string;
  name: string;
  isNew?: boolean;
}

interface WorkflowTabsProps {
  tabs: WorkflowTab[];
  activeTabId: string;
  onTabSelect: (tabId: string) => void;
  onTabAdd: () => void;
  onTabRename?: (tabId: string, newName: string) => void;
  /** Ask the parent to confirm closing a tab; do not delete it directly here. */
  onTabCloseRequest?: (tabId: string) => void;
}

function TabCloseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M4 4L12 12M12 4L4 12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function WorkflowTabs({
  tabs,
  activeTabId,
  onTabSelect,
  onTabAdd,
  onTabRename,
  onTabCloseRequest,
}: WorkflowTabsProps) {
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const handleDoubleClick = (tab: WorkflowTab) => {
    if (onTabRename) {
      setEditingTabId(tab.id);
      setEditingName(tab.isNew ? `New ${tab.name}` : tab.name);
    }
  };

  const handleEditSubmit = (tabId: string) => {
    if (onTabRename && editingName.trim()) {
      onTabRename(tabId, editingName.trim());
    }
    setEditingTabId(null);
    setEditingName('');
  };

  const handleEditKeyDown = (e: React.KeyboardEvent, tabId: string) => {
    if (e.key === 'Enter') {
      handleEditSubmit(tabId);
    } else if (e.key === 'Escape') {
      setEditingTabId(null);
      setEditingName('');
    }
  };

  return (
    <div className={styles.tabsContainer}>
      <div className={styles.tabsContent}>
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTabId;
          const isEditing = editingTabId === tab.id;

          const showClose = Boolean(onTabCloseRequest) && tabs.length > 1 && !isEditing;

          return (
            <React.Fragment key={tab.id}>
              <div
                className={`${styles.tab} ${isActive ? styles.tabActive : styles.tabInactive}`}
                onClick={() => !isEditing && onTabSelect(tab.id)}
                onDoubleClick={() => handleDoubleClick(tab)}
              >
                {isEditing ? (
                  <input
                    type="text"
                    className={styles.tabInput}
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onBlur={() => handleEditSubmit(tab.id)}
                    onKeyDown={(e) => handleEditKeyDown(e, tab.id)}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className={styles.tabLabel}>
                      {tab.isNew ? `New ${tab.name}` : tab.name}
                    </span>
                    {showClose && (
                      <div className={styles.tabCloseOverlay}>
                        <button
                          type="button"
                          className={styles.tabCloseButton}
                          aria-label={`Close ${tab.isNew ? `New ${tab.name}` : tab.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onTabCloseRequest?.(tab.id);
                          }}
                        >
                          <TabCloseIcon className={styles.tabCloseIcon} />
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
              {/* Divider after active tab */}
              {isActive && index < tabs.length - 1 && (
                <div className={styles.divider} />
              )}
            </React.Fragment>
          );
        })}

        {/* Add tab button */}
        <button
          className={styles.addTabButton}
          onClick={onTabAdd}
          title="Add new workflow"
        >
          <span className={styles.addIcon}>+</span>
        </button>
      </div>
    </div>
  );
}
