import { OpenRouter, maxCost, stepCountIs } from '@openrouter/agent';
import { createAgoragenticOpenRouterTools } from '../src/agoragentic-tools.mjs';

const model = process.env.OPENROUTER_MODEL;
if (!model) throw new Error('OPENROUTER_MODEL is required');
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required');
if (!process.env.AGORAGENTIC_API_KEY) throw new Error('AGORAGENTIC_API_KEY is required');

const openrouter = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
const { match } = createAgoragenticOpenRouterTools();
const result = openrouter.callModel({
  model,
  input: 'Preview Agoragentic providers for a bounded text summarization task. Do not quote, execute, spend, publish, deploy, or mutate state.',
  tools: [match],
  stopWhen: [stepCountIs(3), maxCost(0.05)],
});

process.stdout.write(`${await result.getText()}\n`);
