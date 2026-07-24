export {}

const shutdown = new AbortController()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => shutdown.abort())
}

console.log('Audiobook worker ready; no jobs are configured yet.')

const keepAlive = setInterval(() => undefined, 60_000)

await new Promise<void>((resolve) => {
  shutdown.signal.addEventListener(
    'abort',
    () => {
      clearInterval(keepAlive)
      resolve()
    },
    { once: true },
  )
})

console.log('Audiobook worker stopped safely.')
