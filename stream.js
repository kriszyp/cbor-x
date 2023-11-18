import { Transform } from 'stream'
import { Encoder } from './encode.js'
import { checkedRead, getPosition, Decoder, clearSource } from './decode.js'
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
	}
	_transform(chunk, encoding, callback) {
		if (this.incompleteBuffer) {
			chunk = Buffer.concat([this.incompleteBuffer, chunk])
			this.incompleteBuffer = null
		}
		let values
		try {
			values = this.decoder.decodeMultiple(chunk)
		} catch(error) {
			if (error.incomplete) {
				this.incompleteBuffer = chunk.slice(error.lastPosition)
				values = error.values
			} else {
				return callback(error)
			}
		} finally {
			for (let value of values || []) {
				if (value === null)
					value = this.getNullValue()
				this.push(value)
			}
		}
		callback()
	}
	getNullValue() {
		return Symbol.for(null)
	}
}
