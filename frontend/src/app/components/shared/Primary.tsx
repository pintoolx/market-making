'use client';

import React from 'react';
import styles from './Primary.module.css';

export interface PrimaryProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 等同設計稿 width: 100% */
  fullWidth?: boolean;
  /** 與 default 相同互動，主色改為粉紅（如關閉 canvas Remove） */
  variant?: 'default' | 'accentPink';
}

const Primary = React.forwardRef<HTMLButtonElement, PrimaryProps>(function Primary(
  { className, fullWidth, variant = 'default', disabled, children, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      className={[
        styles.primary,
        variant === 'accentPink' ? styles.primaryAccentPink : '',
        fullWidth ? styles.fullWidth : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <span className={styles.label}>{children}</span>
    </button>
  );
});

export default Primary;
