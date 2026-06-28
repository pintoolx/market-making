'use client';

import React, { useState, useRef, useEffect } from 'react';
import Image from 'next/image';
import styles from './CustomSelect.module.css';

interface SelectOption {
  value: string;
  label: string;
  icon: string;
  price: string;
}

interface CustomSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  displayValue?: string; // Optional value to display in the middle of trigger when collapsed
  hideLabel?: boolean; // When true, hide the token label in collapsed view
}

export default function CustomSelect({ value, onChange, options, displayValue, hideLabel }: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const selectRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find(opt => opt.value === value) || options[0];

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (selectRef.current && !selectRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
  };

  return (
    <div className={styles.customSelect} ref={selectRef}>
      {/* Selected value display */}
      <div
        className={`${styles.selectTrigger} ${isOpen ? styles.selectTriggerOpen : ''}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className={styles.selectContent}>
          <Image src={selectedOption.icon} alt={selectedOption.label} className={styles.iconImage} width={24} height={24} />
          {displayValue ? (
            <div className={styles.displayValue}>{displayValue}</div>
          ) : hideLabel ? (
            <div className={styles.labelSpacer}></div>
          ) : (
            <div className={styles.label}>{selectedOption.label}</div>
          )}
          <div className={styles.arrow}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M6 9L12 15L18 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        </div>
      </div>

      {/* Dropdown options */}
      {isOpen && (
        <div className={styles.selectDropdown}>
          {options.map((option) => (
            <div
              key={option.value}
              className={`${styles.selectOption} ${value === option.value ? styles.selected : ''}`}
              onClick={() => handleSelect(option.value)}
            >
              <Image src={option.icon} alt={option.label} className={styles.iconImage} width={24} height={24} />
              <div className={styles.label}>{option.label}</div>
              <div className={styles.spacer}></div>
              <div className={styles.price}>{option.price}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

