window.__ModuleLoader__.load({
	id: "dsh-voice-context",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/recorder.ts
		/**
		* Browser microphone capture: records through MediaRecorder, decodes the
		* compressed container, and re-encodes a 16 kHz mono 16-bit PCM WAV — the one
		* container every ASR backend accepts, without shipping any audio library.
		*/
		/** Pick the first MediaRecorder MIME type this browser actually supports. */
		function pickMimeType() {
			if (typeof MediaRecorder === "undefined") return void 0;
			for (const candidate of [
				"audio/webm;codecs=opus",
				"audio/webm",
				"audio/mp4",
				"audio/ogg"
			]) try {
				if (MediaRecorder.isTypeSupported(candidate)) return candidate;
			} catch {}
		}
		/** Decode a compressed container into a 16 kHz mono Float32 array. */
		async function decodeToMono16k(arrayBuffer) {
			const context = new AudioContext();
			try {
				const audio = await context.decodeAudioData(arrayBuffer);
				const inRate = audio.sampleRate;
				const inLength = audio.length;
				const outLength = Math.max(1, Math.round(inLength * (16e3 / inRate)));
				const out = new Float32Array(outLength);
				for (let i = 0; i < outLength; i++) {
					const position = i * (inRate / 16e3);
					const i0 = Math.floor(position);
					const i1 = Math.min(i0 + 1, inLength - 1);
					const fraction = position - i0;
					let mono = 0;
					for (let channel = 0; channel < audio.numberOfChannels; channel++) {
						const data = audio.getChannelData(channel);
						const s0 = data[i0] ?? 0;
						const s1 = data[i1] ?? 0;
						mono += s0 + (s1 - s0) * fraction;
					}
					out[i] = mono / audio.numberOfChannels;
				}
				return out;
			} finally {
				await context.close();
			}
		}
		/** Write a 16-bit PCM WAV header plus samples into an ArrayBuffer. */
		function encodeWav(samples) {
			const dataBytes = samples.length * 2;
			const buffer = new ArrayBuffer(44 + dataBytes);
			const view = new DataView(buffer);
			const writeAscii = (offset, text) => {
				for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
			};
			writeAscii(0, "RIFF");
			view.setUint32(4, 36 + dataBytes, true);
			writeAscii(8, "WAVE");
			writeAscii(12, "fmt ");
			view.setUint32(16, 16, true);
			view.setUint16(20, 1, true);
			view.setUint16(22, 1, true);
			view.setUint32(24, 16e3, true);
			view.setUint32(28, 16e3 * 2, true);
			view.setUint16(32, 2, true);
			view.setUint16(34, 16, true);
			writeAscii(36, "data");
			view.setUint32(40, dataBytes, true);
			let offset = 44;
			for (let i = 0; i < samples.length; i++) {
				const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
				view.setInt16(offset, clamped < 0 ? clamped * 32768 : clamped * 32767, true);
				offset += 2;
			}
			return buffer;
		}
		/** One recording session producing a 16 kHz mono WAV Blob on stop. */
		var VoiceRecorder = class {
			mediaRecorder;
			stream;
			chunks = [];
			/** Whether the environment can record at all (secure context + getUserMedia). */
			get supported() {
				return typeof navigator !== "undefined" && typeof navigator.mediaDevices !== "undefined" && typeof navigator.mediaDevices.getUserMedia === "function";
			}
			/** Request the microphone and start recording. */
			async start() {
				if (!this.supported) throw new Error("microphone access requires a secure context (https or localhost)");
				this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
				this.chunks = [];
				const mimeType = pickMimeType();
				this.mediaRecorder = new MediaRecorder(this.stream, mimeType === void 0 ? void 0 : { mimeType });
				this.mediaRecorder.ondataavailable = (event) => {
					if (event.data.size > 0) this.chunks.push(event.data);
				};
				this.mediaRecorder.start();
			}
			/**
			* Stop recording and encode the captured audio.
			* @returns a 16 kHz mono WAV blob.
			*/
			stop() {
				return new Promise((resolve, reject) => {
					const recorder = this.mediaRecorder;
					if (recorder === void 0) {
						reject(/* @__PURE__ */ new Error("not recording"));
						return;
					}
					recorder.onstop = () => {
						this.releaseStream();
						const mimeType = recorder.mimeType || "audio/webm";
						const container = new Blob(this.chunks, { type: mimeType });
						this.chunks = [];
						container.arrayBuffer().then((buffer) => decodeToMono16k(buffer)).then((samples) => new Blob([encodeWav(samples)], { type: "audio/wav" })).then(resolve, reject);
					};
					recorder.onerror = () => {
						this.releaseStream();
						reject(/* @__PURE__ */ new Error("audio recording failed"));
					};
					recorder.stop();
				});
			}
			/** Stop capturing without producing audio (component unmount while recording). */
			abort() {
				if (this.mediaRecorder !== void 0 && this.mediaRecorder.state !== "inactive") {
					this.mediaRecorder.onstop = null;
					this.mediaRecorder.onerror = null;
					this.mediaRecorder.stop();
				}
				this.releaseStream();
				this.chunks = [];
			}
			releaseStream() {
				this.stream?.getTracks().forEach((track) => {
					track.stop();
				});
				this.stream = void 0;
			}
		};
		//#endregion
		//#region src/client/preferences.ts
		/** Browser storage key for the versioned Voice-Context routing record. */
		const VOICE_PREFERENCE_KEY = "dsh.voice-context.preference.v1";
		/** Local model ids exposed in the first-party settings selector. */
		const LOCAL_MODELS = [
			"iic/SenseVoiceSmall",
			"small",
			"medium",
			"large-v3"
		];
		/** Safe first-use default for a deployment with the companion local server. */
		const DEFAULT_VOICE_PREFERENCE = {
			backend: "local",
			model: "iic/SenseVoiceSmall"
		};
		/** Return whether the unknown JSON value is one of the controlled choices. */
		function isVoicePreference(value) {
			if (value === null || typeof value !== "object") return false;
			const candidate = value;
			if (candidate.backend === "cloud") return candidate.model === "FunAudioLLM/SenseVoiceSmall";
			return candidate.backend === "local" && typeof candidate.model === "string" && LOCAL_MODELS.includes(candidate.model);
		}
		/**
		* Read the preference, falling back to the production-local default.
		* @returns a validated backend/model pair.
		*/
		function loadVoicePreference() {
			if (typeof localStorage === "undefined") return DEFAULT_VOICE_PREFERENCE;
			try {
				const raw = localStorage.getItem(VOICE_PREFERENCE_KEY);
				if (raw === null) return DEFAULT_VOICE_PREFERENCE;
				const parsed = JSON.parse(raw);
				return isVoicePreference(parsed) ? parsed : DEFAULT_VOICE_PREFERENCE;
			} catch {
				return DEFAULT_VOICE_PREFERENCE;
			}
		}
		/**
		* Whether the user has explicitly saved a first-time routing choice.
		* @returns true when the versioned preference record exists.
		*/
		function hasSavedVoicePreference() {
			return typeof localStorage !== "undefined" && localStorage.getItem("dsh.voice-context.preference.v1") !== null;
		}
		/**
		* Persist one already-controlled backend/model pair.
		* @param preference - validated cloud or local routing choice.
		*/
		function saveVoicePreference(preference) {
			if (!isVoicePreference(preference)) throw new Error("invalid voice preference");
			localStorage.setItem(VOICE_PREFERENCE_KEY, JSON.stringify(preference));
		}
		//#endregion
		//#region src/client/VoiceInput.tsx
		/**
		* VoiceInput: the mic button contributed to the `conversation.input.left`
		* slot. It records an utterance, encodes it to base64, and transcribes it
		* through the injected `transcribe` Remote face, then appends the transcript
		* to the composer draft via `inputActions.setDraft`.
		*/
		/** Append a transcript to the current draft, joining on a single space. */
		function appendTranscript(draft, text) {
			const trimmed = text.trim();
			if (trimmed === "") return draft;
			return draft === "" ? trimmed : `${draft} ${trimmed}`;
		}
		/** Encode a Blob as base64 for the Remote payload. */
		async function blobToBase64(blob) {
			const bytes = new Uint8Array(await blob.arrayBuffer());
			let binary = "";
			for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
			return btoa(binary);
		}
		if (typeof document !== "undefined" && document.querySelector("style[data-vc]") === null) {
			const style = document.createElement("style");
			style.setAttribute("data-vc", "dsh-voice-context");
			style.textContent = "@keyframes vc-spin{to{transform:rotate(360deg)}}";
			document.head.appendChild(style);
		}
		function VoiceInput({ input, inputActions, transcribe }) {
			const [phase, setPhase] = (0, react.useState)("idle");
			const [error, setError] = (0, react.useState)(null);
			const recorderRef = (0, react.useRef)(null);
			const zh = typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh");
			const label = zh ? "语音输入" : "Voice input";
			const recording = phase === "recording";
			(0, react.useEffect)(() => () => {
				recorderRef.current?.abort();
			}, []);
			const toggle = (0, react.useCallback)(async () => {
				if (phase === "transcribing") return;
				if (phase === "recording") {
					const recorder = recorderRef.current;
					recorderRef.current = null;
					setPhase("transcribing");
					setError(null);
					try {
						if (recorder === null) throw new Error("recorder not started");
						const wav = await recorder.stop();
						const preference = loadVoicePreference();
						const outcome = await transcribe({
							audio: await blobToBase64(wav),
							mimeType: "audio/wav",
							backend: preference.backend,
							model: preference.model,
							...zh ? { language: "zh" } : {}
						});
						if (!outcome.ok) throw new Error(outcome.error);
						inputActions.setDraft(appendTranscript(input.draft, outcome.text));
						setPhase("idle");
					} catch (err) {
						setPhase("error");
						setError(err instanceof Error ? err.message : String(err));
					}
					return;
				}
				setPhase("idle");
				setError(null);
				try {
					const recorder = new VoiceRecorder();
					await recorder.start();
					recorderRef.current = recorder;
					setPhase("recording");
				} catch (err) {
					setPhase("error");
					setError(err instanceof Error ? err.message : String(err));
				}
			}, [
				phase,
				input.draft,
				inputActions,
				transcribe,
				zh
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "vc-mic",
				"aria-label": label,
				"aria-pressed": recording,
				title: phase === "error" && error !== null ? `${label}: ${error}` : label,
				"data-phase": phase,
				onClick: () => {
					toggle();
				},
				style: {
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					width: 28,
					height: 28,
					padding: 0,
					border: 0,
					background: "transparent",
					color: recording ? "#e5484d" : phase === "error" ? "#b8860b" : "currentColor",
					cursor: phase === "transcribing" ? "default" : "pointer",
					opacity: phase === "transcribing" ? .6 : 1
				},
				children: phase === "recording" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StopIcon, {}) : phase === "transcribing" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Spinner, {}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MicIcon, {})
			});
		}
		function MicIcon() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: "16",
				height: "16",
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "2",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "9",
						y: "2",
						width: "6",
						height: "12",
						rx: "3"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5 10v1a7 7 0 0 0 14 0v-1" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
						x1: "12",
						y1: "19",
						x2: "12",
						y2: "22"
					})
				]
			});
		}
		function StopIcon() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				width: "16",
				height: "16",
				viewBox: "0 0 24 24",
				fill: "currentColor",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "6",
					y: "6",
					width: "12",
					height: "12",
					rx: "2"
				})
			});
		}
		function Spinner() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: "16",
				height: "16",
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "2",
				"aria-hidden": "true",
				style: { animation: "vc-spin 0.8s linear infinite" },
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "12",
					cy: "12",
					r: "9",
					strokeOpacity: "0.25"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M21 12a9 9 0 0 0-9-9",
					strokeLinecap: "round"
				})]
			});
		}
		//#endregion
		//#region src/client/VoiceSettings.tsx
		/**
		* VoiceSettingsSection: the Voice-Context page in the Web settings panel.
		*
		* The API key is written through the credentials domain
		* (`credentials.set`/`credentials.unset`) addressed by the reference the Host
		* service resolves (`SILICONFLOW_API_KEY`). The value never rides a response —
		* the page only learns whether one is configured. Local backend management
		* lives on the `/voice-local` command, which this page points at.
		*/
		/** Credential reference the Host service resolves (see config.ts). */
		const KEY_REF = "SILICONFLOW_API_KEY";
		function zh() {
			return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh");
		}
		function VoiceSettingsSection({ api }) {
			const [draft, setDraft] = (0, react.useState)("");
			const [configured, setConfigured] = (0, react.useState)(false);
			const [writable, setWritable] = (0, react.useState)(true);
			const [pending, setPending] = (0, react.useState)(false);
			const [message, setMessage] = (0, react.useState)(null);
			const [preference, setPreference] = (0, react.useState)(loadVoicePreference);
			const [preferenceSaved, setPreferenceSaved] = (0, react.useState)(hasSavedVoicePreference);
			const refresh = (0, react.useCallback)(async () => {
				try {
					const response = await api.credentials.describe({ refs: [KEY_REF] });
					if (!response.result.ok) return;
					const view = response.result.value.credentials[KEY_REF];
					setConfigured(view?.configured ?? false);
					setWritable(view?.writable ?? true);
				} catch {}
			}, [api]);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			const save = (0, react.useCallback)(async () => {
				setPending(true);
				setMessage(null);
				try {
					if (draft.trim() === "") await api.credentials.unset({ ref: KEY_REF });
					else await api.credentials.set({
						ref: KEY_REF,
						value: draft.trim()
					});
					setDraft("");
					await refresh();
					setMessage(zh() ? "已保存" : "Saved");
				} catch {
					setMessage(zh() ? "保存失败" : "Save failed");
				} finally {
					setPending(false);
				}
			}, [
				api,
				draft,
				refresh
			]);
			const lang = zh();
			const selectBackend = (0, react.useCallback)((backend) => {
				setPreference({
					backend,
					model: backend === "cloud" ? "FunAudioLLM/SenseVoiceSmall" : "iic/SenseVoiceSmall"
				});
				setPreferenceSaved(false);
				setMessage(null);
			}, []);
			const selectModel = (0, react.useCallback)((model) => {
				setPreference((current) => ({
					...current,
					model
				}));
				setPreferenceSaved(false);
				setMessage(null);
			}, []);
			const saveRouting = (0, react.useCallback)(() => {
				try {
					saveVoicePreference(preference);
					setPreferenceSaved(true);
					setMessage(lang ? "语音配置已保存" : "Voice configuration saved");
				} catch {
					setMessage(lang ? "语音配置保存失败" : "Voice configuration save failed");
				}
			}, [lang, preference]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 12,
					padding: "16px 20px",
					maxWidth: 520
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						style: {
							margin: 0,
							fontSize: 16,
							fontWeight: 600
						},
						children: lang ? "语音输入（Voice-Context）" : "Voice-Context"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: {
							margin: 0,
							fontSize: 13,
							opacity: .8,
							lineHeight: 1.6
						},
						children: lang ? "首次使用请选择云端 API 或本地离线模型；麦克风会按此选择逐次转写。" : "For first use, choose the cloud API or a local offline model; the mic uses this choice for every transcription."
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 8,
							margin: 0,
							padding: 12,
							border: "1px solid rgba(128,128,128,0.35)",
							borderRadius: 8
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", {
								style: {
									padding: "0 4px",
									fontSize: 13
								},
								children: lang ? "处理方式" : "Processing"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									display: "flex",
									gap: 16,
									fontSize: 13
								},
								children: ["local", "cloud"].map((backend) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: {
										display: "inline-flex",
										alignItems: "center",
										gap: 6
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "radio",
										name: "voice-backend",
										value: backend,
										checked: preference.backend === backend,
										onChange: () => {
											selectBackend(backend);
										}
									}), backend === "local" ? lang ? "本地离线" : "Local offline" : lang ? "云端 API" : "Cloud API"]
								}, backend))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: {
									display: "flex",
									flexDirection: "column",
									gap: 6,
									fontSize: 13
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: lang ? "转写模型" : "Transcription model" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
									value: preference.model,
									onChange: (event) => {
										selectModel(event.target.value);
									},
									style: {
										padding: "8px 10px",
										fontSize: 13,
										borderRadius: 6,
										border: "1px solid rgba(128,128,128,0.4)",
										background: "transparent",
										color: "inherit"
									},
									children: preference.backend === "cloud" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "FunAudioLLM/SenseVoiceSmall",
										children: "SenseVoiceSmall (SiliconFlow)"
									}) : LOCAL_MODELS.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: model,
										children: model === "iic/SenseVoiceSmall" ? "SenseVoiceSmall（中文优先）" : `faster-whisper ${model}`
									}, model))
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									gap: 10
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: saveRouting,
									style: {
										padding: "7px 14px",
										fontSize: 13,
										borderRadius: 6,
										border: "1px solid rgba(128,128,128,0.4)",
										background: "transparent",
										color: "inherit",
										cursor: "pointer"
									},
									children: lang ? "保存语音配置" : "Save voice configuration"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 12,
										opacity: .75
									},
									children: preferenceSaved ? lang ? "已配置" : "Configured" : lang ? "尚未保存" : "Not saved"
								})]
							})
						]
					}),
					preference.backend === "cloud" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 6,
							fontSize: 13
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: lang ? "API Key" : "API key" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "password",
							value: draft,
							placeholder: lang ? `配置 ${KEY_REF} 的值` : `value for ${KEY_REF}`,
							disabled: !writable,
							onChange: (event) => {
								setDraft(event.target.value);
							},
							style: {
								padding: "8px 10px",
								fontSize: 13,
								borderRadius: 6,
								border: "1px solid rgba(128,128,128,0.4)",
								background: "transparent",
								color: "inherit"
							}
						})]
					}),
					preference.backend === "cloud" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 10
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => {
									save();
								},
								disabled: pending || !writable,
								style: {
									padding: "7px 14px",
									fontSize: 13,
									borderRadius: 6,
									border: "1px solid rgba(128,128,128,0.4)",
									background: "transparent",
									color: "inherit",
									cursor: pending ? "default" : "pointer",
									opacity: pending ? .6 : 1
								},
								children: lang ? "保存" : "Save"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 12,
									opacity: .75
								},
								children: configured ? lang ? "已配置" : "Configured" : lang ? "未配置" : "Not configured"
							}),
							message !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 12,
									opacity: .85
								},
								role: "status",
								children: message
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: {
							margin: 0,
							fontSize: 12,
							opacity: .65,
							lineHeight: 1.6
						},
						children: lang ? "本地模型按需切换；首次加载大模型会较慢。服务管理：/voice-local status|install|start|stop。" : "Local models switch on demand; the first large-model load is slower. Manage the service with /voice-local status|install|start|stop."
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** The browser services this plugin consumes. */
		const inject = ["slots", "connection"];
		/** Host channel carrying the `transcribe` endpoint. */
		const CHANNEL = "/voice-context";
		/**
		* Client plugin body: contribute the mic control and the settings page.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const connection = ctx.get("connection");
			const transcribe = async (request) => {
				try {
					const result = await connection.rpc.call(CHANNEL, "transcribe", { args: request });
					if (!result.ok) return {
						ok: false,
						error: result.error.message
					};
					const value = result.value;
					return {
						ok: true,
						text: typeof value?.text === "string" ? value.text : ""
					};
				} catch (error) {
					return {
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					};
				}
			};
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "voice-context",
				order: 100,
				inject: () => ({ transcribe })
			}, VoiceInput));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "voice-context",
				order: 40,
				label: () => typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh") ? "语音输入" : "Voice input",
				inject: () => ({ api: connection.api })
			}, VoiceSettingsSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map