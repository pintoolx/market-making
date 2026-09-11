'use client';

import React, { useState, useEffect } from 'react';
import styles from './NumberInputWithOperators.module.css';

interface NumberInputWithOperatorsProps {
  value: number;
  operator: string;
  onChange?: (value: number) => void;
  onOperatorChange?: (operator: string) => void;
  onFinalChange?: (value: number, fieldName?: string) => void;
  onFinalOperatorChange?: (operator: string) => void;
  fieldName?: string;
  placeholder?: string;
}

export default function NumberInputWithOperators({
  value,
  operator,
  onChange,
  onOperatorChange,
  onFinalChange,
  onFinalOperatorChange,
  fieldName,
  placeholder
}: NumberInputWithOperatorsProps) {
  const [displayValue, setDisplayValue] = useState<string>('');
  const [isEditing, setIsEditing] = useState(false);

  // Sync display value with prop value only when not editing
  useEffect(() => {
    if (!isEditing) {
      if (value === 0) {
        setDisplayValue('0');
      } else if (value !== undefined && value !== null) {
        setDisplayValue(value.toLocaleString());
      }
    }
  }, [value, isEditing]);

  const operators = [
    { symbol: '≤', value: 'less_than_or_equal' },
    { symbol: '≥', value: 'greater_than_or_equal' }
  ];

  const handleFocus = () => {
    setIsEditing(true);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputValue = e.target.value.replace(/,/g, '');
    setDisplayValue(inputValue);
    
    // Don't call onChange here, only update display
  };

  const handleBlur = () => {
    setIsEditing(false);
    
    // When blur, if empty, set default to 1, otherwise keep value
    if (displayValue === '') {
      const finalValue = 1;
      if (onChange) onChange(finalValue);
      if (onFinalChange && fieldName) onFinalChange(finalValue, fieldName);
      setDisplayValue('1');
    } else {
      const numValue = parseFloat(displayValue);
      if (!isNaN(numValue)) {
        if (onChange) onChange(numValue);
        if (onFinalChange && fieldName) onFinalChange(numValue, fieldName);
        setDisplayValue(numValue.toLocaleString());
      }
    }
  };

  return (
    <div className={styles.numberInputWrapper}>
      {operators.map((op) => (
        <button
          key={op.value}
          className={`${styles.operatorButton} ${operator === op.value ? styles.active : ''}`}
          onClick={() => {
            if (onOperatorChange) onOperatorChange(op.value);
            if (onFinalOperatorChange) onFinalOperatorChange(op.value);
          }}
          type="button"
        >
          {op.symbol}
        </button>
      ))}
      <input
        type="text"
        className={styles.numberInput}
        value={displayValue}
        onFocus={handleFocus}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder={placeholder}
      />
      <div className={styles.spacer}></div>
    </div>
  );
}
