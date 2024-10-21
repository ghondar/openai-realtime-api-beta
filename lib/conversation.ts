import { InputAudioContentType, ItemType } from './client'
import { RealtimeUtils } from './utils'

/**
 * Contains text and audio information about a item
 * Can also be used as a delta
 * @typedef {Object} ItemContentDeltaType
 * @property {string} [text]
 * @property {Int16Array} [audio]
 * @property {string} [arguments]
 * @property {string} [transcript]
 */
interface ItemContentDeltaType {
  text?: string
  audio?: Int16Array
  arguments?: string
  transcript?: string
}

interface ResponseType {
  id: string
  output: string[]
}

export interface Event {
  event_id: string
  type: string
  item?: ItemType
  item_id?: string
  content_index?: number
  transcript?: string
  response?: ResponseType
  response_id?: string
  part?: InputAudioContentType
  delta?: string
  audio_start_ms?: number
  audio_end_ms?: number
}

interface EventProcessors {
  [key: string]: (event: Event, ...args: unknown[]) => { item: ItemType | null; delta: ItemContentDeltaType | null }
}

/**
 * RealtimeConversation holds conversation history
 * and performs event validation for RealtimeAPI
 * @class
 */
export class RealtimeConversation {
  defaultFrequency: number = 24_000 // 24,000 Hz
  itemLookup: { [key: string]: ItemType } = {}
  items: ItemType[] = []
  responseLookup: { [key: string]: ResponseType } = {}
  responses: ResponseType[] = []
  queuedSpeechItems: {
    [key: string]: {
      audio?: Int16Array
      audio_start_ms?: number
      audio_end_ms?: number
    }
  } = {}
  queuedTranscriptItems: {
    [key: string]: {
      transcript: string
    }
  } = {}
  queuedInputAudio: Int16Array | null = null

  EventProcessors: EventProcessors = {
    'conversation.item.created': (event: Event) => {
      const { item } = event
      // deep copy values
      const newItem = JSON.parse(JSON.stringify(item))
      if (!this.itemLookup[newItem.id]) {
        this.itemLookup[newItem.id] = newItem
        this.items.push(newItem)
      }
      newItem.formatted = {}
      newItem.formatted.audio = new Int16Array(0)
      newItem.formatted.text = ''
      newItem.formatted.transcript = ''
      if (this.queuedSpeechItems[newItem.id]) {
        // If we have a speech item, can populate audio
        newItem.formatted.audio = this.queuedSpeechItems[newItem.id].audio
        delete this.queuedSpeechItems[newItem.id] // free up some memory
      }
      if (newItem.content) {
        // Populate formatted text if it comes out on creation
        const textContent = newItem.content.filter((c) => ['text', 'input_text'].includes(c.type))
        for (const content of textContent) newItem.formatted.text += content.text
      }
      if (this.queuedTranscriptItems[newItem.id]) {
        // If we have a transcript item, can pre-populate transcript
        newItem.formatted.transcript = this.queuedTranscriptItems.transcript
        delete this.queuedTranscriptItems[newItem.id]
      }
      if (newItem.type === 'message') {
        if (newItem.role === 'user') {
          newItem.status = 'completed'
          if (this.queuedInputAudio) {
            newItem.formatted.audio = this.queuedInputAudio
            this.queuedInputAudio = null
          }
        } else {
          newItem.status = 'in_progress'
        }
      } else if (newItem.type === 'function_call') {
        newItem.formatted.tool = {
          arguments: '',
          call_id: newItem.call_id,
          name: newItem.name,
          type: 'function'
        }
        newItem.status = 'in_progress'
      } else if (newItem.type === 'function_call_output') {
        newItem.status = 'completed'
        newItem.formatted.output = newItem.output
      }

      return { delta: null, item: newItem }
    },
    'conversation.item.deleted': (event: Event) => {
      const { item_id } = event
      const item = this.itemLookup[item_id]
      if (!item) throw new Error(`item.deleted: Item "${item_id}" not found`)

      delete this.itemLookup[item.id]
      const index = this.items.indexOf(item)
      if (index > -1) this.items.splice(index, 1)

      return { delta: null, item }
    },
    'conversation.item.input_audio_transcription.completed': (event: Event) => {
      const { item_id, content_index, transcript } = event
      const item = this.itemLookup[item_id]
      // We use a single space to represent an empty transcript for .formatted values
      // Otherwise it looks like no transcript provided
      const formattedTranscript = transcript || ' '
      if (!item) {
        // We can receive transcripts in VAD mode before item.created
        // This happens specifically when audio is empty
        this.queuedTranscriptItems[item_id] = {
          transcript: formattedTranscript
        }

        return { delta: null, item: null }
      } else {
        item['content'][content_index].transcript = transcript
        item.formatted.transcript = formattedTranscript

        return { delta: { transcript }, item }
      }
    },
    'conversation.item.truncated': (event: Event) => {
      const { item_id, audio_end_ms } = event
      const item = this.itemLookup[item_id]
      if (!item) throw new Error(`item.truncated: Item "${item_id}" not found`)

      const endIndex = Math.floor((audio_end_ms * this.defaultFrequency) / 1000)
      item.formatted.transcript = ''
      item.formatted.audio = item.formatted.audio.slice(0, endIndex)

      return { delta: null, item }
    },
    'input_audio_buffer.speech_started': (event: Event) => {
      const { item_id, audio_start_ms } = event
      this.queuedSpeechItems[item_id] = { audio_start_ms }

      return { delta: null, item: null }
    },
    'input_audio_buffer.speech_stopped': (event: Event, inputAudioBuffer: Int16Array) => {
      const { item_id, audio_end_ms } = event
      if (!this.queuedSpeechItems[item_id]) this.queuedSpeechItems[item_id] = { audio_start_ms: audio_end_ms }

      const speech = this.queuedSpeechItems[item_id]
      speech.audio_end_ms = audio_end_ms
      if (inputAudioBuffer) {
        const startIndex = Math.floor((speech.audio_start_ms * this.defaultFrequency) / 1000)
        const endIndex = Math.floor((speech.audio_end_ms * this.defaultFrequency) / 1000)
        speech.audio = inputAudioBuffer.slice(startIndex, endIndex)
      }

      return { delta: null, item: null }
    },
    'response.audio.delta': (event: Event) => {
      const { item_id, /*  content_index, */ delta } = event
      const item = this.itemLookup[item_id]
      if (!item) throw new Error(`response.audio.delta: Item "${item_id}" not found`)

      // This never gets renderered, we care about the file data instead
      // item.content[content_index].audio += delta;
      const arrayBuffer = RealtimeUtils.base64ToArrayBuffer(delta)
      const appendValues = new Int16Array(arrayBuffer)
      item.formatted.audio = RealtimeUtils.mergeInt16Arrays(item.formatted.audio, appendValues)

      return { delta: { audio: appendValues }, item }
    },
    'response.audio_transcript.delta': (event: Event) => {
      const { item_id, content_index, delta } = event
      const item = this.itemLookup[item_id]
      if (!item) throw new Error(`response.audio_transcript.delta: Item "${item_id}" not found`)

      item['content'][content_index].transcript += delta
      item.formatted.transcript += delta

      return { delta: { transcript: delta }, item }
    },
    'response.content_part.added': (event: Event) => {
      const { item_id, part } = event
      const item = this.itemLookup[item_id]
      if (!item) throw new Error(`response.content_part.added: Item "${item_id}" not found`)

      item['content'].push(part)

      return { delta: null, item }
    },
    'response.created': (event: Event) => {
      const { response } = event
      if (!this.responseLookup[response.id]) {
        this.responseLookup[response.id] = response
        this.responses.push(response)
      }

      return { delta: null, item: null }
    },
    'response.function_call_arguments.delta': (event: Event) => {
      const { item_id, delta } = event
      const item = this.itemLookup[item_id]
      if (!item) throw new Error(`response.function_call_arguments.delta: Item "${item_id}" not found`)

      item['arguments'] += delta
      item.formatted.tool.arguments += delta

      return { delta: { arguments: delta }, item }
    },
    'response.output_item.added': (event: Event) => {
      const { response_id, item } = event
      const response = this.responseLookup[response_id]
      if (!response) throw new Error(`response.output_item.added: Response "${response_id}" not found`)

      response.output.push(item.id)

      return { delta: null, item: null }
    },
    'response.output_item.done': (event: Event) => {
      const { item } = event
      if (!item) throw new Error('response.output_item.done: Missing "item"')

      const foundItem = this.itemLookup[item.id]
      if (!foundItem) throw new Error(`response.output_item.done: Item "${item.id}" not found`)

      foundItem['status'] = item['status']

      return { delta: null, item: foundItem }
    },
    'response.text.delta': (event: Event) => {
      const { item_id, content_index, delta } = event
      const item = this.itemLookup[item_id]
      if (!item) throw new Error(`response.text.delta: Item "${item_id}" not found`)

      item['content'][content_index].text += delta
      item.formatted.text += delta

      return { delta: { text: delta }, item }
    }
  }

  /**
   * Create a new RealtimeConversation instance
   * @returns {RealtimeConversation}
   */
  constructor() {
    this.clear()
  }

  /**
   * Clears the conversation history and resets to default
   * @returns {true}
   */
  clear(): true {
    this.itemLookup = {}
    this.items = []
    this.responseLookup = {}
    this.responses = []
    this.queuedSpeechItems = {}
    this.queuedTranscriptItems = {}
    this.queuedInputAudio = null

    return true
  }

  /**
   * Queue input audio for manual speech event
   * @param {Int16Array} inputAudio
   * @returns {Int16Array}
   */
  queueInputAudio(inputAudio: Int16Array): Int16Array {
    this.queuedInputAudio = inputAudio

    return inputAudio
  }

  /**
   * Process an event from the WebSocket server and compose items
   * @param {Object} event
   * @param  {...unknown} args
   * @returns {item: import('./client.js').ItemType | null, delta: ItemContentDeltaType | null}
   */
  processEvent(event: Event, ...args: unknown[]): { item: ItemType | null; delta: ItemContentDeltaType | null } {
    if (!event.event_id) {
      console.error(event)
      throw new Error('Missing "event_id" on event')
    }
    if (!event.type) {
      console.error(event)
      throw new Error('Missing "type" on event')
    }
    const eventProcessor = this.EventProcessors[event.type]
    if (!eventProcessor) throw new Error(`Missing conversation event processor for "${event.type}"`)

    return eventProcessor.call(this, event, ...args)
  }

  /**
   * Retrieves a item by id
   * @param {string} id
   * @returns {import('./client.js').ItemType}
   */
  getItem(id: string): ItemType | null {
    return this.itemLookup[id] || null
  }

  /**
   * Retrieves all items in the conversation
   * @returns {import('./client.js').ItemType[]}
   */
  getItems(): ItemType[] {
    return this.items.slice()
  }
}
