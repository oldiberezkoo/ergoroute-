import fs from "fs"
import path from "path"
import chokidar from "chokidar"
import { EventEmitter } from "events"
import type { Elysia } from "elysia"

// Определение интерфейса конфигурации
export interface Config {
	sourceDirectory?: string
	basePath?: string
	cacheable?: boolean
	port?: number
}

// Конфигурация по умолчанию
export const defaultConfig: Config = {
	sourceDirectory: "./src", // Относительный путь
	basePath: "/api", // Изменено с "/" на "/api" исходя из лога
	cacheable: true,
	port: 3000,
}

// Типы для маршрутов и обработчиков
interface RouteDefinition {
	path: string // Путь маршрута
	method: string // HTTP метод
	handlerPath: string // Путь к файлу обработчика
	middlewares: string[] // Список путей к middleware
	params?: string[] // Ожидаемые параметры (если есть)
	bodyExpected?: boolean // Флаг для ожидания тела запроса
}

// Типы для декларации ожиданий от запроса
export interface RouteExpectations {
	params?: string[]
	bodyExpected?: boolean
}

/**
 * Класс для динамического построения маршрутов на основе файловой системы
 * с поддержкой горячей перезагрузки и группировки
 */
export class EnhancedRouteBuilder extends EventEmitter {
	private app: any // Используем any для обхода проблемы с типизацией
	private elysiaConstructor: any
	private config: Config
	private watcher: chokidar.FSWatcher
	private routes: Map<string, RouteDefinition> = new Map()
	private middlewareCache: Map<string, any> = new Map()
	private expectationsCache: Map<string, RouteExpectations> = new Map()
	private projectRoot: string

	constructor(app: any, config: Config = defaultConfig) {
		super()
		this.app = app
		// Сохраняем конструктор Elysia для последующего использования
		this.elysiaConstructor = app.constructor
		this.config = { ...defaultConfig, ...config }

		// Определяем корень проекта (текущая рабочая директория)
		this.projectRoot = process.cwd()
		console.log(`Project root directory: ${this.projectRoot}`)

		// Преобразуем относительный путь sourceDirectory в абсолютный
		if (!path.isAbsolute(this.config.sourceDirectory!)) {
			this.config.sourceDirectory = path.resolve(this.projectRoot, this.config.sourceDirectory!)
		}

		console.log(`Source directory: ${this.config.sourceDirectory}`)

		// Проверяем существование директории
		if (!fs.existsSync(this.config.sourceDirectory!)) {
			console.error(`Error: Source directory "${this.config.sourceDirectory}" does not exist!`)
			// Создаем директорию, если нужно
			// fs.mkdirSync(this.config.sourceDirectory!, { recursive: true })
		}

		this.watcher = this.createWatcher()
	}

	/**
	 * Создает watcher для отслеживания изменений в файловой системе
	 */
	private createWatcher(): chokidar.FSWatcher {
		console.log(`Setting up watcher for: ${this.config.sourceDirectory}`)
		return chokidar.watch(this.config.sourceDirectory!, {
			persistent: true,
			ignored: (filePath, stats) => {
				// Игнорируем все не .ts файлы и элементы с префиксом "_"
				if (stats?.isFile() && !filePath.endsWith(".ts")) {
					return true
				}
				const segments = filePath.split(path.sep)
				return segments.some((seg) => seg.startsWith("_"))
			},
		})
	}

	/**
	 * Запускает процесс построения маршрутов и начинает отслеживать изменения
	 */
	public async start(): Promise<void> {
		await this.buildRoutes()
		this.setupWatchers()
		this.logRouteTree()
		console.log(`Server started with routes mounted on ${this.config.basePath}`)
	}

	/**
	 * Настраивает обработчики событий для watcher'а
	 */
	private setupWatchers(): void {
		this.watcher
			.on("add", (filePath) => this.handleFileChange(filePath))
			.on("change", (filePath) => this.handleFileChange(filePath))
			.on("unlink", (filePath) => this.handleFileRemoval(filePath))
			.on("unlinkDir", (dirPath) => this.handleDirectoryRemoval(dirPath))
			.on("error", (error) => console.error(`Watcher error: ${error}`))
	}

	/**
	 * Обрабатывает событие добавления/изменения файла
	 */
	private async handleFileChange(filePath: string): Promise<void> {
		console.log(`File changed: ${filePath}`)

		// Очищаем кеш для этого модуля
		try {
			delete require.cache[require.resolve(filePath)]
		} catch (e) {
			// Игнорируем ошибки очистки кеша
		}

		if (path.basename(filePath) === "middleware.ts") {
			// Если это middleware, нужно обновить все маршруты, использующие этот каталог
			const dirPath = path.dirname(filePath)
			await this.rebuildDirectoryRoutes(dirPath)
		} else if (path.basename(filePath) === "expectations.ts") {
			// Если это файл ожиданий, обновляем кеш ожиданий
			this.expectationsCache.delete(path.dirname(filePath))
			await this.rebuildDirectoryRoutes(path.dirname(filePath))
		} else {
			// Для обычного файла маршрута
			const route = await this.parseRouteFile(filePath)
			if (route) {
				this.routes.set(filePath, route)
				await this.applyRouteToApp(route)
			}
		}
		this.logRouteTree()
		this.emit("routesUpdated")
	}

	/**
	 * Обрабатывает событие удаления файла
	 */
	private async handleFileRemoval(filePath: string): Promise<void> {
		console.log(`File removed: ${filePath}`)
		if (this.routes.has(filePath)) {
			this.routes.delete(filePath)
			await this.rebuildApp()
		}
		this.logRouteTree()
		this.emit("routesUpdated")
	}

	/**
	 * Обрабатывает событие удаления директории
	 */
	private async handleDirectoryRemoval(dirPath: string): Promise<void> {
		console.log(`Directory removed: ${dirPath}`)
		// Удаляем все маршруты, связанные с этой директорией
		for (const [filePath, _] of this.routes.entries()) {
			if (filePath.startsWith(dirPath)) {
				this.routes.delete(filePath)
			}
		}
		await this.rebuildApp()
		this.logRouteTree()
		this.emit("routesUpdated")
	}

	/**
	 * Пересобирает маршруты для конкретной директории
	 */
	private async rebuildDirectoryRoutes(dirPath: string): Promise<void> {
		// Удаляем существующие маршруты для этой директории
		for (const [filePath, _] of this.routes.entries()) {
			if (filePath.startsWith(dirPath)) {
				this.routes.delete(filePath)
			}
		}

		// Пересканируем директорию
		const routes = await this.scanDirectory(dirPath)

		// Добавляем новые маршруты
		for (const route of routes) {
			this.routes.set(route.handlerPath, route)
		}

		await this.rebuildApp()
	}

	/**
	 * Выполняет полное построение всех маршрутов
	 */
	private async buildRoutes(): Promise<void> {
		try {
			console.log(`Building routes from ${this.config.sourceDirectory}`)
			const routes = await this.scanDirectory(this.config.sourceDirectory!)
			this.routes.clear()

			for (const route of routes) {
				this.routes.set(route.handlerPath, route)
			}

			await this.rebuildApp()
		} catch (error) {
			console.error("Error building routes:", error)
		}
	}

	/**
	 * Пересоздает приложение Elysia с актуальными маршрутами
	 */
	private async rebuildApp(): Promise<void> {
		// Создаем новый экземпляр Elysia, используя сохраненный конструктор
		const newApp = new this.elysiaConstructor()

		// Группируем маршруты под базовым путем
		newApp.group(this.config.basePath!, (app) => {
			// Применяем каждый маршрут
			for (const route of this.routes.values()) {
				this.applyRouteToApp(route, app)
			}
			return app
		})

		// Если сервер уже запущен, останавливаем его
		if (this.app.server) {
			await this.app.stop()
		}

		// Запускаем новый сервер
		this.app = newApp.listen(this.config.port || 3000)
		console.log("Server reloaded at:", new Date().toISOString())
	}

	/**
	 * Применяет маршрут к приложению Elysia
	 */
	private applyRouteToApp(route: RouteDefinition, app: any = this.app): void {
		try {
			// Импортируем обработчик
			let handler = require(route.handlerPath).default

			// Создаем цепочку middleware
			let routeApp = app

			// Применяем все middleware
			for (const mwPath of route.middlewares) {
				if (!this.middlewareCache.has(mwPath)) {
					try {
						const mw = require(mwPath).default
						this.middlewareCache.set(mwPath, mw)
					} catch (e) {
						console.error(`Error loading middleware ${mwPath}:`, e)
						continue
					}
				}

				routeApp = routeApp.use(this.middlewareCache.get(mwPath))
			}

			// Регистрируем маршрут с соответствующим HTTP методом
			const method = route.method.toLowerCase()
			if (typeof routeApp[method] === "function") {
				routeApp[method](route.path, handler)
				console.log(`Route registered: [${route.method.toUpperCase()}] ${route.path}`)
			} else {
				console.error(`Method ${method} is not supported by Elysia instance`)
			}
		} catch (e) {
			console.error(`Error applying route ${route.handlerPath}:`, e)
		}
	}

	/**
	 * Сканирует директорию для поиска файлов маршрутов и middleware
	 */
	private async scanDirectory(dirPath: string, basePath: string = ""): Promise<RouteDefinition[]> {
		try {
			console.log(`Scanning directory: ${dirPath}`)

			// Проверяем существование директории
			if (!fs.existsSync(dirPath)) {
				console.error(`Directory does not exist: ${dirPath}`)
				return []
			}

			const routes: RouteDefinition[] = []
			const entries = fs.readdirSync(dirPath, { withFileTypes: true })

			// Ищем middleware и expectations для текущей директории
			const middlewarePath = path.join(dirPath, "middleware.ts")
			const expectationsPath = path.join(dirPath, "expectations.ts")

			let localMiddleware: string | null = null
			let expectations: RouteExpectations | null = null

			if (fs.existsSync(middlewarePath)) {
				localMiddleware = middlewarePath
			}

			if (fs.existsSync(expectationsPath)) {
				try {
					expectations = require(expectationsPath).default
					this.expectationsCache.set(dirPath, expectations)
				} catch (e) {
					console.error(`Error loading expectations from ${expectationsPath}:`, e)
				}
			}

			// Получаем ожидания из кеша, если они есть
			if (!expectations && this.expectationsCache.has(dirPath)) {
				expectations = this.expectationsCache.get(dirPath)!
			}

			// Обрабатываем каждый элемент в директории
			for (const entry of entries) {
				if (entry.name.startsWith("_")) continue

				const fullPath = path.join(dirPath, entry.name)

				if (entry.isDirectory()) {
					// Обрабатываем поддиректорию
					let groupName = entry.name

					// Проверяем на группу в скобках (NAME)
					const groupMatch = entry.name.match(/^\((.*?)\)$/)
					if (groupMatch) {
						groupName = groupMatch[1] // Извлекаем имя без скобок
					}

					const newBasePath = path.join(basePath, groupName).replace(/\\/g, "/")
					const subRoutes = await this.scanDirectory(fullPath, newBasePath)
					routes.push(...subRoutes)
				} else if (entry.isFile() && entry.name.endsWith(".ts")) {
					// Обрабатываем файл, если это маршрут
					if (entry.name === "middleware.ts" || entry.name === "expectations.ts") continue

					const route = await this.parseRouteFile(fullPath, basePath, localMiddleware, expectations)
					if (route) {
						routes.push(route)
					}
				}
			}

			return routes
		} catch (e) {
			console.error(`Error scanning directory ${dirPath}:`, e)
			throw e
		}
	}

	/**
	 * Разбирает файл маршрута для создания определения маршрута
	 */
	private async parseRouteFile(
		filePath: string,
		basePath: string = "",
		localMiddleware: string | null = null,
		expectations: RouteExpectations | null = null
	): Promise<RouteDefinition | null> {
		// Разбираем имя файла по шаблону: имя.метод.ts
		const match = path.basename(filePath).match(/^(.+?)\.([a-z]+)\.ts$/)
		if (!match) return null

		const [_, fileName, method] = match

		// Если нет явного basePath, вычисляем его из пути к файлу
		if (!basePath) {
			const relPath = path.relative(this.config.sourceDirectory!, path.dirname(filePath))
			basePath = "/" + relPath.split(path.sep).join("/")

			// Обрабатываем группы в скобках в пути
			const segments = basePath.split("/")
			basePath = segments
				.map((segment) => {
					const groupMatch = segment.match(/^\((.*?)\)$/)
					return groupMatch ? groupMatch[1] : segment
				})
				.join("/")
		}

		// Формируем итоговый путь маршрута
		let routePath = basePath
		if (fileName !== "index") {
			routePath = path.posix.join(basePath, fileName).replace(/\\/g, "/")
		}

		// Собираем middleware из всех родительских директорий
		const middlewares: string[] = []

		if (localMiddleware) {
			middlewares.push(localMiddleware)
		}

		// Добавляем middleware из родительских директорий
		let parentDir = path.dirname(filePath)
		while (parentDir !== this.config.sourceDirectory && parentDir !== ".") {
			parentDir = path.dirname(parentDir)
			const parentMiddleware = path.join(parentDir, "middleware.ts")

			if (fs.existsSync(parentMiddleware)) {
				middlewares.push(parentMiddleware)
			}
		}

		// Создаем определение маршрута
		const route: RouteDefinition = {
			path: routePath,
			method: method.toLowerCase(),
			handlerPath: filePath,
			middlewares,
		}

		// Добавляем ожидания, если они определены
		if (expectations) {
			if (expectations.params) {
				route.params = expectations.params
			}
			if (expectations.bodyExpected !== undefined) {
				route.bodyExpected = expectations.bodyExpected
			}
		}

		return route
	}

	/**
	 * Выводит дерево маршрутов в консоль
	 */
	public logRouteTree(): void {
		const tree = this.buildRouteTree()
		console.log("\n=== Route Tree ===")
		this.printRouteTree(tree)
		console.log("=================\n")
	}

	/**
	 * Строит дерево маршрутов для визуализации
	 */
	private buildRouteTree(): any {
		const tree: any = {}

		for (const route of this.routes.values()) {
			// Разбиваем путь на сегменты
			const segments = route.path.split("/").filter(Boolean)
			let node = tree

			// Создаем узлы для каждого сегмента
			for (const segment of segments) {
				node[segment] = node[segment] || {}
				node = node[segment]
			}

			// Добавляем метод к конечному узлу
			node.methods = node.methods || []
			node.methods.push({
				method: route.method.toUpperCase(),
				handler: route.handlerPath,
				expectations: route.bodyExpected ? "Expects body" : "",
				params: route.params ? `Params: ${route.params.join(", ")}` : "",
			})
		}

		return tree
	}

	/**
	 * Выводит дерево маршрутов в консоль с форматированием
	 */
	private printRouteTree(node: any, prefix: string = "", path: string = ""): void {
		const entries = Object.entries(node)

		for (let i = 0; i < entries.length; i++) {
			const [key, value] = entries[i]
			const isLast = i === entries.length - 1

			if (key === "methods") {
				// Выводим методы
				for (const methodInfo of value as any[]) {
					console.log(
						`${prefix}${isLast ? "└─" : "├─"} [${methodInfo.method}]${
							methodInfo.expectations ? " " + methodInfo.expectations : ""
						}${methodInfo.params ? " " + methodInfo.params : ""}`
					)
				}
			} else {
				// Выводим путь
				const currentPath = path ? `${path}/${key}` : `/${key}`
				console.log(`${prefix}${isLast ? "└─" : "├─"} ${currentPath}`)

				// Рекурсивно выводим дочерние элементы
				this.printRouteTree(value, `${prefix}${isLast ? "   " : "│  "}`, currentPath)
			}
		}
	}

	/**
	 * Возвращает текущий список маршрутов (для отладки)
	 */
	public getRoutes(): RouteDefinition[] {
		return Array.from(this.routes.values())
	}
}
