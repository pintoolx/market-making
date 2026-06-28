'use client';

import React from 'react';
import styles from './Tertiary.module.css';

export interface TertiaryProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  fullWidth?: boolean;
}

const Tertiary = React.forwardRef<HTMLButtonElement, TertiaryProps>(function Tertiary(
  { className, fullWidth, disabled, children, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      className={[
        styles.tertiary,
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

export default Tertiary;
