"use client";

import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { useSyncExternalStore } from "react";

/**
 * Read-only wallet connection through the Wallet Standard, which Jupiter, Phantom, Solflare, Backpack and the other
 * Solana extensions all implement. Only `standard:connect` is used, to learn the public address: this app never
 * asks a wallet to sign anything, so it cannot move funds. The address is remembered in localStorage so the
 * portfolio page opens straight onto it next time.
 */

const STORAGE_KEY = "quant.wallet";

export type WalletOption = { name: string; icon: string; wallet: Wallet };

type ConnectFeature = { connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }> };
type DisconnectFeature = { disconnect: () => Promise<void> };

const isSolana = (w: Wallet) => w.chains.some((c) => c.startsWith("solana:")) && "standard:connect" in w.features;

// Jupiter first: it is the one this app is built around, then whatever else is installed, by name.
const rank = (w: Wallet) => (/jupiter/i.test(w.name) ? 0 : 1);

const NO_OPTIONS: WalletOption[] = []; // stable: a fresh [] per call makes React re-render forever
let options: WalletOption[] = NO_OPTIONS;
let optionsLoaded = false;
const optionListeners = new Set<() => void>();

function loadOptions() {
  if (optionsLoaded || typeof window === "undefined") return;
  optionsLoaded = true;
  const registry = getWallets();
  const refresh = () => {
    options = registry
      .get()
      .filter(isSolana)
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
      .map((wallet) => ({ name: wallet.name, icon: wallet.icon, wallet }));
    optionListeners.forEach((l) => l());
  };
  refresh();
  registry.on("register", refresh);
  registry.on("unregister", refresh);
}

export function useWalletOptions(): WalletOption[] {
  return useSyncExternalStore(
    (listener) => {
      loadOptions();
      optionListeners.add(listener);
      return () => optionListeners.delete(listener);
    },
    () => options,
    () => NO_OPTIONS,
  );
}

type Stored = { address: string; wallet: string | null } | null;
let stored: Stored | undefined;
const addressListeners = new Set<() => void>();

function readStored(): Stored {
  if (stored !== undefined) return stored;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    stored = raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    stored = null;
  }
  return stored;
}

function writeStored(value: Stored) {
  stored = value;
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // private window or blocked storage: the connection just lasts for this page view
  }
  addressListeners.forEach((l) => l());
}

export function useConnectedWallet(): Stored {
  return useSyncExternalStore(
    (listener) => {
      addressListeners.add(listener);
      return () => addressListeners.delete(listener);
    },
    readStored,
    () => null,
  );
}

export async function connectWallet(option: WalletOption): Promise<string> {
  const feature = option.wallet.features["standard:connect"] as ConnectFeature;
  const { accounts } = await feature.connect();
  const account = accounts.find((a) => a.chains.some((c) => c.startsWith("solana:"))) ?? accounts[0];
  if (!account) throw new Error("Wallet tidak memberikan alamat");
  writeStored({ address: account.address, wallet: option.name });
  return account.address;
}

/** For a wallet without the extension on this device: an address typed or pasted in. */
export function watchAddress(address: string) {
  writeStored({ address: address.trim(), wallet: null });
}

export async function disconnectWallet() {
  const current = readStored();
  const option = options.find((o) => o.name === current?.wallet);
  const feature = option?.wallet.features["standard:disconnect"] as DisconnectFeature | undefined;
  writeStored(null);
  await feature?.disconnect().catch(() => undefined);
}

export const isWalletAddress = (value: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim());
