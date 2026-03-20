import * as core from '@actions/core';
import * as fs from 'fs';
import { execSync } from 'child_process';

function getChangedFilesInPR(): string[] {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    core.warning('GITHUB_EVENT_PATH not found or not in PR context');
    return [];
  }

  try {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf-8'));
    const pr = event.pull_request;
    if (!pr?.base?.sha || !pr?.head?.sha) {
      core.warning('Not a pull_request event or missing base/head sha');
      return [];
    }

    const output = execSync(
      `git diff --name-only ${pr.base.sha}...${pr.head.sha}`,
      { encoding: 'utf-8' },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch (error) {
    core.warning(`Failed to get changed files: ${error}`);
    return [];
  }
}

async function run() {
  const files = getChangedFilesInPR();
  core.info(`PR changed files (${files.length}):`);
  files.forEach((f) => core.info(`  - ${f}`));
}

run();
