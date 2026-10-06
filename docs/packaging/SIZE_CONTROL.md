# 发布包体积控制

从 0.6.839 起，`scripts/after-pack.js` 在 electron-builder 的暂存 App 内运行
`prune-packaged-app.cjs`，在签名和 DMG 创建之前清理。源码、开发依赖、原始资源、
Vite source map 配置和本地构建产物均不因这一步修改。

当前清理范围：

- 每个 macOS 包只保留与目标架构相符的 Claude 引擎，排除另一架构。
- `app.asar` 中的 `.map` 调试文件；原始 source map 仍留在开发构建中。
- `cytoscape-fcose/demo` 示例素材，保留图布局运行时代码。

保留 Mermaid 的完整运行时代码，尤其是移动端导出读取的
`node_modules/mermaid/dist/mermaid.min.js`。保留 node-pty 解包方式及原生可执行权限。
其他生产依赖暂不整体排除，以免影响动态加载及插件功能。

清理在临时目录重建 ASAR，校验关键文件后替换暂存产物，最后删除临时目录。
构建输出每个架构删除的文件字节数；该数值不等于压缩后 DMG 的节省量。

验证：`node scripts/test-package-pruning.cjs`，覆盖双架构过滤、source map 排除、
原始文件保持不变、移动端 Mermaid、布局运行时和原生文件权限。
发布时另检查双架构实际 ASAR、签名与 DMG。
