# dsh-voice-context

**DeepSeek Harness（桌面端 / Web）语音转文字插件** —— 在输入框左侧加一个麦克风按钮，说话即转写进草稿；支持**云端 API**（SiliconFlow SenseVoiceSmall）与**本地离线**（FunASR / faster-whisper）两条路径。

- 符合 DSH 插件规范：`dsh.bundle`（宿主补丁层）+ `dsh.client`（浏览器半），一个包双面。
- 通信走 **Connection RPC 通道**（`/voice-context`），与官方 Remote 同一条受信任传输，**Web GUI 与 Electron 桌面端通用**，无需改动任何一方包。
- 可直接从 GitHub 安装。

## 安装

> 桌面端自带 `dsh` 命令：`<安装目录>\resources\runtime\cli\bin\dsh.cmd`

```sh
# 从 GitHub 安装（推荐）
dsh plugin --profile desktop add github:CharlesLiuZC/dsh-voice-context

# 或从本地目录安装
dsh plugin --profile desktop add /path/to/dsh-voice-context
```

安装后**重启应用**（宿主在启动时组装插件层），输入框左侧即出现麦克风按钮。

卸载：

```sh
dsh plugin --profile desktop remove dsh-voice-context
```

## 使用

1. 点输入框左侧的 **麦克风** → 说话 → 再点一次停止；转写文本自动追加到当前草稿。
2. 在 **设置 → 语音输入** 里选择处理方式：
   - **云端 API**：填 `SILICONFLOW_API_KEY`（写入 DSH 凭据域，不落响应、不回显）。
   - **本地离线**：无需密钥，走本机 `127.0.0.1:8000` 的后端。

首次使用建议先选一种方式，麦克风会按该选择逐次转写。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `voice-context` 行（默认值见下）：

```yaml
- id: voice-context
  name: 'dsh-voice-context'
  config:
    baseUrl: https://api.siliconflow.cn   # OpenAI 兼容 STT 服务地址
    model: FunAudioLLM/SenseVoiceSmall    # 云端默认模型
    language: zh                          # 语言提示
    localPort: 8000                       # 本地后端端口
    pythonBin: python                     # 本地后端使用的 Python
    apiKeyEnv: SILICONFLOW_API_KEY        # 凭据引用名
    maxBytes: 26214400                    # 音频上限（字节）
    timeoutMs: 60000                      # 上游超时
```

## 本地离线后端

本包内置一个 OpenAI 兼容的本地 STT 服务（`local/funasr/`），由 `/voice-local` 命令管理：

```sh
/voice-local status    # 硬件与依赖自检
/voice-local install   # 装 funasr + faster-whisper + CPU torch
/voice-local start     # 在 127.0.0.1:8000 启动
/voice-local stop
```

模型选择（兼顾速度与准确度）：

| 引擎 | 中文 | 速度 | 体积 | 说明 |
|---|---|---|---|---|
| FunASR SenseVoiceSmall（默认） | 高 | 极快（非自回归） | ~1GB | 中文首选，CPU 可跑 |
| faster-whisper `small` | 中 | 快 | ~1GB | 多语言、速度优先 |
| faster-whisper `medium` | 中高 | 中 | ~3GB | 多语言、准确优先 |
| faster-whisper `large-v3` | 高 | 慢 | ~6GB | 多语言、最高准确 |

`local/funasr/` 也可**独立部署**（不经 DSH）：见该目录的 README，暴露标准 `POST /v1/audio/transcriptions`。

## 工作原理

```
浏览器半 (lib/client.js)               宿主半 (lib/index.js)
  ├─ conversation.input.left 麦克风      ├─ connection.rpc.handle('/voice-context', …)
  ├─ settings.section 设置页      ──►    │    └─ transcribe 端点
  └─ connection.rpc.call('/voice-context','transcribe',{args})
                                          ├─ 凭据域解析 API Key（每次请求）
                                          ├─ 云端：转发 /v1/audio/transcriptions
                                          └─ 本地：转发 127.0.0.1:<localPort>
```

- 通道 `authority: 'loopback'`：仅本机可用，密钥与本地后端不会暴露给其他来源。
- 音频以 base64 走 JSON（浏览器录 WAV，16kHz 单声道）；上限由 `maxBytes` 约束。
- 转写是**人类输入**，不进入模型的 tool 调用。

## 开发

```sh
pnpm install
pnpm build      # 产出 lib/index.js（宿主，ESM）+ lib/client.js（浏览器 bundle）
pnpm typecheck
```

`lib/` 是构建产物；本仓库已提交构建结果，因此从 GitHub 安装无需在本地再构建。

## 许可

MIT
