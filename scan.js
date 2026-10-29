import { getScanTag, isLegacyRecordTag } from './decode.js'

// Positions are relative to the retained value, including bundle pointers. Frames and their storage survive appends.
export class StructureScanner {
  constructor (decoder) {
    this.decoder = decoder
    this.frames = []
    this.records = new Map()
    this.readers = new Map()
    this.reset()
  }

  reset () {
    this.position = 0
    this.depth = 0
    this.neededLength = 0
    this.postBundlePosition = 0
    this.headers = 0
    this.records.clear()
    this.readers.clear()
    this.push('items', 1)
  }

  push (kind, remaining) {
    if (this.depth === 16384) throw new RangeError('Maximum CBOR nesting depth exceeded')
    const frame = this.frames[this.depth] || (this.frames[this.depth] = {})
    frame.kind = kind
    frame.remaining = remaining
    frame.stage = 0
    frame.id = undefined
    this.depth++
    return frame
  }

  header (source, end, lengthOnly = false) {
    const start = this.position
    if (start >= end) {
      this.neededLength = start + 1
      return false
    }
    const byte = source[start]
    const major = byte >> 5
    const info = byte & 31
    const width = info < 24 || (lengthOnly && info > 26) ? 0 : info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0
    if (!lengthOnly && info >= 28 && info <= 30) throw new Error('Unknown token ' + info)
    if (start + 1 + width > end) {
      this.neededLength = start + 1 + width
      return false
    }
    let value = info
    if (width) {
      value = 0
      for (let i = start + 1; i <= start + width; i++) value = value * 256 + source[i]
      if (width === 8 && major > 1 && major !== 7 && value > 0xffffffff) {
        throw new Error('JavaScript does not support arrays, maps, or strings with length over 4294967295')
      }
    }
    this.major = major
    this.info = info
    this.argument = value
    this.position = start + 1 + width
    this.headers++
    return true
  }

  scan (source, end) {
    while (this.depth) {
      if (this.position > end) {
        this.neededLength = this.position
        return false
      }
      const frame = this.frames[this.depth - 1]
      if (frame.kind === 'bundle') {
        if (frame.stage === 0) {
          if (!this.header(source, end, true)) return false
          frame.remaining = Math.max(0, this.argument - 2)
          frame.stage = 1
        }
        if (frame.stage === 1) {
          const offsetStart = this.position
          if (!this.header(source, end)) return false
          if (this.major > 1 || this.info === 31) throw new Error('Invalid bundled string offset')
          frame.target = offsetStart + (this.major === 1 ? -1 - this.argument : this.argument)
          if (!Number.isSafeInteger(frame.target) || frame.target < 0) throw new Error('Invalid bundled string offset')
          frame.stage = 2
        }
        if (frame.stage === 2) {
          if (frame.remaining) {
            if (!this.header(source, end, true)) return false
            this.position += this.argument
            frame.remaining--
            continue
          }
          frame.resume = this.position
          this.position = frame.target
          frame.remaining = 2
          frame.stage = 3
          continue
        }
        if (frame.stage === 3) {
          if (frame.remaining) {
            if (!this.header(source, end, true)) return false
            this.position += this.argument
            frame.remaining--
            continue
          }
          this.postBundlePosition = this.position
          this.position = frame.resume
          frame.kind = 'items'
          frame.remaining = 1
          continue
        }
      }
      if (frame.kind === 'record') {
        if (!this.header(source, end, true)) return false
        if (this.info > 26) throw new Error('Expected array header, but got ' + source[this.position - 1])
        frame.kind = 'items'
        frame.remaining = this.argument
        const reader = frame.reader
        if (reader.compiled.has(this.argument)) frame.remaining = Math.min(this.argument, reader.length)
        else if (reader.slowReads++ >= 2) {
          reader.compiled.add(this.argument)
          frame.remaining = Math.min(this.argument, reader.length)
        }
        continue
      }
      if (frame.kind === 'definition' && frame.stage === 0) {
        if (!this.header(source, end, true)) return false
        frame.remaining = Math.max(2, this.argument)
        frame.total = frame.remaining
        frame.stage = 1
        continue
      }
      if (frame.remaining === 0) {
        this.depth--
        continue
      }
      if (!this.header(source, end)) return false
      let { major, argument, info } = this
      if (frame.kind === 'definition') {
        const index = frame.total - frame.remaining
        if (index === 0 && major === 0) frame.id = argument
        if ((frame.multiple ? index >= 1 && index < frame.total - 1 : index === 1) && major === 4 && info !== 31 && frame.id !== undefined) {
          this.records.set(frame.id - 0xe000 + (frame.multiple ? index - 1 : 0), { length: argument, slowReads: 0, compiled: new Set() })
        }
      }
      if (major === 7 && info === 31 && (frame.remaining === -1 || frame.remaining === -2)) {
        this.depth--
        continue
      }
      if (frame.remaining > 0) frame.remaining--
      else if (frame.remaining === -2) frame.remaining = -3
      else if (frame.remaining === -3) frame.remaining = -2
      if (info === 31) {
        if (major === 2 || major === 3) throw new Error('Indefinite length not supported for byte or text strings')
        if (major === 4 || major === 5) this.push('items', major === 4 ? -1 : -2)
        else if (major !== 7) throw new Error('Invalid major type for indefinite length ' + major)
        continue
      }
      switch (major) {
        case 2:
        case 3:
          this.position += argument
          break
        case 4:
        case 5:
          if (argument) this.push('items', major === 5 ? argument * 2 : argument)
          break
        case 6: {
          const structure = getScanTag(argument, this.decoder)
          let reader = this.records.get(argument & 0x1fff)
          if (argument >= 0xdff9 && (structure || reader)) {
            if (!reader) {
              reader = this.readers.get(structure)
              if (!reader) {
                reader = { length: structure.length, slowReads: structure.slowReads || 0, compiled: new Set() }
                for (let compiled = structure.compiledReader; compiled; compiled = compiled.next) reader.compiled.add(compiled.propertyCount)
                this.readers.set(structure, reader)
              }
            }
            this.push('record').reader = reader
          } else if (argument === 0xdff9) {
            this.push('bundle')
          } else if (argument === 0xdfff || argument === 0xdffe) {
            this.push('definition').multiple = argument === 0xdffe
          } else if (isLegacyRecordTag(argument)) {
            this.push('definition').multiple = false
          } else {
            this.push('items', 1)
          }
          break
        }
      }
    }
    if (this.postBundlePosition) {
      if (this.position >= this.postBundlePosition) throw new Error('Unexpected bundle position')
      this.position = this.postBundlePosition
    }
    return true
  }
}
