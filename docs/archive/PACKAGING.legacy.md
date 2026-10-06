# Sage 打包规范

> 历史归档：旧脚本说明，不作为当前发布流程。请使用 [当前打包规范](../PACKAGING.md)。

## 📦 打包要求

**所有代码调整后，必须重新打包 dmg。**

## 🚀 打包命令

### 完整打包（推荐）

```bash
./scripts/sign-local.sh --no-run
```

这个命令会：
1. 重新构建前端和 electron
2. 使用 electron-builder 打包
3. 执行 afterSign 钩子（ad-hoc 签名 + hardened runtime）
4. 重建 dmg
5. 清除所有扩展属性（quarantine + provenance）
6. 弹出挂载的镜像
7. **不启动 app**（`--no-run` 参数）

### 仅签名（跳过构建）

```bash
./scripts/sign-local.sh --no-build --no-run
```

适用于：只修改了代码逻辑，不需要重新构建的情况。

### 完整流程（构建 + 签名 + 启动）

```bash
./scripts/sign-local.sh
```

适用于：开发调试，需要立即启动 app 查看效果。

## 📋 打包流程说明

### 1. 构建阶段

```bash
npm run build
```

- 构建前端（Vite）
- 编译 electron（TypeScript）

### 2. 打包阶段

```bash
npx electron-builder --mac dmg --arm64
```

- 打包成 .app
- 触发 afterSign 钩子
- 生成 dmg

### 3. 签名阶段（afterSign 钩子）

```bash
scripts/after-sign.js
```

自动执行：
- 清除扩展属性（quarantine + provenance）
- 移除 electron-builder 默认的不完整签名
- 对 native 模块（node-pty）进行 ad-hoc + runtime 签名
- 对 Electron 框架进行 ad-hoc + runtime 签名
- 对主可执行文件进行 ad-hoc + runtime + entitlements 签名
- 对 app 外壳进行 ad-hoc + runtime + entitlements 签名（保留 claude 的 Developer ID）
- 验证签名
- 清除最终扩展属性

### 4. dmg 重建（sign-local.sh）

```bash
# 弹出已挂载的 Sage dmg
hdiutil detach /dev/diskN -force

# 重建 dmg
npx electron-builder --mac dmg --arm64 --prepackaged release/mac-arm64

# 清除 dmg 的所有扩展属性
xattr -c release/Sage-*.dmg

# 再次弹出新挂载的 dmg
hdiutil detach /dev/diskN -force
```

## ✅ 验证打包结果

### 检查 dmg 文件

```bash
ls -lh release/Sage-*.dmg
```

应该看到：`Sage-0.1.0-arm64.dmg` (约 194MB)

### 检查扩展属性

```bash
xattr -l release/Sage-0.1.0-arm64.dmg
```

应该看到：
- `com.apple.FinderInfo: deviddsk`（正常，dmg 文件系统信息）
- `com.apple.provenance: `（值为空，表示已清除）

### 检查签名

```bash
codesign -dv release/mac-arm64/Sage.app 2>&1 | grep -E "Signature|Identifier"
```

应该看到：
- `Identifier=dev.sage.app`
- `Signature=adhoc`

### 检查 claude 二进制签名

```bash
codesign -dvv release/mac-arm64/Sage.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude 2>&1 | grep "Authority"
```

应该看到：
- `Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)`

（保留 Anthropic 的合法签名，不要被重签）

### 检查挂载状态

```bash
hdiutil info | grep Sage
```

应该为空（无挂载）。

产物核验统一走一条命令（挂载 → 查污染 → 卸载 → 清 LS 死注册 → 重注册本机安装版）：

```bash
npm run verify:dmg            # 默认取 release/ 下最新的 *-arm64.dmg
npm run verify:dmg -- release/Sage-0.6.481-arm64.dmg
```

### LaunchServices 死注册（Dock 空白格子的成因）

每次 `hdiutil attach` 都会为卷内 `Sage.app` 主包 + 4 个 helper 在 LaunchServices
建记录，**卷卸载后记录不会自动消失**。记录攒多了，系统按 bundle id 解析「哪个是
Sage」就可能命中不存在的路径，Dock 表现为「格子在、运行点亮着、图标一片空白」。

```bash
npm run clean:lsregister -- --dry-run        # 先看命中哪些路径，不动数据
npm run clean:lsregister                      # 真正注销
npm run clean:lsregister -- --dry-run '^/Volumes/Sage'   # 自定义路径正则
```

脚本只注销**磁盘上已不存在**的路径，不会碰 `/Applications/Sage.app` 和 `release/`
下的本地构建。`scripts/sign-local.sh` 已在重建 dmg 后自动执行一次。

## 🎯 打包检查清单

每次打包后，确认以下项目：

- [ ] `release/Sage-<版本>-arm64.dmg` 存在
- [ ] dmg 大小约 194MB
- [ ] dmg 扩展属性已清除（provenance 为空）
- [ ] app 签名通过（valid on disk）
- [ ] claude 二进制保留 Anthropic 签名
- [ ] 无 dmg 挂载（hdiutil info 无 Sage）
- [ ] `npm run verify:dmg` 通过（含 LaunchServices 死注册清理）

## 📝 注意事项

### NVM 环境

打包脚本依赖 NVM，确保 `~/.nvm/nvm.sh` 存在：

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
```

### 弹出旧镜像

打包前如果有旧 dmg 挂载，必须先弹出：

```bash
hdiutil detach /dev/diskN -force
```

或者让脚本自动处理（已内置此逻辑）。

### 扩展属性清理

macOS 26+ 的 provenance 属性会触发 Gatekeeper 重新评估，必须清除：

```bash
xattr -c release/Sage-*.dmg
```

### claude 二进制保护

`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` 保留了 Anthropic 的 Developer ID 签名，**不要重签**，否则会破坏合法性。

## 🔄 自动化建议

可以考虑：
1. **Git hook**：在 `pre-push` 或 `post-commit` 自动打包
2. **CI/CD**：每次 push 到 main 自动打包
3. **快捷命令**：创建 alias `sage-pack="./scripts/sign-local.sh --no-run"`

## 📦 打包产物位置

- **dmg**: `release/Sage-0.1.0-arm64.dmg`
- **app**: `release/mac-arm64/Sage.app`
- **blockmap**: `release/Sage-0.1.0-arm64.dmg.blockmap`

## 🐛 故障排除

### 问题：打包失败，提示 disk 已挂载

**解决**：手动弹出

```bash
hdiutil info | grep -B1 "Sage" | grep "^/dev/disk" | awk '{print $1}' | xargs -I {} hdiutil detach {} -force
```

### 问题：签名校验失败

**解决**：清除后重新签名

```bash
xattr -cr release/mac-arm64/Sage.app
./scripts/sign-local.sh --no-build --no-run
```

### 问题：app 无法启动

**原因**：可能是 claude 二进制签名被破坏

**解决**：检查 claude 二进制签名

```bash
codesign -dvv release/mac-arm64/Sage.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude 2>&1 | grep "Authority"
```

如果显示 `Authority=Ad-Hoc`，说明被重签了，需要重新打包。

### 问题：dmg 打开后提示损坏

**原因**：扩展属性未清除

**解决**：

```bash
xattr -c release/Sage-0.1.0-arm64.dmg
```

## 📚 相关文档

- [electron-builder 官方文档](https://www.electron.build/)
- [macOS 代码签名指南](https://developer.apple.com/documentation/security/code-signing-services)
- [Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime)

---

**最后更新**: 2026-08-16
**维护者**: Sage Team
