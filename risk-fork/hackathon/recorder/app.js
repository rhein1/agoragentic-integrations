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
      const localExecution = record.execution_mode === 'local_reference_protocol_execution';
      const noIsolationBoundary = record.isolation_boundary === false;
      lanes.append(
        lane('Clean Parent', [
          ['action', record.action_summary],
          ['parent state', record.parent_state_hash],
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
          ['execution', record.execution_mode || 'not executed', localExecution ? 'ok' : 'blocked'],
          ['isolation boundary', noIsolationBoundary ? 'false' : 'not recorded', noIsolationBoundary ? 'ok' : 'blocked'],
          ['taint', record.taint_status || 'not produced'],
          ['tainted evidence status', taintedEvidence.status],
          ['tainted evidence ref', taintedEvidence.evidence_ref],
          ['tainted evidence hash', taintedEvidence.evidence_hash],
          ['evidence sanitized', taintedEvidence.sanitized === true ? 'true' : 'false', taintedEvidence.sanitized === true ? 'ok' : 'blocked'],
          ['raw tainted output included', taintedEvidence.raw_output_included === true ? 'true' : 'false', taintedEvidence.raw_output_included === true ? 'blocked' : 'ok'],
          ['evidence ref bytes', `${boundedNumber(taintedEvidence.reference_bytes)} / ${boundedNumber(taintedEvidence.max_reference_bytes)}`],
          ['evidence hash bytes', `${boundedNumber(taintedEvidence.hash_bytes)} / ${boundedNumber(taintedEvidence.max_hash_bytes)}`],
          ['lifecycle', (lifecycle.states || []).join(' → ') || 'none'],
        ]),
        lane('Evidence and Cleanup', [
          ['validation', record.validation_status],
          ['destruction request', cleanup.requested],
          ['absence observation', cleanup.absence],
          ['cleanup', cleanup.status, cleanup.status === 'verified' ? 'ok' : 'blocked'],
          ['receipt hash', receipt.demo_receipt_hash],
          ['receipt hash verified', record.receipt_hash_verified === true ? 'true' : 'false', record.receipt_hash_verified === true ? 'ok' : 'blocked'],
          ['receipt binding verified', record.receipt_binding_verified === true ? 'true' : 'false', record.receipt_binding_verified === true ? 'ok' : 'blocked'],
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
