export { Decoder, decode, addExtension, FLOAT32_OPTIONS, clearSource, roundFloat32, isNativeAccelerationEnabled } from './decode.js'
export { Encoder, encode } from './encode.js'
import { Transform, Readable } from 'stream'

export as namespace CBOR;
export class DecoderStream extends Transform {
	constructor(options?: Options | { highWaterMark: number, emitClose: boolean, allowHalfOpen: boolean })
}
export class EncoderStream extends Transform {
	constructor(options?: Options | { highWaterMark: number, emitClose: boolean, allowHalfOpen: boolean })
}
