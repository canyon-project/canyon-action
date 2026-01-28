//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") {
		for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
			key = keys[i];
			if (!__hasOwnProp.call(to, key) && key !== except) {
				__defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
		}
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let __actions_core = require("@actions/core");
__actions_core = __toESM(__actions_core);
let fs = require("fs");
fs = __toESM(fs);
let path = require("path");
path = __toESM(path);

//#region src/index.ts
/**
* 从 GitHub Actions 环境变量获取仓库信息
*/
function getGitHubInfo() {
	const repository = process.env.GITHUB_REPOSITORY || "";
	const [owner, repo] = repository.split("/");
	return {
		provider: "github",
		repoID: repository,
		owner,
		repo,
		sha: process.env.GITHUB_SHA || "",
		ref: process.env.GITHUB_REF || "",
		workflow: process.env.GITHUB_WORKFLOW || "",
		runId: process.env.GITHUB_RUN_ID || "",
		runAttempt: process.env.GITHUB_RUN_ATTEMPT || ""
	};
}
/**
* 读取并合并多个 coverage 文件
*/
function loadCoverageFiles(filePaths) {
	const mergedCoverage = {};
	for (const filePath of filePaths) {
		const fullPath = path.resolve(filePath.trim());
		if (!fs.existsSync(fullPath)) {
			__actions_core.warning(`Coverage file not found: ${fullPath}`);
			continue;
		}
		try {
			const content = fs.readFileSync(fullPath, "utf-8");
			const coverage = JSON.parse(content);
			Object.assign(mergedCoverage, coverage);
			__actions_core.info(`Loaded coverage from: ${fullPath}`);
		} catch (error) {
			__actions_core.error(`Failed to parse coverage file ${fullPath}: ${error}`);
			throw error;
		}
	}
	return mergedCoverage;
}
/**
* 准备 map/init 请求的数据
*/
function prepareMapInitData(coverage, githubInfo, instrumentCwd, buildTarget) {
	const firstCoverageValue = Object.values(coverage)[0];
	const buildInfo = {
		workflow: githubInfo.workflow,
		runId: githubInfo.runId,
		runAttempt: githubInfo.runAttempt,
		ref: githubInfo.ref
	};
	return {
		sha: firstCoverageValue?.sha || githubInfo.sha,
		provider: firstCoverageValue?.provider || githubInfo.provider,
		repoID: firstCoverageValue?.repoID || githubInfo.repoID,
		instrumentCwd: firstCoverageValue?.instrumentCwd || instrumentCwd,
		buildTarget: firstCoverageValue?.buildTarget || buildTarget || "",
		build: buildInfo,
		coverage
	};
}
/**
* 准备 client 请求的数据
*/
function prepareClientData(coverage, scene) {
	const cleanedCoverage = {};
	const fieldsToRemove = [
		"statementMap",
		"fnMap",
		"branchMap",
		"inputSourceMap"
	];
	for (const [filePath, coverageData] of Object.entries(coverage)) if (coverageData && typeof coverageData === "object") {
		cleanedCoverage[filePath] = { ...coverageData };
		for (const field of fieldsToRemove) delete cleanedCoverage[filePath][field];
	}
	return {
		coverage: cleanedCoverage,
		scene
	};
}
/**
* 发送 HTTP 请求
*/
async function sendRequest(url, data, token) {
	const headers = { "Content-Type": "application/json" };
	if (token) headers["Authorization"] = `Bearer ${token}`;
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(data)
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`HTTP ${response.status}: ${response.statusText}\n${errorText}`);
	}
	return response.json();
}
/**
* 主函数
*/
async function run() {
	const failOnError = __actions_core.getInput("fail-on-error") === "" ? true : __actions_core.getBooleanInput("fail-on-error");
	try {
		const coverageFileInput = __actions_core.getInput("coverage-file", { required: true });
		const canyonUrl = __actions_core.getInput("canyon-url", { required: true });
		const canyonToken = __actions_core.getInput("canyon-token");
		const instrumentCwd = __actions_core.getInput("instrument-cwd", { required: true });
		const buildTarget = __actions_core.getInput("build-target") || "";
		const sceneInput = __actions_core.getInput("scene") || "{}";
		const coverageFilePaths = coverageFileInput.split(",").map((f) => f.trim()).filter((f) => f.length > 0);
		if (coverageFilePaths.length === 0) throw new Error("No coverage files specified");
		let scene = {};
		try {
			scene = JSON.parse(sceneInput);
		} catch (error) {
			__actions_core.warning(`Failed to parse scene JSON: ${error}. Using empty object.`);
			scene = {};
		}
		const githubInfo = getGitHubInfo();
		scene = {
			...scene,
			source: "automation",
			type: "ci",
			env: "test",
			trigger: "pipeline",
			...githubInfo
		};
		__actions_core.info(`Loading coverage files: ${coverageFilePaths.join(", ")}`);
		const coverage = loadCoverageFiles(coverageFilePaths);
		if (Object.keys(coverage).length === 0) throw new Error("No coverage data found in files");
		__actions_core.info(`Loaded ${Object.keys(coverage).length} coverage entries`);
		const mapInitData = prepareMapInitData(coverage, githubInfo, instrumentCwd, buildTarget);
		__actions_core.info("Uploading coverage map initialization...");
		const mapInitResult = await sendRequest(`${canyonUrl.replace(/\/$/, "")}/api/coverage/map/init`, mapInitData, canyonToken);
		if (!mapInitResult.success) throw new Error(`Map init failed: ${mapInitResult.message || "Unknown error"}`);
		__actions_core.info(`Map init successful. BuildHash: ${mapInitResult.buildHash}`);
		const clientData = prepareClientData(coverage, scene);
		__actions_core.info("Uploading coverage data...");
		const clientResult = await sendRequest(`${canyonUrl.replace(/\/$/, "")}/api/coverage/client`, clientData, canyonToken);
		if (!clientResult.success) throw new Error(`Client upload failed: ${clientResult.message || "Unknown error"}`);
		__actions_core.info(`Coverage upload successful. BuildHash: ${clientResult.buildHash}, SceneKey: ${clientResult.sceneKey}`);
		__actions_core.setOutput("build-hash", clientResult.buildHash);
		__actions_core.setOutput("scene-key", clientResult.sceneKey);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		__actions_core.error(errorMessage);
		if (failOnError) __actions_core.setFailed(errorMessage);
	}
}
run();

//#endregion