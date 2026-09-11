'use client';

import React from 'react';
import styles from './LoadingTransition.module.css';

interface LoadingTransitionProps {
  isVisible: boolean;
  message?: string;
}

export default function LoadingTransition({ 
  isVisible, 
  message = 'Loading...' 
}: LoadingTransitionProps) {
  if (!isVisible) return null;

  return (
    <div className={styles.overlay}>
      <div className={styles.content}>
        <div className={styles.spinner}></div>
        <p className={styles.message}>{message}</p>
      </div>
    </div>
  );
}