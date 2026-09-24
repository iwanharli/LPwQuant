"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type Status = { registered: number; required: boolean; signed_in: boolean };

const post = async (path: string, body?: unknown) => {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.detail ?? `HTTP ${res.status}`);
  return json;
};

/** Touch ID login. The passkey lives in the Mac's Secure Enclave: no password travels, and the server only ever
 * stores the public half. */
export default function LoginPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((s: Status) => {
        setStatus(s);
        if (s.signed_in) router.replace("/");
      })
      .catch(() => setError("Server tidak menjawab"));
  }, [router]);

  const run = async (kind: "login" | "register") => {
    setBusy(true);
    setError(null);
    try {
      if (kind === "register") {
        const options = await post("/api/auth/register/options");
        const response = await startRegistration({ optionsJSON: options });
        await post("/api/auth/register/verify", { response, label: navigator.platform || "Perangkat ini" });
      } else {
        const options = await post("/api/auth/login/options");
        const response = await startAuthentication({ optionsJSON: options });
        await post("/api/auth/login/verify", { response });
      }
      router.replace("/");
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Gagal";
      setError(/NotAllowed|abort/i.test(message) ? "Dibatalkan atau Touch ID tidak cocok" : message);
    } finally {
      setBusy(false);
    }
  };

  const first = status?.registered === 0;
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-panel p-6 shadow-[0_24px_64px_rgba(0,0,0,0.5)]">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">
          Quant<span className="text-accent-gradient"> DLMM</span>
        </h1>
        <p className="mt-1 text-sm text-ink-3">
          {status === null
            ? "Memeriksa…"
            : first
              ? "Belum ada perangkat terdaftar. Daftarkan MacBook ini sekali, lalu cukup Touch ID untuk masuk."
              : "Masuk dengan Touch ID di MacBook ini."}
        </p>

        <button
          type="button"
          disabled={busy || status === null}
          onClick={() => void run(first ? "register" : "login")}
          className="btn-accent mt-5 h-11 w-full rounded-xl text-sm font-semibold transition disabled:opacity-50"
        >
          {busy ? "Menunggu Touch ID…" : first ? "Daftarkan perangkat ini" : "Masuk dengan Touch ID"}
        </button>

        {!first && status !== null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("register")}
            className="mt-2 h-9 w-full rounded-xl border border-line text-xs text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
          >
            Tambah perangkat lain (butuh sesi yang sudah masuk)
          </button>
        )}

        {error && <p className="mt-3 rounded-lg border border-critical/30 bg-critical/10 px-3 py-2 text-xs text-ink-2">{error}</p>}

        <p className="mt-4 text-[11px] leading-5 text-ink-3">
          Passkey disimpan di Secure Enclave MacBook-mu. Server hanya menyimpan kunci publiknya, jadi tidak ada
          password yang bisa bocor. Butuh HTTPS dengan nama domain agar Touch ID muncul.
        </p>
      </div>
    </main>
  );
}
