import { parseAbi } from 'viem';

export const ACTIVATION_CHAIN_ID = 11155111;
export const aquaActivationAbi = parseAbi([
  'function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32)',
  'function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)',
]);
