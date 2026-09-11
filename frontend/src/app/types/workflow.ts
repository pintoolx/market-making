// Workflow and node type definitions

export interface CanvasNode {
  id: string;
  type: string;
  label: string;
  icon: string;
  x: number;
  y: number;
  config?: Record<string, string | number | boolean>;
}

export interface Connection {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourcePort?: string;
  targetPort?: string;
}

export interface Workflow {
  id: string;
  title: string;
  description: string;
  nodes: CanvasNode[];
  connections: Connection[];
  createdAt: Date;
  updatedAt: Date;
  isPublished: boolean;
}

export interface NodeDefinition {
  id: string;
  label: string;
  icon: string;
  category: string;
  configSchema: Record<string, { type: string; required?: boolean; default?: string | number | boolean; options?: string[] }>;
}

export interface NodeCategory {
  name: string;
  color: string;
  nodes: NodeDefinition[];
}

// Component prop interfaces for Creator space
export interface WorkflowBuilderProps {
  initialNodes?: CanvasNode[];
  onSave?: (workflow: Workflow) => void;
}

export interface NodeToolboxProps {
  categories: NodeCategory[];
  onNodeDrag: (nodeType: string) => void;
}

export interface WorkflowCanvasProps {
  nodes: CanvasNode[];
  connections: Connection[];
  selectedNodeId: string | null;
  onNodeSelect: (nodeId: string) => void;
  onNodeMove: (nodeId: string, x: number, y: number) => void;
}

export interface ConfigPanelProps {
  selectedNode: CanvasNode | null;
  onConfigChange: (nodeId: string, config: Record<string, string | number | boolean>) => void;
}