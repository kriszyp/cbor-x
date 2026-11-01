import { assert } from 'chai'
import { Decoder, DecoderStream, Encoder, Tag, addExtension, decodeMultiple } from '../node-index.js'

const extensionTag = 43312
const encoder = new Encoder({ useRecords: false })

function encoded(value) {
	return Buffer.from(encoder.encode(value))
}

function extension(bytes) {
	return encoded(new Tag(bytes, extensionTag))
}

function array(...items) {
	return Buffer.concat([Buffer.from([0x80 + items.length]), ...items])
}

suite('reentrant decodeMultiple', () => {
	for (const mode of ['another instance', 'same instance', 'exported function']) {
		test(`preserves the outer array with ${mode}`, () => {
			const outer = new Decoder()
			const inner = mode === 'same instance' ? outer : new Decoder()
			addExtension({ tag: extensionTag, decode: bytes => mode === 'exported function' ? decodeMultiple(bytes) : inner.decodeMultiple(bytes) })
			const source = array(extension(Buffer.from([1, 2, 3])), encoded(4))
			assert.deepStrictEqual(outer.decode(source), [[1, 2, 3], 4])
			assert.deepStrictEqual(outer.decodeMultiple(Buffer.from([5, 6])), [5, 6])
		})
	}

	test('restores every level of nested multi-value extensions', () => {
		const decoder = new Decoder()
		addExtension({ tag: extensionTag, decode: bytes => decoder.decodeMultiple(bytes) })
		const inner = Buffer.concat([encoded(1), extension(Buffer.from([2, 3])), encoded(4)])
		assert.deepStrictEqual(decoder.decode(array(extension(inner), encoded(5))), [[1, [2, 3], 4], 5])
	})

	for (const stopAfter of [1, 2, 3]) {
		test(`restores the outer decode after a nested callback stops at ${stopAfter}`, () => {
			const received = []
			addExtension({ tag: extensionTag, decode(bytes) {
				new Decoder().decodeMultiple(bytes, value => {
					received.push(value)
					return received.length < stopAfter
				})
				return 'nested'
			} })
			const source = array(extension(Buffer.from([1, 0x18, 128, 3])), encoded(4))
			assert.deepStrictEqual(new Decoder().decode(source), ['nested', 4])
			assert.deepStrictEqual(received, [1, 128, 3].slice(0, stopAfter))
		})
	}

	test('a callback can read another sequence, including after the final value', () => {
		const decoder = new Decoder()
		const received = []
		decoder.decodeMultiple(Buffer.from([1, 0x18, 128, 3]), value => {
			received.push(value)
			assert.deepStrictEqual(decoder.decodeMultiple(Buffer.from([4, 5])), [4, 5])
		})
		assert.deepStrictEqual(received, [1, 128, 3])
	})

	test('early stopping does not decode trailing invalid bytes', () => {
		const received = []
		addExtension({ tag: extensionTag, decode(bytes) {
			new Decoder().decodeMultiple(bytes, value => {
				received.push(value)
				return false
			})
			return 'nested'
		} })
		const source = array(extension(Buffer.from([1, 0x1c])), encoded(4))
		assert.deepStrictEqual(new Decoder().decode(source), ['nested', 4])
		assert.deepStrictEqual(received, [1])
	})

	test('outer batches continue after nested batches', () => {
		const decoder = new Decoder()
		addExtension({ tag: extensionTag, decode: bytes => decoder.decodeMultiple(bytes) })
		const source = Buffer.concat([encoded(1), extension(Buffer.from([2, 3])), encoded(4)])
		assert.deepStrictEqual(decoder.decodeMultiple(source), [1, [2, 3], 4])
	})

	test('retains outer record definitions after nested record definitions', () => {
		const outerEncoder = new Encoder({ sequential: true })
		const innerEncoder = new Encoder({ sequential: true })
		const before = Buffer.from(outerEncoder.encode({ outer: 1 }))
		const after = Buffer.from(outerEncoder.encode({ outer: 4 }))
		const inner = Buffer.concat([Buffer.from(innerEncoder.encode({ inner: 2 })), Buffer.from(innerEncoder.encode({ inner: 3 }))])
		const decoder = new Decoder()
		addExtension({ tag: extensionTag, decode: bytes => decoder.decodeMultiple(bytes) })
		assert.deepStrictEqual(decoder.decode(array(before, extension(inner), after)), [{ outer: 1 }, [{ inner: 2 }, { inner: 3 }], { outer: 4 }])
	})

	for (const [label, bytes, values, lastPosition] of [
		['an empty sequence', [], undefined, 0],
		['a truncated second value', [1, 0x62, 0x61], [1], 1]
	]) {
		test(`a caught error from ${label} preserves the outer decode`, () => {
			const decoder = new Decoder()
			let caught
			addExtension({ tag: extensionTag, decode(bytes) {
				try {
					decoder.decodeMultiple(bytes)
				} catch (error) {
					caught = error
					return 'caught'
				}
			} })
			assert.deepStrictEqual(decoder.decode(array(extension(Buffer.from(bytes)), encoded(4))), ['caught', 4])
			assert.isTrue(caught.incomplete)
			assert.equal(caught.lastPosition, lastPosition)
			assert.deepStrictEqual(caught.values, values)
			assert.deepStrictEqual(decoder.decodeMultiple(Buffer.from([5, 6])), [5, 6])
		})
	}

	test('an uncaught nested truncation is fatal for a complete outer value', () => {
		const decoder = new Decoder()
		addExtension({ tag: extensionTag, decode: bytes => decoder.decodeMultiple(bytes) })
		let caught
		try {
			decoder.decode(array(extension(Buffer.from([1, 0x62, 0x61])), encoded(4)))
		} catch (error) {
			caught = error
		}
		assert.match(caught.message, /Unexpected end/)
		assert.isFalse(caught.incomplete)
		assert.deepStrictEqual(decoder.decodeMultiple(Buffer.from([5, 6])), [5, 6])
	})

	test('a throwing nested callback can be caught without losing the outer state', () => {
		const decoder = new Decoder()
		const failure = new Error('callback failed')
		let caught
		addExtension({ tag: extensionTag, decode(bytes) {
			try {
				decoder.decodeMultiple(bytes, () => { throw failure })
			} catch (error) {
				caught = error
				return 'caught'
			}
		} })
		assert.deepStrictEqual(decoder.decode(array(extension(Buffer.from([1, 2])), encoded(4))), ['caught', 4])
		assert.strictEqual(caught, failure)
		assert.equal(caught.lastPosition, 0)
	})

	test('a nested sequence does not hide trailing bytes from single-value decoding', () => {
		const decoder = new Decoder()
		addExtension({ tag: extensionTag, decode: bytes => decoder.decodeMultiple(bytes) })
		assert.throws(() => decoder.decode(Buffer.concat([extension(Buffer.from([1, 2])), encoded(3)])), /end of buffer not reached/)
		assert.deepStrictEqual(decoder.decodeMultiple(Buffer.from([4, 5])), [4, 5])
	})

	test('streams can decode multi-value extensions split across chunks', async () => {
		addExtension({ tag: extensionTag, decode: bytes => new Decoder().decodeMultiple(bytes) })
		const source = Buffer.concat([array(extension(Buffer.from([1, 2, 3])), encoded(4)), encoded(5)])
		const stream = new DecoderStream()
		const received = []
		const completed = new Promise((resolve, reject) => {
			stream.on('data', value => received.push(value))
			stream.on('end', resolve)
			stream.on('error', reject)
		})
		for (const byte of source)
			stream.write(Buffer.from([byte]))
		stream.end()
		await completed
		assert.deepStrictEqual(received, [[[1, 2, 3], 4], 5])
	})
})
