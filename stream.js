import { Transform } from 'stream'
import { Encoder } from './encode.js'
import { checkedRead, getPosition, Decoder, clearSource } from './decode.js'
import { ChunkDecoder } from './iterators.js'
var DEFAULT_OPTIONS = {objectMode: true}

export class EncoderStream extends Transform {
	constructor(options) {
		if (!options)
			options = {}
		options.writableObjectMode = true
		super(options)
		options.sequential = true
		this.encoder = options.encoder || new Encoder(options)
	}
	async _transform(value, encoding, callback) {
		try {
			for await (let chunk of this.encoder.encodeAsAsyncIterable(value)) {
				this.push(chunk)
			}
			callback()
		} catch(error) { callback (error) }
	}
}

export class DecoderStream extends Transform {
	constructor(options) {
		if (!options)
			options = {}
		options.objectMode = true
		super(options)
		options.structures = []
		this.decoder = options.decoder || new Decoder(options)
		this.chunkDecoder = new ChunkDecoder(this.decoder, options.maxIncompleteBufferSize)
	}
	_transform(chunk, encoding, callback) {
		let values, fatalError
		try {
			// decodeMultiple is called directly, since another call level here measurably slows small writes
			values = this.chunkDecoder.buffer ? this.chunkDecoder.decodeAfterIncomplete(chunk) : this.decoder.decodeMultiple(chunk)
		} catch(error) {
			values = error.values
			fatalError = this.chunkDecoder.keepIncomplete(error, chunk)
		}
		for (let value of values || []) {
			if (value === null)
				value = this.getNullValue()
			this.push(value)
		}
		callback(fatalError)
	}
	_flush(callback) {
		callback(this.chunkDecoder.end())
	}
	getNullValue() {
		return Symbol.for(null)
	}
}
