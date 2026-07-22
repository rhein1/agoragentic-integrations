#!/usr/bin/env node
'use strict';

const { runCli } = require('agoragentic/agent-os');

runCli().then((code) => {
    process.exitCode = code;
});
