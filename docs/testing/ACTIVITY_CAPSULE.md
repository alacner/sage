# 对话底部合并状态条

0.6.752 将排队消息计数合并到执行计划、文件变更之后。没有队列时不显示该段，只有队列时仍为完整胶囊，所有内容为空时隐藏外框。

执行计划运行或正在恢复时显示旋转图标，停止及等待继续时保留清单图标。窄窗口优先保留图标，计划文字过长显示省略号。

## 验证

```sh
SAGE_TEST_ELECTRON=/path/to/Electron.app/Contents/MacOS/Electron node docs/testing/electron-validation/scripts/run.cjs --project . --timeout 90000 -- node scripts/test-activity-capsule.cjs
npm run typecheck
npm run test:chat-rendering
```

测试在隔离 profile 的真实 Electron 窗口加载生产组件和 store，检查组合顺序、队列更新、恢复回调、文件变更导航、图标动画、窄屏图标边界、单项及空状态，并保存截图和 evidence.json。会话数据、恢复回调和窗口外壳为 fixture；点击使用 DOM API，未宣称操作系统输入或完整已安装应用的端到端覆盖。
