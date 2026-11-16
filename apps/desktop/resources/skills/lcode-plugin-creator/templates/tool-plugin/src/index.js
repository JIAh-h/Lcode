/**
 * Minimal Lcode plugin: one tool.
 *
 * Checklist for the four load-time rules (see references/verification.md):
 *   1. `contributes.tools` in lcode.json lists "hello"          ✓
 *   2. registration happens inside activate()                   ✓
 *   3. nothing long-lived, so the disposer is empty             ✓
 *   4. entry is plain ESM JavaScript                            ✓
 */

/**
 * @param {import('@lcode/plugin-sdk').PluginActivationContext} ctx
 * @param {Record<string, unknown>} config
 */
export async function activate(ctx, config) {
  await ctx.registerTool(
    {
      name: 'hello',
      /*
       * The description decides whether the model ever calls this tool.
       * Say WHEN to use it, not just what it does.
       */
      description:
        'Return a greeting for the given name. Use when the user asks to be greeted by name.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Who to greet' },
        },
        required: ['name'],
      },
      card: 'generic',
    },
    async (args) => {
      const name = typeof args?.name === 'string' && args.name.trim() !== '' ? args.name.trim() : 'world'
      /*
       * Return `{ ok: true, value }` on success and
       * `{ ok: false, error: { code, message } }` on failure.
       * Never throw: a thrown error surfaces to the user as a broken tool.
       */
      return { ok: true, value: { greeting: `Hello, ${name}!` } }
    },
  )

  // Nothing to release. If you add a timer or child process, return a disposer:
  //   const timer = setInterval(poll, 60_000)
  //   return () => clearInterval(timer)
}
