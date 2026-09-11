'use client';

import React from 'react';
import styles from './FormInput.module.css';

export interface FormInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className'> {
  /** 驗證錯誤時外框與文字為桃紅 #D6295D */
  error?: boolean;
  /** 外層撐滿父層寬度 */
  fullWidth?: boolean;
  /** 輸入框左側（如 SOL icon）；勿用 prop 名 prefix（與原生 input 型別衝突） */
  leadingSlot?: React.ReactNode;
  className?: string;
  shellClassName?: string;
}

const FormInput = React.forwardRef<HTMLInputElement, FormInputProps>(function FormInput(
  { error, fullWidth, leadingSlot, className, shellClassName, id, 'aria-invalid': ariaInvalid, ...rest },
  ref
) {
  const input = (
    <input
      ref={ref}
      id={id}
      aria-invalid={error ? true : ariaInvalid}
      className={[styles.input, className].filter(Boolean).join(' ')}
      {...rest}
    />
  );

  return (
    <div
      className={[
        styles.shell,
        error ? styles.shellError : '',
        fullWidth ? styles.fullWidth : '',
        shellClassName ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {leadingSlot ? (
        <div className={styles.innerRow}>
          {leadingSlot}
          {input}
        </div>
      ) : (
        input
      )}
    </div>
  );
});

export default FormInput;
