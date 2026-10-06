#!/bin/bash
# 快捷打包命令：完成功能后直接运行此脚本打包 dmg

set -e

echo "🔨 开始打包 Sage..."
echo ""

# 切换到项目目录
cd "$(dirname "$0")"

# 加载 NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# 检查 node/npm
if ! command -v node &> /dev/null; then
    echo "❌ 错误：未找到 node，请确保 NVM 已安装"
    exit 1
fi

echo "📦 Node 版本: $(node -v)"
echo "📦 npm 版本: $(npm -v)"
echo ""

# 执行打包（完整构建 + 签名 + 重建 dmg，不启动 app）
bash scripts/sign-local.sh --no-run

echo ""
echo "✅ 打包完成！"
echo ""
echo "📦 dmg 文件: release/Sage-0.1.0-arm64.dmg"
echo ""

# 显示文件信息
ls -lh release/Sage-0.1.0-arm64.dmg 2>/dev/null || echo "⚠️  未找到 dmg 文件"
echo ""

# 验证签名
echo "🔍 验证签名..."
codesign -dv release/mac-arm64/Sage.app 2>&1 | grep -E "Signature|Identifier" | sed 's/^/   /'
echo ""

echo "🎉 可以分发 dmg 文件了！"
