'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { CornerDownLeft } from 'lucide-react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAuth } from '../../contexts/AuthContext';
import styles from './ChatPanel.module.css';

interface ChatMessage {
  id: string;
  role: 'agent' | 'user';
  content: string;
  isLoading?: boolean;
}

interface ChatPanelProps {
  onClose?: () => void;
  onCreateNodes?: () => void;
}

export default function ChatPanel({ onClose, onCreateNodes }: ChatPanelProps) {
  const wallet = useWallet();
  const { isAuthenticated: isSignedIn } = useAuth();
  const [inputValue, setInputValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'm-1',
      role: 'agent',
      content:
        'Looks like you could use something good.',
    },
  ]);

  // Get user display name
    const getUserDisplayName = useCallback(() => {
    if (isSignedIn && wallet.publicKey) {
      const address = wallet.publicKey.toString();
      return `${address.slice(0, 4)}...${address.slice(-4)}`;
    }
    return 'PinTool Lover';
    }, [isSignedIn, wallet.publicKey]);

  const renderWithSentenceBreaks = (text: string) => {
    const parts = text.split(/([。！？.!?])/g);
    const result: React.ReactNode[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      result.push(<React.Fragment key={`p-${i}`}>{part}</React.Fragment>);
      if (/[。！？.!?]/.test(part)) {
        result.push(<br key={`br-${i}`} />);
      }
    }
    return result;
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  };

  const handleSend = () => {
    const text = inputValue.trim();
    if (!text) return;
    
    // Add user message
    setMessages((prev) => [
      ...prev,
      { id: `m-${Date.now()}`, role: 'user', content: text },
    ]);
    setInputValue('');
    // Reset textarea height after sending
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = '24px';
    }

    // Add "Thinking..." message with loading
    const thinkingMsgId = `m-thinking-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: thinkingMsgId, role: 'agent', content: 'Thinking...', isLoading: true },
    ]);

    // After 2 seconds, create nodes and close panel
    setTimeout(() => {
      if (onCreateNodes) {
        onCreateNodes();
      }
      if (onClose) {
        onClose();
      }
    }, 2000);
  };

  const renderedMessages = useMemo(() => {
    const userDisplayName = getUserDisplayName();
    return messages.map((msg) => (
      <div key={msg.id} className={styles.agentHeader}>
        <div className={styles.agentIndicator}>
          <div className={msg.role === 'agent' ? styles.agentDot : styles.userDot} />
          <div className={styles.agentName}>{msg.role === 'agent' ? 'PTAgent' : userDisplayName}</div>
        </div>
        <div className={styles.messageBubble}>
          {msg.isLoading ? (
            <div className={styles.loadingContainer}>
                        <Image src="/loading.svg" alt="Loading" className={styles.loadingIcon} width={16} height={16} />
              <span>{msg.content}</span>
            </div>
          ) : (
            <>
              {msg.role === 'agent' ? renderWithSentenceBreaks(msg.content) : msg.content}
            </>
          )}
        </div>
      </div>
    ));
  }, [messages, getUserDisplayName]);

  return (
    <div className={styles.chatPanel}>
      <div className={styles.chatContent}>
        {renderedMessages}
      </div>

      <div className={styles.inputContainer}>
        <div className={styles.inputWrapper}>
          <textarea
            ref={textareaRef}
            className={styles.chatInput}
            placeholder="Tell me what you think?"
            value={inputValue}
            onChange={handleInputChange}
            rows={1}
          />
        </div>
        <button className={styles.sendButton} type="button" onClick={handleSend}>
          <CornerDownLeft size={24} />
        </button>
      </div>
    </div>
  );
}
