#!/usr/bin/env node
/**
 * Offline status helper. Presence of a plausible JSON manifest is NOT evidence
 * validation, completion, profitability or authorization to send notifications.
 */
import { readFileSync } from 'node:fs';
import { inspectMilestoneEvidence } from '../lib/milestone-evidence-gate.mjs';

const file = process.argv[2];
if (!file || process.argv.length !== 3) {
  console.error('Usage: node scripts/check-milestone-evidence.mjs <evidence-manifest.json>');
  process.exitCode = 2;
} else {
  try {
    const evidence = JSON.parse(readFileSync(file, 'utf8'));
    const check = inspectMilestoneEvidence(evidence);
    console.log(JSON.stringify({
      status: check.structuralEvidencePresent
        ? 'EVIDENCE_FIELDS_PRESENT_BUT_INDEPENDENT_SOURCE_AUDIT_STILL_REQUIRED'
        : 'MILESTONE_INCOMPLETE_OR_NOT_EVIDENCED',
      notificationAuthorized: false,
      profitabilityDemonstrated: false,
      humanSourceVerificationRequired: true,
      missingEvidence: check.missing,
    }, null, 2));
  } catch (error) {
    console.error('Unable to parse research evidence manifest: ' + String(error.message));
    process.exitCode = 2;
  }
}
