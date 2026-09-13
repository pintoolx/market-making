"use client";

import React, { useState, useCallback, useRef, useEffect } from "react";
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from "next/dynamic";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletSendTransactionError } from "@solana/wallet-adapter-base";
import {
  Connection as SolanaConnection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { NodeCategory } from "./NodeToolbox";
import WorkflowCanvas, { CanvasNode, Connection } from "./WorkflowCanvas";
import ConfigPanel from "./ConfigPanel";
import WorkflowTabs, { WorkflowTab } from "./WorkflowTabs";

function workflowTabDisplayName(tab: WorkflowTab): string {
  return tab.isNew ? `New ${tab.name}` : tab.name;
}
import styles from "./WorkflowBuilder.module.css";
import { createWorkflow, createCanvas, updateCanvas, deleteCanvas } from "../../lib/workflowService";
import { initWallet } from "../../lib/pintoolApi";
import { useAuth } from "../../contexts/AuthContext";
import { supabase } from "../../lib/supabase";
import { useToast } from "../shared/Toast";
import FormInput from "../shared/FormInput";
import Primary from "../shared/Primary";
import Secondary from "../shared/Secondary";

const SignInButton = dynamic(() => import("../shared/SignInButton"), {
  ssr: false,
  loading: () => <div style={{ width: '150px', height: '40px' }}></div>,
});

// Background Grid configuration (synced with WorkflowCanvas)
const BACKGROUND_CONFIG = {
  LOGO_SIZE_DESKTOP: 80,
  OVERLAP_RATIO: 0.25,
};

// Calculate grid spacing
const getGridSpacing = () => {
  return BACKGROUND_CONFIG.LOGO_SIZE_DESKTOP * (1 - BACKGROUND_CONFIG.OVERLAP_RATIO);
};

// Function to align to grid
const snapToGrid = (value: number, gridSize: number) => {
  return Math.round(value / gridSize) * gridSize;
};

/** Illustrative SOL-to-USD conversion for the success screen, not a live quote. */
const SOL_USD_DISPLAY_APPROX = 80;

/** Recover underlying RPC errors when wallets wrap them in WalletSendTransactionError or Unexpected error. */
function formatSolTransferError(err: unknown): string {
  if (err instanceof WalletSendTransactionError) {
    if (err.error) {
      const inner = err.error as { message?: string };
      if (inner?.message && inner.message !== "Unexpected error") return inner.message;
    }
    // StandardWalletAdapter may throw WalletSendTransactionError without a message for a chain mismatch.
    if (!err.message || err.message === "Unexpected error") {
      return "Wallet blocked send (often: wallet is on a different cluster than this app). Switch your wallet to Mainnet, the same cluster as this app.";
    }
  }
  const m = (err as Error)?.message;
  if (m && m !== "Unexpected error") return m;
  return "Transaction failed. Make sure your wallet is on Mainnet with enough SOL for amount + fees.";
}

/** Simulate before sending so Phantom can show a useful error. */
async function assertTransferSimulationOk(connection: SolanaConnection, tx: Transaction): Promise<void> {
  const { value } = await connection.simulateTransaction(tx);
  if (value.err) {
    const tail = value.logs?.slice(-8).join(" | ") ?? "";
    throw new Error(
      `Simulation: ${JSON.stringify(value.err)}${tail ? ` — ${tail}` : ""}`
    );
  }
}

type WalletTransferFns = {
  sendTransaction: (
    transaction: Transaction,
    connection: SolanaConnection,
    options?: Record<string, unknown>
  ) => Promise<string>;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
};

/**
 * StandardWalletAdapter.sendTransaction checks whether account.chains includes the chain inferred from the RPC.
 * The inference uses @solana/wallet-standard-util getChainForEndpoint; a mismatch throws a message-less
 * WalletSendTransactionError, which appears as Unexpected error.
 * Prefer signTransaction plus sendRawTransaction, retaining the same wallet signer and Connection while avoiding that adapter check.
 */
async function signAndSendLegacyTransfer(
  wallet: WalletTransferFns,
  connection: SolanaConnection,
  transaction: Transaction
): Promise<string> {
  await assertTransferSimulationOk(connection, transaction);

  if (typeof wallet.signTransaction === "function") {
    const signed = await wallet.signTransaction(transaction);
    return connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  }

  return wallet.sendTransaction(transaction, connection);
}

/**
 * Add a buffer above the computed shortfall to account for floating-point conversion and onchain rounding.
 * Before Crossmint creation in Step 2, assume a zero balance: threshold = minimum rent + buffer.
 */
const RENT_TOP_UP_BUFFER_LAMPORTS = 1_000_000; // 0.001 SOL

/**
 * If the receiving Crossmint account is below rent exemption, its post-deposit total must reach getMinimumBalanceForRentExemption(0).
 * Otherwise simulation may return InsufficientFundsForRent, usually for the receiving account index.
 */
async function getRentTopUpLamports(
  connection: SolanaConnection,
  toPubkey: PublicKey
): Promise<{
  minRentLamports: number;
  minExtraLamports: number;
  /** Recommended additional lamports including the buffer; zero when rent is already covered. */
  requiredSendLamports: number;
}> {
  const minRentLamports = await connection.getMinimumBalanceForRentExemption(0);
  const currentLamports = await connection.getBalance(toPubkey);
  const minExtraLamports = Math.max(0, minRentLamports - currentLamports);
  const requiredSendLamports =
    minExtraLamports === 0 ? 0 : minExtraLamports + RENT_TOP_UP_BUFFER_LAMPORTS;
  return { minRentLamports, minExtraLamports, requiredSendLamports };
}

/** Format the deposit hint in SOL without trailing zeros; match Figma 620:31954. */
function formatSolAmountForHint(sol: number): string {
  const t = sol.toFixed(6);
  return t.replace(/\.?0+$/, '') || '0';
}

function rentShortfallHintText(minExtraLamports: number): string {
  return `Please add at least ${formatSolAmountForHint(minExtraLamports / LAMPORTS_PER_SOL)} SOL to continue`;
}


// Calculate new node position
const calculateNewNodePosition = (existingNodes: CanvasNode[], gridSpacing: number) => {
  // If canvas is empty, return default position (left upper visible range)
  if (existingNodes.length === 0) {
    return {
      x: snapToGrid(400, gridSpacing),
      y: snapToGrid(300, gridSpacing)    };
  }

  // Find the rightmost node
  const rightmostNode = existingNodes.reduce((max, node) =>
    node.x > max.x ? node : max
    , existingNodes[0]);

  // Create new node to the right of the rightmost node
  return {
    x: rightmostNode.x + gridSpacing,
    y: rightmostNode.y
  };
};

// DeFi Protocol Node Categories for PinTool POC
const DEFI_NODE_CATEGORIES: NodeCategory[] = [
  {
    name: "Price Feed",
    color: "#F59E0B",
    nodes: [
      {
        id: "pyth-price-feed",
        label: "Pyth Price Feed",
        icon: "📊",
        protocol: "Pyth Network",
      },
      {
        id: "binance-price-feed",
        label: "Binance Price Feed",
        icon: "📊",
        protocol: "Binance",
      },
    ],
  },
  {
    name: "Staking",
    color: "#10B981",
    nodes: [
      {
        id: "marinade-stake",
        label: "Marinade Stake",
        icon: "🥩",
        protocol: "Marinade Finance",
      },
      {
        id: "marinade-unstake",
        label: "Marinade Unstake",
        icon: "🔓",
        protocol: "Marinade Finance",
      },
    ],
  },
  {
    name: "DEX",
    color: "#3B82F6",
    nodes: [
      {
        id: "jupiter-swap",
        label: "Jupiter Swap",
        icon: "🔄",
        protocol: "Jupiter",
      },
    ],
  },
  {
    name: "Lending",
    color: "#8B5CF6",
    nodes: [
      {
        id: "kamino-deposit",
        label: "Kamino Deposit",
        icon: "🏦",
        protocol: "Kamino",
      },
    ],
  },
  {
    name: "Logic",
    color: "#EF4444",
    nodes: [
      { id: "if-else", label: "If/Else", icon: "🔀", protocol: "Core Logic" },
    ],
  },
  {
    name: "Notification",
    color: "#6366F1",
    nodes: [
      {
        id: "telegram-notify",
        label: "Telegram",
        icon: "📱",
        protocol: "Telegram",
      },
      {
        id: "discord-notify",
        label: "Discord",
        icon: "💬",
        protocol: "Discord",
      },
    ],
  },
];

// Empty workflow - no default nodes
const SOL_HEDGING_WORKFLOW: CanvasNode[] = [];

// Empty connections - no default connections
const SOL_HEDGING_CONNECTIONS: Connection[] = [];

interface WorkflowBuilderProps {
  initialNodes?: CanvasNode[];
  initialConnections?: Connection[];
  nodeCategories?: NodeCategory[];
  onSave?: (nodes: CanvasNode[], connections: Connection[]) => void;
  onPublish?: (nodes: CanvasNode[], connections: Connection[]) => void;
}

export default function WorkflowBuilder({
  initialNodes = SOL_HEDGING_WORKFLOW,
  initialConnections = SOL_HEDGING_CONNECTIONS,
  nodeCategories = DEFI_NODE_CATEGORIES,
  onPublish,
}: WorkflowBuilderProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { showToast } = useToast();
  const wallet = useWallet();
  const { connection: solanaConnection } = useConnection();
  const {
    isAuthenticated,
    accessToken,
    walletAddress,
    accounts,
    canvases,
    canvasesLoaded,
    getBusinessSignature,
    refreshAccounts,
    refreshCanvases,
  } = useAuth();

  const canAccessCanvas = isAuthenticated;
  const [nodes, setNodes] = useState<CanvasNode[]>(initialNodes);
  const [connections, setConnections] = useState<Connection[]>(initialConnections);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showConfigPanel, setShowConfigPanel] = useState<boolean>(false);
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [showDeployOverlay, setShowDeployOverlay] = useState(false);
  const [deployStep, setDeployStep] = useState<1 | 2>(1);
  const [deployName, setDeployName] = useState('');
  const [deployBalance, setDeployBalance] = useState<number | null>(null);
  const [deployShowAddFunds, setDeployShowAddFunds] = useState(false);
  const [deployFundAmount, setDeployFundAmount] = useState('');
  const [isAddingFunds, setIsAddingFunds] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deploySuccess, setDeploySuccess] = useState(false);
  /** Whether Step 2 funded SOL; selects the funded or activation success view. */
  const [deploySuccessFunded, setDeploySuccessFunded] = useState(false);
  const [deploySuccessBalanceSol, setDeploySuccessBalanceSol] = useState(0);
  const [deploySuccessUsdApprox, setDeploySuccessUsdApprox] = useState(0);
  const [postSuccessFundInput, setPostSuccessFundInput] = useState('');
  /** Rent-exemption error below the amount input; Figma 620:31892 / 620:32237. */
  const [deployFundRentError, setDeployFundRentError] = useState<string | null>(null);
  const [postSuccessFundRentError, setPostSuccessFundRentError] = useState<string | null>(null);
  const [deployStep2MinRentLamports, setDeployStep2MinRentLamports] = useState<number | null>(null);
  const deployStep2RentSeqRef = useRef(0);
  const postSuccessRentSeqRef = useRef(0);
  const postSuccessFundInputRef = useRef<HTMLInputElement>(null);
  /** An Add Funds onchain transfer is pending after deployment. */
  const [postSuccessFunding, setPostSuccessFunding] = useState(false);
  /** An Activate Strategy accounts.status update is pending. */
  const [postSuccessActivating, setPostSuccessActivating] = useState(false);
  /** Show deployment errors in a modal instead of a toast. */
  const [deployErrorMessage, setDeployErrorMessage] = useState<string | null>(null);
  const [isLoadingWorkflows, setIsLoadingWorkflows] = useState(false);
  /** Figma 596:16129 / 596:16348: require the exact tab label before closing. */
  const [closeCanvasTargetId, setCloseCanvasTargetId] = useState<string | null>(null);
  const [closeCanvasInput, setCloseCanvasInput] = useState('');
  const [closeCanvasRemoving, setCloseCanvasRemoving] = useState(false);
  /** A successful Step 5 transfer and nonzero onchain balance show the redirect view after 1.5 seconds, then navigate to /workflows. */
  const [deployAutoRedirectToWorkflows, setDeployAutoRedirectToWorkflows] = useState(false);
  /** Funded success screen transitions to redirect; Figma 576:14299. */
  const [deployFundedUiPhase, setDeployFundedUiPhase] = useState<'success' | 'redirect'>('success');
  const deployFundedNavTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deployFundedNavTimer2Ref = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDeployFundedAutoNavTimers = useCallback(() => {
    if (deployFundedNavTimerRef.current) {
      clearTimeout(deployFundedNavTimerRef.current);
      deployFundedNavTimerRef.current = null;
    }
    if (deployFundedNavTimer2Ref.current) {
      clearTimeout(deployFundedNavTimer2Ref.current);
      deployFundedNavTimer2Ref.current = null;
    }
    setDeployAutoRedirectToWorkflows(false);
    setDeployFundedUiPhase('success');
  }, []);

  // Workflow tabs state
  const DEFAULT_TAB: WorkflowTab = { id: 'tab-new-default', name: 'PinTool 1', isNew: true };
  const [workflowTabs, setWorkflowTabs] = useState<WorkflowTab[]>([DEFAULT_TAB]);
  const [activeTabId, setActiveTabId] = useState(DEFAULT_TAB.id);
  // Track tabs explicitly created by user via "+" button (not the initial default)
  const userCreatedNewTabsRef = useRef<Set<string>>(new Set());

  // Store nodes and connections per tab (use ref for immediate access)
  const tabDataRef = useRef<Record<string, { nodes: CanvasNode[]; connections: Connection[] }>>({});
  const hasAutoCreatedRef = useRef(false);

  // Clear all canvas state on sign-out.
  useEffect(() => {
    if (!isAuthenticated) {
      setWorkflowTabs([DEFAULT_TAB]);
      setActiveTabId(DEFAULT_TAB.id);
      setNodes([]);
      setConnections([]);
      setSelectedNodeId(null);
      setShowConfigPanel(false);
      setShowDeployOverlay(false);
      setIsLoadingWorkflows(false);
      tabDataRef.current = {};
      userCreatedNewTabsRef.current.clear();
      hasAutoCreatedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  // After sign-in, create the first draft only when the database has no canvases.
  useEffect(() => {
    if (!canAccessCanvas || !walletAddress || !canvasesLoaded || canvases.length > 0 || hasAutoCreatedRef.current) return;
    hasAutoCreatedRef.current = true;
    (async () => {
      try {
        const newCanvas = await createCanvas(walletAddress, DEFAULT_TAB.name);
        const newId = newCanvas.id!;
        tabDataRef.current[newId] = { nodes: [], connections: [] };
        setWorkflowTabs([{ id: newId, name: DEFAULT_TAB.name, isNew: false }]);
        setActiveTabId(newId);
        setNodes([]);
        setConnections([]);
        await refreshCanvases();
      } catch (err) {
        console.warn('Failed to auto-create first canvas:', err);
      }
    })();
  }, [canAccessCanvas, walletAddress, canvasesLoaded, canvases.length, refreshCanvases]);

  // After sign-in, synchronize tabs, load definitions and handle the tab query parameter.
  useEffect(() => {
    if (!canAccessCanvas) return;
    if (canvases.length === 0) return;

    // Remove tab data for canvases that no longer exist.
    const existingCanvasIds = new Set(canvases.map(c => c.id!));
    for (const key of Object.keys(tabDataRef.current)) {
      if (!existingCanvasIds.has(key) && !userCreatedNewTabsRef.current.has(key)) {
        delete tabDataRef.current[key];
      }
    }

    const canvasTabs: WorkflowTab[] = canvases.map(c => ({
      id: c.id!,
      name: c.name,
      isNew: false,
    }));

    // Retain manually created, unsaved tabs in the local fallback.
    for (const tabId of userCreatedNewTabsRef.current) {
      if (!existingCanvasIds.has(tabId)) {
        const tab = workflowTabs.find(t => t.id === tabId && t.isNew);
        if (tab) canvasTabs.push(tab);
      }
    }

    setWorkflowTabs(canvasTabs);

    const tabParam = searchParams.get('tab');
    const tabIds = canvasTabs.map(t => t.id);
    let targetTabId: string;

    if (tabParam && tabIds.includes(tabParam)) {
      targetTabId = tabParam;
      router.replace('/', { scroll: false });
    } else if (!tabIds.includes(activeTabId)) {
      targetTabId = canvasTabs[0]?.id || activeTabId;
    } else {
      targetTabId = activeTabId;
    }

    setActiveTabId(targetTabId);

    // Load each canvas definition into tabDataRef.
    const canvasesToLoad = canvases.filter(
      c => c.id && !(tabDataRef.current[c.id]?.nodes.length > 0)
    );

    if (canvasesToLoad.length > 0) {
      setIsLoadingWorkflows(true);
      const loadCanvasData = async () => {
        try {
          for (const c of canvasesToLoad) {
            const def = c.definition as { nodes?: CanvasNode[]; connections?: Connection[] } | null;
            const loadedNodes = def?.nodes || [];
            const loadedConnections = def?.connections || [];
            tabDataRef.current[c.id!] = { nodes: loadedNodes, connections: loadedConnections };

            if (c.id === targetTabId) {
              setNodes(loadedNodes);
              setConnections(loadedConnections);
            }
          }
        } finally {
          setIsLoadingWorkflows(false);
        }
      };
      loadCanvasData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAccessCanvas, canvases, walletAddress, searchParams]);

  // Get the selected node object
  const selectedNode = selectedNodeId
    ? nodes.find((n) => n.id === selectedNodeId) || null
    : null;

  // Handle node selection from canvas
  const handleNodeSelect = useCallback((nodeId: string) => {
    // If clicking the same node that's already selected, toggle the config panel
    if (selectedNodeId === nodeId && showConfigPanel) {
      setShowConfigPanel(false);
      setSelectedNodeId(null);
    } else {
      setSelectedNodeId(nodeId);
      setShowConfigPanel(true);
    }
  }, [selectedNodeId, showConfigPanel]);

  // Handle closing config panel
  const handleCloseConfigPanel = useCallback(() => {
    setShowConfigPanel(false);
    setSelectedNodeId(null);
  }, []);

  // Handle node deletion (double click)
  const handleNodeDelete = useCallback((nodeId: string) => {
    setNodes((prev) => prev.filter(node => node.id !== nodeId));
    // Close config panel if the deleted node was selected
    if (selectedNodeId === nodeId) {
      setShowConfigPanel(false);
      setSelectedNodeId(null);
    }
  }, [selectedNodeId]);

  // Handle node drop on canvas
  const handleNodeDrop = useCallback(
    (nodeType: string, x: number, y: number) => {
      // Find the node definition from categories
      const nodeDefinition = nodeCategories
        .flatMap((cat) => cat.nodes)
        .find((node) => node.id === nodeType);

      if (!nodeDefinition) return;

      // Create new node
      const newNode: CanvasNode = {
        id: `node-${Date.now()}`,
        type: nodeType,
        label: nodeDefinition.label,
        icon: nodeDefinition.icon,
        x: x - 45, // Center the node on drop position (90px / 2)
        y: y - 38, // Center the node on drop position (76px / 2)
        config: {},
      };

      setNodes((prev) => [...prev, newNode]);
      setSelectedNodeId(newNode.id);
    },
    [nodeCategories]
  );

  // Handle node move with grid snapping and collision detection (insertion logic)
  const handleNodeMove = useCallback((nodeId: string, x: number, y: number) => {
    const gridSpacing = getGridSpacing();
    const snappedX = snapToGrid(x, gridSpacing);
    const snappedY = snapToGrid(y, gridSpacing);

    setNodes((prev) => {
      // Find the node being moved
      const movedNode = prev.find(node => node.id === nodeId);
      if (!movedNode) return prev;

      // Check if there's already a node at the target position
      const nodeAtTarget = prev.find(
        node => node.id !== nodeId && node.x === snappedX && node.y === snappedY
      );

      // If there's a collision, implement insertion logic
      if (nodeAtTarget) {
        const oldX = movedNode.x;
        const newX = snappedX;

        // Get all nodes on the same row (excluding the moved node)
        const nodesOnSameRow = prev
          .filter(node => node.id !== nodeId && node.y === snappedY)
          .sort((a, b) => a.x - b.x);

        // Calculate new positions for all nodes on the row
        const newPositions: Record<string, number> = {};

        if (oldX < newX) {
          // Moving right: shift nodes between oldX and newX to the left
          nodesOnSameRow.forEach(node => {
            if (node.x > oldX && node.x <= newX) {
              newPositions[node.id] = node.x - gridSpacing;
            }
          });
        } else {
          // Moving left: shift nodes between newX and oldX to the right
          nodesOnSameRow.forEach(node => {
            if (node.x >= newX && node.x < oldX) {
              newPositions[node.id] = node.x + gridSpacing;
            }
          });
        }

        // Apply all changes
        return prev.map(node => {
          if (node.id === nodeId) {
            // Move the dragged node to target position
            return { ...node, x: snappedX, y: snappedY };
          } else if (newPositions[node.id] !== undefined) {
            // Shift other nodes
            return { ...node, x: newPositions[node.id] };
          }
          return node;
        });
      }

      // No collision, just move the node
      return prev.map((node) => (node.id === nodeId ? { ...node, x: snappedX, y: snappedY } : node));
    });
  }, []);

  // Handle configuration changes
  const handleConfigChange = useCallback(
    (nodeId: string, config: Record<string, string | number | boolean>) => {
      setNodes((prev) =>
        prev.map((node) => (node.id === nodeId ? { ...node, config } : node))
      );
    },
    []
  );

  // Handle viewport changes
  const handleViewportChange = useCallback((newViewport: { x: number; y: number; zoom: number }) => {
    setViewport(newViewport);
  }, []);

  // Save changed canvas drafts to the canvases table with a two-second debounce.
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!canAccessCanvas || !walletAddress) return;
    // Autosave only database-backed tabs with UUID IDs.
    const isDbCanvas = activeTabId.length === 36 && !activeTabId.startsWith('tab-');
    if (!isDbCanvas) return;

    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(async () => {
      try {
        const activeTab = workflowTabs.find(t => t.id === activeTabId);
        await updateCanvas(activeTabId, walletAddress, {
          name: activeTab?.name,
          nodes,
          connections,
        });
      } catch (err) {
        console.warn('Auto-save failed:', err);
      }
    }, 2000);

    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, connections, activeTabId, canAccessCanvas, walletAddress]);

  // Handle workflow save (currently not used in UI, but available for future use)
  // const handleSave = useCallback(() => {
  //   if (onSave) {
  //     onSave(nodes, connections);
  //   }
  //   console.log("Saving workflow:", { nodes, connections });
  // }, [nodes, connections, onSave]);

  // Crossmint address and Supabase account ID retained after deployment for funding and activation.
  const deployCrossmintAddrRef = useRef<string | null>(null);
  const deployAccountIdRef = useRef<string | null>(null);

  /** Step 2 rent-exemption minimum: a zero wallet balance needs the full minimum rent. */
  useEffect(() => {
    if (!showDeployOverlay || deployStep !== 2) {
      setDeployStep2MinRentLamports(null);
      return;
    }
    let cancelled = false;
    const seq = ++deployStep2RentSeqRef.current;
    (async () => {
      try {
        const min = await solanaConnection.getMinimumBalanceForRentExemption(0);
        if (!cancelled && seq === deployStep2RentSeqRef.current) {
          // Before wallet creation in Step 2, assume zero balance, consistent with getRentTopUpLamports.
          setDeployStep2MinRentLamports(min + RENT_TOP_UP_BUFFER_LAMPORTS);
        }
      } catch {
        if (!cancelled && seq === deployStep2RentSeqRef.current) {
          setDeployStep2MinRentLamports(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showDeployOverlay, deployStep, solanaConnection]);

  useEffect(() => {
    if (!showDeployOverlay || deployStep !== 2) {
      setDeployFundRentError(null);
      return;
    }
    if (deployStep2MinRentLamports == null) {
      return;
    }
    const raw = deployFundAmount.trim();
    if (!raw) {
      setDeployFundRentError(null);
      return;
    }
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) {
      setDeployFundRentError(null);
      return;
    }
    const lamports = Math.round(n * LAMPORTS_PER_SOL);
    if (lamports < deployStep2MinRentLamports) {
      setDeployFundRentError(rentShortfallHintText(deployStep2MinRentLamports));
    } else {
      setDeployFundRentError(null);
    }
  }, [showDeployOverlay, deployStep, deployFundAmount, deployStep2MinRentLamports]);

  /** Validate post-deployment funding against the live Crossmint balance; an empty input preserves the deployment rent hint. */
  useEffect(() => {
    if (!deploySuccess) {
      setPostSuccessFundRentError(null);
      return;
    }
    const raw = postSuccessFundInput.trim();
    if (!raw) {
      return;
    }
    const addr = deployCrossmintAddrRef.current;
    if (!addr) {
      return;
    }
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) {
      return;
    }
    const seq = ++postSuccessRentSeqRef.current;
    let cancelled = false;
    (async () => {
      try {
        const { requiredSendLamports } = await getRentTopUpLamports(solanaConnection, new PublicKey(addr));
        if (cancelled || seq !== postSuccessRentSeqRef.current) {
          return;
        }
        const lamports = Math.round(n * LAMPORTS_PER_SOL);
        if (lamports < requiredSendLamports) {
          setPostSuccessFundRentError(rentShortfallHintText(requiredSendLamports));
        } else {
          setPostSuccessFundRentError(null);
        }
      } catch {
        if (!cancelled && seq === postSuccessRentSeqRef.current) {
          setPostSuccessFundRentError(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deploySuccess, postSuccessFundInput, solanaConnection]);

  // Add Funds transfers SOL from the connected wallet to the Crossmint wallet.
  const handleAddFunds = useCallback(async () => {
    const amount = parseFloat(deployFundAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast('Please enter a valid amount.', 'warning');
      return;
    }
    if (!wallet.connected || !wallet.publicKey) {
      showToast('Please connect your wallet first.', 'warning');
      return;
    }
    const crossmintAddress = deployCrossmintAddrRef.current;
    if (!crossmintAddress) {
      showToast('No Crossmint wallet linked yet. Deploy first, then add funds.', 'warning');
      return;
    }
    const lamportsToSend = Math.round(amount * LAMPORTS_PER_SOL);
    const destPk = new PublicKey(crossmintAddress);
    const { requiredSendLamports } = await getRentTopUpLamports(solanaConnection, destPk);
    if (lamportsToSend < requiredSendLamports) {
      setDeployFundRentError(rentShortfallHintText(requiredSendLamports));
      return;
    }
    setDeployFundRentError(null);
    setIsAddingFunds(true);
    try {
      const { blockhash, lastValidBlockHeight } = await solanaConnection.getLatestBlockhash();
      const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey }).add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: destPk,
          lamports: lamportsToSend,
        })
      );
      const signature = await signAndSendLegacyTransfer(wallet, solanaConnection, tx);
      showToast('Transfer sent. Confirming...', 'info');
      await solanaConnection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      const lamports = await solanaConnection.getBalance(new PublicKey(crossmintAddress));
      setDeployBalance(lamports / LAMPORTS_PER_SOL);
      setDeployFundAmount('');
      setDeployShowAddFunds(false);
      showToast('Funds added successfully!', 'success');
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      if (message.includes('User rejected') || message.includes('rejected')) return;
      showToast(`Transfer failed: ${formatSolTransferError(err)}`, 'error');
    } finally {
      setIsAddingFunds(false);
    }
  }, [deployFundAmount, wallet, showToast, solanaConnection]);

  // Handle workflow publish
  const handlePublish = useCallback(() => {
    clearDeployFundedAutoNavTimers();
    if (onPublish) {
      onPublish(nodes, connections);
    }
    const activeTab = workflowTabs.find(t => t.id === activeTabId);
    setDeployName(activeTab?.name || '');
    setDeployStep(1);
    setDeployBalance(null);
    setDeployShowAddFunds(false);
    setDeployFundAmount('');
    setDeployFundRentError(null);
    setPostSuccessFundRentError(null);
    setShowDeployOverlay(true);
    setDeploySuccess(false);
    setDeploySuccessFunded(false);
    setDeploySuccessBalanceSol(0);
    setDeploySuccessUsdApprox(0);
    setPostSuccessFundInput('');
    setDeployErrorMessage(null);
    setPostSuccessFunding(false);
    setPostSuccessActivating(false);
    setIsDeploying(false);
    deployAccountIdRef.current = null;
    deployCrossmintAddrRef.current = null;
  }, [nodes, connections, onPublish, workflowTabs, activeTabId, clearDeployFundedAutoNavTimers]);

  // Enter Step 2.
  const handleDeployNext = useCallback(() => {
    if (!deployName.trim()) {
      showToast('Please enter a strategy name.', 'warning');
      return;
    }
    setDeployStep(2);
    // Before deployment creates the Crossmint wallet, assume zero balance.
    setDeployBalance(0);
  }, [deployName, showToast]);

  // Flush to the database before selecting another tab.
  const handleTabSelect = useCallback((tabId: string) => {
    if (tabId === activeTabId) return;

    // Save current tab's data to ref
    tabDataRef.current[activeTabId] = { nodes, connections };

    // Flush autosave immediately and cancel the pending timer.
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    const isDbCanvas = activeTabId.length === 36 && !activeTabId.startsWith('tab-');
    if (isDbCanvas && walletAddress) {
      const activeTab = workflowTabs.find(t => t.id === activeTabId);
      updateCanvas(activeTabId, walletAddress, {
        name: activeTab?.name,
        nodes,
        connections,
      }).catch(err => console.warn('Flush save failed:', err));
    }

    // Load the new tab's data
    const newTabData = tabDataRef.current[tabId] || { nodes: [], connections: [] };
    setNodes(newTabData.nodes);
    setConnections(newTabData.connections);
    setActiveTabId(tabId);
    setSelectedNodeId(null);
    setShowConfigPanel(false);
  }, [activeTabId, nodes, connections, walletAddress, workflowTabs]);

  // Persist a local-only tab and return its new canvas ID.
  const persistLocalTab = useCallback(async (tabId: string): Promise<string | null> => {
    if (!walletAddress) return null;
    const isLocal = tabId.startsWith('tab-');
    if (!isLocal) return tabId;

    const tab = workflowTabs.find(t => t.id === tabId);
    const data = tabDataRef.current[tabId] || { nodes: [], connections: [] };
    try {
      const canvas = await createCanvas(walletAddress, tab?.name || 'Untitled', data.nodes, data.connections);
      const newId = canvas.id!;
      tabDataRef.current[newId] = data;
      delete tabDataRef.current[tabId];
      userCreatedNewTabsRef.current.delete(tabId);
      return newId;
    } catch (err) {
      console.warn('Failed to persist local tab:', err);
      return null;
    }
  }, [walletAddress, workflowTabs]);

  // Create a new draft in the database when adding a tab.
  const handleTabAdd = useCallback(async () => {
    tabDataRef.current[activeTabId] = { nodes, connections };

    const newTabNumber = workflowTabs.length + 1;
    const defaultName = `PinTool ${newTabNumber}`;

    if (canAccessCanvas && walletAddress) {
      try {
        // Persist the current local-only tab first.
        await persistLocalTab(activeTabId);

        const newCanvas = await createCanvas(walletAddress, defaultName);
        const newTabId = newCanvas.id!;
        tabDataRef.current[newTabId] = { nodes: [], connections: [] };

        setActiveTabId(newTabId);
        setNodes([]);
        setConnections([]);
        setSelectedNodeId(null);
        setShowConfigPanel(false);
        await refreshCanvases();
        return;
      } catch (err) {
        console.warn('Failed to create canvas in DB, falling back to local tab:', err);
      }
    }

    // Fallback to a local-only tab when signed out or database writes fail.
    const newTabId = `tab-${Date.now()}`;
    userCreatedNewTabsRef.current.add(newTabId);
    tabDataRef.current[newTabId] = { nodes: [], connections: [] };
    setWorkflowTabs((prev) => [...prev, { id: newTabId, name: defaultName, isNew: true }]);
    setActiveTabId(newTabId);
    setNodes([]);
    setConnections([]);
    setSelectedNodeId(null);
    setShowConfigPanel(false);
  }, [workflowTabs.length, activeTabId, nodes, connections, canAccessCanvas, walletAddress, refreshCanvases, persistLocalTab]);

  // Persist tab renames to the database.
  const handleTabRename = useCallback((tabId: string, newName: string) => {
    setWorkflowTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, name: newName, isNew: false } : tab
      )
    );
    const isDbCanvas = tabId.length === 36 && !tabId.startsWith('tab-');
    if (isDbCanvas && walletAddress) {
      updateCanvas(tabId, walletAddress, { name: newName }).catch(err =>
        console.warn('Failed to rename canvas in DB:', err)
      );
    }
  }, [walletAddress]);

  const dismissCloseCanvasModal = useCallback(() => {
    setCloseCanvasTargetId(null);
    setCloseCanvasInput('');
    setCloseCanvasRemoving(false);
  }, []);

  /** The confirmation modal deletes database canvases through deleteCanvas; local tabs update state only. */
  const performCloseCanvasTab = useCallback(
    async (tabId: string): Promise<boolean> => {
      if (workflowTabs.length <= 1) return false;

      const idx = workflowTabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return false;

      const isDbCanvas = tabId.length === 36 && !tabId.startsWith('tab-');
      const closingActive = tabId === activeTabId;

      if (closingActive) {
        if (autoSaveTimerRef.current) {
          clearTimeout(autoSaveTimerRef.current);
          autoSaveTimerRef.current = null;
        }
        tabDataRef.current[activeTabId] = { nodes, connections };
        const flushDb = activeTabId.length === 36 && !activeTabId.startsWith('tab-');
        if (flushDb && walletAddress) {
          const activeTabMeta = workflowTabs.find((t) => t.id === activeTabId);
          try {
            await updateCanvas(activeTabId, walletAddress, {
              name: activeTabMeta?.name,
              nodes,
              connections,
            });
          } catch (err) {
            console.warn('Flush before close failed:', err);
          }
        }
      }

      if (isDbCanvas && walletAddress) {
        try {
          await deleteCanvas(tabId, walletAddress);
          await refreshCanvases();
          return true;
        } catch (err) {
          console.error('Delete canvas failed:', err);
          showToast('Could not delete canvas.', 'error');
          return false;
        }
      }

      const nextLocalId = workflowTabs[idx + 1]?.id ?? workflowTabs[idx - 1]?.id;
      delete tabDataRef.current[tabId];
      userCreatedNewTabsRef.current.delete(tabId);
      setWorkflowTabs((prev) => prev.filter((t) => t.id !== tabId));

      if (closingActive && nextLocalId) {
        const nextData = tabDataRef.current[nextLocalId] || { nodes: [], connections: [] };
        setNodes(nextData.nodes);
        setConnections(nextData.connections);
        setActiveTabId(nextLocalId);
        setSelectedNodeId(null);
        setShowConfigPanel(false);
      }
      return true;
    },
    [workflowTabs, activeTabId, nodes, connections, walletAddress, refreshCanvases, showToast]
  );

  const handleTabCloseRequest = useCallback(
    (tabId: string) => {
      if (workflowTabs.length <= 1) return;
      setCloseCanvasTargetId(tabId);
      setCloseCanvasInput('');
    },
    [workflowTabs.length]
  );

  const handleCloseCanvasConfirm = useCallback(async () => {
    if (!closeCanvasTargetId || closeCanvasRemoving) return;
    const tab = workflowTabs.find((t) => t.id === closeCanvasTargetId);
    if (!tab) {
      dismissCloseCanvasModal();
      return;
    }
    const expected = workflowTabDisplayName(tab);
    if (closeCanvasInput.trim() !== expected.trim()) return;
    setCloseCanvasRemoving(true);
    try {
      const ok = await performCloseCanvasTab(closeCanvasTargetId);
      if (ok) dismissCloseCanvasModal();
    } finally {
      setCloseCanvasRemoving(false);
    }
  }, [
    closeCanvasTargetId,
    closeCanvasInput,
    closeCanvasRemoving,
    workflowTabs,
    performCloseCanvasTab,
    dismissCloseCanvasModal,
  ]);

  // Handle creating nodes from chat (pyth -> jupiter -> kamino)
  const handleCreateNodesFromChat = useCallback(() => {
    const gridSpacing = getGridSpacing();
    let currentX = snapToGrid(400, gridSpacing);
    const currentY = snapToGrid(300, gridSpacing);
    const timestamp = Date.now();

    // Create Pyth Price Feed node
    const pythNode: CanvasNode = {
      id: `node-pyth-${timestamp}`,
      type: 'pyth-price-feed',
      label: 'Pyth Price Feed',
      icon: '📊',
      x: currentX,
      y: currentY,
      config: {
        ticker: 'SOL',
        targetPrice: '200',
        condition: 'above'
      },
    };

    currentX += gridSpacing;

    // Create Jupiter Swap node
    const jupiterNode: CanvasNode = {
      id: `node-jupiter-${timestamp}`,
      type: 'jupiter-swap',
      label: 'Jupiter Swap',
      icon: '🔄',
      x: currentX,
      y: currentY,
      config: {
        sourceToken: 'JitoSOL',
        sourceAmount: 100,
        targetToken: 'USDC',
        targetAmount: 20000,
        slippage: 10,
        priority: 'High',
        rate_SOL: 1,
        rate_JitoSOL: 1.9,
        rate_USDC: 200
      },
    };

    currentX += gridSpacing;

    // Create Marinade Stake node
    const marinadeNode: CanvasNode = {
      id: `node-marinade-${timestamp}`,
      type: 'marinade-stake',
      label: 'Marinade Stake',
      icon: '🥩',
      x: currentX,
      y: currentY,
      config: {
        asset: 'SOL',
        amount: 10,
      },
    };

    // Create connections: pyth -> jupiter -> marinade
    const newConnections: Connection[] = [
      {
        id: `conn-${timestamp}-1`,
        sourceNodeId: pythNode.id,
        targetNodeId: jupiterNode.id,
        sourcePort: 'main',
        targetPort: 'main',
      },
      {
        id: `conn-${timestamp}-2`,
        sourceNodeId: jupiterNode.id,
        targetNodeId: marinadeNode.id,
        sourcePort: 'main',
        targetPort: 'main',
      },
    ];

    // Add all nodes and connections at once
    setNodes((prev) => [...prev, pythNode, jupiterNode, marinadeNode]);
    setConnections((prev) => [...prev, ...newConnections]);
  }, []);

  // Handle adding node from toolbar menu
  const handleAddNode = useCallback((nodeType: string) => {
    // Find the node definition from categories
    const nodeDefinition = nodeCategories
      .flatMap((cat) => cat.nodes)
      .find((node) => node.id === nodeType);

    if (!nodeDefinition) return;

    // Calculate position for new node
    const gridSpacing = getGridSpacing();
    const position = calculateNewNodePosition(nodes, gridSpacing);

    // Set default config based on node type
    let defaultConfig: Record<string, string | number | boolean> = {};

    if (nodeType === 'pyth-price-feed') {
      defaultConfig = {
        ticker: 'SOL',
        targetPrice: '1000',
        condition: 'below'
      };
    } else if (nodeType === 'binance-price-feed') {
      defaultConfig = {
        ticker: 'SOL',
        targetPrice: '1000',
        condition: 'below'
      };
    } else if (nodeType === 'jupiter-swap') {
      defaultConfig = {
        sourceToken: 'SOL',
        sourceAmount: 100,
        targetToken: 'USDC',
        targetAmount: 20000,
        slippage: 10,
        priority: 'High',
        rate_SOL: 1,
        rate_JitoSOL: 1.9,
        rate_USDC: 200
      };
    } else if (nodeType === 'kamino-deposit') {
      defaultConfig = {
        asset: 'USDC',
        pool: 'pool-a',
        amount: 10
      };
    }

    const newNode: CanvasNode = {
      id: `node-${Date.now()}`,
      type: nodeType,
      label: nodeDefinition.label,
      icon: nodeDefinition.icon,
      x: position.x,
      y: position.y,
      config: defaultConfig,
    };

    setNodes((prev) => [...prev, newNode]);
    setSelectedNodeId(newNode.id);
  }, [nodeCategories, nodes]);

  // Deploy: upsert canvas, connect nodes, initialize wallet/account, create workflow, link account and optionally fund.
  const handleConfirmDeployPayment = useCallback(async () => {
    try {
      setIsDeploying(true);
      setDeployErrorMessage(null);
      deployAccountIdRef.current = null;
      deployCrossmintAddrRef.current = null;

      if (!canAccessCanvas || !accessToken || !walletAddress) {
        setDeployErrorMessage('Please sign in and complete invite verification first.');
        setIsDeploying(false);
        return;
      }

      const strategyName = deployName || 'Untitled Workflow';
      /** Snapshot the Step 2 funding amount when Deploy is clicked; preserve it across awaits and loading-state changes. */
      const fundAmountSnapshot = parseFloat(String(deployFundAmount).trim());

      // ── Step 1: upsert canvas ──
      let canvasId: string;
      const isDbCanvas = activeTabId.length === 36 && !activeTabId.startsWith('tab-');

      if (isDbCanvas) {
        await updateCanvas(activeTabId, walletAddress, { name: strategyName, nodes, connections });
        canvasId = activeTabId;
      } else {
        const newCanvas = await createCanvas(walletAddress, strategyName, nodes, connections);
        canvasId = newCanvas.id!;
      }

      // ── Step 2: auto connections ──
      let finalConnections = connections;
      if (connections.length === 0 && nodes.length > 1) {
        const sortedNodes = [...nodes].sort((a, b) => a.x - b.x);
        const autoConnections: Connection[] = [];
        for (let i = 0; i < sortedNodes.length - 1; i++) {
          autoConnections.push({
            id: `conn-auto-${Date.now()}-${i}`,
            sourceNodeId: sortedNodes[i].id,
            targetNodeId: sortedNodes[i + 1].id,
            sourcePort: 'main',
            targetPort: 'main',
          });
        }
        finalConnections = autoConnections;
      }

      // Step 3: initialize the wallet and trading account before binding the workflow definition.
      let accountId: string | null = null;
      let crossmintAddress: string | null = null;

      try {
        const signature = await getBusinessSignature();
        const res = await initWallet(accessToken, walletAddress, signature, strategyName);
        if (res.id) {
          accountId = res.id;
          crossmintAddress = res.crossmint_wallet_address || null;
          deployCrossmintAddrRef.current = crossmintAddress;
          deployAccountIdRef.current = accountId;
        } else {
          setDeployErrorMessage(res.message || 'Failed to create trading account.');
          setIsDeploying(false);
          return;
        }
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('rejected') || message.includes('User rejected')) {
          setIsDeploying(false);
          return;
        }
        setDeployErrorMessage(`Init wallet failed: ${message}`);
        setIsDeploying(false);
        return;
      }

      // Step 4: create the workflow with canvas_id; getActiveAccountId can now bind the existing account.
      let workflowId: string | undefined;
      try {
        const workflowData = await createWorkflow(
          walletAddress,
          strategyName,
          nodes,
          finalConnections,
          undefined,
          canvasId
        );
        workflowId = workflowData.id;
      } catch (e: unknown) {
        const error = e as { code?: string; message?: string };
        if (error?.code === 'DUPLICATE_NAME' || error?.code === '23505') {
          setDeployErrorMessage(error?.message || `Workflow name "${strategyName}" already exists.`);
        } else {
          console.error('Failed to save workflow:', e);
          setDeployErrorMessage(error?.message || 'Failed to save workflow. Please try again.');
        }
        setIsDeploying(false);
        return;
      }

      // Link the account and workflow.
      if (accountId && workflowId) {
        await supabase
          .from('accounts')
          .update({ current_workflow_id: workflowId })
          .eq('id', accountId);
      }

      // The tab is no longer new.
      userCreatedNewTabsRef.current.delete(activeTabId);
      await refreshAccounts();
      await refreshCanvases();

      // Step 5: optionally transfer the amount from deployment Step 2.
      let transferSucceeded = false;
      let postDeployRentMinExtraLamports: number | null = null;
      if (crossmintAddress && Number.isFinite(fundAmountSnapshot) && fundAmountSnapshot > 0) {
        if (!wallet.connected || !wallet.publicKey) {
          showToast(
            'Step 2 deposit was skipped: Solana wallet is not connected. Connect your wallet and use Add Funds below, or run Deploy again.',
            'warning'
          );
        } else {
          try {
            const destPk = new PublicKey(crossmintAddress);
            const lamportsToSend = Math.round(fundAmountSnapshot * LAMPORTS_PER_SOL);
            const { requiredSendLamports } = await getRentTopUpLamports(solanaConnection, destPk);
            if (lamportsToSend < requiredSendLamports) {
              postDeployRentMinExtraLamports = requiredSendLamports;
            } else {
              const { blockhash, lastValidBlockHeight } = await solanaConnection.getLatestBlockhash();
              const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey }).add(
                SystemProgram.transfer({
                  fromPubkey: wallet.publicKey,
                  toPubkey: destPk,
                  lamports: lamportsToSend,
                })
              );
              const sig = await signAndSendLegacyTransfer(wallet, solanaConnection, tx);
              await solanaConnection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
              transferSucceeded = true;
              setDeployFundAmount('');
            }
          } catch (err) {
            if (
              !(err instanceof Error) ||
              (!err.message.includes('rejected') && !err.message.includes('User rejected'))
            ) {
              showToast(`Transfer failed: ${formatSolTransferError(err)}`, 'error');
            }
          }
        }
      }

      // Use the onchain Crossmint balance to determine funding success, not the form amount alone.
      if (transferSucceeded && crossmintAddress) {
        const lamports = await solanaConnection.getBalance(new PublicKey(crossmintAddress));
        const balanceSol = lamports / LAMPORTS_PER_SOL;
        setDeploySuccessBalanceSol(balanceSol);
        setDeploySuccessUsdApprox(Math.round(balanceSol * SOL_USD_DISPLAY_APPROX));
        const funded = balanceSol > 0;
        setDeploySuccessFunded(funded);
        setDeployAutoRedirectToWorkflows(funded);
        setDeployFundedUiPhase('success');
      } else {
        setDeploySuccessBalanceSol(0);
        setDeploySuccessUsdApprox(0);
        setDeploySuccessFunded(false);
        setDeployAutoRedirectToWorkflows(false);
        setDeployFundedUiPhase('success');
      }
      setPostSuccessFundInput('');
      setDeploySuccess(true);
      setIsDeploying(false);
      if (postDeployRentMinExtraLamports !== null) {
        setPostSuccessFundRentError(rentShortfallHintText(postDeployRentMinExtraLamports));
      } else {
        setPostSuccessFundRentError(null);
      }
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      console.error('Deploy failed:', err);
      setDeployErrorMessage(`Deploy failed: ${message}`);
      setIsDeploying(false);
    }
  }, [canAccessCanvas, accessToken, walletAddress, getBusinessSignature, refreshAccounts, refreshCanvases, deployName, deployFundAmount, nodes, connections, showToast, activeTabId, wallet, solanaConnection]);

  /** After deployment, Add Funds transfers SOL from the connected wallet to the newly initialized Crossmint wallet. */
  const handlePostSuccessAddFunds = useCallback(async () => {
    const amount = parseFloat(postSuccessFundInput);
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast('Enter a valid amount.', 'warning');
      return;
    }
    if (!wallet.connected || !wallet.publicKey) {
      showToast('Please connect your wallet first.', 'warning');
      return;
    }
    const crossmintAddress = deployCrossmintAddrRef.current;
    if (!crossmintAddress) {
      showToast('No Crossmint wallet linked.', 'warning');
      return;
    }
    const lamportsToSend = Math.round(amount * LAMPORTS_PER_SOL);
    const destPk = new PublicKey(crossmintAddress);
    const { requiredSendLamports } = await getRentTopUpLamports(solanaConnection, destPk);
    if (lamportsToSend < requiredSendLamports) {
      setPostSuccessFundRentError(rentShortfallHintText(requiredSendLamports));
      return;
    }
    setPostSuccessFundRentError(null);
    setPostSuccessFunding(true);
    try {
      const { blockhash, lastValidBlockHeight } = await solanaConnection.getLatestBlockhash();
      const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey }).add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: destPk,
          lamports: lamportsToSend,
        })
      );
      const signature = await signAndSendLegacyTransfer(wallet, solanaConnection, tx);
      await solanaConnection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      const lamports = await solanaConnection.getBalance(new PublicKey(crossmintAddress));
      const balanceSol = lamports / LAMPORTS_PER_SOL;
      setDeploySuccessBalanceSol(balanceSol);
      setDeploySuccessUsdApprox(Math.round(balanceSol * SOL_USD_DISPLAY_APPROX));
      setDeploySuccessFunded(balanceSol > 0);
      setPostSuccessFundInput('');
      showToast('Funds deposited.', 'success');
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      if (!message.includes('rejected') && !message.includes('User rejected')) {
        showToast(`Transfer failed: ${formatSolTransferError(err)}`, 'error');
      }
    } finally {
      setPostSuccessFunding(false);
    }
  }, [postSuccessFundInput, wallet, showToast, solanaConnection]);

  /**
   * Activate Strategy changes public.accounts.status from inactive to active.
   * Filter by owner_wallet_address and rely on RLS so only the owner can update it.
   */
  const handleActivateStrategyAccount = useCallback(async () => {
    clearDeployFundedAutoNavTimers();
    const accountId = deployAccountIdRef.current;
    if (!accountId || !walletAddress) {
      showToast('Missing trading account. Try deploying again.', 'warning');
      return;
    }
    setPostSuccessActivating(true);
    try {
      const { data, error } = await supabase
        .from('accounts')
        .update({ status: 'active' })
        .eq('id', accountId)
        .eq('owner_wallet_address', walletAddress)
        .select('id')
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        showToast('Could not activate strategy (not found or not your account).', 'error');
        return;
      }

      await refreshAccounts();
      showToast('Strategy activated.', 'success');
      setShowDeployOverlay(false);
      setDeploySuccess(false);
      setDeploySuccessFunded(false);
      setDeploySuccessBalanceSol(0);
      setDeploySuccessUsdApprox(0);
      setPostSuccessFundInput('');
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      console.error('Activate strategy failed:', err);
      showToast(`Could not activate: ${message}`, 'error');
    } finally {
      setPostSuccessActivating(false);
    }
  }, [walletAddress, refreshAccounts, showToast, clearDeployFundedAutoNavTimers]);

  /** After successful deployment funding, show success for 1.5 seconds, then the redirect view and /workflows. */
  useEffect(() => {
    if (!deploySuccess || !deploySuccessFunded || !deployAutoRedirectToWorkflows) {
      return;
    }
    setDeployFundedUiPhase('success');
    deployFundedNavTimerRef.current = setTimeout(() => {
      setDeployFundedUiPhase('redirect');
      deployFundedNavTimer2Ref.current = setTimeout(() => {
        router.push('/workflows');
        setShowDeployOverlay(false);
        setDeploySuccess(false);
        setDeploySuccessFunded(false);
        setDeployAutoRedirectToWorkflows(false);
        setDeployFundedUiPhase('success');
        deployFundedNavTimerRef.current = null;
        deployFundedNavTimer2Ref.current = null;
      }, 400);
    }, 1500);
    return () => {
      if (deployFundedNavTimerRef.current) {
        clearTimeout(deployFundedNavTimerRef.current);
        deployFundedNavTimerRef.current = null;
      }
      if (deployFundedNavTimer2Ref.current) {
        clearTimeout(deployFundedNavTimer2Ref.current);
        deployFundedNavTimer2Ref.current = null;
      }
    };
  }, [deploySuccess, deploySuccessFunded, deployAutoRedirectToWorkflows, router]);

  useEffect(() => {
    if (
      closeCanvasTargetId &&
      !workflowTabs.some((t) => t.id === closeCanvasTargetId)
    ) {
      dismissCloseCanvasModal();
    }
  }, [closeCanvasTargetId, workflowTabs, dismissCloseCanvasModal]);

  const closeCanvasTargetTab =
    closeCanvasTargetId === null
      ? null
      : workflowTabs.find((t) => t.id === closeCanvasTargetId) ?? null;
  const closeCanvasExpectedName = closeCanvasTargetTab
    ? workflowTabDisplayName(closeCanvasTargetTab)
    : '';
  const canConfirmCloseCanvas =
    closeCanvasExpectedName.length > 0 &&
    closeCanvasInput.trim() === closeCanvasExpectedName.trim();

  return (
    <div className={styles.workflowBuilder}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <img
            src="/pintoolLogo.svg"
            alt="PinTool"
            className={styles.logoImage}
            onClick={() => router.push('/')}
          />
        </div>
        <div className={styles.toolbarRight}>
          <SignInButton />
        </div>
      </div>

      {/* Show workflow tabs only after sign-in. */}
      {canAccessCanvas && (
        <WorkflowTabs
          tabs={workflowTabs}
          activeTabId={activeTabId}
          onTabSelect={handleTabSelect}
          onTabAdd={handleTabAdd}
          onTabRename={handleTabRename}
          onTabCloseRequest={handleTabCloseRequest}
        />
      )}

      {/* Do not mount the canvas while signed out. */}
      <div className={styles.workspace}>
        {canAccessCanvas && (isLoadingWorkflows || !canvasesLoaded) && (
          <div className={styles.loadingOverlay}>
            <img src="/loading.svg" alt="Loading" className={styles.loadingSpinner} />
            <div className={styles.loadingText}>Loading...</div>
          </div>
        )}
        {canAccessCanvas ? (
          <>
            <WorkflowCanvas
              nodes={nodes}
              connections={connections}
              selectedNodeId={selectedNodeId}
              onNodeSelect={handleNodeSelect}
              onNodeDelete={handleNodeDelete}
              onNodeDrop={handleNodeDrop}
              onNodeMove={handleNodeMove}
              onViewportChange={handleViewportChange}
              onCreateNodesFromChat={handleCreateNodesFromChat}
              onAddNode={handleAddNode}
              onPlayClick={handlePublish}
            />

            {showConfigPanel && (
              <ConfigPanel
                selectedNode={selectedNode}
                onConfigChange={handleConfigChange}
                onClose={handleCloseConfigPanel}
                viewport={viewport}
              />
            )}
          </>
        ) : (
          <div className={styles.canvasGate} aria-hidden="true" />
        )}
      </div>
      {showDeployOverlay && (
        <div className={styles.deployOverlay}>
          <div
            className={`${styles.deployModal} ${deploySuccess || deployErrorMessage || isDeploying ? styles.deployModalOutcome : ''}`}
          >
            {deployErrorMessage ? (
              <>
                <div className={styles.deployResultHeader}>
                  <div className={styles.deployResultTitleFail}>Failed!</div>
                  <p className={styles.deployResultSub}>
                    We couldn&apos;t activate your strategy.
                  </p>
                </div>
                <div className={styles.deployErrorReasonBlock}>
                  <div className={styles.deployErrorReasonLabel}>Reason:</div>
                  <div className={styles.deployErrorReasonText}>{deployErrorMessage}</div>
                </div>
                <div className={styles.deployActions}>
                  <Secondary
                    type="button"
                    className={styles.deployActionGrow}
                    fullWidth
                    onClick={() => window.open('https://t.me/pintoolfam', '_blank', 'noopener,noreferrer')}
                  >
                    Support
                  </Secondary>
                  <Primary
                    type="button"
                    className={styles.deployActionGrow}
                    fullWidth
                    onClick={() => {
                      setDeployErrorMessage(null);
                      setShowDeployOverlay(false);
                    }}
                  >
                    Fix Now
                  </Primary>
                </div>
              </>
            ) : isDeploying ? (
                /* Deploying: Figma 589:15352 Active/Variant6. */
                <div
                  className={styles.deployDeployingWrap}
                  aria-busy="true"
                  aria-live="polite"
                >
                  <div className={styles.deployDeployingHead}>
                    <div className={styles.deployResultTitleOk}>Active Ready!</div>
                    <div className={styles.deployDeployingStatusRow}>
                      <img
                        src="/loading.svg"
                        alt=""
                        className={styles.deployDeployingSpinner}
                        aria-hidden
                      />
                      <p className={styles.deployDeployingStatusText}>Strategy is being established...</p>
                    </div>
                  </div>
                  <div className={styles.deployDeployingNote} role="status">
                    <span className={styles.deployDeployingNoteStar} aria-hidden>
                      *
                    </span>
                    <span className={styles.deployDeployingNoteText}>Do not close this window</span>
                  </div>
                </div>
              ) : deploySuccess ? (
                deploySuccessFunded ? (
                  deployFundedUiPhase === 'redirect' ? (
                    /* Figma 576:14299: redirect to Portfolio. */
                    <div className={styles.deployPortfolioRedirectWrap}>
                      <div className={styles.deployPortfolioRedirectHead}>
                        <div className={styles.deployPortfolioRedirectTitle}>Active!</div>
                        <div className={styles.deployPortfolioRedirectStatusRow}>
                          <img
                            src="/loading.svg"
                            alt=""
                            className={styles.deployPortfolioRedirectSpinner}
                            aria-hidden
                          />
                          <p className={styles.deployPortfolioRedirectStatusText}>
                            Redirecting to your portfolio...
                          </p>
                        </div>
                      </div>
                      <div className={styles.deployPortfolioRedirectActions}>
                        <Secondary
                          type="button"
                          className={styles.deployActionGrow}
                          fullWidth
                          onClick={() => {
                            clearDeployFundedAutoNavTimers();
                            router.push('/workflows');
                          }}
                        >
                          Portfolio
                        </Secondary>
                      </div>
                    </div>
                  ) : (
                    /* Successful and funded: Portfolio and Activate Strategy with a fixed-width primary action. */
                    <>
                      <div className={styles.deployResultHeader}>
                        <div className={styles.deployResultTitleOk}>Successful!</div>
                        <p className={styles.deployResultSub}>
                          Your strategy is ready, let&apos;s add funds and activate strategy.
                        </p>
                      </div>
                      <div className={styles.deployOutcomeBalanceRow}>
                        <span className={styles.deployOutcomeBalanceLabel}>Balance:</span>
                        <span className={styles.deployOutcomeBalanceSol}>
                          {deploySuccessBalanceSol.toFixed(1)}
                        </span>
                        <span className={styles.deployOutcomeBalanceUnit}>SOL</span>
                        <span className={styles.deployOutcomeApprox}>
                          <span aria-hidden>≈</span>
                          <span>{deploySuccessUsdApprox}</span>
                          <span>USD</span>
                        </span>
                      </div>
                      <div className={styles.deploySuccessTopActions}>
                        <Secondary
                          type="button"
                          className={styles.deployActionGrow}
                          fullWidth
                          onClick={() => {
                            clearDeployFundedAutoNavTimers();
                            router.push('/workflows');
                          }}
                        >
                          Portfolio
                        </Secondary>
                        <Primary
                          type="button"
                          className={styles.deployActivatePrimary169}
                          fullWidth
                          disabled={postSuccessActivating}
                          onClick={handleActivateStrategyAccount}
                        >
                          {postSuccessActivating ? 'Activating…' : 'Activate Strategy'}
                        </Primary>
                      </div>
                    </>
                  )
                ) : (
                  /* Successful but unfunded: allow the funding form to expand. */
                  <>
                        <div className={styles.deployResultHeader}>
                          <div className={styles.deployResultTitleOk}>Successful!</div>
                          <p className={styles.deployResultSub}>
                            Your strategy is ready, let&apos;s add funds and activate strategy.
                          </p>
                        </div>
                        <div className={styles.deployOutcomeBalanceRow}>
                          <span className={styles.deployOutcomeBalanceLabel}>Balance:</span>
                          <span className={styles.deployOutcomeBalanceSol}>
                            {deploySuccessBalanceSol.toFixed(1)}
                          </span>
                          <span className={styles.deployOutcomeBalanceUnit}>SOL</span>
                          <span className={styles.deployOutcomeApprox}>
                            <span aria-hidden>≈</span>
                            <span>{deploySuccessUsdApprox}</span>
                            <span>USD</span>
                          </span>
                        </div>
                        <div className={styles.deploySuccessTopActions}>
                          <Secondary
                            type="button"
                            className={styles.deployActionGrow}
                            fullWidth
                            onClick={() => router.push('/workflows')}
                          >
                            Portfolio
                          </Secondary>
                          {/* Figma 576:14272: Add Funds and Portfolio are clickable Secondary actions; zero balance must still allow funding. */}
                          <Secondary
                            type="button"
                            className={styles.deployActionGrow}
                            fullWidth
                            disabled={postSuccessFunding || postSuccessActivating}
                            onClick={handlePostSuccessAddFunds}
                          >
                            {postSuccessFunding ? 'Sending…' : 'Add Funds'}
                          </Secondary>
                        </div>
                        <div className={styles.deployPostSuccessFundBlock}>
                          <div className={styles.deployFundFieldStack}>
                            <FormInput
                              fullWidth
                              ref={postSuccessFundInputRef}
                              error={!!postSuccessFundRentError}
                              type="number"
                              min={0}
                              step="0.01"
                              placeholder="0.1"
                              value={postSuccessFundInput}
                              onChange={(e) => {
                                const v = e.target.value;
                                setPostSuccessFundInput(v);
                                if (!v.trim()) {
                                  setPostSuccessFundRentError(null);
                                }
                              }}
                              leadingSlot={
                                <img src="/solana.svg" alt="SOL" className={styles.deploySolIcon} />
                              }
                            />
                            {postSuccessFundRentError && (
                              <div className={styles.deployRentHint} role="alert">
                                <span className={styles.deployRentHintStar} aria-hidden>
                                  *
                                </span>
                                <span className={styles.deployRentHintText}>{postSuccessFundRentError}</span>
                              </div>
                            )}
                          </div>
                          <div className={styles.deployPctRow}>
                            {(
                              [
                                { label: '10%', value: '0.1' },
                                { label: '25%', value: '0.25' },
                                { label: '50%', value: '0.5' },
                                { label: '100%', value: '1' },
                              ] as const
                            ).map(({ label, value }) => (
                              <Secondary
                                key={label}
                                type="button"
                                className={styles.deployPctSecondary}
                                onClick={() => setPostSuccessFundInput(value)}
                              >
                                {label}
                              </Secondary>
                            ))}
                          </div>
                        </div>
                        <div className={styles.deployActivateOnlyRow}>
                          <Primary
                            type="button"
                            className={styles.deployActionGrow}
                            fullWidth
                            disabled={postSuccessActivating || postSuccessFunding}
                            onClick={handleActivateStrategyAccount}
                          >
                            {postSuccessActivating ? 'Activating…' : 'Activate Strategy'}
                          </Primary>
                        </div>
                      </>
                    )
                ) : deployStep === 1 ? (
                /* Step 1: choose a name. */
                <>
                    <div className={styles.deployModalTitle}>Set Strategy Name</div>
                    <FormInput
                      fullWidth
                      placeholder="Name this strategy"
                      value={deployName}
                      onChange={(e) => {
                        const newName = e.target.value;
                        setDeployName(newName);
                        setWorkflowTabs(prev =>
                          prev.map(tab =>
                            tab.id === activeTabId ? { ...tab, name: newName, isNew: false } : tab
                          )
                        );
                      }}
                    />
                    <div className={styles.deployHelperSection}>
                      <div className={styles.deployWarningBox}>
                        <div className={styles.deployWarningDot} />
                        <div className={styles.deployWarningText}>
                          This strategy may execute frequently once activated.
                        </div>
                      </div>
                      <div className={styles.deployNoteRow}>
                        <div className={styles.deployNoteAsteriskCol}>
                          <div className={styles.deployNoteAsterisk}>*</div>
                          <div className={styles.deployNoteAsteriskInvisible}>*</div>
                        </div>
                        <div className={styles.deployNoteText}>
                          Deploy and Activate are two steps, funds can be added now or later.
                        </div>
                      </div>
                    </div>
                    <div className={styles.deployActions}>
                        <Secondary
                          className={styles.deployActionGrow}
                          fullWidth
                          onClick={() => setShowDeployOverlay(false)}
                        >
                        Cancel
                        </Secondary>
                        <Primary
                          className={styles.deployActionGrow}
                          fullWidth
                          onClick={handleDeployNext}
                          disabled={!deployName.trim()}
                        >
                        Next
                        </Primary>
                    </div>
              </>
            ) : (
                    /* ── Step 2：Deploy Ready ── */
              <>
                      <div className={styles.deployModalTitle}>Deploy Ready!</div>

                      {/* Show the strategy name read-only with a subtle border. */}
                      <div className={styles.deployNameField}>
                        <span className={styles.deployNameReadonly}>{deployName}</span>
                      </div>

                      {/* Add Funds + Fee */}
                      <div className={styles.deployStep2Section}>
                        <div className={styles.deployFundFieldStack}>
                          <FormInput
                            fullWidth
                            error={!!deployFundRentError}
                            type="number"
                            min={0}
                            step="0.01"
                            placeholder="0.1"
                            value={deployFundAmount}
                            onChange={e => setDeployFundAmount(e.target.value)}
                            leadingSlot={
                              <img src="/solana.svg" alt="SOL" className={styles.deploySolIcon} />
                            }
                          />
                          {deployFundRentError && (
                            <div className={styles.deployRentHint} role="alert">
                              <span className={styles.deployRentHintStar} aria-hidden>
                                *
                              </span>
                              <span className={styles.deployRentHintText}>{deployFundRentError}</span>
                            </div>
                          )}
                        </div>
                        <div className={styles.deployFeeRow}>
                          <span className={styles.deployFeeLabel}>Deploy Fee</span>
                          <div className={styles.deployFeeValues}>
                            <div className={styles.deployFeeStrike}>
                              <span>0.5</span>
                              <span>SOL</span>
                            </div>
                            <div className={styles.deployFeeActual}>
                              <span>0.0</span>
                              <span>SOL</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Warning. */}
                      <div className={styles.deployHelperSection}>
                        <div className={styles.deployWarningBox}>
                          <div className={styles.deployWarningDot} />
                          <div className={styles.deployWarningText}>
                            This strategy may execute frequently once activated.
                          </div>
                        </div>
                        <div className={styles.deployNoteRow}>
                          <div className={styles.deployNoteAsteriskCol}>
                            <div className={styles.deployNoteAsterisk}>*</div>
                            <div className={styles.deployNoteAsteriskInvisible}>*</div>
                          </div>
                          <div className={styles.deployNoteText}>
                            Deploy and Activate are two steps, funds can be added now or later.
                          </div>
                        </div>
                      </div>

                      <div className={styles.deployActions}>
                          <Secondary
                            className={styles.deployActionGrow}
                            fullWidth
                          onClick={() => setDeployStep(1)}
                        >
                          Back
                          </Secondary>
                          <Primary
                            className={styles.deployActionGrow}
                            fullWidth
                          onClick={handleConfirmDeployPayment}
                        >
                          Deploy
                          </Primary>
                      </div>
              </>
            )}
          </div>
        </div>
      )}

      {closeCanvasTargetId && closeCanvasTargetTab && (
        <div
          className={styles.deployOverlay}
          role="presentation"
          onClick={dismissCloseCanvasModal}
        >
          <div
            className={styles.deployModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-canvas-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.closeCanvasIntro}>
              <div className={styles.deployModalTitle} id="close-canvas-title">
                Close canva
              </div>
              <p className={styles.closeCanvasBody}>
                Close this canvas will immediately remove it from your Dashboard.
              </p>
            </div>
            <div className={styles.closeCanvasConfirmBlock}>
              <p className={styles.closeCanvasConfirmLine}>
                Confirm by typing{' '}
                <span className={styles.closeCanvasHighlightName}>{closeCanvasExpectedName}</span>{' '}
                below.
              </p>
              <FormInput
                fullWidth
                type="text"
                placeholder={closeCanvasExpectedName}
                value={closeCanvasInput}
                onChange={(e) => setCloseCanvasInput(e.target.value)}
                autoComplete="off"
                autoFocus
                disabled={closeCanvasRemoving}
                onKeyDown={(e) => {
                    if (
                      e.key === 'Enter' &&
                      canConfirmCloseCanvas &&
                      !closeCanvasRemoving
                    ) {
                      e.preventDefault();
                      void handleCloseCanvasConfirm();
                    }
                  }}
                />
            </div>
            <div className={styles.deployActions}>
              <Secondary
                type="button"
                className={styles.deployActionGrow}
                fullWidth
                disabled={closeCanvasRemoving}
                onClick={dismissCloseCanvasModal}
              >
                Cancel
              </Secondary>
              <Primary
                type="button"
                variant="accentPink"
                className={styles.deployActionGrow}
                fullWidth
                disabled={!canConfirmCloseCanvas || closeCanvasRemoving}
                onClick={() => void handleCloseCanvasConfirm()}
              >
                {closeCanvasRemoving ? 'Removing…' : 'Remove'}
              </Primary>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
