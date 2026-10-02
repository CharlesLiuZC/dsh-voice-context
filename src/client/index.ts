/**
 * dsh-voice-context — browser half.
 *
 * Two contributions:
 *  - a mic button in the composer's `conversation.input.left` tool row, which
 *    records an utterance and transcribes it through the host's
 *    `/voice-context` Connection RPC channel;
 *  - a `settings.section` page where the user picks cloud vs. local and types
 *    the STT API key (written through the credentials domain).
 *
 * No import of another plugin's values: the RPC channel and the shared API
 * client both arrive through the `connection` service.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { TranscribeRequest } from '../types.ts'
import { VoiceInput, type VoiceInputInjected } from './VoiceInput.tsx'
import { VoiceSettingsSection, type VoiceSettingsInjected } from './VoiceSettings.tsx'

/** The browser services this plugin consumes. */
export const inject = ['slots', 'connection']

/** Host channel carrying the `transcribe` endpoint. */
const CHANNEL = '/voice-context'

/** One transcription outcome mapped from the RPC result. */
type TranscribeOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string }

/**
 * Client plugin body: contribute the mic control and the settings page.
 * @param ctx - client root context.
 */
export function apply(ctx: {
  get: (name: string) => unknown
  slots: {
    inject: (name: string, register: () => unknown) => unknown
    register: (options: Record<string, unknown>, component: unknown) => unknown
  }
}): void {
  const connection = ctx.get('connection') as ConnectionHandle

  const transcribe = async (request: TranscribeRequest): Promise<TranscribeOutcome> => {
    try {
      const result = await connection.rpc.call(CHANNEL, 'transcribe', { args: request })
      if (!result.ok) return { ok: false, error: result.error.message }
      const value = result.value as { text?: unknown } | null
      return { ok: true, text: typeof value?.text === 'string' ? value.text : '' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'voice-context',
    order: 100,
    inject: (): VoiceInputInjected => ({ transcribe }),
  }, VoiceInput))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'voice-context',
    order: 40,
    label: () => (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')
      ? '语音输入'
      : 'Voice input'),
    inject: (): VoiceSettingsInjected => ({ api: connection.api }),
  }, VoiceSettingsSection))
}
