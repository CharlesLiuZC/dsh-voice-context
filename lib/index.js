import { execFile, spawn } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
//#region src/config.ts
/**
* Fill schema defaults over a partial entry config.
* @param config - partial Loader entry configuration.
* @returns the complete runtime configuration.
*/
function resolveConfig(config) {
	return {
		apiKey: config.apiKey ?? "",
		apiKeyEnv: config.apiKeyEnv ?? "SILICONFLOW_API_KEY",
		baseUrl: config.baseUrl ?? "https://api.siliconflow.cn",
		model: config.model ?? "FunAudioLLM/SenseVoiceSmall",
		language: config.language ?? "zh",
		maxBytes: config.maxBytes ?? 25 * 1024 * 1024,
		timeoutMs: config.timeoutMs ?? 6e4,
		localPort: config.localPort ?? 8e3,
		pythonBin: config.pythonBin ?? "python"
	};
}
//#endregion
//#region src/transcribe.ts
/** POSIX identifier the credentials seam accepts as a reference name. */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
* Name one credential reference. Inlined so this package carries no runtime
* dependency on a first-party wire package.
* @param value - candidate reference name.
* @returns the same name for the seam's branded parameter.
*/
function credentialRef(value) {
	if (!CREDENTIAL_REF_PATTERN.test(value)) throw new TypeError(`invalid credential ref: ${value}`);
	return value;
}
const CLOUD_BASE_URL = "https://api.siliconflow.cn";
const CLOUD_MODEL = "FunAudioLLM/SenseVoiceSmall";
const LOCAL_MODEL_IDS = new Set([
	"iic/SenseVoiceSmall",
	"small",
	"medium",
	"large-v3"
]);
/** Resolve the API key for one request: credentials seam → literal → environment. */
async function resolveApiKey(ctx, config) {
	const credentials = ctx.get("credentials");
	if (credentials !== void 0) {
		const resolved = await credentials.resolve(credentialRef(config.apiKeyEnv));
		if (resolved !== void 0) return resolved.value;
	}
	if (config.apiKey !== "") return config.apiKey;
	const ambient = process.env[config.apiKeyEnv];
	return ambient !== void 0 && ambient !== "" ? ambient : void 0;
}
/** Whether the configured base URL points at the loopback interface. */
function isLoopback(baseUrl) {
	try {
		const hostname = new URL(baseUrl).hostname;
		return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
	} catch {
		return false;
	}
}
/** Resolve the trusted upstream route for one browser-selected backend. */
function resolveTarget(config, request) {
	if (request.backend === "local") {
		const model = request.model ?? "iic/SenseVoiceSmall";
		if (!LOCAL_MODEL_IDS.has(model)) throw new Error(`voice-context: invalid local STT model ${model}`);
		return {
			baseUrl: `http://127.0.0.1:${config.localPort}`,
			model
		};
	}
	if (request.backend === "cloud") {
		const model = request.model ?? CLOUD_MODEL;
		if (model !== CLOUD_MODEL) throw new Error(`voice-context: invalid cloud STT model ${model}`);
		return {
			baseUrl: isLoopback(config.baseUrl) ? CLOUD_BASE_URL : config.baseUrl,
			model
		};
	}
	return {
		baseUrl: config.baseUrl,
		model: config.model
	};
}
/** Upstream filename extension from a container MIME type. */
function filenameFor(mimeType) {
	if (mimeType.includes("webm")) return "audio.webm";
	if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "audio.m4a";
	if (mimeType.includes("ogg") || mimeType.includes("opus")) return "audio.ogg";
	if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "audio.mp3";
	return "audio.wav";
}
/** Extract the transcript string from an upstream JSON body. */
function extractText(parsed) {
	if (parsed !== null && typeof parsed === "object") {
		const record = parsed;
		if (typeof record.text === "string") return record.text;
		if (typeof record.result === "string") return record.result;
		if (Array.isArray(record.segments)) {
			const joined = record.segments.map((segment) => segment !== null && typeof segment === "object" ? segment.text : void 0).filter((text) => typeof text === "string").join("");
			if (joined !== "") return joined;
		}
	}
	return "";
}
/**
* Forward one transcription request to the configured provider.
* @param ctx - owning context supplying the credentials plane.
* @param config - resolved service configuration.
* @param request - base64 audio plus its container and optional language hint.
* @returns the transcribed text.
* @throws when no credential is configured for a cloud backend, or upstream fails.
*/
async function transcribeAudio(ctx, config, request) {
	const target = resolveTarget(config, request);
	const apiKey = isLoopback(target.baseUrl) ? void 0 : await resolveApiKey(ctx, config);
	if (apiKey === void 0 && !isLoopback(target.baseUrl)) throw new Error(`voice-context: no STT credential configured (set ${config.apiKeyEnv} in settings)`);
	const audio = Buffer.from(request.audio, "base64");
	if (audio.length === 0) throw new Error("voice-context: empty audio payload");
	if (audio.length > config.maxBytes) throw new Error("voice-context: audio payload exceeds maxBytes");
	const form = new FormData();
	form.append("model", target.model);
	form.append("language", request.language ?? config.language);
	form.append("file", new Blob([audio], { type: request.mimeType }), filenameFor(request.mimeType));
	const headers = {};
	if (apiKey !== void 0) headers.authorization = `Bearer ${apiKey}`;
	const upstream = await fetch(`${target.baseUrl.replace(/\/+$/, "")}/v1/audio/transcriptions`, {
		method: "POST",
		headers,
		body: form,
		signal: AbortSignal.timeout(config.timeoutMs)
	});
	const raw = await upstream.text();
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = void 0;
	}
	if (!upstream.ok) {
		const message = parsed !== null && typeof parsed === "object" && "error" in parsed ? String(parsed.error) : `upstream STT failed (${upstream.status})`;
		throw new Error(`voice-context: ${message}`);
	}
	return { text: extractText(parsed) };
}
//#endregion
//#region src/local.ts
/**
* Local backend manager: detect whether the host can run a local STT model,
* install the FunASR and faster-whisper runtimes, launch the companion server
* as a tracked child process, and report status. The `/voice-local` command
* (see index.ts) is the human-facing surface.
* @module @deepseek-ai/dsh-voice-context/local
*/
/** Absolute path of the shipped FunASR backend directory (next to `lib/`). */
const LOCAL_DIR = fileURLToPath(new URL("../local/funasr/", import.meta.url));
function check(command, args, timeoutMs = 2e4) {
	return new Promise((resolve) => {
		execFile(command, args, {
			encoding: "utf8",
			timeout: timeoutMs
		}, (error, stdout, stderr) => {
			resolve({
				ok: error === null,
				output: `${stdout}\n${stderr}`.trim()
			});
		});
	});
}
/** Whether the local STT server answers `/health` on the configured port. */
async function serverHealthy(port) {
	try {
		return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2e3) })).ok;
	} catch {
		return false;
	}
}
/** Poll `/health` until it answers or the deadline passes (model load can take seconds). */
async function waitHealthy(port, timeoutMs = 3e4) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await serverHealthy(port)) return true;
		await new Promise((resolve) => {
			setTimeout(resolve, 1e3);
		});
	}
	return false;
}
/**
* Owns the local backend's lifecycle. The launched server is a child of this
* dsh process, so it stops with the harness unless `stop` is called first.
*/
var LocalSttManager = class {
	config;
	child;
	constructor(config) {
		this.config = config;
	}
	/**
	* Report hardware capability and local-backend readiness as UI text.
	* @returns a command result containing the readiness report.
	*/
	async status() {
		const lines = [];
		const python = await check(this.config.pythonBin, ["--version"]);
		lines.push(python.ok ? `Python: ${python.output.split("\n")[0]}` : `Python: not found (tried "${this.config.pythonBin}")`);
		const gpu = await check("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], 5e3);
		lines.push(gpu.ok ? `GPU: ${gpu.output.split("\n")[0] ?? "detected"}` : "GPU: none detected (CPU mode is fine for SenseVoiceSmall)");
		lines.push(`CPU cores: ${cpus().length}`);
		lines.push(`RAM: ${(totalmem() / 2 ** 30).toFixed(1)} GiB`);
		if (python.ok) {
			const dependencies = await check(this.config.pythonBin, ["-c", "import funasr, faster_whisper, torch"]);
			lines.push(dependencies.ok ? "Local STT dependencies: installed" : "Local STT dependencies: incomplete — run /voice-local install");
		}
		lines.push(await serverHealthy(this.config.localPort) ? `Local server: running on 127.0.0.1:${this.config.localPort}` : "Local server: not running — run /voice-local start");
		return {
			kind: "success",
			text: lines.join("\n")
		};
	}
	/**
	* Install both local engines and CPU torch into the active Python environment.
	* @param signal - cancellation signal forwarded to pip.
	* @returns the install outcome as a command result.
	*/
	async install(signal) {
		if (!(await check(this.config.pythonBin, ["--version"])).ok) return {
			kind: "error",
			text: `Python not found (tried "${this.config.pythonBin}"); install Python 3.9+ or set pythonBin in config.`
		};
		const torch = await check(this.config.pythonBin, ["-c", "import torch, torchaudio"]);
		const installs = [[
			"-m",
			"pip",
			"install",
			"-r",
			`${LOCAL_DIR}requirements.txt`
		], [
			"-m",
			"pip",
			"install",
			"-r",
			`${LOCAL_DIR}requirements-faster-whisper.txt`
		]];
		if (!torch.ok) installs.push([
			"-m",
			"pip",
			"install",
			"torch",
			"torchaudio",
			"--index-url",
			"https://download.pytorch.org/whl/cpu",
			"--extra-index-url",
			"https://pypi.org/simple"
		]);
		for (const args of installs) {
			const output = await runInstall(this.config.pythonBin, args, signal);
			if (!output.ok) return {
				kind: "error",
				text: `pip install failed:\n${output.output}`
			};
		}
		return {
			kind: "success",
			text: `Installed local STT dependencies. Download any faster-whisper weights you want, then run /voice-local start; the server listens at http://127.0.0.1:${this.config.localPort}.`
		};
	}
	/**
	* Launch the local server as a tracked child process.
	* @returns the launch outcome as a command result.
	*/
	async start() {
		if (await serverHealthy(this.config.localPort)) return {
			kind: "success",
			text: `Local server already running on 127.0.0.1:${this.config.localPort}.`
		};
		if (this.child !== void 0) return {
			kind: "error",
			text: "A local server launch is already tracked; run /voice-local stop first."
		};
		const child = spawn(this.config.pythonBin, [
			"-m",
			"uvicorn",
			"server:app",
			"--host",
			"127.0.0.1",
			"--port",
			String(this.config.localPort)
		], {
			cwd: LOCAL_DIR,
			stdio: "ignore",
			detached: false
		});
		this.child = child;
		child.once("error", () => {
			this.child = void 0;
		});
		child.once("exit", () => {
			this.child = void 0;
		});
		return await waitHealthy(this.config.localPort) ? {
			kind: "success",
			text: `Local STT server started on 127.0.0.1:${this.config.localPort}. Point baseUrl at it.`
		} : {
			kind: "error",
			text: `Server launched but /health is not answering on 127.0.0.1:${this.config.localPort}; check the uvicorn output.`
		};
	}
	/**
	* Stop the tracked local server.
	* @returns the stop outcome as a command result.
	*/
	stop() {
		if (this.child === void 0) return Promise.resolve({
			kind: "success",
			text: "No local server is tracked by this process."
		});
		this.child.kill();
		this.child = void 0;
		return Promise.resolve({
			kind: "success",
			text: "Stopped the local server."
		});
	}
	/**
	* Dispatch one parsed `/voice-local` invocation to its subcommand.
	* @param rawInput - unparsed text after the command name.
	* @param signal - cancellation signal for long-running installation.
	* @returns the selected subcommand outcome.
	*/
	async run(rawInput, signal) {
		switch (rawInput.trim().toLowerCase()) {
			case "":
			case "status": return await this.status();
			case "install": return await this.install(signal);
			case "start": return await this.start();
			case "stop": return await this.stop();
			default: return {
				kind: "error",
				text: "Usage: /voice-local [status|install|start|stop]"
			};
		}
	}
};
/** Run one pip installation command and capture its output. */
function runInstall(python, args, signal) {
	return new Promise((resolve) => {
		execFile(python, args, {
			encoding: "utf8",
			timeout: 1800 * 1e3,
			signal,
			maxBuffer: 16 * 1024 * 1024
		}, (error, stdout, stderr) => {
			resolve({
				ok: error === null,
				output: `${stdout}\n${stderr}`.trim()
			});
		});
	});
}
//#endregion
//#region src/index.ts
/** Loader entry identity. */
const name = "voice-context";
/** The channel rides the host web server, which must exist before this mounts. */
const inject = ["webServer"];
/** Route prefix owning every Voice-Context endpoint. */
const CHANNEL = "/voice-context";
/** The single endpoint the browser half calls. */
const TRANSCRIBE_ENDPOINT = "transcribe";
/** One endpoint path segment (mirrors the built-in RPC channel segment rule). */
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/;
/**
* JSON body cap. The browser sends base64 audio (~1.34x the raw bytes), so this
* sits above `maxBytes` with envelope headroom.
*/
const BODY_CAP_BYTES = 64 * 1024 * 1024;
function failed(code, message, details = {}) {
	return {
		ok: false,
		error: {
			code,
			message,
			details
		}
	};
}
/**
* Whether a normalized URL hostname names the local loopback authority.
* @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
* @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
*/
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/**
* Loopback trust fence: the Host header must name this machine (DNS-rebinding
* defense) and any browser marker must be same-origin.
* @param req - incoming node:http request.
* @returns true when the request may reach the endpoint.
*/
function isTrustedLoopbackRequest(req) {
	const host = req.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/** The channel-relative endpoint of a request path, or undefined when it is not one. */
function endpointFromPath(pathname) {
	if (!pathname.startsWith(`${CHANNEL}/`)) return void 0;
	const endpoint = pathname.slice(15);
	if (endpoint.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || !ENDPOINT_SEGMENT.test(segment))) return;
	return endpoint;
}
/** Buffer one request body up to a byte cap. */
async function readBody(req, cap) {
	const chunks = [];
	let received = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		received += buffer.byteLength;
		if (received > cap) throw new Error("request body exceeds the channel cap");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Dispatch one decoded endpoint call. */
async function dispatch(ctx, config, endpoint, payload) {
	if (endpoint !== TRANSCRIBE_ENDPOINT) return failed("internal", `voice-context: unknown endpoint "${endpoint}"`);
	const args = payload?.args;
	if (args === void 0 || args === null || typeof args !== "object") return failed("internal", "voice-context: missing transcribe args");
	try {
		return {
			ok: true,
			value: await transcribeAudio(ctx, config, args)
		};
	} catch (error) {
		return failed("internal", error instanceof Error ? error.message : String(error));
	}
}
/**
* Answer one channel request: fence, parse the envelope, dispatch, respond.
* @param ctx - owning plugin context.
* @param config - resolved plugin configuration.
* @param req - incoming request.
* @param res - response the handler owns to completion.
*/
async function handleRequest(ctx, config, req, res) {
	if (!isTrustedLoopbackRequest(req)) {
		res.writeHead(403);
		res.end("forbidden");
		return;
	}
	const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
	const endpoint = endpointFromPath(pathname);
	if (req.method !== "POST") {
		res.writeHead(405);
		res.end("method not allowed");
		return;
	}
	if (endpoint === void 0) {
		res.writeHead(404);
		res.end("not found");
		return;
	}
	if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
		res.writeHead(415);
		res.end("content type must be application/json");
		return;
	}
	let envelope;
	try {
		envelope = JSON.parse(await readBody(req, BODY_CAP_BYTES));
	} catch {
		res.writeHead(400);
		res.end("body is not JSON");
		return;
	}
	const rpcId = typeof envelope.rpcId === "string" ? envelope.rpcId : "invalid-request";
	const result = envelope.type === "client-request" && envelope.method === endpoint ? await dispatch(ctx, config, endpoint, envelope.payload) : failed("bad-request", `voice-context: method ${JSON.stringify(String(envelope.method))} does not match endpoint ${JSON.stringify(endpoint)}`, { issues: [] });
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({
		type: "server-response",
		rpcId,
		result
	}));
}
/**
* Mount the Voice-Context host surface.
* @param ctx - owning plugin context.
* @param config - partial Loader entry configuration; defaults apply.
*/
function apply(ctx, config = {}) {
	const resolved = resolveConfig(config);
	const local = new LocalSttManager(resolved);
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: CHANNEL,
		handler: (req, res) => handleRequest(ctx, resolved, req, res)
	}), "voice-context: /voice-context channel");
	ctx.inject(["commands"], (commandCtx) => {
		commandCtx.commands.register({
			name: "voice-local",
			description: "manage the local offline speech-to-text backend",
			input: { hint: "[status|install|start|stop]" },
			handler: (invocation) => local.run(invocation.rawInput, invocation.signal)
		});
	});
}
//#endregion
export { apply, inject, name };
