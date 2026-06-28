# Design Document

## Overview

The PinTool application will be restructured from a single-page workflow builder into a multi-page application with three distinct pages:

1. **Entry Page** (`/`) - A landing page that routes users to Creator or Earner spaces
2. **Creator Space** (`/creator`) - The existing advanced workflow builder interface
3. **Earner Space** (`/earner`) - A new marketplace interface for browsing and activating strategies

This design maintains the powerful workflow building capabilities while introducing a user-friendly marketplace experience, creating clear separation of concerns and improved user experience for different user types.

## Architecture

### Page Structure
```
src/app/
├── page.tsx                    # Entry page with role selection
├── creator/
│   └── page.tsx               # Creator space (workflow builder)
├── earner/
│   └── page.tsx               # Earner space (marketplace)
├── components/
│   ├── EntryPage/
│   │   ├── RoleSelector.tsx   # Role selection component
│   │   └── EntryPage.module.css
│   ├── Creator/
│   │   ├── WorkflowBuilder.tsx # Existing workflow builder (refactored)
│   │   ├── NodeToolbox.tsx    # Left panel with node categories
│   │   ├── WorkflowCanvas.tsx # Center canvas area
│   │   ├── ConfigPanel.tsx    # Right configuration panel
│   │   └── Creator.module.css
│   ├── Earner/
│   │   ├── StrategyMarketplace.tsx # Main marketplace component
│   │   ├── StrategyCard.tsx   # Individual strategy display
│   │   ├── FilterPanel.tsx    # Strategy filtering options
│   │   └── Earner.module.css
│   └── shared/
│       ├── Navigation.tsx     # Common navigation component
│       ├── Layout.tsx         # Shared layout wrapper
│       └── shared.module.css
└── types/
    ├── workflow.ts            # Workflow and node type definitions
    └── strategy.ts            # Strategy marketplace types
```

### Technology Stack
- **Framework**: Next.js 15.5.2 with App Router
- **Language**: TypeScript
- **Styling**: CSS Modules (maintaining current approach) + Tailwind CSS
- **State Management**: React useState/useContext for local state
- **UI Components**: Custom components following current design system

## Components and Interfaces

### Entry Page Components

#### RoleSelector Component
```typescript
interface RoleSelectorProps {
  onRoleSelect: (role: 'creator' | 'earner') => void;
}
```

**Responsibilities:**
- Display two prominent cards/buttons for role selection
- Handle navigation to appropriate spaces
- Provide clear visual distinction between Creator and Earner paths
- Include brief descriptions of each role

### Creator Space Components

#### WorkflowBuilder Component (Refactored from PinToolCorePage)
```typescript
interface WorkflowBuilderProps {
  initialNodes?: CanvasNode[];
  onSave?: (workflow: Workflow) => void;
}
```

**Responsibilities:**
- Orchestrate the three-panel layout (toolbox, canvas, config)
- Manage workflow state and node interactions
- Handle workflow saving and publishing functionality

#### NodeToolbox Component
```typescript
interface NodeCategory {
  name: string;
  color: string;
  nodes: NodeDefinition[];
}

interface NodeToolboxProps {
  categories: NodeCategory[];
  onNodeDrag: (nodeType: string) => void;
}
```

#### WorkflowCanvas Component
```typescript
interface CanvasNode {
  id: string;
  type: string;
  label: string;
  icon: string;
  x: number;
  y: number;
  config?: Record<string, any>;
}

interface WorkflowCanvasProps {
  nodes: CanvasNode[];
  connections: Connection[];
  selectedNodeId: string | null;
  onNodeSelect: (nodeId: string) => void;
  onNodeMove: (nodeId: string, x: number, y: number) => void;
}
```

#### ConfigPanel Component
```typescript
interface ConfigPanelProps {
  selectedNode: CanvasNode | null;
  onConfigChange: (nodeId: string, config: Record<string, any>) => void;
}
```

### Earner Space Components

#### StrategyMarketplace Component
```typescript
interface Strategy {
  id: string;
  title: string;
  description: string;
  creator: string;
  category: string;
  tags: string[];
  rating: number;
  usageCount: number;
  isActive: boolean;
  previewImage?: string;
}

interface StrategyMarketplaceProps {
  strategies: Strategy[];
  onStrategyActivate: (strategyId: string) => void;
  onStrategyDeactivate: (strategyId: string) => void;
}
```

#### StrategyCard Component
```typescript
interface StrategyCardProps {
  strategy: Strategy;
  onActivate: (strategyId: string) => void;
  onDeactivate: (strategyId: string) => void;
  onViewDetails: (strategyId: string) => void;
}
```

#### FilterPanel Component
```typescript
interface FilterOptions {
  categories: string[];
  tags: string[];
  ratingRange: [number, number];
  sortBy: 'rating' | 'usage' | 'recent';
}

interface FilterPanelProps {
  filters: FilterOptions;
  onFilterChange: (filters: FilterOptions) => void;
}
```

### Shared Components

#### Navigation Component
```typescript
interface NavigationProps {
  currentPage: 'entry' | 'creator' | 'earner';
  showBackToHome?: boolean;
}
```

#### Layout Component
```typescript
interface LayoutProps {
  children: React.ReactNode;
  showNavigation?: boolean;
  pageType: 'entry' | 'creator' | 'earner';
}
```

## Data Models

### Workflow Types
```typescript
interface Workflow {
  id: string;
  title: string;
  description: string;
  nodes: CanvasNode[];
  connections: Connection[];
  createdAt: Date;
  updatedAt: Date;
  isPublished: boolean;
}

interface Connection {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourcePort?: string;
  targetPort?: string;
}

interface NodeDefinition {
  id: string;
  label: string;
  icon: string;
  category: string;
  configSchema: Record<string, any>;
}
```

### Strategy Types
```typescript
interface PublishedStrategy {
  id: string;
  workflowId: string;
  title: string;
  description: string;
  creator: {
    id: string;
    name: string;
    avatar?: string;
  };
  category: string;
  tags: string[];
  rating: number;
  reviewCount: number;
  usageCount: number;
  publishedAt: Date;
  previewImage?: string;
  workflow: Workflow;
}

interface UserStrategy {
  id: string;
  strategyId: string;
  userId: string;
  isActive: boolean;
  activatedAt: Date;
  customConfig?: Record<string, any>;
}
```

## Error Handling

### Navigation Errors
- **Invalid Routes**: Redirect to entry page with error message
- **Missing Permissions**: Show appropriate access denied message
- **Network Issues**: Display offline mode with cached data when possible

### Creator Space Errors
- **Workflow Save Failures**: Show retry mechanism with local backup
- **Node Configuration Errors**: Validate inputs with clear error messages
- **Publishing Errors**: Provide detailed feedback on publication requirements

### Earner Space Errors
- **Strategy Loading Failures**: Show skeleton loading states and retry options
- **Activation Errors**: Clear feedback on why activation failed
- **Filter/Search Errors**: Graceful degradation with basic functionality

### Error Boundaries
```typescript
interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
}
```

## Testing Strategy

### Unit Testing
- **Component Testing**: Test each component in isolation using React Testing Library
- **Hook Testing**: Test custom hooks for state management and business logic
- **Utility Testing**: Test helper functions and data transformations

### Integration Testing
- **Page Navigation**: Test routing between entry, creator, and earner pages
- **Workflow Operations**: Test complete workflow creation, editing, and publishing flows
- **Strategy Marketplace**: Test strategy browsing, filtering, and activation flows

### End-to-End Testing
- **User Journeys**: Test complete user flows from entry to task completion
- **Cross-Page Interactions**: Test data persistence across page transitions
- **Responsive Design**: Test functionality across different screen sizes

### Performance Testing
- **Page Load Times**: Ensure fast initial page loads and transitions
- **Canvas Performance**: Test workflow canvas with large numbers of nodes
- **Strategy Loading**: Test marketplace performance with many strategies

## Design System Consistency

### Visual Design
- **Color Scheme**: Maintain current dark theme with accent colors
  - Background: `#181A20`
  - Panel Background: `#23243A`
  - Accent: `#FFD166`
  - Text: `#F3F3F3`
- **Typography**: Continue using Inter font family
- **Spacing**: Consistent 8px grid system
- **Border Radius**: 8-12px for cards and panels

### Component Patterns
- **Cards**: Consistent card design across strategy cards and role selectors
- **Buttons**: Primary, secondary, and tertiary button styles
- **Form Elements**: Consistent input styling matching current config panel
- **Navigation**: Clear breadcrumbs and back navigation options

### Responsive Design
- **Desktop First**: Optimize for desktop workflow building experience
- **Tablet Support**: Ensure marketplace works well on tablets
- **Mobile Considerations**: Basic mobile support for strategy browsing