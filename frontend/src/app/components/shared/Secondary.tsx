'use client';

import React from 'react';
import styles from './Secondary.module.css';

export interface SecondaryProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  fullWidth?: boolean;
  /** 與 Secondary 同視覺，但為靜態區塊（無 hover／click 互動），例如餘額顯示 */
  presentational?: boolean;
}

const Secondary = React.forwardRef<HTMLButtonElement, SecondaryProps>(function Secondary(
  { className, fullWidth, disabled, children, type = 'button', presentational, ...rest },
  ref
) {
  const mergedClass = [
    styles.secondary,
    presentational ? styles.secondaryPresentational : '',
    fullWidth ? styles.fullWidth : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  if (presentational) {
    return (
      <span className={mergedClass}>
        <span className={styles.label}>{children}</span>
      </span>
    );
  }

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      className={mergedClass}
      {...rest}
    >
      <span className={styles.label}>{children}</span>
    </button>
  );
});

export default Secondary;
