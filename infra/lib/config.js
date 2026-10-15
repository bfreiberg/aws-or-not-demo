import { existsSync, readFileSync } from 'node:fs';

// Deployment-specific values (your domain, hosted zone, alert email) live in infra/deploy-config.json,
// which is gitignored. Copy infra/deploy-config.example.json to get started.
const FILE = new URL('../deploy-config.json', import.meta.url);

export function loadDeployConfig() {
  if (!existsSync(FILE)) return null;
  const config = JSON.parse(readFileSync(FILE, 'utf8'));
  for (const key of ['domain', 'hostedZoneId', 'hostedZoneName', 'alertEmail', 'budgetUsd']) {
    if (config[key] === undefined || config[key] === '') throw new Error(`infra/deploy-config.json is missing "${key}"`);
  }
  if (!config.domain.endsWith(`.${config.hostedZoneName}`)) {
    throw new Error(`domain ${config.domain} is not inside hosted zone ${config.hostedZoneName}`);
  }
  return config;
}
