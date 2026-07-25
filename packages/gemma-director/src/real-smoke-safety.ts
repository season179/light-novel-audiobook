export interface BrowserBoundaryResult {
  readonly originStatus: 401 | 403
  readonly fetchMetadataStatus: 401 | 403
  readonly accessControlAllowOrigin: null
  readonly slotsIdleBefore: true
  readonly slotsIdleAfter: true
  readonly slotObservedBusy: false
}

function listenerLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function assertOwnedLoopbackListener(
  ssOutput: string,
  pid: number,
  host: string,
  port: number,
): void {
  const lines = listenerLines(ssOutput)
  const expectedAddress = `${host}:${port}`
  if (
    lines.length !== 1 ||
    !lines[0]?.split(/\s+/).includes(expectedAddress) ||
    !lines[0]?.includes(`pid=${pid},`)
  ) {
    throw new Error('Configured smoke endpoint is not the owned loopback llama-server process')
  }
}

export function assertOwnedProcessIdentity(options: {
  readonly expectedExecutable: string
  readonly observedExecutable: string
  readonly expectedArgv: readonly string[]
  readonly observedArgv: readonly string[]
}): void {
  if (options.observedExecutable !== options.expectedExecutable) {
    throw new Error('Owned llama-server executable identity does not match the verified binary')
  }
  if (
    options.observedArgv.length !== options.expectedArgv.length ||
    options.observedArgv.some((value, index) => value !== options.expectedArgv[index])
  ) {
    throw new Error('Owned llama-server command line does not match the verified model/runtime')
  }
}

async function readSlots(
  fetchImplementation: typeof globalThis.fetch,
  origin: string,
  apiKey: string,
): Promise<boolean> {
  const response = await fetchImplementation(`${origin}/slots`, {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok) throw new Error(`Smoke slot probe returned HTTP ${response.status}`)
  const value = (await response.json()) as unknown
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Smoke slot probe returned malformed slots')
  }
  return value.every(
    (slot) =>
      typeof slot === 'object' &&
      slot !== null &&
      (slot as { is_processing?: unknown }).is_processing === false,
  )
}

function isRejected(status: number): status is 401 | 403 {
  return status === 401 || status === 403
}

export async function probeBrowserBoundary(options: {
  readonly fetch?: typeof globalThis.fetch
  readonly origin: string
  readonly apiKey: string
  readonly modelId: string
}): Promise<BrowserBoundaryResult> {
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const slotsIdleBefore = await readSlots(fetchImplementation, options.origin, options.apiKey)
  if (!slotsIdleBefore) throw new Error('Browser boundary probe requires an idle inference slot')
  const body = JSON.stringify({
    model: options.modelId,
    messages: [{ role: 'user', content: 'Synthetic authenticated browser-boundary probe.' }],
    max_tokens: 256,
    stream: false,
  })
  const authorization = `Bearer ${options.apiKey}`
  let requestsSettled = false
  const responsesPromise = Promise.all([
    fetchImplementation(`${options.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        origin: 'https://attacker.invalid',
      },
      body,
    }),
    fetchImplementation(`${options.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'sec-fetch-site': 'cross-site',
      },
      body,
    }),
  ]).finally(() => {
    requestsSettled = true
  })
  let slotObservedBusy = false
  while (!requestsSettled) {
    if (!(await readSlots(fetchImplementation, options.origin, options.apiKey))) {
      slotObservedBusy = true
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2))
  }
  const [originResponse, fetchMetadataResponse] = await responsesPromise
  await Promise.all([originResponse.text(), fetchMetadataResponse.text()])
  const accessControlAllowOrigin =
    originResponse.headers.get('access-control-allow-origin') ??
    fetchMetadataResponse.headers.get('access-control-allow-origin')
  const slotsIdleAfter = await readSlots(fetchImplementation, options.origin, options.apiKey)
  if (
    !isRejected(originResponse.status) ||
    !isRejected(fetchMetadataResponse.status) ||
    accessControlAllowOrigin !== null ||
    slotObservedBusy ||
    !slotsIdleAfter
  ) {
    throw new Error(
      'Authenticated browser Origin/fetch-metadata traffic was not rejected before inference',
    )
  }
  return {
    originStatus: originResponse.status,
    fetchMetadataStatus: fetchMetadataResponse.status,
    accessControlAllowOrigin: null,
    slotsIdleBefore: true,
    slotsIdleAfter: true,
    slotObservedBusy: false,
  }
}
