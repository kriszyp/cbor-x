import { Decoder, decode, decodeMultiple, setSizeLimits, addExtension } from '../decode.js'
import { Encoder } from '../encode.js'
import { DecoderStream, decodeIter } from '../node-index.js'
import { assert } from 'chai'

// A prefix of a valid encoding can only fail because bytes are missing, so it must always be reported as
// incomplete. DecoderStream relies on this to wait for the next chunk instead of erroring.
const values = {
	'small ints': [0, 1, 23, 24, 255, 256, 65535, 65536, 0xffffffff, 2 ** 32, 2 ** 53 - 1],
	'negative ints': [-1, -24, -25, -256, -257, -65537, -(2 ** 32), -(2 ** 53)],
	bigints: [2n ** 64n - 1n, -(2n ** 63n), 2n ** 70n],
	floats: [1.5, 0.1, -1e300, 3.4e38, NaN, Infinity],
	strings: ['', 'a', 'x'.repeat(23), 'y'.repeat(24), 'z'.repeat(300), 'é∂ü😀'.repeat(5), 'k'.repeat(70000)],
	'object keys': { a: 1, bb: 2, ccc: 3, dddd: 4, eeeee: 5, ffffffffffffffff: 6, ['g'.repeat(23)]: 7 },
	'repeated keys': [{ name: 'a', id: 1 }, { name: 'b', id: 2 }, { name: 'c', id: 3 }],
	buffers: [Buffer.alloc(0), Buffer.from('hello'), Buffer.alloc(300, 7)],
	'typed arrays': [new Uint16Array([1, 2, 3]), new Float64Array([1.5, 2.5]), new Int32Array([-1, 7]),
		new Float32Array([0.5]), new BigInt64Array([5n])],
	'large array': new Array(300).fill(0).map((_, i) => i),
	'large map': new Map(new Array(300).fill(0).map((_, i) => [i, 'v' + i])),
	set: new Set([1, 'two', 3]),
	date: new Date(1700000000000),
	regexp: /ab+c/gi,
	error: new Error('boom'),
	nested: { list: [[1, [2, [3, { deep: [4] }]]]], map: new Map([['k', { v: [1.5] }]]) }
}

const configs = {
	default: {},
	'mapsAsObjects: false': { mapsAsObjects: false },
	useRecords: { useRecords: true },
	pack: { pack: true },
	bundleStrings: { bundleStrings: true },
	useFloat32: { useFloat32: 1 },
	'tagUint8Array + int64AsNumber': { tagUint8Array: true, int64AsNumber: true },
	keyMap: { keyMap: { name: 1, id: 2, a: 3 } },
	useSelfDescribedHeader: { useSelfDescribedHeader: true },
	useStringRefs: { useStringRefs: true },
	'shared structures': { structures: [] }
}

function assertIncomplete(decoder, bytes, label) {
	let value
	try {
		value = decoder.decode(bytes)
	} catch (error) {
		assert.isTrue(error.incomplete, `${label}: threw a non-incomplete ${error.constructor.name}: ${error.message}`)
		return
	}
	assert.fail(`${label}: decoded ${String(value)} from a truncated encoding`)
}

suite('truncated encodings', function () {
	this.timeout(20000)
	for (const [configLabel, options] of Object.entries(configs)) {
		test(configLabel, () => {
			for (const [label, value] of Object.entries(values)) {
				// separate copies so an encoder and decoder can share structures
				const encoded = new Encoder({ ...options }).encode(value)
				const decoder = new Decoder({ ...options })
				decoder.decode(encoded)
				// every boundary near the headers and the end, sampled through the middle of long values
				for (let end = 0; end < encoded.length; end += end < 512 || end > encoded.length - 512 ? 1 : 251) {
					// a copy, so the DataView ends with the data, as it does for a stream chunk
					assertIncomplete(decoder, Buffer.from(encoded.subarray(0, end)), `${label} [0, ${end})`)
					// a view onto a longer buffer, delimited only by the end argument
					try {
						decoder.decode(encoded, end)
						assert.fail(`${label}: decoded with end ${end}`)
					} catch (error) {
						assert.isTrue(error.incomplete, `${label} end=${end}: ${error.message}`)
					}
				}
			}
		})
	}

	test('decodeIter reassembles a sequence split at every offset', () => {
		const encoder = new Encoder()
		const items = [{ a: 'hello' }, [1, 2.5, 'three'], 'x'.repeat(30), 70000, new Map([[1, 2]])]
		const encoded = Buffer.concat(items.map(item => encoder.encode(item)))
		const expected = items.map(item => new Decoder().decode(encoder.encode(item)))
		for (let split = 1; split < encoded.length; split++) {
			assert.deepStrictEqual([...decodeIter([encoded.subarray(0, split), encoded.subarray(split)])], expected,
				`split at ${split}`)
		}
	})

	test('DecoderStream reassembles a sequence split at every offset', async () => {
		const items = Object.values(values)
		const encoder = new Encoder()
		const encoded = Buffer.concat(items.map(item => encoder.encode(item)))
		const expected = items.map(item => new Decoder().decode(encoder.encode(item)))
		for (let split = 1; split < encoded.length; split += split < 200 ? 1 : 97) {
			const stream = new DecoderStream()
			const received = []
			let failure
			stream.on('data', value => received.push(value))
			stream.on('error', error => failure = error)
			stream.write(encoded.subarray(0, split))
			stream.write(encoded.subarray(split))
			stream.end()
			await new Promise(resolve => {
				stream.on('finish', resolve)
				stream.on('error', resolve)
			})
			assert.isUndefined(failure, `split at ${split}: ${failure?.message}`)
			assert.deepStrictEqual(received, expected, `split at ${split}`)
		}
	})
})

// The decoder recurses once per level of nesting; input nested deeper than the call stack allows must fail
// as a normal (fatal) error, not be mistaken for truncated input that more bytes could complete.
const deeplyNested = {
	arrays: Buffer.alloc(100000, 0x81),
	'indefinite length arrays': Buffer.alloc(100000, 0x9f),
	maps: Buffer.alloc(200000, 0xa1).map((byte, i) => i % 2 ? 0x01 : byte),
	tags: Buffer.alloc(200000, 0xc0).map((byte, i) => i % 2 ? 0x81 : byte)
}

suite('deeply nested input', function () {
	for (const [label, bytes] of Object.entries(deeplyNested)) {
		test(label, () => {
			for (const decoder of [new Decoder(), new Decoder({ mapsAsObjects: false }), new Decoder({ useRecords: true })]) {
				for (const decodeFn of [bytes => decoder.decode(bytes), bytes => decoder.decodeMultiple(bytes)]) {
					try {
						decodeFn(bytes)
						assert.fail('should not decode')
					} catch (error) {
						assert.instanceOf(error, RangeError)
						assert.isNotOk(error.incomplete, error.message)
					}
				}
				assert.deepStrictEqual(decoder.decode(Buffer.from([0x82, 0x01, 0x61, 0x61])), [1, 'a'], 'decoder recovers')
			}
		})
	}

	test('DecoderStream errors instead of waiting for more data', async () => {
		const stream = new DecoderStream()
		stream.on('data', () => {})
		const error = await new Promise(resolve => {
			stream.on('error', resolve)
			stream.write(deeplyNested.arrays)
		})
		assert.instanceOf(error, RangeError)
		assert.isUndefined(stream.incompleteBuffer)
	})

	test('decodeIter yields the values that precede a fatal error', async () => {
		const bytes = Buffer.concat([Buffer.from([0x01, 0x61, 0x61]), deeplyNested.arrays])
		const received = []
		assert.throws(() => { for (const value of decodeIter([bytes])) received.push(value) }, RangeError)
		assert.deepStrictEqual(received, [1, 'a'])
		const receivedAsync = []
		try {
			for await (const value of decodeIter((async function * () { yield bytes })())) receivedAsync.push(value)
			assert.fail('should throw')
		} catch (error) {
			assert.instanceOf(error, RangeError)
		}
		assert.deepStrictEqual(receivedAsync, [1, 'a'])
	})

	test('DecoderStream emits the values that precede a fatal error', async () => {
		const stream = new DecoderStream()
		const received = []
		stream.on('data', value => received.push(value))
		await new Promise(resolve => {
			stream.on('error', resolve)
			stream.write(Buffer.concat([Buffer.from([0x01, 0x61, 0x61]), deeplyNested.arrays]))
		})
		assert.deepStrictEqual(received, [1, 'a'])
	})

	test('moderately nested data still decodes', () => {
		let value = 'leaf'
		for (let i = 0; i < 1000; i++) value = i % 2 ? [value] : { a: value }
		assert.deepStrictEqual(decode(new Encoder().encode(value)), value)
	})

	test('encoding too deep a structure throws and leaves the encoder usable', () => {
		let value = []
		for (let i = 0; i < 100000; i++) value = [value]
		const encoder = new Encoder()
		assert.throws(() => encoder.encode(value), RangeError)
		assert.deepStrictEqual(decode(encoder.encode({ a: [1, 'b'] })), { a: [1, 'b'] })
	})
})

suite('size limits', function () {
	const defaults = { maxArraySize: 112810000, maxMapSize: 16810000, maxObjectSize: 16710000 }
	teardown(() => setSizeLimits(defaults))
	const definiteMap = Buffer.from([0xa6, ...[1, 2, 3, 4, 5, 6].flatMap(i => [0x61, 0x60 + i, i])])
	const indefiniteMap = Buffer.from([0xbf, ...definiteMap.subarray(1), 0xff])

	test('maxObjectSize limits object properties', () => {
		setSizeLimits({ maxObjectSize: 5 })
		for (const bytes of [definiteMap, indefiniteMap]) {
			assert.throws(() => new Decoder({ mapsAsObjects: true }).decode(bytes), /Property count exceeds 5/)
			assert.strictEqual(new Decoder({ mapsAsObjects: false }).decode(bytes).size, 6, 'does not limit a Map')
		}
	})

	test('limits allow exactly the configured size', () => {
		setSizeLimits({ maxObjectSize: 6, maxMapSize: 6, maxArraySize: 3 })
		for (const bytes of [definiteMap, indefiniteMap]) {
			assert.strictEqual(Object.keys(new Decoder({ mapsAsObjects: true }).decode(bytes)).length, 6)
			assert.strictEqual(new Decoder({ mapsAsObjects: false }).decode(bytes).size, 6)
		}
		assert.deepStrictEqual(decode(Buffer.from([0x83, 1, 2, 3])), [1, 2, 3])
		assert.deepStrictEqual(decode(Buffer.from([0x9f, 1, 2, 3, 0xff])), [1, 2, 3])
		assert.throws(() => decode(Buffer.from([0x84, 1, 2, 3, 4])), /Array length exceeds 3/)
		assert.throws(() => decode(Buffer.from([0x9f, 1, 2, 3, 4, 0xff])), /Array length exceeds 3/)
	})

	test('maxMapSize limits Map entries and object properties', () => {
		setSizeLimits({ maxMapSize: 5 })
		for (const bytes of [definiteMap, indefiniteMap]) {
			assert.throws(() => new Decoder({ mapsAsObjects: false }).decode(bytes), /Map size exceeds 5/)
			assert.throws(() => new Decoder({ mapsAsObjects: true }).decode(bytes), /Property count exceeds 5/)
		}
	})
})

// Complete input that is invalid must fail as a fatal error; marked incomplete, DecoderStream would keep it
// and append every later chunk to it.
suite('complete but invalid input is not incomplete', function () {
	addExtension({ tag: 40002, decode: bytes => new Decoder().decode(bytes) })
	const cases = {
		'packed values table with no values': [0xd8, 0x33, 0x84, 0x80, 0x80, 0x80, 0x01],
		'packed values table without an array': [0xd8, 0x33, 0x01],
		'packed values table with a string for values': [0xd8, 0x33, 0x84, 0x61, 0x61, 0x80, 0x80, 0x01],
		'packed reference to undefined': [0xd8, 0x33, 0x84, 0x81, 0x01, 0x80, 0x80, 0xc6, 0xf7],
		'extension decoding a truncated embedded value': [0xd9, 0x9c, 0x42, 0x42, 0x82, 0x01]
	}
	for (const [label, bytes] of Object.entries(cases)) {
		test(label, async () => {
			try {
				new Decoder().decode(Buffer.from(bytes))
				assert.fail('should not decode')
			} catch (error) {
				assert.isNotOk(error.incomplete, error.message)
			}
			const stream = new DecoderStream()
			stream.on('data', () => {})
			const error = await new Promise(resolve => {
				stream.on('error', resolve)
				stream.write(Buffer.from(bytes))
			})
			assert.isNotOk(error.incomplete)
			assert.isUndefined(stream.incompleteBuffer)
		})
	}
	test('an extension sees whether its own nested decode was incomplete', () => {
		addExtension({ tag: 40003, decode: bytes => {
			try {
				return new Decoder().decode(bytes)
			} catch (error) {
				return { incomplete: error.incomplete }
			}
		} })
		assert.deepStrictEqual(new Decoder().decode(Buffer.from([0xd9, 0x9c, 0x43, 0x42, 0x82, 0x01])), { incomplete: true })
	})

	test('an extension throwing a non-Error value', () => {
		addExtension({ tag: 40004, decode: () => { throw 'invalid' } })
		assert.throws(() => new Decoder().decode(Buffer.from([0xd9, 0x9c, 0x44, 0x01])), 'invalid')
	})

	test('packed values table truncated after its tag', () => {
		try {
			new Decoder().decode(Buffer.from([0xd8, 0x33]))
			assert.fail('should not decode')
		} catch (error) {
			assert.isTrue(error.incomplete, error.message)
		}
	})
})

suite('tag 259 (map)', function () {
	const object = Buffer.from([0xa1, 0x61, 0x61, 0x01]) // {a: 1}
	const cases = {
		'wrapping a map': [0xd9, 0x01, 0x03, 0xa1, 0x01, 0x02],
		'wrapping a non-map': [0xd9, 0x01, 0x03, 0x01],
		'truncated': [0xd9, 0x01, 0x03],
		'wrapping deeply nested input': [0xd9, 0x01, 0x03, ...deeplyNested.arrays]
	}
	for (const [label, bytes] of Object.entries(cases)) {
		test(`${label} does not change how later maps decode`, () => {
			const decoder = new Decoder({ mapsAsObjects: true })
			try {
				decoder.decode(Buffer.from(bytes))
			} catch (error) {}
			assert.deepStrictEqual(decoder.decode(object), { a: 1 })
		})
	}

	test('an extension that decodes embedded data does not change either decoder', () => {
		let inner
		addExtension({ tag: 40001, decode: bytes => inner.decode(bytes) })
		const embedded = { valid: [0xa1, 0x61, 0x62, 0x02], invalid: [0x1c] } // {b: 2}, and an invalid token
		for (const mapsAsObjects of [true, false]) {
			for (const [label, embeddedBytes] of Object.entries(embedded)) {
				inner = new Decoder({ mapsAsObjects })
				const outer = new Decoder({ mapsAsObjects: true })
				try { // 259(40001(h'...'))
					outer.decode(Buffer.from([0xd9, 0x01, 0x03, 0xd9, 0x9c, 0x41, 0x40 + embeddedBytes.length, ...embeddedBytes]))
				} catch (error) {}
				const description = `${label} embedded data, inner mapsAsObjects: ${mapsAsObjects}`
				assert.deepStrictEqual(outer.decode(object), { a: 1 }, `outer decoder (${description})`)
				assert.deepStrictEqual(inner.decode(object), mapsAsObjects ? { a: 1 } : new Map([['a', 1]]),
					`inner decoder (${description})`)
			}
		}
	})

	test('decodes only the tagged map as a Map', () => {
		const decoded = new Decoder({ mapsAsObjects: true }).decode(
			Buffer.from([0xd9, 0x01, 0x03, 0xa1, 0x01, 0xa1, 0x61, 0x62, 0x02])) // 259({1: {b: 2}})
		assert.deepStrictEqual(decoded, new Map([[1, { b: 2 }]]))
	})

	test('a stream retry after truncation inside a tagged value decodes the same', async () => {
		const bytes = Buffer.from([0xa1, 0x61, 0x61, 0xd9, 0x01, 0x03, 0xa1, 0x01, 0x02]) // {a: 259({1: 2})}
		const stream = new DecoderStream({ mapsAsObjects: true })
		const received = []
		stream.on('data', value => received.push(value))
		stream.write(bytes.subarray(0, 6))
		stream.write(bytes.subarray(6))
		stream.end()
		await new Promise(resolve => stream.on('finish', resolve))
		assert.deepStrictEqual(received, [{ a: new Map([[1, 2]]) }])
	})
})
