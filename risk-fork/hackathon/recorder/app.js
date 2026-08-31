(() => {
  'use strict';
  const status = document.getElementById('status');
  const root = document.getElementById('records');
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('token') || '';
  history.replaceState(null, '', location.pathname);

  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = String(value ?? 'not recorded');
    return node;
  };
  const row = (label, value, className) => {
    const node = text('p', '', 'row');
    node.append(text('span', `${label}: `, 'label'), text('span', value, className));
    return node;
  };
  const lane = (name, rows) => {
    const section = text('section', '', 'lane');
    section.append(text('h3', name));
    rows.forEach((item) => section.append(row(item[0], item[1], item[2])));
    return section;
  };
  const boundedNumber = (value, unit = '') => (
    Number.isSafeInteger(value) && value >= 0
      ? `${value}${unit ? ` ${unit}` : ''}`
      : 'not recorded'
  );

  const render = (records) => {
    root.replaceChildren();
    records.forEach((record) => {
      const article = text('article', '', 'record');
      article.append(text('h2', `${record.scenario?.id || 'synthetic-run'} — ${record.final_state || record.status || 'unknown'}`));
      const lanes = text('div', '', 'lanes');
      const decision = record.decision || {};
      const lifecycle = record.lifecycle || {};
      const cleanup = record.cleanup || {};
      const receipt = record.demo_receipt || {};
      const limits = record.limits || {};
      const taintedEvidence = record.tainted_output_evidence || {};
      const providerEvidence = record.provider_evidence || {};
      const cleanupTracking = providerEvidence.cleanup_tracking || {};
      const ttlCountdown = providerEvidence.ttl_countdown || {};
      const cost = record.cost || {};
      const attacks = Array.isArray(record.attack_attempts)
        ? record.attack_attempts.map((item) => `${item.attack}:${item.status}`).join(', ')
        : 'not recorded';
      const accepted = record.accepted_typed_result
        ? JSON.stringify(record.accepted_typed_result)
        : 'not recorded';
      const localExecution = record.execution_mode === 'local_reference_protocol_execution';
      const fakeE2BExecution = record.execution_mode === 'fake_e2b_protocol_execution';
      const noIsolationBoundary = record.isolation_boundary === false;
      lanes.append(
        lane('Clean Parent', [
          ['action', record.action_summary],
          ['provider profile', record.provider_profile],
          ['parent state', record.parent_state_hash],
          ['parent before', record.parent_state_hash_before],
          ['parent after', record.parent_state_hash_after],
          ['parent unchanged', record.parent_state_unchanged === true ? 'true' : 'not recorded', record.parent_state_unchanged === true ? 'ok' : 'blocked'],
          ['Savepoint Capsule', record.savepoint_capsule_hash],
          ['savepoint', record.savepoint_status || 'not allocated'],
        ]),
        lane('Policy and Risk Decision', [
          ['level', decision.level],
          ['directive', decision.directive || decision.action],
          ['score', decision.score],
          ['reasons', (decision.reasons || []).join(', ') || 'none'],
          ['classifier', decision.classifier],
          ['classifier version', decision.classifier_version],
        ]),
        lane('Disposable Fork', [
          ['fresh identity', record.fork_identity_hash],
          ['sandbox', record.sandbox_id],
          ['execution', record.execution_mode || 'not executed', localExecution || fakeE2BExecution ? 'ok' : 'blocked'],
          ['provider calls', providerEvidence.provider_calls === 0 ? '0' : 'not recorded', providerEvidence.provider_calls === 0 ? 'ok' : 'blocked'],
          ['simulated SDK events', boundedNumber(record.simulated_sdk_events)],
          ['sandbox timeout', boundedNumber(providerEvidence.timeout_ms, 'ms')],
          ['recorded TTL transition', Number.isSafeInteger(ttlCountdown.start_seconds) && Number.isSafeInteger(ttlCountdown.remaining_seconds) ? `${ttlCountdown.start_seconds}s → ${ttlCountdown.remaining_seconds}s (${ttlCountdown.terminal_reason || 'unknown'})` : 'not recorded'],
          ['MCP transport', providerEvidence.stdio_mcp_transport],
          ['IPv4 status', providerEvidence.ipv4_containment],
          ['IPv6 status', providerEvidence.ipv6_containment],
          ['boundary-evaluated synthetic attack outcomes', attacks],
          ['isolation boundary', noIsolationBoundary ? 'false' : 'not recorded', noIsolationBoundary ? 'ok' : 'blocked'],
          ['taint', record.taint_status || 'not produced'],
          ['tainted evidence status', taintedEvidence.status],
          ['tainted evidence ref', taintedEvidence.evidence_ref],
          ['tainted runner-result hash', taintedEvidence.evidence_hash],
          ['hostile narrative hash', providerEvidence.tainted_narrative_hash],
          ['raw hostile narrative included', providerEvidence.raw_narrative_included === false ? 'false' : 'not recorded', providerEvidence.raw_narrative_included === false ? 'ok' : 'blocked'],
          ['evidence sanitized', taintedEvidence.sanitized === true ? 'true' : 'false', taintedEvidence.sanitized === true ? 'ok' : 'blocked'],
          ['raw tainted output included', taintedEvidence.raw_output_included === true ? 'true' : 'false', taintedEvidence.raw_output_included === true ? 'blocked' : 'ok'],
          ['evidence ref bytes', `${boundedNumber(taintedEvidence.reference_bytes)} / ${boundedNumber(taintedEvidence.max_reference_bytes)}`],
          ['evidence hash bytes', `${boundedNumber(taintedEvidence.hash_bytes)} / ${boundedNumber(taintedEvidence.max_hash_bytes)}`],
          ['lifecycle', (lifecycle.states || []).join(' → ') || 'none'],
        ]),
        lane('Evidence and Cleanup', [
          ['validation', record.validation_status],
          ['accepted typed result', accepted],
          ['destruction request', cleanup.requested],
          ['absence observation', cleanup.absence],
          ['allocation requested', cleanupTracking.allocation_requested === true ? 'true' : 'not recorded', cleanupTracking.allocation_requested === true ? 'ok' : 'blocked'],
          ['sandbox ID observed', cleanupTracking.sandbox_id_observed === true ? 'true' : 'not recorded', cleanupTracking.sandbox_id_observed === true ? 'ok' : 'blocked'],
          ['kill requested', cleanupTracking.kill_requested === true ? 'true' : 'not recorded', cleanupTracking.kill_requested === true ? 'ok' : 'blocked'],
          ['kill acknowledged', cleanupTracking.kill_acknowledged === true ? 'true' : 'not recorded', cleanupTracking.kill_acknowledged === true ? 'ok' : 'blocked'],
          ['running-state queries', boundedNumber(cleanupTracking.running_state_query_count)],
          ['exact metadata/list queries', boundedNumber(cleanupTracking.exact_metadata_list_query_count)],
          ['metadata/list observations', boundedNumber(cleanupTracking.exact_metadata_list_observation_count)],
          ['provider API absence observations', boundedNumber(cleanupTracking.absence_observation_count)],
          ['cleanup unknown', cleanupTracking.cleanup_unknown === false ? 'false' : cleanupTracking.cleanup_unknown === true ? 'true' : 'not recorded', cleanupTracking.cleanup_unknown === false ? 'ok' : 'blocked'],
          ['orphan reconciliation required', cleanupTracking.orphan_reconciliation_required === false ? 'false' : cleanupTracking.orphan_reconciliation_required === true ? 'true' : 'not recorded', cleanupTracking.orphan_reconciliation_required === false ? 'ok' : 'blocked'],
          ['cleanup', cleanup.status, cleanup.status === 'verified' ? 'ok' : 'blocked'],
          ['receipt hash', receipt.demo_receipt_hash],
          ['receipt hash verified', record.receipt_hash_verified === true ? 'true' : 'false', record.receipt_hash_verified === true ? 'ok' : 'blocked'],
          ['receipt binding verified', record.receipt_binding_verified === true ? 'true' : 'false', record.receipt_binding_verified === true ? 'ok' : 'blocked'],
          ['configured vCPU', boundedNumber(cost.vcpu)],
          ['configured memory', boundedNumber(cost.memory_gib, 'GiB')],
          ['maximum runtime', boundedNumber(cost.maximum_seconds, 'seconds')],
          ['observed elapsed', boundedNumber(cost.observed_elapsed_ms, 'ms')],
          ['rate source', cost.posted_rate_snapshot?.source],
          ['two-vCPU rate', Number.isFinite(cost.posted_rate_snapshot?.two_vcpu_usd_per_second) ? `$${cost.posted_rate_snapshot.two_vcpu_usd_per_second.toFixed(7)}/second` : 'not recorded'],
          ['memory rate', Number.isFinite(cost.posted_rate_snapshot?.memory_usd_per_gib_second) ? `$${cost.posted_rate_snapshot.memory_usd_per_gib_second.toFixed(7)}/GiB-second` : 'not recorded'],
          ['maximum estimate', Number.isFinite(cost.estimated_maximum_cost_usd) ? `$${cost.estimated_maximum_cost_usd.toFixed(6)}` : 'not recorded'],
          ['provider-finalized cost', cost.provider_finalized_cost_usd === null ? 'unknown' : cost.provider_finalized_cost_usd],
          ['final', record.final_state, record.final_state === 'prepared_not_committed' ? 'ok' : 'blocked'],
          ['max active runs', boundedNumber(limits.max_active_runs)],
          ['max completed runs before cleanup', boundedNumber(limits.max_completed_runs_before_reset)],
          ['max workspace files', boundedNumber(limits.max_workspace_files)],
          ['max workspace bytes', boundedNumber(limits.max_workspace_bytes, 'bytes')],
          ['max single write', boundedNumber(limits.max_write_bytes, 'bytes')],
          ['max actions', boundedNumber(limits.max_actions)],
          ['fork TTL', boundedNumber(limits.fork_ttl_ms, 'ms')],
          ['execution timeout', boundedNumber(limits.execution_timeout_ms, 'ms')],
          ['max recorder bytes', boundedNumber(limits.max_recorder_bytes, 'bytes')],
          ['max owned-root bytes', boundedNumber(limits.max_root_bytes, 'bytes')],
        ]),
      );
      article.append(lanes);
      root.append(article);
    });
    if (records.length === 0) root.append(text('p', 'No sanitized demo records are present.'));
  };

  if (!token) {
    status.textContent = 'Missing per-run local token.';
    status.className = 'blocked';
    return;
  }
  fetch('/api/records', {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
    .then((response) => {
      if (!response.ok) throw new Error('Local replay authorization failed');
      return response.json();
    })
    .then((payload) => {
      status.textContent = 'Authorized local replay. No external assets or telemetry are used.';
      status.className = 'ok';
      render(payload.records || []);
    })
    .catch((error) => {
      status.textContent = error.message;
      status.className = 'blocked';
    });
})();
