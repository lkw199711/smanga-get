import type { taskType } from '#type/index.js'

/**
 * 任务调度器接口
 * 在 MangaTask 执行流程中嵌入调度控制点，
 * 后续反爬模型（时间窗口、冷却、每日配额等）通过实现此接口接入。
 */
export interface TaskScheduler {
  /**
   * 任务执行前调用
   * 可用于等待时间窗口、检查每日配额等阻塞操作
   * @param task 即将执行的任务
   */
  beforeTask(task: taskType): Promise<void>

  /**
   * 任务执行后调用
   * 可用于记录执行历史、更新每日计数等
   * @param task 刚完成的任务
   * @param success 是否执行成功
   */
  afterTask(task: taskType, success: boolean): Promise<void>

  /**
   * 是否应继续执行下一个任务
   * @returns false 时中断任务循环
   */
  shouldContinue(): boolean
}

/**
 * 直通调度器（无操作桩）
 * 当前行为不变——所有钩子为空操作，永远继续执行。
 * 后续替换为带时间窗口/冷却/配额的 AntiBotScheduler。
 */
export class PassThroughScheduler implements TaskScheduler {
  async beforeTask(_task: taskType): Promise<void> {
    // no-op
  }

  async afterTask(_task: taskType, _success: boolean): Promise<void> {
    // no-op
  }

  shouldContinue(): boolean {
    return true
  }
}
