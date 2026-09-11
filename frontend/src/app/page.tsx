'use client';

import React from 'react';
import WorkflowBuilder from './components/Creator/WorkflowBuilder';
import { CanvasNode, Connection } from './components/Creator/WorkflowCanvas';
import { useAuth } from './contexts/AuthContext';
import AquaApp from './marketplace/AquaApp';

export default function Home() {
  const { isAuthenticated } = useAuth();

  const handleWorkflowSave = (nodes: CanvasNode[], connections: Connection[]) => {
    console.log('Saving workflow:', { nodes, connections });
    localStorage.setItem('workflow', JSON.stringify({ nodes, connections, savedAt: new Date().toISOString() }));
  };

  const handleWorkflowPublish = (nodes: CanvasNode[], connections: Connection[]) => {
    console.log('Publishing workflow:', { nodes, connections });
    const workflow = { nodes, connections, publishedAt: new Date().toISOString(), isPublished: true };
    localStorage.setItem('publishedWorkflow', JSON.stringify(workflow));
  };

  // Visitors land on the marketplace; the canvas needs a signed-in wallet.
  if (!isAuthenticated) return <AquaApp screen="home" />;

  return (
    <WorkflowBuilder
      onSave={handleWorkflowSave}
      onPublish={handleWorkflowPublish}
    />
  );
}