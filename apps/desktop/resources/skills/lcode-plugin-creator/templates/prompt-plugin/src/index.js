/**
 * Minimal Lcode plugin: a prompt section.
 *
 * Injects standing instructions into the system prompt of every session.
 *
 * Important: `content` is a **static string**. It cannot vary per session, workspace, or time —
 * the protocol only carries a string. If you need per-session text, this is not the mechanism;
 * inject it through a tool result instead.
 */

/** Order placement: base prompt is 0, runtime context 900, time 999. Use >100 to land after persona. */
const ORDER = 500

/**
 * @param {import('@lcode/plugin-sdk').PluginActivationContext} ctx
 * @param {{ rules?: string }} config
 */
export async function activate(ctx, config) {
  const rules = typeof config?.rules === 'string' && config.rules.trim() !== ''
    ? config.rules.trim()
    : 'Answer in the user\'s language, keep responses concise.'

  await ctx.registerPromptSection(
    // Must match an entry in lcode.json -> contributes.promptSections
    'acme-house-rules',
    rules,
    ORDER,
  )

  // The host owns the section's lifetime; nothing to dispose.
}
