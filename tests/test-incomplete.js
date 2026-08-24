import { decode, encode } from '../index.js'
import { Decoder } from '../decode.js'
import { assert } from 'chai'
import { Encoder } from '../encode.js'

const tests = {
  string: 'interesting string',
  number: 12345,
  buffer: Buffer.from('hello world'),
  bigint: 12345678910n,
  array: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  'many-strings': [],
  set: new Set('abcdefghijklmnopqrstuvwxyz'.split('')),
  object: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }
}
for (let i = 0; i < 100; i++) {
  tests['many-strings'].push('test-data-' + i)
}

suite('encode and decode tests with partial values', function () {
  const encoder = new Encoder({ objectMode: true, structures: [] })

  for (const [label, testData] of Object.entries(tests)) {
    test(label, () => {
      const encoded = encoder.encode(testData)
      assert.isTrue(Buffer.isBuffer(encoded), 'encode returns a Buffer')
      assert.deepStrictEqual(encoder.decode(encoded, encoded.length, true), testData, 'full buffer decodes well')
      const firstHalf = encoded.slice(0, Math.floor(encoded.length / 2))
      let value
      try {
        value = encoder.decode(firstHalf, firstHalf.length, true)
      } catch (err) {
        if (err.incomplete !== true) {
          assert.fail(`Should throw an error with .incomplete set to true, instead threw error <${err}>`)
        } else {
          return; // victory! correct outcome!
        }
      }
      assert.fail(`Should throw an error with .incomplete set to true, instead returned value ${JSON.stringify(value)}`)
    })
  }
})

// A definite-length container declares its element count up front. Decoding must not trust that
// count enough to allocate or traverse it before the elements are actually present in the source,
// otherwise a few bytes of header can force arbitrarily large allocations and loops.
const malformedContainers = {
  'array32 declaring 20 million elements': [0x9a, 0x01, 0x31, 0x2d, 0x00],
  'array64 declaring 4 billion elements': [0x9b, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xfe],
  'array8 declaring 24 elements': [0x98, 0x18],
  'map32 declaring 16 million entries': [0xba, 0x00, 0xf4, 0x24, 0x00],
  'map with header only': [0xa1],
  'indefinite length array with no content': [0x9f],
  'indefinite length map with no content': [0xbf],
  'indefinite length array of truncated arrays': [0x9f, 0x9f],
  'nested arrays declaring a million elements each': [0x9a, 0, 0x10, 0, 0, 0x9a, 0, 0x10, 0, 0],
  'record definitions tag with a huge array': [0xd9, 0xdf, 0xfe, 0x9a, 0x7f, 0xff, 0xff, 0xff],
  'bundled strings tag with a huge array': [0xd9, 0xdf, 0xf9, 0x9a, 0x7f, 0xff, 0xff, 0xff]
}

suite('decode malformed containers', function () {
  this.timeout(1000) // these must all fail immediately, not after filling a declared length
  const decoders = [
    ['default', new Decoder()],
    ['mapsAsObjects: false', new Decoder({ mapsAsObjects: false })],
    ['useRecords', new Decoder({ useRecords: true, structures: [] })]
  ]
  for (const [label, bytes] of Object.entries(malformedContainers)) {
    test(label, () => {
      for (const [decoderLabel, decoder] of decoders) {
        assert.throws(() => decoder.decode(Buffer.from(bytes)), Error, undefined,
          `${label} should not decode (${decoderLabel})`)
      }
    })
  }

  test('rejecting an oversized declared length does not allocate', () => {
    let before = process.memoryUsage().heapUsed
    assert.throws(() => decode(Buffer.from([0x9a, 0x01, 0x31, 0x2d, 0x00])))
    // before this was checked, the 5 byte header above retained a 20 million element array (~150MB)
    assert.isBelow((process.memoryUsage().heapUsed - before) / 1048576, 50, 'heap growth in MB')
  })

  test('truncated data reports an incomplete error', () => {
    for (const bytes of [[0x9a, 0x01, 0x31, 0x2d, 0x00], [0x9f], [0xbf], [0x98, 0x18]]) {
      try {
        decode(Buffer.from(bytes))
        assert.fail(`${Buffer.from(bytes).toString('hex')} should not decode`)
      } catch (error) {
        assert.isTrue(error.incomplete, `${Buffer.from(bytes).toString('hex')}: ${error.message}`)
      }
    }
  })
})
