export function syntheticOperationalStatus(operationalPassed: boolean): string {
  return `${
    operationalPassed
      ? 'SYNTHETIC OPERATIONAL SMOKE COMPLETE'
      : 'SYNTHETIC OPERATIONAL SMOKE FAILED'
  } — NOT REPRESENTATIVE ACCURACY`
}
