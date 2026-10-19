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
 * buffer is set, or else directly with decodeMultiple, and pass any error to keepIncomplete, which returns the error
 * to report, if any. end returns an error if the input ended inside a value.
 */
export class ChunkDecoder {
  constructor (decoder, maxIncompleteBufferSize) {
    this.decoder = decoder
    if (maxIncompleteBufferSize === undefined) maxIncompleteBufferSize = 0x4000000
    if (typeof maxIncompleteBufferSize !== 'number' || !(maxIncompleteBufferSize >= 0)) {
      throw new TypeError('maxIncompleteBufferSize must be a non-negative number')
    }
    this.maxIncompleteBufferSize = Math.floor(maxIncompleteBufferSize)
    // buffer[0, bufferEnd) is the incomplete value; no decoded value is a view of buffer while it is kept here
    this.buffer = null
    this.bufferEnd = 0
    this.appends = 0
    this.neededLength = 0 // a lower bound on the incomplete value's length
  }

  decodeAfterIncomplete (chunk) {
    if (!(ArrayBuffer.isView(chunk) && chunk.BYTES_PER_ELEMENT === 1)) {
      throw new TypeError('Source must be a Uint8Array or Buffer')
    }
    const length = this.bufferEnd + chunk.length
    if (length < this.neededLength && length > this.maxIncompleteBufferSize) throw maxIncompleteBufferSizeError()
    if (length > this.buffer.length) {
      // Values usually complete within two appends, which are sized exactly. After that the buffer grows by at least
      // the bytes already kept, so that they are copied a bounded number of times however small the chunks are.
      const size = this.appends < 2 ? length
        : Math.max(length, Math.min(length + this.bufferEnd, this.maxIncompleteBufferSize))
      const buffer = Buffer.allocUnsafe(size)
      if (size > length) buffer.fill(0, length) // decoded values are views of this buffer, so no uninitialized memory
      buffer.set(this.buffer.subarray(0, this.bufferEnd))
      this.buffer = buffer
    }
    this.buffer.set(chunk, this.bufferEnd)
    this.bufferEnd = length
    this.appends++
    if (length < this.neededLength) return []
    const values = this.decoder.decodeMultiple(this.buffer.subarray(0, length))
    this.buffer = null
    return values
  }

  keepIncomplete (error, chunk) {
    if (!error.incomplete) return this.fail(error)
    const source = this.buffer ? this.buffer.subarray(0, this.bufferEnd) : chunk
    const length = source.length - error.lastPosition
    if (length > this.maxIncompleteBufferSize) return this.fail(maxIncompleteBufferSizeError())
    if (!this.buffer || error.lastPosition > 0) {
      if (length === 0) return
      try {
        // copied, so that the remainder does not keep in memory the chunk, or the buffer that the values before it
        // are views of
        this.buffer = Buffer.from(source.subarray(error.lastPosition))
      } catch (copyError) {
        return this.fail(copyError)
      }
      this.bufferEnd = length
      this.appends = 0
    }
    this.neededLength = error.neededEnd ? error.neededEnd - error.lastPosition : length + 1
  }

  end () {
    if (this.buffer) {
      const error = this.fail(new Error('Unexpected end of CBOR data'))
      error.incomplete = true
      return error
    }
  }

  fail (error) {
    this.buffer = null
    return error
  }
}

function maxIncompleteBufferSizeError () {
  return new Error('Maximum incomplete buffer size exceeded')
}
