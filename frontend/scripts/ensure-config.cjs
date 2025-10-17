#!/usr/bin/env node
const { existsSync, mkdirSync, copyFileSync } = require('fs');
const { join } = require('path');

const configDir = join(__dirname, '..', 'config');
const runtimeFile = join(configDir, 'runtime.json');
const templateFile = join(configDir, 'runtime.template.json');

mkdirSync(configDir, { recursive: true });

if (!existsSync(runtimeFile)) {
  if (!existsSync(templateFile)) {
    throw new Error(
      `Missing template config at ${templateFile}. Please create runtime.json manually.`,
    );
  }
  copyFileSync(templateFile, runtimeFile);
  console.log(`Created ${runtimeFile} from template. Update apiBaseUrl before building.`);
}
