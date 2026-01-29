import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';

interface BuildInfo {
  [key: string]: any;
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
 * 准备 map/init 请求的数据
 */
function prepareMapInitData(
  coverage: any,
  githubInfo: ReturnType<typeof getGitHubInfo>,
  instrumentCwd: string,
  buildTarget: string,
): any {
  const buildInfo: BuildInfo = {
    workflow: githubInfo.workflow,
    runId: githubInfo.runId,
    runAttempt: githubInfo.runAttempt,
    ref: githubInfo.ref,
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
    Object.entries(githubInfo).forEach((item)=>{
      console.log(`key:${item[0]},value:${item[1]}`)
    })
    core.info(`Loading coverage file: ${coverageFile}`);
    const coverage = loadCoverageFile(coverageFile);

    if (Object.keys(coverage).length === 0) {
      throw new Error('No coverage data found in file');
    }

    core.info(`Loaded ${Object.keys(coverage).length} coverage entries`);

    // 准备 map/init 数据
    const mapInitData = prepareMapInitData(
      coverage,
      githubInfo,
      instrumentCwd,
      buildTarget,
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
