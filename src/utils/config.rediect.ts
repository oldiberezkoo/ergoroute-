export interface Config {
	sourceDirectory?: string
	basePath?: string
	cacheable?: boolean
}

/**
 * @description Конфигурация приложения
 * По умолчанию используется конфигурация приложения для Elysia
 * @example
 * import { config } from "./config.ts"
 * app.config(config)
 * @type {Config}
 */
export const config: Config = {
	sourceDirectory: "./src",
	basePath: "/",
	cacheable: true,
}
