import { Encoder } from './encode.js'
import { Decoder } from './decode.js'

/**
 * Given an Iterable first argument, returns an Iterable where each value is encoded as a Buffer
 * If the argument is only Async Iterable, the return value will be an Async Iterable.
 * @param {Iterable|Iterator|AsyncIterable|AsyncIterator} objectIterator - iterable source, like a Readable object stream, an array, Set, or custom object
 * @param {options} [options] - cbor-x Encoder options
 * @returns {IterableIterator|Promise.<AsyncIterableIterator>}
 */
export function encodeIter (objectIterator, options = {}) {
  if (!objectIterator || typeof objectIterator !== 'object') {
    throw new Error('first argument must be an Iterable, Async Iterable, or a Promise for an Async Iterable')
  } else if (typeof objectIterator[Symbol.iterator] === 'function') {
    return encodeIterSync(objectIterator, options)
  } else if (typeof objectIterator.then === 'function' || typeof objectIterator[Symbol.asyncIterator] === 'function') {
    return encodeIterAsync(objectIterator, options)
  } else {
    throw new Error('first argument must be an Iterable, Async Iterable, Iterator, Async Iterator, or a Promise')
  }
}

function * encodeIterSync (objectIterator, options) {
  const encoder = new Encoder(options)
  for (const value of objectIterator) {
    yield encoder.encode(value)
  }
}

async function * encodeIterAsync (objectIterator, options) {
  const encoder = new Encoder(options)
  for await (const value of objectIterator) {
    yield encoder.encode(value)
  }
}

/**
 * Given an Iterable/Iterator input which yields buffers, returns an IterableIterator which yields sync decoded objects
 * Or, given an Async Iterable/Iterator which yields promises resolving in buffers, returns an AsyncIterableIterator.
 * @param {Iterable|Iterator|AsyncIterable|AsyncIterableIterator} bufferIterator
 * @param {object} [options] - Decoder options, and maxIncompleteBufferSize
 * @returns {IterableIterator|Promise.<AsyncIterableIterator}
 */
export function decodeIter (bufferIterator, options = {}) {
  if (!bufferIterator || typeof bufferIterator !== 'object') {
    throw new Error('first argument must be an Iterable, Async Iterable, Iterator, Async Iterator, or a promise')
  }

  const decoder = new Decoder(options)
  const chunkDecoder = new ChunkDecoder(decoder, options.maxIncompleteBufferSize)
  let fatalError
  const parser = (chunk) => {
    try {
      return chunkDecoder.buffer ? chunkDecoder.decodeAfterIncomplete(chunk) : decoder.decodeMultiple(chunk)
    } catch (error) {
      fatalError = chunkDecoder.keepIncomplete(error, chunk)
      return error.values || []
    }
  }

  if (typeof bufferIterator[Symbol.iterator] === 'function') {
    return (function * iter () {
      for (const value of bufferIterator) {
        yield * parser(value)
        if (fatalError) throw fatalError
      }
      const endError = chunkDecoder.end()
      if (endError) throw endError
    })()
  } else if (typeof bufferIterator[Symbol.asyncIterator] === 'function') {
    return (async function * iter () {
      for await (const value of bufferIterator) {
        yield * parser(value)
        if (fatalError) throw fatalError
      }
      const endError = chunkDecoder.end()
      if (endError) throw endError
    })()
  }
}

/**
 * Keeps the bytes of a value that a chunk of a stream ends inside of, for DecoderStream and decodeIter, and decodes
 * them again once enough have arrived to possibly complete it. Callers decode a chunk with decodeAfterIncomplete if
 * buffer is set, or else directly with decodeMultiple, and pass any error to keepIncomplete.
 */
export class ChunkDecoder {
  constructor (decoder, maxIncompleteBufferSize) {
    this.decoder = decoder
    this.maxIncompleteBufferSize = maxIncompleteBufferSize !== undefined ? maxIncompleteBufferSize : 0x4000000
    // the incomplete value is buffer[bufferStart, bufferEnd); bytes before bufferStart may be referenced by values
    // already decoded, so they are never overwritten
    this.buffer = null
    this.bufferStart = 0
    this.bufferEnd = 0
    this.neededLength = 0 // a lower bound on the incomplete value's length
  }

  decodeAfterIncomplete (chunk) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('Source must be a Uint8Array or Buffer')
    const length = this.bufferEnd - this.bufferStart + chunk.length
    if (length < this.neededLength) {
      // still incomplete, so all of these bytes belong to the incomplete value
      if (length > this.maxIncompleteBufferSize) throw maxIncompleteBufferSizeError()
      // grown geometrically, so that the bytes are copied a bounded number of times however small the chunks are
      this.append(chunk, Math.min(length * 2, this.maxIncompleteBufferSize))
      return []
    }
    this.append(chunk, length)
    const values = this.decoder.decodeMultiple(this.buffer.subarray(this.bufferStart, this.bufferEnd))
    this.buffer = null
    return values
  }

  /**
   * Keeps the incomplete value from an error decoding the chunk. Returns the error to report instead if it is fatal,
   * or if the incomplete value is larger than maxIncompleteBufferSize.
   */
  keepIncomplete (error, chunk) {
    if (!error.incomplete) return this.fail(error)
    const start = (this.buffer ? this.bufferStart : 0) + error.lastPosition
    const length = (this.buffer ? this.bufferEnd : chunk.length) - start
    if (length > this.maxIncompleteBufferSize) return this.fail(maxIncompleteBufferSizeError())
    if (this.buffer) {
      this.bufferStart = start
    } else {
      if (length === 0) return // an empty chunk
      // copied, so that a short remainder does not keep the whole chunk in memory
      this.buffer = Buffer.from(chunk.subarray(start))
      this.bufferStart = 0
      this.bufferEnd = length
    }
    this.neededLength = error.neededEnd ? error.neededEnd - error.lastPosition : length + 1
  }

  /**
   * Returns an error if the input ended inside a value.
   */
  end () {
    if (this.buffer) {
      const error = this.fail(new Error('Unexpected end of CBOR data'))
      error.incomplete = true
      return error
    }
  }

  append (chunk, capacity) {
    const length = this.bufferEnd - this.bufferStart + chunk.length
    if (this.bufferEnd + chunk.length > this.buffer.length) {
      const buffer = Buffer.allocUnsafe(Math.max(length, capacity))
      buffer.fill(0, length) // decoded values are views of this buffer, so it must not expose uninitialized memory
      buffer.set(this.buffer.subarray(this.bufferStart, this.bufferEnd))
      this.buffer = buffer
      this.bufferEnd -= this.bufferStart
      this.bufferStart = 0
    }
    this.buffer.set(chunk, this.bufferEnd)
    this.bufferEnd += chunk.length
  }

  fail (error) {
    this.buffer = null
    return error
  }
}

function maxIncompleteBufferSizeError () {
  return new Error('Maximum incomplete buffer size exceeded')
}
