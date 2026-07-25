export class DomainError extends Error {
  override readonly name: string = 'DomainError'
}

export class InvalidStateTransitionError extends DomainError {
  override readonly name: string = 'InvalidStateTransitionError'

  constructor(entity: string, from: string, to: string) {
    super(`${entity} cannot transition from ${from} to ${to}`)
  }
}

export class SourceCoverageError extends DomainError {
  override readonly name: string = 'SourceCoverageError'
}
