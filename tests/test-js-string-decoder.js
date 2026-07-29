import chai from 'chai'
import { decode } from '../decode.js?js-string-tests'

const assert = chai.assert
const replacement = '\uFFFD'

function decodeText(bytes) {
	const header = bytes.length < 24 ? [0x60 + bytes.length] : [0x78, bytes.length]
	return decode(Uint8Array.from([...header, ...bytes]))
}

suite('JavaScript UTF-8 string decoder', function() {
	test('decodes valid multi-byte sequences', function() {
		assert.equal(decodeText([0xc2, 0xa2, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80]), '¢€😀')
		assert.equal(decodeText([0xf4, 0x8f, 0xbf, 0xbf]), String.fromCodePoint(0x10ffff))
	})

	test('reprocesses invalid UTF-8 continuation bytes', function() {
		const strings = [
			[[0xc0, 0xaf], replacement.repeat(2)],
			[[0xc2, 0x41], replacement + 'A'],
			[[0xe0, 0x9f, 0x80], replacement.repeat(3)],
			[[0xe1, 0x41, 0x42], replacement + 'AB'],
			[[0xe1, 0x80, 0x41], replacement + 'A'],
			[[0xed, 0xa0, 0x80], replacement.repeat(3)],
			[[0xf0, 0x80, 0x80, 0x41], replacement.repeat(3) + 'A'],
			[[0xf1, 0x41, 0x42, 0x43], replacement + 'ABC'],
			[[0xf1, 0x80, 0x41, 0x42], replacement + 'AB'],
			[[0xf1, 0x80, 0x80, 0x41], replacement + 'A'],
			[[0xf4, 0x90, 0x80, 0x80], replacement.repeat(4)],
			[[0xf5, 0x80, 0x80, 0x80], replacement.repeat(4)],
			[[0x80], replacement],
		]
		for (const [bytes, expected] of strings) {
			assert.equal(decodeText(bytes), expected)
		}
	})

	test('does not consume values following a truncated sequence', function() {
		assert.deepEqual(decode(Uint8Array.from([0x82, 0x61, 0xc2, 0x01])), [replacement, 1])
		assert.deepEqual(decode(Uint8Array.from([0x82, 0x62, 0xe1, 0x80, 0x01])), [replacement, 1])
		assert.deepEqual(decode(Uint8Array.from([0x82, 0x63, 0xf1, 0x80, 0x80, 0x01])), [replacement, 1])
		assert.deepEqual(
			decode(Uint8Array.from([0x83, 0x61, 0xe0, 0x64, 0x6e, 0x65, 0x78, 0x74, 0x07])),
			[replacement, 'next', 7]
		)
	})

	test('matches the TextDecoder path for the same malformed prefix', function() {
		const malformed = [0xf0, 0x80, 0x80, 0x41]
		const shortResult = decodeText(malformed)
		const padding = new Array(61).fill(0x41)
		assert.equal(decodeText([...malformed, ...padding]), shortResult + 'A'.repeat(61))
	})
})
