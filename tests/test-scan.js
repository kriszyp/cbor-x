import { assert } from 'chai'
import { performance } from 'node:perf_hooks'
import { Decoder, Encoder, DecoderStream, decodeIter, addExtension, Tag } from '../node-index.js'
import { StructureScanner } from '../scan.js'

function chunks (bytes, size) {
  const parts = []
  for (let i = 0; i < bytes.length; i += size) parts.push(bytes.subarray(i, i + size))
  return parts
}

async function streamDecode (parts, options) {
  const stream = new DecoderStream(options)
  const values = []
  const ends = []
  let fed = 0
  let calls = 0
  const decodeMultiple = stream.decoder.decodeMultiple
  stream.decoder.decodeMultiple = function (source) {
    calls++
    return decodeMultiple.call(this, source)
  }
  stream.on('data', value => { values.push(value); ends.push(fed) })
  const done = new Promise(resolve => {
    stream.once('error', error => resolve(error))
    stream.once('finish', () => resolve())
  })
  for (const part of parts) {
    if (stream.errored) break
    fed += part.length
    stream.write(part)
  }
  stream.end()
  return { error: await done, values, calls, ends, scanner: stream.chunkDecoder.scanner }
}

function iterDecode (parts, options) {
  let calls = 0
  const decodeMultiple = Decoder.prototype.decodeMultiple
  Decoder.prototype.decodeMultiple = function (source) {
    calls++
    return decodeMultiple.call(this, source)
  }
  try {
    return { values: [...decodeIter(parts, options)], calls }
  } finally {
    Decoder.prototype.decodeMultiple = decodeMultiple
  }
}

suite('resumable structure scan', function () {
  this.timeout(20000)

  test('4 MiB of small strings uses two decodes in streams and iterators', async () => {
    const count = Math.floor(4 * 1048576 / 21)
    const bytes = Buffer.alloc(5 + count * 21, 120)
    bytes[0] = 0x9a
    bytes.writeUInt32BE(count, 1)
    for (let i = 5; i < bytes.length; i += 21) bytes[i] = 0x74
    const parts = chunks(bytes, 16384)
    const start = performance.now()
    const iter = iterDecode(parts)
    const stream = await streamDecode(parts)
    assert.isUndefined(stream.error)
    assert.strictEqual(iter.calls, 2)
    assert.strictEqual(stream.calls, 2)
    assert.strictEqual(iter.values[0].length, count)
    assert.isTrue(iter.values[0].every(value => value === 'x'.repeat(20)))
    assert.deepStrictEqual(stream.values, iter.values)
    assert.strictEqual(stream.scanner.headers, count + 1)
    assert.isBelow(performance.now() - start, 5000)
  })

  test('deep fanout-two trees scan every header once', async () => {
    let tree = 'x'.repeat(20)
    for (let i = 0; i < 16; i++) tree = [tree, tree]
    const bytes = new Encoder({ useRecords: false }).encode(tree)
    const parts = chunks(bytes, 1024)
    const result = await streamDecode(parts)
    assert.isUndefined(result.error)
    assert.strictEqual(result.calls, 2)
    assert.strictEqual(result.scanner.headers, 2 ** 17 - 1)
    assert.deepStrictEqual(result.values, [tree])
    assert.strictEqual(iterDecode(parts).calls, 2)
  })

  test('indefinite arrays and maps keep their position and map parity', async () => {
    for (const count of [4000, 16000]) {
      const item = Buffer.from([0x74, ...Buffer.from('x'.repeat(20))])
      const array = Buffer.concat([Buffer.from([0x9f]), ...new Array(count).fill(item), Buffer.from([0xff])])
      const result = await streamDecode(chunks(array, 257))
      assert.isUndefined(result.error)
      assert.strictEqual(result.calls, 2)
      assert.strictEqual(result.scanner.headers, count + 2)
      assert.strictEqual(result.values[0].length, count)
      assert.strictEqual(iterDecode(chunks(array, 257)).calls, 2)
    }
    const map = Buffer.from([0xbf, 1, 0xff, 2, 0x9f, 3, 0xff, 0xff])
    const result = await streamDecode(chunks(map, 1), { mapsAsObjects: false })
    assert.isUndefined(result.error)
    assert.deepStrictEqual(result.values, [new Decoder({ mapsAsObjects: false }).decode(map)])
    assert.strictEqual(result.calls, 2)
  })

  for (const options of [{ useRecords: true }, { pack: true }, { bundleStrings: true },
    { keyMap: { name: 1, id: 2 } }, { useStringRefs: true }, { structuredClone: true }]) {
    test('all split offsets and bytewise delivery: ' + JSON.stringify(options), async () => {
      const items = [[{ name: 'hello hello', id: 1 }, { name: 'hello hello', id: 2 }],
        ['another string', 'another string'], 12345]
      const encoder = new Encoder(options)
      const encodings = items.map(value => encoder.encode(value))
      const bytes = Buffer.concat(encodings)
      const expected = [...decodeIter([bytes], options)]
      for (let offset = 1; offset < bytes.length; offset++) {
        const parts = [bytes.subarray(0, offset), bytes.subarray(offset)]
        assert.deepStrictEqual([...decodeIter(parts, options)], expected, 'offset ' + offset)
        const result = await streamDecode(parts, options)
        assert.isUndefined(result.error, 'offset ' + offset)
        assert.deepStrictEqual(result.values, expected)
      }
      let fed = 0
      const ends = []
      const actual = []
      for await (const value of decodeIter((async function * () {
        for (; fed < bytes.length; fed++) yield bytes.subarray(fed, fed + 1)
      })(), options)) {
        ends.push(fed + 1)
        actual.push(value)
      }
      let end = 0
      assert.deepStrictEqual(ends, encodings.map(bytes => end += bytes.length))
      assert.deepStrictEqual(actual, expected)
      const streamed = await streamDecode(chunks(bytes, 1), options)
      assert.isUndefined(streamed.error)
      assert.deepStrictEqual(streamed.ends, ends)
      assert.deepStrictEqual(streamed.values, expected)
      assert.isAtMost(streamed.calls, 2 * items.length)
    })
  }

  test('chained bundles and a trailing value', async () => {
    const value = new Array(12000).fill('bundled α text of twenty bytes')
    const encoder = new Encoder({ bundleStrings: true })
    const bytes = Buffer.concat([encoder.encode(value), encoder.encode(42)])
    const result = await streamDecode(chunks(bytes, 127))
    assert.isUndefined(result.error)
    assert.strictEqual(result.calls, 3)
    assert.deepStrictEqual(result.values, [value, 42])
    assert.deepStrictEqual([...decodeIter(chunks(bytes, 127))], [value, 42])
  })

  test('record definitions and record readers preserve their wire counts', async () => {
    const cases = [
      [0xd9, 0xdf, 0xfe, 0x82, 0x19, 0xe0, 0, 0x81, 0xd9, 0xe0, 0, 0x61, 0x61],
      [0x82, 0xd9, 0xdf, 0xff, 0x83, 0x19, 0xe0, 0, 0x81, 0x61, 0x61, 1, 0xd9, 0xe0, 0, 0x41, 2],
      [0x82, 0xd8, 105, 0x83, 0x19, 0xe0, 0, 0x81, 0x61, 0x61, 1, 0xd9, 0xe0, 0, 0x41, 2],
      [0xd9, 0xdf, 0xfe, 0x84, 0x19, 0xe0, 0, 0x81, 0x61, 0x61, 0x81, 0x61, 0x62,
        0x82, 0xd9, 0xe0, 0, 0x81, 1, 0xd9, 0xe0, 1, 0x41, 2]
    ]
    for (const bytes of cases) {
      const buffer = Buffer.from(bytes)
      const expected = new Decoder().decode(buffer)
      const result = await streamDecode(chunks(buffer, 1))
      assert.isUndefined(result.error)
      assert.deepStrictEqual(result.values, [expected])
      assert.deepStrictEqual([...decodeIter(chunks(buffer, 1))], [expected])
      assert.strictEqual(result.calls, 2)
    }
    const compiled = Buffer.from([0x85, 0xd9, 0xdf, 0xff, 0x83, 0x19, 0xe0, 0, 0x81, 0x61, 0x61, 1,
      ...[2, 3, 4].flatMap(n => [0xd9, 0xe0, 0, 0x81, n]), 0xd9, 0xe0, 0, 0x82, 5])
    assert.deepStrictEqual([...decodeIter(chunks(compiled, 1))], [new Decoder().decode(compiled)])
    const structures = []
    structures[0x1ff9] = ['a']
    const bytes = Buffer.from([0xd9, 0xdf, 0xf9, 0x81, 0x65, ...Buffer.from('hello')])
    assert.deepStrictEqual([...decodeIter(chunks(bytes, 1), { structures })], [{ a: 'hello' }])
  })

  test('native string read-ahead cannot cross a scanned value into a truncated next value', async () => {
    const message = new Encoder({ useRecords: false }).encode({ id: 123, name: 'x'.repeat(700), data: [1, 2, 3] })
    const bytes = Buffer.concat(new Array(1000).fill(message))
    for (const size of [127, 1024, 65536]) {
      const parts = chunks(bytes, size)
      const expected = [...decodeIter([bytes])]
      assert.deepStrictEqual([...decodeIter(parts)], expected)
      const streamed = await streamDecode(parts)
      assert.isUndefined(streamed.error)
      assert.deepStrictEqual(streamed.values, expected)
    }
  })

  test('interleaved scanners keep their state separate', () => {
    const first = new Encoder().encode(['first', [1, 2, 3]])
    const second = new Encoder({ bundleStrings: true }).encode(['second string', 'third string'])
    const a = new StructureScanner(new Decoder())
    const b = new StructureScanner(new Decoder())
    for (let end = 1; end < Math.max(first.length, second.length); end++) {
      if (end < first.length) assert.isFalse(a.scan(first, end))
      if (end < second.length) assert.isFalse(b.scan(second, end))
    }
    assert.isTrue(a.scan(first, first.length))
    assert.isTrue(b.scan(second, second.length))
  })

  test('stringref tags retain the existing ordinary-tag behavior', () => {
    const bytes = Buffer.from([0xd9, 1, 0, 0x82, 0x65, ...Buffer.from('hello'), 0xd8, 25, 0])
    assert.deepStrictEqual([...decodeIter(chunks(bytes, 1))], [new Tag(['hello', new Tag(0, 25)], 256)])
  })

  test('header widths, malformed headers, and indefinite strings', async () => {
    for (const bytes of [
      [0x82, 0x1b, 0, 0, 0, 0, 0, 0, 0, 1, 0xfb, 0x3f, 0xf0, 0, 0, 0, 0, 0, 0],
      [0x82, 0x9b, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0xf9, 0x3c, 0],
      [0x82, 1, 0x7f], [0x82, 1, 0x5f], [0x82, 1, 0x1c], [0x82, 1, 0x1d], [0x82, 1, 0x1e],
      [0x82, 0x5b, 0, 0, 0, 1, 0, 0, 0, 0]
    ]) {
      const buffer = Buffer.from(bytes)
      let expected, error
      try { expected = new Decoder().decode(buffer) } catch (failure) { error = failure }
      const result = await streamDecode(chunks(buffer, 1))
      if (error) {
        assert.strictEqual(result.error?.message, error.message)
        assert.isNotOk(result.error.incomplete)
      } else {
        assert.isUndefined(result.error)
        assert.deepStrictEqual(result.values, [expected])
      }
    }
  })

  test('a deeply nested incomplete value bounds scanner memory and fails through the stream', async () => {
    const result = await streamDecode(chunks(Buffer.alloc(20000, 0x81), 1024))
    assert.instanceOf(result.error, RangeError)
    assert.isNotOk(result.error.incomplete)
  })

  test('scanner exceptions reach the error event', async () => {
    const scan = StructureScanner.prototype.scan
    StructureScanner.prototype.scan = () => { throw new Error('scan allocation failure') }
    try {
      const result = await streamDecode([Buffer.from([0x82]), Buffer.from([1, 2])])
      assert.strictEqual(result.error?.message, 'scan allocation failure')
    } finally {
      StructureScanner.prototype.scan = scan
    }
  })

  test('an indefinite container still enforces the incomplete byte cap', async () => {
    const parts = chunks(Buffer.from([0x9f, ...new Array(100).fill(1)]), 7)
    const result = await streamDecode(parts, { maxIncompleteBufferSize: 50 })
    assert.strictEqual(result.error?.message, 'Maximum incomplete buffer size exceeded')
    assert.strictEqual(result.calls, 1)
    assert.throws(() => [...decodeIter(parts, { maxIncompleteBufferSize: 50 })], 'Maximum incomplete buffer size exceeded')
  })

  test('custom multi-item handlesRead is rejected only for the fragmented value', async () => {
    const decode = read => Array.from({ length: read() }, () => read())
    decode.handlesRead = true
    addExtension({ tag: 41000, decode })
    const bytes = Buffer.from([0xd9, 0xa0, 0x28, 3, 1, 2, 3])
    const message = 'Tag 41000: fragmented decoding cannot frame multi-item handlesRead extensions'
    try {
      assert.deepStrictEqual(new Decoder().decode(bytes), [1, 2, 3])
      assert.deepStrictEqual([...decodeIter([bytes])], [[1, 2, 3]])
      const parts = [bytes.subarray(0, 4), ...chunks(bytes.subarray(4), 1)]
      assert.throws(() => [...decodeIter(parts)], message)
      assert.strictEqual((await streamDecode(parts)).error?.message, message)
      assert.deepStrictEqual(new Decoder().decode(bytes), [1, 2, 3])
      const result = await streamDecode([Buffer.from([0x81]), Buffer.concat([Buffer.from([1]), bytes])])
      assert.isUndefined(result.error)
      assert.deepStrictEqual(result.values, [[1], [1, 2, 3]])
      const catching = read => {
        const first = read()
        try { read() } catch (error) {}
        return first
      }
      catching.handlesRead = true
      addExtension({ tag: 41000, decode: catching })
      assert.throws(() => [...decodeIter([bytes.subarray(0, 2), bytes.subarray(2)])], message)
    } finally {
      addExtension({ tag: 41000, decode: value => value })
    }
  })

  test('single-item handlesRead and nested whole-buffer decoding remain supported', () => {
    const multi = read => [read(), read()]
    multi.handlesRead = true
    const single = read => {
      const value = read()
      return [value, new Decoder().decode(Buffer.from([0xd9, 0xa0, 0x29, 1, 2]))]
    }
    single.handlesRead = true
    addExtension({ tag: 41001, decode: multi })
    addExtension({ tag: 41002, decode: single })
    try {
      const bytes = Buffer.from([0x82, 0xd9, 0xa0, 0x2a, 0x81, 1, 0xd9, 0xa0, 0x2a, 0x81, 2])
      assert.deepStrictEqual([...decodeIter(chunks(bytes, 1))], [[[[1], [1, 2]], [[2], [1, 2]]]])
    } finally {
      addExtension({ tag: 41001, decode: value => value })
      addExtension({ tag: 41002, decode: value => value })
    }
  })
})
