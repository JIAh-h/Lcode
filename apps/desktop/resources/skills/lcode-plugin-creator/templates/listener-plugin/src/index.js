/**
 * Minimal Lcode plugin: an event listener with a long-lived resource.
 *
 * Demonstrates the disposer discipline that the other two templates skip: anything you create
 * must be released, or it survives until the process is killed.
 *
 * Note the `activation.events` entry in lcode.json — a listener plugin declares the events it
 * wants, so it stays dormant until one fires.
 */

/** Keeps the most recent event timestamps in memory, bounded. */
const RECENT_LIMIT = 20

/**
 * @param {import('@lcode/plugin-sdk').PluginActivationContext} ctx
 */
export async function activate(ctx) {
  const recent = []

  /*
   * A listener is registered through `request`. There is no typed `registerListener` helper in
   * the current SDK — this is the documented escape hatch for host methods the typed surface
   * does not cover yet.
   */
  await ctx.request('ctx/registerListener', {
    listenerId: 'acme.session-logger',
    event: 'session/end',
  })

  /*
   * A periodic flush. This is the resource that must be disposed — without the cleanup below it
   * keeps running after the plugin is unloaded.
   */
  const timer = setInterval(() => {
    if (recent.length === 0) return
    // Replace with your own sink; keep the work small and non-throwing.
    console.error('[acme.session-logger] pending events:', recent.length)
  }, 30_000)

  // Timers often keep the Node event loop alive; unref so the plugin process can exit cleanly.
  timer.unref?.()

  /*
   * The disposer. Returned from activate, run on unload.
   *
   * Keep it fast and idempotent: the host terminates the process even if this hangs, but a hang
   * delays teardown of everything else.
   */
  return () => {
    clearInterval(timer)
    recent.length = 0
  }
}
