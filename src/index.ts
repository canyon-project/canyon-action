import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';

interface BuildInfo {
  [key: string]: any;
}

/**
 * 从 ref 中提取分支名
 */
function extractBranchFromRef(ref: string): string | undefined {
  // ref 格式通常是 refs/heads/main, refs/tags/v1.0.0 等
  if (ref.startsWith('refs/heads/')) {
    return ref.replace('refs/heads/', '');
  }
  return undefined;
}

/**
 * 从 GitHub Actions 环境变量获取仓库信息
 */
function getGitHubInfo() {
  const repoID = process.env.GITHUB_REPOSITORY_ID || '';
  const sha = process.env.GITHUB_SHA || '';
  const ref = process.env.GITHUB_REF || '';
  const workflow = process.env.GITHUB_WORKFLOW || '';
  const runId = process.env.GITHUB_RUN_ID || '';
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '';

  return {
    provider: 'github',
    repoID,
    sha,
    ref,
    workflow,
    runId,
    runAttempt,
  };
}

/**
 * 读取单个 coverage 文件
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
 * 读取 diff.json 文件（如果存在）
 */
function loadDiffData(): any | undefined {
  const diffJsonPath = path.resolve('diff.json');
  if (fs.existsSync(diffJsonPath)) {
    try {
      const diffJsonContent = fs.readFileSync(diffJsonPath, 'utf-8');
      const diffData = JSON.parse(diffJsonContent);
      core.info(`Found diff.json file: ${diffJsonPath}`);
      return diffData;
    } catch (error) {
      core.warning(`Failed to read or parse diff.json: ${error}`);
      return undefined;
    }
  }
  return undefined;
}

/**
 * 准备 map/init 请求的数据
 */
function prepareMapInitData(
  coverage: any,
  githubInfo: ReturnType<typeof getGitHubInfo>,
  instrumentCwd: string,
  buildTarget: string,
  diffData?: any,
): any {
  const branch = extractBranchFromRef(githubInfo.ref);


  // 检测是否在 GitHub Actions 环境中
  const isGitHubActions =
    process.env.GITHUB_ACTIONS === 'true' || !!process.env.GITHUB_EVENT_PATH;

  // 读取 GitHub Actions event 内容
  let githubEvent: string | undefined;
  if (isGitHubActions && process.env.GITHUB_EVENT_PATH) {
    try {
      if (fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
        githubEvent = fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8');
      } else {
        console.log(
          'GITHUB_EVENT_PATH file not found:',
          process.env.GITHUB_EVENT_PATH,
        );
      }
    } catch (error) {
      console.warn('Failed to read GITHUB_EVENT_PATH:', error);
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
    ...(diffData && { diff: diffData }),
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
 * 主函数
 */
async function run() {
  // 获取输入参数（在 try 外获取 failOnError，以便在 catch 中使用）
  const failOnErrorInput = core.getInput('fail-on-error');
  const failOnError = failOnErrorInput === '' ? true : core.getBooleanInput('fail-on-error');

  try {
    // 获取输入参数
    const coverageFile = core.getInput('coverage-file', { required: true });
    const canyonUrl = core.getInput('canyon-url', { required: true });
    const canyonToken = core.getInput('canyon-token');
    const instrumentCwd = core.getInput('instrument-cwd', { required: true });
    const buildTarget = core.getInput('build-target') || '';

    const githubInfo = getGitHubInfo();
    core.info(`Loading coverage file: ${coverageFile}`);
    const coverage = loadCoverageFile(coverageFile);

    if (Object.keys(coverage).length === 0) {
      throw new Error('No coverage data found in file');
    }

    core.info(`Loaded ${Object.keys(coverage).length} coverage entries`);

    // 尝试读取 diff.json 文件
    const diffData = loadDiffData();

    // 准备 map/init 数据
    const mapInitData = prepareMapInitData(
      coverage,
      githubInfo,
      instrumentCwd,
      buildTarget,
      diffData,
    );

    // 调用 map/init 接口
    core.info('Uploading coverage map initialization...');
    const mapInitUrl = `${canyonUrl.replace(/\/$/, '')}/api/coverage/map/init`;
    const mapInitResult = await sendRequest(mapInitUrl, mapInitData, canyonToken);

    if (!mapInitResult.success) {
      throw new Error(
        `Map init failed: ${mapInitResult.message || 'Unknown error'}`,
      );
    }

    core.info(`Coverage upload successful. BuildHash: ${mapInitResult.buildHash}`);

    // 设置输出
    core.setOutput('build-hash', mapInitResult.buildHash);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.error(errorMessage);

    if (failOnError) {
      core.setFailed(errorMessage);
    }
  }
}

// 执行主函数
run();
