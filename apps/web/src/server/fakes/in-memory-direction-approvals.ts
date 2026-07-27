import type {
  DirectionApprovalQuery,
  DirectionApprovalRepository,
  PersistedDirectionApproval,
} from '@light-novel-audiobook/application'

/** Process-local fake for the additive direction-confirmation ledger. */
export class InMemoryDirectionApprovalRepository implements DirectionApprovalRepository {
  private readonly records = new Map<string, PersistedDirectionApproval>()

  async findDirectionApproval(
    query: DirectionApprovalQuery,
  ): Promise<PersistedDirectionApproval | undefined> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.jobId === query.jobId &&
          record.bookId === query.bookId &&
          record.scriptSha256 === query.scriptSha256.toLowerCase(),
      )
      .sort((left, right) => {
        const leftKey = `${left.decidedAt}\u0000${left.approvalId}`
        const rightKey = `${right.decidedAt}\u0000${right.approvalId}`
        return leftKey < rightKey ? 1 : leftKey > rightKey ? -1 : 0
      })[0]
  }

  async saveDirectionApproval(approval: PersistedDirectionApproval): Promise<void> {
    this.records.set(approval.approvalId, approval)
  }
}
