import { ShadowCheckpointService } from "./ShadowCheckpointService"

/**
 * Checkpoint 服务管理器
 * 负责管理所有活跃的 checkpoint 服务实例的生命周期
 */
export class CheckpointServiceManager {
	private static instance: CheckpointServiceManager
	private activeServices: Map<string, ShadowCheckpointService> = new Map()
	private isShuttingDown = false

	private constructor() {}

	/**
	 * 获取单例实例
	 */
	public static getInstance(): CheckpointServiceManager {
		if (!CheckpointServiceManager.instance) {
			CheckpointServiceManager.instance = new CheckpointServiceManager()
		}
		return CheckpointServiceManager.instance
	}

	/**
	 * 注册一个 checkpoint 服务
	 */
	public registerService(taskId: string, service: ShadowCheckpointService): void {
		if (this.isShuttingDown) {
			console.warn(`[CheckpointServiceManager] 正在关闭中，忽略服务注册: ${taskId}`)
			return
		}

		// 如果已存在同 taskId 的服务，先清理旧的
		if (this.activeServices.has(taskId)) {
			console.warn(`[CheckpointServiceManager] 发现重复的 taskId，清理旧服务: ${taskId}`)
			this.unregisterService(taskId)
		}

		this.activeServices.set(taskId, service)
		console.log(`[CheckpointServiceManager] 注册 checkpoint 服务: ${taskId}`)

		// 监听服务错误事件
		service.on("error", (errorData) => {
			console.error(`[CheckpointServiceManager] 服务 ${taskId} 发生错误:`, errorData.error)
			// 可以选择自动清理出错的服务
			// this.unregisterService(taskId)
		})
	}

	/**
	 * 注销一个 checkpoint 服务
	 */
	public async unregisterService(taskId: string): Promise<void> {
		const service = this.activeServices.get(taskId)
		if (!service) {
			return
		}

		try {
			console.log(`[CheckpointServiceManager] 开始注销 checkpoint 服务: ${taskId}`)
			await service.dispose()
			this.activeServices.delete(taskId)
			console.log(`[CheckpointServiceManager] 成功注销 checkpoint 服务: ${taskId}`)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			console.error(`[CheckpointServiceManager] 注销服务 ${taskId} 时出错: ${errorMessage}`)
			// 即使出错也要从映射中删除
			this.activeServices.delete(taskId)
		}
	}

	/**
	 * 获取指定任务的 checkpoint 服务
	 */
	public getService(taskId: string): ShadowCheckpointService | undefined {
		return this.activeServices.get(taskId)
	}

	/**
	 * 获取所有活跃的服务
	 */
	public getAllServices(): Map<string, ShadowCheckpointService> {
		return new Map(this.activeServices)
	}

	/**
	 * 获取活跃服务数量
	 */
	public getActiveServiceCount(): number {
		return this.activeServices.size
	}

	/**
	 * 清理所有 checkpoint 服务
	 */
	public async disposeAll(): Promise<void> {
		if (this.isShuttingDown) {
			console.warn(`[CheckpointServiceManager] 已经在关闭过程中`)
			return
		}

		this.isShuttingDown = true
		console.log(`[CheckpointServiceManager] 开始清理所有 checkpoint 服务，共 ${this.activeServices.size} 个`)

		const disposePromises: Promise<void>[] = []

		// 并行清理所有服务
		for (const [taskId, service] of this.activeServices) {
			const disposePromise = (async () => {
				try {
					console.log(`[CheckpointServiceManager] 清理服务: ${taskId}`)
					await service.dispose()
					console.log(`[CheckpointServiceManager] 服务清理完成: ${taskId}`)
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error)
					console.error(`[CheckpointServiceManager] 清理服务 ${taskId} 时出错: ${errorMessage}`)
				}
			})()
			disposePromises.push(disposePromise)
		}

		// 等待所有清理操作完成
		try {
			await Promise.allSettled(disposePromises)
		} catch (error) {
			console.error(`[CheckpointServiceManager] 清理过程中发生未预期错误:`, error)
		}

		// 清空服务映射
		this.activeServices.clear()
		this.isShuttingDown = false

		console.log(`[CheckpointServiceManager] 所有 checkpoint 服务清理完成`)
	}

	/**
	 * 检查是否正在关闭
	 */
	public isShutdownInProgress(): boolean {
		return this.isShuttingDown
	}

	/**
	 * 重置管理器状态（主要用于测试）
	 */
	public reset(): void {
		this.activeServices.clear()
		this.isShuttingDown = false
		console.log(`[CheckpointServiceManager] 管理器状态已重置`)
	}

	/**
	 * 获取服务统计信息
	 */
	public getStats(): {
		activeCount: number
		taskIds: string[]
		isShuttingDown: boolean
	} {
		return {
			activeCount: this.activeServices.size,
			taskIds: Array.from(this.activeServices.keys()),
			isShuttingDown: this.isShuttingDown,
		}
	}
}

/**
 * 全局 checkpoint 服务管理器实例
 */
export const checkpointServiceManager = CheckpointServiceManager.getInstance()
