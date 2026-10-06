# 对话删除失败问题修复

> 历史归档：保留原始记录，不作为当前版本的操作或接口规范。当前入口见 [文档索引](../README.md)。

## 问题描述

用户报告某些对话无法删除。点击删除按钮后，对话仍然显示在列表中。

## 根本原因

### 删除流程分析

1. **前端** (`src/stores/appStore.ts`)
   - 调用 `window.api.deleteConv(id)` 只传递对话 ID
   - 不检查返回值，直接调用 `refreshConversations()` 刷新列表

2. **后端** (`electron/ipc.ts`)
   - `ConvDelete` handler 调用 `getConvCached(id)` 获取对话元数据
   - 如果缓存未命中，调用 `findConvById(id)` 扫描所有项目
   - `findConvById` 只扫描 `settings.json` 中的项目列表
   - 如果项目不在列表中（例如被移除），返回 `null`
   - Handler 返回 `{ ok: false }`，但前端不检查这个返回值

3. **问题场景**
   - 对话存在于磁盘上（`.sage/chats/<id>/meta.json`）
   - 但项目不在 `settings.json` 的 `projects` 数组中
   - `findConvById` 无法找到对话，返回 `null`
   - 删除操作失败，但前端不知道，继续刷新列表
   - 刷新时直接从磁盘读取，对话仍然存在

### 验证问题

检查 `settings.json`：
```bash
cat ~/Library/Application\ Support/Sage/settings.json | jq '.projects | length'
# 输出: 0 (项目列表为空！)
```

但对话文件存在：
```bash
ls .sage/chats/R2D_-UFJ/meta.json
# 文件存在，projectPath: "/Users/alacner/sandbox/sage"
```

## 解决方案

### 核心思路

让前端在删除对话时传递 `projectPath`，后端直接用 `projectPath` 删除，不依赖 `findConvById` 的全局扫描。

### 代码修改

#### 1. 后端 IPC Handler (`electron/ipc.ts`)

```typescript
// 修改前
ipcMain.handle(IpcChannels.ConvDelete, async (_e, id: string) => {
  const meta = await getConvCached(id);
  if (!meta) return { ok: false };
  await deleteConv(meta);
  convCache.delete(id);
  return { ok: true };
});

// 修改后
ipcMain.handle(IpcChannels.ConvDelete, async (_e, args: { id: string; projectPath?: string }) => {
  let meta = await getConvCached(args.id);
  // 如果缓存里没有，但有 projectPath，直接从磁盘加载
  if (!meta && args.projectPath) {
    meta = await loadConv(args.projectPath, args.id);
    if (meta) convCache.set(args.id, meta);
  }
  if (!meta) return { ok: false };
  await deleteConv(meta);
  convCache.delete(args.id);
  return { ok: true };
});
```

**关键改进**：
- 接受 `projectPath` 参数（可选，保持向后兼容）
- 如果缓存未命中但有 `projectPath`，直接从指定项目路径加载
- 导入 `loadConv` 函数用于直接加载对话

#### 2. Preload API (`electron/preload.ts`)

```typescript
// 修改前
deleteConv: (id: string) => ipcRenderer.invoke(IpcChannels.ConvDelete, id),

// 修改后
deleteConv: (id: string, projectPath?: string) =>
  ipcRenderer.invoke(IpcChannels.ConvDelete, { id, projectPath }),
```

#### 3. 前端 Store (`src/stores/appStore.ts`)

```typescript
// 修改前
deleteConversation: async (id) => {
  await window.api.deleteConv(id);
  if (get().currentConversation?.id === id) set({ currentConversation: undefined });
  await get().refreshConversations();
},

// 修改后
deleteConversation: async (id) => {
  const proj = get().currentProject;
  await window.api.deleteConv(id, proj?.path);
  if (get().currentConversation?.id === id) set({ currentConversation: undefined });
  await get().refreshConversations();
},
```

**关键改进**：
- 获取当前项目的 `projectPath`
- 传递给 `deleteConv` API
- 后端可以直接从指定路径加载和删除对话

## 向后兼容性

- `projectPath` 参数是可选的
- 如果不传 `projectPath`，仍然使用原来的 `getConvCached` + `findConvById` 逻辑
- 老版本的前端代码仍然可以正常工作

## 测试验证

1. 重启应用
2. 尝试删除之前无法删除的对话
3. 验证对话是否成功删除
4. 检查磁盘上的对话目录是否被移除

## 相关文件

- `electron/ipc.ts` - IPC handler
- `electron/preload.ts` - API 定义
- `electron/store.ts` - `loadConv`, `deleteConv` 函数
- `src/stores/appStore.ts` - 前端 store
- `src/components/Sidebar.tsx` - 删除按钮 UI

## 总结

这个问题的根本原因是：删除对话时依赖全局扫描来定位对话文件，但当项目不在 `settings.json` 中时，扫描失败。通过让前端传递 `projectPath`，后端可以直接从指定路径加载和删除对话，避免了对全局扫描的依赖。
