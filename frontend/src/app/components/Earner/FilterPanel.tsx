'use client';

import React, { useState } from 'react';
import { FilterPanelProps, FilterOptions } from '../../types/strategy';
import styles from './FilterPanel.module.css';

export const FilterPanel: React.FC<FilterPanelProps> = ({
  filters,
  onFilterChange
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Available filter options
  const availableCategories = [
    'Trading Bots',
    'DeFi Strategies',
    'Arbitrage',
    'Market Making',
    'Yield Farming',
    'Portfolio Management'
  ];

  const availableTags = [
    'Beginner',
    'Advanced',
    'High Frequency',
    'Low Risk',
    'High Yield',
    'Automated',
    'Manual',
    'Scalping',
    'Swing Trading',
    'Long Term'
  ];

  const handleCategoryChange = (category: string, checked: boolean) => {
    const newCategories = checked
      ? [...filters.categories, category]
      : filters.categories.filter(c => c !== category);
    
    onFilterChange({
      ...filters,
      categories: newCategories
    });
  };

  const handleTagChange = (tag: string, checked: boolean) => {
    const newTags = checked
      ? [...filters.tags, tag]
      : filters.tags.filter(t => t !== tag);
    
    onFilterChange({
      ...filters,
      tags: newTags
    });
  };

  const handleRatingChange = (min: number, max: number) => {
    onFilterChange({
      ...filters,
      ratingRange: [min, max]
    });
  };

  const handleSortChange = (sortBy: FilterOptions['sortBy']) => {
    onFilterChange({
      ...filters,
      sortBy
    });
  };

  const clearAllFilters = () => {
    onFilterChange({
      categories: [],
      tags: [],
      ratingRange: [0, 5],
      sortBy: 'rating'
    });
  };

  const hasActiveFilters = 
    filters.categories.length > 0 || 
    filters.tags.length > 0 || 
    filters.ratingRange[0] > 0 || 
    filters.ratingRange[1] < 5;

  return (
    <div className={styles.filterPanel}>
      <div className={styles.header}>
        <h3 className={styles.title}>Filters</h3>
        <button
          className={styles.toggleButton}
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? '−' : '+'}
        </button>
      </div>

      <div className={`${styles.content} ${isExpanded ? styles.expanded : ''}`}>
        {/* Sort Options */}
        <div className={styles.section}>
          <h4 className={styles.sectionTitle}>Sort By</h4>
          <div className={styles.sortOptions}>
            {[
              { value: 'rating', label: 'Rating' },
              { value: 'usage', label: 'Most Used' },
              { value: 'recent', label: 'Recently Added' }
            ].map(option => (
              <label key={option.value} className={styles.radioLabel}>
                <input
                  type="radio"
                  name="sortBy"
                  value={option.value}
                  checked={filters.sortBy === option.value}
                  onChange={() => handleSortChange(option.value as FilterOptions['sortBy'])}
                  className={styles.radioInput}
                />
                <span className={styles.radioText}>{option.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Rating Filter */}
        <div className={styles.section}>
          <h4 className={styles.sectionTitle}>Minimum Rating</h4>
          <div className={styles.ratingFilter}>
            <input
              type="range"
              min="0"
              max="5"
              step="0.5"
              value={filters.ratingRange[0]}
              onChange={(e) => handleRatingChange(parseFloat(e.target.value), filters.ratingRange[1])}
              className={styles.rangeInput}
            />
            <div className={styles.ratingDisplay}>
              <span className={styles.ratingValue}>
                {filters.ratingRange[0].toFixed(1)}+ ★
              </span>
            </div>
          </div>
        </div>

        {/* Categories Filter */}
        <div className={styles.section}>
          <h4 className={styles.sectionTitle}>Categories</h4>
          <div className={styles.checkboxGroup}>
            {availableCategories.map(category => (
              <label key={category} className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={filters.categories.includes(category)}
                  onChange={(e) => handleCategoryChange(category, e.target.checked)}
                  className={styles.checkboxInput}
                />
                <span className={styles.checkboxText}>{category}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Tags Filter */}
        <div className={styles.section}>
          <h4 className={styles.sectionTitle}>Tags</h4>
          <div className={styles.tagGroup}>
            {availableTags.map(tag => (
              <button
                key={tag}
                className={`${styles.tagButton} ${
                  filters.tags.includes(tag) ? styles.tagSelected : ''
                }`}
                onClick={() => handleTagChange(tag, !filters.tags.includes(tag))}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        {/* Clear Filters */}
        {hasActiveFilters && (
          <div className={styles.section}>
            <button className={styles.clearButton} onClick={clearAllFilters}>
              Clear All Filters
            </button>
          </div>
        )}
      </div>

      {/* Active Filters Summary */}
      {hasActiveFilters && (
        <div className={styles.activeFilters}>
          <span className={styles.activeFiltersLabel}>Active:</span>
          <div className={styles.activeFiltersList}>
            {filters.categories.map(category => (
              <span key={category} className={styles.activeFilter}>
                {category}
                <button
                  onClick={() => handleCategoryChange(category, false)}
                  className={styles.removeFilter}
                >
                  ×
                </button>
              </span>
            ))}
            {filters.tags.map(tag => (
              <span key={tag} className={styles.activeFilter}>
                {tag}
                <button
                  onClick={() => handleTagChange(tag, false)}
                  className={styles.removeFilter}
                >
                  ×
                </button>
              </span>
            ))}
            {filters.ratingRange[0] > 0 && (
              <span className={styles.activeFilter}>
                {filters.ratingRange[0].toFixed(1)}+ ★
                <button
                  onClick={() => handleRatingChange(0, filters.ratingRange[1])}
                  className={styles.removeFilter}
                >
                  ×
                </button>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};