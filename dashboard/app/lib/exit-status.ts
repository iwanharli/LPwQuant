/**
 * One colour rule for how a paper position ended, on every paper tab:
 *   green  = left as planned (its own exit signal or the normal end of its range/time),
 *   amber  = left because conditions changed (fees faded, a breakout, a dead pool, the time limit of a signal exit),
 *   red    = left on a loss rule or because the pool went wrong,
 *   blue   = still running, grey = stopped by us.
 */
export const EXIT_TONE = {
  running: "bg-sky-400/10 text-sky-300",
  planned: "bg-emerald-400/10 text-emerald-300",
  changed: "bg-amber-400/10 text-amber-300",
  loss: "bg-rose-400/10 text-rose-300",
  stopped: "bg-white/[0.06] text-ink-3",
} as const;
