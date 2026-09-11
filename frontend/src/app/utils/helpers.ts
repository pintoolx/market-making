// Shared utility functions

import { CanvasNode, Workflow } from '../types/workflow';
import { Strategy, FilterOptions } from '../types/strategy';

// Workflow utilities
export function generateNodeId(): string {
  return `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function generateConnectionId(): string {
  return `connection-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function validateWorkflow(workflow: Workflow): boolean {
  // Basic validation - ensure all nodes have required fields
  if (!workflow.nodes.every(node => node.id && node.type && node.label)) {
    return false;
  }
  
  // Ensure all connections reference valid nodes
  const nodeIds = new Set(workflow.nodes.map(node => node.id));
  return workflow.connections.every(conn => 
    nodeIds.has(conn.sourceNodeId) && nodeIds.has(conn.targetNodeId)
  );
}

export function createEmptyWorkflow(): Workflow {
  return {
    id: `workflow-${Date.now()}`,
    title: 'Untitled Workflow',
    description: '',
    nodes: [],
    connections: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    isPublished: false,
  };
}

// Strategy utilities
export function filterStrategies(strategies: Strategy[], filters: FilterOptions): Strategy[] {
  return strategies.filter(strategy => {
    // Category filter
    if (filters.categories.length > 0 && !filters.categories.includes(strategy.category)) {
      return false;
    }
    
    // Tags filter
    if (filters.tags.length > 0 && !filters.tags.some(tag => strategy.tags.includes(tag))) {
      return false;
    }
    
    // Rating filter
    if (strategy.rating < filters.ratingRange[0] || strategy.rating > filters.ratingRange[1]) {
      return false;
    }
    
    return true;
  });
}

export function sortStrategies(strategies: Strategy[], sortBy: FilterOptions['sortBy']): Strategy[] {
  const sorted = [...strategies];
  
  switch (sortBy) {
    case 'rating':
      return sorted.sort((a, b) => b.rating - a.rating);
    case 'usage':
      return sorted.sort((a, b) => b.usageCount - a.usageCount);
    case 'recent':
      // For now, sort by ID as a proxy for recency
      return sorted.sort((a, b) => b.id.localeCompare(a.id));
    default:
      return sorted;
  }
}

// UI utilities
export function formatRating(rating: number): string {
  return rating.toFixed(1);
}

export function formatUsageCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toString();
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

// Canvas utilities
export function calculateDistance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
}

export function isNodeInBounds(node: CanvasNode, canvasWidth: number, canvasHeight: number): boolean {
  const nodeWidth = 120; // Approximate node width
  const nodeHeight = 60; // Approximate node height
  
  return node.x >= 0 && 
         node.y >= 0 && 
         node.x + nodeWidth <= canvasWidth && 
         node.y + nodeHeight <= canvasHeight;
}

// Local storage utilities
export function saveToLocalStorage<T>(key: string, data: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (error) {
    console.warn('Failed to save to localStorage:', error);
  }
}

export function loadFromLocalStorage<T>(key: string): T | null {
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : null;
  } catch (error) {
    console.warn('Failed to load from localStorage:', error);
    return null;
  }
}

export function removeFromLocalStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.warn('Failed to remove from localStorage:', error);
  }
}