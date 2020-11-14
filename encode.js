"use strict"
let Decoder = require('./unencode').Decoder
let encoder
try {
	encoder = new TextEncoder()
} catch (error) {}
const RECORD_SYMBOL = Symbol('record-id')
class Encoder extends Decoder {
	constructor(options) {
		super(options)
		this.offset = 0
		let target = new ByteArray(8192) // as you might expect, allocUnsafeSlow is the fastest and safest way to allocate memory
		let targetView = new DataView(target.buffer, 0, 8192)
		let typeBuffer
		let position = 0
		let start
		let safeEnd
		let sharedStructures
		let hasSharedUpdate
		let structures
		let types
		let lastSharedStructuresLength = 0
		let encodeUtf8 = target.utf8Write ? function(string, position, maxBytes) {
			return target.utf8Write(string, position, maxBytes)
		} : encoder.encodeInto ?
			function(string, position) {
				return encoder.encodeInto(string, target.subarray(position)).written
			} : false

		let encoder = this
		let maxSharedStructures = 32
		let isSequential = options && options.sequential
		if (isSequential) {
			maxSharedStructures = 0
			this.structures = []
		}
		let recordIdsToRemove = []
		let transitionsCount = 0
		let serializationsSinceTransitionRebuild = 0
		if (this.structures && this.structures.length > maxSharedStructures) {
			throw new Error('Too many shared structures')
		}

		this.encode = function(value) {
			position = encoder.offset
			safeEnd = target.length - 10
			if (safeEnd - position < 0x800) {
				// don't start too close to the end, 
				target = new ByteArray(target.length)
				targetView = new DataView(target.buffer, 0, target.length)
				safeEnd = target.length - 10
				position = 0
			}
			start = position
			sharedStructures = encoder.structures
			if (sharedStructures) {
				let sharedStructuresLength = sharedStructures.length
				if (sharedStructuresLength >  maxSharedStructures && !isSequential)
					sharedStructuresLength = maxSharedStructures
				if (!sharedStructures.transitions) {
					// rebuild our structure transitions
					sharedStructures.transitions = Object.create(null)
					for (let i = 0; i < sharedStructuresLength; i++) {
						let keys = sharedStructures[i]
						let nextTransition, transition = sharedStructures.transitions
						for (let i =0, l = keys.length; i < l; i++) {
							let key = keys[i]
							nextTransition = transition[key]
							if (!nextTransition) {
								nextTransition = transition[key] = Object.create(null)
							}
							transition = nextTransition
						}
						transition[RECORD_SYMBOL] = i + 0x40
					}
					lastSharedStructuresLength = sharedStructures.length
				}
				if (!isSequential)
					sharedStructures.nextId = sharedStructuresLength + 0x40
			}
			if (hasSharedUpdate)
				hasSharedUpdate = false
			structures = sharedStructures || []
			try {
				encode(value)
				encoder.offset = position // update the offset so next serialization doesn't write over our buffer, but can continue writing to same buffer sequentially
				return target.subarray(start, position) // position can change if we call encode again in saveStructures, so we get the buffer now
			} finally {
				if (sharedStructures) {
					if (serializationsSinceTransitionRebuild < 10)
						serializationsSinceTransitionRebuild++
					if (transitionsCount > 5000) {
						// force a rebuild occasionally after a lot of transitions so it can get cleaned up
						sharedStructures.transitions = null
						serializationsSinceTransitionRebuild = 0
						transitionsCount = 0
						if (recordIdsToRemove.length > 0)
							recordIdsToRemove = []
					} else if (recordIdsToRemove.length > 0 && !isSequential) {
						for (let i = 0, l = recordIdsToRemove.length; i < l; i++) {
							recordIdsToRemove[i][RECORD_SYMBOL] = 0
						}
						recordIdsToRemove = []
					}
					if (hasSharedUpdate && encoder.saveStructures) {
						if (encoder.structures.length > maxSharedStructures) {
							encoder.structures = encoder.structures.slice(0, maxSharedStructures)
						}

						if (encoder.saveStructures(encoder.structures, lastSharedStructuresLength) === false) {
							// get updated structures and try again if the update failed
							encoder.structures = encoder.getStructures() || []
							return encoder.encode(value)
						}
						lastSharedStructuresLength = encoder.structures.length
					}
				}
			}
		}
		const encode = (value) => {
			if (position > safeEnd)
				target = makeRoom(position)

			var type = typeof value
			var length
			if (type === 'string') {
				let strLength = value.length
				let headerSize
				// first we estimate the header size, so we can write to the correct location
				if (strLength < 0x20) {
					headerSize = 1
				} else if (strLength < 0x100) {
					headerSize = 2
				} else if (strLength < 0x10000) {
					headerSize = 3
				} else {
					headerSize = 5
				}
				let maxBytes = strLength * 3
				if (position + maxBytes > safeEnd)
					target = makeRoom(position + maxBytes)

				if (strLength < 0x40 || !encodeUtf8) {
					let i, c1, c2, strPosition = position + headerSize
					for (i = 0; i < strLength; i++) {
						c1 = value.charCodeAt(i)
						if (c1 < 0x80) {
							target[strPosition++] = c1
						} else if (c1 < 0x800) {
							target[strPosition++] = c1 >> 6 | 0xc0
							target[strPosition++] = c1 & 0x3f | 0x80
						} else if (
							(c1 & 0xfc00) === 0xd800 &&
							((c2 = value.charCodeAt(i + 1)) & 0xfc00) === 0xdc00
						) {
							c1 = 0x10000 + ((c1 & 0x03ff) << 10) + (c2 & 0x03ff)
							i++
							target[strPosition++] = c1 >> 18 | 0xf0
							target[strPosition++] = c1 >> 12 & 0x3f | 0x80
							target[strPosition++] = c1 >> 6 & 0x3f | 0x80
							target[strPosition++] = c1 & 0x3f | 0x80
						} else {
							target[strPosition++] = c1 >> 12 | 0xe0
							target[strPosition++] = c1 >> 6 & 0x3f | 0x80
							target[strPosition++] = c1 & 0x3f | 0x80
						}
					}
					length = strPosition - position - headerSize
				} else {
					length = encodeUtf8(value, position + headerSize, maxBytes)
				}

				if (length < 0x18) {
					target[position++] = 0x60 | length
				} else if (length < 0x100) {
					if (headerSize < 2) {
						target.copyWithin(position + 2, position + 1, position + 1 + length)
					}
					target[position++] = 0x78
					target[position++] = length
				} else if (length < 0x10000) {
					if (headerSize < 3) {
						target.copyWithin(position + 3, position + 2, position + 2 + length)
					}
					target[position++] = 0x79
					target[position++] = length >> 8
					target[position++] = length & 0xff
				} else {
					if (headerSize < 5) {
						target.copyWithin(position + 5, position + 3, position + 3 + length)
					}
					target[position++] = 0x7a
					targetView.setUint32(position, length)
					position += 4
				}
				position += length
			} else if (type === 'number') {
				if (value >> 0 == value) {// integer, 32-bit or less
					if (value >= 0) {
						// positive uint
						if (value < 0x18) {
							target[position++] = value
						} else if (value < 0x100) {
							target[position++] = 0x18
							target[position++] = value
						} else if (value < 0x10000) {
							target[position++] = 0x19
							target[position++] = value >> 8
							target[position++] = value & 0xff
						} else {
							target[position++] = 0x1a
							targetView.setUint32(position, value)
							position += 4
						}
					} else {
						// negative int
						if (value >= -0x18) {
							target[position++] = 0x38 + value
						} else if (value >= -0x100) {
							target[position++] = 0x38
							target[position++] = value + 0x100
						} else if (value >= -0x10000) {
							target[position++] = 0x39
							targetView.setUint16(position, -value)
							position += 2
						} else {
							target[position++] = 0x3a
							targetView.setUint32(position, -value)
							position += 4
						}
					}
				} else {
					// very difficult to tell if float is sufficient, just use double for now
					target[position++] = 0xfb
					targetView.setFloat64(position, value)
					/*if (!target[position[4] && !target[position[5] && !target[position[6] && !target[position[7] && !(target[0] & 0x78) < ) {
						// something like this can be represented as a float
					}*/
					position += 8
				}
			} else if (type === 'object') {
				if (!value)
					target[position++] = 0xf6
				else {
					let constructor = value.constructor
					if (constructor === Object) {
						writeObject(value, true)
					} else if (constructor === Array) {
						length = value.length
						if (length < 0x18) {
							target[position++] = 0x80 | length
						} else if (length < 0x100) {
							target[position++] = 0x98
							target[position++] = length
						} else if (length < 0x10000) {
							target[position++] = 0x99
							target[position++] = length >> 8
							target[position++] = length & 0xff
						} else {
							target[position++] = 0x9a
							targetView.setUint32(position, length)
							position += 4
						}
						for (let i = 0; i < length; i++) {
							encode(value[i])
						}
					} else if (constructor === Map) {
						length = value.size
						if (length < 0x18) {
							target[position++] = 0xa0 | length
						} else if (length < 0x100) {
							target[position++] = 0xb8
							target[position++] = length
						} else if (length < 0x10000) {
							target[position++] = 0xb9
							target[position++] = length >> 8
							target[position++] = length & 0xff
						} else {
							target[position++] = 0xba
							targetView.setUint32(position, length)
							position += 4
						}
						for (let [ key, entryValue ] of value) {
							encode(key)
							encode(entryValue)
						}
					} else if (constructor === Date) {
						// using the 32 timestamp for now, TODO: implement support for 64-bit and 128-bit
						length = value.getTime() / 1000
						target[position++] = 0xd6
						target[position++] = 0xff
						targetView.setUint32(position, length)
						position += 4
					} else if (constructor === Buffer) {
						length = value.length
						if (length < 0x100) {
							target[position++] = 0x58
							target[position++] = length
						} else if (length < 0x10000) {
							target[position++] = 0x59
							target[position++] = length >> 8
							target[position++] = length & 0xff
						} else {
							target[position++] = 0x5a
							targetView.setUint32(position, length)
							position += 4
						}
						if (position + length > safeEnd)
							makeRoom(position + length)
						if (value.copy)
							value.copy(target, position)
						else
							copyBinary(value, target, position, 0, value.length)
						position += length
					} else {	
						writeObject(value, false)
					}
				}
			} else if (type === 'boolean') {
				target[position++] = value ? 0xf5 : 0xf4
			} else if (type === 'bigint') {
				target[position++] = 0xfb
				/*if (value < 9223372036854776000 && value > -9223372036854776000) 
					targetView.setBigInt64(position, value)
				else*/
					targetView.setFloat64(position, value)
				position += 8
			} else if (type === 'undefined') {
				//target[position++] = 0xc1 // this is the "never-used" byte
				target[position++] = 0xf7
			} else {
				throw new Error('Unknown type ' + type)
			}
		}

		const writeObject = this.objectsAsMaps ? (object, safePrototype) => {
			target[position++] = 0xde // always use map 16, so we can preallocate and set the length afterwards
			let objectOffset = position - start
			position += 2
			let size = 0
			for (let key in object) {
				if (safePrototype || object.hasOwnProperty(key)) {
					encode(key)
					encode(object[key])
					size++
				}
			}
			target[objectOffset++ + start] = size >> 8
			target[objectOffset + start] = size & 0xff
		} :
	/*	sharedStructures ?  // For highly stable structures, using for-in can a little bit faster
		(object, safePrototype) => {
			let nextTransition, transition = structures.transitions || (structures.transitions = Object.create(null))
			let objectOffset = position++ - start
			let wroteKeys
			for (let key in object) {
				if (safePrototype || object.hasOwnProperty(key)) {
					nextTransition = transition[key]
					if (!nextTransition) {
						nextTransition = transition[key] = Object.create(null)
						nextTransition.__keys__ = (transition.__keys__ || []).concat([key])
						/*let keys = Object.keys(object)
						if 
						let size = 0
						let startBranch = transition.__keys__ ? transition.__keys__.length : 0
						for (let i = 0, l = keys.length; i++) {
							let key = keys[i]
							size += key.length << 2
							if (i >= startBranch) {
								nextTransition = nextTransition[key] = Object.create(null)
								nextTransition.__keys__ = keys.slice(0, i + 1)
							}
						}
						makeRoom(position + size)
						nextTransition = transition[key]
						target.copy(target, )
						objectOffset
					}
					transition = nextTransition
					encode(object[key])
				}
			}
			let id = transition.id
			if (!id) {
				id = transition.id = structures.push(transition.__keys__) + 63
				if (sharedStructures.onUpdate)
					sharedStructures.onUpdate(id, transition.__keys__)
			}
			target[objectOffset + start] = id
		}*/
		(object) => {
			let keys = Object.keys(object)
			let nextTransition, hasNewTransition, transition = structures.transitions || (structures.transitions = Object.create(null))
			for (let i =0, l = keys.length; i < l; i++) {
				let key = keys[i]
				nextTransition = transition[key]
				if (!nextTransition) {
					nextTransition = transition[key] = Object.create(null)
					hasNewTransition = true
				}
				transition = nextTransition
			}
			let recordId = transition[RECORD_SYMBOL]
			if (recordId) {
				target[position++] = recordId
			} else {
				recordId = structures.nextId++
				if (!recordId) {
					recordId = 0x40
					structures.nextId = 0x41
				}
				if (recordId >= 0x80) {// cycle back around
					structures.nextId = (recordId = maxSharedStructures + 0x40) + 1
				}
				transition[RECORD_SYMBOL] = recordId
				structures[0x3f & recordId] = keys
				if (sharedStructures && sharedStructures.length <= maxSharedStructures) {
					target[position++] = recordId
					hasSharedUpdate = true
				} else {
					target[position++] = 0xd4 // fixext 1
					target[position++] = 0x72 // "r" record defintion extension type
					target[position++] = recordId
					if (hasNewTransition)
						transitionsCount += serializationsSinceTransitionRebuild
					// record the removal of the id, we can maintain our shared structure
					if (recordIdsToRemove.length >= 0x40 - maxSharedStructures)
						recordIdsToRemove.shift()[RECORD_SYMBOL] = 0 // we are cycling back through, and have to remove old ones
					recordIdsToRemove.push(transition)
					encode(keys)
				}
			}
			// now write the values
			for (let i =0, l = keys.length; i < l; i++)
				encode(object[keys[i]])
		}
		const makeRoom = (end) => {
			let newSize = ((Math.max((end - start) << 2, target.length - 1) >> 12) + 1) << 12
			let newBuffer = new ByteArray(newSize)
			targetView = new DataView(newBuffer.buffer, 0, newSize)
			target.copy(newBuffer, 0, start, end)
			if (target.copy)
				target.copy(newBuffer, 0, start, end)
			else
				copyBinary(target, newBuffer, 0, start, end)
			position -= start
			start = 0
			safeEnd = newBuffer.length - 10
			return target = newBuffer
		}
	}
	resetMemory() {
		// this means we are finished using our local buffer and we can write over it safely
		this.offset = 0
	}
}
exports.Encoder = Encoder

let ByteArray = typeof window == 'undefined' ? Buffer.allocUnsafeSlow : Uint8Array
function copyBinary(source, target, targetOffset, offset, endOffset) {
	while (offset < endOffset) {
		target[targetOffset++] = source[offset++]
	}
}