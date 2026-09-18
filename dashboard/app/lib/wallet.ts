"use client";

import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { useEffect, useSyncExternalStore } from "react";

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

type SignAndSendFeature = {
  signAndSendTransaction: (
    ...inputs: { account: WalletAccount; chain: string; transaction: Uint8Array }[]
  ) => Promise<{ signature: Uint8Array }[]>;
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += "1";
  }
  return out + digits.reverse().map((d) => B58[d]).join("");
}

/** Whether the remembered address came from an installed wallet that can sign (a pasted address cannot). */
export function canSign(current: { wallet: string | null } | null, available: WalletOption[]): boolean {
  const option = available.find((o) => o.name === current?.wallet);
  return !!option && "solana:signAndSendTransaction" in option.wallet.features;
}

/**
 * Hands unsigned transactions to the wallet, which shows what they do and asks the user to approve. Returns the
 * signatures (base58). Re-connects first to get the account object, and refuses if the wallet is now on a
 * different account than the one the page shows, so a claim can never be signed by the wrong wallet.
 */
export async function signAndSendAll(transactions: Uint8Array[]): Promise<string[]> {
  const current = readStored();
  const option = options.find((o) => o.name === current?.wallet);
  if (!current || !option) throw new Error("Wallet tidak terhubung lewat extension");
  const connect = option.wallet.features["standard:connect"] as ConnectFeature;
  const { accounts } = await connect.connect();
  const account = accounts.find((a) => a.address === current.address);
  if (!account) throw new Error("Akun aktif di wallet berbeda dengan yang dipantau");
  const feature = option.wallet.features["solana:signAndSendTransaction"] as SignAndSendFeature | undefined;
  if (!feature) throw new Error(`${option.name} tidak mendukung pengiriman transaksi`);
  const results = await feature.signAndSendTransaction(
    ...transactions.map((transaction) => ({ account, chain: "solana:mainnet", transaction })),
  );
  return results.map((r) => base58(r.signature));
}

/** ?wallet=<address> opens a wallet without an extension (a link from another device, say). It never replaces a
 * wallet connected through an extension. */
export function useWalletParam(connected: { address: string; wallet: string | null } | null) {
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("wallet");
    if (param && isWalletAddress(param) && !connected?.wallet && connected?.address !== param) watchAddress(param);
  }, [connected]);
}
