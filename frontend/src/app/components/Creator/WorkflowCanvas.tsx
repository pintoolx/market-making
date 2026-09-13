/* eslint-disable @next/next/no-img-element */
'use client';

import React, { useState, useRef, useCallback, useEffect, memo } from 'react';
import CanvasToolbar from './CanvasToolbar';
import styles from './WorkflowCanvas.module.css';

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

interface WorkflowCanvasProps {
  nodes: CanvasNode[];
  connections?: Connection[];
  selectedNodeId: string | null;
  onNodeSelect: (nodeId: string) => void;
  onNodeDelete?: (nodeId: string) => void;
  onNodeDrop?: (nodeType: string, x: number, y: number) => void;
  onNodeMove?: (nodeId: string, x: number, y: number) => void;
  onViewportChange?: (viewport: { x: number; y: number; zoom: number }) => void;
  onCreateNodesFromChat?: () => void;
  onAddNode?: (nodeType: string) => void;
  onPlayClick?: () => void;
}

function WorkflowCanvas({
  nodes,
  connections = [],
  selectedNodeId,
  onNodeSelect,
  onNodeDelete,
  onNodeDrop,
  onNodeMove,
  onViewportChange,
  onCreateNodesFromChat,
  onAddNode,
  onPlayClick
}: WorkflowCanvasProps) {
  // Viewport state for pan and zoom
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [isDraggingCanvas, setIsDraggingCanvas] = useState(false);
  const [isDraggingNode, setIsDraggingNode] = useState(false);
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [dragStartPos, setDragStartPos] = useState({ x: 0, y: 0 });
  const [showChatPanel, setShowChatPanel] = useState(false);
  const [activeToolButton, setActiveToolButton] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const isPanningRef = useRef(false);
  const lastMousePosRef = useRef({ x: 0, y: 0 });
  const lastClickRef = useRef<{ nodeId: string; time: number } | null>(null);

  // Apply boundary constraints to prevent dragging beyond canvas
  const applyBoundaryConstraints = useCallback((x: number, y: number, zoom: number) => {
    if (!canvasRef.current) return { x, y };

    const canvasWidth = 5000 * zoom;
    const canvasHeight = 5000 * zoom;
    const viewportWidth = canvasRef.current.clientWidth;
    const viewportHeight = canvasRef.current.clientHeight;

    // Calculate boundaries
    // Maximum values: allow viewport to show the top-left of canvas
    const maxX = 0;
    const maxY = 0;

    // Minimum values: don't allow dragging beyond bottom-right of canvas
    const minX = -(canvasWidth - viewportWidth);
    const minY = -(canvasHeight - viewportHeight);

    return {
      x: Math.max(minX, Math.min(maxX, x)),
      y: Math.max(minY, Math.min(maxY, y))
    };
  }, []);

  // Notify parent of viewport changes
  useEffect(() => {
    if (onViewportChange) {
      onViewportChange(viewport);
    }
  }, [viewport, onViewportChange]);

  // Convert screen coordinates to canvas coordinates
  const screenToCanvas = useCallback((screenX: number, screenY: number) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: (screenX - rect.left - viewport.x) / viewport.zoom,
      y: (screenY - rect.top - viewport.y) / viewport.zoom
    };
  }, [viewport]);

  // Handle canvas pan (left click on empty space)
  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    // Left click for panning (will not trigger if clicking on a node due to stopPropagation)
    if (e.button === 0) {
      e.preventDefault();
      isPanningRef.current = true;
      setIsDraggingCanvas(true);
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };
      setDragStartPos({ x: e.clientX, y: e.clientY });
    }
  }, []);

  // Handle node drag start
  const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    // Only handle left mouse button
    if (e.button !== 0) return;

    e.stopPropagation();
    e.preventDefault();

    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    // Start dragging the node
    setIsDraggingNode(true);
    setDraggedNodeId(nodeId);
    setDragStartPos({ x: e.clientX, y: e.clientY });

    const canvasPos = screenToCanvas(e.clientX, e.clientY);
    setDragOffset({
      x: canvasPos.x - node.x,
      y: canvasPos.y - node.y
    });
  }, [nodes, screenToCanvas]);

  // Handle mouse move
  const handleMouseMove = useCallback((e: MouseEvent) => {
    // Handle canvas panning
    if (isPanningRef.current) {
      const deltaX = e.clientX - lastMousePosRef.current.x;
      const deltaY = e.clientY - lastMousePosRef.current.y;

      setViewport(prev => {
        const newX = prev.x + deltaX;
        const newY = prev.y + deltaY;
        const constrained = applyBoundaryConstraints(newX, newY, prev.zoom);

        return {
          ...prev,
          ...constrained
        };
      });

      lastMousePosRef.current = { x: e.clientX, y: e.clientY };
      return;
    }

    // Handle node dragging
    if (isDraggingNode && draggedNodeId && onNodeMove) {
      const canvasPos = screenToCanvas(e.clientX, e.clientY);
      const newX = canvasPos.x - dragOffset.x;
      const newY = canvasPos.y - dragOffset.y;
      onNodeMove(draggedNodeId, newX, newY);
    }
  }, [isDraggingNode, draggedNodeId, dragOffset, onNodeMove, screenToCanvas, applyBoundaryConstraints]);

  // Handle mouse up
  const handleMouseUp = useCallback((e: MouseEvent) => {
    const distanceMoved = Math.sqrt(
      Math.pow(e.clientX - dragStartPos.x, 2) +
      Math.pow(e.clientY - dragStartPos.y, 2)
    );

    // If we were dragging a node and barely moved, it's a click
    if (isDraggingNode && draggedNodeId && distanceMoved < 5) {
      const now = Date.now();
      const lastClick = lastClickRef.current;

      // Check for double click (within 300ms on the same node)
      if (lastClick && lastClick.nodeId === draggedNodeId && now - lastClick.time < 300) {
        // Double click detected - delete the node
        if (onNodeDelete) {
          onNodeDelete(draggedNodeId);
        }
        lastClickRef.current = null; // Reset click tracking
      } else {
      // Single click - select the node immediately
        onNodeSelect(draggedNodeId);
        lastClickRef.current = { nodeId: draggedNodeId, time: now };
      }
    }

    // Reset all dragging states
    setIsDraggingCanvas(false);
    isPanningRef.current = false;
    setIsDraggingNode(false);
    setDraggedNodeId(null);
  }, [dragStartPos, isDraggingNode, draggedNodeId, onNodeSelect, onNodeDelete]);

  // Handle zoom (Figma-style: scroll up = zoom in, scroll down = zoom out)
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();

    const delta = e.deltaY > 0 ? 1.1 : 0.9;
    // Zoom ranges from 1 (80x80 logo) to 2 (160x160 logo).
    const newZoom = Math.min(Math.max(1, viewport.zoom * delta), 2);

    // Zoom towards mouse cursor
    if (canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      setViewport(prev => {
        const newX = mouseX - (mouseX - prev.x) * (newZoom / prev.zoom);
        const newY = mouseY - (mouseY - prev.y) * (newZoom / prev.zoom);
        const constrained = applyBoundaryConstraints(newX, newY, newZoom);

        return {
          ...constrained,
          zoom: newZoom
        };
      });
    }
  }, [viewport.zoom, applyBoundaryConstraints]);

  // Handle drop from toolbox
  const handleCanvasDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    if (onNodeDrop) {
      const canvasPos = screenToCanvas(event.clientX, event.clientY);
      const nodeType = event.dataTransfer.getData('text/plain');
      onNodeDrop(nodeType, canvasPos.x, canvasPos.y);
    }
  }, [onNodeDrop, screenToCanvas]);

  const handleCanvasDragOver = (event: React.DragEvent) => {
    event.preventDefault();
  };

  // Add event listeners for mouse events
  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => handleMouseMove(e);
    const handleGlobalMouseUp = (e: MouseEvent) => handleMouseUp(e);

    if (isDraggingCanvas || isDraggingNode) {
      document.addEventListener('mousemove', handleGlobalMouseMove);
      document.addEventListener('mouseup', handleGlobalMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [isDraggingCanvas, isDraggingNode, handleMouseMove, handleMouseUp]);

  // Zoom controls
  const handleZoomIn = () => {
    setViewport(prev => {
      const newZoom = Math.min(prev.zoom * 1.2, 2); // Maximum 2x.
      const constrained = applyBoundaryConstraints(prev.x, prev.y, newZoom);
      return {
        ...constrained,
        zoom: newZoom
      };
    });
  };

  const handleZoomOut = () => {
    setViewport(prev => {
      const newZoom = Math.max(prev.zoom / 1.2, 1); // Minimum 1x, preserving the 80x80 logo.
      const constrained = applyBoundaryConstraints(prev.x, prev.y, newZoom);
      return {
        ...constrained,
        zoom: newZoom
      };
    });
  };

  const handleResetView = () => {
    setViewport({ x: 0, y: 0, zoom: 1 });
  };

  return (
    <main className={styles.canvasArea}>
      <div 
        ref={canvasRef}
        className={`${styles.canvasBg} ${isDraggingCanvas ? styles.panning : ''} ${isDraggingNode ? styles.dragging : ''}`}
        onDrop={handleCanvasDrop}
        onDragOver={handleCanvasDragOver}
        onMouseDown={handleCanvasMouseDown}
        onWheel={handleWheel}
        style={{ cursor: isDraggingCanvas ? 'grabbing' : 'default' }}
      >
        {/* Gradient overlay - fixed to viewport, doesn't scale */}
        <div className={styles.gradientOverlay} />

        {/* Viewport container */}
        <div
          className={styles.viewport}
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            transformOrigin: '0 0'
          }}
        >
          {/* Use a repeating CSS background to avoid generating excessive DOM nodes during responsive layout. */}
          <div className={styles.backgroundGrid} aria-hidden />

          {/* Nodes - sorted by x coordinate so rightmost nodes appear on top */}
          {[...nodes].sort((a, b) => a.x - b.x).map((node) => {
            const isJupiterSwap = node.type === 'jupiter-swap';
            const isPythPriceFeed = node.type === 'pyth-price-feed';
            const isKaminoLending = node.type === 'kamino-deposit';
            const isMarinadeStake = node.type === 'marinade-stake';
            const isTelegramNotify = node.type === 'telegram-notify';
            const isDiscordNotify = node.type === 'discord-notify';

            // Get node config for display (pyth-price-feed)
            // Current backend parameter format: ticker / targetPrice / condition.
            // Legacy format compatibility: asset / operator / threshold.
            const ticker = isPythPriceFeed
              ? (typeof node.config?.ticker === 'string'
                ? node.config.ticker
                : (node.config?.asset as string | undefined))
              : undefined;

            const assetIcon = isPythPriceFeed && ticker
              ? (ticker === 'SOL' ? '/solana.svg'
                : ticker === 'JITOSOL' ? '/jitosol.svg'
                  : ticker === 'USDC' ? '/usdc.svg'
                    : null)
              : null;

            const condition = isPythPriceFeed
              ? (typeof node.config?.condition === 'string'
                ? node.config.condition
                : (node.config?.operator as string | undefined))
              : '';

            const operatorSymbol = isPythPriceFeed
              ? (condition === 'below' || condition === 'less_than' || condition === 'less_than_or_equal' ? '≤'
                : condition === 'above' || condition === 'greater_than' || condition === 'greater_than_or_equal' ? '≥'
                  : condition === 'equal' || condition === 'equal_to' ? '='
                    : '')
              : '';

            const targetPriceRaw = isPythPriceFeed ? (node.config?.targetPrice ?? node.config?.threshold) : undefined;
            const targetPriceNum = typeof targetPriceRaw === 'number'
              ? targetPriceRaw
              : typeof targetPriceRaw === 'string'
                ? Number(targetPriceRaw)
                : undefined;
            const displayValue = isPythPriceFeed && targetPriceNum !== undefined && !Number.isNaN(targetPriceNum)
              ? targetPriceNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
              : '';

            // Determine node background SVG and shadow color based on type
            const getNodeStyle = () => {
              if (isPythPriceFeed || node.type === 'binance-price-feed') {
                return { svg: '/Price Feed.svg', shadowColor: '#BF79F0' };
              }
              if (isJupiterSwap) {
                return { svg: '/DEX.svg', shadowColor: '#79F0BE' };
              }
              if (isKaminoLending) {
                return { svg: '/Lending.svg', shadowColor: '#F07979' };
              }
              if (isMarinadeStake) {
                return { svg: '/Staking.svg', shadowColor: '#79D0F0' };
              }
              if (node.type === 'if-else') {
                return { svg: '/Logicnode.svg', shadowColor: '#799BF0' };
              }
              if (isTelegramNotify || isDiscordNotify) {
                return { svg: '/Notification.svg', shadowColor: '#F079E0' };
              }
              return { svg: '/node.svg', shadowColor: '#BF79F0' };
            };
            const nodeStyle = getNodeStyle();

            return (
              <div
                key={node.id}
                className={`${styles.canvasNode} ${selectedNodeId === node.id ? styles.selectedNode : ''
                  } ${draggedNodeId === node.id ? styles.dragging : ''}`}
                style={{
                  left: `${node.x}px`,
                  top: `${node.y}px`,
                  cursor: isDraggingNode && draggedNodeId === node.id ? 'grabbing' : 'grab',
                  '--shadow-color': nodeStyle.shadowColor,
                  zIndex: Math.max(1, Math.floor(10000 - node.x))
                } as React.CSSProperties}
                onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
              >
                <img
                  src={nodeStyle.svg}
                  alt={node.label}
                  className={styles.nodeImage}
                  draggable={false}
                />

                {/* Node Content Overlay */}
                <div className={styles.nodeContent}>
                  {isJupiterSwap ? (
                    <>
                      {/* Expanded view at 2x zoom */}
                      {viewport.zoom >= 2 && (
                        (() => {
                          const srcAmountRaw = node.config?.sourceAmount;
                          const srcAmount = typeof srcAmountRaw === 'number' ? srcAmountRaw : (typeof srcAmountRaw === 'string' ? Number(srcAmountRaw) : 0);
                          const tgtAmountRaw = node.config?.targetAmount;
                          const tgtAmount = typeof tgtAmountRaw === 'number' ? tgtAmountRaw : (typeof tgtAmountRaw === 'string' ? Number(tgtAmountRaw) : 0);
                          return (
                            <>
                              <div className={styles.swapInputValue}>
                                ${!isNaN(srcAmount) && srcAmount > 0 ? srcAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '000.00'} {(node.config?.sourceToken as string) || 'SOL'}
                              </div>
                              <div className={styles.swapOutputValue}>
                                ${!isNaN(tgtAmount) && tgtAmount > 0 ? tgtAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '000.00'} {(node.config?.targetToken as string) || 'USDC'}
                              </div>
                            </>
                          );
                        })()
                      )}
                      <div
                        className={`${styles.nodeIcon} ${styles.jupiterIcon}`}
                        style={{
                          WebkitMask: `url('/jupiter.svg') center/contain no-repeat`,
                          mask: `url('/jupiter.svg') center/contain no-repeat`,
                          transform: `translateY(-50%) scale(${1 / viewport.zoom})`,
                        }}
                      />
                    </>
                  ) : isPythPriceFeed ? (
                    <>
                      {/* Expanded view at 2x zoom */}
                      {viewport.zoom >= 2 && (
                        <>
                          <div className={styles.priceFeedHeader}>
                            <div className={styles.barChartIcon}>
                              <div className={styles.bar1} />
                              <div className={styles.bar2} />
                              <div className={styles.bar3} />
                            </div>
                            <span className={styles.priceFeedLabel}>Pyth</span>
                          </div>
                          <div className={styles.priceFeedValue}>
                            <span>$</span>
                            <span>{displayValue || '000.00'}</span>
                          </div>
                        </>
                      )}
                      {assetIcon && (
                        <div
                          className={`${styles.nodeIcon} ${styles.priceFeedIcon}`}
                          style={{
                            WebkitMask: `url('${assetIcon}') center/contain no-repeat`,
                            mask: `url('${assetIcon}') center/contain no-repeat`,
                            transform: `translateY(-50%) scale(${1 / viewport.zoom})`,
                          }}
                        />
                      )}
                      {operatorSymbol && (
                        <div className={styles.nodeOperator}>
                          {operatorSymbol}
                        </div>
                      )}
                    </>
                  ) : isKaminoLending ? (
                    <>
                          {/* Expanded view at 2x zoom */}
                          {viewport.zoom >= 2 ? (
                            (() => {
                              const poolValue = node.config?.pool as string;
                              const poolLabel = poolValue === 'pool-a' ? 'USDC Prime'
                                : poolValue === 'pool-b' ? 'Allez USDC'
                                  : poolValue === 'pool-c' ? 'Steakhouse'
                                    : poolValue || 'Pool';
                              const amountRaw = node.config?.amount;
                              const amount = typeof amountRaw === 'number' ? amountRaw : (typeof amountRaw === 'string' ? Number(amountRaw) : 0);
                              const asset = (node.config?.asset as string) || 'USDC';
                              const assetIcon = asset === 'SOL' ? '/solana.svg'
                                : asset === 'JitoSOL' ? '/jitosol.svg'
                                  : '/usdc.svg';
                              return (
                                <>
                                  <div className={styles.kaminoPoolLabel}>
                                    {poolLabel}
                                  </div>
                                  <div className={styles.kaminoAmountValue}>
                                    {!isNaN(amount) && amount > 0 ? amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'} {asset}
                                  </div>
                                  {/* Icons container - centered together */}
                                  <div
                                    className={styles.kaminoIconsContainer}
                                    style={{ transform: `translate(-50%, -50%) scale(${1 / viewport.zoom})` }}
                                  >
                                    <div
                                      className={styles.kaminoIconExpanded}
                                      style={{
                                        WebkitMask: `url('/kamino.svg') center/contain no-repeat`,
                                        mask: `url('/kamino.svg') center/contain no-repeat`,
                                      }}
                                    />
                                    <div
                                      className={styles.kaminoAssetIcon}
                                      style={{
                                        WebkitMask: `url('${assetIcon}') center/contain no-repeat`,
                                        mask: `url('${assetIcon}') center/contain no-repeat`,
                                      }}
                                    />
                                  </div>
                                </>
                              );
                            })()
                          ) : (
                            <div
                              className={`${styles.nodeIcon} ${styles.kaminoIconDefault}`}
                              style={{
                                WebkitMask: `url('/kamino.svg') center/contain no-repeat`,
                                mask: `url('/kamino.svg') center/contain no-repeat`,
                                transform: `translateY(-50%) scale(${1 / viewport.zoom})`,
                              }}
                            />
                          )}
                    </>
                  ) : isMarinadeStake ? (
                    <div
                      className={`${styles.nodeIcon} ${styles.marinadeIcon}`}
                      style={{
                        WebkitMask: `url('/marinade.svg') center/contain no-repeat`,
                        mask: `url('/marinade.svg') center/contain no-repeat`,
                        transform: `translateY(-50%) scale(${1 / viewport.zoom})`,
                      }}
                    />
                  ) : isTelegramNotify ? (
                    <>
                            <div
                              className={`${styles.nodeIcon} ${styles.notificationIcon}`}
                              style={{
                                WebkitMask: `url('/telegram.svg') center/contain no-repeat`,
                                mask: `url('/telegram.svg') center/contain no-repeat`,
                                transform: `translateY(-50%) scale(${1 / viewport.zoom})`,
                              }}
                            />
                    </>
                  ) : isDiscordNotify ? (
                    <>
                              <div
                                className={`${styles.nodeIcon} ${styles.notificationIcon}`}
                                style={{
                                  WebkitMask: `url('/discord.svg') center/contain no-repeat`,
                                  mask: `url('/discord.svg') center/contain no-repeat`,
                                  transform: `translateY(-50%) scale(${1 / viewport.zoom})`,
                                }}
                              />
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Zoom controls - hidden */}
      {false && (
        <div className={styles.canvasControls}>
          <button
            className={styles.controlButton}
            onClick={handleZoomIn}
            title="Zoom In"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M10 4V16M4 10H16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className={styles.controlButton}
            onClick={handleZoomOut}
            title="Zoom Out"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M4 10H16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className={styles.controlButton}
            onClick={handleResetView}
            title="Reset View"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M4 10H16M10 4L16 10L10 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className={styles.zoomLevel}>
            {Math.round(viewport.zoom * 100)}%
          </div>
        </div>
      )}

      {/* Stats Display - Top Right */}
      <div className={styles.statsDisplay}>
        <div className={styles.statItem}>
          <span className={styles.statText}>{nodes.length} Nodes</span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statText}>{connections.length} Connections</span>
        </div>
      </div>

      {/* Canvas Toolbar */}
      <CanvasToolbar
        onAgentClick={() => setShowChatPanel(prev => !prev)}
        isAgentActive={showChatPanel}
        onChatClose={() => setShowChatPanel(false)}
        onCreateNodesFromChat={onCreateNodesFromChat}
        onPriceFeedClick={() => setActiveToolButton(prev => prev === 'triggers' ? null : 'triggers')}
        onSwapClick={() => setActiveToolButton(prev => prev === 'logic' ? null : 'logic')}
        onActivityClick={() => setActiveToolButton(prev => prev === 'actions' ? null : 'actions')}
        onAlertClick={() => setActiveToolButton(prev => prev === 'notification' ? null : 'notification')}
        onAddNode={(nodeType) => {
          onAddNode?.(nodeType);
          setActiveToolButton(null);
        }}
        onPlayClick={onPlayClick}
        isTriggersActive={activeToolButton === 'triggers'}
        isLogicActive={activeToolButton === 'logic'}
        isActionsActive={activeToolButton === 'actions'}
        isNotificationActive={activeToolButton === 'notification'}
      />

      {/* Zoom Controls - Bottom Right */}
      <div className={styles.zoomControls}>
        <button
          className={styles.zoomButton}
          onClick={handleZoomOut}
          title="Zoom Out"
        >
          -
        </button>
        <span className={styles.zoomLevel}>
          {Math.round(viewport.zoom * 100)}%
        </span>
        <button
          className={styles.zoomButton}
          onClick={handleZoomIn}
          title="Zoom In"
        >
          +
        </button>
      </div>

    </main>
  );
}

export default memo(WorkflowCanvas);
