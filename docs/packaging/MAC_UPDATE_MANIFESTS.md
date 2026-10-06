# Mac 自动更新清单

自 0.6.840 起，Mac 客户端按**运行程序的架构**选择更新清单。更新源仍为一个 HTTP(S) 目录，不需要在设置中填写 JSON 文件名。

| 程序架构 | 平台 | 清单文件 | 默认安装包 |
| --- | --- | --- | --- |
| `arm64` | Apple Silicon | `latest-mac.json` | `Sage-<version>-arm64.dmg` |
| `x64` | Intel | `latest-mac-intel.json` | `Sage-<version>.dmg` |

Intel 安装包没有 `-x64` 后缀，这是当前 electron-builder 的实际默认产物名称。在 Apple Silicon 上以 Rosetta 运行的 x64 程序也读取 Intel 清单。运行架构不受构建机器或物理 CPU 名称影响。

## 客户端行为

检查更新、更新源自检、下载前重新读取清单、已下载版本的新版探测及切换新版使用同一个架构映射。Intel 清单缺失、无效或对应安装包不可下载时明确报错，不会读取 ARM 清单、使用 ARM 安装包或寻找旧包。

更新源优先级保持原行为：可用中继的 `/updates` 目录优先；没有可用中继时使用用户配置的 `updateServerUrl`。设置页自检传入的目录地址可以临时覆盖已保存地址。清单生成脚本的配置优先级是 `SAGE_UPDATE_BASE`、项目根目录 `.sage-update-base`、上一份清单恢复的目录（先 ARM，缺失时再 Intel）。

新清单包含 `version`、`arch`（`arm64` 或 `x64`）、`url`、`sha256`、`notes` 和 `publishedAt`。`sha256` 分别由两个实际安装包的字节计算，下载和安装前继续执行校验。客户端兼容没有 `arch` 字段的自定义清单，但若提供 `arch`，必须与运行程序一致；标准 Sage 安装包名称中明确的架构和版本也必须匹配。自定义目录和自定义安装包名称继续按清单 URL 下载。

**旧 Intel 客户端的兼容边界：** 0.6.840 之前的程序仍只请求 `latest-mac.json`。该文件继续保持 ARM 定义，因此旧 Intel 客户端需要先手动下载并安装 0.6.840 或更高版本的 Intel 包，此后才使用 `latest-mac-intel.json`。为旧客户端把 ARM 清单临时改指 Intel 包会破坏 Apple Silicon 更新，不能采用。

## 生成与发布

正常双架构构建完成后，`scripts/gen-latest.js` 同时生成两个本地清单。必须存在**当前 package.json 版本**的两个普通、非空安装包；缺少任意一个时脚本失败并保留既有清单，不会搜索旧版本作兜底。

也可显式生成，命令只生成本地文件，不执行上传：

```sh
node scripts/publish-update.js https://your.example/updates \
  --dmg /absolute/path/Sage-0.6.840-arm64.dmg \
  --intel-dmg /absolute/path/Sage-0.6.840.dmg \
  --notes "本次发布说明"
```

原有 `--dmg` 参数继续表示 ARM 包，`--intel-dmg` 表示 Intel 包。显式路径可以在其他目录，但文件名必须匹配当前版本及对应架构的默认产物名称，避免误传旧包或另一个架构的包。

先上传两个安装包并核对 URL 和 SHA-256，再替换各自清单。两个清单的内容先完整准备到临时文件，每份通过重命名替换；后一次替换失败时脚本还原已替换清单。跨两个文件的提交不是单次文件系统事务，服务器发布也应避免在安装包未就绪时提前切换指针。

## download 目录清理

清理程序遍历所有 `latest-*.json`，保护每份清单引用的安装包及其 `.blockmap`、`.sha256`。`latest-mac.json` 与 `latest-mac-intel.json` 同时生效，即使 Intel 指向较旧版本，也不会被 ARM 新版本的清理规则误删。清单损坏或清理期间发生变化时停止删除。

离线验证命令：

```sh
node scripts/test-mac-update-manifests.cjs
node scripts/test-update-source.cjs
node scripts/test-update-integrity.cjs
node scripts/test-update-cancel.cjs
node tools/sage-website/test-download-cleanup.cjs
```
