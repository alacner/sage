# 窗口级模态蒙版

需要阻止整个窗口交互的弹窗使用 `src/components/WindowOverlay.tsx`。它将蒙版 Portal 到 document.body，固定覆盖整个渲染窗口，并覆盖浮动浏览器。不要仅在右侧内容容器中设置 fixed：父级 transform、contain 或裁切可能改变其覆盖范围。

已统一停止对话、文件拖入选择、语音授权提示、通用确认、反馈、更新、关于、用量统计、引导、组合模型添加、浏览器收藏和设备编辑、Git 分支以及工作流弹窗。接入点随模块拆分变化，以检查脚本扫描的实际调用为准，不依赖历史数量。图片、Mermaid、定时任务、完整权限及模型探测日志弹窗已有 body Portal。菜单点击外部关闭层和文件拖入高亮属于局部交互，不改为模态弹窗。

从 0.6.789 开始，WindowOverlay 负责初始焦点、最上层 Tab 循环与关闭后焦点恢复；使用 `data-autofocus` 指定初始控件，使用 `onEscape` 接入统一关闭行为。窗口中的具体 dialog 应提供可访问名称；通用确认框默认聚焦取消。工作区快捷键在模态层打开时暂停。该机制仅覆盖接入 WindowOverlay 的窗口，不应将其他独立 Portal 自动视为同一模态层。

验证：`npm run test:workspace-ux` 检查接入点和键盘焦点行为；`node scripts/test-browser-agent.cjs` 在真实 Electron 窗口中将入口放进右侧带 transform 和 overflow 的容器，验证蒙版坐标为窗口原点、尺寸覆盖全窗，以及左侧点击落在蒙版上。
