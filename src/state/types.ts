/**
 * 状态模块 - 类型定义
 *
 * 定义状态快照、监听器回调与状态更新函数的 TypeScript 类型。
 * 状态机模块与事件分发模块共享这些类型契约。
 *
 * 依据: US-2.AC-2.1
 */

/**
 * 状态快照。
 *
 * 表示某一时刻状态的只读副本。通过 `Readonly<S>` 保证外部无法
 * 直接修改快照内容，确保状态变更必须经过 Store 的更新流程。
 *
 * @typeParam S - 状态结构类型，必须是普通对象
 */
export type StateSnapshot<S> = Readonly<S>;

/**
 * 状态变更监听器回调。
 *
 * 当状态发生更新时，事件分发器会遍历调用所有已注册的监听器，
 * 并将新旧状态快照作为参数传入。
 *
 * @typeParam S - 状态结构类型
 * @param newState - 更新后的状态快照
 * @param oldState - 更新前的状态快照
 */
export type StateListener<S> = (
  newState: StateSnapshot<S>,
  oldState: StateSnapshot<S>,
) => void;

/**
 * 状态更新函数。
 *
 * 接收当前状态快照，返回计算后的新状态。Store 在执行更新时
 * 会先获取旧快照，调用该函数得到新状态，再分发新旧快照给监听器。
 *
 * @typeParam S - 状态结构类型
 * @param prevState - 更新前的状态快照
 * @returns 计算后的新状态
 */
export type StateUpdater<S> = (prevState: StateSnapshot<S>) => S;
