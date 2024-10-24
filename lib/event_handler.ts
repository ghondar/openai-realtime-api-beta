/**
 * EventHandler callback
 */
type EventHandlerCallbackType<T = { [key: string]: unknown }> = (event: T) => void

const sleep = (t: number): Promise<void> => new Promise((r) => setTimeout(() => r(), t))

/**
 * Inherited class for RealtimeAPI and RealtimeClient
 * Adds basic event handling
 * @class
 */
export class RealtimeEventHandler {
  private eventHandlers: { [key: string]: EventHandlerCallbackType[] } = {}
  private nextEventHandlers: { [key: string]: EventHandlerCallbackType[] } = {}

  /**
   * Create a new RealtimeEventHandler instance
   */
  constructor() {}

  /**
   * Clears all event handlers
   * @returns {true}
   */
  clearEventHandlers(): true {
    this.eventHandlers = {}
    this.nextEventHandlers = {}

    return true
  }

  /**
   * Listen to specific events
   * @param {string} eventName The name of the event to listen to
   * @param {EventHandlerCallbackType} callback Code to execute on event
   * @returns {EventHandlerCallbackType}
   */
  on<T>(eventName: string, callback: EventHandlerCallbackType<T>): EventHandlerCallbackType<T> {
    this.eventHandlers[eventName] = this.eventHandlers[eventName] || []
    this.eventHandlers[eventName].push(callback as EventHandlerCallbackType)

    return callback
  }

  /**
   * Listen for the next event of a specified type
   * @param {string} eventName The name of the event to listen to
   * @param {EventHandlerCallbackType} callback Code to execute on event
   * @returns {EventHandlerCallbackType}
   */
  onNext(eventName: string, callback: EventHandlerCallbackType): EventHandlerCallbackType {
    this.nextEventHandlers[eventName] = this.nextEventHandlers[eventName] || []
    this.nextEventHandlers[eventName].push(callback)

    return callback
  }

  /**
   * Turns off event listening for specific events
   * Calling without a callback will remove all listeners for the event
   * @param {string} eventName
   * @param {EventHandlerCallbackType} [callback]
   * @returns {true}
   */
  off(eventName: string, callback?: EventHandlerCallbackType): true {
    const handlers = this.eventHandlers[eventName] || []
    if (callback) {
      const index = handlers.indexOf(callback)
      if (index === -1) throw new Error(`Could not turn off specified event listener for "${eventName}": not found as a listener`)

      handlers.splice(index, 1)
    } else {
      delete this.eventHandlers[eventName]
    }

    return true
  }

  /**
   * Turns off event listening for the next event of a specific type
   * Calling without a callback will remove all listeners for the next event
   * @param {string} eventName
   * @param {EventHandlerCallbackType} [callback]
   * @returns {true}
   */
  offNext(eventName: string, callback?: EventHandlerCallbackType): true {
    const nextHandlers = this.nextEventHandlers[eventName] || []
    if (callback) {
      const index = nextHandlers.indexOf(callback)
      if (index === -1) throw new Error(`Could not turn off specified next event listener for "${eventName}": not found as a listener`)

      nextHandlers.splice(index, 1)
    } else {
      delete this.nextEventHandlers[eventName]
    }

    return true
  }

  /**
   * Waits for next event of a specific type and returns the payload
   * @param {string} eventName
   * @param {number|null} [timeout]
   * @returns {Promise<{[key: string]: any}|null>}
   */
  async waitForNext<T>(eventName: string, timeout: number | null = null): Promise<T | null> {
    const t0 = Date.now()
    let nextEvent: T | undefined
    this.onNext(eventName, (event) => (nextEvent = event as T))
    while (!nextEvent) {
      if (timeout) {
        const t1 = Date.now()
        if (t1 - t0 > timeout) return null
      }
      await sleep(1)
    }

    return nextEvent
  }

  /**
   * Executes all events in the order they were added, with .on() event handlers executing before .onNext() handlers
   * @param {string} eventName
   * @param {any} event
   * @returns {true}
   */
  dispatch(eventName: string, event?: unknown): true {
    const handlers = [].concat(this.eventHandlers[eventName] || [])
    for (const handler of handlers) handler(event)

    const nextHandlers = [].concat(this.nextEventHandlers[eventName] || [])
    for (const nextHandler of nextHandlers) nextHandler(event)

    delete this.nextEventHandlers[eventName]

    return true
  }
}
