import { DEFAULT_SCENARIO_PATH, loadScenario, scenarioSummary } from './scenario.mjs';

const [command = 'check'] = process.argv.slice(2);
if (command !== 'check') {
  console.error(`unknown command: ${command} (supported: check)`);
  process.exit(2);
}
const scenarioPath = process.env.JOIN_GATEKEEPER_SCENARIO_PATH || DEFAULT_SCENARIO_PATH;
try {
  console.log(JSON.stringify(scenarioSummary(loadScenario(scenarioPath)), null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
}
