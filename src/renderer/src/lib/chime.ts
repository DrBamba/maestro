/** Two soft notes on the accent's interval — the completion cue from PLAN.md §3.5. */
export function playChime(): void {
  try {
    const Ctx = window.AudioContext
    const ctx = new Ctx()
    const now = ctx.currentTime
    for (const [index, freq] of [660, 880].entries()) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const start = now + index * 0.11
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.06, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28)
      osc.connect(gain).connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.3)
    }
    setTimeout(() => void ctx.close(), 800)
  } catch {
    // Audio is a nicety; never let it break a state update.
  }
}
