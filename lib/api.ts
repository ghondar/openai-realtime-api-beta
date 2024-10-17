import { RealtimeEventHandler } from './event_handler'
import { RealtimeUtils } from './utils'

interface RealtimeAPISettings {
  url?: string
  apiKey?: string
  dangerouslyAllowAPIKeyInBrowser?: boolean
  debug?: boolean
}

interface ConnectSettings {
  model?: string
}

export class RealtimeAPI extends RealtimeEventHandler {
  private defaultUrl: string
  private url: string
  private apiKey: string | null
  private debug: boolean
  private ws: WebSocket | null

  /**
   * Create a new RealtimeAPI instance
   * @param {RealtimeAPISettings} [settings]
   * @returns {RealtimeAPI}
   */
  constructor({ url, apiKey, dangerouslyAllowAPIKeyInBrowser, debug }: RealtimeAPISettings = {}) {
    super()
    this.defaultUrl = 'wss://api.openai.com/v1/realtime'
    this.url = url || this.defaultUrl
    this.apiKey = apiKey || null
    this.debug = !!debug
    this.ws = null
    if (globalThis.document && this.apiKey) {
      if (!dangerouslyAllowAPIKeyInBrowser) {
        throw new Error(`Can not provide API key in the browser without "dangerouslyAllowAPIKeyInBrowser" set to true`)
      }
    }
  }

  /**
   * Tells us whether or not the WebSocket is connected
   * @returns {boolean}
   */
  isConnected(): boolean {
    return !!this.ws
  }

  /**
   * Writes WebSocket logs to console
   * @param  {...any} args
   * @returns {true}
   */
  log(...args: unknown[]): boolean {
    const date = new Date().toISOString()
    const logs = [`[Websocket/${date}]`].concat(args.toString()).map((arg) => {
      if (typeof arg === 'object' && arg !== null) {
        return JSON.stringify(arg, null, 2)
      } else {
        return arg
      }
    })
    if (this.debug) {
      console.log(...logs)
    }
    return true
  }

  /**
   * Connects to Realtime API Websocket Server
   * @param {ConnectSettings} [settings]
   * @returns {Promise<true>}
   */
  async connect({ model }: ConnectSettings = { model: 'gpt-4o-realtime-preview-2024-10-01' }): Promise<true> {
    if (!this.apiKey && this.url === this.defaultUrl) {
      console.warn(`No apiKey provided for connection to "${this.url}"`)
    }
    if (this.isConnected()) {
      throw new Error(`Already connected`)
    }
    if (globalThis.document) {
      /**
       * Web browser
       */
      if (this.apiKey) {
        console.warn('Warning: Connecting using API key in the browser, this is not recommended')
      }
      const WebSocket = globalThis.WebSocket
      const ws = new WebSocket(`${this.url}${model ? `?model=${model}` : ''}`, [
        'realtime',
        `openai-insecure-api-key.${this.apiKey}`,
        'openai-beta.realtime-v1'
      ])
      ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        this.receive(message.type, message)
      })
      return new Promise((resolve, reject) => {
        const connectionErrorHandler = () => {
          this.disconnect(ws)
          reject(new Error(`Could not connect to "${this.url}"`))
        }
        ws.addEventListener('error', connectionErrorHandler)
        ws.addEventListener('open', () => {
          this.log(`Connected to "${this.url}"`)
          ws.removeEventListener('error', connectionErrorHandler)
          ws.addEventListener('error', () => {
            this.disconnect(ws)
            this.log(`Error, disconnected from "${this.url}"`)
            this.dispatch('close', { error: true })
          })
          ws.addEventListener('close', () => {
            this.disconnect(ws)
            this.log(`Disconnected from "${this.url}"`)
            this.dispatch('close', { error: false })
          })
          this.ws = ws
          resolve(true)
        })
      })
    } else {
      /**
       * Node.js
       */
      const moduleName = 'ws'
      const wsModule = await import(/* @vite-ignore */ /* webpackIgnore: true */ moduleName)
      const WebSocket = wsModule.default
      const ws = new WebSocket(this.url, [], {
        finishRequest: (request) => {
          // Auth
          request.setHeader('Authorization', `Bearer ${this.apiKey}`)
          request.setHeader('OpenAI-Beta', 'realtime=v1')
          request.setHeader('api-key', this.apiKey)
          request.end()
        }
      })
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString())
        this.receive(message.type, message)
      })
      return new Promise((resolve, reject) => {
        const connectionErrorHandler = () => {
          this.disconnect(ws)
          reject(new Error(`Could not connect to "${this.url}"`))
        }
        ws.on('error', connectionErrorHandler)
        ws.on('open', () => {
          this.log(`Connected to "${this.url}"`)
          ws.removeListener('error', connectionErrorHandler)
          ws.on('error', () => {
            this.disconnect(ws)
            this.log(`Error, disconnected from "${this.url}"`)
            this.dispatch('close', { error: true })
          })
          ws.on('close', () => {
            this.disconnect(ws)
            this.log(`Disconnected from "${this.url}"`)
            this.dispatch('close', { error: false })
          })
          this.ws = ws
          resolve(true)
        })
      })
    }
  }

  /**
   * Disconnects from Realtime API server
   * @param {WebSocket} [ws]
   * @returns {true}
   */
  disconnect(ws?: WebSocket): true {
    if (!ws || this.ws === ws) {
      this.ws && this.ws.close()
      this.ws = null
      return true
    }
  }

  /**
   * Receives an event from WebSocket and dispatches as "server.{eventName}" and "server.*" events
   * @param {string} eventName
   * @param {{[key: string]: any}} event
   * @returns {true}
   */
  receive(eventName: string, event: { [key: string]: unknown }): true {
    this.log(`received:`, eventName, event)
    this.dispatch(`server.${eventName}`, event)
    this.dispatch('server.*', event)
    return true
  }

  /**
   * Sends an event to WebSocket and dispatches as "client.{eventName}" and "client.*" events
   * @param {string} eventName
   * @param {{[key: string]: any}} data
   * @returns {true}
   */
  send(eventName: string, data?: { [key: string]: unknown }): true {
    if (!this.isConnected()) {
      throw new Error(`RealtimeAPI is not connected`)
    }
    data = data || {}
    if (typeof data !== 'object') {
      throw new Error(`data must be an object`)
    }
    const event = {
      event_id: RealtimeUtils.generateId('evt_'),
      type: eventName,
      ...data
    }
    this.dispatch(`client.${eventName}`, event)
    this.dispatch('client.*', event)
    this.log(`sent:`, eventName, event)
    this.ws.send(JSON.stringify(event))
    return true
  }
}
