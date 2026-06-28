'use client';

import React, { useState, useRef } from 'react';
import ChatPanel from './ChatPanel';
import styles from './CanvasToolbar.module.css';

// Menu items for each category
const MENU_ITEMS = {
  triggers: [
    { id: 'pyth-price-feed', name: 'Pyth', description: 'Price feed via Pyth Network.', icon: '/pyth.svg' },
    { id: 'binance-price-feed', name: 'Binance', description: 'Price feed via Binance.', icon: '/binance.svg' },
  ],
  logic: [
    { id: 'if-else', name: 'If/Else', description: 'Conditional logic branching.', icon: '/logic.svg' },
  ],
  actions: [
    { id: 'jupiter-swap', name: 'Jupiter', description: 'Swap tokens via Jupiter.', icon: '/jupiter.svg' },
    { id: 'kamino-deposit', name: 'Kamino', description: 'Deposit to Kamino lending.', icon: '/kamino.svg' },
    { id: 'marinade-stake', name: 'Marinade', description: 'Stake SOL via Marinade.', icon: '/marinade.svg' },
  ],
  notification: [
    { id: 'telegram-notify', name: 'Telegram', description: 'Send notification via Telegram.', icon: '/telegram.svg' },
    { id: 'discord-notify', name: 'Discord', description: 'Send notification via Discord.', icon: '/discord.svg' },
  ],
};

// Flatten all menu items for search
const ALL_NODES = [
  ...MENU_ITEMS.triggers,
  ...MENU_ITEMS.logic,
  ...MENU_ITEMS.actions,
  ...MENU_ITEMS.notification,
];

interface CanvasToolbarProps {
  onAgentClick?: () => void;
  onSearchSubmit?: (query: string) => void;
  onPriceFeedClick?: () => void;
  onSwapClick?: () => void;
  onActivityClick?: () => void;
  onAlertClick?: () => void;
  onPlayClick?: () => void;
  onAddNode?: (nodeType: string) => void;
  isAgentActive?: boolean;
  isTriggersActive?: boolean;
  isLogicActive?: boolean;
  isActionsActive?: boolean;
  isNotificationActive?: boolean;
  onChatClose?: () => void;
  onCreateNodesFromChat?: () => void;
}

export default function CanvasToolbar({
  onAgentClick,
  onSearchSubmit,
  onPriceFeedClick,
  onSwapClick,
  onActivityClick,
  onAlertClick,
  onPlayClick,
  onAddNode,
  isAgentActive = false,
  isTriggersActive = false,
  isLogicActive = false,
  isActionsActive = false,
  isNotificationActive = false,
  onChatClose,
  onCreateNodesFromChat,
}: CanvasToolbarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (filteredNodes.length === 1) {
      handleSearchSelect(filteredNodes[0].id);
    }
  };

  const filteredNodes = searchQuery.trim()
    ? ALL_NODES.filter((node) =>
      node.name.toLowerCase().startsWith(searchQuery.toLowerCase())
    )
    : [];

  const handleSearchSelect = (nodeId: string) => {
    onAddNode?.(nodeId);
    setSearchQuery('');
  };

  return (
    <div className={styles.toolbarContainer}>
      {isAgentActive && (
        <div className={styles.chatPanelAside}>
          <ChatPanel
            onClose={onChatClose}
            onCreateNodes={onCreateNodesFromChat}
          />
        </div>
      )}
      <div className={styles.toolbarTools}>
      <div className={`${styles.toolGroup} ${styles.agentGroup}`}>
        <button
          className={`${styles.toolButton} ${styles.agentButton} ${isAgentActive ? styles.active : ''}`}
          onClick={onAgentClick}
        >
          <svg width="24" height="25" viewBox="0 0 24 25" fill="none" xmlns="http://www.w3.org/2000/svg" className={styles.toolIconCat}>
            <path d="M5.44236 24.5122C2.43663 24.5122 -1.06508e-07 22.0756 -2.37893e-07 19.0698L-8.94531e-07 4.04773C-1.10945e-06 -0.869045 7.11699 -1.53049 8.0231 3.30208C8.84823 7.70279 15.1518 7.70279 15.9769 3.30208C16.883 -1.53049 24 -0.869046 24 4.04773L24 19.0698C24 22.0756 21.5634 24.5122 18.5576 24.5122L5.44236 24.5122Z" className={styles.catBody} />
            <path d="M6 16.5122L6.34314 16.8554C9.46734 19.9795 14.5327 19.9795 17.6569 16.8554L18 16.5122" className={styles.catFace} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="5" cy="11.5122" r="2" className={styles.catFace} />
            <circle cx="19" cy="11.5122" r="2" className={styles.catFace} />
          </svg>
        </button>
        <span className={styles.agentTooltip}>PT Agent</span>
      </div>

      {/* Search */}
      <div className={`${styles.toolGroup} ${styles.searchGroup}`}>
        <button
          className={styles.toolButton}
          title="Search"
          type="button"
          onClick={() => searchInputRef.current?.focus()}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M11 19C15.4183 19 19 15.4183 19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11C3 15.4183 6.58172 19 11 19Z" stroke="#0E0F28" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M21 21L16.65 16.65" stroke="#0E0F28" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <form onSubmit={handleSearchSubmit} className={styles.searchForm}>
          <input
            ref={searchInputRef}
            type="text"
            className={styles.searchInput}
            placeholder="search nodes"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </form>
        {/* Search Results Dropdown */}
        {searchQuery.trim() && filteredNodes.length > 0 && (
          <div className={styles.searchResults}>
            {filteredNodes.map((item) => (
              <div
                key={item.id}
                className={styles.menuItem}
                onClick={() => handleSearchSelect(item.id)}
              >
                <img src={item.icon} alt={item.name} className={styles.menuItemIcon} />
                <div className={styles.menuItemText}>
                  <span className={styles.menuItemName}>{item.name}</span>
                  <span className={styles.menuItemDesc}>{item.description}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        {searchQuery.trim() && filteredNodes.length === 0 && (
          <div className={styles.searchResults}>
            <div className={styles.noResults}>No nodes found</div>
          </div>
        )}
      </div>

      {/* Node Tools Group */}
      <div className={styles.toolGroupMulti}>
        <div className={styles.toolButtonWrapper}>
          <button
            className={`${styles.toolButton} ${styles.nodeToolButton} ${isTriggersActive ? styles.nodeToolActive : ''}`}
            onClick={onPriceFeedClick}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 1V23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M17 5H9.5C8.57174 5 7.6815 5.36875 7.02513 6.02513C6.36875 6.6815 6 7.57174 6 8.5C6 9.42826 6.36875 10.3185 7.02513 10.9749C7.6815 11.6313 8.57174 12 9.5 12H14.5C15.4283 12 16.3185 12.3687 16.9749 13.0251C17.6313 13.6815 18 14.5717 18 15.5C18 16.4283 17.6313 17.3185 16.9749 17.9749C16.3185 18.6313 15.4283 19 14.5 19H6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {!isTriggersActive && <span className={styles.tooltip}>Triggers</span>}
          {isTriggersActive && (
            <div className={styles.toolMenu}>
              {MENU_ITEMS.triggers.map((item) => (
                <div
                  key={item.id}
                  className={styles.menuItem}
                  onClick={() => onAddNode?.(item.id)}
                >
                  <img src={item.icon} alt={item.name} className={styles.menuItemIcon} />
                  <div className={styles.menuItemText}>
                    <span className={styles.menuItemName}>{item.name}</span>
                    <span className={styles.menuItemDesc}>{item.description}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className={styles.toolButtonWrapper}>
          <button
            className={`${styles.toolButton} ${styles.nodeToolButton} ${isLogicActive ? styles.nodeToolActive : ''}`}
            onClick={onSwapClick}
          >
            <img src="/logic.svg" alt="Logic" className={styles.toolIconSmall} />
          </button>
          {!isLogicActive && <span className={styles.tooltip}>Logic</span>}
          {isLogicActive && (
            <div className={styles.toolMenu}>
              {MENU_ITEMS.logic.map((item) => (
                <div
                  key={item.id}
                  className={styles.menuItem}
                  onClick={() => onAddNode?.(item.id)}
                >
                  <img src={item.icon} alt={item.name} className={styles.menuItemIcon} />
                  <div className={styles.menuItemText}>
                    <span className={styles.menuItemName}>{item.name}</span>
                    <span className={styles.menuItemDesc}>{item.description}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className={styles.toolButtonWrapper}>
          <button
            className={`${styles.toolButton} ${styles.nodeToolButton} ${isActionsActive ? styles.nodeToolActive : ''}`}
            onClick={onActivityClick}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <polyline points="22,12 18,12 15,21 9,3 6,12 2,12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {!isActionsActive && <span className={styles.tooltip}>Actions</span>}
          {isActionsActive && (
            <div className={styles.toolMenu}>
              {MENU_ITEMS.actions.map((item) => (
                <div
                  key={item.id}
                  className={styles.menuItem}
                  onClick={() => onAddNode?.(item.id)}
                >
                  <img src={item.icon} alt={item.name} className={styles.menuItemIcon} />
                  <div className={styles.menuItemText}>
                    <span className={styles.menuItemName}>{item.name}</span>
                    <span className={styles.menuItemDesc}>{item.description}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className={styles.toolButtonWrapper}>
          <button
            className={`${styles.toolButton} ${styles.nodeToolButton} ${isNotificationActive ? styles.nodeToolActive : ''}`}
            onClick={onAlertClick}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M18 8C18 6.4087 17.3679 4.88258 16.2426 3.75736C15.1174 2.63214 13.5913 2 12 2C10.4087 2 8.88258 2.63214 7.75736 3.75736C6.63214 4.88258 6 6.4087 6 8C6 15 3 17 3 17H21C21 17 18 15 18 8Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M13.73 21C13.5542 21.3031 13.3019 21.5547 12.9982 21.7295C12.6946 21.9044 12.3504 21.9965 12 21.9965C11.6496 21.9965 11.3054 21.9044 11.0018 21.7295C10.6982 21.5547 10.4458 21.3031 10.27 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {!isNotificationActive && <span className={styles.tooltip}>Notification</span>}
          {isNotificationActive && (
            <div className={styles.toolMenu}>
              {MENU_ITEMS.notification.map((item) => (
                <div
                  key={item.id}
                  className={styles.menuItem}
                  onClick={() => onAddNode?.(item.id)}
                >
                  <img src={item.icon} alt={item.name} className={styles.menuItemIcon} />
                  <div className={styles.menuItemText}>
                    <span className={styles.menuItemName}>{item.name}</span>
                    <span className={styles.menuItemDesc}>{item.description}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Play Button */}
      <div className={`${styles.toolGroup} ${styles.playGroup}`}>
        <button
          className={`${styles.toolButton} ${styles.playButton}`}
          onClick={onPlayClick}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <polygon points="5,3 19,12 5,21" stroke="#0E0F28" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          </svg>
        </button>
        <span className={styles.playTooltip}>Ready to deploy?</span>
      </div>
      </div>
    </div>
  );
}
