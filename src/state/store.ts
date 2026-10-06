/**
 * 状态存储
 *
 * 维护当前状态，提供获取当前状态和计算/更新新状态的方法。
 * 每次更新时生成新旧状态快照（浅拷贝只读副本），并交由事件分发器
 * 通知已注册的监听器。
 *
 * 数据流对应:
 *   步骤 4 - 核心逻辑触发状态变更时，计算新状态并将新旧快照传递给事件分发模块
 *
 * 依据: US-2.AC-2.1
 */

import type { StateSnapshot, StateUpdater } from './types';
import { Dispatcher } from './dispatcher';

/**
 * 状态存储。
 *
 * 负责持有当前状态，对外提供只读快照访问，以及安全的状态更新流程：
 *   1. 对当前状态生成旧快照（浅拷贝）
 *   2. 通过 updater 函数或新状态值计算新状态
 *   3. 对新状态生成新快照（浅拷贝）
 *   4. 通过 Dispatcher 将新旧快照分发给所有监听器
 *
 * @typeParam S - 状态结构类型
 */
export class Store<S extends object> {
  /** 当前内部状态 */
  private state: S;

  /** 事件分发器，用于通知监听器状态变更 */
  private readonly dispatcher: Dispatcher<S>;

  /**
   * @param initialState - 初始状态
   * @param dispatcher - 事件分发器实例，由外部注入以便与生命周期模块共享
   */
  constructor(initialState: S, dispatcher: Dispatcher<S>) {
    this.state = initialState;
    this.dispatcher = dispatcher;
  }

  /**
   * 获取当前状态的只读快照。
   *
   * 返回浅拷贝副本，防止外部直接修改内部状态。
   */
  getState(): StateSnapshot<S> {
    return this.createSnapshot(this.state);
  }

  /**
   * 通过更新函数计算并应用新状态。
   *
   * updater 接收当前状态快照，返回新状态。更新完成后，
   * 新旧快照会被分发给所有通过 Dispatcher 注册的监听器。
   *
   * @param updater - 状态更新函数，基于旧状态计算新状态
   */
  setState(updater: StateUpdater<S>): void {
    const oldSnapshot = this.createSnapshot(this.state);
    const next = updater(oldSnapshot);
    this.state = next;
    const newSnapshot = this.createSnapshot(next);
    this.dispatcher.dispatch(newSnapshot, oldSnapshot);
  }

  /**
   * 创建状态的只读快照（浅拷贝）。
   *
   * 使用 `Object.assign` 生成顶层浅拷贝，并通过 `Readonly<S>` 类型
   * 在编译期阻止外部修改。这确保了状态变更只能经过 `setState` 流程，
   * 监听器拿到的新旧快照始终是不可变的。
   */
  private createSnapshot(source: S): StateSnapshot<S> {
    return Object.assign(Object.create(null), source) as StateSnapshot<S>;
  }
}
