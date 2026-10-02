/**
 * dsh-voice-context — host half.
 *
 * Registers the `/voice-context` channel on the host web server: a
 * browser-trust-fenced POST endpoint carrying the same `client-request` →
 * `server-response` envelope the built-in Connection RPC channels use, so the
 * browser half reaches it through the transport every client shape shares
 * (Web GUI and Desktop/Electron alike).
 *
 * The channel is loopback-only: the user's provider key and the credential-free
 * local backend must never be reachable from another origin.
 *
 * Also mounts the optional `/voice-local` command, which installs and manages
 * the bundled offline backend under `local/funasr`.
 *
 * @module dsh-voice-context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolveConfig, type ResolvedConfig, type VoiceContextConfig } from './config.ts'
import { transcribeAudio } from './transcribe.ts'
import { LocalSttManager } from './local.ts'
import type { TranscribeRequest } from './types.ts'

/** Loader entry identity. */
export const name = 'voice-context'

/** The channel rides the host web server, which must exist before this mounts. */
export const inject: string[] = ['webServer']

/** Route prefix owning every Voice-Context endpoint. */
const CHANNEL = '/voice-context'

/** The single endpoint the browser half calls. */
const TRANSCRIBE_ENDPOINT = 'transcribe'

/** One endpoint path segment (mirrors the built-in RPC channel segment rule). */
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/

/**
 * JSON body cap. The browser sends base64 audio (~1.34x the raw bytes), so this
 * sits above `maxBytes` with envelope headroom.
 */
const BODY_CAP_BYTES = 64 * 1024 * 1024

/** One failed endpoint call in the Connection RPC result vocabulary. */
type RpcError = { code: 'internal' | 'bad-request'; message: string; details: Record<string, unknown> }
type RpcResult = { ok: true; value: unknown } | { ok: false; error: RpcError }

function failed(code: RpcError['code'], message: string, details: Record<string, unknown> = {}): RpcResult {
  return { ok: false, error: { code, message, details } }
}

/**
 * Whether a normalized URL hostname names the local loopback authority.
 * @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
 * @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Loopback trust fence: the Host header must name this machine (DNS-rebinding
 * defense) and any browser marker must be same-origin.
 * @param req - incoming node:http request.
 * @returns true when the request may reach the endpoint.
 */
function isTrustedLoopbackRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** The channel-relative endpoint of a request path, or undefined when it is not one. */
function endpointFromPath(pathname: string): string | undefined {
  if (!pathname.startsWith(`${CHANNEL}/`)) return undefined
  const endpoint = pathname.slice(CHANNEL.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT.test(segment))) {
    return undefined
  }
  return endpoint
}

/** Buffer one request body up to a byte cap. */
async function readBody(req: IncomingMessage, cap: number): Promise<string> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > cap) throw new Error('request body exceeds the channel cap')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Dispatch one decoded endpoint call. */
async function dispatch(
  ctx: Context,
  config: ResolvedConfig,
  endpoint: string,
  payload: unknown,
): Promise<RpcResult> {
  if (endpoint !== TRANSCRIBE_ENDPOINT) return failed('internal', `voice-context: unknown endpoint "${endpoint}"`)
  const args = (payload as { args?: TranscribeRequest } | null | undefined)?.args
  if (args === undefined || args === null || typeof args !== 'object') {
    return failed('internal', 'voice-context: missing transcribe args')
  }
  try {
    return { ok: true, value: await transcribeAudio(ctx, config, args) }
  } catch (error) {
    return failed('internal', error instanceof Error ? error.message : String(error))
  }
}

/**
 * Answer one channel request: fence, parse the envelope, dispatch, respond.
 * @param ctx - owning plugin context.
 * @param config - resolved plugin configuration.
 * @param req - incoming request.
 * @param res - response the handler owns to completion.
 */
async function handleRequest(
  ctx: Context,
  config: ResolvedConfig,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isTrustedLoopbackRequest(req)) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }

  const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
  const endpoint = endpointFromPath(pathname)
  if (req.method !== 'POST') {
    res.writeHead(405)
    res.end('method not allowed')
    return
  }
  if (endpoint === undefined) {
    res.writeHead(404)
    res.end('not found')
    return
  }

  const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    res.writeHead(415)
    res.end('content type must be application/json')
    return
  }

  let envelope: { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
  try {
    envelope = JSON.parse(await readBody(req, BODY_CAP_BYTES)) as typeof envelope
  } catch {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }

  const rpcId = typeof envelope.rpcId === 'string' ? envelope.rpcId : 'invalid-request'
  const result = envelope.type === 'client-request' && envelope.method === endpoint
    ? await dispatch(ctx, config, endpoint, envelope.payload)
    : failed('bad-request', `voice-context: method ${JSON.stringify(String(envelope.method))} does not match endpoint ${JSON.stringify(endpoint)}`, { issues: [] })

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
}

/**
 * Mount the Voice-Context host surface.
 * @param ctx - owning plugin context.
 * @param config - partial Loader entry configuration; defaults apply.
 */
export function apply(ctx: Context, config: VoiceContextConfig = {}): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  const local = new LocalSttManager(resolved)

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: CHANNEL,
      handler: (req, res) => handleRequest(ctx, resolved, req, res),
    }),
    'voice-context: /voice-context channel',
  )

  // The local backend is a host-side capability; the command surfaces it.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'voice-local',
      description: 'manage the local offline speech-to-text backend',
      input: { hint: '[status|install|start|stop]' },
      handler: (invocation: { rawInput: string; signal: AbortSignal }) =>
        local.run(invocation.rawInput, invocation.signal),
    })
  })
}
