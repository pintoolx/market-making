'use client';

import React, { useState, useRef, useEffect } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import styles from './PoolSelect.module.css';

interface PoolOption {
  value: string;
  label: string;
  apy: number;
}

interface PoolSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: PoolOption[];
}

type SortBy = 'name' | 'apy' | null;
type SortOrder = 'asc' | 'desc';

export default function PoolSelect({ value, onChange, options }: PoolSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const selectRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find(opt => opt.value === value) || options[0];

  // Sort options based on current sort settings
  const sortedOptions = [...options].sort((a, b) => {
    if (sortBy === null) return 0;
    if (sortBy === 'name') {
      const comparison = a.label.localeCompare(b.label);
      return sortOrder === 'asc' ? comparison : -comparison;
    }
    if (sortBy === 'apy') {
      const comparison = a.apy - b.apy;
      return sortOrder === 'asc' ? comparison : -comparison;
    }
    return 0;
  });

  const handleSortClick = (field: 'name' | 'apy') => {
    if (sortBy === field) {
      // Toggle order if clicking same field
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      // Set new field with ascending order
      setSortBy(field);
      setSortOrder('asc');
    }
  };

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
    <div className={styles.poolSelect} ref={selectRef}>
      {/* Selected value display */}
      <div
        className={`${styles.selectTrigger} ${isOpen ? styles.selectTriggerOpen : ''}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className={styles.selectContent}>
          <div className={styles.poolLabelCollapsed}>{selectedOption?.label || value}</div>
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
          {/* Header */}
          <div className={styles.dropdownHeader}>
            <div 
              className={`${styles.headerLeft} ${sortBy === 'name' ? styles.headerActive : ''}`}
              onClick={(e) => { e.stopPropagation(); handleSortClick('name'); }}
            >
              <div className={styles.headerIcon}>
                {sortBy === 'name' ? (
                  sortOrder === 'asc' ? (
                    <ChevronUp size={24} />
                  ) : (
                    <ChevronDown size={24} />
                  )
                ) : (
                  <div className={styles.doubleArrow}>
                    <ChevronUp size={24} />
                    <ChevronDown size={24} style={{ marginTop: '-4px' }} />
                  </div>
                )}
              </div>
              <div className={styles.headerLabel}>Pools</div>
            </div>
            <div 
              className={`${styles.headerRight} ${sortBy === 'apy' ? styles.headerActive : ''}`}
              onClick={(e) => { e.stopPropagation(); handleSortClick('apy'); }}
            >
              <div className={styles.headerIcon}>
                {sortBy === 'apy' ? (
                  sortOrder === 'asc' ? (
                    <ChevronUp size={24} />
                  ) : (
                    <ChevronDown size={24} />
                  )
                ) : (
                  <div className={styles.doubleArrow}>
                    <ChevronUp size={24} />
                    <ChevronDown size={24} style={{ marginTop: '-4px' }} />
                  </div>
                )}
              </div>
              <div className={styles.headerApy}>APY%</div>
            </div>
          </div>

          {/* Options */}
          {sortedOptions.map((option) => (
            <div
              key={option.value}
              className={`${styles.selectOption} ${value === option.value ? styles.selected : ''}`}
              onClick={() => handleSelect(option.value)}
            >
              <div className={styles.poolInfo}>
                <div className={styles.poolLabel}>{option.label}</div>
                <div className={styles.poolApy}>{option.apy}%</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
