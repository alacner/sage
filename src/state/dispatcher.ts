/**
 * 事件分发器
 *
 * 提供订阅（注册监听器）与分发（触发回调）能力。
 * 在遍历执行回调时，使用 try-catch 捕获单个监听器的异常并记录错误日志，
 * 确保一个监听器抛出的错误不会影响其他监听器的执行。
 *
 * 数据流对应:
 *   步骤 3 - 业务子模块通过此模块向状态机注册监听器
 *   步骤 5 - 遍历执行已注册的回调函数，通知业务子模块
 *
 * 依据: US-2.AC-2.2
 */

import type { StateListener } from './types';

/**
 * 事件分发器。
 *
 * 管理一组状态变更监听器，支持注册（subscribe）与触发（dispatch）。
 * `subscribe` 返回一个取消订阅函数，方便业务子模块在生命周期结束时
 * 清理自身注册的回调。
 *
 * @typeParam S - 状态结构类型
 */
export class Dispatcher<S> {
  /** 已注册的监听器集合，使用 Set 保证同一引用不会重复注册 */
  private listeners = new Set<StateListener<S>>();

  /**
   * 注册一个状态变更监听器。
   *
   * 如果同一个函数引用已经被注册过，则不会重复添加。
   *
   * @param listener - 状态变更时将被调用的回调函数
   * @returns 取消订阅函数，调用后移除该监听器
   */
  subscribe(listener: StateListener<S>): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 触发所有已注册的监听器。
   *
   * 遍历前先拷贝当前监听器列表（快照），确保在遍历过程中
   * 若有监听器通过取消订阅修改了集合，不影响本次分发流程。
   *
   * 对每个监听器的调用使用 try-catch 包裹：单个监听器抛出异常时
   * 记录错误日志，其余监听器仍然正常执行。
   *
   * @param newState - 更新后的状态快照
   * @param oldState - 更新前的状态快照
   */
  dispatch(newState: Readonly<S>, oldState: Readonly<S>): void {
    // 拷贝快照，避免遍历期间集合被修改
    const snapshot = [...this.listeners];

    for (const listener of snapshot) {
      try {
        listener(newState, oldState);
      } catch (error) {
        // 记录单个监听器的异常，不影响其他监听器执行
        console.error(
          '[Dispatcher] 监听器执行异常，已跳过：',
          error,
        );
      }
    }
  }

  /**
   * 获取当前已注册的监听器数量（供调试/测试使用）。
   */
  get listenerCount(): number {
    return this.listeners.size;
  }
}
