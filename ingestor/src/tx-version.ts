/**
 * The highest Solana transaction version this code asks the RPC for. Asking for less than a transaction uses makes
 * the RPC refuse the whole request -- which is how the wallet history stopped syncing on 2026-09-25, when the
 * first version-1 transactions reached this wallet and every read failed with "Transaction version (1) is not
 * supported". Parsed transactions come back as JSON from the RPC, so reading a newer version needs no new parser.
 */
export const MAX_TX_VERSION = 1;
