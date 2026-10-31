import { assert } from 'chai'
import { Decoder, DecoderStream, Encoder, Tag, addExtension, decode } from '../node-index.js'

const extensionTag = 43311
const encoder = new Encoder({ useRecords: false })
const reference = Buffer.from([0xe0])

function encoded(value) {
	return Buffer.from(encoder.encode(value))
}

function array(...items) {
	return Buffer.concat([Buffer.from([0x80 + items.length]), ...items])
}

function packed(rump, values = ['outer'], prefixes = [], suffixes = []) {
	// Tag 51 contains [values, prefixes, suffixes, rump]. Keep references in the rump encoded.
	return Buffer.concat([Buffer.from([0xd8, 0x33, 0x84]), encoded(values), encoded(prefixes), encoded(suffixes), rump])
}

function extension(bytes) {
	return encoded(new Tag(bytes, extensionTag))
}

suite('packed values across reentrant decode', () => {
	for (const mode of ['another instance', 'same instance', 'exported function']) {
		test(`preserves the outer table with ${mode}`, () => {
			const outer = new Decoder()
			const inner = mode === 'same instance' ? outer : new Decoder()
			addExtension({ tag: extensionTag, decode: bytes => mode === 'exported function' ? decode(bytes) : inner.decode(bytes) })
			const source = packed(array(reference, extension(encoded(1)), reference))
			assert.deepStrictEqual(outer.decode(source), ['outer', 1, 'outer'])
			assert.equal(outer.decode(encoded('fresh')), 'fresh')
		})
	}

	test('an inner packed table cannot silently replace the outer table', () => {
		const decoder = new Decoder()
		addExtension({ tag: extensionTag, decode: bytes => decoder.decode(bytes) })
		const inner = packed(array(reference, reference), ['inner'])
		const source = packed(array(reference, extension(inner), reference))
		assert.deepStrictEqual(decoder.decode(source), ['outer', ['inner', 'inner'], 'outer'])
	})

	test('restores independent tables at every nesting level', () => {
		const decoder = new Decoder()
		addExtension({ tag: extensionTag, decode: bytes => decoder.decode(bytes) })
		const inner = packed(array(reference, reference), ['inner'])
		const middle = packed(array(reference, extension(inner), reference), ['middle'])
		const source = packed(array(reference, extension(middle), reference))
		assert.deepStrictEqual(decoder.decode(source), ['outer', ['middle', ['inner', 'inner'], 'middle'], 'outer'])
	})

	test('restores the outer prefix and suffix tables', () => {
		const decoder = new Decoder()
		addExtension({ tag: extensionTag, decode: bytes => decoder.decode(bytes) })
		const prefix = value => encoded(new Tag(value, 225))
		const suffix = value => encoded(new Tag(value, 216))
		const inner = packed(array(prefix('inside'), suffix('inside')), ['inner'], [null, 'inner-prefix:'], [':inner-suffix'])
		const source = packed(array(prefix('before'), suffix('before'), extension(inner), prefix('after'), suffix('after')),
			['outer'], [null, 'outer-prefix:'], [':outer-suffix'])
		assert.deepStrictEqual(decoder.decode(source), [
			'outer-prefix:before', 'before:outer-suffix', ['inner-prefix:inside', 'inside:inner-suffix'],
			'outer-prefix:after', 'after:outer-suffix'
		])
	})

	test('preserves shared values alongside private packed values', () => {
		const sharedValues = Array(17).fill(null)
		sharedValues[16] = 'shared'
		const decoder = new Decoder({ sharedValues })
		addExtension({ tag: extensionTag, decode: bytes => new Decoder().decode(bytes) })
		const sharedReference = encoded(new Tag(0, 6)) // extended reference to index 16
		const source = packed(array(reference, sharedReference, extension(encoded(1)), reference, sharedReference), ['private'])
		assert.deepStrictEqual(decoder.decode(source), ['private', 'shared', 1, 'private', 'shared'])
		assert.equal(decoder.decode(sharedReference), 'shared')
	})

	test('restores the table when an extension catches a nested decoding error', () => {
		const decoder = new Decoder()
		let caught
		addExtension({ tag: extensionTag, decode(bytes) {
			try {
				decoder.decode(bytes)
			} catch (error) {
				caught = error
				return 'caught'
			}
		} })
		const truncated = packed(Buffer.from([0x62, 0x61]), ['inner'])
		const source = packed(array(reference, extension(truncated), reference))
		assert.deepStrictEqual(decoder.decode(source), ['outer', 'caught', 'outer'])
		assert.isTrue(caught.incomplete)
		assert.equal(decoder.decode(packed(reference, ['fresh'])), 'fresh')
	})

	test('a failed outer decode does not leak the nested table into a fresh decode', () => {
		const decoder = new Decoder()
		addExtension({ tag: extensionTag, decode: bytes => decoder.decode(bytes) })
		const truncated = packed(Buffer.from([0x62, 0x61]), ['inner'])
		const source = packed(array(reference, extension(truncated), reference))
		let caught
		try {
			decoder.decode(source)
		} catch (error) {
			caught = error
		}
		assert.match(caught.message, /Unexpected end/)
		assert.isFalse(caught.incomplete)
		assert.equal(decoder.decode(packed(reference, ['fresh'])), 'fresh')
	})

	test('reassembles packed values containing a nested decode one byte at a time', async () => {
		addExtension({ tag: extensionTag, decode: bytes => new Decoder().decode(bytes) })
		const source = packed(array(reference, extension(packed(reference, ['inner'])), reference))
		const stream = new DecoderStream()
		const received = []
		const finished = new Promise((resolve, reject) => {
			stream.on('data', value => received.push(value))
			stream.on('error', reject)
			stream.on('end', resolve)
		})
		for (const byte of source)
			stream.write(Buffer.from([byte]))
		stream.end()
		await finished
		assert.deepStrictEqual(received, [['outer', 'inner', 'outer']])
	})
})
