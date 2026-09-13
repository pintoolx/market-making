'use client';

import React from 'react';
import styles from './FormInput.module.css';

export interface FormInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className'> {
  /** Validation errors use pink #D6295D for the border and text. */
  error?: boolean;
  /** Fill the parent width. */
  fullWidth?: boolean;
  /** Leading content such as a SOL icon. Avoid the native input prop name prefix. */
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
