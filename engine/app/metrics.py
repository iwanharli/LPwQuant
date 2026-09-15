import math
from collections import deque
from dataclasses import dataclass, field


@dataclass
class PriceHistory:
    """Irregularly sampled price series for one pool, bounded by age."""

    points: deque[tuple[int, float]] = field(default_factory=deque)

    def add(self, ts_ms: int, price: float, max_age_ms: int) -> None:
        if not math.isfinite(price) or price <= 0:
            return
        if self.points and ts_ms <= self.points[-1][0]:
            return
        self.points.append((ts_ms, price))
        cutoff = ts_ms - max_age_ms
        while self.points and self.points[0][0] < cutoff:
            self.points.popleft()

    @property
    def last_price(self) -> float | None:
        return self.points[-1][1] if self.points else None

    def _window(self, now_ms: int, window_ms: int) -> list[tuple[int, float]]:
        cutoff = now_ms - window_ms
        return [p for p in self.points if p[0] >= cutoff]

    def change_pct(self, now_ms: int, window_ms: int) -> float | None:
        """Percent change over the window; None until history covers at least half of it."""
        pts = self._window(now_ms, window_ms)
        if len(pts) < 2 or now_ms - pts[0][0] < window_ms / 2:
            return None
        return (pts[-1][1] / pts[0][1] - 1) * 100

    def realized_vol_pct(self, now_ms: int, window_ms: int) -> float | None:
        """sqrt(sum of squared log returns) over the window, in percent. Works with irregular sampling."""
        pts = self._window(now_ms, window_ms)
        if len(pts) < 3:
            return None
        variance = sum(math.log(b[1] / a[1]) ** 2 for a, b in zip(pts, pts[1:]))
        return math.sqrt(variance) * 100
