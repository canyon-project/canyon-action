import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

interface BuildInfo {
  [key: string]: any;
}

/**
 * 从 ref 中提取分支名
 */
function extractBranchFromRef(ref: string): string | undefined {
  if (ref.startsWith('refs/heads/')) {
    return ref.replace('refs/heads/', '');
  }
  return undefined;
}

/**
 * 从 GitHub event 文件中获取 PR head 信息
 * head 仓库即 PR 来源（fork），如 travzhang/rstest -> web-infra-dev/rstest 时取 travzhang/rstest
 */
function getPullRequestHeadInfo(): {
  sha?: string;
  repoID?: string;
  repository?: string;
} {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    return {};
  }

  try {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf-8'));
    const pullRequest = event.pull_request;
    if (pullRequest?.head?.repo) {
      const repo = pullRequest.head.repo;
      const repository = repo.full_name || (repo.owner?.login && repo.name ? `${repo.owner.login}/${repo.name}` : undefined);
      return {
        sha: pullRequest.head.sha,
        repoID: repo.id?.toString(),
        repository,
      };
    }
  } catch (error) {
    core.warning(`Failed to parse GitHub event file: ${error}`);
  }

  return {};
}

/**
 * 从 GitHub Actions 环境变量获取仓库信息
 */
function getGitHubInfo() {
  const prHeadInfo = getPullRequestHeadInfo();

  const repoID = prHeadInfo.repoID || process.env.GITHUB_REPOSITORY_ID || '';
  const sha = prHeadInfo.sha || process.env.GITHUB_SHA || '';
  const ref = process.env.GITHUB_REF || '';
  const workflow = process.env.GITHUB_WORKFLOW || '';
  const runId = process.env.GITHUB_RUN_ID || '';
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '';
  // PR 时用 head 仓库（fork），否则用当前仓库
  const repository = prHeadInfo.repository || process.env.GITHUB_REPOSITORY || '';

  if (prHeadInfo.sha || prHeadInfo.repoID) {
    core.info(`Using PR head info - sha: ${sha}, repoID: ${repoID}, repository: ${repository}`);
  }

  return {
    provider: 'github',
    repoID,
    sha,
    ref,
    workflow,
    runId,
    runAttempt,
    repository,
  };
}

/**
 * 获取 PR 变更文件列表及 base/head sha（git fetch + git diff）
 */
function getChangedFilesInPR(): {
  files: string[];
  base?: string;
  head?: string;
} {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    return { files: [] };
  }

  try {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf-8'));
    const pr = event.pull_request;
    if (!pr?.base?.sha || !pr?.head?.sha) {
      return { files: [] };
    }

    const { base, head } = { base: pr.base.sha, head: pr.head.sha };

    execSync(`git fetch origin ${base} ${head}`, { encoding: 'utf-8' });

    const output = execSync(`git diff --name-only ${base}...${head}`, {
      encoding: 'utf-8',
    });
    const files = output.trim().split('\n').filter(Boolean);
    return { files, base, head };
  } catch (error) {
    core.warning(`Failed to get changed files: ${error}`);
    return { files: [] };
  }
}

/**
 * 用 PR 变更文件过滤 coverage 数据
 */
function filterCoverageByChangedFiles(
  coverage: Record<string, any>,
  changedFiles: string[],
): Record<string, any> {
  if (changedFiles.length === 0) return coverage;

  const normalizedChanged = new Set(
    changedFiles.map((f) => f.replace(/\\/g, '/')),
  );

  const filtered: Record<string, any> = {};
  for (const [filePath, data] of Object.entries(coverage)) {
    const normalized = filePath.replace(/\\/g, '/');
    const match = [...normalizedChanged].some(
      (changed) =>
        normalized === changed || normalized.endsWith('/' + changed),
    );
    if (match) {
      filtered[filePath] = data;
    }
  }
  return filtered;
}

/**
 * 读取 coverage 文件
 */
function loadCoverageFile(filePath: string): any {
  const fullPath = path.resolve(filePath.trim());

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Coverage file not found: ${fullPath}`);
  }

  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    const coverage = JSON.parse(content);
    core.info(`Loaded coverage from: ${fullPath}`);
    return coverage;
  } catch (error) {
    core.error(`Failed to parse coverage file ${fullPath}: ${error}`);
    throw error;
  }
}

/**
 * 准备 map/init 请求的数据
 */
function prepareMapInitData(
  coverage: any,
  githubInfo: ReturnType<typeof getGitHubInfo>,
  instrumentCwd: string,
  buildTarget: string,
): any {
  const branch = extractBranchFromRef(githubInfo.ref);

  const isGitHubActions =
    process.env.GITHUB_ACTIONS === 'true' || !!process.env.GITHUB_EVENT_PATH;

  let githubEvent: string | undefined;
  if (isGitHubActions && process.env.GITHUB_EVENT_PATH) {
    try {
      if (fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
        githubEvent = fs.readFileSync(
          process.env.GITHUB_EVENT_PATH,
          'utf8',
        );
      }
    } catch (error) {
      core.warning(`Failed to read GITHUB_EVENT_PATH: ${error}`);
    }
  }

  const buildInfo: BuildInfo = {
    provider: 'github_actions',
    event: githubEvent,
    buildID: githubInfo.runId,
    branch: branch,
  };

  return {
    sha: githubInfo.sha,
    provider: githubInfo.provider,
    repoID: githubInfo.repoID,
    instrumentCwd: instrumentCwd,
    buildTarget: buildTarget || '',
    build: buildInfo,
    coverage,
  };
}

/**
 * 发送 HTTP 请求
 */
async function sendRequest(
  url: string,
  data: any,
  token?: string,
): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });



  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HTTP ${response.status}: ${response.statusText}\n${errorText}`,
    );
  }

  return response.json();
}

/**
 * 生成 Canyon 报告链接
 */
function buildReportLinks(params: {
  reportBaseUrl: string;
  repository: string;
  sha: string;
  base?: string;
  head?: string;
}): { compareUrl?: string; commitUrl: string } {
  const { reportBaseUrl, repository, sha, base, head } = params;
  const baseUrl = reportBaseUrl.replace(/\/$/, '');
  const commitUrl = `${baseUrl}/report/-/github/${repository}/commit/${sha}/-`;
  const compareUrl =
    base && head
      ? `${baseUrl}/report/-/github/${repository}/compare/${base}...${head}/-`
      : undefined;
  return { compareUrl, commitUrl };
}

/**
 * 写入 Job Summary（显示在 Actions 运行页面的 Summary 区域）
 */
async function writeJobSummary(params: {
  buildHash?: string;
  changedFiles: string[];
  coverageEntries: number;
  onlyChanges: boolean;
  skipped?: boolean;
  compareUrl?: string;
  commitUrl: string;
}) {
  const {
    buildHash,
    changedFiles,
    coverageEntries,
    onlyChanges,
    skipped,
    compareUrl,
    commitUrl,
  } = params;

  const md: string[] = [];
  md.push('## Canyon Coverage Upload');
  md.push('');

  if (skipped) {
    md.push('> ⏭️ **Skipped**: No coverage data for changed files, upload skipped.');
    md.push('');
  } else if (buildHash) {
    md.push('| Key | Value |');
    md.push('|:--|:--|');
    md.push(`| **BuildHash** | \`${buildHash}\` |`);
    md.push(`| **Coverage entries** | ${coverageEntries}${onlyChanges && changedFiles.length > 0 ? ' _(PR changed files only)_' : ''} |`);
    if (changedFiles.length > 0) {
      md.push(`| **PR changed files** | ${changedFiles.length} |`);
    }
    md.push('');
  }

  md.push('### Report');
  md.push('');
  if (compareUrl) {
    md.push(`- **[Changed files coverage](${compareUrl})**`);
  }
  md.push(`- **[Full coverage](${commitUrl})**`);
  md.push('');

  if (changedFiles.length > 0) {
    md.push('### Changed files');
    md.push('');
    changedFiles.forEach((f) => md.push(`- \`${f}\``));
    md.push('');
  }

  await core.summary.addRaw(md.join('\n')).write();
}

async function run() {
  const failOnErrorInput = core.getInput('fail-on-error');
  const failOnError =
    failOnErrorInput === '' ? true : core.getBooleanInput('fail-on-error');

  try {
    const coverageFile = core.getInput('coverage-file', { required: true });
    const canyonUrl = core.getInput('canyon-url', { required: true });
    const canyonToken = core.getInput('canyon-token');
    const instrumentCwdInput = core.getInput('instrument-cwd');
    const instrumentCwd = instrumentCwdInput || process.cwd();
    const buildTarget = core.getInput('build-target') || '';
    const onlyChangesInput = core.getInput('only-changes');
    const onlyChanges =
      onlyChangesInput === '' ? true : core.getBooleanInput('only-changes');
    const reportUrl =
      core.getInput('report-url') || 'https://app.canyonjs.io';

    core.info(`Instrument CWD: ${instrumentCwd}`);

    const githubInfo = getGitHubInfo();
    core.info(`Loading coverage file: ${coverageFile}`);
    let coverage = loadCoverageFile(coverageFile);

    if (Object.keys(coverage).length === 0) {
      throw new Error('No coverage data found in file');
    }

    core.info(`Loaded ${Object.keys(coverage).length} coverage entries`);

    // 获取 PR 变更文件，按需过滤 coverage
    const { files: changedFiles, base, head } = getChangedFilesInPR();
    if (changedFiles.length > 0) {
      core.info(`PR changed files (${changedFiles.length}):`);
      changedFiles.forEach((f) => core.info(`  - ${f}`));

      if (onlyChanges) {
        coverage = filterCoverageByChangedFiles(coverage, changedFiles);
        core.info(
          `Filtered to ${Object.keys(coverage).length} coverage entries (PR changed files only)`,
        );
      } else {
        core.info('only-changes=false, uploading full coverage');
      }
    }

    // PR 场景下调用 source/diff 接口
    if (base && head && githubInfo.repoID) {
      const diffUrl = `${canyonUrl.replace(/\/$/, '')}/api/source/diff`;
      const diffPayload = {
        repoID: githubInfo.repoID,
        provider: 'github',
        subject: 'compare',
        subjectID: `${base}...${head}`,
      };
      core.info(`Calling source/diff: ${JSON.stringify(diffPayload)}`);
      try {
        await sendRequest(diffUrl, diffPayload, canyonToken);
        core.info('Source diff registered successfully');
      } catch (diffError) {
        core.warning(`Source diff failed (non-fatal): ${diffError}`);
      }
    }

    const coverageEntries = Object.keys(coverage).length;
    const { compareUrl, commitUrl } = buildReportLinks({
      reportBaseUrl: reportUrl,
      repository: githubInfo.repository,
      sha: githubInfo.sha,
      base,
      head,
    });

    let buildHash: string | undefined;

    if (coverageEntries === 0) {
      core.info('Skipped: No coverage data for changed files, upload skipped.');
    } else {
      const mapInitData = prepareMapInitData(
        coverage,
        githubInfo,
        instrumentCwd,
        buildTarget,
      );

      core.info('Uploading coverage map initialization...');
      const mapInitUrl = `${canyonUrl.replace(/\/$/, '')}/api/coverage/map/init`;
      const mapInitResult = await sendRequest(mapInitUrl, mapInitData, canyonToken) as {
        success?: boolean;
        buildHash?: string;
        message?: string;
      };

      if (!mapInitResult.success) {
        throw new Error(
          `Map init failed: ${mapInitResult.message || 'Unknown error'}`,
        );
      }

      buildHash = mapInitResult.buildHash;
      core.info(`Coverage upload successful. BuildHash: ${buildHash}`);
      core.setOutput('build-hash', buildHash);
    }

    // 输出到 Job Summary（Actions 运行页面的 Summary 区域）
    try {
      await writeJobSummary({
        buildHash,
        changedFiles,
        coverageEntries,
        onlyChanges,
        skipped: coverageEntries === 0,
        compareUrl,
        commitUrl,
      });
    } catch (e) {
      core.warning(`Failed to write job summary: ${e}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.error(errorMessage);

    if (failOnError) {
      core.setFailed(errorMessage);
    }
  }
}

run();
