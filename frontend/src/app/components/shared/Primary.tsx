'use client';

import React from 'react';
import styles from './Primary.module.css';

export interface PrimaryProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Match the design at width: 100%. */
  fullWidth?: boolean;
  /** Same interaction as default, with a pink accent for actions such as removing a canvas. */
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
