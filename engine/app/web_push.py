"""Web Push: new pools of newly launched tokens, delivered to browsers and phones even when quant is not open.

Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in .env (created once with `python -m app.web_push keys`). Browsers
subscribe through the dashboard (behind the login); the subscriptions live in push_subscriptions. Every EVERY_S the
engine looks at the screener's new pools and sends one notification per pool whose token is new too, once
(push_sent). Subscriptions the push service reports gone (404/410) are deleted.
"""

import asyncio
import base64
import json
import logging
import os
import sys
from typing import Any, Callable

from . import config  # noqa: F401  (loads .env, where the VAPID keys live)

log = logging.getLogger("web_push")

EVERY_S = 15
MIN_TVL = 500.0
MAX_POOL_AGE_H = 1.0
SUBJECT = "https://lp.kecup.in"


def keys() -> tuple[str, str] | None:
    pub, priv = os.getenv("VAPID_PUBLIC_KEY", "").strip(), os.getenv("VAPID_PRIVATE_KEY", "").strip()
    return (pub, priv) if pub and priv else None


def generate() -> tuple[str, str]:
    """A new VAPID key pair as (public, private), both base64url, the formats browsers and pywebpush take."""
    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid01

    v = Vapid01()
    v.generate_keys()
    pub = v.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    priv = v.private_key.private_numbers().private_value.to_bytes(32, "big")
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()  # noqa: E731
    return b64(pub), b64(priv)


def _send(sub: dict[str, Any], payload: dict[str, Any], private_key: str) -> int:
    """Blocking send; returns the push service's HTTP status (201 ok, 404/410 gone)."""
    from pywebpush import WebPushException, webpush

    try:
        res = webpush(
            subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
            data=json.dumps(payload),
            vapid_private_key=private_key,
            vapid_claims={"sub": SUBJECT},
            ttl=3600,
        )
        return res.status_code
    except WebPushException as err:
        return err.response.status_code if err.response is not None else 0


async def send_all(db, payload: dict[str, Any]) -> tuple[int, int]:
    """Send to every subscription; drop the ones that are gone. Returns (sent, dropped)."""
    k = keys()
    if not k:
        return 0, 0
    sent = dropped = 0
    for sub in await db.fetch("select endpoint, p256dh, auth from push_subscriptions"):
        status = await asyncio.to_thread(_send, dict(sub), payload, k[1])
        if status in (404, 410):
            await db.execute("delete from push_subscriptions where endpoint = $1", sub["endpoint"])
            dropped += 1
        elif 200 <= status < 300:
            sent += 1
        else:
            log.info("push to %s…: HTTP %s", sub["endpoint"][:40], status)
    return sent, dropped


def _status(row: dict[str, Any]) -> str:
    from .alerts import safe_new_pool

    if len(row.get("danger") or []) >= 2:
        return "☠ BERBAHAYA"
    if not row.get("security"):
        return "⏳ Menunggu RugCheck"
    ok, _ = safe_new_pool({**row, "pool_age_hours": min(row.get("pool_age_hours") or 0, 23.9)})
    return "✅ Lolos cek" if ok else "⛔ Tidak lolos"


async def loop(db, rows: Callable[[], dict[str, dict[str, Any]]]) -> None:
    if not keys():
        log.info("web push off (no VAPID keys)")
        return
    from .alerts import token_kind

    first = not await db.fetchval("select 1 from push_sent limit 1")
    while True:
        try:
            fresh = [
                r for r in rows().values()
                if (r.get("pool_age_hours") is not None and r["pool_age_hours"] <= MAX_POOL_AGE_H)
                and (r.get("tvl") or 0) >= MIN_TVL and token_kind(r) == "new"
            ]
            for r in fresh:
                done = await db.fetchval(
                    "insert into push_sent (address, sent_at) values ($1, now()) on conflict do nothing returning 1",
                    r["address"])
                if not done or first:
                    continue  # already announced, or the first look after a restart only learns what exists
                age_min = max(1, round((r.get("pool_age_hours") or 0) * 60))
                tvl = r.get("tvl") or 0
                payload = {
                    "title": f"🐣 Pool token baru: {(r.get('name') or '?').replace('-', '/')}",
                    "body": f"{_status(r)} · TVL ${tvl:,.0f} · dibuat {age_min} mnt lalu",
                    "url": f"/pool/{r['address']}",
                    "tag": r["address"],
                }
                sent, dropped = await send_all(db, payload)
                log.info("push %s: sent %d, dropped %d", r.get("name"), sent, dropped)
            first = False
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("web push round failed")
        await asyncio.sleep(EVERY_S)


if __name__ == "__main__" and sys.argv[1:] == ["keys"]:
    pub, priv = generate()
    print(f"VAPID_PUBLIC_KEY={pub}\nVAPID_PRIVATE_KEY={priv}")
